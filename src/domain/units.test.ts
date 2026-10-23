import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Lot, Model, Order, Unit } from './types.ts';
import {
  checkCancelLot,
  checkLotEdit,
  checkReceiveLot,
  daysBetween,
  expandLotGroups,
  formatUnitCode,
  holdingOrder,
  modelStock,
  unitDaysInStock,
  unitStatus,
  unitStatusLabel,
} from './units.ts';

const lot = (over: Partial<Lot> = {}): Lot => ({ id: 'L', rate: 3600, shipFee: 600000, status: 'received', receivedAt: '2026-10-03', ...over });
const unit = (id: string, over: Partial<Unit> = {}): Unit => ({
  id, code: `KU-${id}`, modelId: 'ku', lotId: 'L', priceCny: 1010, costOverride: null, listPrice: 6800000, ...over,
});
const order = (status: Order['status'], unitIds: string[], over: Partial<Order> = {}): Order => ({
  id: `o-${status}`, code: 'D-009', status, shipFee: 0, shipPayer: 'customer',
  lines: unitIds.map((unitId) => ({ unitId, price: 6800000 })), payments: [], ...over,
});
const ku: Model = { id: 'ku', name: 'K Ultra', codePrefix: 'KU', defaultListPrice: 6800000, lowStockThreshold: 1 };

/* ---------- D1 codes ---------- */

test('D1: formatUnitCode pads to 3+ digits', () => {
  assert.equal(formatUnitCode('ZP6', 1), 'ZP6-001');
  assert.equal(formatUnitCode('KU', 7), 'KU-007');
  assert.equal(formatUnitCode('JU', 42), 'JU-042');
  assert.equal(formatUnitCode('JU', 999), 'JU-999');
  assert.equal(formatUnitCode('ZP6', 1234), 'ZP6-1234');
  assert.throws(() => formatUnitCode('ZP6', 0), RangeError);
  assert.throws(() => formatUnitCode('ZP6', 1.5), RangeError);
});

test('A2: expandLotGroups creates N units per group, codes continue per model, list price defaults to model', () => {
  const zp6: Model = { id: 'zp6', name: 'ZP6 Special', codePrefix: 'ZP6', defaultListPrice: 4600000, lowStockThreshold: 1, nextSeq: 12 };
  const r = expandLotGroups(
    [
      { modelId: 'ku', qty: 2, priceCny: 1000, listPrice: null },
      { modelId: 'zp6', qty: 1, priceCny: 740, listPrice: 4500000 },
      { modelId: 'ku', qty: 1, priceCny: 1020, listPrice: 7000000 },
    ],
    [{ ...ku, nextSeq: 7 }, zp6],
  );
  assert.ok(r.ok);
  assert.deepEqual(r.value.map((d) => [d.code, d.priceCny, d.listPrice]), [
    ['KU-007', 1000, 6800000],
    ['KU-008', 1000, 6800000],
    ['ZP6-012', 740, 4500000],
    ['KU-009', 1020, 7000000],
  ]);
  assert.equal(expandLotGroups([{ modelId: 'ku', qty: 1, priceCny: 1, listPrice: null }], [ku]).ok && 'KU-001', 'KU-001'); // nextSeq default 1
  assert.equal(expandLotGroups([], [ku]).ok, false);
  assert.equal(expandLotGroups([{ modelId: 'nope', qty: 1, priceCny: 1, listPrice: null }], [ku]).ok, false);
  const bad = expandLotGroups([{ modelId: 'ku', qty: 0, priceCny: 1, listPrice: null }], [ku]);
  assert.ok(!bad.ok);
  assert.equal(bad.error.field, 'groups[0].qty');
});

/* ---------- A5 status ---------- */

