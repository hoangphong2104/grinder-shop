// Dùng chung cho nhóm Tổng quan / Kho / Sổ quỹ / Model / Cài đặt (CR-001: quản lý từng chiếc).
// CR-004: dòng danh sách 2 dòng (UI-M1, research §1.3) - Row2 + UnitRow / LotRow / OrderRow.
import { useEffect, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { AgingLevelDb, DbData, LotRow as LotDbRow, ModelStockRow, OrderSummaryRow, UnitStatusDb, UnitViewRow } from '../../data/types.ts'
import { supabase } from '../../lib/supabase.ts'
import { CONDITION_LABEL, LotChip, OrderChip, unitLabel } from '../../ui/status.tsx'
import { todayVn, tr, vnd } from '../../ui/format.ts'
import '../../styles/overview.css'

/** Máy tính (≥ 960px) - đổi bảng ↔ thẻ như prototype. */
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

/** Số ngày từ ngày ISO (YYYY-MM-DD…) tới hôm nay (giờ VN). */
export function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null
  const a = Date.parse(`${iso.slice(0, 10)}T00:00:00Z`), b = Date.parse(`${todayVn()}T00:00:00Z`)
  return Number.isFinite(a) ? Math.max(0, Math.round((b - a) / 86400000)) : null
}

/** Ngưỡng ngày trong Cài đặt (CR-004; DB chưa có cột ⇒ mặc định 30 / 60 / 21). */
export function thresholds(d: DbData) {
  const s = d.settings
  return { warn: s?.aging_warn_days ?? 30, alert: s?.aging_alert_days ?? 60, lotLate: s?.lot_late_days ?? 21 }
}

/** Class màu chữ theo tuổi tồn (KHO-S1): ok thường · warn cam · alert đỏ. */
export const agingCls = (a: AgingLevelDb | null | undefined) => (a === 'alert' ? 'age-alert' : a === 'warn' ? 'age-warn' : '')

/** Thứ tự model như danh mục (sort_order rồi thứ tự tạo - d.models đã sắp sẵn). */
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
export const seqOf = (code: string) => Number(code.slice(code.lastIndexOf('-') + 1)) || 0

/** KHO-M3 kiểu sắp xếp: mã · tồn lâu nhất · mới nhập · giá bán cao → thấp · lãi dự kiến cao → thấp. */
export type UnitSort = 'ma' | 'ton' | 'moi' | 'gia' | 'lai'
export const UNIT_SORTS: [UnitSort, string][] = [['ma', 'Mã (theo model)'], ['ton', 'Tồn lâu nhất'], ['moi', 'Mới nhập'], ['gia', 'Giá bán cao → thấp'], ['lai', 'Lãi dự kiến cao → thấp']]
/** Giá bên phải dòng: chiếc đã bán = giá chốt, còn lại = giá bán dự kiến. */
export const unitPrice = (u: UnitViewRow) => (u.status === 'sold' ? u.sold_price_vnd : u.list_price_vnd)
/** Tuổi để sắp "tồn lâu": đã về = số ngày tồn; đang về = số ngày từ lúc đặt (xếp sau chiếc đã về). */
const ageKey = (u: UnitViewRow) => (u.days_in_stock != null ? 100000 + u.days_in_stock : daysSince(u.ordered_at) ?? 0)

/** Sắp chiếc theo model (thứ tự danh mục) rồi theo mã; hoặc theo kiểu sx. */
export function sortUnits(d: DbData, list: UnitViewRow[], sx: UnitSort = 'ma'): UnitViewRow[] {
  const mi = modelOrder(d)
  const byCode = (a: UnitViewRow, b: UnitViewRow) => (mi.get(a.model_id) ?? 0) - (mi.get(b.model_id) ?? 0)
    || a.code_prefix.localeCompare(b.code_prefix) || seqOf(a.code) - seqOf(b.code)
  const desc = (f: (u: UnitViewRow) => number | null) => (a: UnitViewRow, b: UnitViewRow) => {
    const x = f(a), y = f(b)
    if (x == null && y == null) return byCode(a, b)
    if (x == null) return 1
    if (y == null) return -1
    return y - x || byCode(a, b)
  }
  const cmp = sx === 'ton' ? desc(ageKey)
    : sx === 'moi' ? (a: UnitViewRow, b: UnitViewRow) => (b.received_at ?? b.ordered_at).localeCompare(a.received_at ?? a.ordered_at) || seqOf(b.code) - seqOf(a.code)
      : sx === 'gia' ? desc(unitPrice)
        : sx === 'lai' ? desc((u) => unitProfit(u).value)
          : byCode
  return [...list].sort(cmp)
}

