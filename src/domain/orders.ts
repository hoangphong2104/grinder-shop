/**
 * Sales orders after CR-001: an order is a list of specific units (A6, D4).
 *  - Picking units: availability (A6), resulting status (A6), shipping guard (A8 + Q-007),
 *    automatic confirmation of pre-orders when a lot is received (A7), cancel / complete guards.
 *  - Money: total / paid / receivable / refund due (BR-10, Q-009, Q-010, Q-015),
 *    profit from each unit's CURRENT effective cost (BR-11 + A8, no snapshot) and monthly profit.
 * Pure: guards return Results, inputs are never mutated.
 */
import type { IsoDate, Lot, Order, Payment, Result, Unit, Vnd } from './types.ts';
import { LOT_STATUS_LABEL, ORDER_STATUS_LABEL, fail, ok } from './types.ts';
import { formatVnd } from './money.ts';
import { holdingOrder, isSoldOrder } from './units.ts';

const orderRef = (o: Pick<Order, 'id' | 'code'>): string => o.code ?? o.id;

/* ---------- Picking units (A6) ---------- */

/**
 * A6 — can this unit be put on an order? Not if its lot is cancelled, nor if another non-cancelled order
 * already holds it (reserved or sold). `forOrderId` = the order being edited (its own lines don't conflict).
 * On success returns where the unit is: `in_stock` or `incoming`.
 */
export function checkUnitAvailable(
  unit: Unit,
  lot: Pick<Lot, 'status'>,
  orders: readonly Order[],
  forOrderId?: string,
): Result<'in_stock' | 'incoming'> {
  if (lot.status === 'cancelled') {
    return fail({ code: 'UNIT_UNAVAILABLE', rule: 'A6', message: `Chiếc ${unit.code} thuộc lô đã huỷ.`, unitId: unit.id, lotId: unit.lotId });
  }
  const holder = holdingOrder(unit.id, orders, forOrderId);
  if (holder) {
    const message = isSoldOrder(holder) ? `Chiếc ${unit.code} đã bán (${orderRef(holder)}).` : `Chiếc ${unit.code} đã giữ cho ${orderRef(holder)}.`;
    return fail({ code: 'UNIT_UNAVAILABLE', rule: 'A6', message, unitId: unit.id, conflictOrderId: holder.id });
  }
  return ok(lot.status === 'received' ? 'in_stock' : 'incoming');
}

/** A6 — status of an order holding these units: any unit still incoming → `preorder`, all received → `confirmed`. */
export function orderStatusFor(units: readonly Pick<Unit, 'lotId'>[], lots: readonly Pick<Lot, 'id' | 'status'>[]): 'preorder' | 'confirmed' {
  const lotById = new Map(lots.map((l) => [l.id, l]));
  return units.some((u) => lotById.get(u.lotId)?.status !== 'received') ? 'preorder' : 'confirmed';
}

/**
 * A6 — validate the unit selection of a new (or edited, `forOrderId`) order and decide its status.
 * Rejects: no unit, the same unit twice, unknown unit, unit unavailable.
 */
export function checkOrderUnits(
  unitIds: readonly string[],
  units: readonly Unit[],
  lots: readonly Lot[],
  orders: readonly Order[],
  forOrderId?: string,
): Result<{ status: 'preorder' | 'confirmed'; units: Unit[] }> {
  if (unitIds.length === 0) {
    return fail({ code: 'INVALID_INPUT', rule: 'A6', message: 'Đơn phải có ít nhất 1 chiếc.', field: 'lines', orderId: forOrderId });
  }
  const unitById = new Map(units.map((u) => [u.id, u]));
  const lotById = new Map(lots.map((l) => [l.id, l]));
  const seen = new Set<string>();
  const picked: Unit[] = [];
  for (const [i, id] of unitIds.entries()) {
    const unit = unitById.get(id);
    const lot = unit && lotById.get(unit.lotId);
    if (!unit || !lot) {
      return fail({ code: 'INVALID_INPUT', rule: 'A6', message: `Dòng ${i + 1}: chiếc không tồn tại.`, field: `lines[${i}].unitId`, unitId: id, orderId: forOrderId });
    }
    if (seen.has(id)) {
      return fail({ code: 'INVALID_INPUT', rule: 'A6', message: `Chiếc ${unit.code} được chọn 2 lần.`, field: `lines[${i}].unitId`, unitId: id, orderId: forOrderId });
    }
    seen.add(id);
    const a = checkUnitAvailable(unit, lot, orders, forOrderId);
    if (!a.ok) return fail({ ...a.error, orderId: forOrderId });
    picked.push(unit);
  }
  return ok({ status: orderStatusFor(picked, lots), units: picked });
}