test('A5: incoming / in_stock depend on the lot; reserved / sold on the holding order; cancelled lot wins', () => {
  const u = unit('001');
  assert.equal(unitStatus(u, lot({ status: 'vn_shipping', receivedAt: null }), []), 'incoming');
  assert.equal(unitStatus(u, lot(), []), 'in_stock');
  assert.equal(unitStatus(u, lot(), [order('preorder', ['001'])]), 'reserved');
  assert.equal(unitStatus(u, lot(), [order('confirmed', ['001'])]), 'reserved');
  assert.equal(unitStatus(u, lot({ status: 'ordered', receivedAt: null }), [order('preorder', ['001'])]), 'reserved');
  assert.equal(unitStatus(u, lot(), [order('shipped', ['001'])]), 'sold');
  assert.equal(unitStatus(u, lot(), [order('completed', ['001'])]), 'sold');
  assert.equal(unitStatus(u, lot({ status: 'cancelled', receivedAt: null }), []), 'cancelled');
});

test('A5: a cancelled order releases its unit (back to in_stock / incoming)', () => {
  const u = unit('001');
  assert.equal(unitStatus(u, lot(), [order('cancelled', ['001'])]), 'in_stock');
  assert.equal(unitStatus(u, lot({ status: 'at_forwarder', receivedAt: null }), [order('cancelled', ['001'])]), 'incoming');
  assert.equal(holdingOrder('001', [order('cancelled', ['001'])]), null);
});

test('D4: labels — "Đã giữ cho D-xxx"', () => {
  const o = order('preorder', ['001']);
  assert.equal(unitStatusLabel('reserved', o), 'Đã giữ cho D-009');
  assert.equal(unitStatusLabel('sold', o), 'Đã bán (D-009)');
  assert.equal(unitStatusLabel('in_stock'), 'Trong kho');
  assert.equal(unitStatusLabel('incoming', null), 'Đang về');
});

/* ---------- Days in stock ---------- */

test('days in stock: received → ship date when sold, else → today; null before receipt', () => {
  assert.equal(daysBetween('2026-09-30', '2026-10-02'), 2);
  assert.equal(daysBetween('2026-10-03T10:00:00+07:00', '2026-10-22'), 19);
  assert.equal(daysBetween(null, '2026-10-22'), null);
  assert.equal(daysBetween('2026-10-23', '2026-10-22'), 0);
  assert.equal(unitDaysInStock(lot(), null, '2026-10-22'), 19);
  assert.equal(unitDaysInStock(lot(), order('shipped', ['001'], { shippedAt: '2026-10-05' }), '2026-10-22'), 2);
  assert.equal(unitDaysInStock(lot(), order('confirmed', ['001']), '2026-10-22'), 19);
  assert.equal(unitDaysInStock(lot({ status: 'vn_shipping', receivedAt: null }), null, '2026-10-22'), null);
});

/* ---------- A9 model stock ---------- */

test('A9: sellable = in stock + incoming not held; low stock when sellable ≤ threshold', () => {
  const lots = [lot(), lot({ id: 'L2', status: 'vn_shipping', shipFee: null, receivedAt: null })];
  const units = [unit('1'), unit('2'), unit('3', { lotId: 'L2' }), unit('4', { lotId: 'L2' })];
  // 1 sold, 3 reserved (incoming) → in stock 2, incoming 4 → sellable 2 > 1
  const os = [order('shipped', ['1'], { id: 'a' }), order('preorder', ['3'], { id: 'b' })];
  const s = modelStock(ku, units, lots, os);
  assert.deepEqual(
    { inStock: s.inStock, incoming: s.incoming, reserved: s.reserved, sold: s.sold, onHand: s.onHand, sellable: s.sellable, lowStock: s.lowStock },
    { inStock: 1, incoming: 1, reserved: 1, sold: 1, onHand: 1, sellable: 2, lowStock: false },
  );
  // stock value: only unit 2 (received, not sold): 1.010 × 3.600 + 600.000 ÷ 2
  assert.equal(s.stockValue, 3936000);
  // hold unit 2 too → sellable 1 ≤ 1 → low; reserved received unit still counts in stock value
  const s2 = modelStock(ku, units, lots, [...os, order('confirmed', ['2'], { id: 'c' })]);
  assert.equal(s2.sellable, 1);
  assert.equal(s2.lowStock, true);
  assert.equal(s2.stockValue, 3936000);
  assert.equal(modelStock({ ...ku, lowStockThreshold: 0 }, units, lots, [...os, order('confirmed', ['2'], { id: 'c' })]).lowStock, false);
});

