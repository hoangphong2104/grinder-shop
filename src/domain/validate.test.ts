import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Model, Order, Transfer, Unit } from './types.ts';
import { validateLot, validateModel, validateOrder, validatePayment, validateTransfer, validateUnit } from './validate.ts';

const field = (r: { ok: boolean; error?: { field?: string } }) => (r.ok ? 'ok' : r.error?.field);

test('validateModel: name, code prefix (D1), default price, threshold', () => {
  const m: Model = { id: 'm', name: 'K Ultra', codePrefix: 'KU', defaultListPrice: 6800000, lowStockThreshold: 1 };
  assert.equal(validateModel(m).ok, true);
  assert.equal(validateModel({ ...m, defaultListPrice: null }).ok, true);
  assert.equal(field(validateModel({ ...m, name: ' ' })), 'name');
  assert.equal(field(validateModel({ ...m, codePrefix: 'K-U' })), 'codePrefix');
  assert.equal(field(validateModel({ ...m, codePrefix: '' })), 'codePrefix');
  assert.equal(field(validateModel({ ...m, defaultListPrice: 1.5 })), 'defaultListPrice');
  assert.equal(field(validateModel({ ...m, lowStockThreshold: -1 })), 'lowStockThreshold');
});

test('validateLot: rate > 0 (BR-03), ship fee null or whole đồng ≥ 0 (BR-02)', () => {
  const l = { id: 'L', rate: 3600, shipFee: null, status: 'ordered' as const, receivedAt: null };
  assert.equal(validateLot(l).ok, true);
  assert.equal(field(validateLot({ ...l, rate: 0 })), 'rate');
  assert.equal(field(validateLot({ ...l, shipFee: -1 })), 'shipFee');
  assert.equal(field(validateLot({ ...l, shipFee: 0.5 })), 'shipFee');
});

test('validateUnit: ¥ > 0, override / list price null or whole đồng ≥ 0', () => {
  const u: Unit = { id: 'u', code: 'KU-001', modelId: 'ku', lotId: 'L', priceCny: 1010, costOverride: null, listPrice: 6800000 };
  assert.equal(validateUnit(u).ok, true);
  assert.equal(validateUnit({ ...u, priceCny: 99.5, costOverride: 0, listPrice: null }).ok, true);
  assert.equal(field(validateUnit({ ...u, priceCny: 0 })), 'priceCny');
  assert.equal(field(validateUnit({ ...u, costOverride: -5 })), 'costOverride');
  assert.equal(field(validateUnit({ ...u, listPrice: 1.2 })), 'listPrice');
  assert.equal(field(validateUnit({ ...u, code: '' })), 'code');
});

test('validateOrder: ≥ 1 line, each unit once, whole-đồng prices, ship, payer, payments', () => {
  const o: Order = { id: 'o', status: 'confirmed', shipFee: 30000, shipPayer: 'customer', lines: [{ unitId: 'a', price: 4500000 }], payments: [{ kind: 'deposit', amount: 1 }] };
  assert.equal(validateOrder(o).ok, true);
  assert.equal(field(validateOrder({ ...o, lines: [] })), 'lines');
  assert.equal(field(validateOrder({ ...o, lines: [{ unitId: 'a', price: 1 }, { unitId: 'a', price: 2 }] })), 'lines[1].unitId');
  assert.equal(field(validateOrder({ ...o, lines: [{ unitId: 'a', price: -1 }] })), 'lines[0].price');
  assert.equal(field(validateOrder({ ...o, shipFee: 0.5 })), 'shipFee');
  assert.equal(field(validateOrder({ ...o, shipPayer: 'x' as 'shop' })), 'shipPayer');
  assert.equal(field(validateOrder({ ...o, payments: [{ kind: 'refund', amount: -1 }] })), 'payments[0].amount');
  assert.equal(field(validatePayment({ kind: 'coc' as 'deposit', amount: 1 })), 'payments[0].kind');
});

test('validateTransfer: transfer > 0, adjustment signed ≠ 0, whole đồng', () => {
  const t = (amount: number, kind: Transfer['kind'] = 'transfer'): Transfer => ({ kind, amount });
  assert.equal(validateTransfer(t(5000000)).ok, true);
  assert.equal(validateTransfer(t(0)).ok, false);
  assert.equal(validateTransfer(t(-1)).ok, false);
  assert.equal(validateTransfer(t(1.5)).ok, false);
  assert.equal(validateTransfer(t(-1, 'adjustment')).ok, true);
  assert.equal(validateTransfer(t(0, 'adjustment')).ok, false);
  assert.equal(validateTransfer({ kind: 'payable' as 'transfer', amount: 1 }).ok, false);
});
