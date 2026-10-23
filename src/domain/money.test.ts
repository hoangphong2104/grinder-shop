import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCny, formatTr, formatVnd, roundVnd } from './money.ts';

/* ---------- Q-006 rounding ---------- */

test('roundVnd: half away from zero, float noise absorbed, no -0', () => {
  assert.equal(roundVnd(2.5), 3);
  assert.equal(roundVnd(-2.5), -3);
  assert.equal(roundVnd(1.005 * 1000), 1005); // 1004.9999999999999 in binary
  assert.equal(roundVnd(0.1 * 3 * 10), 3);
  assert.ok(Object.is(roundVnd(-0.4), 0));
  assert.throws(() => roundVnd(Number.NaN), RangeError);
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
  assert.equal(formatCny(745.5), '¥745,5');
  assert.equal(formatCny(-12), '−¥12');
  assert.equal(formatCny(null), '—');
});
