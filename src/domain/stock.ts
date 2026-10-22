/**
 * Stock rules: BR-04 (weighted average on receipt), BR-05 (cost snapshot on shipment),
 * BR-06 (on hand / incoming / reserved / sellable), BR-07 (status of a new order),
 * BR-09 (no shipment beyond on hand), BR-02 (ship fee required to receive).
 * Pure: every function returns new objects; inputs are never mutated.
 */
import type { Inventory, IsoDate, Lot, Order, OrderLine, Result, RuleError, StockMap, Vnd, VariantStock } from './types.ts';
import { fail, ok } from './types.ts';
import { isSent, lotPayable, lotQty, roundVnd, unitCost } from './money.ts';
import { isIsoDate, validateLot, validateOrder, validateOrderLines } from './validate.ts';

const EMPTY: VariantStock = Object.freeze({ onHand: 0, avgCost: 0 });

export const stockOf = (stock: StockMap, variantId: string): VariantStock => stock[variantId] ?? EMPTY;

/** BR-04 — BQ mới = (có sẵn × BQ cũ + SL nhận × giá vốn lô) ÷ (có sẵn + SL nhận). Unrounded. */
export function weightedAverage(onHand: number, avgCost: number, qtyIn: number, unitCostIn: number): number {
  const total = onHand + qtyIn;
  return total === 0 ? avgCost : (onHand * avgCost + qtyIn * unitCostIn) / total;
}

/** BR-06 — Có thể bán = Có sẵn + Đang về − Đã giữ. */
export const sellableQty = (onHand: number, incoming: number, reserved: number): number => onHand + incoming - reserved;

/* ---------- Internal appliers (no status checks) ---------- */

function applyReceipt(lot: Lot, stock: StockMap): Record<string, VariantStock> {
  const next: Record<string, VariantStock> = { ...stock };
  for (const line of lot.lines) {
    const cost = unitCost(lot, line);
    if (cost == null) throw new Error('applyReceipt: ship fee must be checked before'); // guarded by callers
    const s = stockOf(next, line.variantId);
    next[line.variantId] = { onHand: s.onHand + line.qty, avgCost: weightedAverage(s.onHand, s.avgCost, line.qty, cost) };
  }
  return next;
}

/** Quantity needed per variant (an order may list the same variant on several lines). */
function qtyByVariant(lines: ReadonlyArray<{ variantId: string; qty: number }>): Map<string, number> {
  const m = new Map<string, number>();
  for (const x of lines) m.set(x.variantId, (m.get(x.variantId) ?? 0) + x.qty);
  return m;
}

/** BR-09 check for a whole order. */
function checkOnHand(order: Order, stock: StockMap): RuleError | null {
  for (const [variantId, need] of qtyByVariant(order.lines)) {
    const have = stockOf(stock, variantId).onHand;
    if (have < need) {
      return {
        code: 'INSUFFICIENT_STOCK',
        rule: 'BR-09',
        message: `Không đủ hàng có sẵn để gửi: cần ${need}, có sẵn ${have}.`,
        orderId: order.id,
        variantId,
        requested: need,
        available: have,
      };
    }
  }
  return null;
}

/**
 * Average left after shipping `qty` units at a FROZEN cost (BR-05 + Q-008).
 *
 *   a = current (unrounded) average, Q = on hand before shipping, c = frozen cost
 *   avg after = a + qty × (round(a) − c) ÷ (Q − qty)          (when Q − qty > 0)
 *
 * i.e. remaining value = (Q − qty) × a + qty × (round(a) − c): the units left absorb the gap
 * between what the shipped units would cost under the current lot data and their frozen cost.
 * When c = round(a) — always the case for a live shipment and for unedited history — the gap is 0
 * and the average is unchanged, exactly as BR-05 says. When nothing is left (Q − qty = 0)
 * the gap cannot be carried and the average stays `a`.
 */
export function averageAfterShipment(onHand: number, avgCost: number, qty: number, frozenCost: number): number {
  const remaining = onHand - qty;
  if (remaining <= 0) return avgCost;
  const gap = roundVnd(avgCost) - frozenCost;
  return gap === 0 ? avgCost : avgCost + (qty * gap) / remaining;
}

/**
 * BR-05 — deduct on hand and snapshot cost per line.
 * `keepStoredCost` (replay): a line that already carries a cost keeps it (frozen, Q-008);
 * otherwise (live shipment, or legacy history without snapshot) cost = round(current average).
 */
function applyShipment(order: Order, stock: StockMap, keepStoredCost: boolean): { lines: OrderLine[]; stock: Record<string, VariantStock> } {
  const next: Record<string, VariantStock> = { ...stock };
  const lines = order.lines.map((x) => {
    const s = stockOf(next, x.variantId);
    const cost = keepStoredCost && x.cost != null ? x.cost : roundVnd(s.avgCost);
    next[x.variantId] = { onHand: s.onHand - x.qty, avgCost: averageAfterShipment(s.onHand, s.avgCost, x.qty, cost) };
    return { ...x, cost };
  });
  return { lines, stock: next };
}

