/**
 * Units (per-grinder tracking, CR-001): codes (D1), creating N units per lot group (A2),
 * derived status (A5), days in stock, per-model stock counts (A9) and lot guards
 * (BR-02 / Q-011 receive, A10 / Q-014 edit lock, cancel). Pure: inputs are never mutated.
 */
import type { AgingLevel, AgingThresholds, Cny, IsoDate, Lot, Model, Order, Result, RuleError, Unit, UnitStatus, Vnd } from './types.ts';
import { DEFAULT_AGING, DEFAULT_LOT_LATE_DAYS, LOT_STATUS_LABEL, UNIT_STATUS_LABEL, fail, ok } from './types.ts';
import { unitCosts, type UnitCost } from './cost.ts';
import { validateLotGroup } from './validate.ts';

/* ---------- Codes (D1) ---------- */

/** D1 — `formatUnitCode('ZP6', 1)` → `"ZP6-001"`; at least 3 digits (`1234` → `"ZP6-1234"`). */
export function formatUnitCode(prefix: string, seq: number): string {
  if (!Number.isInteger(seq) || seq < 1) throw new RangeError(`formatUnitCode: seq must be a positive integer (${seq})`);
  return `${prefix}-${String(seq).padStart(3, '0')}`;
}

/** One group of the lot form (A2): model, quantity N, ¥ / unit, list price / unit. */
export interface LotGroupInput {
  modelId: string;
  qty: number;
  priceCny: Cny;
  /** Giá bán dự kiến / chiếc; null = the model's default list price (A1). */
  listPrice: Vnd | null;
}

/** A unit about to be created (preview — the DB assigns the real code from `models.next_seq`). */
export interface DraftUnit {
  code: string;
  modelId: string;
  priceCny: Cny;
  costOverride: null;
  listPrice: Vnd | null;
}

/**
 * A2 — expand the lot form groups into N draft units each, numbering codes per model from
 * `model.nextSeq` (default 1); several groups of the same model continue the sequence.
 */
export function expandLotGroups(groups: readonly LotGroupInput[], models: readonly Model[]): Result<DraftUnit[]> {
  if (groups.length === 0) {
    return fail({ code: 'INVALID_INPUT', rule: 'A2', message: 'Lô phải có ít nhất 1 nhóm chiếc.', field: 'groups' });
  }
  const modelById = new Map(models.map((m) => [m.id, m]));
  const seq = new Map<string, number>();
  const out: DraftUnit[] = [];
  for (const [i, g] of groups.entries()) {
    const v = validateLotGroup(g, i);
    if (!v.ok) return fail(v.error);
    const model = modelById.get(g.modelId);
    if (!model) {
      return fail({ code: 'INVALID_INPUT', rule: 'A2', message: `Nhóm ${i + 1}: model không tồn tại.`, field: `groups[${i}].modelId` });
    }
    let next = seq.get(model.id) ?? model.nextSeq ?? 1;
    for (let k = 0; k < g.qty; k++) {
      out.push({
        code: formatUnitCode(model.codePrefix, next++),
        modelId: model.id,
        priceCny: g.priceCny,
        costOverride: null,
        listPrice: g.listPrice ?? model.defaultListPrice,
      });
    }
    seq.set(model.id, next);
  }
  return ok(out);
}

/* ---------- Status (A5) ---------- */

/** Order that has shipped (Đã gửi / Hoàn tất): its units are sold. */
export const isSoldOrder = (o: Pick<Order, 'status'>): boolean => o.status === 'shipped' || o.status === 'completed';

/**
 * Order that has let go of its units: cancelled (§2) or returned (CR-004 "Hoàn hàng" — the DB flags its lines
 * `cancelled`). Its units are free again (in stock / incoming) and can be sold to another order.
 */
export const isReleasedOrder = (o: Pick<Order, 'status'>): boolean => o.status === 'cancelled' || o.status === 'returned';

/** The order holding a unit (not cancelled / returned; each unit belongs to at most one such order — CR §3), or null. */
export function holdingOrder(unitId: string, orders: readonly Order[], exceptOrderId?: string): Order | null {
  for (const o of orders) {
    if (isReleasedOrder(o) || o.id === exceptOrderId) continue;
    if (o.lines.some((l) => l.unitId === unitId)) return o;
  }
  return null;
}

/** unit id → holding order (cancelled / returned orders hold nothing). */
export function holderIndex(orders: readonly Order[]): Map<string, Order> {
  const m = new Map<string, Order>();
  for (const o of orders) {
    if (isReleasedOrder(o)) continue;
    for (const l of o.lines) if (!m.has(l.unitId)) m.set(l.unitId, o);
  }
  return m;
}

