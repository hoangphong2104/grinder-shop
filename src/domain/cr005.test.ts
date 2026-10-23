/**
 * CR-005: trạng thái lô mới + nhãn, trả trung gian theo lô, sổ quỹ (mirror trigger / view DB), VietQR.
 * Số liệu sổ quỹ = đúng kịch bản supabase/v2/tests/13_cr005_tests.sql (mục 2–7) ⇒ domain và DB cho cùng số.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CashEntry, Lot, Order, Transfer, Unit } from './types.ts';
import { CASH_KIND_LABEL, LOT_FLOW, LOT_STATUS_LABEL, ORDER_STATUS_LABEL, UNIT_STATUS_LABEL } from './types.ts';
import {
  autoCashEntries, cashBalance, cashByMonth, cashEffect, cashKindDirection, checkPayLot, isAutoCashKind, isManualCashKind,
  lotOutstanding, lotPaid, validateCashEntry,
} from './cash.ts';
import { buildVietQrPayload, checkVietQr, crc16Ccitt, vietQrText } from './vietqr.ts';
import { checkReceiveLot, modelStock, unitLocationLabel } from './units.ts';

/* ---------- Trạng thái + nhãn ---------- */

test('CR-005: lot flow Kho TQ → Kho VN → Kho Lumi; order / unit labels', () => {
  assert.deepEqual([...LOT_FLOW], ['cn_warehouse', 'vn_warehouse', 'received']);
  assert.deepEqual(LOT_FLOW.map((s) => LOT_STATUS_LABEL[s]), ['Kho TQ', 'Kho VN', 'Kho Lumi']);
  assert.equal(ORDER_STATUS_LABEL.shipped, 'Vận chuyển tới khách');
  assert.equal(ORDER_STATUS_LABEL.completed, 'Đã giao');
  assert.equal(UNIT_STATUS_LABEL.in_stock, 'Kho Lumi');
  assert.equal(unitLocationLabel('incoming', 'cn_warehouse'), 'Kho TQ');
  assert.equal(unitLocationLabel('incoming', 'vn_warehouse'), 'Kho VN');
  assert.equal(unitLocationLabel('in_stock', 'received'), 'Kho Lumi');
  assert.equal(unitLocationLabel('sold', 'received', 'shipped'), 'Vận chuyển tới khách');
  assert.equal(unitLocationLabel('sold', 'received', 'completed'), 'Đã giao');
  assert.equal(unitLocationLabel('reserved', 'vn_warehouse', 'preorder'), 'Đã giữ');
  assert.equal(unitLocationLabel('cancelled', 'cancelled'), 'Huỷ');
});

test('CR-005: receive from any open status (Kho TQ too)', () => {
  assert.equal(checkReceiveLot({ id: 'L', rate: 3600, shipFee: 0, status: 'cn_warehouse', receivedAt: null }).ok, true);
  assert.equal(checkReceiveLot({ id: 'L', rate: 3600, shipFee: 0, status: 'received', receivedAt: '2026-10-01' }).ok, false);
});

/* ---------- Trả trung gian theo lô ---------- */

const unit = (id: string, lotId: string, priceCny = 1000, over: Partial<Unit> = {}): Unit => ({
  id, code: id, modelId: 'zp6', lotId, priceCny, costOverride: null, listPrice: null, ...over,
});
const LD: Lot = { id: 'LD', rate: 3600, shipFee: null, status: 'cn_warehouse', receivedAt: null };
const unitsD = [unit('d1', 'LD'), unit('d2', 'LD')];

test('CR-005: paid / outstanding per lot; ship entered later ⇒ outstanding = ship; pay_lot guard', () => {
  const paidNow: Transfer = { kind: 'transfer', amount: 7200000, lotId: 'LD' };
  const general: Transfer = { kind: 'transfer', amount: 999, lotId: null };
  const adj: Transfer = { kind: 'adjustment', amount: 5000 };
  assert.equal(lotPaid('LD', [paidNow, general, adj]), 7200000);
  assert.equal(lotOutstanding(LD, unitsD, [paidNow]), 0);
  const nothing = checkPayLot(LD, unitsD, [paidNow]);
  assert.equal(nothing.ok, false);
  if (!nothing.ok) assert.equal(nothing.error.code, 'LOT_ALREADY_PAID');
  const received: Lot = { ...LD, shipFee: 400000, status: 'received', receivedAt: '2026-10-13' };
  assert.equal(lotOutstanding(received, unitsD, [paidNow]), 400000);
  assert.deepEqual(checkPayLot(received, unitsD, [paidNow]), { ok: true, value: 400000 });
  // trả dư (vd. trung gian giảm ship) ⇒ âm
  assert.equal(lotOutstanding({ ...received, shipFee: 0 }, unitsD, [paidNow, { kind: 'transfer', amount: 400000, lotId: 'LD' }]), -400000);
  assert.equal(checkPayLot({ ...LD, status: 'cancelled' }, unitsD, []).ok, false);
});