const shipFeeRequired = (lot: Lot): RuleError => ({
  code: 'SHIP_FEE_REQUIRED',
  rule: 'BR-02',
  message: 'Cần nhập phí ship về VN của cả lô trước khi chuyển "Đã nhận".',
  field: 'shipFee',
  lotId: lot.id,
});

/* ---------- Guards for state changes ---------- */

/**
 * Move a lot to `daNhan` and add its lines to stock (BR-02, BR-04).
 * Allowed from any open status (dat … veVN). Rejects a lot without ship fee.
 */
export function receiveLot(lot: Lot, stock: StockMap, receivedAt: IsoDate): Result<{ lot: Lot; stock: StockMap }> {
  const v = validateLot(lot);
  if (!v.ok) return v;
  if (lot.status === 'daNhan' || lot.status === 'huy') {
    return fail({ code: 'INVALID_TRANSITION', rule: 'BR-04', message: `Lô đang ở trạng thái "${lot.status === 'huy' ? 'Huỷ' : 'Đã nhận'}", không nhận vào kho được.`, lotId: lot.id });
  }
  if (lot.shipFee == null) return fail(shipFeeRequired(lot));
  if (!isIsoDate(receivedAt)) {
    return fail({ code: 'INVALID_INPUT', rule: 'BR-04', message: 'Ngày nhận không hợp lệ.', field: 'receivedAt', lotId: lot.id });
  }
  return ok({ lot: { ...lot, status: 'daNhan', receivedAt }, stock: applyReceipt(lot, stock) });
}

/**
 * Edit the ship fee of a lot (BR-02, Q-008). Any lot may get or change its fee; a received
 * lot cannot have it cleared. Stock is NOT touched here: re-run `replayHistory` with the
 * orders' stored (frozen) line costs — shipped costs stay, only the average of what is
 * still in stock moves (see `averageAfterShipment`).
 */
export function setLotShipFee(lot: Lot, shipFee: number | null): Result<Lot> {
  if (shipFee == null && lot.status === 'daNhan') return fail(shipFeeRequired(lot));
  return validateLot({ ...lot, shipFee });
}

/**
 * Move an order to `daGui` (BR-05, BR-09): deduct on hand and snapshot line costs.
 * Only from `daChot` (Q-007): a `datTruoc` order must be confirmed first.
 */
export function shipOrder(order: Order, stock: StockMap, sentAt: IsoDate): Result<{ order: Order; stock: StockMap }> {
  const v = validateOrder(order);
  if (!v.ok) return v;
  if (order.status !== 'daChot') {
    return fail({
      code: 'INVALID_TRANSITION',
      rule: 'BR-05',
      message: order.status === 'datTruoc' ? 'Đơn "Đặt trước" phải chốt trước khi gửi hàng.' : 'Chỉ gửi được đơn "Đã chốt".',
      orderId: order.id,
    });
  }
  if (!isIsoDate(sentAt)) {
    return fail({ code: 'INVALID_INPUT', rule: 'BR-05', message: 'Ngày gửi không hợp lệ.', field: 'sentAt', orderId: order.id });
  }
  const short = checkOnHand(order, stock);
  if (short) return fail(short);
  const r = applyShipment(order, stock, false);
  return ok({ order: { ...order, status: 'daGui', sentAt, lines: r.lines }, stock: r.stock });
}

/**
 * BR-07 — status for a NEW order, given current figures per variant.
 * All lines fit in (có sẵn − đã giữ) → `daChot`; else all fit in có thể bán → `datTruoc`
 * (UI warns "chờ hàng về"); otherwise rejected with EXCEEDS_SELLABLE.
 * Several lines of the same variant are summed.
 */
export function decideNewOrderStatus(
  lines: ReadonlyArray<{ variantId: string; qty: number }>,
  figures: Readonly<Record<string, { onHand: number; incoming: number; reserved: number }>>,
): Result<'daChot' | 'datTruoc'> {
  const v = validateOrderLines(lines);
  if (!v.ok) return v;
  let allFree = true;
  for (const [variantId, need] of qtyByVariant(lines)) {
    const f = figures[variantId] ?? { onHand: 0, incoming: 0, reserved: 0 };
    const sellable = sellableQty(f.onHand, f.incoming, f.reserved);
    if (need > sellable) {
      return fail({
        code: 'EXCEEDS_SELLABLE',
        rule: 'BR-07',
        message: `Vượt số có thể bán (${Math.max(0, sellable)}). Nhập thêm lô trước.`,
        variantId,
        requested: need,
        available: Math.max(0, sellable),
      });
    }
    if (need > f.onHand - f.reserved) allFree = false;
  }
  return ok(allFree ? 'daChot' : 'datTruoc');
}

/* ---------- Derivation from history ---------- */

/**
 * Replay received lots and sent orders in date order (receipts before shipments on the
 * same date, then input order) to derive on hand + weighted average per variant (BR-04)
 * and each sent order's cost (BR-05).
 *
 * Shipped lines that already carry a cost keep it (frozen, Q-008); the average of the units
 * still in stock absorbs any gap (see `averageAfterShipment`). Lines without a stored cost
 * (legacy data) get round(average at that point).
 *
 * Returns the stock and `orders` = the input orders, sent ones with every line cost filled.
 * Fails if history violates BR-02 (received lot without ship fee) or BR-09 (shipping more than on hand).
 */