/** KHO-S2: tìm theo mã (gõ "zp6001", "zp6 1" vẫn khớp ZP6-001), seri, tên model, ghi chú - không phân biệt dấu. */
export function unitMatch(u: UnitViewRow, q: string): false | 'code' | 'serial' | 'other' {
  const f = fold(q.trim())
  if (!f) return 'other'
  const compact = f.replace(/[\s-]/g, '')
  const pfx = fold(u.code_prefix)
  if (fold(u.code).includes(f) || fold(u.code).replace(/-/g, '').includes(compact)) return 'code'
  if (compact.startsWith(pfx) && /^\d+$/.test(compact.slice(pfx.length)) && Number(compact.slice(pfx.length)) === seqOf(u.code)) return 'code'
  if (u.serial_no && fold(u.serial_no).includes(f)) return 'serial'
  if (fold(u.model_name).includes(f) || (u.note && fold(u.note).includes(f))) return 'other'
  return false
}

/** Mã đơn đang giữ / đã bán chiếc (cho UnitChip "Đã giữ cho D-005"). */
export const holderCode = (d: DbData, u: UnitViewRow) => (u.holding_order_id ? d.orderCode[u.holding_order_id] : undefined)

const UNIT_TONE: Record<UnitStatusDb, string> = { incoming: 'way', in_stock: 'ok', reserved: 'hold', sold: 'neu', cancelled: 'neu' }
/** Chip trạng thái chiếc rút gọn (CR-005): Kho TQ / Kho VN / Kho Lumi / "Giữ D-005" / Vận chuyển tới khách / "Đã giao D-005". */
export function UnitChipShort({ u, holder }: { u: UnitViewRow; holder?: string }) {
  const t = u.status === 'reserved' && holder ? `Giữ ${holder}`
    : u.status === 'sold' && u.holding_order_status === 'completed' && holder ? `Đã giao ${holder}`
      : unitLabel(u.status, u.lot_status, u.holding_order_status)
  return <span className={`pill ${UNIT_TONE[u.status]}`}>{t}</span>
}

/** Giá nhập ₫ của chiếc + dấu "sửa tay" / "tạm tính" (ship lô chưa nhập). */
export function CostCell({ u, short }: { u: UnitViewRow; short?: boolean }) {
  return (
    <>
      {short ? tr(u.cost_vnd) : vnd(u.cost_vnd)}
      {u.cost_is_overridden
        ? <> <span className="pill" title="Giá nhập đã sửa tay">sửa tay</span></>
        : u.cost_is_provisional ? <> <span className="pill way" title="Lô chưa có phí ship - giá nhập tạm tính">tạm tính</span></> : null}
    </>
  )
}

/** Lãi của chiếc: đã bán = thực tế (giá chốt − giá nhập); chưa bán = dự kiến (giá bán dự kiến − giá nhập). */
export function unitProfit(u: UnitViewRow): { value: number | null; actual: boolean } {
  if (u.status === 'sold') return { value: u.actual_profit_vnd, actual: true }
  if (u.status === 'cancelled') return { value: null, actual: false }
  return { value: u.expected_profit_vnd, actual: false }
}

/** "2 × K Ultra, 1 × ZP6" từ v_lot_summary.models. short: dùng tiền tố mã ("2 × KU, 1 × ZP6"). */
export function lotModelsText(d: DbData, lotId: string, style: 'qtyFirst' | 'qtyLast' | 'short' = 'qtyFirst'): string {
  const s = d.lotSummary.find((x) => x.lot_id === lotId)
  if (!s || !s.models?.length) return '(chưa có chiếc)'
  const pfx = (id: string, name: string) => d.models.find((m) => m.id === id)?.code_prefix ?? name
  return s.models.map((m) => (style === 'qtyLast' ? `${m.model_name} ×${m.qty}` : `${m.qty} × ${style === 'short' ? pfx(m.model_id, m.model_name) : m.model_name}`)).join(', ')
}
/** "KU-007, JU-003 +1" từ v_order_summary.unit_codes (tối đa `max` mã). */
export function codesText(codes: string[] | null | undefined, max = 2): string {
  if (!codes?.length) return '(chưa có chiếc)'
  return codes.slice(0, max).join(', ') + (codes.length > max ? ` +${codes.length - max}` : '')
}
export function orderUnitsText(d: DbData, orderId: string): string {
  return codesText(d.orderSummary.find((x) => x.order_id === orderId)?.unit_codes, 99)
}

/** Số tiền ô KPI: máy tính đủ đồng (không ký hiệu), điện thoại "5.400k". */
export const kpiAmount = (n: number, desk: boolean) => (desk ? vnd(n).replace(' ₫', '') : tr(n))