/* ---------- Sổ quỹ ---------- */

// Kịch bản 13_cr005_tests.sql (ngày tương đối d0 = 2026-10-23)
const T: Transfer[] = [
  { kind: 'transfer', amount: 7200000, lotId: 'LD', date: '2026-10-03' }, // paid_now lô D
  { kind: 'transfer', amount: 400000, lotId: 'LD', date: '2026-10-18' }, // pay_lot ship lô D
  { kind: 'transfer', amount: 7200000, lotId: 'LA', date: '2026-10-23' }, // pay_lot lô A
  { kind: 'transfer', amount: 0, date: '2026-10-20' }, // 0 ₫ ⇒ không vào quỹ
  { kind: 'adjustment', amount: -50000 }, // điều chỉnh công nợ ⇒ không vào quỹ
];
const O1: Order = {
  id: 'o1', status: 'completed', shippedAt: '2026-10-18', shipFee: 30000, shipPayer: 'shop', lines: [{ unitId: 'c1', price: 4500000 }],
  payments: [{ kind: 'deposit', amount: 1000000, date: '2026-10-13' }, { kind: 'payment', amount: 3600000, date: '2026-10-20' }],
};
const O2: Order = {
  id: 'o2', status: 'returned', shippedAt: '2026-10-18', returnedAt: '2026-10-20', returnShipFee: 25000, shipFee: 40000,
  shipPayer: 'customer', lines: [{ unitId: 'd1', price: 5000000 }], payments: [],
};
const O3: Order = {
  id: 'o3', status: 'returned', shippedAt: '2026-10-20', returnedAt: '2026-10-23', returnShipFee: 0, shipFee: 35000,
  shipPayer: 'shop', lines: [{ unitId: 'd2', price: 5000000 }], payments: [],
};
const O4: Order = { id: 'o4', status: 'confirmed', shipFee: 50000, shipPayer: 'shop', lines: [], payments: [{ kind: 'refund', amount: 1, date: '2026-10-22' }] };
const manual: CashEntry[] = [
  { kind: 'capital_in', direction: 'in', amount: 50000000, date: '2026-09-13' },
  { kind: 'expense', direction: 'out', amount: 150000, date: '2026-10-20', expenseCategory: 'Đóng gói' },
  { kind: 'capital_out', direction: 'out', amount: 2000000, date: '2026-10-23' },
];

test('CR-005: auto entries mirror the DB triggers', () => {
  const auto = autoCashEntries([O1, O2, O3, O4], T);
  assert.deepEqual(auto.map((e) => `${e.kind}:${e.direction}:${e.amount}:${e.date}`), [
    'customer_payment:in:1000000:2026-10-13',
    'customer_payment:in:3600000:2026-10-20',
    'ship_shop:out:30000:2026-10-18', // đơn đã giao, shop chịu ship ⇒ ra ngày gửi
    'return_ship:out:25000:2026-10-20', // khách chịu ship đi ⇒ chỉ ship chiều về
    'ship_shop:out:35000:2026-10-20', // hoàn hàng ship về 0 ⇒ chỉ ship đi
    'customer_refund:out:1:2026-10-22', // đơn chưa gửi ⇒ chưa có ship
    'intermediary:out:7200000:2026-10-03',
    'intermediary:out:400000:2026-10-18',
    'intermediary:out:7200000:2026-10-23',
  ]);
  assert.equal(auto.every((e) => e.isAuto && isAutoCashKind(e.kind)), true);
  assert.equal(auto.find((e) => e.kind === 'intermediary')!.lotId, 'LD');
});

test('CR-005: fund balance = Σ in − Σ out, from 0 (same numbers as the DB test: 54.600.000 / 17.040.000 / 37.560.000)', () => {
  const all = [...autoCashEntries([O1, O2, O3], T), ...manual];
  assert.deepEqual(cashBalance(all), { totalIn: 54600000, totalOut: 17040000, balance: 37560000 });
  assert.deepEqual(cashBalance([]), { totalIn: 0, totalOut: 0, balance: 0 });
  const months = cashByMonth(all);
  assert.deepEqual(months.map((m) => m.month), ['2026-09-01', '2026-10-01']);
  assert.equal(months[0]!.net, 50000000);
  assert.equal(months.reduce((a, m) => a + m.net, 0), 37560000);
  assert.equal(cashEffect({ direction: 'out', amount: 5 }), -5);
});

