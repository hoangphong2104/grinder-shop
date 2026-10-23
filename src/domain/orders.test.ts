import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Lot, Order, Unit } from './types.ts';
import {
  canShip,
  checkCancelOrder,
  checkOrderUnits,
  checkUnitAvailable,
  completeOrder,
  customersTotalDue,
  orderMargin,
  orderPaid,
  orderProfit,
  orderReceivable,
  orderRefundDue,
  orderStatusFor,
  orderTotal,
  preordersToAutoConfirm,
  profitForMonth,
} from './orders.ts';

const received: Lot = { id: 'R', rate: 3600, shipFee: 600000, status: 'received', receivedAt: '2026-10-03' };
const incoming: Lot = { id: 'I', rate: 3610, shipFee: null, status: 'vn_shipping', receivedAt: null };
const cancelled: Lot = { id: 'C', rate: 3610, shipFee: null, status: 'cancelled', receivedAt: null };
const lots = [received, incoming, cancelled];
const unit = (id: string, lotId: string): Unit => ({ id, code: `KU-${id}`, modelId: 'ku', lotId, priceCny: 1010, costOverride: null, listPrice: 6800000 });
const units = [unit('r1', 'R'), unit('r2', 'R'), unit('i1', 'I'), unit('i2', 'I'), unit('c1', 'C')];
const order = (over: Partial<Order> = {}): Order => ({
  id: 'O', code: 'D-010', status: 'confirmed', shippedAt: null, shipFee: 0, shipPayer: 'customer',
  lines: [{ unitId: 'r1', price: 4500000 }], payments: [], ...over,
});

/* ---------- A6 availability & status ---------- */

test('A6: availability — in stock / incoming ok; cancelled lot, held, sold rejected', () => {
  assert.deepEqual(checkUnitAvailable(units[0]!, received, []), { ok: true, value: 'in_stock' });
  assert.deepEqual(checkUnitAvailable(units[2]!, incoming, []), { ok: true, value: 'incoming' });
  const c = checkUnitAvailable(units[4]!, cancelled, []);
  assert.ok(!c.ok);
  assert.equal(c.error.code, 'UNIT_UNAVAILABLE');
  assert.equal(c.error.message, 'Chiếc KU-c1 thuộc lô đã huỷ.');
  const held = checkUnitAvailable(units[0]!, received, [order({ id: 'other', code: 'D-005', status: 'preorder' })]);
  assert.ok(!held.ok);
  assert.equal(held.error.message, 'Chiếc KU-r1 đã giữ cho D-005.');
  assert.equal(held.error.conflictOrderId, 'other');
  const sold = checkUnitAvailable(units[0]!, received, [order({ id: 'other', code: 'D-002', status: 'completed' })]);
  assert.ok(!sold.ok);
  assert.equal(sold.error.message, 'Chiếc KU-r1 đã bán (D-002).');
  // held by a cancelled order → free; held by the order being edited → free
  assert.equal(checkUnitAvailable(units[0]!, received, [order({ id: 'x', status: 'cancelled' })]).ok, true);
  assert.equal(checkUnitAvailable(units[0]!, received, [order({ id: 'self' })], 'self').ok, true);
});

test('A6: order status — any incoming unit → preorder, all received → confirmed', () => {
  assert.equal(orderStatusFor([units[0]!, units[1]!], lots), 'confirmed');
  assert.equal(orderStatusFor([units[0]!, units[2]!], lots), 'preorder');
  assert.equal(orderStatusFor([units[2]!], lots), 'preorder');
});

test('A6: checkOrderUnits — empty, duplicate, unknown, conflict, and the resulting status', () => {
  const st = (ids: string[], orders: Order[] = [], forId?: string) => {
    const r = checkOrderUnits(ids, units, lots, orders, forId);
    return r.ok ? r.value.status : r.error.code;
  };
  assert.equal(st(['r1', 'r2']), 'confirmed');
  assert.equal(st(['r1', 'i1']), 'preorder');
  assert.equal(st([]), 'INVALID_INPUT');
  assert.equal(st(['r1', 'r1']), 'INVALID_INPUT');
  assert.equal(st(['nope']), 'INVALID_INPUT');
  assert.equal(st(['c1']), 'UNIT_UNAVAILABLE');
  const other = order({ id: 'B', code: 'D-011', status: 'preorder', lines: [{ unitId: 'i1', price: 1 }] });
  assert.equal(st(['i1'], [other]), 'UNIT_UNAVAILABLE');
  assert.equal(st(['i1', 'r2'], [other], 'B'), 'preorder'); // editing B itself
});

