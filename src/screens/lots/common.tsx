// Dùng chung cho nhóm màn Lô nhập (v0.2, CR-001 quản lý từng chiếc): tra cứu, cảnh báo, thẻ lô (bảng cột),
// dòng lô 2 dòng + dòng chiếc (điện thoại, CR-004), tóm tắt model + đếm trạng thái chiếc của lô (v_lot_summary), ô giá nhập ₫ của 1 chiếc.
import { useEffect, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { DbData, LotRow, LotStatusDb, LotSummaryRow, UnitViewRow } from '../../data/types.ts'
import { ConditionChip, LOT_FLOW, LOT_LABEL, UnitChip } from '../../ui/status.tsx'
import { cny, dmy, todayVn, tr, vnd } from '../../ui/format.ts'
import { lotDaysOpen } from '../../domain/index.ts'

/** Màn hình máy tính (≥ 960px) - đổi theo kích thước cửa sổ. */
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

/** Các chiếc của lô (v_units), theo mã. */
export const unitsOfLot = (d: DbData, lotId: string): UnitViewRow[] =>
  d.unitView.filter((u) => u.lot_id === lotId).sort((a, b) => a.code.localeCompare(b.code, 'en', { numeric: true }))
export const summaryOf = (d: DbData, lotId: string): LotSummaryRow | undefined => d.lotSummary.find((x) => x.lot_id === lotId)
/** Phí mua hộ % của lô (CR-003). DB chưa chạy 002_buying_fee.sql ⇒ cột chưa có ⇒ 0. */
export const lotFeePct = (l: Pick<LotRow, 'buying_fee_pct'> | undefined): number => Number(l?.buying_fee_pct ?? 0)

/** Tiền tố mã của model (KU) - không có thì dùng tên model. */
export const prefixOf = (d: DbData, modelId: string, fallback = '?') => d.models.find((m) => m.id === modelId)?.code_prefix ?? fallback
/** "2 × KU, 1 × JU" từ v_lot_summary.models. */
export function modelsText(d: DbData, sum: LotSummaryRow | undefined): string {
  const ms = sum?.models ?? []
  return ms.length ? ms.map((m) => `${m.qty} × ${prefixOf(d, m.model_id, m.model_name)}`).join(', ') : 'Chưa có chiếc nào'
}
/** Đếm trạng thái chiếc của lô: [nhãn, tone pill] - chỉ các trạng thái có chiếc. */
export function unitCounts(sum: LotSummaryRow | undefined): [string, string][] {
  if (!sum) return []
  const out: [string, string][] = []
  if (sum.incoming_count) out.push([`${sum.incoming_count} ${sum.status === 'vn_warehouse' ? 'Kho VN' : sum.status === 'cn_warehouse' ? 'Kho TQ' : 'đang về'}`, 'way'])
  if (sum.in_stock_count) out.push([`${sum.in_stock_count} Kho Lumi`, 'ok'])
  if (sum.reserved_count) out.push([`${sum.reserved_count} khách đặt`, 'hold'])
  if (sum.sold_count) out.push([`${sum.sold_count} đã bán`, 'neu'])
  return out
}
export function UnitCounts({ sum }: { sum: LotSummaryRow | undefined }) {
  const c = unitCounts(sum)
  return c.length ? <span className="row-wrap">{c.map(([t, k]) => <span key={t} className={`pill ${k}`}>{t}</span>)}</span> : null
}

export const isOpen = (s: LotStatusDb) => s !== 'received' && s !== 'cancelled'
/** Bước kế tiếp trong luồng (null nếu đã nhận / huỷ). */
export function nextStatus(s: LotStatusDb): LotStatusDb | null {
  const i = LOT_FLOW.indexOf(s)
  return i >= 0 && i < LOT_FLOW.length - 1 ? LOT_FLOW[i + 1] : null
}
/** CR-004 U9: nhãn bước ngắn cho chip / nút trên điện thoại. */
export const LOT_SHORT: Record<LotStatusDb, string> = { cn_warehouse: 'Kho TQ', vn_warehouse: 'Kho VN', received: 'Kho Lumi', cancelled: 'Huỷ' }
const LOT_TONE: Record<LotStatusDb, string> = { cn_warehouse: 'way', vn_warehouse: 'way', received: 'ok', cancelled: 'neu' }
/** Chip bước nhãn ngắn (cùng màu LotChip). */
export const LotStepPill = ({ s }: { s: LotStatusDb }) => <span className={`pill ${LOT_TONE[s]}`}>{LOT_SHORT[s]}</span>
/** CR-004 LOT-S2: lô về trễ (v_lot_summary.is_lot_late - DB tính theo Cài đặt lot_late_days). */
export const isLate = (d: DbData, l: LotRow): boolean => Boolean(summaryOf(d, l.id)?.is_lot_late)
/** Số ngày từ ngày đặt (lô còn mở) - null khi đã nhận / huỷ. */
export const daysOpen = (l: LotRow): number | null => lotDaysOpen({ status: l.status, orderedAt: l.ordered_at }, todayVn())
export const sellerOf = (d: DbData, l: LotRow) => (l.seller_id ? d.sellers.find((s) => s.id === l.seller_id) : undefined)
/** Mới nhất trước: ngày đặt, rồi thời điểm tạo. */
export const byNewest = (a: LotRow, b: LotRow) => b.ordered_at.localeCompare(a.ordered_at) || b.created_at.localeCompare(a.created_at)

/** Id các đơn Đặt trước đang giữ chiếc của lô (D4). */
export const preordersOfLot = (d: DbData, lotId: string): string[] =>
  [...new Set(unitsOfLot(d, lotId).filter((u) => u.holding_order_status === 'preorder' && u.holding_order_id).map((u) => u.holding_order_id!))]

/** Chip cảnh báo trên thẻ lô (prototype lotCard). */
export function lotWarnings(d: DbData, l: LotRow): [string, string][] {
  const w: [string, string][] = []
  const idx = LOT_FLOW.indexOf(l.status)
  if (isLate(d, l)) w.push(['Về trễ', 'bad'])
  if (l.ship_fee_vnd == null && idx >= 1 && isOpen(l.status)) w.push(['Thiếu phí ship', 'bad'])
  const s = summaryOf(d, l.id)
  if (s && l.status !== 'cancelled' && s.outstanding_vnd > 0) w.push([`Còn nợ TG ${tr(s.outstanding_vnd)}`, 'bad'])
  if (sellerOf(d, l)?.is_avoided) w.push(['Người bán bị đánh dấu tránh', 'bad'])
  if (isOpen(l.status) && preordersOfLot(d, l.id).length) w.push(['Có đơn đặt trước đang chờ', 'hold'])
  return w
}

const stop = (fn: () => void) => (e: MouseEvent) => { e.stopPropagation(); fn() }

/** Thẻ lô trong bảng cột (máy tính, prototype lotCard). CR-004 LOT-M3: 1 nút bước kế; phí ship nhập ở chi tiết lô. */
export function LotCard({ d, l, withActs, busy, onNext }: {
  d: DbData; l: LotRow; withActs: boolean; busy: boolean; onNext: (l: LotRow) => void
}) {
  const nav = useNavigate()
  const s = sellerOf(d, l), sum = summaryOf(d, l.id), next = nextStatus(l.status)
  const go = () => nav(`/lo/${l.id}`)
  const key = (e: KeyboardEvent) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); go() } }
  const warns = lotWarnings(d, l)
  return (
    <div className="kcard" role="button" tabIndex={0} onClick={go} onKeyDown={key}>
      <span className="t">{d.lotCode[l.id]} · {modelsText(d, sum)}</span>
      <span className="s">{s?.nickname ?? 'Chưa rõ người bán'} · {l.status === 'received' ? `nhận ${dmy(l.received_at)}` : `đặt ${dmy(l.ordered_at)} · ${daysOpen(l) ?? 0} ngày`}</span>
      <span className="m">
        <span>{l.status === 'received' && sum?.ship_per_unit_vnd != null ? `ship ${tr(sum.ship_per_unit_vnd)}/chiếc` : cny(Number(sum?.total_cny ?? 0))}</span>
        <span>{tr(sum?.payable_vnd ?? 0)}</span>
      </span>
      <UnitCounts sum={sum} />
      {warns.length > 0 && <span className="row-wrap">{warns.map(([t, c]) => <span key={t} className={`pill ${c}`}>{t}</span>)}</span>}
      {withActs && next && (
        <div className="acts">
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={stop(() => onNext(l))}>{next === 'received' ? 'Nhận hàng' : `${LOT_LABEL[next]} →`}</button>
        </div>
      )}
    </div>
  )
}

