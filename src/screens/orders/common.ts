// Tra cứu + tính phụ dùng chung cho nhóm màn Đơn bán / Khách.
// Số tiền chính thức lấy từ view v_order_summary; ở đây chỉ ghép tên và ƯỚC lãi đơn chưa gửi (BQ hiện tại).
import { useEffect, useState } from 'react'
import type { CustomerRow, DbData, OrderLineRow, OrderRow, OrderStatusDb, OrderSummaryRow, PaymentKindDb, VariantRow, VariantStockRow } from '../../data/types.ts'

/** true khi màn hình ≥ 960px (bảng trên máy tính, thẻ trên điện thoại). */
export function useIsDesk(): boolean {
  const q = '(min-width: 960px)'
  const [desk, setDesk] = useState(() => matchMedia(q).matches)
  useEffect(() => {
    const m = matchMedia(q)
    const on = () => setDesk(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return desk
}

export const PAY_LABEL: Record<PaymentKindDb, string> = { payment: 'Thanh toán', deposit: 'Cọc', refund: 'Hoàn tiền' }
export const OPEN_STATUSES: OrderStatusDb[] = ['preorder', 'confirmed', 'shipped']
export const isSentStatus = (s: OrderStatusDb) => s === 'shipped' || s === 'completed'

export interface Lookup {
  order: (id: string) => OrderRow | undefined
  sum: (orderId: string) => OrderSummaryRow | undefined
  lines: (orderId: string) => OrderLineRow[]
  cust: (id: string) => CustomerRow | undefined
  variant: (id: string) => VariantRow | undefined
  stock: (variantId: string) => VariantStockRow | undefined
  /** "K Ultra · Đen" */
  vName: (variantId: string) => string
  /** "1 × K Ultra · Đen, 2 × …" */
  linesText: (orderId: string) => string
  /** Khách phải trả = tiền hàng + ship khách trả (thu hộ — Q-015). */
  total: (s: OrderSummaryRow) => number
  /** Lãi: đơn đã gửi = số DB (giá vốn đã chốt); chưa gửi = ước theo BQ hiện tại; Huỷ = null. */
  profit: (orderId: string) => { value: number | null; est: boolean }
}

export function makeLookup(d: DbData): Lookup {
  const by = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]))
  const orders = by(d.orders), customers = by(d.customers), variants = by(d.variants), models = by(d.models)
  const sums = new Map(d.orderSummary.map((s) => [s.order_id, s]))
  const stock = new Map(d.stock.map((s) => [s.variant_id, s]))
  const linesBy = new Map<string, OrderLineRow[]>()
  for (const l of d.orderLines) {
    const a = linesBy.get(l.order_id)
    if (a) a.push(l); else linesBy.set(l.order_id, [l])
  }
  const vName = (vid: string) => {
    const v = variants.get(vid)
    if (!v) return '?'
    return `${models.get(v.model_id)?.name ?? '?'} · ${v.name}`
  }
  const lines = (oid: string) => linesBy.get(oid) ?? []
  return {
    order: (id) => orders.get(id),
    sum: (id) => sums.get(id),
    lines,
    cust: (id) => customers.get(id),
    variant: (id) => variants.get(id),
    stock: (id) => stock.get(id),
    vName,
    linesText: (oid) => lines(oid).map((x) => `${x.qty} × ${vName(x.variant_id)}`).join(', '),
    total: (s) => s.goods_vnd + s.ship_charged_vnd,
    profit: (oid) => {
      const s = sums.get(oid)
      if (!s || s.status === 'cancelled') return { value: null, est: false }
      if (s.profit_vnd != null) return { value: s.profit_vnd, est: false }
      const margin = lines(oid).reduce((a, x) => a + x.qty * (x.unit_price_vnd - (x.unit_cost_vnd ?? stock.get(x.variant_id)?.avg_cost_vnd ?? 0)), 0)
      return { value: margin - (s.ship_fee_payer === 'shop' ? s.ship_fee_vnd : 0), est: true }
    },
  }
}

/** Sắp đơn mới nhất trước (ngày đơn, rồi thứ tự tạo). */
export function sortOrders(d: DbData, rows: OrderSummaryRow[]): OrderSummaryRow[] {
  const idx = new Map(d.orders.map((o, i) => [o.id, i]))
  return [...rows].sort((a, b) => b.order_date.localeCompare(a.order_date) || (idx.get(b.order_id) ?? 0) - (idx.get(a.order_id) ?? 0))
}

/** Ghi trực tiếp 1 dòng có cột version: chỉ cập nhật nếu version chưa đổi (bắt sửa đồng thời 2 máy). */
export const VERSION_CONFLICT_MSG = 'Dữ liệu vừa được sửa trên máy khác. App đã tải lại — thử lại thao tác.'
