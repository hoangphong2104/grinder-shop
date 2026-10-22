import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Lot, Order, StockMap } from './types.ts';
import {
  averageAfterShipment,
  computeInventory,
  decideNewOrderStatus,
  incomingQty,
  receiveLot,
  replayHistory,
  reservedQty,
  sellableQty,
  setLotShipFee,
  shipOrder,
  stockValue,
  weightedAverage,
} from './stock.ts';
import { validateLot } from './validate.ts';
import { orderProfit } from './money.ts';

const lot = (over: Partial<Lot> = {}): Lot => ({
  id: 'L', orderedAt: '2026-10-01', rate: 3400, shipFee: 0, status: 'veVN', receivedAt: null,
  lines: [{ variantId: 'v', qty: 2, cny: 1000 }], ...over,
});

const order = (over: Partial<Order> = {}): Order => ({
  id: 'O', date: '2026-10-01', status: 'daChot', sentAt: null, shipFee: 0, shipPayer: 'khach',
  lines: [{ variantId: 'v', qty: 1, price: 4500000 }], payments: [], ...over,
});

/* ---------- BR-04 ---------- */

test('BR-04 approved example: 2 on hand at 3.000.000 + receive 2 at 3.400.000 → avg 3.200.000', () => {
  assert.equal(weightedAverage(2, 3000000, 2, 3400000), 3200000);
  const stock: StockMap = { v: { onHand: 2, avgCost: 3000000 } };
  const r = receiveLot(lot(), stock, '2026-10-05'); // 2 × ¥1.000 × 3.400 + 0 ship = 3.400.000/unit
  assert.ok(r.ok);
  assert.deepEqual(r.value.stock.v, { onHand: 4, avgCost: 3200000 });
  assert.equal(r.value.lot.status, 'daNhan');
  assert.equal(r.value.lot.receivedAt, '2026-10-05');
  // inputs untouched
  assert.deepEqual(stock.v, { onHand: 2, avgCost: 3000000 });
});

test('BR-04: receiving into empty stock sets avg = lot unit cost; avg unchanged by non-received lots', () => {
  const r = receiveLot(lot({ rate: 3600, shipFee: 600000, lines: [{ variantId: 'v', qty: 2, cny: 1010 }] }), {}, '2026-10-05');
  assert.ok(r.ok);
  assert.deepEqual(r.value.stock.v, { onHand: 2, avgCost: 3936000 });
});

test('BR-04: a lot with several lines updates each variant with its own unit cost (shared ship split by total qty)', () => {
  const l = lot({ rate: 3600, shipFee: 900000, lines: [{ variantId: 'a', qty: 2, cny: 1000 }, { variantId: 'b', qty: 1, cny: 1200 }] });
  const r = receiveLot(l, { a: { onHand: 1, avgCost: 3000000 } }, '2026-10-05');
  assert.ok(r.ok);
  assert.deepEqual(r.value.stock.a, { onHand: 3, avgCost: (3000000 + 2 * 3900000) / 3 });
  assert.deepEqual(r.value.stock.b, { onHand: 1, avgCost: 4620000 });
});

test('BR-04: average is kept unrounded internally', () => {
  const r = receiveLot(lot({ rate: 1, lines: [{ variantId: 'v', qty: 2, cny: 1000001 }] }), { v: { onHand: 1, avgCost: 1000000 } }, '2026-10-05');
  assert.ok(r.ok);
  assert.equal(r.value.stock.v.avgCost, 3000002 / 3);
});

/* ---------- BR-02 ---------- */

test('BR-02: receiving a lot with null ship fee → rule error, stock unchanged', () => {
  const r = receiveLot(lot({ shipFee: null }), {}, '2026-10-05');
  assert.equal(r.ok, false);
  assert.ok(!r.ok);
  assert.equal(r.error.code, 'SHIP_FEE_REQUIRED');
  assert.equal(r.error.rule, 'BR-02');
  assert.equal(r.error.field, 'shipFee');
});

test('BR-02: a lot may be created/validated with ship fee null, but not negative or fractional', () => {
  assert.equal(validateLot(lot({ shipFee: null })).ok, true);
  assert.equal(validateLot(lot({ shipFee: 0 })).ok, true);
  assert.equal(validateLot(lot({ shipFee: -1 })).ok, false);
  assert.equal(validateLot(lot({ shipFee: 100.5 })).ok, false);
});

