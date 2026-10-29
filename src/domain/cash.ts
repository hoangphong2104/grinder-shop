/**
 * CR-005 - Sổ quỹ (một quỹ chung, bắt đầu từ 0) + trả trung gian theo lô.
 * Mirrors the DB (supabase/v2/005_cash_status_qr.sql): auto entries written by triggers (`autoCashEntries`),
 * `v_cash_balance` (`cashBalance`), `v_cash_monthly` (`cashByMonth`), `v_lot_summary.paid_vnd / outstanding_vnd`
 * (`lotPaid`, `lotOutstanding`) and the `pay_lot` RPC guard (`checkPayLot`). Pure: inputs are never mutated.
 *
 *   số dư quỹ         = Σ tiền vào − Σ tiền ra
 *   bút toán tự sinh  = khoản thu khách (cọc / thanh toán → vào; hoàn tiền → ra) · khoản Đã chuyển trung gian > 0 (ra)
 *                       · ship đơn shop chịu khi đơn đã gửi (Vận chuyển tới khách / Đã giao / Hoàn hàng; ra, ngày gửi)
 *                       · ship chiều về của đơn Hoàn hàng (ra, ngày hoàn)
 *   đã trả lô         = Σ khoản Đã chuyển gắn lô;  còn nợ lô = phải trả lô − đã trả lô (âm = trả dư)
 */
import type { CashDirection, CashEntry, CashKind, IsoDate, Lot, Order, Result, Transfer, Unit, Vnd } from './types.ts';
import { AUTO_CASH_KINDS, MANUAL_CASH_KINDS, fail, ok } from './types.ts';
import { lotPayable } from './cost.ts';

export const isAutoCashKind = (k: CashKind): boolean => AUTO_CASH_KINDS.includes(k);
export const isManualCashKind = (k: CashKind): boolean => MANUAL_CASH_KINDS.includes(k);

/** Fixed direction of a kind (DB check `cash_kind_direction`); `adjustment` may go either way ⇒ null. */
export function cashKindDirection(k: CashKind): CashDirection | null {
  if (k === 'customer_payment' || k === 'capital_in') return 'in';
  if (k === 'adjustment') return null;
  return 'out';
}

/** Signed effect on the fund: in +, out −. */
export const cashEffect = (e: Pick<CashEntry, 'direction' | 'amount'>): Vnd => (e.direction === 'in' ? e.amount : -e.amount);

export interface CashBalance {
  totalIn: Vnd;
  totalOut: Vnd;
  /** Số dư quỹ = vào − ra (starts from 0 - no opening balance). */
  balance: Vnd;
}

/** ≈ DB view v_cash_balance. */
export function cashBalance(entries: readonly Pick<CashEntry, 'direction' | 'amount'>[]): CashBalance {
  let totalIn = 0;
  let totalOut = 0;
  for (const e of entries) {
    if (e.direction === 'in') totalIn += e.amount;
    else totalOut += e.amount;
  }
  return { totalIn, totalOut, balance: totalIn - totalOut };
}

export interface CashMonth {
  /** First day of the month, `YYYY-MM-01` (same as DB v_cash_monthly.month). */
  month: IsoDate;
  in: Vnd;
  out: Vnd;
  net: Vnd;
}

/** ≈ DB view v_cash_monthly (in / out / net), ascending by month. Entries without a date are skipped. */
export function cashByMonth(entries: readonly Pick<CashEntry, 'date' | 'direction' | 'amount'>[]): CashMonth[] {
  const m = new Map<string, CashMonth>();
  for (const e of entries) {
    if (!e.date) continue;
    const month = `${e.date.slice(0, 7)}-01`;
    const row = m.get(month) ?? { month, in: 0, out: 0, net: 0 };
    if (e.direction === 'in') row.in += e.amount;
    else row.out += e.amount;
    row.net = row.in - row.out;
    m.set(month, row);
  }
  return [...m.values()].sort((a, b) => a.month.localeCompare(b.month));
}

/** Đơn đã gửi (shop đã trả hãng ship): Vận chuyển tới khách / Đã giao / Hoàn hàng. */
const hasShipped = (o: Pick<Order, 'status'>): boolean => o.status === 'shipped' || o.status === 'completed' || o.status === 'returned';

/**
 * Bút toán tự sinh - same rules as the DB triggers (private.cash_sync_payment / _txn / _order / _lot).
 * Order: per order (payments in order, then ship_shop, return_ship), then transfers, then lots (CR-009 local_ship:
 * ship Kho VN → Lumi of a non-cancelled lot - out, dated the receipt day, or the order day before receipt).
 */
