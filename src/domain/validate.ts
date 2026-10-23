/**
 * Input validation shared by the guards and the forms. Returns typed rule errors, never throws.
 */
import type { Cny, Lot, Model, Order, Payment, PaymentMethod, Result, RuleError, Transfer, Unit, UnitCondition, Vnd } from './types.ts';
import { fail, ok } from './types.ts';

const invalid = (rule: string, message: string, field: string, extra: Partial<RuleError> = {}): RuleError => ({
  code: 'INVALID_INPUT',
  rule,
  message,
  field,
  ...extra,
});

export const isPositiveInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;
export const isNonNegativeInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;
const isFiniteNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const isNonEmptyString = (s: unknown): s is string => typeof s === 'string' && s.trim() !== '';
const isOptionalVnd = (n: unknown): boolean => n === null || isNonNegativeInt(n);

/** Accepts `YYYY-MM-DD`, optionally followed by a time part. */
export const isIsoDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}(?:$|T)/.test(s);

/** Code prefix (D1): 1–10 letters / digits, e.g. `ZP6`, `KU`, `JU`. */
export const CODE_PREFIX_RE = /^[A-Za-z0-9]{1,10}$/;

/** Max units created by one lot group (same bound as the v1 lot line quantity). */
export const MAX_GROUP_QTY = 1000;

/** A1 — model fields. */
export function validateModel(m: Model): Result<Model> {
  if (!isNonEmptyString(m.name) || m.name.trim().length > 80) {
    return fail(invalid('A1', 'Tên model phải có 1–80 ký tự.', 'name'));
  }
  if (typeof m.codePrefix !== 'string' || !CODE_PREFIX_RE.test(m.codePrefix)) {
    return fail(invalid('D1', 'Tiền tố mã phải là 1–10 chữ cái / chữ số (vd. ZP6).', 'codePrefix'));
  }
  if (!isOptionalVnd(m.defaultListPrice)) {
    return fail(invalid('A1', 'Giá bán mặc định phải là số đồng nguyên ≥ 0 (hoặc để trống).', 'defaultListPrice'));
  }
  if (!isNonNegativeInt(m.lowStockThreshold)) {
    return fail(invalid('A9', 'Ngưỡng sắp hết phải là số nguyên ≥ 0.', 'lowStockThreshold'));
  }
  return ok(m);
}

/** CR-003 — phí mua hộ %: số từ 0 đến 100, tối đa 2 chữ số thập phân (DB numeric(5,2)). */
export const isBuyingFeePct = (n: unknown): n is number =>
  isFiniteNumber(n) && n >= 0 && n <= 100 && Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;

/** BR-03 rate > 0; BR-02 ship fee null or whole đồng ≥ 0; CR-003 phí mua hộ 0..100 % (missing = 0). */
export function validateLot(lot: Lot): Result<Lot> {
  const at = { lotId: lot.id };
  if (!isFiniteNumber(lot.rate) || lot.rate <= 0) {
    return fail(invalid('BR-03', 'Tỷ giá phải là số dương.', 'rate', at));
  }
  if (lot.shipFee !== null && !isNonNegativeInt(lot.shipFee)) {
    return fail(invalid('BR-02', 'Phí ship về VN phải là số đồng nguyên ≥ 0 (hoặc để trống).', 'shipFee', at));
  }
  if (lot.buyingFeePct != null && !isBuyingFeePct(lot.buyingFeePct)) {
    return fail(invalid('CR-003', 'Phí mua hộ là số % từ 0 đến 100 (tối đa 2 chữ số thập phân, vd. 2,5).', 'buyingFeePct', at));
  }
  return ok(lot);
}

const checkPriceCny = (n: Cny): boolean => isFiniteNumber(n) && n > 0;

/** A2 — one group of the lot form: model, N ≥ 1, ¥ > 0, list price null or whole đồng ≥ 0. */
export function validateLotGroup(g: { modelId: string; qty: number; priceCny: Cny; listPrice: Vnd | null }, i = 0): Result<true> {
  if (!isNonEmptyString(g.modelId)) return fail(invalid('A2', `Nhóm ${i + 1}: chưa chọn model.`, `groups[${i}].modelId`));
  if (!isPositiveInt(g.qty) || g.qty > MAX_GROUP_QTY) {
    return fail(invalid('A2', `Nhóm ${i + 1}: số lượng phải là số nguyên từ 1 đến ${MAX_GROUP_QTY}.`, `groups[${i}].qty`));
  }
  if (!checkPriceCny(g.priceCny)) return fail(invalid('A2', `Nhóm ${i + 1}: giá ¥ phải là số dương.`, `groups[${i}].priceCny`));
  if (!isOptionalVnd(g.listPrice)) {
    return fail(invalid('D3', `Nhóm ${i + 1}: giá bán dự kiến phải là số đồng nguyên ≥ 0.`, `groups[${i}].listPrice`));
  }
  return ok(true);
}

/** CR-004 — DB enums. */
export const UNIT_CONDITIONS: readonly UnitCondition[] = ['new', 'like_new', 'used', 'defect'];
export const PAYMENT_METHODS: readonly PaymentMethod[] = ['transfer', 'cash', 'cod'];

