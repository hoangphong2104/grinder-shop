// Kiểu dòng dữ liệu đọc từ Supabase - khớp supabase/v2/001_schema_v2.sql + 002_buying_fee.sql + 003_cod_return_condition.sql
// (bảng + view). CR-003: cột phí mua hộ chỉ có sau khi chạy 002 ⇒ đọc qua `?? 0` (DB chưa nâng cấp vẫn chạy, coi như 0%).
// CR-004 (003): COD, Hoàn hàng ('returned'), tình trạng chiếc, ngưỡng tuổi tồn - cột mới ở CUỐI bảng / view.
//   Áp 003 TRƯỚC khi chạy bản app dùng các cột này (CI tự áp theo supabase/v2/deploy-order.txt).
export type LotStatusDb = 'ordered' | 'cn_shipping' | 'at_forwarder' | 'vn_shipping' | 'received' | 'cancelled'
/** CR-004: 'returned' = Hoàn hàng (chỉ từ 'shipped', RPC return_order) - dòng đơn được nhả, chiếc về kho. */
export type OrderStatusDb = 'preorder' | 'confirmed' | 'shipped' | 'completed' | 'cancelled' | 'returned'
export type PaymentKindDb = 'deposit' | 'payment' | 'refund'
/** CR-004 hình thức thu: chuyển khoản (mặc định) / tiền mặt / COD (chỉ cho kind 'payment' - check DB). */
export type PaymentMethodDb = 'transfer' | 'cash' | 'cod'
/** CR-004 tình trạng chiếc: Mới (mặc định) / Như mới / Đã dùng / Có lỗi. */
export type UnitConditionDb = 'new' | 'like_new' | 'used' | 'defect'
/** CR-004 v_units.aging_level: ok ≤ aging_warn_days < warn ≤ aging_alert_days < alert. */
export type AgingLevelDb = 'ok' | 'warn' | 'alert'
export type TxnKindDb = 'payable' | 'transfer' | 'adjustment'
export type ShipPayerDb = 'customer' | 'shop'

interface Row { id: string; user_id: string; created_at: string; updated_at: string; version: number }
export interface ModelRow extends Row { name: string; brand: string; image_path: string | null; aliases: string[]; code_prefix: string; default_list_price_vnd: number | null; low_stock_threshold: number; next_seq: number; is_active: boolean; sort_order: number }
export interface SellerRow extends Row { nickname: string; region: string | null; profile_url: string | null; reputation_note: string | null; is_avoided: boolean; is_hidden: boolean }
export interface LotRow extends Row { goofish_url: string | null; goofish_item_id: string | null; seller_id: string | null; screenshot_path: string | null; listing_title: string | null; ordered_at: string; exchange_rate: number; ship_fee_vnd: number | null; status: LotStatusDb; received_at: string | null; cancelled_at: string | null; note: string | null; /** CR-003 phí mua hộ % (0..100) */ buying_fee_pct: number }
export interface UnitRow extends Row { code: string; model_id: string; lot_id: string; price_cny: number; cost_vnd_auto: number; cost_vnd_override: number | null; list_price_vnd: number | null; serial_no: string | null; note: string | null; /** CR-004 (sửa qua update_unit / receive_lot p_units) */ condition: UnitConditionDb }
export interface TxnRow extends Row { txn_date: string; kind: TxnKindDb; amount_vnd: number; lot_id: string | null; note: string | null }
export interface CustomerRow extends Row { fb_name: string; fb_url: string | null; phone: string | null; address: string | null; note: string | null; is_hidden: boolean }
export interface OrderRow extends Row { customer_id: string; order_date: string; status: OrderStatusDb; tracking_no: string | null; ship_fee_vnd: number; ship_fee_payer: ShipPayerDb; shipped_at: string | null; completed_at: string | null; completion_forced: boolean; cancelled_at: string | null; note: string | null
  /** CR-004 COD hãng ship thu hộ (ship_order p_cod_amount_vnd / set_order_cod) */ cod_amount_vnd: number
  /** CR-004 Hoàn hàng (return_order) */ returned_at: string | null; return_ship_fee_vnd: number; keep_deposit: boolean; return_note: string | null }
/** cancelled = dòng đã nhả chiếc (đơn huỷ hoặc Hoàn hàng). */
export interface OrderLineRow extends Row { order_id: string; line_no: number; unit_id: string; unit_price_vnd: number; cancelled: boolean }
export interface PaymentRow extends Row { order_id: string; paid_at: string; kind: PaymentKindDb; amount_vnd: number; note: string | null; /** CR-004, ghi trực tiếp được */ method: PaymentMethodDb }
export interface NoteRow { id: string; user_id: string; body: string; is_pinned: boolean; created_at: string; updated_at: string; version: number }
export interface SettingsRow { user_id: string; ai_scan_enabled: boolean; ai_scan_monthly_cap: number; ai_confidence_threshold: number; default_ship_fee_payer: ShipPayerDb; /** CR-003 phí mua hộ mặc định % cho lô mới */ default_buying_fee_pct: number
  /** CR-004 ngưỡng tuổi tồn (cam > warn, đỏ > alert; warn < alert) + lô về trễ (ngày) - client sửa trực tiếp */
  aging_warn_days: number; aging_alert_days: number; lot_late_days: number
  updated_at: string; version: number ; /** CR-004 DON-S2: STK / ngân hàng cho tin xác nhận đơn */ bank_info: string | null }