/* ---------- Transitions ---------- */

/**
 * A8 + Q-007 — "Gửi hàng" only for a confirmed order whose units are all in received lots.
 * `units` / `lots` may be the full lists (looked up by id).
 */
export function canShip(order: Order, units: readonly Unit[], lots: readonly Lot[]): Result<true> {
  if (order.status !== 'confirmed') {
    const message =
      order.status === 'preorder'
        ? 'Đơn Đặt trước phải được chốt (hàng về đủ) trước khi gửi.'
        : `Không gửi được đơn đang "${ORDER_STATUS_LABEL[order.status]}".`;
    return fail({ code: 'INVALID_TRANSITION', rule: 'Q-007', message, orderId: order.id });
  }
  if (order.lines.length === 0) {
    return fail({ code: 'INVALID_INPUT', rule: 'A6', message: 'Đơn chưa có chiếc nào.', field: 'lines', orderId: order.id });
  }
  const unitById = new Map(units.map((u) => [u.id, u]));
  const lotById = new Map(lots.map((l) => [l.id, l]));
  for (const line of order.lines) {
    const unit = unitById.get(line.unitId);
    const lot = unit && lotById.get(unit.lotId);
    if (!unit || !lot) {
      return fail({ code: 'INVALID_INPUT', rule: 'A8', message: 'Đơn có chiếc không tồn tại.', unitId: line.unitId, orderId: order.id });
    }
    if (lot.status !== 'received') {
      return fail({
        code: 'NOT_RECEIVED',
        rule: 'A8',
        message: `Chiếc ${unit.code} chưa về kho (lô đang "${LOT_STATUS_LABEL[lot.status]}").`,
        unitId: unit.id,
        lotId: lot.id,
        orderId: order.id,
      });
    }
  }
  return ok(true);
}

/**
 * A7 — pre-orders to switch to `confirmed` once lot `lotIdJustReceived` is received: those holding at least
 * one unit of that lot and whose units are now ALL in received lots. The lot is treated as received even if
 * `lots` still carries its old status.
 */
export function preordersToAutoConfirm(lotIdJustReceived: string, units: readonly Unit[], lots: readonly Lot[], orders: readonly Order[]): Order[] {
  const unitById = new Map(units.map((u) => [u.id, u]));
  const received = new Set(lots.filter((l) => l.status === 'received').map((l) => l.id));
  received.add(lotIdJustReceived);
  return orders.filter((o) => {
    if (o.status !== 'preorder' || o.lines.length === 0) return false;
    const lotIds = o.lines.map((l) => unitById.get(l.unitId)?.lotId);
    return lotIds.includes(lotIdJustReceived) && lotIds.every((id) => id != null && received.has(id));
  });
}

/** §2 — an order can be cancelled only before it is shipped. Its units are released (A5). */
export function checkCancelOrder(order: Order): Result<true> {
  if (order.status !== 'preorder' && order.status !== 'confirmed') {
    return fail({ code: 'INVALID_TRANSITION', rule: '§2', message: `Không huỷ được đơn đang "${ORDER_STATUS_LABEL[order.status]}".`, orderId: order.id });
  }
  return ok(true);
}

/**
 * BR-10 + Q-010 — move a shipped order to `completed`. Needs receivable = 0 (neither under- nor overpaid)
 * unless the user explicitly confirms (`acceptOutstanding`).
 */
export function completeOrder(order: Order, opts: { acceptOutstanding?: boolean } = {}): Result<Order> {
  if (order.status !== 'shipped') {
    return fail({ code: 'INVALID_TRANSITION', rule: 'BR-10', message: 'Chỉ hoàn tất được đơn đang "Đã gửi".', orderId: order.id });
  }
  const due = orderReceivable(order);
  if (due !== 0 && !opts.acceptOutstanding) {
    return fail({
      code: 'OUTSTANDING_DUE',
      rule: 'BR-10',
      message: due > 0 ? `Khách còn nợ ${formatVnd(due)}. Xác nhận nếu vẫn muốn hoàn tất.` : `Khách trả dư ${formatVnd(-due)}. Xác nhận nếu vẫn muốn hoàn tất.`,
      orderId: order.id,
      amount: due,
    });
  }
  return ok({ ...order, status: 'completed' });
}

/* ---------- Money (BR-10, BR-11, Q-009, Q-015) ---------- */

/** Σ giá chốt (one line = one unit). */
export const orderGoodsTotal = (o: Pick<Order, 'lines'>): Vnd => o.lines.reduce((a, l) => a + l.price, 0);

/** Ship fee charged to the customer (collected on behalf, Q-015); 0 when the shop pays. */
export const orderShipCharged = (o: Pick<Order, 'shipFee' | 'shipPayer'>): Vnd => (o.shipPayer === 'customer' ? o.shipFee : 0);