export function replayHistory(lots: readonly Lot[], orders: readonly Order[]): Result<{ stock: StockMap; orders: Order[] }> {
  type Ev = { date: string; kind: 0 | 1; lot?: Lot; order?: Order };
  const events: Ev[] = [];
  for (const lot of lots) {
    if (lot.status !== 'daNhan') continue;
    const v = validateLot(lot);
    if (!v.ok) return v;
    if (lot.shipFee == null) return fail(shipFeeRequired(lot));
    if (!isIsoDate(lot.receivedAt)) {
      return fail({ code: 'INVALID_INPUT', rule: 'BR-04', message: 'Lô đã nhận nhưng thiếu ngày nhận.', field: 'receivedAt', lotId: lot.id });
    }
    events.push({ date: lot.receivedAt, kind: 0, lot });
  }
  for (const order of orders) {
    if (!isSent(order)) continue;
    const v = validateOrder(order);
    if (!v.ok) return v;
    if (!isIsoDate(order.sentAt)) {
      return fail({ code: 'INVALID_INPUT', rule: 'BR-05', message: 'Đơn đã gửi nhưng thiếu ngày gửi.', field: 'sentAt', orderId: order.id });
    }
    events.push({ date: order.sentAt, kind: 1, order });
  }
  // Array.prototype.sort is stable, so equal (date, kind) keep input order.
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind - b.kind));

  let stock: StockMap = {};
  const shippedLines = new Map<Order, OrderLine[]>();
  for (const e of events) {
    if (e.lot) {
      stock = applyReceipt(e.lot, stock);
    } else if (e.order) {
      const short = checkOnHand(e.order, stock);
      if (short) return fail(short);
      const r = applyShipment(e.order, stock, true);
      stock = r.stock;
      shippedLines.set(e.order, r.lines);
    }
  }
  const outOrders = orders.map((o) => {
    const lines = shippedLines.get(o);
    return lines ? { ...o, lines } : o;
  });
  return ok({ stock, orders: outOrders });
}

/** Đang về — Σ SL of lots not `daNhan` / `huy`, for one variant. */
export function incomingQty(lots: readonly Lot[], variantId: string): number {
  let n = 0;
  for (const l of lots) {
    if (l.status === 'daNhan' || l.status === 'huy') continue;
    for (const x of l.lines) if (x.variantId === variantId) n += x.qty;
  }
  return n;
}

/** Đã giữ — Σ SL of orders `datTruoc` / `daChot`, for one variant. */
export function reservedQty(orders: readonly Order[], variantId: string): number {
  let n = 0;
  for (const o of orders) {
    if (o.status !== 'datTruoc' && o.status !== 'daChot') continue;
    for (const x of o.lines) if (x.variantId === variantId) n += x.qty;
  }
  return n;
}

/** BR-06 figures for one variant. */
export function inventoryOf(stock: StockMap, lots: readonly Lot[], orders: readonly Order[], variantId: string): Inventory {
  const s = stockOf(stock, variantId);
  const incoming = incomingQty(lots, variantId);
  const reserved = reservedQty(orders, variantId);
  return { onHand: s.onHand, avgCost: s.avgCost, incoming, reserved, sellable: sellableQty(s.onHand, incoming, reserved), free: s.onHand - reserved };
}

/**
 * Replay + BR-06 for every variant that appears in `variantIds`, the lots or the orders.
 */
export function computeInventory(
  lots: readonly Lot[],
  orders: readonly Order[],
  variantIds: readonly string[] = [],
): Result<{ inventory: Record<string, Inventory>; stock: StockMap; orders: Order[] }> {
  const r = replayHistory(lots, orders);
  if (!r.ok) return r;
  const ids = new Set<string>(variantIds);
  for (const l of lots) for (const x of l.lines) ids.add(x.variantId);
  for (const o of orders) for (const x of o.lines) ids.add(x.variantId);
  const inventory: Record<string, Inventory> = {};
  for (const id of ids) inventory[id] = inventoryOf(r.value.stock, lots, orders, id);
  return ok({ inventory, stock: r.value.stock, orders: r.value.orders });
}

/** Vốn trong kho = Σ có sẵn × BQ, rounded to đồng. */
export function stockValue(stock: StockMap): Vnd {
  let v = 0;
  for (const s of Object.values(stock)) v += s.onHand * s.avgCost;
  return roundVnd(v);
}

/** Hàng đang về: units and Σ phải trả trung gian of open lots (not `daNhan` / `huy`). */
export function incomingSummary(lots: readonly Lot[]): { qty: number; payable: Vnd } {
  let qty = 0;
  let payable = 0;
  for (const l of lots) {
    if (l.status === 'daNhan' || l.status === 'huy') continue;
    qty += lotQty(l);
    payable += lotPayable(l);
  }
  return { qty, payable };
}
