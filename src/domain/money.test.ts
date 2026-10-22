import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Lot, Order } from './types.ts';
import {
  completeOrder,
  customersTotalDue,
  formatCny,
  formatTr,
  formatVnd,
  lotPayable,
  orderDue,
  orderPaid,
  orderProfit,
  orderTotal,
  profitForMonth,
  roundVnd,
  unitCost,
  unitCostBeforeShip,
} from './money.ts';

const br01Lot = (over: Partial<Lot> = {}): Lot => ({
  id: 'L', orderedAt: '2026-10-01', rate: 3600, shipFee: 600000, status: 'veVN', receivedAt: null,
  lines: [{ variantId: 'v', qty: 2, cny: 1010 }], ...over,
});

const order = (over: Partial<Order> = {}): Order => ({
  id: 'O', date: '2026-10-01', status: 'daChot', sentAt: null, shipFee: 0, shipPayer: 'khach',
  lines: [{ variantId: 'v', qty: 1, price: 4500000 }], payments: [], ...over,
});

/* ---------- BR-01 ---------- */

test('BR-01 approved example: 2 × ¥1.010, rate 3.600, lot ship 600.000 → 3.936.000 ₫/unit', () => {
  const lot = br01Lot();
  assert.equal(unitCost(lot, lot.lines[0]), 3936000);
});

test('BR-01: unit cost is null while the ship fee is blank; ¥ × rate part still available', () => {
  const lot = br01Lot({ shipFee: null });
  assert.equal(unitCost(lot, lot.lines[0]), null);
  assert.equal(unitCostBeforeShip(lot, lot.lines[0]), 3636000);
});

test('BR-01: ship fee is split over the TOTAL lot quantity across several lines', () => {
  const lot = br01Lot({
    rate: 3600, shipFee: 900000,
    lines: [{ variantId: 'a', qty: 2, cny: 1000 }, { variantId: 'b', qty: 1, cny: 1200 }],
  });
  // 900.000 ÷ 3 = 300.000 per unit, regardless of line
  assert.equal(unitCost(lot, lot.lines[0]), 3600000 + 300000);
  assert.equal(unitCost(lot, lot.lines[1]), 4320000 + 300000);
});

test('BR-01: rounds to whole đồng (half away from zero), decimal ¥ and rate', () => {
  // 100.000 ÷ 3 = 33.333,33 → 1.000 × 3.600 + 33.333,33 = 3.633.333,33 → 3.633.333
  assert.equal(unitCost(br01Lot({ shipFee: 100000, lines: [{ variantId: 'v', qty: 3, cny: 1000 }] }), { variantId: 'v', qty: 3, cny: 1000 }), 3633333);
  // 200.000 ÷ 3 = 66.666,67 → rounds up
  assert.equal(unitCost(br01Lot({ shipFee: 200000, lines: [{ variantId: 'v', qty: 3, cny: 1000 }] }), { variantId: 'v', qty: 3, cny: 1000 }), 3666667);
  // ¥99,5 × 3.601,5 = 358.349,25 → 358.349; + 1 ÷ 2 = 0,5 → 358.349,75 → 358.350
  assert.equal(unitCost(br01Lot({ rate: 3601.5, shipFee: 1, lines: [{ variantId: 'v', qty: 2, cny: 99.5 }] }), { variantId: 'v', qty: 2, cny: 99.5 }), 358350);
});

test('roundVnd: half away from zero, float noise absorbed, no -0', () => {
  assert.equal(roundVnd(2.5), 3);
  assert.equal(roundVnd(-2.5), -3);
  assert.equal(roundVnd(1.005 * 1000), 1005); // 1004.9999999999999 in binary
  assert.equal(roundVnd(0.1 * 3 * 10), 3);
  assert.ok(Object.is(roundVnd(-0.4), 0));
  assert.throws(() => roundVnd(Number.NaN), RangeError);
});

/* ---------- BR-12 (per-lot payable) ---------- */

test('BR-12 approved example: lot payable = 2.020 × 3.600 + 600.000 = 7.872.000 ₫', () => {
  assert.equal(lotPayable(br01Lot()), 7872000);
});

test('BR-12: payable excludes ship fee until it is entered', () => {
  assert.equal(lotPayable(br01Lot({ shipFee: null })), 7272000);
});

test('BR-12: cancelled lot payable = 0', () => {
  assert.equal(lotPayable(br01Lot({ status: 'huy' })), 0);
});

test('BR-12: Σ(qty × ¥) is multiplied by the rate once, then rounded (not per line)', () => {
  // per line: round(0,4 × 1) + round(0,4 × 1) = 0; on the sum: round(0,8) = 1
  const lot = br01Lot({ rate: 1, shipFee: 0, lines: [{ variantId: 'a', qty: 1, cny: 0.4 }, { variantId: 'b', qty: 1, cny: 0.4 }] });
  assert.equal(lotPayable(lot), 1);
});

test('BR-01 vs BR-12: Σ rounded unit costs may differ from payable by a few đồng (rounding)', () => {
  const lot = br01Lot({ shipFee: 100000, lines: [{ variantId: 'v', qty: 3, cny: 1000 }] });
  assert.equal(3 * (unitCost(lot, lot.lines[0]) ?? 0), 10899999);
  assert.equal(lotPayable(lot), 10900000);
});

/* ---------- BR-10 ---------- */

test('BR-10 approved example: total 4.500.000, deposit 1.000.000 → due 3.500.000', () => {
  const o = order({ payments: [{ date: '2026-10-01', amount: 1000000, kind: 'coc' }] });
  assert.equal(orderTotal(o), 4500000);
  assert.equal(orderDue(o), 3500000);
});