test('receiveLot rejects already received or cancelled lots', () => {
  for (const status of ['daNhan', 'huy'] as const) {
    const r = receiveLot(lot({ status }), {}, '2026-10-05');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'INVALID_TRANSITION');
  }
});

test('qty 0 / negative / fractional and bad rate are rejected on lots', () => {
  for (const qty of [0, -1, 1.5]) {
    const r = receiveLot(lot({ lines: [{ variantId: 'v', qty, cny: 1000 }] }), {}, '2026-10-05');
    assert.ok(!r.ok, `qty ${qty}`);
    assert.equal(r.error.code, 'INVALID_INPUT');
    assert.equal(r.error.field, 'lines[0].qty');
  }
  assert.equal(validateLot(lot({ rate: 0 })).ok, false);
  assert.equal(validateLot(lot({ lines: [] })).ok, false);
  assert.equal(validateLot(lot({ lines: [{ variantId: 'v', qty: 1, cny: -5 }] })).ok, false);
});

/* ---------- BR-05 / BR-09 ---------- */

test('BR-05 approved example: ship 1 unit at avg 3.200.000 → line cost 3.200.000, avg unchanged', () => {
  const stock: StockMap = { v: { onHand: 4, avgCost: 3200000 } };
  const r = shipOrder(order(), stock, '2026-10-06');
  assert.ok(r.ok);
  assert.equal(r.value.order.status, 'daGui');
  assert.equal(r.value.order.sentAt, '2026-10-06');
  assert.equal(r.value.order.lines[0].cost, 3200000);
  assert.deepEqual(r.value.stock.v, { onHand: 3, avgCost: 3200000 });
  assert.deepEqual(stock.v, { onHand: 4, avgCost: 3200000 });
});

test('BR-05: snapshot rounds the unrounded average to whole đồng', () => {
  const r = shipOrder(order(), { v: { onHand: 3, avgCost: 3000002 / 3 } }, '2026-10-06');
  assert.ok(r.ok);
  assert.equal(r.value.order.lines[0].cost, 1000001);
});

test('BR-09: shipping with on hand < qty → rule error', () => {
  const r = shipOrder(order({ lines: [{ variantId: 'v', qty: 2, price: 4500000 }] }), { v: { onHand: 1, avgCost: 3000000 } }, '2026-10-06');
  assert.ok(!r.ok);
  assert.equal(r.error.code, 'INSUFFICIENT_STOCK');
  assert.equal(r.error.rule, 'BR-09');
  assert.equal(r.error.requested, 2);
  assert.equal(r.error.available, 1);
});

test('BR-09: several lines of the same variant are summed before checking', () => {
  const o = order({ lines: [{ variantId: 'v', qty: 1, price: 4500000 }, { variantId: 'v', qty: 1, price: 4400000 }] });
  const r = shipOrder(o, { v: { onHand: 1, avgCost: 3000000 } }, '2026-10-06');
  assert.ok(!r.ok);
  assert.equal(r.error.requested, 2);
  const ok2 = shipOrder(o, { v: { onHand: 2, avgCost: 3000000 } }, '2026-10-06');
  assert.ok(ok2.ok);
  assert.equal(ok2.value.stock.v.onHand, 0);
});

test('Q-007: only a daChot order can be shipped; datTruoc must be confirmed first even with stock', () => {
  const stock: StockMap = { v: { onHand: 5, avgCost: 3000000 } };
  assert.equal(shipOrder(order({ status: 'daChot' }), stock, '2026-10-06').ok, true);
  const pre = shipOrder(order({ status: 'datTruoc' }), stock, '2026-10-06');
  assert.ok(!pre.ok);
  assert.equal(pre.error.code, 'INVALID_TRANSITION');
  assert.match(pre.error.message, /chốt trước/);
  for (const status of ['daGui', 'hoanTat', 'huy'] as const) {
    const r = shipOrder(order({ status }), stock, '2026-10-06');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'INVALID_TRANSITION');
  }
});

test('Q-007: status is checked before stock (datTruoc with no stock → INVALID_TRANSITION, not BR-09)', () => {
  const r = shipOrder(order({ status: 'datTruoc' }), {}, '2026-10-06');
  assert.ok(!r.ok);
  assert.equal(r.error.code, 'INVALID_TRANSITION');
});

test('shipOrder ignores any pre-filled cost and snapshots the current average', () => {
  const r = shipOrder(order({ lines: [{ variantId: 'v', qty: 1, price: 4500000, cost: 1 }] }), { v: { onHand: 2, avgCost: 3200000 } }, '2026-10-06');
  assert.ok(r.ok);
  assert.equal(r.value.order.lines[0].cost, 3200000);
  assert.equal(r.value.stock.v.avgCost, 3200000);
});

