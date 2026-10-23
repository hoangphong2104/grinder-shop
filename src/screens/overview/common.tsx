// Dùng chung cho nhóm Tổng quan / Kho / Công nợ / Báo cáo / Người bán / Model / Cài đặt (CR-001: quản lý từng chiếc).
import { useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { DbData, LotRow, ModelStockRow, OrderRow, UnitViewRow } from '../../data/types.ts'
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

/** Bỏ dấu + chữ thường để tìm kiếm. */
export const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase()

/** Thứ tự model như danh mục (sort_order rồi thứ tự tạo — d.models đã sắp sẵn). */
export function modelOrder(d: DbData): Map<string, number> {
  return new Map(d.models.map((m, i) => [m.id, i]))
}

/** Tồn theo model (v_model_stock), sắp theo thứ tự danh mục. onlyActive: bỏ model đã ẩn nhưng vẫn giữ model ẩn còn hàng trong kho. */
export function sortedModelStock(d: DbData, onlyActive = true): ModelStockRow[] {
  const mi = modelOrder(d)
  return d.modelStock
    .filter((s) => !onlyActive || s.is_active || s.on_hand_count + s.incoming_count > 0)
    .sort((a, b) => (mi.get(a.model_id) ?? 0) - (mi.get(b.model_id) ?? 0))
}

/** Số thứ tự trong mã "KU-007" → 7 (để sắp 999 < 1000). */
const seqOf = (code: string) => Number(code.slice(code.lastIndexOf('-') + 1)) || 0
/** Sắp chiếc theo model (thứ tự danh mục) rồi theo mã. */
export function sortUnits(d: DbData, list: UnitViewRow[]): UnitViewRow[] {
  const mi = modelOrder(d)
  return [...list].sort((a, b) => (mi.get(a.model_id) ?? 0) - (mi.get(b.model_id) ?? 0)
    || a.code_prefix.localeCompare(b.code_prefix) || seqOf(a.code) - seqOf(b.code))
}

/** Mã đơn đang giữ / đã bán chiếc (cho UnitChip "Đã giữ cho D-005"). */
export const holderCode = (d: DbData, u: UnitViewRow) => (u.holding_order_id ? d.orderCode[u.holding_order_id] : undefined)

/** Giá nhập ₫ của chiếc + dấu "sửa tay" / "tạm tính" (ship lô chưa nhập). */
export function CostCell({ u, short }: { u: UnitViewRow; short?: boolean }) {
  return (
    <>
      {short ? tr(u.cost_vnd) : vnd(u.cost_vnd)}
      {u.cost_is_overridden
        ? <> <span className="pill" title="Giá nhập đã sửa tay">sửa tay</span></>
        : u.cost_is_provisional ? <> <span className="pill way" title="Lô chưa có phí ship — giá nhập tạm tính">tạm tính</span></> : null}
    </>
  )
}

/** Lãi của chiếc: đã bán = thực tế (giá chốt − giá nhập); chưa bán = dự kiến (giá bán dự kiến − giá nhập). */
export function unitProfit(u: UnitViewRow): { value: number | null; actual: boolean } {
  if (u.status === 'sold') return { value: u.actual_profit_vnd, actual: true }
  if (u.status === 'cancelled') return { value: null, actual: false }
  return { value: u.expected_profit_vnd, actual: false }
}

/** "2 × K Ultra, 1 × ZP6" từ v_lot_summary.models. */
export function lotModelsText(d: DbData, lotId: string, style: 'qtyFirst' | 'qtyLast' = 'qtyFirst'): string {
  const s = d.lotSummary.find((x) => x.lot_id === lotId)
  if (!s || !s.models?.length) return '(chưa có chiếc)'
  return s.models.map((m) => (style === 'qtyFirst' ? `${m.qty} × ${m.model_name}` : `${m.model_name} ×${m.qty}`)).join(', ')
}
/** "KU-007, JU-003" từ v_order_summary.unit_codes. */
export function orderUnitsText(d: DbData, orderId: string): string {
  const s = d.orderSummary.find((x) => x.order_id === orderId)
  return s?.unit_codes?.length ? s.unit_codes.join(', ') : '(chưa có chiếc)'
}

/** Số tiền ô KPI: máy tính đủ đồng (không ký hiệu), điện thoại "5,4tr". */
export const kpiAmount = (n: number, desk: boolean) => (desk ? vnd(n).replace(' ₫', '') : tr(n))

/** Dòng lô (thẻ "shot") — như lotRow của prototype. */
export function LotShot({ d, l }: { d: DbData; l: LotRow }) {
  const s = d.lotSummary.find((x) => x.lot_id === l.id)
  const seller = d.sellers.find((x) => x.id === l.seller_id)
  return (
    <Link className="shot" to={`/lo/${l.id}`}>
      <span className="t">{d.lotCode[l.id]} · đặt {dmy(l.ordered_at)} · {seller?.nickname ?? '(chưa rõ người bán)'}</span>
      <span className="b">{lotModelsText(d, l.id)}</span>
      <span className="r"><LotChip s={l.status} /><span className="num small">{tr(s?.payable_vnd ?? 0)}</span></span>
      <span className="f">{cny(Number(s?.total_cny ?? 0))} × {Number(l.exchange_rate).toLocaleString('vi-VN')} · ship {l.ship_fee_vnd == null ? <span className="req">chưa nhập</span> : tr(l.ship_fee_vnd)}</span>
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
      <span className="b">{orderUnitsText(d, o.id)}</span>
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
      onClick={(e) => { if (!(e.target as HTMLElement).closest('a,button,input')) nav(to) }}>{children}</tr>
  )
}

/** Lỗi Supabase → câu tiếng Việt cho thao tác ghi bảng trực tiếp (BR-14 khi xoá mục đã dùng). */
export function writeError(e: unknown, what = 'Mục này'): string {
  const err = (e ?? {}) as { code?: string; message?: string }
  const msg = String(err.message ?? e ?? '')
  if (err.code === '23503') return `${what} đã có lô / chiếc cối / đơn dùng tới — không xoá được, hãy Ẩn (BR-14).`
  if (err.code === '23505') return /prefix/i.test(msg) ? 'Tiền tố mã này đã dùng cho model khác — chọn tiền tố khác.' : 'Tên này đã có — chọn tên khác.'
  if (err.code === '23514') return 'Dữ liệu nhập chưa hợp lệ (độ dài / số âm / ký tự).'
  if (err.code === '42501') return 'Không có quyền thực hiện thao tác này.'
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return 'Mất kết nối mạng — chưa lưu. Thử lại khi có mạng.'
  return msg || 'Có lỗi xảy ra.'
}
export const CONFLICT_MSG = 'Dữ liệu vừa được sửa trên máy khác. App đã tải lại — thử lại thao tác.'

/** Ghi bảng trực tiếp kèm kiểm tra version (2 máy sửa cùng lúc). Ném Error tiếng Việt khi lỗi / xung đột. */
export async function updateVersioned(table: string, id: string, version: number, patch: Record<string, unknown>, what?: string): Promise<void> {
  const { data, error } = await supabase.from(table).update(patch).eq('id', id).eq('version', version).select('id')
  if (error) throw new Error(writeError(error, what))
  if (!data || data.length === 0) throw new Error(CONFLICT_MSG)
}
