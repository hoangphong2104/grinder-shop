/**
 * Unit cost (D2, A3, CR-003) and lot payable (A4 / BR-12, CR-003). Pure functions, no I/O.
 *
 *   giá nhập ₫ tự tính  = round(giá ¥ × tỷ giá × (1 + phí mua hộ %/100) + phí ship lô ÷ số chiếc của lô)   (D2, CR-003)
 *   giá nhập ₫ hiệu lực = giá sửa tay ?? giá tự tính                                                     (D2, CR §3)
 *   phải trả lô          = round(Σ giá ¥ × tỷ giá × (1 + phí mua hộ %/100) + phí ship lô); lô huỷ = 0     (A4, CR-003)
 *   tiền hàng lô         = round(Σ giá ¥ × tỷ giá)            — chưa gồm phí mua hộ (= v_lot_summary.goods_vnd)
 *   phí mua hộ lô        = round(Σ giá ¥ × tỷ giá × %/100)    (= v_lot_summary.buying_fee_vnd)
 *
 * There is no average and no snapshot: costs always follow the current lot data (A3, A8), so the
 * profit of an order already shipped changes when the lot's ship fee / rate is corrected, unless the
 * unit's cost was overridden by hand.
 */
import type { Lot, Unit, Vnd } from './types.ts';
import { roundVnd } from './money.ts';

/** Units of a lot (all of them, including those already sold). */
export const unitsOfLot = (lotId: string, units: readonly Unit[]): Unit[] => units.filter((u) => u.lotId === lotId);

/** Số chiếc của lô — the divisor of the lot ship fee. */
export const lotUnitCount = (lotId: string, units: readonly Unit[]): number =>
  units.reduce((n, u) => n + (u.lotId === lotId ? 1 : 0), 0);

/** Phí mua hộ % of a lot (CR-003); missing / null = 0. */
export const buyingFeePctOf = (lot: Pick<Lot, 'buyingFeePct'>): number => lot.buyingFeePct ?? 0;

/** ₫ value × (1 + phí %/100), unrounded. Computed as × (100 + %) ÷ 100 to keep binary noise tiny. */
const withBuyingFee = (vnd: number, pct: number): number => (vnd * (100 + pct)) / 100;

/**
 * D2 + CR-003 — giá nhập ₫ tự tính = round(giá ¥ × tỷ giá × (1 + phí mua hộ %/100) + (phí ship lô ?? 0) ÷ số chiếc lô).
 * While the ship fee is blank the cost is provisional (ship counted as 0, see `isCostProvisional`).
 * `lotUnitCount` must be ≥ 1 (the unit itself belongs to the lot) — anything else is a caller bug.
 */
export function autoUnitCost(unit: Pick<Unit, 'priceCny'>, lot: Pick<Lot, 'rate' | 'shipFee' | 'buyingFeePct'>, lotUnitCount: number): Vnd {
  if (!Number.isInteger(lotUnitCount) || lotUnitCount < 1) {
    throw new RangeError(`autoUnitCost: lotUnitCount must be a positive integer (${lotUnitCount})`);
  }
  return roundVnd(withBuyingFee(unit.priceCny * lot.rate, buyingFeePctOf(lot)) + (lot.shipFee ?? 0) / lotUnitCount);
}

/** The ¥ × rate × (1 + phí %) part only — no ship (UI shows "… + ship" while the ship fee is blank). */
export const unitCostBeforeShip = (unit: Pick<Unit, 'priceCny'>, lot: Pick<Lot, 'rate' | 'buyingFeePct'>): Vnd =>
  roundVnd(withBuyingFee(unit.priceCny * lot.rate, buyingFeePctOf(lot)));

/** D2 — giá nhập ₫ hiệu lực = giá sửa tay nếu có, ngược lại giá tự tính (= coalesce(override, auto) in the DB). */
export const effectiveCost = (unit: Pick<Unit, 'costOverride'>, auto: Vnd): Vnd => unit.costOverride ?? auto;

