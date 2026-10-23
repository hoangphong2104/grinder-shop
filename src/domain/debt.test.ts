import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Lot, Transfer, Unit } from './types.ts';
import { intermediaryBalance, intermediaryDebt, totalPayable, transferEffect } from './debt.ts';

const lot = (over: Partial<Lot> = {}): Lot => ({ id: 'L1', rate: 3600, shipFee: 600000, status: 'vn_shipping', receivedAt: null, ...over });
const unit = (id: string, lotId = 'L1', over: Partial<Unit> = {}): Unit => ({
  id, code: id, modelId: 'ku', lotId, priceCny: 1010, costOverride: null, listPrice: null, ...over,
});
const units = [unit('a'), unit('b')];
const sent = (amount: number, over: Partial<Transfer> = {}): Transfer => ({ kind: 'transfer', amount, ...over });

test('BR-12 approved example: payable 7.872.000 − transfer 5.000.000 → debt 2.872.000', () => {
  assert.equal(totalPayable([lot()], units), 7872000);
  assert.equal(intermediaryDebt([lot()], units, [sent(5000000)]), 2872000);
});

test('A4: payable ignores hand-entered ₫ costs', () => {
  assert.equal(intermediaryDebt([lot()], [unit('a', 'L1', { costOverride: 1 }), unit('b')], [sent(5000000)]), 2872000);
});

test('BR-12: payable follows lot edits (ship fee entered later) and cancellation', () => {
  assert.equal(intermediaryDebt([lot({ shipFee: null })], units, [sent(5000000)]), 2272000);
  assert.equal(intermediaryDebt([lot({ status: 'cancelled' })], units, [sent(5000000)]), -5000000);
});

test('BR-12: adjustments are signed (+ increases debt, − decreases); several lots', () => {
  const lots = [lot(), lot({ id: 'L2', rate: 3500, shipFee: 100000 })];
  const us = [...units, unit('c', 'L2', { priceCny: 1000 })]; // L2: 1.000 × 3.500 + 100.000 = 3.600.000
  const ts = [sent(5000000), sent(10000, { kind: 'adjustment' }), sent(-2000, { kind: 'adjustment' })];
  assert.deepEqual(intermediaryBalance(lots, us, ts), {
    totalPayable: 7872000 + 3600000,
    totalTransferred: 5000000,
    totalAdjustment: 8000,
    balance: 7872000 + 3600000 - 5000000 + 8000,
  });
  assert.equal(transferEffect(sent(5)), -5);
  assert.equal(transferEffect(sent(-5, { kind: 'adjustment' })), -5);
});
