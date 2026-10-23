// Nhãn + chip màu theo trạng thái (prototype v2.2: xanh lá = xong / còn hàng, cam = đang về / chờ, xanh dương = cần làm, đỏ = nợ / hết / lỗi).
import type { LotStatusDb, ModelStockRow, OrderStatusDb, UnitStatusDb } from '../data/types.ts'

export const LOT_FLOW: LotStatusDb[] = ['ordered', 'cn_shipping', 'at_forwarder', 'vn_shipping', 'received']
export const LOT_LABEL: Record<LotStatusDb, string> = {
  ordered: 'Đã đặt', cn_shipping: 'Ship nội địa TQ', at_forwarder: 'Tới trung gian', vn_shipping: 'Đang về VN', received: 'Đã nhận', cancelled: 'Huỷ',
}
const LOT_TONE: Record<LotStatusDb, string> = { ordered: 'neu', cn_shipping: 'way', at_forwarder: 'way', vn_shipping: 'way', received: 'ok', cancelled: 'neu' }
export const ORDER_LABEL: Record<OrderStatusDb, string> = { preorder: 'Đặt trước', confirmed: 'Đã chốt', shipped: 'Đã gửi', completed: 'Hoàn tất', cancelled: 'Huỷ' }
const ORDER_TONE: Record<OrderStatusDb, string> = { preorder: 'way', confirmed: 'hold', shipped: 'neu', completed: 'ok', cancelled: 'neu' }

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