/* ---------- A8 / Q-007 shipping ---------- */

test('A8 + Q-007: ship only confirmed orders whose units are all received', () => {
  assert.deepEqual(canShip(order(), units, lots), { ok: true, value: true });
  const pre = canShip(order({ status: 'preorder', lines: [{ unitId: 'i1', price: 1 }] }), units, lots);
  assert.ok(!pre.ok);
  assert.equal(pre.error.code, 'INVALID_TRANSITION');
  assert.equal(pre.error.rule, 'Q-007');
  // a confirmed order that (after an edit) contains an incoming unit
  const nr = canShip(order({ lines: [{ unitId: 'r1', price: 1 }, { unitId: 'i2', price: 1 }] }), units, lots);
  assert.ok(!nr.ok);
  assert.equal(nr.error.code, 'NOT_RECEIVED');
  assert.equal(nr.error.rule, 'A8');
  assert.equal(nr.error.message, 'Chiếc KU-i2 chưa về kho (lô đang "Đang về VN").');
  assert.equal(canShip(order({ status: 'shipped' }), units, lots).ok, false);
  assert.equal(canShip(order({ lines: [] }), units, lots).ok, false);
});

/* ---------- A7 auto-confirm ---------- */

test('A7: receiving a lot auto-confirms pre-orders whose units are now all received', () => {
  const nowReceived = lots.map((l) => (l.id === 'I' ? { ...l, status: 'received' as const, shipFee: 700000, receivedAt: '2026-10-23' } : l));
  const other: Lot = { id: 'X', rate: 3600, shipFee: null, status: 'ordered', receivedAt: null };
  const allUnits = [...units, unit('x1', 'X')];
  const os = [
    order({ id: 'a', status: 'preorder', lines: [{ unitId: 'i1', price: 1 }] }), // → confirm
    order({ id: 'b', status: 'preorder', lines: [{ unitId: 'i2', price: 1 }, { unitId: 'x1', price: 1 }] }), // x1 still incoming
    order({ id: 'c', status: 'preorder', lines: [{ unitId: 'r1', price: 1 }, { unitId: 'i2', price: 1 }] }), // mix → confirm
    order({ id: 'd', status: 'cancelled', lines: [{ unitId: 'i1', price: 1 }] }),
    order({ id: 'e', status: 'confirmed', lines: [{ unitId: 'r2', price: 1 }] }),
  ];
  assert.deepEqual(preordersToAutoConfirm('I', allUnits, [...nowReceived, other], os).map((o) => o.id), ['a', 'c']);
  // same result when `lots` still shows the old status of the lot just received
  assert.deepEqual(preordersToAutoConfirm('I', allUnits, [...lots, other], os).map((o) => o.id), ['a', 'c']);
  // a lot unrelated to any pre-order confirms nothing
  assert.deepEqual(preordersToAutoConfirm('R', allUnits, [...lots, other], os), []);
});

/* ---------- Cancel / complete ---------- */

test('§2: cancel only before shipping', () => {
  assert.equal(checkCancelOrder(order({ status: 'preorder' })).ok, true);
  assert.equal(checkCancelOrder(order()).ok, true);
  assert.equal(checkCancelOrder(order({ status: 'shipped' })).ok, false);
  assert.equal(checkCancelOrder(order({ status: 'cancelled' })).ok, false);
});

test('BR-10 + Q-010: complete needs receivable = 0 (under- or overpaid needs confirmation)', () => {
  const sent = order({ status: 'shipped', shippedAt: '2026-10-12', payments: [{ kind: 'deposit', amount: 1000000 }] });
  const r = completeOrder(sent);
  assert.ok(!r.ok);
  assert.equal(r.error.code, 'OUTSTANDING_DUE');
  assert.equal(r.error.amount, 3500000);
  assert.equal(r.error.message, 'Khách còn nợ 3.500.000 ₫. Xác nhận nếu vẫn muốn hoàn tất.');
  const forced = completeOrder(sent, { acceptOutstanding: true });
  assert.equal(forced.ok && forced.value.status, 'completed');
  assert.equal(completeOrder({ ...sent, payments: [{ kind: 'payment', amount: 4500000 }] }).ok, true);
  const over = completeOrder({ ...sent, payments: [{ kind: 'payment', amount: 4600000 }] });
  assert.ok(!over.ok);
  assert.match(over.error.message, /trả dư 100\.000 ₫/);
  assert.equal(completeOrder(order()).ok, false);
});

/* ---------- Money: BR-10, Q-009, Q-015 ---------- */