/** CR-004 LOT-M1 + LOT-M3: dòng lô 2 dòng (điện thoại, research §3.4).
 *  Dòng 1: mã lô + tóm tắt model … Phải trả TG. Dòng 2: chip bước · "đặt N ngày" / "nhận dd/mm" (+ chip "Về trễ")
 *  · 1 cảnh báo ngắn … nút bước kế (lô mở) / "N chiếc" (lô đã nhận). Cả dòng mở chi tiết (link phủ dòng). */
export function LotRow2({ d, l, busy, onNext }: { d: DbData; l: LotRow; busy: boolean; onNext: (l: LotRow) => void }) {
  const sum = summaryOf(d, l.id), next = nextStatus(l.status)
  const days = daysOpen(l)
  const late = isLate(d, l)
  const warn = shortWarning(d, l)
  const code = d.lotCode[l.id] ?? 'Lô'
  return (
    <div className="lotrow">
      <span className="l1">
        <Link className="code num" to={`/lo/${l.id}`} aria-label={`Mở ${code}`}>{code}</Link>
        <span className="nm">{modelsText(d, sum)}</span>
      </span>
      <span className="r1 num">{tr(sum?.payable_vnd ?? 0)}</span>
      <span className="l2">
        <LotStepPill s={l.status} />
        {late && <span className="pill bad">Về trễ</span>}
        <span className="meta">
          {days != null ? `đặt ${days} ngày` : l.status === 'received' ? `nhận ${dmy(l.received_at)}` : `đặt ${dmy(l.ordered_at)}`}
          {warn && <> · <span className={warn[1] === 'bad' ? 'req' : ''}>{warn[0]}</span></>}
        </span>
      </span>
      <span className="r2">
        {isOpen(l.status) && next
          ? <button type="button" className="btn btn-ghost nx" disabled={busy} onClick={() => onNext(l)}>{next === 'received' ? 'Nhận hàng' : `→ ${LOT_SHORT[next]}`}</button>
          : <span className="muted small num">{sum?.total_qty ?? 0} chiếc</span>}
      </span>
    </div>
  )
}

