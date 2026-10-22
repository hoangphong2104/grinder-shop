// Kiểu dòng dữ liệu đọc từ Supabase — khớp supabase/migrations/001_init.sql (bảng + view).
export type LotStatusDb = 'ordered' | 'cn_shipping' | 'at_forwarder' | 'vn_shipping' | 'received' | 'cancelled'
export type OrderStatusDb = 'preorder' | 'confirmed' | 'shipped' | 'completed' | 'cancelled'
export type PaymentKindDb = 'deposit' | 'payment' | 'refund'
export type TxnKindDb = 'payable' | 'transfer' | 'adjustment'
export type ShipPayerDb = 'customer' | 'shop'

interface Row { id: string; user_id: string; created_at: string; updated_at: string; version: number }
export interface ModelRow extends Row { name: string; brand: string; image_path: string | null; aliases: string[]; is_active: boolean; sort_order: number }
export interface VariantRow extends Row { model_id: string; name: string; list_price_vnd: number | null; low_stock_threshold: number; is_active: boolean; on_hand_qty: number; avg_cost_vnd: number }
export interface SellerRow extends Row { nickname: string; region: string | null; profile_url: string | null; reputation_note: string | null; is_avoided: boolean; is_hidden: boolean }
export interface LotRow extends Row { goofish_url: string | null; goofish_item_id: string | null; seller_id: string | null; screenshot_path: string | null; listing_title: string | null; ordered_at: string; exchange_rate: number; ship_fee_vnd: number | null; status: LotStatusDb; received_at: string | null; cancelled_at: string | null; note: string | null }
export interface LotLineRow extends Row { lot_id: string; line_no: number; variant_id: string; qty: number; price_cny: number; unit_cost_vnd: number }
export interface TxnRow extends Row { txn_date: string; kind: TxnKindDb; amount_vnd: number; lot_id: string | null; note: string | null }
export interface CustomerRow extends Row { fb_name: string; fb_url: string | null; phone: string | null; address: string | null; note: string | null; is_hidden: boolean }
export interface OrderRow extends Row { customer_id: string; order_date: string; status: OrderStatusDb; tracking_no: string | null; ship_fee_vnd: number; ship_fee_payer: ShipPayerDb; shipped_at: string | null; completed_at: string | null; completion_forced: boolean; cancelled_at: string | null; note: string | null }
export interface OrderLineRow extends Row { order_id: string; line_no: number; variant_id: string; qty: number; unit_price_vnd: number; unit_cost_vnd: number | null }
export interface PaymentRow extends Row { order_id: string; paid_at: string; kind: PaymentKindDb; amount_vnd: number; note: string | null }
export interface SettingsRow { user_id: string; ai_scan_enabled: boolean; ai_scan_monthly_cap: number; ai_confidence_threshold: number; default_ship_fee_payer: ShipPayerDb; updated_at: string; version: number }

export interface VariantStockRow { variant_id: string; model_id: string; model_name: string; variant_name: string; is_active: boolean; on_hand: number; incoming: number; reserved: number; sellable: number; free_on_hand: number; avg_cost_vnd: number; stock_value_vnd: number; list_price_vnd: number | null; low_stock_threshold: number; is_low_stock: boolean }
export interface LotSummaryRow { lot_id: string; status: LotStatusDb; ordered_at: string; received_at: string | null; exchange_rate: number; ship_fee_vnd: number | null; seller_id: string | null; seller_nickname: string | null; goofish_item_id: string | null; listing_title: string | null; total_qty: number; total_cny: number; goods_vnd: number; payable_vnd: number; cost_is_provisional: boolean }
export interface OrderSummaryRow { order_id: string; customer_id: string; customer_name: string; status: OrderStatusDb; order_date: string; shipped_at: string | null; completed_at: string | null; ship_fee_vnd: number; ship_fee_payer: ShipPayerDb; goods_vnd: number; ship_charged_vnd: number; paid_vnd: number; receivable_vnd: number; refund_due_vnd: number; profit_vnd: number | null }
export interface BalanceRow { total_payable_vnd: number; total_transferred_vnd: number; total_adjustment_vnd: number; balance_vnd: number }
export interface SuggestionsRow { last_exchange_rate: number | null; last_ship_fee_per_unit_vnd: number | null }

export interface DbData {
  models: ModelRow[]; variants: VariantRow[]; sellers: SellerRow[]; lots: LotRow[]; lotLines: LotLineRow[]
  txns: TxnRow[]; customers: CustomerRow[]; orders: OrderRow[]; orderLines: OrderLineRow[]; payments: PaymentRow[]
  settings: SettingsRow | null; stock: VariantStockRow[]; lotSummary: LotSummaryRow[]; orderSummary: OrderSummaryRow[]
  balance: BalanceRow; suggestions: SuggestionsRow
  /** Mã hiển thị L-001 / D-001 theo thứ tự tạo (DB không có cột mã). */
  lotCode: Record<string, string>; orderCode: Record<string, string>
}
