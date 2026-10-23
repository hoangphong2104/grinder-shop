/**
 * CR-004 (phần dữ liệu): tình trạng chiếc, hình thức thu + COD, Hoàn hàng, tuổi tồn, lô trễ.
 * Numbers mirror supabase/v2/tests/10_cr004_tests.sql (same orders, same arithmetic) so domain = DB view.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Lot, Order, Unit } from './types.ts';
import { ORDER_STATUS_LABEL, PAYMENT_METHOD_LABEL, UNIT_CONDITION_LABEL } from './types.ts';
import {
  checkCancelOrder, checkReturnOrder, checkUnitAvailable, completeOrder, orderCodPending, orderCodReceived, orderKept,
  orderProfit, orderProfitDate, orderReceivable, orderRefundDue, profitByMonth, profitForMonth, returnOrder, totalCodPending,
  totalRefundDue,
} from './orders.ts';
import { agingLevel, buildUnitViews, holdingOrder, isLotLate, lotDaysOpen, modelStock, unitAgingLevel, unitStatus } from './units.ts';
import { validateOrder, validatePayment, validateUnit } from './validate.ts';

const today = '2026-10-23';
// L1 nhận 65 ngày trước (18/08) · L2 31 ngày (22/09) · L3 30 ngày (23/09)
const L1: Lot = { id: 'L1', rate: 3600, shipFee: 300000, status: 'received', receivedAt: '2026-08-19', orderedAt: '2026-08-04' };
const L2: Lot = { id: 'L2', rate: 3600, shipFee: 200000, status: 'received', receivedAt: '2026-09-22', orderedAt: '2026-09-03' };
const L3: Lot = { id: 'L3', rate: 3600, shipFee: 0, status: 'received', receivedAt: '2026-09-23', orderedAt: '2026-09-08' };
const L4: Lot = { id: 'L4', rate: 3600, shipFee: null, status: 'vn_shipping', receivedAt: null, orderedAt: '2026-10-01' };
const lots = [L1, L2, L3, L4];
const u = (id: string, lotId: string, priceCny: number, over: Partial<Unit> = {}): Unit =>
  ({ id, code: id.toUpperCase(), modelId: lotId === 'L1' || lotId === 'L4' ? 'zp6' : 'ku', lotId, priceCny, costOverride: null, listPrice: null, ...over });
const units = [u('z1', 'L1', 1000, { condition: 'used' }), u('z2', 'L1', 1000, { condition: 'defect' }), u('z3', 'L1', 1000),
  u('k1', 'L2', 1500), u('k2', 'L2', 1500), u('k3', 'L3', 1500), u('z4', 'L4', 1000)];

// O3: KU k1 giá 7.000.000, ship 40.000 shop chịu, cọc 1.000.000 + thanh toán 500.000, gửi 18/10, COD 5.500.000
const o3: Order = {
  id: 'o3', code: 'D-003', status: 'shipped', shippedAt: '2026-10-18', shipFee: 40000, shipPayer: 'shop', codAmount: 5500000,
  lines: [{ unitId: 'k1', price: 7000000 }],
  payments: [{ kind: 'deposit', amount: 1000000 }, { kind: 'payment', amount: 500000 }],
};
// O5: ZP6 z1 giá 5.000.000, ship 30.000 khách trả, cọc 800.000, gửi hôm nay, COD 4.230.000
const o5: Order = {
  id: 'o5', code: 'D-005', status: 'shipped', shippedAt: today, shipFee: 30000, shipPayer: 'customer', codAmount: 4230000,
  lines: [{ unitId: 'z1', price: 5000000 }], payments: [{ kind: 'deposit', amount: 800000 }],
};
const ok = <T>(r: { ok: true; value: T } | { ok: false }): T => { assert.ok(r.ok); return (r as { value: T }).value; };

test('CR-004 labels: Hoàn hàng, tình trạng, hình thức thu', () => {
  assert.equal(ORDER_STATUS_LABEL.returned, 'Hoàn hàng');
  assert.deepEqual(UNIT_CONDITION_LABEL, { new: 'Mới', like_new: 'Như mới', used: 'Đã dùng', defect: 'Có lỗi' });
  assert.deepEqual(PAYMENT_METHOD_LABEL, { transfer: 'Chuyển khoản', cash: 'Tiền mặt', cod: 'COD' });
});

test('KHO-S3: validateUnit accepts the 4 conditions (missing = Mới), rejects others', () => {
  for (const c of ['new', 'like_new', 'used', 'defect'] as const) assert.equal(validateUnit(u('x', 'L1', 1, { condition: c })).ok, true);
  assert.equal(validateUnit(u('x', 'L1', 1)).ok, true);
  const bad = validateUnit(u('x', 'L1', 1, { condition: 'broken' as never }));
  assert.ok(!bad.ok);
  assert.equal(bad.error.field, 'condition');
});

test('DON-S1: payment method — 3 methods, COD only for a payment', () => {
  assert.equal(validatePayment({ kind: 'deposit', amount: 1, method: 'cash' }).ok, true);
  assert.equal(validatePayment({ kind: 'payment', amount: 1, method: 'cod' }).ok, true);
  assert.equal(validatePayment({ kind: 'deposit', amount: 1, method: 'cod' }).ok, false);
  assert.equal(validatePayment({ kind: 'refund', amount: 1, method: 'cod' }).ok, false);
  assert.equal(validatePayment({ kind: 'payment', amount: 1, method: 'momo' as never }).ok, false);
  assert.equal(validateOrder({ ...o3, codAmount: -1 }).ok, false);
  assert.equal(validateOrder({ ...o3, returnShipFee: 1.5 }).ok, false);
});

test('DON-S1: COD pending = max(min(COD − COD received, receivable), 0) — mirror of SQL O1', () => {
  // O1: 5.000.000 + ship 30.000 khách trả = 5.030.000; cọc tiền mặt 1.000.000 ⇒ còn thu 4.030.000; COD 4.030.000
  const o1: Order = { id: 'o1', status: 'shipped', shippedAt: '2026-10-17', shipFee: 30000, shipPayer: 'customer', codAmount: 4030000,
    lines: [{ unitId: 'z3', price: 5000000 }], payments: [{ kind: 'deposit', amount: 1000000, method: 'cash' }] };
  assert.equal(orderCodPending(o1), 4030000);
  assert.equal(orderCodPending({ ...o1, status: 'confirmed' }), 0); // not shipped yet
  const part = { ...o1, payments: [...o1.payments, { kind: 'payment' as const, amount: 2000000, method: 'cod' as const }] };
  assert.equal(orderCodReceived(part), 2000000);
  assert.equal(orderCodPending(part), 2030000); // min(4.030.000 − 2.000.000, 5.030.000 − 3.000.000)
  const full = { ...part, payments: [...part.payments, { kind: 'payment' as const, amount: 2030000, method: 'cod' as const }] };
  assert.equal(orderCodPending(full), 0);
  assert.equal(orderReceivable(full), 0);
  assert.equal(ok(completeOrder(full)).status, 'completed');
  // rest paid by transfer instead of COD ⇒ receivable 0 ⇒ no false "COD chờ về"
  const byTransfer = { ...o1, payments: [...o1.payments, { kind: 'payment' as const, amount: 4030000 }] };
  assert.equal(orderCodPending(byTransfer), 0);
  assert.equal(totalCodPending([o1, part, full, byTransfer]), 4030000 + 2030000);
});

test('DON-S3: returnOrder guard — only from shipped; returned cannot complete / cancel / return again', () => {
  for (const status of ['preorder', 'confirmed', 'completed', 'cancelled', 'returned'] as const) {
    const r = checkReturnOrder({ ...o3, status });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'INVALID_TRANSITION');
  }
  assert.equal(returnOrder(o3, { keepDeposit: true, returnShipFee: -1, returnedAt: '2026-10-21' }).ok, false);
  assert.equal(returnOrder(o3, { keepDeposit: true, returnShipFee: 0, returnedAt: '2026-10-17' }).ok, false); // before ship date
  const r3 = ok(returnOrder(o3, { keepDeposit: true, returnShipFee: 45000, returnedAt: '2026-10-21' }));
  assert.equal(r3.status, 'returned');
  assert.equal(completeOrder(r3, { acceptOutstanding: true }).ok, false);
  assert.equal(checkCancelOrder(r3).ok, false);
  assert.equal(checkReturnOrder(r3).ok, false);
});

test('DON-S3: returned + KEEP deposit — numbers of SQL O3', () => {
  const r3 = ok(returnOrder(o3, { keepDeposit: true, returnShipFee: 45000, returnedAt: '2026-10-21' }));
  // đã thu ròng 1.500.000; giữ tối đa Σ cọc 1.000.000 ⇒ cần hoàn 500.000; giữ 1.000.000
  // lãi = 1.000.000 − 40.000 (ship đi shop chịu) − 45.000 (ship về) = 915.000
  assert.equal(orderReceivable(r3), 0);
  assert.equal(orderRefundDue(r3), 500000);
  assert.equal(orderKept(r3), 1000000);
  assert.equal(orderProfit(r3, new Map()), 915000);
  assert.equal(orderCodPending(r3), 0);
  assert.equal(orderProfitDate(r3), '2026-10-21');
  // recording the refund: refund due 0, kept + profit unchanged
  const refunded = { ...r3, payments: [...r3.payments, { kind: 'refund' as const, amount: 500000 }] };
  assert.equal(orderRefundDue(refunded), 0);
  assert.equal(orderKept(refunded), 1000000);
  assert.equal(orderProfit(refunded, new Map()), 915000);
});

test('DON-S3: returned + REFUND deposit — numbers of SQL O5', () => {
  const r5 = ok(returnOrder(o5, { keepDeposit: false, returnShipFee: 35000, returnedAt: today }));
  // đã thu ròng 800.000; giữ tối đa 0 ⇒ cần hoàn 800.000; giữ 0; lãi = 0 − 0 (ship khách chịu) − 35.000 = −35.000
  assert.equal(orderRefundDue(r5), 800000);
  assert.equal(orderKept(r5), 0);
  assert.equal(orderProfit(r5, new Map()), -35000);
  assert.equal(totalRefundDue([r5, { ...o3, status: 'cancelled' }]), 800000 + 1500000);
  assert.equal(orderKept(o5), null); // not returned
});

test('DON-S3: units of a returned order are released, back in stock, sellable again', () => {
  const r3 = ok(returnOrder(o3, { keepDeposit: true, returnShipFee: 45000, returnedAt: '2026-10-21' }));
  const k1 = units.find((x) => x.id === 'k1')!;
  assert.equal(unitStatus(k1, L2, [o3]), 'sold');
  assert.equal(unitStatus(k1, L2, [r3]), 'in_stock');
  assert.equal(holdingOrder('k1', [r3]), null);
  assert.deepEqual(checkUnitAvailable(k1, L2, [r3]), { ok: true, value: 'in_stock' });
  const o4: Order = { id: 'o4', status: 'confirmed', shipFee: 0, shipPayer: 'customer', lines: [{ unitId: 'k1', price: 6800000 }], payments: [] };
  assert.equal(unitStatus(k1, L2, [r3, o4]), 'reserved');
  // KU stock after O3 returned: k1, k2 (L2) + k3 (L3) in stock; value 5.500.000 × 2 + 5.400.000
  const s = modelStock({ id: 'ku', name: 'K Ultra', codePrefix: 'KU', defaultListPrice: null, lowStockThreshold: 1 }, units, lots, [r3]);
  assert.equal(s.inStock, 3);
  assert.equal(s.sold, 0);
  assert.equal(s.stockValue, 16400000);
});

test('CR-004 monthly profit: returned order counts in its return month, not its ship month', () => {
  const costs = new Map([['k1', 5500000], ['z1', 3700000]]);
  const r3 = ok(returnOrder({ ...o3, shippedAt: '2026-09-28' }, { keepDeposit: true, returnShipFee: 45000, returnedAt: '2026-10-02' }));
  assert.deepEqual(profitForMonth([r3], costs, '2026-09'), { month: '2026-09', profit: 0, revenue: 0, orders: 0, returns: 0 });
  assert.deepEqual(profitForMonth([r3, o5], costs, '2026-10'),
    // o5 sold: 5.000.000 − 3.700.000 = 1.300.000; r3: +915.000
    { month: '2026-10', profit: 2215000, revenue: 5000000, orders: 1, returns: 1 });
  assert.deepEqual(profitByMonth([r3, o5], costs).map((m) => m.month), ['2026-10']);
});

test('KHO-S1: aging level — > 30 warn, > 60 alert (defaults), thresholds from settings', () => {
  assert.equal(agingLevel(null), null);
  assert.equal(agingLevel(30), 'ok');
  assert.equal(agingLevel(31), 'warn');
  assert.equal(agingLevel(60), 'warn');
  assert.equal(agingLevel(61), 'alert');
  assert.equal(agingLevel(65, { warnDays: 30, alertDays: 70 }), 'warn');
  // mirror of SQL: L1 65 ngày → alert, L2 31 → warn, L3 30 → ok, L4 incoming → null; sold → null
  assert.equal(unitAgingLevel('in_stock', L1, today), 'alert');
  assert.equal(unitAgingLevel('reserved', L2, today), 'warn');
  assert.equal(unitAgingLevel('in_stock', L3, today), 'ok');
  assert.equal(unitAgingLevel('incoming', L4, today), null);
  assert.equal(unitAgingLevel('sold', L1, today), null);
  const views = buildUnitViews(units, lots, [o3], today);
  assert.deepEqual(views.map((v) => `${v.unit.id}:${v.agingLevel}`),
    ['z1:alert', 'z2:alert', 'z3:alert', 'k1:null', 'k2:warn', 'k3:ok', 'z4:null']);
  assert.equal(buildUnitViews(units, lots, [], today, { warnDays: 30, alertDays: 70 })[0]!.agingLevel, 'warn');
});

test('LOT-S2: lot late — open lot ordered > 21 days ago (setting), received / cancelled never late', () => {
  assert.equal(lotDaysOpen(L4, today), 22);
  assert.equal(isLotLate(L4, today), true);
  assert.equal(isLotLate(L4, today, 22), false);
  assert.equal(isLotLate({ status: 'ordered', orderedAt: '2026-10-02' }, today), false); // 21 days = not late
  assert.equal(isLotLate(L1, today), false);
  assert.equal(isLotLate({ status: 'cancelled', orderedAt: '2026-01-01' }, today), false);
  assert.equal(lotDaysOpen({ status: 'ordered' }, today), null);
});
