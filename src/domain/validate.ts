/**
 * Input validation shared by the guards. Returns typed rule errors, never throws.
 */
import type { Lot, LotLine, Order, OrderLine, Payment, Result, RuleError, Transfer } from './types.ts';
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

/** Accepts `YYYY-MM-DD`, optionally followed by a time part. */
export const isIsoDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}(?:$|T)/.test(s);

/** Shape checks for a lot (BR-01 inputs, BR-02: ship fee may be null, otherwise a whole-đồng amount ≥ 0). */
export function validateLot(lot: Lot): Result<Lot> {
  const at = { lotId: lot.id };
  if (!isFiniteNumber(lot.rate) || lot.rate <= 0) {
    return fail(invalid('BR-03', 'Tỷ giá phải là số dương.', 'rate', at));
  }
  if (lot.shipFee !== null && !isNonNegativeInt(lot.shipFee)) {
    return fail(invalid('BR-02', 'Phí ship về VN phải là số đồng nguyên ≥ 0 (hoặc để trống).', 'shipFee', at));
  }
  if (!Array.isArray(lot.lines) || lot.lines.length === 0) {
    return fail(invalid('BR-01', 'Lô phải có ít nhất 1 dòng hàng.', 'lines', at));
  }
  for (const [i, line] of lot.lines.entries()) {
    const r = validateLotLine(line, i);
    if (!r.ok) return fail({ ...r.error, ...at });
  }
  return ok(lot);
}

function validateLotLine(line: LotLine, i: number): Result<LotLine> {
  if (!isNonEmptyString(line.variantId)) {
    return fail(invalid('BR-01', `Dòng ${i + 1}: chưa chọn biến thể.`, `lines[${i}].variantId`));
  }
  if (!isPositiveInt(line.qty)) {
    return fail(invalid('BR-01', `Dòng ${i + 1}: số lượng phải là số nguyên dương.`, `lines[${i}].qty`, { variantId: line.variantId }));
  }
  if (!isFiniteNumber(line.cny) || line.cny < 0) {
    return fail(invalid('BR-01', `Dòng ${i + 1}: giá ¥ phải là số ≥ 0.`, `lines[${i}].cny`, { variantId: line.variantId }));
  }
  return ok(line);
}

/** Lines of an order (or of a new-order request): positive whole qty, whole-đồng price ≥ 0. */
export function validateOrderLines(lines: ReadonlyArray<Pick<OrderLine, 'variantId' | 'qty'> & Partial<Pick<OrderLine, 'price'>>>): Result<true> {
  if (!Array.isArray(lines) || lines.length === 0) {
    return fail(invalid('BR-07', 'Đơn phải có ít nhất 1 dòng hàng.', 'lines'));
  }
  for (const [i, line] of lines.entries()) {
    if (!isNonEmptyString(line.variantId)) {
      return fail(invalid('BR-07', `Dòng ${i + 1}: chưa chọn biến thể.`, `lines[${i}].variantId`));
    }
    if (!isPositiveInt(line.qty)) {
      return fail(invalid('BR-07', `Dòng ${i + 1}: số lượng phải là số nguyên dương.`, `lines[${i}].qty`, { variantId: line.variantId }));
    }
    if (line.price !== undefined && !isNonNegativeInt(line.price)) {
      return fail(invalid('BR-10', `Dòng ${i + 1}: giá chốt phải là số đồng nguyên ≥ 0.`, `lines[${i}].price`, { variantId: line.variantId }));
    }
  }
  return ok(true);
}

export function validatePayment(p: Payment, i = 0): Result<Payment> {
  if (!isPositiveInt(p.amount)) {
    return fail(invalid('BR-10', `Khoản thu ${i + 1}: số tiền phải là số đồng nguyên dương (hoàn tiền vẫn nhập số dương).`, `payments[${i}].amount`));
  }
  if (p.kind !== 'coc' && p.kind !== 'tt' && p.kind !== 'hoan') {
    return fail(invalid('BR-10', `Khoản thu ${i + 1}: loại không hợp lệ.`, `payments[${i}].kind`));
  }
  return ok(p);
}

export function validateOrder(order: Order): Result<Order> {
  const at = { orderId: order.id };
  const lines = validateOrderLines(order.lines);
  if (!lines.ok) return fail({ ...lines.error, ...at });
  for (const [i, line] of order.lines.entries()) {
    if (!isNonNegativeInt(line.price)) {
      return fail(invalid('BR-10', `Dòng ${i + 1}: giá chốt phải là số đồng nguyên ≥ 0.`, `lines[${i}].price`, { ...at, variantId: line.variantId }));
    }
    if (line.cost != null && !isNonNegativeInt(line.cost)) {
      return fail(invalid('BR-05', `Dòng ${i + 1}: giá vốn đã chụp phải là số đồng nguyên ≥ 0.`, `lines[${i}].cost`, { ...at, variantId: line.variantId }));
    }
  }
  if (!isNonNegativeInt(order.shipFee)) {
    return fail(invalid('BR-10', 'Phí ship VN phải là số đồng nguyên ≥ 0.', 'shipFee', at));
  }
  if (order.shipPayer !== 'khach' && order.shipPayer !== 'shop') {
    return fail(invalid('BR-10', 'Chưa chọn ai trả phí ship.', 'shipPayer', at));
  }
  for (const [i, p] of order.payments.entries()) {
    const r = validatePayment(p, i);
    if (!r.ok) return fail({ ...r.error, ...at });
  }
  return ok(order);
}

/** `chuyen` must be > 0; `dieuChinh` is signed but not 0. Whole đồng. */
export function validateTransfer(t: Transfer): Result<Transfer> {
  if (t.kind === 'chuyen' && !isPositiveInt(t.amount)) {
    return fail(invalid('BR-12', 'Số tiền đã chuyển phải là số đồng nguyên dương.', 'amount'));
  }
  if (t.kind === 'dieuChinh' && (!Number.isInteger(t.amount) || t.amount === 0)) {
    return fail(invalid('BR-12', 'Số tiền điều chỉnh phải là số đồng nguyên khác 0 (âm = giảm nợ).', 'amount'));
  }
  if (t.kind !== 'chuyen' && t.kind !== 'dieuChinh') {
    return fail(invalid('BR-12', 'Loại giao dịch trung gian không hợp lệ.', 'kind'));
  }
  return ok(t);
}