test('A9: a model with no units has 0 sellable → low stock (threshold ≥ 0)', () => {
  const s = modelStock({ ...ku, lowStockThreshold: 0 }, [], [], []);
  assert.equal(s.sellable, 0);
  assert.equal(s.lowStock, true);
});

/* ---------- Lot guards ---------- */

test('BR-02 + Q-011: receive from any open status, ship fee required', () => {
  assert.equal(checkReceiveLot(lot({ status: 'ordered', receivedAt: null })).ok, true);
  const r = checkReceiveLot(lot({ status: 'vn_shipping', shipFee: null, receivedAt: null }));
  assert.ok(!r.ok);
  assert.equal(r.error.code, 'SHIP_FEE_REQUIRED');
  assert.equal(r.error.rule, 'BR-02');
  assert.equal(checkReceiveLot(lot()).ok, false); // already received
  assert.equal(checkReceiveLot(lot({ status: 'cancelled' })).ok, false);
});

test('cancel lot: only before receipt and not while a unit is held by a live order', () => {
  const open = lot({ status: 'cn_shipping', shipFee: null, receivedAt: null });
  const units = [unit('1'), unit('2')];
  assert.equal(checkCancelLot(open, units, []).ok, true);
  assert.equal(checkCancelLot(open, units, [order('cancelled', ['1'])]).ok, true);
  const held = checkCancelLot(open, units, [order('preorder', ['2'])]);
  assert.ok(!held.ok);
  assert.equal(held.error.unitId, '2');
  assert.match(held.error.message, /KU-2.*D-009/);
  assert.equal(checkCancelLot(lot(), units, []).ok, false);
});

test('A10 / Q-014: received lot — ship fee, override, list price, serial editable; rate, ¥, model, unit set locked', () => {
  const before = { lot: lot(), units: [unit('1'), unit('2')] };
  const okEdit = {
    lot: lot({ shipFee: 800000 }),
    units: [unit('1', { costOverride: 4000000, listPrice: 7000000, serialNo: 'S1', note: 'x' }), unit('2')],
  };
  assert.equal(checkLotEdit(before, okEdit).ok, true);
  const code = (after: typeof before) => {
    const r = checkLotEdit(before, after);
    return r.ok ? 'ok' : `${r.error.code}:${r.error.field}`;
  };
  assert.equal(code({ lot: lot({ rate: 3650 }), units: before.units }), 'LOT_LOCKED:rate');
  assert.equal(code({ lot: lot({ buyingFeePct: 3 }), units: before.units }), 'LOT_LOCKED:buyingFeePct'); // CR-003
  assert.equal(code({ lot: lot({ buyingFeePct: 0 }), units: before.units }), 'ok'); // missing = 0 ⇒ không đổi
  assert.equal(code({ lot: lot(), units: [unit('1')] }), 'LOT_LOCKED:units');
  assert.equal(code({ lot: lot(), units: [...before.units, unit('3')] }), 'LOT_LOCKED:units');
  assert.equal(code({ lot: lot(), units: [unit('1', { priceCny: 1000 }), unit('2')] }), 'LOT_LOCKED:priceCny');
  assert.equal(code({ lot: lot(), units: [unit('1', { modelId: 'ju' }), unit('2')] }), 'LOT_LOCKED:modelId');
  // open lot: anything goes
  const open = { lot: lot({ status: 'ordered', receivedAt: null }), units: before.units };
  assert.equal(checkLotEdit(open, { lot: lot({ status: 'ordered', rate: 3700 }), units: [unit('1', { priceCny: 999 })] }).ok, true);
  assert.equal(checkLotEdit(open, { lot: lot({ status: 'ordered', buyingFeePct: 2.5 }), units: before.units }).ok, true);
});