test('shipOrder rejects qty 0 / negative lines', () => {
  for (const qty of [0, -2]) {
    const r = shipOrder(order({ lines: [{ variantId: 'v', qty, price: 4500000 }] }), { v: { onHand: 5, avgCost: 1 } }, '2026-10-06');
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'INVALID_INPUT');
  }
});

/* ---------- BR-06 ---------- */

test('BR-06 approved example: on hand 3, incoming 2, reserved 4 → sellable 1', () => {
  assert.equal(sellableQty(3, 2, 4), 1);
});

test('BR-06: incoming excludes received/cancelled lots; reserved counts datTruoc + daChot only', () => {
  const lots = [
    lot({ id: '1', status: 'dat', lines: [{ variantId: 'v', qty: 1, cny: 1 }] }),
    lot({ id: '2', status: 'trungGian', lines: [{ variantId: 'v', qty: 2, cny: 1 }, { variantId: 'w', qty: 5, cny: 1 }] }),
    lot({ id: '3', status: 'daNhan', receivedAt: '2026-10-02', lines: [{ variantId: 'v', qty: 3, cny: 1 }] }),
    lot({ id: '4', status: 'huy', lines: [{ variantId: 'v', qty: 4, cny: 1 }] }),
  ];
  assert.equal(incomingQty(lots, 'v'), 3);
  const orders = ['datTruoc', 'daChot', 'daGui', 'hoanTat', 'huy'].map((status, i) =>
    order({ id: String(i), status: status as Order['status'], sentAt: status === 'daGui' || status === 'hoanTat' ? '2026-10-03' : null, lines: [{ variantId: 'v', qty: 1, price: 1 }] }));
  assert.equal(reservedQty(orders, 'v'), 2);
  const inv = computeInventory(lots, orders);
  assert.ok(inv.ok);
  // on hand: received 3 − sent 2 = 1; incoming 3; reserved 2
  assert.deepEqual(
    { onHand: inv.value.inventory.v.onHand, incoming: inv.value.inventory.v.incoming, reserved: inv.value.inventory.v.reserved, sellable: inv.value.inventory.v.sellable, free: inv.value.inventory.v.free },
    { onHand: 1, incoming: 3, reserved: 2, sellable: 2, free: -1 },
  );
});

/* ---------- BR-07 ---------- */

test('BR-07 approved example: on hand 0, incoming 2, reserved 0, qty 1 → datTruoc', () => {
  const r = decideNewOrderStatus([{ variantId: 'v', qty: 1 }], { v: { onHand: 0, incoming: 2, reserved: 0 } });
  assert.deepEqual(r, { ok: true, value: 'datTruoc' });
});

test('BR-07: fits in on hand − reserved → daChot; boundary is inclusive', () => {
  assert.deepEqual(decideNewOrderStatus([{ variantId: 'v', qty: 2 }], { v: { onHand: 3, incoming: 0, reserved: 1 } }), { ok: true, value: 'daChot' });
  assert.deepEqual(decideNewOrderStatus([{ variantId: 'v', qty: 3 }], { v: { onHand: 3, incoming: 2, reserved: 1 } }), { ok: true, value: 'datTruoc' });
  assert.deepEqual(decideNewOrderStatus([{ variantId: 'v', qty: 4 }], { v: { onHand: 3, incoming: 2, reserved: 1 } }), { ok: true, value: 'datTruoc' });
});

test('BR-07: more than sellable → rejected', () => {
  const r = decideNewOrderStatus([{ variantId: 'v', qty: 2 }], { v: { onHand: 3, incoming: 2, reserved: 4 } });
  assert.ok(!r.ok);
  assert.equal(r.error.code, 'EXCEEDS_SELLABLE');
  assert.equal(r.error.rule, 'BR-07');
  assert.equal(r.error.available, 1);
  // unknown variant = nothing to sell
  assert.equal(decideNewOrderStatus([{ variantId: 'x', qty: 1 }], {}).ok, false);
});