test('CR-005: kinds - direction rules + labels; manual entry validation', () => {
  assert.equal(cashKindDirection('capital_in'), 'in');
  assert.equal(cashKindDirection('expense'), 'out');
  assert.equal(cashKindDirection('adjustment'), null);
  assert.equal(isManualCashKind('adjustment'), true);
  assert.equal(isManualCashKind('ship_shop'), false);
  assert.equal(CASH_KIND_LABEL.ship_shop, 'Ship cho khách (shop chịu)');
  assert.equal(validateCashEntry(manual[1]!).ok, true);
  assert.equal(validateCashEntry({ kind: 'adjustment', direction: 'in', amount: 5000 }).ok, true);
  const bad = (e: CashEntry, field: string) => {
    const r = validateCashEntry(e);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.field, field);
  };
  bad({ kind: 'customer_payment', direction: 'in', amount: 1 }, 'kind');
  bad({ kind: 'expense', direction: 'in', amount: 1 }, 'direction');
  bad({ kind: 'capital_in', direction: 'out', amount: 1 }, 'direction');
  bad({ kind: 'expense', direction: 'out', amount: 0 }, 'amount');
  bad({ kind: 'expense', direction: 'out', amount: 1.5 }, 'amount');
  bad({ kind: 'capital_out', direction: 'out', amount: 1, expenseCategory: 'x' }, 'expenseCategory');
});

test('CR-005: model stock - capital incl. incoming units (reserved by a pre-order too); cancelled lot excluded', () => {
  const lots: Lot[] = [
    { id: 'R', rate: 3600, shipFee: 0, status: 'received', receivedAt: '2026-10-01' },
    { id: 'V', rate: 3600, shipFee: null, status: 'vn_warehouse', receivedAt: null },
    { id: 'X', rate: 3600, shipFee: null, status: 'cancelled', receivedAt: null },
  ];
  const us = [unit('r1', 'R'), unit('v1', 'V', 1500), unit('v2', 'V', 1500), unit('x1', 'X')];
  const pre: Order = { id: 'p', status: 'preorder', shipFee: 0, shipPayer: 'customer', lines: [{ unitId: 'v2', price: 1 }], payments: [] };
  const s = modelStock({ id: 'zp6', name: 'ZP6', codePrefix: 'ZP6', defaultListPrice: null, lowStockThreshold: 0 }, us, lots, [pre]);
  assert.equal(s.stockValue, 3600000);
  assert.equal(s.incomingValue, 2 * 5400000);
  assert.equal(s.totalCapital, 3600000 + 2 * 5400000);
});

/* ---------- VietQR ---------- */

test('VietQR: CRC-16/CCITT-FALSE check value ("123456789" → 29B1)', () => {
  assert.equal(crc16Ccitt('123456789'), '29B1');
  assert.equal(crc16Ccitt(''), 'FFFF');
});

test('VietQR: dynamic payload (Vietcombank 970436, amount, order code) - CRC verified independently (Python binascii.crc_hqx)', () => {
  const p = buildVietQrPayload({ bin: '970436', accountNo: '0011001234567', accountName: 'NGUYỄN VĂN A', amount: 4530000, content: 'D-005' });
  assert.equal(p, '00020101021238570010A00000072701270006970436011300110012345670208QRIBFTTA5303704540745300005802VN62090805D-0056304F9B0');
  // CRC = CRC của mọi thứ trước 4 ký tự cuối (kể cả "6304")
  assert.equal(crc16Ccitt(p.slice(0, -4)), p.slice(-4));
  assert.ok(p.includes('0010A000000727') && p.includes('0208QRIBFTTA') && p.includes('5303704') && p.includes('5802VN'));
});

test('VietQR: static payload (no amount, no content) - Point of Initiation 11, no tags 54 / 62', () => {
  assert.equal(buildVietQrPayload({ bin: '970422', accountNo: 'MB123' }),
    '00020101021138490010A000000727011900069704220105MB1230208QRIBFTTA53037045802VN6304F716');
  assert.equal(buildVietQrPayload({ bin: '970422', accountNo: 'MB123', amount: 0, content: '  ' }),
    '00020101021138490010A000000727011900069704220105MB1230208QRIBFTTA53037045802VN6304F716');
});

test('VietQR: content without diacritics / symbols, max 25; input checks', () => {
  assert.equal(vietQrText('Đơn D-005: cối ZP6 ✓'), 'Don D-005 coi ZP6');
  assert.equal(vietQrText('x'.repeat(40)).length, 25);
  assert.equal(checkVietQr({ bin: '97043', accountNo: '1' }) != null, true);
  assert.equal(checkVietQr({ bin: '970436', accountNo: '0123 456' }) != null, true);
  assert.equal(checkVietQr({ bin: '970436', accountNo: '01234567890123456789' }) != null, true);
  assert.equal(checkVietQr({ bin: '970436', accountNo: '1', amount: 1.5 }) != null, true);
  assert.equal(checkVietQr({ bin: '970436', accountNo: '1', amount: 100 }), null);
  assert.throws(() => buildVietQrPayload({ bin: 'abc', accountNo: '1' }), RangeError);
});
