// Dùng chung cho nhóm màn Lô nhập: tra cứu, cảnh báo, thẻ lô (bảng cột) và dòng lô (điện thoại).
import { useEffect, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { DbData, LotLineRow, LotRow, LotStatusDb, LotSummaryRow } from '../../data/types.ts'
import { LOT_FLOW, LOT_LABEL, LotChip } from '../../ui/status.tsx'
import { cny, dmy, tr, vnd } from '../../ui/format.ts'
import { roundVnd } from '../../domain/index.ts'

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

/** "K Ultra · Đen" */
export function variantName(d: DbData, variantId: string): string {
  const v = d.variants.find((x) => x.id === variantId)
  if (!v) return '?'
  const m = d.models.find((x) => x.id === v.model_id)
  return `${m?.name ?? '?'} · ${v.name}`
}
export const linesOf = (d: DbData, lotId: string): LotLineRow[] => d.lotLines.filter((x) => x.lot_id === lotId).sort((a, b) => a.line_no - b.line_no)
export const summaryOf = (d: DbData, lotId: string): LotSummaryRow | undefined => d.lotSummary.find((x) => x.lot_id === lotId)
export const lotLinesText = (d: DbData, lotId: string) => linesOf(d, lotId).map((x) => `${x.qty} × ${variantName(d, x.variant_id)}`).join(', ')
export const totalCny = (lines: LotLineRow[]) => lines.reduce((a, x) => a + x.qty * Number(x.price_cny), 0)
/** Tiền hàng 1 dòng (₫) = SL × giá ¥ × tỷ giá. */
export const lineGoodsVnd = (lot: LotRow, x: LotLineRow) => roundVnd(x.qty * Number(x.price_cny) * Number(lot.exchange_rate))
export const isOpen = (s: LotStatusDb) => s !== 'received' && s !== 'cancelled'
/** Bước kế tiếp trong luồng (null nếu đã nhận / huỷ). */
export function nextStatus(s: LotStatusDb): LotStatusDb | null {
  const i = LOT_FLOW.indexOf(s)
  return i >= 0 && i < LOT_FLOW.length - 1 ? LOT_FLOW[i + 1] : null
}
export const sellerOf = (d: DbData, l: LotRow) => (l.seller_id ? d.sellers.find((s) => s.id === l.seller_id) : undefined)
/** Mới nhất trước: ngày đặt, rồi thời điểm tạo. */
export const byNewest = (a: LotRow, b: LotRow) => b.ordered_at.localeCompare(a.ordered_at) || b.created_at.localeCompare(a.created_at)

/** Đơn Đặt trước đang chờ có dòng thuộc các biến thể của lô. */
export function pendingPreorders(d: DbData, lotId: string) {
  const vids = new Set(linesOf(d, lotId).map((x) => x.variant_id))
  return d.orders.filter((o) => o.status === 'preorder' && d.orderLines.some((ol) => ol.order_id === o.id && vids.has(ol.variant_id)))
}

/** Chip cảnh báo trên thẻ lô (prototype lotCard). */
export function lotWarnings(d: DbData, l: LotRow): [string, string][] {
  const w: [string, string][] = []
  const idx = LOT_FLOW.indexOf(l.status)
  if (l.ship_fee_vnd == null && idx >= 2 && isOpen(l.status)) w.push(['Thiếu phí ship', 'bad'])
  if (sellerOf(d, l)?.is_avoided) w.push(['Người bán bị đánh dấu tránh', 'bad'])
  if (isOpen(l.status) && pendingPreorders(d, l.id).length) w.push(['Có đơn đặt trước đang chờ', 'hold'])
  return w
}

const stop = (fn: () => void) => (e: MouseEvent) => { e.stopPropagation(); fn() }

/** Thẻ lô trong bảng cột / danh sách theo bước (prototype lotCard). */
export function LotCard({ d, l, withActs, busy, onShipFee, onNext }: {
  d: DbData; l: LotRow; withActs: boolean; busy: boolean; onShipFee: (l: LotRow) => void; onNext: (l: LotRow) => void
}) {
  const nav = useNavigate()
  const s = sellerOf(d, l), sum = summaryOf(d, l.id), lines = linesOf(d, l.id), next = nextStatus(l.status)
  const go = () => nav(`/lo/${l.id}`)
  const key = (e: KeyboardEvent) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); go() } }
  return (
    <div className="kcard" role="button" tabIndex={0} onClick={go} onKeyDown={key}>
      <span className="t">{d.lotCode[l.id]} · {lotLinesText(d, l.id)}</span>
      <span className="s">{s?.nickname ?? 'Chưa rõ người bán'} · {l.status === 'received' ? `nhận ${dmy(l.received_at)}` : `đặt ${dmy(l.ordered_at)}`}</span>
      <span className="m">
        <span>{l.status === 'received' ? lines.map((x) => `${tr(x.unit_cost_vnd)}/chiếc`).join(', ') : cny(totalCny(lines))}</span>
        <span>{tr(sum?.payable_vnd ?? 0)}</span>
      </span>
      {lotWarnings(d, l).length > 0 && (
        <span className="row-wrap">{lotWarnings(d, l).map(([t, c]) => <span key={t} className={`pill ${c}`}>{t}</span>)}</span>
      )}
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
  const s = sellerOf(d, l), sum = summaryOf(d, l.id), lines = linesOf(d, l.id)
  return (
    <Link className="shot" to={`/lo/${l.id}`}>
      <span className="t">{d.lotCode[l.id]} · đặt {dmy(l.ordered_at)} · {s?.nickname ?? 'Chưa rõ người bán'}</span>
      <span className="b">{lotLinesText(d, l.id)}</span>
      <span className="r"><LotChip s={l.status} /><span className="num small">{tr(sum?.payable_vnd ?? 0)}</span></span>
      <span className="f">
        {cny(totalCny(lines))} × {Number(l.exchange_rate).toLocaleString('vi-VN')} · ship {l.ship_fee_vnd == null ? <span className="req">chưa nhập</span> : tr(l.ship_fee_vnd)}
      </span>
    </Link>
  )
}

/** Giá vốn / chiếc của dòng lô — tạm tính khi chưa có phí ship. */
export function UnitCost({ l, x }: { l: LotRow; x: LotLineRow }) {
  return l.ship_fee_vnd == null ? <span className="muted">{vnd(x.unit_cost_vnd)} + ship</span> : <>{vnd(x.unit_cost_vnd)}</>
}