export type UnitStatusDb = 'incoming' | 'in_stock' | 'reserved' | 'sold' | 'cancelled'
/** v_units - 1 dòng / chiếc (CR-001 A5). */
export interface UnitViewRow { unit_id: string; code: string; serial_no: string | null; note: string | null; model_id: string; model_name: string; code_prefix: string; lot_id: string; lot_status: LotStatusDb; ordered_at: string; received_at: string | null; exchange_rate: number; lot_ship_fee_vnd: number | null; goofish_item_id: string | null; seller_id: string | null; price_cny: number; cost_vnd_auto: number; cost_vnd_override: number | null; cost_vnd: number; cost_is_overridden: boolean; cost_is_provisional: boolean; list_price_vnd: number | null; is_received: boolean; status: UnitStatusDb; holding_order_line_id: string | null; holding_order_id: string | null; holding_order_status: OrderStatusDb | null; holding_customer_id: string | null; holding_customer_name: string | null; order_unit_price_vnd: number | null; sold_price_vnd: number | null; sold_at: string | null; expected_profit_vnd: number | null; actual_profit_vnd: number | null; days_in_stock: number | null; created_at: string; updated_at: string; version: number
  /** CR-004 */ condition: UnitConditionDb
  /** CR-004: chỉ chiếc đã về kho chưa bán (in_stock / reserved đã về); khác ⇒ null */ aging_level: AgingLevelDb | null }
/** v_model_stock - đếm theo model (A9). */
export interface ModelStockRow { model_id: string; model_name: string; brand: string; code_prefix: string; is_active: boolean; sort_order: number; default_list_price_vnd: number | null; low_stock_threshold: number; in_stock_count: number; incoming_count: number; reserved_count: number; reserved_received_count: number; on_hand_count: number; sold_count: number; sellable_count: number; stock_value_vnd: number; is_low_stock: boolean }
export interface LotSummaryRow { lot_id: string; status: LotStatusDb; ordered_at: string; received_at: string | null; exchange_rate: number; ship_fee_vnd: number | null; seller_id: string | null; seller_nickname: string | null; goofish_url: string | null; goofish_item_id: string | null; listing_title: string | null; screenshot_path: string | null; note: string | null; version: number; total_qty: number; total_cny: number; goods_vnd: number; ship_per_unit_vnd: number | null; payable_vnd: number; cost_is_provisional: boolean; total_cost_vnd: number; incoming_count: number; in_stock_count: number; reserved_count: number; sold_count: number; models: { model_id: string; model_name: string; qty: number }[]; /** CR-003 */ buying_fee_pct: number; /** CR-003 = round(Σ¥ × tỷ giá × %/100); goods_vnd chưa gồm phí */ buying_fee_vnd: number
  /** CR-004: lô chưa nhận / chưa huỷ, đặt quá settings.lot_late_days ngày */ is_lot_late: boolean }
export interface OrderSummaryRow { order_id: string; customer_id: string; customer_name: string; status: OrderStatusDb; order_date: string; shipped_at: string | null; completed_at: string | null; completion_forced: boolean; cancelled_at: string | null; tracking_no: string | null; ship_fee_vnd: number; ship_fee_payer: ShipPayerDb; note: string | null; version: number; unit_count: number; unit_codes: string[]; all_units_received: boolean; goods_vnd: number; cost_vnd: number; ship_charged_vnd: number; paid_vnd: number
  /** đơn huỷ / Hoàn hàng ⇒ 0; âm = khách trả dư */ receivable_vnd: number
  /** huỷ: max(đã thu, 0); Hoàn hàng: max(đã thu − (keep_deposit ? Σ cọc : 0), 0) */ refund_due_vnd: number
  /** Đã gửi / Hoàn tất: Σ(giá chốt − giá nhập) − ship shop; Hoàn hàng: kept_vnd − ship shop − ship về; khác null */ profit_vnd: number | null
  /** CR-004 COD */ cod_amount_vnd: number; cod_received_vnd: number
  /** = max(min(cod_amount − cod_received, receivable), 0) cho Đã gửi / Hoàn tất / Hoàn hàng; khác 0 */ cod_pending_vnd: number
  /** Σ khoản cọc */ deposit_vnd: number
  /** CR-004 Hoàn hàng */ returned_at: string | null; return_ship_fee_vnd: number; keep_deposit: boolean; return_note: string | null
  /** tiền shop giữ của đơn Hoàn hàng (null đơn khác) */ kept_vnd: number | null
  /** ngày tính lãi: shipped_at (Đã gửi / Hoàn tất), returned_at (Hoàn hàng), null khác */ profit_date: string | null }
export interface BalanceRow { total_payable_vnd: number; total_transferred_vnd: number; total_adjustment_vnd: number; balance_vnd: number }
export interface SuggestionsRow { last_exchange_rate: number | null; last_ship_fee_per_unit_vnd: number | null; /** CR-003 phí % lô gần nhất (tham khảo) */ last_buying_fee_pct?: number | null }

export interface DbData {
  models: ModelRow[]; units: UnitRow[]; sellers: SellerRow[]; lots: LotRow[]
  txns: TxnRow[]; customers: CustomerRow[]; orders: OrderRow[]; orderLines: OrderLineRow[]; payments: PaymentRow[]
  settings: SettingsRow | null; notes: NoteRow[]; unitView: UnitViewRow[]; modelStock: ModelStockRow[]; lotSummary: LotSummaryRow[]; orderSummary: OrderSummaryRow[]
  balance: BalanceRow; suggestions: SuggestionsRow
  /** Mã hiển thị L-001 / D-001 theo thứ tự tạo (DB không có cột mã). */
  lotCode: Record<string, string>; orderCode: Record<string, string>
}