function statusOf(lot: Pick<Lot, 'status'>, holder: Order | null | undefined): UnitStatus {
  if (lot.status === 'cancelled') return 'cancelled';
  if (holder) return isSoldOrder(holder) ? 'sold' : 'reserved';
  return lot.status === 'received' ? 'in_stock' : 'incoming';
}

/**
 * A5 — Trạng thái chiếc: `cancelled` (lô huỷ) · `sold` (đơn Đã gửi / Hoàn tất) · `reserved` (đơn Đặt trước /
 * Đã chốt) · `in_stock` (lô đã nhận, chưa ai giữ) · `incoming` (lô chưa nhận, chưa ai giữ).
 * A cancelled or returned order releases its units (they fall back to in_stock / incoming).
 */
export const unitStatus = (unit: Pick<Unit, 'id'>, lot: Pick<Lot, 'status'>, orders: readonly Order[]): UnitStatus =>
  statusOf(lot, holdingOrder(unit.id, orders));

/** Display text; a reserved unit shows the order holding it (D4): "Đã giữ cho D-005". */
export function unitStatusLabel(status: UnitStatus, holder?: Pick<Order, 'id' | 'code'> | null): string {
  if (holder && status === 'reserved') return `Đã giữ cho ${holder.code ?? holder.id}`;
  if (holder && status === 'sold') return `Đã bán (${holder.code ?? holder.id})`;
  return UNIT_STATUS_LABEL[status];
}

/* ---------- Days in stock ---------- */

