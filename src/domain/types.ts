/**
 * Kho Cối — domain types (approved/data-and-rules-v1.md).
 * Pure data shapes only: no I/O, no runtime dependencies.
 *
 * Money conventions:
 *  - `Vnd` amounts are whole đồng (integers) unless a field says otherwise.
 *  - `Cny` amounts are yuan (may have decimals, e.g. ¥1.010 or ¥99,5).
 *  - Dates are ISO strings `YYYY-MM-DD` (a full ISO timestamp also sorts correctly).
 */

export type Vnd = number;
export type Cny = number;
export type IsoDate = string;

/* ---------- Statuses (section 2) ---------- */

/** Lô nhập: dat → shipTQ → trungGian → veVN → daNhan; huy allowed before daNhan. */
export type LotStatus = 'dat' | 'shipTQ' | 'trungGian' | 'veVN' | 'daNhan' | 'huy';

/** Đơn bán: datTruoc / daChot → daGui → hoanTat; huy allowed before daGui. */
export type OrderStatus = 'datTruoc' | 'daChot' | 'daGui' | 'hoanTat' | 'huy';

/** Thu tiền khách: cọc / thanh toán / hoàn tiền (refund counts negative). */
export type PaymentKind = 'coc' | 'tt' | 'hoan';

/** Giao dịch trung gian entered by hand. `phaiTra` entries are generated from lots (BR-12). */
export type TransferKind = 'chuyen' | 'dieuChinh';

/** Who bears the domestic (VN) shipping fee of an order (Q-002). */
export type ShipPayer = 'khach' | 'shop';

export const LOT_STATUS_LABEL: Readonly<Record<LotStatus, string>> = {
  dat: 'Đã đặt',
  shipTQ: 'Ship nội địa TQ',
  trungGian: 'Tới trung gian',
  veVN: 'Đang về VN',
  daNhan: 'Đã nhận',
  huy: 'Huỷ',
};

export const ORDER_STATUS_LABEL: Readonly<Record<OrderStatus, string>> = {
  datTruoc: 'Đặt trước',
  daChot: 'Đã chốt',
  daGui: 'Đã gửi',
  hoanTat: 'Hoàn tất',
  huy: 'Huỷ',
};

/* ---------- Data objects ---------- */

/** DO_002 Biến thể (only the fields the domain core needs are required). */
export interface Variant {
  id: string;
  modelId?: string;
  name?: string;
  listPrice?: Vnd;
  lowStockAt?: number;
  active?: boolean;
}

/** DO_005 Dòng lô. Unit cost ₫ is computed (BR-01), never stored here. */
export interface LotLine {
  variantId: string;
  qty: number;
  /** Giá web ¥ / chiếc. */
  cny: Cny;
}

/** DO_004 Lô nhập. */
export interface Lot {
  id: string;
  code?: string;
  orderedAt: IsoDate;
  /** Tỷ giá ₫ per ¥ (entered per lot, BR-03). */
  rate: number;
  /** Phí ship về VN of the whole lot, ₫. Null until known; required to receive (BR-02). */
  shipFee: Vnd | null;
  status: LotStatus;
  receivedAt: IsoDate | null;
  lines: LotLine[];
}

/** DO_009 Dòng đơn. */
export interface OrderLine {
  variantId: string;
  qty: number;
  /** Giá chốt ₫ / chiếc. */
  price: Vnd;
  /** Giá vốn ₫ / chiếc snapshotted when the order is shipped (BR-05). Null/absent before. */
  cost?: Vnd | null;
}

/** DO_010 Thu tiền khách. `amount` is always positive; `hoan` is subtracted. */
export interface Payment {
  date: IsoDate;
  amount: Vnd;
  kind: PaymentKind;
}

/** DO_008 Đơn bán. */
export interface Order {
  id: string;
  code?: string;
  customerId?: string;
  date: IsoDate;
  status: OrderStatus;
  sentAt: IsoDate | null;
  /** Phí ship VN, ₫. */
  shipFee: Vnd;
  shipPayer: ShipPayer;
  lines: OrderLine[];
  payments: Payment[];
}

/**
 * DO_006 Giao dịch trung gian entered by hand.
 *  - `chuyen`: money sent to the intermediary, `amount` > 0, reduces the debt.
 *  - `dieuChinh`: signed adjustment; positive increases the debt, negative decreases it.
 */
export interface Transfer {
  id: string;
  date: IsoDate;
  kind: TransferKind;
  amount: Vnd;
  note?: string;
}

/* ---------- Derived stock (DO_012) ---------- */

/** Running stock of one variant, derived by replaying receipts and shipments. */
export interface VariantStock {
  /** Có sẵn. */
  onHand: number;
  /**
   * Giá vốn bình quân, ₫, kept UNROUNDED so repeated averaging does not drift.
   * Round with `roundVnd` for display; shipments snapshot the rounded value.
   */
  avgCost: number;
}

export type StockMap = Readonly<Record<string, VariantStock>>;

/** Full BR-06 figures for one variant. */
export interface Inventory extends VariantStock {
  /** Đang về. */
  incoming: number;
  /** Đã giữ. */
  reserved: number;
  /** Có thể bán = onHand + incoming − reserved. */
  sellable: number;
  /** onHand − reserved (stock on the shelf not yet promised; used by BR-07). */
  free: number;
}

/* ---------- Results / rule errors ---------- */

export type RuleErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_TRANSITION'
  | 'SHIP_FEE_REQUIRED'
  | 'INSUFFICIENT_STOCK'
  | 'EXCEEDS_SELLABLE'
  | 'OUTSTANDING_DUE';

export interface RuleError {
  code: RuleErrorCode;
  /** Business-rule ID from the approved spec, e.g. 'BR-02'. */
  rule: string;
  /** Vietnamese, user-facing. */
  message: string;
  field?: string;
  lotId?: string;
  orderId?: string;
  variantId?: string;
  requested?: number;
  available?: number;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: RuleError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });
export const fail = <T = never>(error: RuleError): Result<T> => ({ ok: false, error });