test('BR-10: ship fee counts only when the customer pays it', () => {
  const lines = [{ variantId: 'v', qty: 2, price: 2000000 }];
  assert.equal(orderTotal(order({ lines, shipFee: 40000, shipPayer: 'khach' })), 4040000);
  assert.equal(orderTotal(order({ lines, shipFee: 40000, shipPayer: 'shop' })), 4000000);
});

test('BR-10: refunds count negative', () => {
  const o = order({
    payments: [
      { date: '2026-10-01', amount: 1000000, kind: 'coc' },
      { date: '2026-10-02', amount: 4000000, kind: 'tt' },
      { date: '2026-10-03', amount: 500000, kind: 'hoan' },
    ],
  });
  assert.equal(orderPaid(o), 4500000);
  assert.equal(orderDue(o), 0);
});

test('BR-10: cancelled order owes nothing; unrefunded deposit shows as negative due', () => {
  const dep = { date: '2026-10-01', amount: 1000000, kind: 'coc' as const };
  assert.equal(orderDue(order({ status: 'huy', payments: [dep] })), -1000000);
  assert.equal(orderDue(order({ status: 'huy', payments: [dep, { ...dep, kind: 'hoan' }] })), 0);
});

test('customersTotalDue sums positive dues only', () => {
  const owes = order({ id: 'a' });
  const over = order({ id: 'b', payments: [{ date: '2026-10-01', amount: 5000000, kind: 'tt' }] });
  assert.equal(customersTotalDue([owes, over]), 4500000);
});

test('BR-10: completing needs due = 0 unless the user confirms', () => {
  const sent = order({ status: 'daGui', sentAt: '2026-10-02', lines: [{ variantId: 'v', qty: 1, price: 4500000, cost: 3000000 }], payments: [{ date: '2026-10-01', amount: 1000000, kind: 'coc' }] });
  const r = completeOrder(sent);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.error.code, 'OUTSTANDING_DUE');
  assert.equal(!r.ok && r.error.rule, 'BR-10');
  const forced = completeOrder(sent, { acceptOutstanding: true });
  assert.equal(forced.ok && forced.value.status, 'hoanTat');
  const paid = completeOrder({ ...sent, payments: [{ date: '2026-10-01', amount: 4500000, kind: 'tt' }] });
  assert.equal(paid.ok, true);
  assert.equal(completeOrder(order({ status: 'daChot' })).ok, false);
});

/* ---------- BR-11 ---------- */

test('BR-11: profit = Σ qty × (price − cost) − ship the shop pays; only once sent', () => {
  const lines = [{ variantId: 'a', qty: 2, price: 4500000, cost: 3200000 }, { variantId: 'b', qty: 1, price: 7000000, cost: 4440000 }];
  assert.equal(orderProfit(order({ status: 'daGui', sentAt: '2026-10-02', lines, shipFee: 45000, shipPayer: 'shop' })), 2600000 + 2560000 - 45000);
  assert.equal(orderProfit(order({ status: 'hoanTat', sentAt: '2026-10-02', lines, shipFee: 45000, shipPayer: 'khach' })), 2600000 + 2560000);
  assert.equal(orderProfit(order({ status: 'daChot', lines })), null);
  assert.equal(orderProfit(order({ status: 'datTruoc', lines })), null);
  assert.equal(orderProfit(order({ status: 'huy', lines })), null);
});

test('BR-11: a sent order without cost snapshot is a data error (throws)', () => {
  assert.throws(() => orderProfit(order({ status: 'daGui', sentAt: '2026-10-02' })), /cost snapshot/);
});

test('profitForMonth groups by sentAt month', () => {
  const lines = [{ variantId: 'a', qty: 1, price: 5000000, cost: 3000000 }];
  const os = [
    order({ id: '1', status: 'daGui', sentAt: '2026-10-01', lines }),
    order({ id: '2', status: 'hoanTat', sentAt: '2026-09-30', lines }),
    order({ id: '3', status: 'daChot', lines }),
  ];
  assert.deepEqual(profitForMonth(os, '2026-10'), { profit: 2000000, orders: 1, revenue: 5000000 });
});

/* ---------- Formatting ---------- */

test('formatVnd', () => {
  assert.equal(formatVnd(3936000), '3.936.000 ₫');
  assert.equal(formatVnd(0), '0 ₫');
  assert.equal(formatVnd(-2872000), '−2.872.000 ₫');
  assert.equal(formatVnd(999.6), '1.000 ₫');
  assert.equal(formatVnd(null), '—');
});

test('formatTr', () => {
  assert.equal(formatTr(5400000), '5,4tr');
  assert.equal(formatTr(3000000), '3tr');
  assert.equal(formatTr(3200000), '3,2tr');
  assert.equal(formatTr(4649800), '4,6tr');
  assert.equal(formatTr(5350000), '5,4tr');
  assert.equal(formatTr(15290000), '15,3tr');
  assert.equal(formatTr(99960000), '100tr');
  assert.equal(formatTr(150400000), '150tr');
  assert.equal(formatTr(1234000000), '1.234tr');
  assert.equal(formatTr(120000), '120k');
  assert.equal(formatTr(999600), '1tr');
  assert.equal(formatTr(500), '500');
  assert.equal(formatTr(-2872000), '−2,9tr');
  assert.equal(formatTr(undefined), '—');
});

test('formatCny', () => {
  assert.equal(formatCny(1010), '¥1.010');
  assert.equal(formatCny(99.5), '¥99,5');
});
