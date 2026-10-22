/**
 * Scenario: replay the prototype's full mock history (hand-verified figures, simulated today 2026-10-22).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lots, orders, transfers } from './prototype-history.fixture.ts';
import {
  computeInventory,
  customersTotalDue,
  decideNewOrderStatus,
  incomingSummary,
  intermediaryDebt,
  orderProfit,
  profitForMonth,
  setLotShipFee,
  shipOrder,
  stockValue,
} from './index.ts';

const replayed = () => {
  const r = computeInventory(lots, orders);
  assert.ok(r.ok, !r.ok ? r.error.message : '');
  return r.value;
};

test('scenario: October 2026 profit = 5.368.600 ₫', () => {
  const { orders: os } = replayed();
  const oct = profitForMonth(os, '2026-10');
  assert.equal(oct.profit, 5368600);
  assert.equal(oct.orders, 2);
  // per order: D-003 7.300.000 − 4.440.000 − 45.000 ship (shop); D-004 6.700.000 − 4.146.400
  assert.equal(orderProfit(os.find((o) => o.id === 'o3')!), 2815000);
  assert.equal(orderProfit(os.find((o) => o.id === 'o4')!), 2553600);
});

test('scenario: stock value (on hand × average) = 10.351.200 ₫', () => {
  const { stock, inventory } = replayed();
  assert.equal(stockValue(stock), 10351200);
  assert.deepEqual(stock.v1, { onHand: 2, avgCost: 2955600 });
  assert.deepEqual(stock.v2, { onHand: 0, avgCost: 4146400 });
  assert.deepEqual(stock.v4, { onHand: 1, avgCost: 4440000 });
  // BR-06 for K Ultra Đen: 0 on hand, 2 incoming (L-004), 1 reserved (D-005 datTruoc) → 1 sellable
  assert.equal(inventory.v2.sellable, 1);
  // ZP6: 2 on hand, 2 incoming (L-005), 1 reserved (D-006) → 3
  assert.equal(inventory.v1.sellable, 3);
});

test('scenario: incoming = 5 units / 17.210.200 ₫ payable', () => {
  assert.deepEqual(incomingSummary(lots), { qty: 5, payable: 17210200 });
});

test("scenario: customers' total due = 15.290.000 ₫", () => {
  assert.equal(customersTotalDue(orders), 15290000);
});

test('scenario: intermediary debt = 4.649.800 ₫', () => {
  assert.equal(intermediaryDebt(lots, transfers), 4649800);
});

test('scenario: next steps behave per rules (new order status, shipping a pre-order without stock)', () => {
  const { inventory, stock } = replayed();
  // 1 more K Ultra Đen: sellable 1, on shelf 0 → datTruoc; 2 → rejected
  assert.deepEqual(decideNewOrderStatus([{ variantId: 'v2', qty: 1 }], inventory), { ok: true, value: 'datTruoc' });
  assert.equal(decideNewOrderStatus([{ variantId: 'v2', qty: 2 }], inventory).ok, false);
  // D-005 is datTruoc → must be confirmed first (Q-007)
  const o5 = orders.find((o) => o.id === 'o5')!;
  const r = shipOrder(o5, stock, '2026-10-22');
  assert.ok(!r.ok);
  assert.equal(r.error.code, 'INVALID_TRANSITION');
  // even once confirmed, K Ultra Đen has 0 on hand (BR-09)
  const r2 = shipOrder({ ...o5, status: 'daChot' }, stock, '2026-10-22');
  assert.ok(!r2.ok);
  assert.equal(r2.error.rule, 'BR-09');
  // D-006 (daChot ZP6, 2 on hand) ships at the current average 2.955.600
  const r3 = shipOrder(orders.find((o) => o.id === 'o6')!, stock, '2026-10-22');
  assert.ok(r3.ok);
  assert.equal(r3.value.order.lines[0].cost, 2955600);
});

test('scenario Q-008: raising L-003 ship fee after D-003 shipped keeps October profit; J Ultra left absorbs it', () => {
  const first = replayed(); // fills frozen costs on sent orders
  const l3 = lots.find((l) => l.id === 'l3')!;
  const edited = setLotShipFee(l3, 1000000); // unit cost 4.140.000 + 500.000 = 4.640.000
  assert.ok(edited.ok);
  const r = computeInventory(lots.map((l) => (l.id === 'l3' ? edited.value : l)), first.orders);
  assert.ok(r.ok);
  assert.equal(r.value.orders.find((o) => o.id === 'o3')!.lines[0].cost, 4440000);
  assert.equal(profitForMonth(r.value.orders, '2026-10').profit, 5368600);
  // v4: 2 × 4.640.000 received − 4.440.000 shipped = 4.840.000 for the 1 unit left
  assert.deepEqual(r.value.stock.v4, { onHand: 1, avgCost: 4840000 });
  assert.equal(stockValue(r.value.stock), 5911200 + 4840000);
});