test('BR-07: multi-line order is daChot only if every variant fits on the shelf', () => {
  const figures = { a: { onHand: 2, incoming: 0, reserved: 0 }, b: { onHand: 0, incoming: 1, reserved: 0 } };
  assert.deepEqual(decideNewOrderStatus([{ variantId: 'a', qty: 1 }, { variantId: 'b', qty: 1 }], figures), { ok: true, value: 'datTruoc' });
  assert.deepEqual(decideNewOrderStatus([{ variantId: 'a', qty: 1 }, { variantId: 'a', qty: 1 }], figures), { ok: true, value: 'daChot' });
  assert.equal(decideNewOrderStatus([{ variantId: 'a', qty: 2 }, { variantId: 'a', qty: 1 }], figures).ok, false);
});

test('BR-07: qty 0 / negative / fractional rejected', () => {
  for (const qty of [0, -1, 0.5]) {
    const r = decideNewOrderStatus([{ variantId: 'v', qty }], { v: { onHand: 10, incoming: 0, reserved: 0 } });
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'INVALID_INPUT');
  }
  assert.equal(decideNewOrderStatus([], {}).ok, false);
});

/* ---------- Replay ---------- */

test('replay: receipts before shipments on the same day; later receipt does not change past snapshots', () => {
  const lots = [
    lot({ id: 'a', status: 'daNhan', receivedAt: '2026-10-01', rate: 3000, lines: [{ variantId: 'v', qty: 1, cny: 1000 }] }),
    lot({ id: 'b', status: 'daNhan', receivedAt: '2026-10-05', rate: 3400, lines: [{ variantId: 'v', qty: 1, cny: 1000 }] }),
  ];
  const orders = [
    order({ id: 'late', status: 'daGui', sentAt: '2026-10-05' }),
    order({ id: 'early', status: 'hoanTat', sentAt: '2026-10-02' }),
  ];
  const r = replayHistory(lots, orders);
  assert.ok(r.ok);
  assert.equal(r.value.orders[1].lines[0].cost, 3000000); // early: only lot a
  assert.equal(r.value.orders[0].lines[0].cost, 3400000); // late: lot b received same day, avg of the 1 left
  assert.deepEqual(r.value.stock.v, { onHand: 0, avgCost: 3400000 });
  assert.equal(orders[0].lines[0].cost, undefined); // input not mutated
});

test('replay: history that ships more than on hand → BR-09 error; received lot without ship fee → BR-02', () => {
  const r = replayHistory([], [order({ status: 'daGui', sentAt: '2026-10-02' })]);
  assert.ok(!r.ok);
  assert.equal(r.error.rule, 'BR-09');
  const r2 = replayHistory([lot({ status: 'daNhan', receivedAt: '2026-10-01', shipFee: null })], []);
  assert.ok(!r2.ok);
  assert.equal(r2.error.rule, 'BR-02');
});

/* ---------- Q-008: frozen cost snapshots ---------- */

const editLot = (base: Lot, shipFee: number): Lot => {
  const r = setLotShipFee(base, shipFee);
  assert.ok(r.ok);
  return r.value;
};

test('Q-008: editing a received lot ship fee keeps shipped cost; remaining unit absorbs the gap', () => {
  // receive 2 @ 3.000.000 (¥1.000 × 3.000 + 0 ship), ship 1 → frozen 3.000.000
  const received = lot({ status: 'daNhan', receivedAt: '2026-10-01', rate: 3000, shipFee: 0 });
  const r1 = replayHistory([received], [order({ status: 'daGui', sentAt: '2026-10-02' })]);
  assert.ok(r1.ok);
  const shipped = r1.value.orders;
  assert.equal(shipped[0].lines[0].cost, 3000000);
  assert.deepEqual(r1.value.stock.v, { onHand: 1, avgCost: 3000000 });

  // edit ship fee 0 → 400.000 ⇒ unit cost 3.000.000 + 400.000 ÷ 2 = 3.200.000
  const edited = editLot(received, 400000);
  const r2 = replayHistory([edited], shipped);
  assert.ok(r2.ok);
  assert.equal(r2.value.orders[0].lines[0].cost, 3000000); // frozen
  assert.equal(orderProfit(r2.value.orders[0]), 4500000 - 3000000); // profit unchanged
  // remaining avg = 3.200.000 + 1 × (3.200.000 − 3.000.000) ÷ 1 = 3.400.000
  // (= value received 6.400.000 − frozen shipped 3.000.000, on 1 unit)
  assert.deepEqual(r2.value.stock.v, { onHand: 1, avgCost: 3400000 });

  // without stored costs (legacy data) the replay would re-snapshot at the new average
  const legacy = replayHistory([edited], [order({ status: 'daGui', sentAt: '2026-10-02' })]);
  assert.ok(legacy.ok);
  assert.equal(legacy.value.orders[0].lines[0].cost, 3200000);
  assert.equal(legacy.value.stock.v.avgCost, 3200000);
});