export function autoCashEntries(orders: readonly Order[], transfers: readonly Transfer[], lots: readonly Lot[] = []): CashEntry[] {
  const out: CashEntry[] = [];
  for (const o of orders) {
    for (const p of o.payments) {
      const refund = p.kind === 'refund';
      out.push({
        date: p.date ?? null, direction: refund ? 'out' : 'in', kind: refund ? 'customer_refund' : 'customer_payment',
        amount: p.amount, orderId: o.id, isAuto: true,
      });
    }
    if (hasShipped(o) && o.shipPayer === 'shop' && o.shipFee > 0) {
      out.push({ date: o.shippedAt ?? null, direction: 'out', kind: 'ship_shop', amount: o.shipFee, orderId: o.id, isAuto: true });
    }
    if (o.status === 'returned' && (o.returnShipFee ?? 0) > 0) {
      out.push({ date: o.returnedAt ?? null, direction: 'out', kind: 'return_ship', amount: o.returnShipFee!, orderId: o.id, isAuto: true });
    }
  }
  for (const t of transfers) {
    if (t.kind !== 'transfer' || t.amount <= 0) continue;
    out.push({ date: t.date ?? null, direction: 'out', kind: 'intermediary', amount: t.amount, lotId: t.lotId ?? null, note: t.note ?? null, isAuto: true });
  }
  for (const l of lots) {
    if (l.status === 'cancelled' || (l.localShip ?? 0) <= 0) continue;
    out.push({ date: l.receivedAt ?? l.orderedAt ?? null, direction: 'out', kind: 'local_ship', amount: l.localShip!, lotId: l.id, isAuto: true });
  }
  return out;
}

/** Đã trả lô = Σ khoản Đã chuyển gắn lô (≈ v_lot_summary.paid_vnd). */
export const lotPaid = (lotId: string, transfers: readonly Transfer[]): Vnd =>
  transfers.reduce((a, t) => a + (t.kind === 'transfer' && t.lotId === lotId ? t.amount : 0), 0);

/** Còn nợ lô = phải trả − đã trả (≈ v_lot_summary.outstanding_vnd; negative = overpaid). */
export const lotOutstanding = (
  lot: Pick<Lot, 'id' | 'rate' | 'shipFee' | 'status' | 'buyingFeePct'>,
  units: readonly Unit[],
  transfers: readonly Transfer[],
): Vnd => lotPayable(lot, units) - lotPaid(lot.id, transfers);

/** pay_lot guard: amount to pay = còn nợ; cancelled lot or nothing owed ⇒ error (DB LOT_CANCELLED / LOT_ALREADY_PAID). */
export function checkPayLot(lot: Lot, units: readonly Unit[], transfers: readonly Transfer[]): Result<Vnd> {
  if (lot.status === 'cancelled') {
    return fail({ code: 'INVALID_TRANSITION', rule: 'CR-005', message: 'Lô đã huỷ - không trả trung gian.', lotId: lot.id });
  }
  const due = lotOutstanding(lot, units, transfers);
  if (due <= 0) {
    return fail({ code: 'LOT_ALREADY_PAID', rule: 'CR-005', message: 'Lô đã thanh toán đủ cho trung gian.', lotId: lot.id, amount: due });
  }
  return ok(due);
}

/** Field checks of a hand-entered cash entry (same as DB checks + RLS: manual kinds only). */
export function validateCashEntry(e: CashEntry): Result<CashEntry> {
  if (!isManualCashKind(e.kind)) {
    return fail({ code: 'INVALID_INPUT', rule: 'CR-005', message: 'Bút toán tự sinh - sửa ở khoản gốc (đơn / khoản trả).', field: 'kind' });
  }
  if (!Number.isInteger(e.amount) || e.amount <= 0) {
    return fail({ code: 'INVALID_INPUT', rule: 'CR-005', message: 'Số tiền phải là số nguyên > 0.', field: 'amount' });
  }
  const dir = cashKindDirection(e.kind);
  if (dir && dir !== e.direction) {
    return fail({ code: 'INVALID_INPUT', rule: 'CR-005', message: dir === 'in' ? 'Nạp vốn là tiền vào.' : 'Khoản này là tiền ra.', field: 'direction' });
  }
  const cat = e.expenseCategory?.trim() ?? '';
  if (e.kind !== 'expense' && cat) {
    return fail({ code: 'INVALID_INPUT', rule: 'CR-005', message: 'Loại chi phí chỉ dùng cho "Chi phí khác".', field: 'expenseCategory' });
  }
  if (cat.length > 60) {
    return fail({ code: 'INVALID_INPUT', rule: 'CR-005', message: 'Loại chi phí tối đa 60 ký tự.', field: 'expenseCategory' });
  }
  if ((e.note ?? '').length > 1000) {
    return fail({ code: 'INVALID_INPUT', rule: 'CR-005', message: 'Ghi chú tối đa 1000 ký tự.', field: 'note' });
  }
  return ok(e);
}
