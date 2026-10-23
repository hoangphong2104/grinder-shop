// Tra cứu + tính phụ dùng chung cho nhóm màn Đơn bán / Khách (CR-001: đơn = danh sách chiếc cụ thể).
// Số tiền chính thức lấy từ view v_order_summary / v_units; ở đây chỉ ghép tên và ƯỚC lãi đơn chưa gửi.
import { useEffect, useState } from 'react'
import { tr } from '../../ui/format.ts'
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
/** Đơn còn đang chạy (chưa Hoàn tất / Huỷ / Hoàn hàng). */
export const OPEN_STATUSES: OrderStatusDb[] = ['preorder', 'confirmed', 'shipped']
/** Đơn đã từng gửi hàng (CR-004: gồm cả Hoàn hàng - chỉ đi được từ Đã gửi). */
export const isSentStatus = (s: OrderStatusDb) => s === 'shipped' || s === 'completed' || s === 'returned'
/** Chiếc đang ở tay khách (Đã bán): Đã gửi / Hoàn tất. Hoàn hàng ⇒ chiếc đã về kho. */
export const isSoldStatus = (s: OrderStatusDb) => s === 'shipped' || s === 'completed'
/** Đơn đã đóng, chỉ còn việc tiền (hoàn tiền) nếu có. */
export const isClosedStatus = (s: OrderStatusDb) => s === 'completed' || s === 'cancelled' || s === 'returned'

/** Ngày giữa 2 ngày ISO (YYYY-MM-DD). */
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000)

/** "ZP6-001, KU-007 +1" - tối đa `max` mã, phần còn lại thành "+n". */
export function codesText(codes: readonly string[] | null | undefined, max = 2): string {
  if (!codes?.length) return '-'
  return codes.length <= max ? codes.join(', ') : `${codes.slice(0, max).join(', ')} +${codes.length - max}`
}

// ---------- CR-004 DON-M2: 1 hàng chip lọc có đếm (?f=) ----------
export type OrderFilter = 'todo' | 'pre' | 'wait' | 'sent' | 'cod' | 'due' | 'refund' | 'ret' | 'all'
/** Cần hoàn: đơn Huỷ / Hoàn hàng còn tiền phải trả lại khách (Q-009, DON-S3). */
const needsRefund = (s: OrderSummaryRow) => s.refund_due_vnd > 0
export const ORDER_FILTERS: { k: OrderFilter; t: string; test: (s: OrderSummaryRow) => boolean; optional?: boolean }[] = [
  // Cần xử lý = Đặt trước + Đã chốt + Đã gửi chưa xong + Huỷ / Hoàn hàng còn tiền phải hoàn
  { k: 'todo', t: 'Cần xử lý', test: (s) => OPEN_STATUSES.includes(s.status) || needsRefund(s) },
  { k: 'pre', t: 'Đặt trước', test: (s) => s.status === 'preorder' },
  { k: 'wait', t: 'Chờ gửi', test: (s) => s.status === 'confirmed' },
  { k: 'sent', t: 'Đã gửi', test: (s) => s.status === 'shipped' },
  { k: 'cod', t: 'COD chờ về', test: (s) => s.cod_pending_vnd > 0 },
  { k: 'due', t: 'Còn nợ', test: (s) => s.receivable_vnd > 0 },
  // Chỉ hiện chip khi có đơn (hoặc đang chọn qua URL, vd. từ Tổng quan "Cần hoàn")
  { k: 'refund', t: 'Cần hoàn', test: needsRefund, optional: true },
  { k: 'ret', t: 'Hoàn hàng', test: (s) => s.status === 'returned' },
  { k: 'all', t: 'Tất cả', test: () => true },
]
/** Đọc ?f= (giữ tương thích link cũ: 'open' = Cần xử lý). */
export function parseOrderFilter(v: string | null): OrderFilter {
  if (!v || v === 'open') return 'todo'
  return ORDER_FILTERS.some((f) => f.k === v) ? (v as OrderFilter) : 'todo'
}

// ---------- CR-004 DON-M4: trạng thái THANH TOÁN tách khỏi trạng thái đơn ----------
export interface PayState { short: string; long: string; tone: 'ok' | 'way' | 'hold' | 'bad' | 'neu' }
/**
 * 1 nhãn thanh toán / đơn (thứ tự ưu tiên): Cần hoàn → COD chờ về → Chưa thu / Còn → Trả dư → Đã thu đủ.
 * short = chữ màu trên dòng điện thoại (§4.4), long = chip trên bảng / thẻ máy tính. null = không có gì để báo.
 */
export function payState(s: OrderSummaryRow): PayState | null {
  if (s.refund_due_vnd > 0) return { short: `hoàn ${tr(s.refund_due_vnd)}`, long: `Cần hoàn ${tr(s.refund_due_vnd)}`, tone: 'bad' }
  if (s.cod_pending_vnd > 0) return { short: `COD ${tr(s.cod_pending_vnd)}`, long: `COD chờ về ${tr(s.cod_pending_vnd)}`, tone: 'way' }
  if (s.status === 'cancelled' || s.status === 'returned') return null
  if (s.receivable_vnd > 0) {
    if (s.paid_vnd <= 0) return { short: 'chưa thu', long: 'Chưa thu', tone: 'bad' }
    return { short: `còn ${tr(s.receivable_vnd)}`, long: s.deposit_vnd > 0 && s.paid_vnd === s.deposit_vnd ? `Cọc ${tr(s.deposit_vnd)} · còn ${tr(s.receivable_vnd)}` : `Còn ${tr(s.receivable_vnd)}`, tone: 'bad' }
  }
  if (s.receivable_vnd < 0) return { short: `trả dư ${tr(-s.receivable_vnd)}`, long: `Trả dư ${tr(-s.receivable_vnd)}`, tone: 'hold' }
  return { short: 'đã đủ', long: 'Đã thu đủ', tone: 'ok' }
}

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
  /** Khách phải trả = tiền hàng + ship khách trả (thu hộ - Q-015). */
  total: (s: OrderSummaryRow) => number
  /** Lãi: đơn đã gửi / Hoàn hàng = số DB; chưa gửi = ước theo giá nhập ₫ hiện tại (A8); Huỷ = null. */
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
    unitsText: (s) => (s.unit_codes?.length ? s.unit_codes.join(', ') : '-'),
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
 * A6 - chiếc chọn được cho đơn: Trong kho hoặc Đang về và chưa đơn nào giữ; khi sửa đơn,
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
export const VERSION_CONFLICT_MSG = 'Dữ liệu vừa được sửa trên máy khác. App đã tải lại - thử lại thao tác.'
