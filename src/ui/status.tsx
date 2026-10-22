// Nhãn + chip màu theo trạng thái (prototype v2.2: xanh lá = xong / còn hàng, cam = đang về / chờ, xanh dương = cần làm, đỏ = nợ / hết / lỗi).
import type { LotStatusDb, OrderStatusDb, VariantStockRow } from '../data/types.ts'

export const LOT_FLOW: LotStatusDb[] = ['ordered', 'cn_shipping', 'at_forwarder', 'vn_shipping', 'received']
export const LOT_LABEL: Record<LotStatusDb, string> = {
  ordered: 'Đã đặt', cn_shipping: 'Ship nội địa TQ', at_forwarder: 'Tới trung gian', vn_shipping: 'Đang về VN', received: 'Đã nhận', cancelled: 'Huỷ',
}
const LOT_TONE: Record<LotStatusDb, string> = { ordered: 'neu', cn_shipping: 'way', at_forwarder: 'way', vn_shipping: 'way', received: 'ok', cancelled: 'neu' }
export const ORDER_LABEL: Record<OrderStatusDb, string> = { preorder: 'Đặt trước', confirmed: 'Đã chốt', shipped: 'Đã gửi', completed: 'Hoàn tất', cancelled: 'Huỷ' }
const ORDER_TONE: Record<OrderStatusDb, string> = { preorder: 'way', confirmed: 'hold', shipped: 'neu', completed: 'ok', cancelled: 'neu' }

export const LotChip = ({ s }: { s: LotStatusDb }) => <span className={`pill ${LOT_TONE[s]}`}>{LOT_LABEL[s]}</span>
export const OrderChip = ({ s }: { s: OrderStatusDb }) => <span className={`pill ${ORDER_TONE[s]}`}>{ORDER_LABEL[s]}</span>
export function StockChip({ v, waitingLot }: { v: VariantStockRow; waitingLot?: string }) {
  if (v.sellable <= 0) return <span className="pill bad">Hết hàng</span>
  if (v.free_on_hand <= 0 && v.incoming > 0) return <span className="pill way">Chờ {waitingLot ?? 'lô'}</span>
  if (v.is_low_stock) return <span className="pill hold">Sắp hết</span>
  return <span className="pill ok">Còn {v.sellable} bán được</span>
}