/** True while the effective cost still lacks the lot ship fee (no override and ship fee blank). */
export const isCostProvisional = (unit: Pick<Unit, 'costOverride'>, lot: Pick<Lot, 'shipFee'>): boolean =>
  unit.costOverride == null && lot.shipFee == null;

export interface UnitCost {
  /** Giá nhập ₫ tự tính (D2). */
  auto: Vnd;
  /** Giá nhập ₫ hiệu lực (override ?? auto). */
  effective: Vnd;
  overridden: boolean;
  provisional: boolean;
}

/**
 * Cost of every unit, keyed by unit id. `lots` must contain the lot of every unit and `units` must
 * contain ALL units of those lots (the ship fee is split over the whole lot). A unit whose lot is
 * missing is a data error and throws.
 */
export function unitCosts(units: readonly Unit[], lots: readonly Lot[]): Map<string, UnitCost> {
  const lotById = new Map(lots.map((l) => [l.id, l]));
  const count = new Map<string, number>();
  for (const u of units) count.set(u.lotId, (count.get(u.lotId) ?? 0) + 1);
  const out = new Map<string, UnitCost>();
  for (const u of units) {
    const lot = lotById.get(u.lotId);
    if (!lot) throw new Error(`unitCosts: lot ${u.lotId} of unit ${u.code} is missing`);
    const auto = autoUnitCost(u, lot, count.get(u.lotId) ?? 1);
    out.set(u.id, {
      auto,
      effective: effectiveCost(u, auto),
      overridden: u.costOverride != null,
      provisional: isCostProvisional(u, lot),
    });
  }
  return out;
}

/** Effective cost by unit id — the input expected by the profit / stock-value functions. */
export function effectiveCosts(units: readonly Unit[], lots: readonly Lot[]): Map<string, Vnd> {
  const out = new Map<string, Vnd>();
  for (const [id, c] of unitCosts(units, lots)) out.set(id, c.effective);
  return out;
}

/** Σ giá ¥ of the lot's units (units of other lots in `units` are ignored). */
export const lotGoodsCny = (lot: Pick<Lot, 'id'>, units: readonly Unit[]): number =>
  units.reduce((a, u) => a + (u.lotId === lot.id ? u.priceCny : 0), 0);

/** Tiền hàng = Σ giá ¥ × tỷ giá, rounded once — WITHOUT the buying fee (same meaning as before CR-003). */
export const lotGoodsVnd = (lot: Pick<Lot, 'id' | 'rate'>, units: readonly Unit[]): Vnd => roundVnd(lotGoodsCny(lot, units) * lot.rate);

/** CR-003 — Phí mua hộ ₫ of a lot = round(Σ giá ¥ × tỷ giá × phí %/100) (= v_lot_summary.buying_fee_vnd). */
export const lotBuyingFeeVnd = (lot: Pick<Lot, 'id' | 'rate' | 'buyingFeePct'>, units: readonly Unit[]): Vnd =>
  roundVnd((lotGoodsCny(lot, units) * lot.rate * buyingFeePctOf(lot)) / 100);

/**
 * A4 / BR-12 + CR-003 — Phải trả trung gian of a lot
 *   = round(Σ giá ¥ × tỷ giá × (1 + phí mua hộ %/100) + phí ship lô (khi đã nhập)).
 * Rounded once, so it may differ by 1 ₫ from tiền hàng + phí mua hộ + ship (each rounded on its own).
 * Independent of hand-entered ₫ costs. A cancelled lot is 0. `units` may contain other lots' units.
 */
export function lotPayable(lot: Pick<Lot, 'id' | 'rate' | 'shipFee' | 'status' | 'buyingFeePct'>, units: readonly Unit[]): Vnd {
  if (lot.status === 'cancelled') return 0;
  return roundVnd(withBuyingFee(lotGoodsCny(lot, units) * lot.rate, buyingFeePctOf(lot)) + (lot.shipFee ?? 0));
}
