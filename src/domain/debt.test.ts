import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Lot, Transfer } from './types.ts';
import { intermediaryDebt, intermediaryLedger, totalPayable } from './debt.ts';
import { validateTransfer } from './validate.ts';

const br01Lot = (over: Partial<Lot> = {}): Lot => ({
  id: 'L1', orderedAt: '2026-10-01', rate: 3600, shipFee: 600000, status: 'veVN', receivedAt: null,
  lines: [{ variantId: 'v', qty: 2, cny: 1010 }], ...over,
});
const sent = (amount: number, over: Partial<Transfer> = {}): Transfer => ({ id: 'T1', date: '2026-10-02', kind: 'chuyen', amount, ...over });

test('BR-12 approved example: payable 7.872.000 − transfer 5.000.000 → debt 2.872.000', () => {
  assert.equal(totalPayable([br01Lot()]), 7872000);
  assert.equal(intermediaryDebt([br01Lot()], [sent(5000000)]), 2872000);
});

test('BR-12: payable follows lot edits (ship fee entered later) and cancellation', () => {
  assert.equal(intermediaryDebt([br01Lot({ shipFee: null })], [sent(5000000)]), 2272000);
  assert.equal(intermediaryDebt([br01Lot({ status: 'huy' })], [sent(5000000)]), -5000000);
});

test('BR-12: adjustments are signed (+ increases debt, − decreases)', () => {
  const ts = [sent(5000000), sent(10000, { id: 'T2', kind: 'dieuChinh' }), sent(-2000, { id: 'T3', kind: 'dieuChinh' })];
  assert.equal(intermediaryDebt([br01Lot()], ts), 2872000 + 10000 - 2000);
});

test('ledger: chronological with running balance; cancelled lot stays at 0', () => {
  const lots = [br01Lot(), br01Lot({ id: 'L2', orderedAt: '2026-10-03', status: 'huy' })];
  const ts = [sent(5000000, { date: '2026-10-01' }), sent(1000, { id: 'T2', kind: 'dieuChinh', date: '2026-10-04' })];
  assert.deepEqual(intermediaryLedger(lots, ts), [
    { date: '2026-10-01', kind: 'phaiTra', refId: 'L1', amount: 7872000, balance: 7872000 },
    { date: '2026-10-01', kind: 'daChuyen', refId: 'T1', amount: -5000000, balance: 2872000 },
    { date: '2026-10-03', kind: 'phaiTra', refId: 'L2', amount: 0, balance: 2872000 },
    { date: '2026-10-04', kind: 'dieuChinh', refId: 'T2', amount: 1000, balance: 2873000 },
  ]);
});

test('transfer validation', () => {
  assert.equal(validateTransfer(sent(5000000)).ok, true);
  assert.equal(validateTransfer(sent(0)).ok, false);
  assert.equal(validateTransfer(sent(-1)).ok, false);
  assert.equal(validateTransfer(sent(1.5)).ok, false);
  assert.equal(validateTransfer(sent(-1, { kind: 'dieuChinh' })).ok, true);
  assert.equal(validateTransfer(sent(0, { kind: 'dieuChinh' })).ok, false);
});