/** Tháng tính lãi của đơn (CR-004: theo profit_date - ngày gửi, đơn Hoàn hàng = ngày hoàn). */
export const profitMonth = (o: OrderSummaryRow) => (o.profit_vnd != null && o.profit_date ? o.profit_date.slice(0, 7) : null)

// ---------- Dòng danh sách 2 dòng (UI-M1) ----------
/** Dòng chuẩn: a = dòng 1 trái (định danh + mô tả cắt …), b = dòng 1 phải (số chính), c = dòng 2 trái (1 chip + phụ cắt …), d = dòng 2 phải (số phụ). */
export function Row2({ to, onClick, a, b, c, d, className, label }: {
  to?: string; onClick?: () => void; a: ReactNode; b?: ReactNode; c?: ReactNode; d?: ReactNode; className?: string; label?: string
}) {
  const inner = <><span className="a">{a}</span><span className="b">{b}</span>{(c != null || d != null) && <><span className="c">{c}</span><span className="d">{d}</span></>}</>
  const cls = `ov-row ${className ?? ''}`
  if (to) return <Link className={cls} to={to} aria-label={label}>{inner}</Link>
  if (onClick) return <button type="button" className={cls} onClick={onClick} aria-label={label}>{inner}</button>
  return <div className={`${cls} static`}>{inner}</div>
}
/** Định danh (không cắt) + mô tả (cắt …). */
export const Ident = ({ id, text }: { id: ReactNode; text?: ReactNode }) => <><b className="id">{id}</b>{text != null && <span className="tx">{text}</span>}</>
/** Phần phụ sau chip (cắt …). */
export const Tx = ({ children, className }: { children: ReactNode; className?: string }) => <span className={`tx ${className ?? ''}`}>{children}</span>
/** Tiền âm đỏ, có dấu −. */
export const Money = ({ n, prefix }: { n: number | null | undefined; prefix?: string }) =>
  <span className={n != null && n < 0 ? 'neg' : ''}>{prefix}{n != null && n < 0 ? `−${tr(-n)}` : tr(n)}</span>
/** CR-005 ý 12: lãi luôn có dấu "+2.592k" / "−35k" (0 ⇒ "0k"). */
export const signed = (n: number) => (n > 0 ? `+${tr(n)}` : n < 0 ? `−${tr(-n)}` : tr(0))
export const signedVnd = (n: number) => (n > 0 ? `+${vnd(n)}` : n < 0 ? `−${vnd(-n)}` : vnd(0))
/** Lãi có dấu, màu xanh / đỏ; est = lãi chưa chốt ⇒ thêm chữ "dự kiến"; full = đủ đồng. */
export const Profit = ({ n, est, full, prefix }: { n: number | null | undefined; est?: boolean; full?: boolean; prefix?: string }) =>
  n == null ? <span>-</span>
    : <span className={n < 0 ? 'neg' : n > 0 ? 'pos' : ''}>{prefix}{full ? signedVnd(n) : signed(n)}{est ? ' dự kiến' : ''}</span>

/** Dòng 1 chiếc (research §2.4): mã + model … giá bán · chip + tuổi tồn … nhập (đã bán: lãi). */
export function UnitRow({ d, u, right2, sub }: { d: DbData; u: UnitViewRow; right2?: ReactNode; sub?: ReactNode }) {
  const holder = holderCode(d, u)
  const age = u.status === 'incoming'
    ? (() => { const n = daysSince(u.ordered_at); return n != null ? <span>đặt {n} ngày</span> : null })()
    : u.days_in_stock != null && u.status !== 'cancelled'
      ? <span className={agingCls(u.aging_level)}>{u.days_in_stock} ngày</span> : null
  const cond = u.condition && u.condition !== 'new' ? <span className={`pill ${u.condition === 'defect' ? 'bad' : 'neu'}`}>{CONDITION_LABEL[u.condition]}</span> : null
  const p = unitProfit(u)
  return (
    <Row2 to={`/kho/${u.unit_id}`}
      a={<Ident id={u.code} text={u.model_name} />}
      b={unitPrice(u) != null ? tr(unitPrice(u)) : '-'}
      c={<><UnitChipShort u={u} holder={holder} />{cond}<Tx>{sub ?? age}</Tx></>}
      d={right2 ?? (u.status === 'sold' ? <Profit n={p.value} prefix="lãi " /> : <>nhập {tr(u.cost_vnd)}</>)} />
  )
}

