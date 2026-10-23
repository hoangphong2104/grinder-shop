/**
 * BR-12 / A4 — Công nợ trung gian.
 * Every lot owes one "Phải trả" = lotPayable(lot, units) (0 once cancelled; derived, so it follows lot edits).
 * Còn nợ = Σ Phải trả − Σ Đã chuyển + Σ Điều chỉnh (adjustments are signed).
 */
import type { Lot, Transfer, Unit, Vnd } from './types.ts';
import { lotPayable } from './cost.ts';

/** Signed effect of a hand-entered transaction on the debt. */
export const transferEffect = (t: Pick<Transfer, 'kind' | 'amount'>): Vnd => (t.kind === 'transfer' ? -t.amount : t.amount);

/** Σ Phải trả over lots (`units` = all units; each lot only counts its own). */
export const totalPayable = (lots: readonly Lot[], units: readonly Unit[]): Vnd => lots.reduce((a, l) => a + lotPayable(l, units), 0);

export const totalTransferred = (transfers: readonly Transfer[]): Vnd =>
  transfers.reduce((a, t) => a + (t.kind === 'transfer' ? t.amount : 0), 0);

export const totalAdjustments = (transfers: readonly Transfer[]): Vnd =>
  transfers.reduce((a, t) => a + (t.kind === 'adjustment' ? t.amount : 0), 0);

export interface IntermediaryBalance {
  totalPayable: Vnd;
  totalTransferred: Vnd;
  totalAdjustment: Vnd;
  /** Còn nợ trung gian; negative = the shop has prepaid. */
  balance: Vnd;
}

/** Breakdown mirroring the DB view v_intermediary_balance. */
export function intermediaryBalance(lots: readonly Lot[], units: readonly Unit[], transfers: readonly Transfer[]): IntermediaryBalance {
  const p = totalPayable(lots, units);
  const t = totalTransferred(transfers);
  const a = totalAdjustments(transfers);
  return { totalPayable: p, totalTransferred: t, totalAdjustment: a, balance: p - t + a };
}

/** Còn nợ trung gian = Σ Phải trả − Σ Đã chuyển + Σ Điều chỉnh. */
export const intermediaryDebt = (lots: readonly Lot[], units: readonly Unit[], transfers: readonly Transfer[]): Vnd =>
  intermediaryBalance(lots, units, transfers).balance;
