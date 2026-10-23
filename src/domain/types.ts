/**
 * Grinder Shop — domain types after CR-001 (per-unit tracking, no weighted average, no colour variants).
 * Sources: 1.5-change-control/draft/CR_001_quan-ly-tung-chiec.md (D1–D4, A1–A11, §3) and the rules still
 * in force from 1.0-requirements/approved/data-and-rules-v1.md (BR-02, BR-03, BR-10..BR-14, §6).
 * Pure data shapes only: no I/O, no runtime dependencies.
 *
 * Status / kind codes are the DB codes (English) so DB rows map 1:1; Vietnamese labels are in the *_LABEL maps.
 *
 * Money conventions:
 *  - `Vnd` amounts are whole đồng (integers).
 *  - `Cny` amounts are yuan (may have decimals, e.g. ¥1.010 or ¥99,5).
 *  - Dates are ISO strings `YYYY-MM-DD` (a full ISO timestamp is accepted where noted; only the date part is used).
 */

export type Vnd = number;
export type Cny = number;
export type IsoDate = string;

/* ---------- Statuses & kinds (DB codes) ---------- */

/** Lô nhập: ordered → cn_shipping → at_forwarder → vn_shipping → received; cancelled before received. */
export type LotStatus = 'ordered' | 'cn_shipping' | 'at_forwarder' | 'vn_shipping' | 'received' | 'cancelled';

/** Đơn bán: preorder / confirmed → shipped → completed; cancelled before shipped. */
export type OrderStatus = 'preorder' | 'confirmed' | 'shipped' | 'completed' | 'cancelled';

/** Trạng thái chiếc (A5) — derived, never entered. */
export type UnitStatus = 'incoming' | 'in_stock' | 'reserved' | 'sold' | 'cancelled';

/** Thu tiền khách: cọc / thanh toán / hoàn tiền (refund counts negative). `amount` is always positive. */
export type PaymentKind = 'deposit' | 'payment' | 'refund';

/** Hand-entered intermediary transactions. The per-lot "payable" is derived from the lot (BR-12 / A4). */
export type TransferKind = 'transfer' | 'adjustment';

/** Who bears the domestic (VN) shipping fee of an order (Q-002). */
export type ShipPayer = 'customer' | 'shop';

export const LOT_STATUS_LABEL: Readonly<Record<LotStatus, string>> = {
  ordered: 'Đã đặt',
  cn_shipping: 'Ship nội địa TQ',
  at_forwarder: 'Tới trung gian',
  vn_shipping: 'Đang về VN',
  received: 'Đã nhận',
  cancelled: 'Huỷ',
};

export const ORDER_STATUS_LABEL: Readonly<Record<OrderStatus, string>> = {
  preorder: 'Đặt trước',
  confirmed: 'Đã chốt',
  shipped: 'Đã gửi',
  completed: 'Hoàn tất',
  cancelled: 'Huỷ',
};

export const UNIT_STATUS_LABEL: Readonly<Record<UnitStatus, string>> = {
  incoming: 'Đang về',
  in_stock: 'Trong kho',
  reserved: 'Đã giữ',
  sold: 'Đã bán',
  cancelled: 'Huỷ',
};

export const PAYMENT_KIND_LABEL: Readonly<Record<PaymentKind, string>> = {
  deposit: 'Cọc',
  payment: 'Thanh toán',
  refund: 'Hoàn tiền',
};

export const TRANSFER_KIND_LABEL: Readonly<Record<TransferKind, string>> = {
  transfer: 'Đã chuyển',
  adjustment: 'Điều chỉnh',
};

export const SHIP_PAYER_LABEL: Readonly<Record<ShipPayer, string>> = {
  customer: 'Khách trả',
  shop: 'Shop chịu',
};

/* ---------- Data objects (only the fields the domain core needs are required) ---------- */