/** Unit fields (D1–D3, CR-004 condition). */
export function validateUnit(u: Unit): Result<Unit> {
  const at = { unitId: u.id, lotId: u.lotId };
  if (!isNonEmptyString(u.code)) return fail(invalid('D1', 'Chiếc chưa có mã.', 'code', at));
  if (!isNonEmptyString(u.modelId)) return fail(invalid('A1', `Chiếc ${u.code}: chưa chọn model.`, 'modelId', at));
  if (!checkPriceCny(u.priceCny)) return fail(invalid('D2', `Chiếc ${u.code}: giá ¥ phải là số dương.`, 'priceCny', at));
  if (!isOptionalVnd(u.costOverride)) {
    return fail(invalid('D2', `Chiếc ${u.code}: giá nhập ₫ sửa tay phải là số đồng nguyên ≥ 0 (để trống = tự tính).`, 'costOverride', at));
  }
  if (!isOptionalVnd(u.listPrice)) return fail(invalid('D3', `Chiếc ${u.code}: giá bán dự kiến phải là số đồng nguyên ≥ 0.`, 'listPrice', at));
  if (u.condition != null && !UNIT_CONDITIONS.includes(u.condition)) {
    return fail(invalid('KHO-S3', `Chiếc ${u.code}: tình trạng không hợp lệ.`, 'condition', at));
  }
  return ok(u);
}

export function validatePayment(p: Payment, i = 0): Result<Payment> {
  if (!isPositiveInt(p.amount)) {
    return fail(invalid('BR-10', `Khoản thu ${i + 1}: số tiền phải là số đồng nguyên dương (hoàn tiền vẫn nhập số dương).`, `payments[${i}].amount`));
  }
  if (p.kind !== 'deposit' && p.kind !== 'payment' && p.kind !== 'refund') {
    return fail(invalid('BR-10', `Khoản thu ${i + 1}: loại không hợp lệ.`, `payments[${i}].kind`));
  }
  if (p.method != null && !PAYMENT_METHODS.includes(p.method)) {
    return fail(invalid('DON-S1', `Khoản thu ${i + 1}: hình thức thu không hợp lệ.`, `payments[${i}].method`));
  }
  if (p.method === 'cod' && p.kind !== 'payment') {
    return fail(invalid('DON-S1', `Khoản thu ${i + 1}: COD chỉ dùng cho khoản thanh toán (tiền hãng ship chuyển về).`, `payments[${i}].method`));
  }
  return ok(p);
}

/** Order shape: ≥ 1 line, each unit once, whole-đồng prices, ship fee, payer, payments. */
export function validateOrder(order: Order): Result<Order> {
  const at = { orderId: order.id };
  if (!Array.isArray(order.lines) || order.lines.length === 0) {
    return fail(invalid('A6', 'Đơn phải có ít nhất 1 chiếc.', 'lines', at));
  }
  const seen = new Set<string>();
  for (const [i, line] of order.lines.entries()) {
    if (!isNonEmptyString(line.unitId)) return fail(invalid('A6', `Dòng ${i + 1}: chưa chọn chiếc.`, `lines[${i}].unitId`, at));
    if (seen.has(line.unitId)) return fail(invalid('A6', `Dòng ${i + 1}: chiếc bị chọn 2 lần.`, `lines[${i}].unitId`, { ...at, unitId: line.unitId }));
    seen.add(line.unitId);
    if (!isNonNegativeInt(line.price)) {
      return fail(invalid('D3', `Dòng ${i + 1}: giá chốt phải là số đồng nguyên ≥ 0.`, `lines[${i}].price`, { ...at, unitId: line.unitId }));
    }
  }
  if (!isNonNegativeInt(order.shipFee)) return fail(invalid('BR-10', 'Phí ship VN phải là số đồng nguyên ≥ 0.', 'shipFee', at));
  if (order.shipPayer !== 'customer' && order.shipPayer !== 'shop') {
    return fail(invalid('BR-10', 'Chưa chọn ai trả phí ship.', 'shipPayer', at));
  }
  if (order.codAmount != null && !isNonNegativeInt(order.codAmount)) {
    return fail(invalid('DON-S1', 'Tiền COD phải là số đồng nguyên ≥ 0.', 'codAmount', at));
  }
  if (order.returnShipFee != null && !isNonNegativeInt(order.returnShipFee)) {
    return fail(invalid('DON-S3', 'Phí ship chiều về phải là số đồng nguyên ≥ 0.', 'returnShipFee', at));
  }
  for (const [i, p] of order.payments.entries()) {
    const r = validatePayment(p, i);
    if (!r.ok) return fail({ ...r.error, ...at });
  }
  return ok(order);
}

/** `transfer` must be > 0; `adjustment` is signed but not 0. Whole đồng. */
export function validateTransfer(t: Transfer): Result<Transfer> {
  if (t.kind !== 'transfer' && t.kind !== 'adjustment') {
    return fail(invalid('BR-12', 'Loại giao dịch trung gian không hợp lệ.', 'kind'));
  }
  if (t.kind === 'transfer' && !isPositiveInt(t.amount)) {
    return fail(invalid('BR-12', 'Số tiền đã chuyển phải là số đồng nguyên dương.', 'amount'));
  }
  if (t.kind === 'adjustment' && (!Number.isInteger(t.amount) || t.amount === 0)) {
    return fail(invalid('BR-12', 'Số tiền điều chỉnh phải là số đồng nguyên khác 0 (âm = giảm nợ).', 'amount'));
  }
  return ok(t);
}
