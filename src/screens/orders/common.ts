// Tra cứu + tính phụ dùng chung cho nhóm màn Đơn bán / Khách (CR-001: đơn = danh sách chiếc cụ thể).
// Số tiền chính thức lấy từ view v_order_summary / v_units; ở đây chỉ ghép tên và ƯỚC lãi đơn chưa gửi.
import { useEffect, useState } from 'react'
import type { CustomerRow, DbData, OrderLineRow, OrderRow, OrderStatusDb, OrderSummaryRow, PaymentKindDb, UnitViewRow } from '../../data/types.ts'

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

/** Bỏ dấu + chữ thường để tìm kiếm ("Đen" ~ "den"). */
export const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase()

export interface Lookup {
  order: (id: string) => OrderRow | undefined
  sum: (orderId: string) => OrderSummaryRow | undefined
  /** Dòng đơn (mỗi dòng 1 chiếc) theo line_no. */
  lines: (orderId: string) => OrderLineRow[]
  cust: (id: string) => CustomerRow | undefined
  /** Chiếc cối (v_units) theo unit id. */
  unit: (unitId: string) => UnitViewRow | undefined
  /** "KU-007, JU-003" */
  unitsText: (s: OrderSummaryRow) => string
  /** Khách phải trả = tiền hàng + ship khách trả (thu hộ — Q-015). */
  total: (s: OrderSummaryRow) => number
  /** Lãi: đơn đã gửi = số DB; chưa gửi = ước theo giá nhập ₫ hiện tại (A8); Huỷ = null. */
  profit: (orderId: string) => { value: number | null; est: boolean }
}

export function makeLookup(d: DbData): Lookup {
  const by = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]))
  const orders = by(d.orders), customers = by(d.customers)
  const units = new Map(d.unitView.map((u) => [u.unit_id, u]))
  const sums = new Map(d.orderSummary.map((s) => [s.order_id, s]))
  const linesBy = new Map<string, OrderLineRow[]>()
  for (const l of d.orderLines) {
    const a = linesBy.get(l.order_id)
    if (a) a.push(l); else linesBy.set(l.order_id, [l])
  }
  return {
    order: (id) => orders.get(id),
    sum: (id) => sums.get(id),
    lines: (oid) => linesBy.get(oid) ?? [],
    cust: (id) => customers.get(id),
    unit: (id) => units.get(id),
    unitsText: (s) => (s.unit_codes?.length ? s.unit_codes.join(', ') : '—'),
    total: (s) => s.goods_vnd + s.ship_charged_vnd,
    profit: (oid) => {
      const s = sums.get(oid)
      if (!s || s.status === 'cancelled') return { value: null, est: false }
      if (s.profit_vnd != null) return { value: s.profit_vnd, est: false }
      // cost_vnd của view = Σ giá nhập ₫ hiệu lực hiện tại của các chiếc ⇒ cùng công thức với lãi khi đã gửi.
      return { value: s.goods_vnd - s.cost_vnd - (s.ship_fee_payer === 'shop' ? s.ship_fee_vnd : 0), est: true }
    },
  }
}

/**
 * A6 — chiếc chọn được cho đơn: Trong kho hoặc Đang về và chưa đơn nào giữ; khi sửa đơn,
 * các chiếc của chính đơn đó cũng chọn được. Trả về nơi chiếc đang ở, hoặc null nếu không chọn được.
 */
export function unitAvailability(u: UnitViewRow, editId: string | null): 'in_stock' | 'incoming' | null {
  if (u.lot_status === 'cancelled') return null
  if (u.holding_order_id && u.holding_order_id !== editId) return null
  return u.is_received ? 'in_stock' : 'incoming'
}

/** Sắp đơn mới nhất trước (ngày đơn, rồi thứ tự tạo). */
export function sortOrders(d: DbData, rows: OrderSummaryRow[]): OrderSummaryRow[] {
  const idx = new Map(d.orders.map((o, i) => [o.id, i]))
  return [...rows].sort((a, b) => b.order_date.localeCompare(a.order_date) || (idx.get(b.order_id) ?? 0) - (idx.get(a.order_id) ?? 0))
}

/** Ghi trực tiếp 1 dòng có cột version: chỉ cập nhật nếu version chưa đổi (bắt sửa đồng thời 2 máy). */
export const VERSION_CONFLICT_MSG = 'Dữ liệu vừa được sửa trên máy khác. App đã tải lại — thử lại thao tác.'
