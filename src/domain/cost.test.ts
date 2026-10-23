import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Lot, Order, Unit } from './types.ts';
import {
  autoUnitCost,
  effectiveCost,
  effectiveCosts,
  isCostProvisional,
  lotGoodsVnd,
  lotPayable,
  lotUnitCount,
  unitCostBeforeShip,
  unitCosts,
} from './cost.ts';
import { orderProfit } from './orders.ts';

/* CR worked example: 1 lot, 2 units × ¥1.010, rate 3.600, lot ship 600.000. */
const lot = (over: Partial<Lot> = {}): Lot => ({ id: 'L', rate: 3600, shipFee: 600000, status: 'received', receivedAt: '2026-10-03', ...over });
const unit = (id: string, over: Partial<Unit> = {}): Unit => ({
  id, code: `KU-${id}`, modelId: 'ku', lotId: 'L', priceCny: 1010, costOverride: null, listPrice: 6800000, ...over,
});
const crUnits = (over: Partial<Unit> = {}): Unit[] => [unit('001'), unit('002', over)];

test('D2 CR example: 2 × ¥1.010, rate 3.600, ship 600.000 → each 1.010 × 3.600 + 600.000 ÷ 2 = 3.936.000', () => {
  const us = crUnits();
  assert.equal(lotUnitCount('L', us), 2);
  assert.equal(autoUnitCost(us[0]!, lot(), 2), 3936000);
  assert.deepEqual([...effectiveCosts(us, [lot()]).values()], [3936000, 3936000]);
});

test('A4 CR example: lot payable = round(2.020 × 3.600 + 600.000) = 7.872.000', () => {
  assert.equal(lotPayable(lot(), crUnits()), 7872000);
  assert.equal(lotGoodsVnd(lot(), crUnits()), 7272000);
});

test('A4: overriding one unit to 4.000.000 changes its effective cost, NOT the lot payable', () => {
  const us = crUnits({ costOverride: 4000000 });
  const c = unitCosts(us, [lot()]);
  assert.deepEqual(c.get('001'), { auto: 3936000, effective: 3936000, overridden: false, provisional: false });
  assert.deepEqual(c.get('002'), { auto: 3936000, effective: 4000000, overridden: true, provisional: false });
  assert.equal(lotPayable(lot(), us), 7872000);
});

test('A3 CR example: ship 600.000 → 800.000: non-overridden 4.036.000, overridden stays 4.000.000, sold unit profit follows', () => {
  const us = crUnits({ costOverride: 4000000 });
  // unit 001 is SOLD at 6.700.000 (shop pays no ship)
  const sold: Order = { id: 'o', code: 'D-004', status: 'shipped', shippedAt: '2026-10-12', shipFee: 0, shipPayer: 'shop', lines: [{ unitId: '001', price: 6700000 }], payments: [] };
  assert.equal(orderProfit(sold, effectiveCosts(us, [lot()])), 6700000 - 3936000); // 2.764.000

  const edited = lot({ shipFee: 800000 });
  const c = effectiveCosts(us, [edited]);
  assert.equal(c.get('001'), 1010 * 3600 + 800000 / 2); // 4.036.000
  assert.equal(c.get('002'), 4000000);
  assert.equal(orderProfit(sold, c), 6700000 - 4036000); // 2.664.000 — no frozen snapshot any more
  assert.equal(lotPayable(edited, us), 8072000); // 7.272.000 + 800.000
});

test('D2: ship fee blank → provisional cost = ¥ × rate only; override is never provisional', () => {
  const l = lot({ shipFee: null, status: 'vn_shipping', receivedAt: null });
  const us = crUnits({ costOverride: 3900000 });
  assert.equal(autoUnitCost(us[0]!, l, 2), 3636000);
  assert.equal(unitCostBeforeShip(us[0]!, l), 3636000);
  assert.equal(isCostProvisional(us[0]!, l), true);
  assert.equal(isCostProvisional(us[1]!, l), false);
  assert.equal(lotPayable(l, us), 7272000);
});

test('D2: ship fee is split over ALL units of the lot, across models and ¥ prices', () => {
  // 3 units, ship 900.000 → 300.000 each
  const l = lot({ shipFee: 900000 });
  const us = [unit('a', { priceCny: 1150, modelId: 'ju' }), unit('b', { priceCny: 1150, modelId: 'ju' }), unit('c', { priceCny: 740, modelId: 'zp6' })];
  const c = effectiveCosts(us, [l]);
  assert.equal(c.get('a'), 4140000 + 300000);
  assert.equal(c.get('c'), 2664000 + 300000);
  // payable: (1.150 + 1.150 + 740) × 3.600 + 900.000 = 10.944.000 + 900.000
  assert.equal(lotPayable(l, us), 11844000);
});

test('Q-006: one rounding per formula (half away from zero); Σ unit costs may differ from payable by a few đồng', () => {
  const l = lot({ shipFee: 100000, rate: 3600 });
  const us = [unit('a', { priceCny: 1000 }), unit('b', { priceCny: 1000 }), unit('c', { priceCny: 1000 })];
  // 3.600.000 + 33.333,33 → 3.633.333
  assert.equal(autoUnitCost(us[0]!, l, 3), 3633333);
  // 200.000 ÷ 3 = 66.666,67 → rounds up
  assert.equal(autoUnitCost(us[0]!, lot({ shipFee: 200000 }), 3), 3666667);
  // ¥99,5 × 3.601,5 = 358.349,25; + 1 ÷ 2 → 358.349,75 → 358.350
  assert.equal(autoUnitCost({ priceCny: 99.5 }, { rate: 3601.5, shipFee: 1 }, 2), 358350);
  // exact .5 rounds away from zero: ¥0,5 × 1 + 0 → 0,5 → 1
  assert.equal(autoUnitCost({ priceCny: 0.5 }, { rate: 1, shipFee: 0 }, 1), 1);
  assert.equal(3 * autoUnitCost(us[0]!, l, 3), 10899999);
  assert.equal(lotPayable(l, us), 10900000);
});

test('A4: Σ ¥ is multiplied by the rate once, then rounded (not per unit)', () => {
  const l = lot({ rate: 1, shipFee: 0 });
  // per unit: round(0,4) + round(0,4) = 0; on the sum: round(0,8) = 1
  assert.equal(lotPayable(l, [unit('a', { priceCny: 0.4 }), unit('b', { priceCny: 0.4 })]), 1);
});

test('A4: cancelled lot payable = 0; units of other lots are ignored', () => {
  assert.equal(lotPayable(lot({ status: 'cancelled' }), crUnits()), 0);
  assert.equal(lotPayable(lot(), [...crUnits(), unit('x', { lotId: 'OTHER', priceCny: 9999 })]), 7872000);
});

test('effectiveCost = override ?? auto; bad inputs are caller bugs (throw)', () => {
  assert.equal(effectiveCost({ costOverride: null }, 3936000), 3936000);
  assert.equal(effectiveCost({ costOverride: 0 }, 3936000), 0);
  assert.throws(() => autoUnitCost({ priceCny: 1 }, lot(), 0), RangeError);
  assert.throws(() => unitCosts([unit('a', { lotId: 'missing' })], [lot()]), /missing/);
});