test('Q-008: several frozen shipments — value is conserved across them', () => {
  // receive 3 @ 3.000.000, ship 1 + 1 (frozen 3.000.000 each), then unit cost becomes 3.200.000
  const received = lot({ status: 'daNhan', receivedAt: '2026-10-01', rate: 3000, shipFee: 0, lines: [{ variantId: 'v', qty: 3, cny: 1000 }] });
  const os = [order({ id: 'a', status: 'daGui', sentAt: '2026-10-02' }), order({ id: 'b', status: 'hoanTat', sentAt: '2026-10-03' })];
  const r1 = replayHistory([received], os);
  assert.ok(r1.ok);
  const r2 = replayHistory([editLot(received, 600000)], r1.value.orders);
  assert.ok(r2.ok);
  assert.deepEqual(r2.value.orders.map((o) => o.lines[0].cost), [3000000, 3000000]);
  // 3 × 3.200.000 − 2 × 3.000.000 = 3.600.000 left on 1 unit
  assert.deepEqual(r2.value.stock.v, { onHand: 1, avgCost: 3600000 });
});

test('Q-008: when nothing is left in stock the gap is not carried (avg stays, on hand 0)', () => {
  const received = lot({ status: 'daNhan', receivedAt: '2026-10-01', rate: 3000, shipFee: 0, lines: [{ variantId: 'v', qty: 1, cny: 1000 }] });
  const r1 = replayHistory([received], [order({ status: 'daGui', sentAt: '2026-10-02' })]);
  assert.ok(r1.ok);
  const r2 = replayHistory([editLot(received, 200000)], r1.value.orders);
  assert.ok(r2.ok);
  assert.equal(r2.value.orders[0].lines[0].cost, 3000000);
  assert.deepEqual(r2.value.stock.v, { onHand: 0, avgCost: 3200000 });
});

test('Q-008: replaying unedited history with stored costs gives the same state as without (idempotent)', () => {
  const lots = [
    lot({ id: 'a', status: 'daNhan', receivedAt: '2026-10-01', rate: 3000, shipFee: 100000, lines: [{ variantId: 'v', qty: 3, cny: 1000 }] }),
    lot({ id: 'b', status: 'daNhan', receivedAt: '2026-10-04', rate: 3400, shipFee: 0, lines: [{ variantId: 'v', qty: 2, cny: 1000 }] }),
  ];
  const os = [order({ id: '1', status: 'daGui', sentAt: '2026-10-02' }), order({ id: '2', status: 'daGui', sentAt: '2026-10-05' })];
  const first = replayHistory(lots, os);
  assert.ok(first.ok);
  const again = replayHistory(lots, first.value.orders);
  assert.ok(again.ok);
  assert.deepEqual(again.value, first.value);
});

test('averageAfterShipment: BR-05 avg unchanged when frozen cost = round(avg)', () => {
  assert.equal(averageAfterShipment(3, 3000002 / 3, 1, 1000001), 3000002 / 3);
  assert.equal(averageAfterShipment(2, 3200000, 1, 3000000), 3400000);
  assert.equal(averageAfterShipment(1, 3200000, 1, 3000000), 3200000);
});

test('setLotShipFee: a received lot cannot have its ship fee cleared; invalid fee rejected', () => {
  const received = lot({ status: 'daNhan', receivedAt: '2026-10-01' });
  const cleared = setLotShipFee(received, null);
  assert.ok(!cleared.ok);
  assert.equal(cleared.error.rule, 'BR-02');
  assert.equal(setLotShipFee(lot({ status: 'veVN' }), null).ok, true);
  assert.equal(setLotShipFee(received, -1).ok, false);
});

test('replay rejects a stored cost that is not a whole-đồng amount', () => {
  const r = replayHistory(
    [lot({ status: 'daNhan', receivedAt: '2026-10-01' })],
    [order({ status: 'daGui', sentAt: '2026-10-02', lines: [{ variantId: 'v', qty: 1, price: 1, cost: 1.5 }] })],
  );
  assert.ok(!r.ok);
  assert.equal(r.error.field, 'lines[0].cost');
});

test('stockValue = Σ on hand × avg, rounded', () => {
  assert.equal(stockValue({ a: { onHand: 2, avgCost: 1000000.4 }, b: { onHand: 0, avgCost: 5 } }), 2000001);
});