/** Khách phải trả = Σ giá chốt + phí ship khi khách trả. */
export const orderTotal = (o: Pick<Order, 'lines' | 'shipFee' | 'shipPayer'>): Vnd => orderGoodsTotal(o) + orderShipCharged(o);

/** Signed effect of a payment: deposits / payments positive, refunds negative. */
export const paymentSigned = (p: Pick<Payment, 'kind' | 'amount'>): Vnd => (p.kind === 'refund' ? -p.amount : p.amount);

/** Σ tiền đã thu, net of refunds. */
export const orderPaid = (o: Pick<Order, 'payments'>): Vnd => o.payments.reduce((a, p) => a + paymentSigned(p), 0);

/**
 * BR-10 — Còn phải thu = tổng − đã thu. Negative = customer overpaid (Q-010).
 * A cancelled order owes nothing: 0 (Q-009 — its money shows in `orderRefundDue` instead).
 */
export const orderReceivable = (o: Order): Vnd => (o.status === 'cancelled' ? 0 : orderTotal(o) - orderPaid(o));

/** Q-009 — "Cần hoàn X" of a cancelled order = net paid (≥ 0) until refunds are recorded; 0 otherwise. */
export const orderRefundDue = (o: Order): Vnd => (o.status === 'cancelled' ? Math.max(0, orderPaid(o)) : 0);

/** Khách còn nợ (dashboard): Σ positive receivables only — overpaid orders do not offset others. */
export const customersTotalDue = (orders: readonly Order[]): Vnd => orders.reduce((a, o) => a + Math.max(0, orderReceivable(o)), 0);

/** Σ refund due over cancelled orders. */
export const totalRefundDue = (orders: readonly Order[]): Vnd => orders.reduce((a, o) => a + orderRefundDue(o), 0);

/** Ship fee borne by the shop (reduces profit, BR-11); a customer-paid fee is pass-through (Q-015). */
export const orderShipCost = (o: Pick<Order, 'shipFee' | 'shipPayer'>): Vnd => (o.shipPayer === 'shop' ? o.shipFee : 0);

/**
 * Σ(giá chốt − giá nhập ₫ hiệu lực) − phí ship shop chịu, whatever the status (used for estimates).
 * `costs` = effective cost by unit id (see `effectiveCosts`). A line whose unit has no cost is a data
 * error and throws.
 */
export function orderMargin(o: Order, costs: ReadonlyMap<string, Vnd>): Vnd {
  let m = 0;
  for (const l of o.lines) {
    const c = costs.get(l.unitId);
    if (c == null) throw new Error(`orderMargin: no cost for unit ${l.unitId} of order ${orderRef(o)}`);
    m += l.price - c;
  }
  return m - orderShipCost(o);
}

/**
 * BR-11 + A8 — Lãi đơn = Σ(giá chốt − giá nhập ₫ hiện tại của chiếc) − phí ship shop chịu.
 * Only for shipped / completed orders (null otherwise). Not frozen: it follows later cost corrections (A3).
 */
export const orderProfit = (o: Order, costs: ReadonlyMap<string, Vnd>): Vnd | null => (isSoldOrder(o) ? orderMargin(o, costs) : null);

export interface MonthProfit {
  /** `YYYY-MM`. */
  month: string;
  profit: Vnd;
  /** Σ giá chốt (pass-through ship excluded). */
  revenue: Vnd;
  orders: number;
}

/** Profit of the orders shipped in `month` (`YYYY-MM`, by `shippedAt`). */
export function profitForMonth(orders: readonly Order[], costs: ReadonlyMap<string, Vnd>, month: string): MonthProfit {
  const r: MonthProfit = { month, profit: 0, revenue: 0, orders: 0 };
  for (const o of orders) {
    if (!isSoldOrder(o) || !o.shippedAt || !o.shippedAt.startsWith(month)) continue;
    r.profit += orderMargin(o, costs);
    r.revenue += orderGoodsTotal(o);
    r.orders += 1;
  }
  return r;
}

/** Profit per ship month, ascending. Shipped orders without `shippedAt` are skipped. */
export function profitByMonth(orders: readonly Order[], costs: ReadonlyMap<string, Vnd>): MonthProfit[] {
  const months = new Set<string>();
  for (const o of orders) if (isSoldOrder(o) && o.shippedAt) months.add(o.shippedAt.slice(0, 7));
  return [...months].sort().map((m) => profitForMonth(orders, costs, m));
}

/** `YYYY-MM` of a date (helper for month pickers). */
export const monthOf = (d: IsoDate): string => d.slice(0, 7);
