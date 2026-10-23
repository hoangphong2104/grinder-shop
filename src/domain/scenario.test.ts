/**
 * Scenario over the realistic fixture (shop.fixture.ts, today 2026-10-22). Every expected figure is
 * hand-computed; the arithmetic is in the comments (unit costs: see the fixture header).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TODAY, lots, models, orders, transfers, units } from './shop.fixture.ts';
import type { Lot } from './types.ts';
import {
  buildUnitViews,
  canShip,
  checkOrderUnits,
  checkReceiveLot,
  customersTotalDue,
  effectiveCosts,
  intermediaryBalance,
  lotPayable,
  modelStocks,
  orderProfit,
  orderReceivable,
  orderRefundDue,
  preordersToAutoConfirm,
  profitByMonth,
  stockValue,
  totalRefundDue,
} from './index.ts';

const costs = () => effectiveCosts(units, lots);
const byCode = (code: string) => units.find((u) => u.code === code)!;
const order = (code: string) => orders.find((o) => o.code === code)!;

test('scenario: unit costs (auto / override / provisional)', () => {
  const c = costs();
  assert.equal(c.get(byCode('ZP6-001').id), 2955600); // 760 × 3.560 + 750.000 ÷ 3
  assert.equal(c.get(byCode('KU-001').id), 4146400); // 1.080 × 3.580 + 560.000 ÷ 2
  assert.equal(c.get(byCode('KU-003').id), 3936000); // 1.010 × 3.600 + 600.000 ÷ 2
  assert.equal(c.get(byCode('KU-004').id), 4000000); // override
  assert.equal(c.get(byCode('JU-001').id), 4440000); // 1.150 × 3.600 + 900.000 ÷ 3
  assert.equal(c.get(byCode('ZP6-004').id), 2964000); // 740 × 3.600 + 900.000 ÷ 3
  assert.equal(c.get(byCode('KU-005').id), 3790500); // 1.050 × 3.610 + 0 (ship blank)
  assert.equal(c.get(byCode('ZP6-005').id), 2698710); // 745,5 × 3.620 + 0
});

test('scenario: lot payables and intermediary debt = 2.004.020', () => {
  const p = Object.fromEntries(lots.map((l) => [l.code, lotPayable(l, units)]));
  assert.deepEqual(p, {
    'L-001': 8866800, // 2.280 × 3.560 = 8.116.800 + 750.000
    'L-002': 8292800, // 2.160 × 3.580 = 7.732.800 + 560.000
    'L-003': 7872000, // 2.020 × 3.600 = 7.272.000 + 600.000 (override of KU-004 ignored, A4)
    'L-004': 11844000, // 3.040 × 3.600 = 10.944.000 + 900.000
    'L-005': 7581000, // 2.100 × 3.610, ship blank
    'L-006': 5397420, // 1.491 × 3.620, ship blank
    'L-007': 0, // cancelled
  });
  // Σ payable 49.854.020 − transfers (9 + 8 + 7,9 + 11 + 7 + 5 = 47.900.000) + adjustment 50.000
  assert.deepEqual(intermediaryBalance(lots, units, transfers), {
    totalPayable: 49854020,
    totalTransferred: 47900000,
    totalAdjustment: 50000,
    balance: 2004020,
  });
});

test('scenario: unit statuses (A5) and days in stock', () => {
  const v = new Map(buildUnitViews(units, lots, orders, TODAY).map((x) => [x.unit.code, x]));
  const status = Object.fromEntries([...v].map(([code, x]) => [code, x.status]));
  assert.deepEqual(status, {
    'ZP6-001': 'sold', 'ZP6-002': 'reserved', 'ZP6-003': 'reserved', 'ZP6-004': 'in_stock', 'ZP6-005': 'reserved', 'ZP6-006': 'incoming',
    'KU-001': 'sold', 'KU-002': 'in_stock', // D-007 cancelled → released
    'KU-003': 'sold', 'KU-004': 'in_stock', 'KU-005': 'reserved', 'KU-006': 'incoming',
    'JU-001': 'sold', 'JU-002': 'in_stock', 'JU-003': 'cancelled',
  });
  assert.equal(v.get('ZP6-005')!.holder?.code, 'D-008'); // reserved while still incoming (D4)
  assert.equal(v.get('ZP6-004')!.daysInStock, 16); // 06/10 → 22/10
  assert.equal(v.get('KU-002')!.daysInStock, 34); // 18/09 → 22/10
  assert.equal(v.get('ZP6-002')!.daysInStock, 42); // 10/09 → 22/10 (reserved, still on the shelf)
  assert.equal(v.get('JU-001')!.daysInStock, 1); // 06/10 → shipped 07/10
  assert.equal(v.get('KU-006')!.daysInStock, null); // not received
  assert.equal(v.get('JU-001')!.profit, 7300000 - 4440000); // unit margin, ship not included
  assert.equal(v.get('ZP6-002')!.expectedProfit, 4650000 - 2955600); // agreed price on D-006
  assert.equal(v.get('KU-006')!.expectedProfit, 6900000 - 3790500); // list price − provisional cost
  assert.equal(v.get('KU-006')!.cost.provisional, true);
});

test('scenario: model stock (A9) and stock value = 21.461.600', () => {
  const s = Object.fromEntries(modelStocks(models, units, lots, orders).map((x) => [x.modelId, x]));
  // ZP6: in stock 004 · incoming 006 · reserved 002, 003, 005 · sold 001 → sellable 1 + 1 = 2 > 1
  // value = 002 + 003 (2 × 2.955.600) + 004 (2.964.000) = 8.875.200
  assert.deepEqual(s['m-zp6'], { modelId: 'm-zp6', inStock: 1, incoming: 1, reserved: 3, sold: 1, onHand: 3, sellable: 2, lowStock: false, stockValue: 8875200 });
  // KU: in stock 002, 004 · incoming 006 · reserved 005 · sold 001, 003 → sellable 3
  // value = 4.146.400 + 4.000.000 = 8.146.400
  assert.deepEqual(s['m-ku'], { modelId: 'm-ku', inStock: 2, incoming: 1, reserved: 1, sold: 2, onHand: 2, sellable: 3, lowStock: false, stockValue: 8146400 });
  // JU: in stock 002 · sold 001 · 003 cancelled (not counted) → sellable 1 ≤ threshold 1 → low
  assert.deepEqual(s['m-ju'], { modelId: 'm-ju', inStock: 1, incoming: 0, reserved: 0, sold: 1, onHand: 1, sellable: 1, lowStock: true, stockValue: 4440000 });
  assert.equal(stockValue(units, lots, orders), 8875200 + 8146400 + 4440000);
});

test('scenario: profit by ship month — Sep 4.263.000, Oct 5.579.000', () => {
  // Sep: D-001 4.600.000 − 2.955.600 − 35.000 (shop ship) = 1.609.400; D-002 6.800.000 − 4.146.400 = 2.653.600 (ship 40.000 pass-through)
  // Oct: D-003 7.300.000 − 4.440.000 − 45.000 = 2.815.000; D-004 6.700.000 − 3.936.000 = 2.764.000
  assert.deepEqual(profitByMonth(orders, costs()), [
    { month: '2026-09', profit: 4263000, revenue: 11400000, orders: 2 },
    { month: '2026-10', profit: 5579000, revenue: 14000000, orders: 2 },
  ]);
  assert.equal(orderProfit(order('D-005'), costs()), null); // not shipped
});

test('scenario: receivables 24.010.000, refund due 600.000 (D-007)', () => {
  const r = Object.fromEntries(orders.map((o) => [o.code, orderReceivable(o)]));
  assert.deepEqual(r, {
    'D-001': 0, // 4.600.000 − (1.000.000 + 3.600.000)
    'D-002': 0, // 6.800.000 + 40.000 − 6.840.000
    'D-003': 5300000, // 7.300.000 − 2.000.000 (shop pays the ship)
    'D-004': 0,
    'D-005': 5430000, // 6.900.000 + 30.000 − 1.500.000
    'D-006': 4180000, // 4.650.000 + 30.000 − 500.000
    'D-007': 0, // cancelled
    'D-008': 9100000, // 4.600.000 + 4.500.000
  });
  assert.equal(customersTotalDue(orders), 24010000);
  assert.equal(orderRefundDue(order('D-007')), 600000); // 1.000.000 deposit − 400.000 refunded
  assert.equal(totalRefundDue(orders), 600000);
});

test('scenario A3: L-003 ship 600.000 → 800.000 moves D-004 profit and October, not KU-004 (override)', () => {
  const edited: Lot[] = lots.map((l) => (l.id === 'l3' ? { ...l, shipFee: 800000 } : l));
  const c = effectiveCosts(units, edited);
  assert.equal(c.get(byCode('KU-003').id), 4036000); // 3.636.000 + 400.000
  assert.equal(c.get(byCode('KU-004').id), 4000000);
  assert.equal(orderProfit(order('D-004'), c), 2664000); // 6.700.000 − 4.036.000
  assert.equal(profitByMonth(orders, c)[1]!.profit, 5479000); // 5.579.000 − 100.000
  assert.equal(intermediaryBalance(edited, units, transfers).balance, 2204020); // + 200.000
});

test('scenario A7: receiving L-005 auto-confirms D-005 only; then L-006 confirms D-008', () => {
  const l5 = lots.find((l) => l.id === 'l5')!;
  assert.equal(checkReceiveLot(l5).ok, false); // BR-02: ship fee missing
  const l5r: Lot = { ...l5, shipFee: 700000, status: 'received', receivedAt: '2026-10-23' };
  assert.equal(checkReceiveLot({ ...l5, shipFee: 700000 }).ok, true);
  const after5 = lots.map((l) => (l.id === 'l5' ? l5r : l));
  assert.deepEqual(preordersToAutoConfirm('l5', units, after5, orders).map((o) => o.code), ['D-005']);
  assert.equal(effectiveCosts(units, after5).get(byCode('KU-005').id), 4140500); // 3.790.500 + 700.000 ÷ 2

  const after6 = after5.map((l) => (l.id === 'l6' ? { ...l, shipFee: 500000, status: 'received' as const, receivedAt: '2026-10-25' } : l));
  assert.deepEqual(preordersToAutoConfirm('l6', units, after6, orders).map((o) => o.code), ['D-008']);
});

test('scenario: new order picking (A6) and shipping (A8)', () => {
  // KU-002 is free again (D-007 cancelled) + JU-002 in stock → confirmed
  const a = checkOrderUnits([byCode('KU-002').id, byCode('JU-002').id], units, lots, orders);
  assert.ok(a.ok);
  assert.equal(a.value.status, 'confirmed');
  // KU-006 incoming → preorder
  const b = checkOrderUnits([byCode('KU-002').id, byCode('KU-006').id], units, lots, orders);
  assert.ok(b.ok);
  assert.equal(b.value.status, 'preorder');
  // KU-005 held by D-005
  const c = checkOrderUnits([byCode('KU-005').id], units, lots, orders);
  assert.ok(!c.ok);
  assert.equal(c.error.message, 'Chiếc KU-005 đã giữ cho D-005.');
  // D-006 (confirmed, ZP6-002 received) can ship; D-005 (preorder) cannot
  assert.deepEqual(canShip(order('D-006'), units, lots), { ok: true, value: true });
  const d = canShip(order('D-005'), units, lots);
  assert.ok(!d.ok);
  assert.equal(d.error.code, 'INVALID_TRANSITION');
});