/** DO_001 Model (A1): colour variants are gone; the model carries the code prefix, default price, threshold. */
export interface Model {
  id: string;
  name: string;
  /** Tiền tố mã chiếc, e.g. `ZP6` (D1). */
  codePrefix: string;
  /** Giá bán mặc định ₫ — prefilled as the list price of new units (A1). */
  defaultListPrice: Vnd | null;
  /** Ngưỡng sắp hết (A9). */
  lowStockThreshold: number;
  /** Next code number to assign (DB `models.next_seq`); used only to preview new codes. Default 1. */
  nextSeq?: number;
}

/** DO_004 Lô nhập. */
export interface Lot {
  id: string;
  code?: string;
  /** Ngày đặt — dates the lot's "Phải trả" in the intermediary ledger. */
  orderedAt?: IsoDate;
  /** Tỷ giá ₫ per ¥ (entered per lot, BR-03). */
  rate: number;
  /** Phí ship về VN of the whole lot, ₫. Null until known; required to receive (BR-02). */
  shipFee: Vnd | null;
  status: LotStatus;
  /** Ngày nhận (date or timestamp). Null until received. */
  receivedAt: IsoDate | null;
}

/** Unit — one physical grinder (replaces lot lines + variants, CR §3). */
export interface Unit {
  id: string;
  /** App-assigned code, e.g. `ZP6-001` (D1), unique per user, never reused. */
  code: string;
  modelId: string;
  lotId: string;
  /** Giá nhập ¥ of this unit. */
  priceCny: Cny;
  /** Giá nhập ₫ entered by hand; null = use the automatic cost (D2). */
  costOverride: Vnd | null;
  /** Giá bán dự kiến ₫ (D3). */
  listPrice: Vnd | null;
  serialNo?: string | null;
  note?: string | null;
}

/** DO_009 Dòng đơn — exactly one unit per line (A6). */
export interface OrderLine {
  unitId: string;
  /** Giá chốt ₫ of this unit (D3). */
  price: Vnd;
}

/** DO_010 Thu tiền khách. `amount` is always positive; `refund` is subtracted. */
export interface Payment {
  kind: PaymentKind;
  amount: Vnd;
  date?: IsoDate;
}

/** DO_008 Đơn bán. */
export interface Order {
  id: string;
  /** Display code, e.g. `D-005` (used in messages such as "Đã giữ cho D-005"). */
  code?: string;
  orderDate?: IsoDate;
  status: OrderStatus;
  /** Ngày gửi — profit is reported in the month of this date. */
  shippedAt?: IsoDate | null;
  /** Phí ship VN, ₫. */
  shipFee: Vnd;
  shipPayer: ShipPayer;
  lines: OrderLine[];
  payments: Payment[];
}

/**
 * DO_006 hand-entered intermediary transaction.
 *  - `transfer`: money sent to the intermediary, `amount` > 0, reduces the debt.
 *  - `adjustment`: signed; positive increases the debt, negative decreases it.
 */
export interface Transfer {
  id?: string;
  date?: IsoDate;
  kind: TransferKind;
  amount: Vnd;
  note?: string;
}

/* ---------- Results / rule errors ---------- */

export type RuleErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_TRANSITION'
  | 'SHIP_FEE_REQUIRED'
  | 'UNIT_UNAVAILABLE'
  | 'NOT_RECEIVED'
  | 'LOT_LOCKED'
  | 'OUTSTANDING_DUE';

export interface RuleError {
  code: RuleErrorCode;
  /** Rule ID from the approved spec or the CR, e.g. 'BR-02', 'A6'. */
  rule: string;
  /** Vietnamese, user-facing. */
  message: string;
  field?: string;
  lotId?: string;
  orderId?: string;
  unitId?: string;
  /** The other order involved in a conflict (unit already held / sold). */
  conflictOrderId?: string;
  /** Amount involved (e.g. the outstanding due for OUTSTANDING_DUE). */
  amount?: Vnd;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: RuleError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = <T = never>(error: RuleError): Result<T> => ({ ok: false, error });
