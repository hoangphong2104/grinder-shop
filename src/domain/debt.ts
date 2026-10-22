/**
 * BR-12 — Công nợ trung gian.
 * Every lot generates one "Phải trả" entry = lotPayable(lot) (0 once cancelled; it follows lot edits
 * because it is derived, never stored). Còn nợ = Σ Phải trả − Σ Đã chuyển ± Điều chỉnh.
 */
import type { IsoDate, Lot, Transfer, Vnd } from './types.ts';
import { lotPayable } from './money.ts';

export type LedgerKind = 'phaiTra' | 'daChuyen' | 'dieuChinh';

export interface LedgerEntry {
  date: IsoDate;
  kind: LedgerKind;
  /** Lot id for `phaiTra`, transfer id otherwise. */
  refId: string;
  /** Signed effect on the debt: + increases what the shop owes, − decreases it. */
  amount: Vnd;
  /** Debt after this entry. */
  balance: Vnd;
}

/** Signed effect of a hand-entered transaction on the debt. */
export const transferEffect = (t: Transfer): Vnd => (t.kind === 'chuyen' ? -t.amount : t.amount);

export const totalPayable = (lots: readonly Lot[]): Vnd => lots.reduce((a, l) => a + lotPayable(l), 0);

export const totalTransferred = (transfers: readonly Transfer[]): Vnd =>
  transfers.reduce((a, t) => a + (t.kind === 'chuyen' ? t.amount : 0), 0);

export const totalAdjustments = (transfers: readonly Transfer[]): Vnd =>
  transfers.reduce((a, t) => a + (t.kind === 'dieuChinh' ? t.amount : 0), 0);

/** Còn nợ trung gian = Σ Phải trả − Σ Đã chuyển ± Điều chỉnh. Negative = the shop has prepaid. */
export const intermediaryDebt = (lots: readonly Lot[], transfers: readonly Transfer[]): Vnd =>
  totalPayable(lots) - totalTransferred(transfers) + totalAdjustments(transfers);

/**
 * Chronological ledger with running balance. A lot's "Phải trả" is dated `orderedAt`
 * (generated when the lot is created). Same-day: payables first, then input order.
 * Cancelled lots stay in the ledger with amount 0.
 */
export function intermediaryLedger(lots: readonly Lot[], transfers: readonly Transfer[]): LedgerEntry[] {
  type Row = Omit<LedgerEntry, 'balance'> & { rank: number };
  const rows: Row[] = [
    ...lots.map((l): Row => ({ date: l.orderedAt, kind: 'phaiTra', refId: l.id, amount: lotPayable(l), rank: 0 })),
    ...transfers.map((t): Row => ({ date: t.date, kind: t.kind === 'chuyen' ? 'daChuyen' : 'dieuChinh', refId: t.id, amount: transferEffect(t), rank: 1 })),
  ];
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.rank - b.rank));
  let balance = 0;
  return rows.map(({ rank: _rank, ...r }) => {
    balance += r.amount;
    return { ...r, balance };
  });
}
