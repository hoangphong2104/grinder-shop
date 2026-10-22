// Dùng chung cho nhóm Tổng quan / Kho / Công nợ / Báo cáo / Người bán / Danh mục / Cài đặt.
import { useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { DbData, LotRow, OrderRow, VariantStockRow } from '../../data/types.ts'
import { supabase } from '../../lib/supabase.ts'
import { LotChip, OrderChip } from '../../ui/status.tsx'
import { cny, dmy, tr, vnd } from '../../ui/format.ts'
import '../../styles/overview.css'

/** Máy tính (≥ 960px) — đổi bảng ↔ thẻ như prototype. */
export function useDesk(): boolean {
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

/** Tên đầy đủ "K Ultra · Đen". */
export function vName(d: DbData, variantId: string): string {
  const v = d.variants.find((x) => x.id === variantId)
  if (!v) return '(đã xoá)'
  const m = d.models.find((x) => x.id === v.model_id)
  return `${m?.name ?? ''} · ${v.name}`
}
export const modelNameOf = (d: DbData, variantId: string) => {
  const v = d.variants.find((x) => x.id === variantId)
  return d.models.find((m) => m.id === v?.model_id)?.name ?? ''
}

/** Tồn theo thứ tự model (sort_order) rồi thứ tự tạo biến thể. */
export function sortedStock(d: DbData, onlyActive = true): VariantStockRow[] {
  const mi = new Map(d.models.map((m, i) => [m.id, i]))
  const vi = new Map(d.variants.map((v, i) => [v.id, i]))
  return d.stock
    .filter((s) => !onlyActive || s.is_active)
    .sort((a, b) => (mi.get(a.model_id) ?? 0) - (mi.get(b.model_id) ?? 0) || (vi.get(a.variant_id) ?? 0) - (vi.get(b.variant_id) ?? 0))
}

/** Mã lô đang mở (chưa nhận / chưa huỷ) đầu tiên có biến thể này — cho chip "Chờ L-00x". */
export function waitingLot(d: DbData, variantId: string): string | undefined {
  const l = d.lots.find((x) => x.status !== 'received' && x.status !== 'cancelled'
    && d.lotLines.some((ln) => ln.lot_id === x.id && ln.variant_id === variantId))
  return l ? d.lotCode[l.id] : undefined
}

export const lotLinesText = (d: DbData, lotId: string, style: 'qtyFirst' | 'qtyLast' = 'qtyFirst') =>
  d.lotLines.filter((x) => x.lot_id === lotId)
    .map((x) => (style === 'qtyFirst' ? `${x.qty} × ${vName(d, x.variant_id)}` : `${vName(d, x.variant_id)} ×${x.qty}`)).join(', ')
export const orderLinesText = (d: DbData, orderId: string) =>
  d.orderLines.filter((x) => x.order_id === orderId).map((x) => `${x.qty} × ${vName(d, x.variant_id)}`).join(', ')

/** Số tiền ô KPI: máy tính đủ đồng (không ký hiệu), điện thoại "5,4tr". */
export const kpiAmount = (n: number, desk: boolean) => (desk ? vnd(n).replace(' ₫', '') : tr(n))

/** Dòng lô (thẻ "shot") — như lotRow của prototype. */
export function LotShot({ d, l }: { d: DbData; l: LotRow }) {
  const s = d.lotSummary.find((x) => x.lot_id === l.id)
  const seller = d.sellers.find((x) => x.id === l.seller_id)
  return (
    <Link className="shot" to={`/lo/${l.id}`}>
      <span className="t">{d.lotCode[l.id]} · đặt {dmy(l.ordered_at)} · {seller?.nickname ?? '(chưa rõ người bán)'}</span>
      <span className="b">{lotLinesText(d, l.id)}</span>
      <span className="r"><LotChip s={l.status} /><span className="num small">{tr(s?.payable_vnd ?? 0)}</span></span>
      <span className="f">{cny(s?.total_cny ?? 0)} × {Number(l.exchange_rate).toLocaleString('vi-VN')} · ship {l.ship_fee_vnd == null ? <span className="req">chưa nhập</span> : tr(l.ship_fee_vnd)}</span>
    </Link>
  )
}

/** Dòng đơn (thẻ "shot") — như orderRow của prototype. */
export function OrderShot({ d, o }: { d: DbData; o: OrderRow }) {
  const s = d.orderSummary.find((x) => x.order_id === o.id)
  const cust = d.customers.find((c) => c.id === o.customer_id)
  const due = s?.receivable_vnd ?? 0
  return (
    <Link className="shot" to={`/don/${o.id}`}>
      <span className="t">{d.orderCode[o.id]} · {dmy(o.order_date)} · {cust?.fb_name ?? ''}</span>
      <span className="b">{orderLinesText(d, o.id)}</span>
      <span className="r"><OrderChip s={o.status} />{due > 0 && <span className="pill bad">còn {tr(due)}</span>}</span>
      <span className="f num">{vnd((s?.goods_vnd ?? 0) + (s?.ship_charged_vnd ?? 0))}</span>
    </Link>
  )
}

/** Dòng bảng bấm được (cả hàng) — ô đầu có Link cho bàn phím. */
export function GoRow({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  const nav = useNavigate()
  return (
    <tr data-act="go" className={className}
      onClick={(e) => { if (!(e.target as HTMLElement).closest('a,button')) nav(to) }}>{children}</tr>
  )
}

/** Lỗi Supabase → câu tiếng Việt cho thao tác ghi bảng trực tiếp (BR-14 khi xoá mục đã dùng). */
export function writeError(e: unknown, what = 'Mục này'): string {
  const err = (e ?? {}) as { code?: string; message?: string }
  if (err.code === '23503') return `${what} đã có lô / đơn hoặc còn mục con — không xoá được, hãy Ẩn (BR-14).`
  if (err.code === '23505') return 'Tên này đã có — chọn tên khác.'
  if (err.code === '23514') return 'Dữ liệu nhập chưa hợp lệ (độ dài / số âm).'
  if (err.code === '42501') return 'Không có quyền thực hiện thao tác này.'
  const msg = String(err.message ?? e ?? '')
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return 'Mất kết nối mạng — chưa lưu. Thử lại khi có mạng.'
  return msg || 'Có lỗi xảy ra.'
}
export const CONFLICT_MSG = 'Dữ liệu vừa được sửa trên máy khác. App đã tải lại — thử lại thao tác.'

/** Số ngày giữa 2 ngày YYYY-MM-DD. */
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 86400000)

/** Ghi bảng trực tiếp kèm kiểm tra version (2 máy sửa cùng lúc). Ném Error tiếng Việt khi lỗi / xung đột. */
export async function updateVersioned(table: string, id: string, version: number, patch: Record<string, unknown>, what?: string): Promise<void> {
  const { data, error } = await supabase.from(table).update(patch).eq('id', id).eq('version', version).select('id')
  if (error) throw new Error(writeError(error, what))
  if (!data || data.length === 0) throw new Error(CONFLICT_MSG)
}
