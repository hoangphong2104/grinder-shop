// Nhãn + chip màu theo trạng thái (prototype v2.2: xanh lá = xong / còn hàng, cam = đang về / chờ, xanh dương = cần làm, đỏ = nợ / hết / lỗi).
import type { AgingLevelDb, LotStatusDb, ModelStockRow, OrderStatusDb, PaymentMethodDb, UnitConditionDb, UnitStatusDb } from '../data/types.ts'

export const LOT_FLOW: LotStatusDb[] = ['ordered', 'cn_shipping', 'at_forwarder', 'vn_shipping', 'received']
export const LOT_LABEL: Record<LotStatusDb, string> = {
  ordered: 'Đã đặt', cn_shipping: 'Ship nội địa TQ', at_forwarder: 'Tới trung gian', vn_shipping: 'Đang về VN', received: 'Đã nhận', cancelled: 'Huỷ',
}
const LOT_TONE: Record<LotStatusDb, string> = { ordered: 'neu', cn_shipping: 'way', at_forwarder: 'way', vn_shipping: 'way', received: 'ok', cancelled: 'neu' }
// CR-004: 'returned' = Hoàn hàng (khách bom / chuyển hoàn) — chip đỏ
export const ORDER_LABEL: Record<OrderStatusDb, string> = { preorder: 'Đặt trước', confirmed: 'Đã chốt', shipped: 'Đã gửi', completed: 'Hoàn tất', cancelled: 'Huỷ', returned: 'Hoàn hàng' }
const ORDER_TONE: Record<OrderStatusDb, string> = { preorder: 'way', confirmed: 'hold', shipped: 'neu', completed: 'ok', cancelled: 'neu', returned: 'bad' }

export const LotChip = ({ s }: { s: LotStatusDb }) => <span className={`pill ${LOT_TONE[s]}`}>{LOT_LABEL[s]}</span>
export const OrderChip = ({ s }: { s: OrderStatusDb }) => <span className={`pill ${ORDER_TONE[s]}`}>{ORDER_LABEL[s]}</span>
// CR-001 A5: trạng thái từng chiếc
export const UNIT_LABEL: Record<UnitStatusDb, string> = { incoming: 'Đang về', in_stock: 'Trong kho', reserved: 'Đã giữ', sold: 'Đã bán', cancelled: 'Huỷ' }
const UNIT_TONE: Record<UnitStatusDb, string> = { incoming: 'way', in_stock: 'ok', reserved: 'hold', sold: 'neu', cancelled: 'neu' }
/** holder = mã đơn đang giữ (vd. D-005) → "Đã giữ cho D-005". */
export const UnitChip = ({ s, holder }: { s: UnitStatusDb; holder?: string }) =>
  <span className={`pill ${UNIT_TONE[s]}`}>{s === 'reserved' && holder ? `Đã giữ cho ${holder}` : s === 'sold' && holder ? `Đã bán · ${holder}` : UNIT_LABEL[s]}</span>
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
// CR-004 KHO-S1: màu tuổi tồn (v_units.aging_level) — dùng làm class chữ / chip
export const AGING_TONE: Record<AgingLevelDb, string> = { ok: 'neu', warn: 'way', alert: 'bad' }