/** Cảnh báo ngắn nhất cho dòng lô (tối đa 1): thiếu ship → người bán tránh → có đặt trước. */
export function shortWarning(d: DbData, l: LotRow): [string, string] | null {
  if (l.ship_fee_vnd == null && LOT_FLOW.indexOf(l.status) >= 1 && isOpen(l.status)) return ['thiếu ship', 'bad']
  const sm = summaryOf(d, l.id)
  if (sm && l.status !== 'cancelled' && sm.outstanding_vnd > 0) return [`nợ TG ${tr(sm.outstanding_vnd)}`, 'bad']
  if (sellerOf(d, l)?.is_avoided) return ['người bán tránh', 'bad']
  if (isOpen(l.status) && preordersOfLot(d, l.id).length) return ['có đặt trước', 'hold']
  return null
}

/** Dòng chiếc trong chi tiết lô (điện thoại, dòng Kho §2.4 + tình trạng - CR-004 KHO-S3).
 *  Dòng 1: mã + model … giá bán dự kiến / giá chốt. Dòng 2: chip trạng thái + chip tình trạng · seri … nhập. */
export function UnitRow2({ d, u }: { d: DbData; u: UnitViewRow }) {
  const holder = u.holding_order_id ? d.orderCode[u.holding_order_id] : undefined
  const price = u.status === 'sold' ? u.sold_price_vnd : u.list_price_vnd
  return (
    <Link className="lotrow unit" to={`/kho/${u.unit_id}`}>
      <span className="l1"><b className="code num">{u.code}</b><span className="nm">{u.model_name}</span></span>
      <span className="r1 num">{price != null ? tr(price) : '-'}</span>
      <span className="l2">
        <UnitChip s={u.status} holder={holder} lot={u.lot_status} order={u.holding_order_status} />
        <ConditionChip c={u.condition ?? 'new'} />
        {u.serial_no && <span className="meta">{u.serial_no}</span>}
      </span>
      <span className="r2 muted small num">nhập {tr(u.cost_vnd)}{u.cost_is_overridden ? ' (sửa tay)' : u.cost_is_provisional ? ' + ship' : ''}</span>
    </Link>
  )
}

/** Giá nhập ₫ hiệu lực của 1 chiếc: "sửa tay" khi có giá sửa tay; "+ ship" khi đang tạm tính (chưa có phí ship). */
export function UnitCost({ u }: { u: UnitViewRow }) {
  if (u.cost_is_overridden) return <>{vnd(u.cost_vnd)} <span className="pill hold">sửa tay</span></>
  if (u.cost_is_provisional) return <span className="muted">{vnd(u.cost_vnd)} + ship</span>
  return <>{vnd(u.cost_vnd)}</>
}

/** "KU-008, KU-009" hoặc "KU-008, KU-009, KU-010 +5" khi dài. */
export function codesText(codes: string[], max = 4): string {
  if (codes.length <= max) return codes.join(', ')
  return `${codes.slice(0, max).join(', ')} +${codes.length - max}`
}
/** Dãy mã liên tiếp (xem trước nhóm mới): "KU-008, KU-009" hoặc "KU-008 … KU-015". */
export function rangeText(codes: string[], max = 3): string {
  return codes.length <= max ? codes.join(', ') : `${codes[0]} … ${codes[codes.length - 1]}`
}
