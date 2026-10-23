// Dùng chung cho nhóm màn Lô nhập (v0.2, CR-001 quản lý từng chiếc): tra cứu, cảnh báo, thẻ lô (bảng cột),
// dòng lô (điện thoại), tóm tắt model + đếm trạng thái chiếc của lô (v_lot_summary), ô giá nhập ₫ của 1 chiếc.
import { useEffect, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { DbData, LotRow, LotStatusDb, LotSummaryRow, UnitViewRow } from '../../data/types.ts'
import { LOT_FLOW, LOT_LABEL, LotChip } from '../../ui/status.tsx'
import { cny, dmy, tr, vnd } from '../../ui/format.ts'

/** Màn hình máy tính (≥ 960px) — đổi theo kích thước cửa sổ. */
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

/** Tiền tố mã của model (KU) — không có thì dùng tên model. */
export const prefixOf = (d: DbData, modelId: string, fallback = '?') => d.models.find((m) => m.id === modelId)?.code_prefix ?? fallback
/** "2 × KU, 1 × JU" từ v_lot_summary.models. */
export function modelsText(d: DbData, sum: LotSummaryRow | undefined): string {
  const ms = sum?.models ?? []
  return ms.length ? ms.map((m) => `${m.qty} × ${prefixOf(d, m.model_id, m.model_name)}`).join(', ') : 'Chưa có chiếc nào'
}
/** Đếm trạng thái chiếc của lô: [nhãn, tone pill] — chỉ các trạng thái có chiếc. */
export function unitCounts(sum: LotSummaryRow | undefined): [string, string][] {
  if (!sum) return []
  const out: [string, string][] = []
  if (sum.incoming_count) out.push([`${sum.incoming_count} đang về`, 'way'])
  if (sum.in_stock_count) out.push([`${sum.in_stock_count} trong kho`, 'ok'])
  if (sum.reserved_count) out.push([`${sum.reserved_count} đã giữ`, 'hold'])
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
  if (l.ship_fee_vnd == null && idx >= 2 && isOpen(l.status)) w.push(['Thiếu phí ship', 'bad'])
  if (sellerOf(d, l)?.is_avoided) w.push(['Người bán bị đánh dấu tránh', 'bad'])
  if (isOpen(l.status) && preordersOfLot(d, l.id).length) w.push(['Có đơn đặt trước đang chờ', 'hold'])
  return w
}

const stop = (fn: () => void) => (e: MouseEvent) => { e.stopPropagation(); fn() }

/** Thẻ lô trong bảng cột / danh sách theo bước (prototype lotCard). */
export function LotCard({ d, l, withActs, busy, onShipFee, onNext }: {
  d: DbData; l: LotRow; withActs: boolean; busy: boolean; onShipFee: (l: LotRow) => void; onNext: (l: LotRow) => void
}) {
  const nav = useNavigate()
  const s = sellerOf(d, l), sum = summaryOf(d, l.id), next = nextStatus(l.status)
  const go = () => nav(`/lo/${l.id}`)
  const key = (e: KeyboardEvent) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); go() } }
  const warns = lotWarnings(d, l)
  return (
    <div className="kcard" role="button" tabIndex={0} onClick={go} onKeyDown={key}>
      <span className="t">{d.lotCode[l.id]} · {modelsText(d, sum)}</span>
      <span className="s">{s?.nickname ?? 'Chưa rõ người bán'} · {l.status === 'received' ? `nhận ${dmy(l.received_at)}` : `đặt ${dmy(l.ordered_at)}`}</span>
      <span className="m">
        <span>{l.status === 'received' && sum?.ship_per_unit_vnd != null ? `ship ${tr(sum.ship_per_unit_vnd)}/chiếc` : cny(Number(sum?.total_cny ?? 0))}</span>
        <span>{tr(sum?.payable_vnd ?? 0)}</span>
      </span>
      <UnitCounts sum={sum} />
      {warns.length > 0 && <span className="row-wrap">{warns.map(([t, c]) => <span key={t} className={`pill ${c}`}>{t}</span>)}</span>}
      {withActs && next && (
        <div className="acts">
          {l.ship_fee_vnd == null && <button className="btn btn-ghost btn-sm" disabled={busy} onClick={stop(() => onShipFee(l))}>Phí ship</button>}
          <button className="btn btn-primary btn-sm" disabled={busy} onClick={stop(() => onNext(l))}>{LOT_LABEL[next]} →</button>
        </div>
      )}
    </div>
  )
}

/** Dòng lô (danh sách trên điện thoại, prototype lotRow). */
export function LotRowItem({ d, l }: { d: DbData; l: LotRow }) {
  const s = sellerOf(d, l), sum = summaryOf(d, l.id)
  return (
    <Link className="shot" to={`/lo/${l.id}`}>
      <span className="t">{d.lotCode[l.id]} · đặt {dmy(l.ordered_at)} · {s?.nickname ?? 'Chưa rõ người bán'}</span>
      <span className="b">{modelsText(d, sum)}</span>
      <span className="r"><LotChip s={l.status} /><span className="num small">{tr(sum?.payable_vnd ?? 0)}</span></span>
      <span className="f">
        {cny(Number(sum?.total_cny ?? 0))} × {Number(l.exchange_rate).toLocaleString('vi-VN')} · ship {l.ship_fee_vnd == null ? <span className="req">chưa nhập</span> : tr(l.ship_fee_vnd)}
      </span>
      {unitCounts(sum).length > 0 && <span className="f"><UnitCounts sum={sum} /></span>}
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
