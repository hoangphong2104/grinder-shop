/**
 * Money rules: BR-01 (unit cost), BR-10 (amount due), BR-11 (profit), BR-12 (lot payable),
 * plus VND rounding / formatting. Pure functions, no I/O.
 */
import type { Lot, LotLine, Order, Payment, Result, Vnd } from './types.ts';
import { fail, ok } from './types.ts';

/* ---------- Rounding & formatting ---------- */

/**
 * Round to whole đồng, half away from zero. A 6-decimal pre-rounding absorbs binary
 * floating-point noise (e.g. 0.1 × 3 = 0.30000000000000004) so x.5 values round as written.
 */
export function roundVnd(n: number): Vnd {
  if (!Number.isFinite(n)) throw new RangeError(`roundVnd: not a finite number (${n})`);
  const a = Math.round(Number(Math.abs(n).toFixed(6)));
  return a === 0 ? 0 : n < 0 ? -a : a;
}

const MINUS = '−';

function groupThousands(intAbs: number): string {
  return String(intAbs).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** `3936000` → `"3.936.000 ₫"`; negative → `"−2.872.000 ₫"`; null/undefined → `"—"`. */
export function formatVnd(n: Vnd | null | undefined): string {
  if (n == null) return '—';
  const r = roundVnd(n);
  return (r < 0 ? MINUS : '') + groupThousands(Math.abs(r)) + ' ₫';
}

/**
 * Compact form used on dashboards: `5400000` → `"5,4tr"`, `3000000` → `"3tr"`,
 * `120000` → `"120k"`, `150000000` → `"150tr"`, `500` → `"500"`.
 * Under 100tr one decimal is shown (dropped when it is 0); from 100tr whole millions.
 */
export function formatTr(n: Vnd | null | undefined): string {
  if (n == null) return '—';
  const r = roundVnd(n);
  const sign = r < 0 ? MINUS : '';
  const a = Math.abs(r);
  const thousands = Math.round(a / 1e3);
  if (thousands < 1000) {
    return sign + (a >= 1e3 ? `${thousands}k` : String(a));
  }
  if (a < 1e8) {
    const tenths = Math.round(a / 1e5);
    const whole = Math.floor(tenths / 10);
    const dec = tenths % 10;
    return sign + groupThousands(whole) + (dec ? `,${dec}` : '') + 'tr';
  }
  return sign + groupThousands(Math.round(a / 1e6)) + 'tr';
}

/** `1010` → `"¥1.010"`; decimals use a comma (`99.5` → `"¥99,5"`). */
export function formatCny(n: number | null | undefined): string {
  if (n == null) return '—';
  const [i, d] = String(Math.abs(n)).split('.');
  return (n < 0 ? MINUS : '') + '¥' + groupThousands(Number(i)) + (d ? `,${d}` : '');
}

/* ---------- Lots: BR-01, BR-12 ---------- */

/** Tổng SL lô. */
export const lotQty = (lot: Lot): number => lot.lines.reduce((a, x) => a + x.qty, 0);

/** Σ(SL × giá ¥). */
export const lotGoodsCny = (lot: Lot): number => lot.lines.reduce((a, x) => a + x.qty * x.cny, 0);

/** Σ(SL × giá ¥) × tỷ giá, rounded to đồng (goods part of the payable, BR-12). */
export const lotGoodsVnd = (lot: Lot): Vnd => roundVnd(lotGoodsCny(lot) * lot.rate);

/**
 * BR-01 — Giá vốn/chiếc = giá web ¥ × tỷ giá + phí ship về VN của lô ÷ tổng SL lô, rounded to đồng.
 * Returns null while the lot's ship fee is not known yet (BR-02 allows that until receiving).
 */
export function unitCost(lot: Lot, line: LotLine): Vnd | null {
  if (lot.shipFee == null) return null;
  const qty = lotQty(lot);
  if (qty <= 0) return null;
  return roundVnd(line.cny * lot.rate + lot.shipFee / qty);
}

/** The ¥ × rate part of the unit cost only (UI shows it as "… + ship" while ship fee is blank). */
export const unitCostBeforeShip = (lot: Lot, line: LotLine): Vnd => roundVnd(line.cny * lot.rate);

/**
 * BR-12 — Phải trả trung gian of a lot = Σ(SL × giá ¥) × tỷ giá + phí ship về VN (when entered).
 * A cancelled lot (`huy`) is 0.
 */
export function lotPayable(lot: Lot): Vnd {
  if (lot.status === 'huy') return 0;
  return lotGoodsVnd(lot) + (lot.shipFee ?? 0);
}

/* ---------- Orders: BR-10, BR-11 ---------- */

export const isSent = (o: Pick<Order, 'status'>): boolean => o.status === 'daGui' || o.status === 'hoanTat';

/** Σ(SL × giá chốt). */
export const orderGoodsTotal = (o: Order): Vnd => o.lines.reduce((a, x) => a + x.qty * x.price, 0);

/** Khách phải trả = Σ(SL × giá chốt) + phí ship VN when the customer pays it. */
export const orderTotal = (o: Order): Vnd => orderGoodsTotal(o) + (o.shipPayer === 'khach' ? o.shipFee : 0);

/** Signed effect of a payment: deposits/payments positive, refunds negative. */
export const paymentSigned = (p: Payment): Vnd => (p.kind === 'hoan' ? -p.amount : p.amount);

/** Σ tiền đã thu (net of refunds). */
export const orderPaid = (o: Order): Vnd => o.payments.reduce((a, p) => a + paymentSigned(p), 0);

/**
 * BR-10 — Còn phải thu = Σ(SL × giá chốt) + ship (if customer pays) − Σ tiền đã thu.
 * A cancelled order owes nothing, so its due is −(net paid): a negative value means
 * the shop still has to refund the customer; 0 once the refund is recorded.
 * Negative due on a live order = customer overpaid.
 */
export function orderDue(o: Order): Vnd {
  const total = o.status === 'huy' ? 0 : orderTotal(o);
  return total - orderPaid(o);
}

/**
 * BR-11 — Lãi đơn = Σ(SL × (giá chốt − giá vốn)) − phí ship VN shop chịu.
 * Only defined once the order is `daGui` / `hoanTat`; returns null before.
 * Throws if a sent order has a line without a cost snapshot (data corruption, not a user rule).
 */
export function orderProfit(o: Order): Vnd | null {
  if (!isSent(o)) return null;
  let p = 0;
  for (const x of o.lines) {
    if (x.cost == null) throw new Error(`orderProfit: order ${o.id} is sent but line ${x.variantId} has no cost snapshot (BR-05)`);
    p += x.qty * (x.price - x.cost);
  }
  return p - (o.shipPayer === 'shop' ? o.shipFee : 0);
}

/** Estimated profit for a not-yet-sent order, using given average costs (unrounded avg is rounded per unit). */
export function orderProfitEstimate(o: Order, avgCostByVariant: Readonly<Record<string, number>>): Vnd {
  const goods = o.lines.reduce((a, x) => a + x.qty * (x.price - roundVnd(x.cost ?? avgCostByVariant[x.variantId] ?? 0)), 0);
  return goods - (o.shipPayer === 'shop' ? o.shipFee : 0);
}

/** Profit, order count and goods revenue of orders sent in a month (`YYYY-MM`, by `sentAt`). */
export function profitForMonth(orders: readonly Order[], month: string): { profit: Vnd; orders: number; revenue: Vnd } {
  let profit = 0;
  let count = 0;
  let revenue = 0;
  for (const o of orders) {
    if (!isSent(o) || !o.sentAt || !o.sentAt.startsWith(month)) continue;
    profit += orderProfit(o) ?? 0;
    revenue += orderGoodsTotal(o);
    count += 1;
  }
  return { profit, orders: count, revenue };
}

/** Khách còn nợ (dashboard): Σ of positive dues only — overpaid / to-refund orders do not offset others. */
export const customersTotalDue = (orders: readonly Order[]): Vnd => orders.reduce((a, o) => a + Math.max(0, orderDue(o)), 0);

/**
 * BR-10 guard — move a sent order to `hoanTat`. Allowed only when due = 0,
 * unless the user explicitly confirms (`acceptOutstanding`).
 */
export function completeOrder(o: Order, opts: { acceptOutstanding?: boolean } = {}): Result<Order> {
  if (o.status !== 'daGui') {
    return fail({ code: 'INVALID_TRANSITION', rule: 'BR-10', message: 'Chỉ hoàn tất được đơn đang ở trạng thái "Đã gửi".', orderId: o.id });
  }
  const due = orderDue(o);
  if (due !== 0 && !opts.acceptOutstanding) {
    return fail({
      code: 'OUTSTANDING_DUE',
      rule: 'BR-10',
      message: due > 0 ? `Khách còn nợ ${formatVnd(due)}. Xác nhận nếu vẫn muốn hoàn tất.` : `Khách trả dư ${formatVnd(-due)}. Xác nhận nếu vẫn muốn hoàn tất.`,
      orderId: o.id,
      requested: 0,
      available: due,
    });
  }
  return ok({ ...o, status: 'hoanTat' });
}