function dayNumber(d: IsoDate): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (!m) throw new RangeError(`not an ISO date: ${d}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000;
}

/** Whole calendar days from `from` to `to` (date parts only; never negative). Null when `from` is null. */
export function daysBetween(from: IsoDate | null, to: IsoDate): number | null {
  if (from == null) return null;
  return Math.max(0, dayNumber(to) - dayNumber(from));
}

/**
 * Số ngày tồn of a unit: from the lot's received date to the ship date of its order when sold,
 * otherwise to `today`. Null while the unit is not received (incoming / cancelled lot).
 */
export function unitDaysInStock(lot: Pick<Lot, 'status' | 'receivedAt'>, holder: Order | null | undefined, today: IsoDate): number | null {
  if (lot.status !== 'received' || lot.receivedAt == null) return null;
  const until = holder && isSoldOrder(holder) ? (holder.shippedAt ?? today) : today;
  return daysBetween(lot.receivedAt, until);
}

/* ---------- Aging (CR-004 KHO-S1, LOT-S2, HOME-S1) ---------- */

/**
 * KHO-S1 — mức tuổi tồn từ số ngày tồn: > alertDays ⇒ `alert` (đỏ), > warnDays ⇒ `warn` (cam), else `ok`.
 * Defaults 30 / 60 (Cài đặt). Null days ⇒ null.
 */
export function agingLevel(days: number | null, t: AgingThresholds = DEFAULT_AGING): AgingLevel | null {
  if (days == null) return null;
  if (days > t.alertDays) return 'alert';
  if (days > t.warnDays) return 'warn';
  return 'ok';
}

/**
 * Same as DB `v_units.aging_level`: only units already in stock and not sold (status `in_stock` or a `reserved`
 * unit whose lot is received) have an aging level; incoming / sold / cancelled ⇒ null.
 */
export function unitAgingLevel(
  status: UnitStatus,
  lot: Pick<Lot, 'status' | 'receivedAt'>,
  today: IsoDate,
  t: AgingThresholds = DEFAULT_AGING,
): AgingLevel | null {
  if (lot.status !== 'received' || (status !== 'in_stock' && status !== 'reserved')) return null;
  return agingLevel(daysBetween(lot.receivedAt, today), t);
}

/** Số ngày từ ngày đặt của lô còn mở ("đặt 12 ngày"); null when the lot is received / cancelled or has no order date. */
export function lotDaysOpen(lot: Pick<Lot, 'status' | 'orderedAt'>, today: IsoDate): number | null {
  if (lot.status === 'received' || lot.status === 'cancelled' || !lot.orderedAt) return null;
  return daysBetween(lot.orderedAt, today);
}

/** LOT-S2 — "Lô về trễ": open lot ordered more than `lateDays` (default 21) days ago. Same as DB `v_lot_summary.is_lot_late`. */
export function isLotLate(lot: Pick<Lot, 'status' | 'orderedAt'>, today: IsoDate, lateDays: number = DEFAULT_LOT_LATE_DAYS): boolean {
  const d = lotDaysOpen(lot, today);
  return d != null && d > lateDays;
}

/* ---------- Unit list rows (mirror of the DB view v_units) ---------- */

export interface UnitView {
  unit: Unit;
  lot: Lot;
  status: UnitStatus;
  /** Order holding the unit (reserved or sold), null otherwise. */
  holder: Order | null;
  cost: UnitCost;
  /** Giá chốt on the holding order, null when not held. */
  salePrice: Vnd | null;
  /** Lãi dự kiến = (giá chốt if held, else giá bán dự kiến) − giá nhập ₫ hiệu lực; null without a price. */
  expectedProfit: Vnd | null;
  /** Lãi thực tế = giá chốt − giá nhập ₫ hiệu lực, only when sold. */
  profit: Vnd | null;
  daysInStock: number | null;
  /** CR-004 — mức tuổi tồn (≈ `v_units.aging_level`). */
  agingLevel: AgingLevel | null;
}

/**
 * One row per unit with status, holder, costs, profit, days in stock and aging level. `units` must contain ALL
 * units of the lots involved (ship fee split), `lots` every unit's lot (missing lot throws — data error).
 */
export function buildUnitViews(
  units: readonly Unit[],
  lots: readonly Lot[],
  orders: readonly Order[],
  today: IsoDate,
  aging: AgingThresholds = DEFAULT_AGING,
): UnitView[] {
  const lotById = new Map(lots.map((l) => [l.id, l]));
  const costs = unitCosts(units, lots);
  const holders = holderIndex(orders);
  return units.map((unit) => {
    const lot = lotById.get(unit.lotId)!; // unitCosts already threw if missing
    const cost = costs.get(unit.id)!;
    const holder = holders.get(unit.id) ?? null;
    const status = statusOf(lot, holder);
    const salePrice = holder?.lines.find((l) => l.unitId === unit.id)?.price ?? null;
    const refPrice = salePrice ?? unit.listPrice;
    return {
      unit,
      lot,
      status,
      holder,
      cost,
      salePrice,
      expectedProfit: refPrice == null ? null : refPrice - cost.effective,
      profit: status === 'sold' && salePrice != null ? salePrice - cost.effective : null,
      daysInStock: unitDaysInStock(lot, holder, today),
      agingLevel: unitAgingLevel(status, lot, today, aging),
    };
  });
}

/* ---------- Model stock (A9) ---------- */

export interface ModelStock {
  modelId: string;
  /** Trong kho — received, not held. */
  inStock: number;
  /** Đang về — lot not received yet, not held. */
  incoming: number;
  /** Đã giữ — held by a pre-order / confirmed order (received or still incoming). */
  reserved: number;
  sold: number;
  /** Received and not sold (in_stock + reserved units already received) — what is physically on the shelf. */
  onHand: number;
  /** Có thể bán = Trong kho + Đang về chưa giữ (A9). */
  sellable: number;
  /** Sắp hết: sellable ≤ model threshold (A9). */
  lowStock: boolean;
  /** Giá trị tồn = Σ giá nhập ₫ hiệu lực of received, not-sold units (CR §3 v_model_stock). */
  stockValue: Vnd;
}

/** A9 — stock figures per model, in the order of `models`. Same input requirements as `buildUnitViews`. */
export function modelStocks(models: readonly Model[], units: readonly Unit[], lots: readonly Lot[], orders: readonly Order[]): ModelStock[] {
  const lotById = new Map(lots.map((l) => [l.id, l]));
  const costs = unitCosts(units, lots);
  const holders = holderIndex(orders);
  return models.map((m) => {
    const s: ModelStock = { modelId: m.id, inStock: 0, incoming: 0, reserved: 0, sold: 0, onHand: 0, sellable: 0, lowStock: false, stockValue: 0 };
    for (const u of units) {
      if (u.modelId !== m.id) continue;
      const lot = lotById.get(u.lotId)!;
      const status = statusOf(lot, holders.get(u.id));
      if (status === 'in_stock') s.inStock++;
      else if (status === 'incoming') s.incoming++;
      else if (status === 'reserved') s.reserved++;
      else if (status === 'sold') s.sold++;
      if (lot.status === 'received' && status !== 'sold') {
        s.onHand++;
        s.stockValue += costs.get(u.id)!.effective;
      }
    }
    s.sellable = s.inStock + s.incoming;
    s.lowStock = s.sellable <= m.lowStockThreshold;
    return s;
  });
}

/** Single-model convenience over `modelStocks`. */
export const modelStock = (model: Model, units: readonly Unit[], lots: readonly Lot[], orders: readonly Order[]): ModelStock =>
  modelStocks([model], units, lots, orders)[0]!;

/** Total stock value over all units: Σ effective cost of received, not-sold units. */
export function stockValue(units: readonly Unit[], lots: readonly Lot[], orders: readonly Order[]): Vnd {
  const lotById = new Map(lots.map((l) => [l.id, l]));
  const costs = unitCosts(units, lots);
  const holders = holderIndex(orders);
  let value = 0;
  for (const u of units) {
    const lot = lotById.get(u.lotId)!;
    if (lot.status === 'received' && statusOf(lot, holders.get(u.id)) !== 'sold') value += costs.get(u.id)!.effective;
  }
  return value;
}

/* ---------- Lot guards ---------- */

const isOpenLot = (lot: Pick<Lot, 'status'>): boolean => lot.status !== 'received' && lot.status !== 'cancelled';

/** BR-02 + Q-011 — a lot can be received from any open status, but only once its ship fee is entered. */
export function checkReceiveLot(lot: Lot): Result<true> {
  if (!isOpenLot(lot)) {
    return fail({ code: 'INVALID_TRANSITION', rule: 'Q-011', message: `Lô đang "${LOT_STATUS_LABEL[lot.status]}" — không nhận hàng được.`, lotId: lot.id });
  }
  if (lot.shipFee == null) {
    return fail({ code: 'SHIP_FEE_REQUIRED', rule: 'BR-02', message: 'Nhập phí ship về VN của lô trước khi chuyển "Đã nhận".', field: 'shipFee', lotId: lot.id });
  }
  return ok(true);
}

/**
 * Cancel a lot: only before it is received (§2), and (AI proposal) not while one of its units is held by a
 * non-cancelled order — the order must be cancelled or edited first, otherwise it would point to a unit that
 * will never arrive.
 */
export function checkCancelLot(lot: Lot, units: readonly Unit[], orders: readonly Order[]): Result<true> {
  if (!isOpenLot(lot)) {
    return fail({ code: 'INVALID_TRANSITION', rule: '§2', message: 'Chỉ huỷ được lô chưa nhận.', lotId: lot.id });
  }
  const holders = holderIndex(orders);
  for (const u of units) {
    if (u.lotId !== lot.id) continue;
    const h = holders.get(u.id);
    if (h) {
      return fail({
        code: 'INVALID_TRANSITION',
        rule: 'A5',
        message: `Chiếc ${u.code} đang thuộc đơn ${h.code ?? h.id} — huỷ hoặc sửa đơn trước khi huỷ lô.`,
        lotId: lot.id,
        unitId: u.id,
        conflictOrderId: h.id,
      });
    }
  }
  return ok(true);
}

/**
 * A10 / Q-014 — a received lot may change its ship fee and, per unit, the hand-entered ₫ cost, list price,
 * serial / note; it may NOT add / remove units or change the rate, the buying fee % (CR-003), a unit's ¥ price or model.
 * `before` / `after` are the lot with its units; units of other lots are ignored. Open lots are unrestricted.
 */
export function checkLotEdit(before: { lot: Lot; units: readonly Unit[] }, after: { lot: Lot; units: readonly Unit[] }): Result<true> {
  if (before.lot.status !== 'received') return ok(true);
  const locked = (message: string, extra: Partial<RuleError> = {}): Result<true> =>
    fail({ code: 'LOT_LOCKED', rule: 'A10', message, lotId: before.lot.id, ...extra });
  if (after.lot.rate !== before.lot.rate) return locked('Lô đã nhận: không đổi được tỷ giá (sai thì ghi Điều chỉnh công nợ).', { field: 'rate' });
  if ((after.lot.buyingFeePct ?? 0) !== (before.lot.buyingFeePct ?? 0)) {
    return locked('Lô đã nhận: không đổi được phí mua hộ (sai thì ghi Điều chỉnh công nợ).', { field: 'buyingFeePct' });
  }
  const prev = new Map(before.units.filter((u) => u.lotId === before.lot.id).map((u) => [u.id, u]));
  const next = after.units.filter((u) => u.lotId === before.lot.id);
  if (next.length !== prev.size || next.some((u) => !prev.has(u.id))) {
    return locked('Lô đã nhận: không thêm / bớt chiếc được.', { field: 'units' });
  }
  for (const u of next) {
    const p = prev.get(u.id)!;
    if (u.priceCny !== p.priceCny) return locked(`Lô đã nhận: không đổi được giá ¥ của chiếc ${p.code}.`, { field: 'priceCny', unitId: u.id });
    if (u.modelId !== p.modelId) return locked(`Lô đã nhận: không đổi được model của chiếc ${p.code}.`, { field: 'modelId', unitId: u.id });
  }
  return ok(true);
}