test('BR-10 approved example: total 4.500.000, deposit 1.000.000 → receivable 3.500.000', () => {
  const o = order({ payments: [{ kind: 'deposit', amount: 1000000 }] });
  assert.equal(orderTotal(o), 4500000);
  assert.equal(orderReceivable(o), 3500000);
});

test('BR-10 / Q-015: ship fee is added to the total only when the customer pays it', () => {
  const lines = [{ unitId: 'r1', price: 2000000 }, { unitId: 'r2', price: 2000000 }];
  assert.equal(orderTotal(order({ lines, shipFee: 40000, shipPayer: 'customer' })), 4040000);
  assert.equal(orderTotal(order({ lines, shipFee: 40000, shipPayer: 'shop' })), 4000000);
});

test('BR-10: refunds count negative; overpayment → negative receivable', () => {
  const o = order({ payments: [{ kind: 'deposit', amount: 1000000 }, { kind: 'payment', amount: 4000000 }, { kind: 'refund', amount: 500000 }] });
  assert.equal(orderPaid(o), 4500000);
  assert.equal(orderReceivable(o), 0);
  assert.equal(orderReceivable(order({ payments: [{ kind: 'payment', amount: 5000000 }] })), -500000);
});

test('Q-009: cancelled order — receivable 0, refund due = net paid until refunded', () => {
  const dep = { kind: 'deposit' as const, amount: 1000000 };
  const c = order({ status: 'cancelled', payments: [dep] });
  assert.equal(orderReceivable(c), 0);
  assert.equal(orderRefundDue(c), 1000000);
  assert.equal(orderRefundDue(order({ status: 'cancelled', payments: [dep, { kind: 'refund', amount: 400000 }] })), 600000);
  assert.equal(orderRefundDue(order({ status: 'cancelled', payments: [dep, { kind: 'refund', amount: 1000000 }] })), 0);
  assert.equal(orderRefundDue(order({ payments: [dep] })), 0); // live order: nothing to refund
});

test('customersTotalDue sums positive receivables only', () => {
  const owes = order({ id: 'a' });
  const over = order({ id: 'b', payments: [{ kind: 'payment', amount: 5000000 }] });
  const canc = order({ id: 'c', status: 'cancelled' });
  assert.equal(customersTotalDue([owes, over, canc]), 4500000);
});

/* ---------- Profit: BR-11 + A8, Q-015 ---------- */

const costs = new Map([['r1', 3200000], ['r2', 4440000]]);
const two = [{ unitId: 'r1', price: 4500000 }, { unitId: 'r2', price: 7000000 }];

test('BR-11: profit = Σ(price − effective cost) − ship the shop pays; only shipped / completed', () => {
  // 1.300.000 + 2.560.000 − 45.000
  assert.equal(orderProfit(order({ status: 'shipped', shippedAt: '2026-10-02', lines: two, shipFee: 45000, shipPayer: 'shop' }), costs), 3815000);
  // customer-paid ship is pass-through (Q-015): not revenue, not cost
  assert.equal(orderProfit(order({ status: 'completed', shippedAt: '2026-10-02', lines: two, shipFee: 45000, shipPayer: 'customer' }), costs), 3860000);
  for (const status of ['preorder', 'confirmed', 'cancelled'] as const) {
    assert.equal(orderProfit(order({ status, lines: two }), costs), null);
  }
  // estimate for an unshipped order uses the same formula
  assert.equal(orderMargin(order({ lines: two }), costs), 3860000);
});

test('BR-11: a line whose unit has no cost is a data error (throws)', () => {
  assert.throws(() => orderMargin(order({ lines: [{ unitId: 'zz', price: 1 }] }), costs), /no cost/);
});

test('profitForMonth groups by shippedAt month', () => {
  const os = [
    order({ id: '1', status: 'shipped', shippedAt: '2026-10-01', lines: [{ unitId: 'r1', price: 5000000 }] }),
    order({ id: '2', status: 'completed', shippedAt: '2026-09-30', lines: [{ unitId: 'r2', price: 5000000 }] }),
    order({ id: '3', status: 'confirmed', lines: [{ unitId: 'r2', price: 9000000 }] }),
  ];
  assert.deepEqual(profitForMonth(os, costs, '2026-10'), { month: '2026-10', profit: 1800000, revenue: 5000000, orders: 1, returns: 0 });
  assert.deepEqual(profitForMonth(os, costs, '2026-09'), { month: '2026-09', profit: 560000, revenue: 5000000, orders: 1, returns: 0 });
});
