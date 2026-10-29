// Nhãn + chip màu theo trạng thái (prototype v2.2: xanh lá = xong / còn hàng, cam = đang về / chờ, xanh dương = cần làm, đỏ = nợ / hết / lỗi).
import type { AgingLevelDb, CashKindDb, LotStatusDb, ModelStockRow, OrderStatusDb, PaymentMethodDb, UnitConditionDb, UnitStatusDb } from '../data/types.ts'

// CR-005: Kho TQ → Kho VN → Kho Lumi (= đã về kho shop, bán được). Nhận hàng (→ Kho Lumi) = RPC receive_lot.
export const LOT_FLOW: LotStatusDb[] = ['cn_warehouse', 'vn_warehouse', 'received']
export const LOT_LABEL: Record<LotStatusDb, string> = { cn_warehouse: 'Kho TQ', vn_warehouse: 'Kho VN', received: 'Kho Lumi', cancelled: 'Huỷ' }
const LOT_TONE: Record<LotStatusDb, string> = { cn_warehouse: 'way', vn_warehouse: 'way', received: 'ok', cancelled: 'neu' }
// CR-004: 'returned' = Hoàn hàng (khách bom / chuyển hoàn) - chip đỏ. CR-005: shipped = "Vận chuyển tới khách", completed = "Đã giao" (mã giữ nguyên)
export const ORDER_LABEL: Record<OrderStatusDb, string> = { preorder: 'Đặt trước', confirmed: 'Đã chốt', shipped: 'Vận chuyển tới khách', completed: 'Đã giao', cancelled: 'Huỷ', returned: 'Hoàn hàng' }
const ORDER_TONE: Record<OrderStatusDb, string> = { preorder: 'way', confirmed: 'hold', shipped: 'neu', completed: 'ok', cancelled: 'neu', returned: 'bad' }

export const LotChip = ({ s }: { s: LotStatusDb }) => <span className={`pill ${LOT_TONE[s]}`}>{LOT_LABEL[s]}</span>
export const OrderChip = ({ s }: { s: OrderStatusDb }) => <span className={`pill ${ORDER_TONE[s]}`}>{ORDER_LABEL[s]}</span>
// CR-001 A5: trạng thái từng chiếc. CR-005: in_stock = "Kho Lumi"; incoming tách theo lô ("Kho TQ" / "Kho VN") và sold theo
// trạng thái đơn ("Vận chuyển tới khách" / "Đã giao") qua unitLabel(s, lotStatus, orderStatus).
export const UNIT_LABEL: Record<UnitStatusDb, string> = { incoming: 'Đang về', in_stock: 'Kho Lumi', reserved: 'Khách đặt', sold: 'Đã bán', cancelled: 'Huỷ' }
const UNIT_TONE: Record<UnitStatusDb, string> = { incoming: 'way', in_stock: 'ok', reserved: 'hold', sold: 'neu', cancelled: 'neu' }
/** Nhãn chiếc theo vị trí: Đang về ⇒ Kho TQ / Kho VN (theo lô); Đã bán ⇒ nhãn trạng thái đơn đang giữ; còn lại UNIT_LABEL. */
export function unitLabel(s: UnitStatusDb, lot?: LotStatusDb | null, order?: OrderStatusDb | null): string {
  if (s === 'incoming' && (lot === 'cn_warehouse' || lot === 'vn_warehouse')) return LOT_LABEL[lot]
  if (s === 'sold' && order) return ORDER_LABEL[order]
  return UNIT_LABEL[s]
}
/** holder = mã đơn đang giữ (vd. D-005) → "Đã giữ cho D-005"; lot / order (tuỳ chọn, CR-005) = v_units.lot_status / holding_order_status. */
export const UnitChip = ({ s, holder, lot, order }: { s: UnitStatusDb; holder?: string; lot?: LotStatusDb | null; order?: OrderStatusDb | null }) =>
  <span className={`pill ${UNIT_TONE[s]}`}>{s === 'reserved' && holder ? `Khách đặt, ${holder}` : s === 'sold' && holder ? `${order ? ORDER_LABEL[order] : 'Đã bán'}, ${holder}` : unitLabel(s, lot, order)}</span>
/** Chip tồn theo model (A9). */
export function ModelStockChip({ m }: { m: ModelStockRow }) {
  if (m.sellable_count <= 0) return <span className="pill bad">Hết hàng</span>
  if (m.in_stock_count <= 0 && m.incoming_count > 0) return <span className="pill way">Chờ hàng về</span>
  if (m.is_low_stock) return <span className="pill hold">Sắp hết</span>
  return <span className="pill ok">Còn {m.sellable_count} bán được</span>
}

// CR-004 KHO-S3: tình trạng từng chiếc (mặc định Mới)
export const CONDITION_LABEL: Record<UnitConditionDb, string> = { new: 'Mới', like_new: 'Như mới', used: 'Đã dùng', defect: 'Có lỗi' }
export const CONDITION_ORDER: UnitConditionDb[] = ['new', 'like_new', 'used', 'defect']
const CONDITION_TONE: Record<UnitConditionDb, string> = { new: 'ok', like_new: 'ok', used: 'neu', defect: 'bad' }
/** Chip tình trạng; `hideNew` = không hiện gì khi Mới (dòng danh sách gọn). */
export const ConditionChip = ({ c, hideNew }: { c: UnitConditionDb; hideNew?: boolean }) =>
  hideNew && c === 'new' ? null : <span className={`pill ${CONDITION_TONE[c]}`}>{CONDITION_LABEL[c]}</span>
// CR-004 DON-S1: hình thức thu
export const PAY_METHOD_LABEL: Record<PaymentMethodDb, string> = { transfer: 'Chuyển khoản', cash: 'Tiền mặt', cod: 'COD' }
// CR-004 KHO-S1: màu tuổi tồn (v_units.aging_level) - dùng làm class chữ / chip
export const AGING_TONE: Record<AgingLevelDb, string> = { ok: 'neu', warn: 'way', alert: 'bad' }
// CR-005 sổ quỹ: nhãn loại bút toán (5 loại đầu + local_ship tự sinh - chỉ đọc, sửa ở nguồn; 4 loại sau ghi tay)
export const CASH_KIND_LABEL: Record<CashKindDb, string> = {
  customer_payment: 'Thu khách', customer_refund: 'Hoàn tiền khách', intermediary: 'Trả trung gian', ship_shop: 'Ship cho khách (shop chịu)',
  return_ship: 'Ship chiều về', expense: 'Chi phí khác', capital_in: 'Nạp vốn', capital_out: 'Rút vốn', adjustment: 'Điều chỉnh',
  local_ship: 'Ship kho VN → Lumi', // CR-009 tự sinh từ cối
}
export const CASH_MANUAL_KINDS: CashKindDb[] = ['expense', 'capital_in', 'capital_out', 'adjustment']