/** Dòng lô (research §3.4): mã lô + model … phải trả · chip bước + đặt N ngày / nhận dd/mm + cảnh báo … số chiếc. */
export function LotRow({ d, l, noChip }: { d: DbData; l: LotDbRow; noChip?: boolean }) {
  const s = d.lotSummary.find((x) => x.lot_id === l.id)
  const open = l.status !== 'received' && l.status !== 'cancelled'
  const when = open ? `đặt ${daysSince(l.ordered_at) ?? 0} ngày` : l.status === 'received' ? `nhận ${dmyShort(l.received_at)}` : `đặt ${dmyShort(l.ordered_at)}`
  const warn = open && l.ship_fee_vnd == null && l.status === 'vn_warehouse' ? 'thiếu ship' : s?.is_lot_late ? 'về trễ' : null
  return (
    <Row2 to={`/lo/${l.id}`}
      a={<Ident id={d.lotCode[l.id] ?? 'Lô'} text={lotModelsText(d, l.id, 'short')} />}
      b={tr(s?.payable_vnd ?? 0)}
      c={<>{!noChip && <LotChip s={l.status} />}<Tx className={s?.is_lot_late && open ? 'age-alert' : ''}>{when}{warn ? <> · <span className="neg">⚠ {warn}</span></> : null}</Tx></>}
      d={`${s?.total_qty ?? 0} chiếc`} />
  )
}
const dmyShort = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '-')

/** Thanh toán dạng chữ màu (research §4.4 Dòng 2 phải). */
export function PayText({ o }: { o: OrderSummaryRow }) {
  if (o.refund_due_vnd > 0) return <span className="neg">hoàn {tr(o.refund_due_vnd)}</span>
  if (o.status === 'cancelled') return <span>-</span>
  if (o.status === 'returned') return <Profit n={o.profit_vnd} prefix="lãi " />
  if (o.cod_pending_vnd > 0) return <span className="age-warn">COD {tr(o.cod_pending_vnd)}</span>
  if (o.receivable_vnd > 0) return <span className="neg">còn {tr(o.receivable_vnd)}</span>
  if (o.receivable_vnd < 0) return <span>trả dư {tr(-o.receivable_vnd)}</span>
  return <span className="pos">đủ ✓</span>
}

/** Dòng đơn (research §4.4): mã đơn + khách … tổng · chip + ngày + mã chiếc … thanh toán. sub thay phần phụ dòng 2. */
export function OrderRow({ d, o, noChip, sub, right2 }: { d: DbData; o: OrderSummaryRow; noChip?: boolean; sub?: ReactNode; right2?: ReactNode }) {
  return (
    <Row2 to={`/don/${o.order_id}`}
      a={<Ident id={d.orderCode[o.order_id] ?? 'Đơn'} text={o.customer_name} />}
      b={tr(o.goods_vnd + o.ship_charged_vnd)}
      c={<>{!noChip && <OrderChip s={o.status} />}<Tx>{sub ?? <>{dmyShort(o.order_date)} · {codesText(o.unit_codes)}</>}</Tx></>}
      d={right2 ?? <PayText o={o} />} />
  )
}

/** Đoạn giải thích dài gập lại (UI-S3 "ⓘ Cách tính"). */
export function HowTo({ children, title = 'Cách tính' }: { children: ReactNode; title?: string }) {
  return <details className="ov-how"><summary>ⓘ {title}</summary><div className="hint">{children}</div></details>
}

/** Dòng bảng bấm được (cả hàng) - ô đầu có Link cho bàn phím. */
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
  if (err.code === '23503') return `${what} đã có lô / chiếc cối / đơn dùng tới - không xoá được, hãy Ẩn (BR-14).`
  if (err.code === '23505') return /prefix/i.test(msg) ? 'Tiền tố mã này đã dùng cho model khác - chọn tiền tố khác.' : 'Tên này đã có - chọn tên khác.'
  if (err.code === '23514') return 'Dữ liệu nhập chưa hợp lệ (độ dài / số âm / ký tự).'
  if (err.code === '42501') return 'Không có quyền thực hiện thao tác này.'
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return 'Mất kết nối mạng - chưa lưu. Thử lại khi có mạng.'
  return msg || 'Có lỗi xảy ra.'
}
export const CONFLICT_MSG = 'Dữ liệu vừa được sửa trên máy khác. App đã tải lại - thử lại thao tác.'

/** Ghi bảng trực tiếp kèm kiểm tra version (2 máy sửa cùng lúc). Ném Error tiếng Việt khi lỗi / xung đột. */
export async function updateVersioned(table: string, id: string, version: number, patch: Record<string, unknown>, what?: string): Promise<void> {
  const { data, error } = await supabase.from(table).update(patch).eq('id', id).eq('version', version).select('id')
  if (error) throw new Error(writeError(error, what))
  if (!data || data.length === 0) throw new Error(CONFLICT_MSG)
}
