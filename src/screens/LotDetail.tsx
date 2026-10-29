// SC_05 Chi tiết lô (CR-006: chỉ còn cho lô cũ nhiều chiếc; lô 1 chiếc chuyển sang trang cối): bước trạng thái, chuyển bước / nhận vào kho, khối tiền (v_lot_summary - số do DB tính), phí ship,
// danh sách chiếc của lô (v_units, CR-001), thông tin tin Goofish, huỷ.
// CR-004: thanh dính đáy (chuyển bước + phí ship), menu ⋯ (Sửa / Ghi chú / Nhận ngay / Huỷ), chip Về trễ + đặt N ngày,
// dòng chiếc 2 dòng có tình trạng, khối "Giá nhập từng chiếc" (LOT-M4, LOT-S2, LOT-S3, KHO-S3).
// CR-005: Kho TQ → Kho VN → Kho Lumi; đã trả / còn nợ trung gian + nút "Đã thanh toán" (pay_lot); người bán hiện ngay ở đây (bỏ màn Người bán).
import { useCallback, useEffect, useState } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { useData, useStore } from '../data/store.tsx'
import { supabase } from '../lib/supabase.ts'
import { Shell } from '../ui/Shell.tsx'
import { Sheet, useToast } from '../ui/feedback.tsx'
import { Icon } from '../ui/icons.tsx'
import type { DbData, UnitViewRow } from '../data/types.ts'
import { ConditionChip, LOT_FLOW, LotChip, UnitChip } from '../ui/status.tsx'
import { cny, dmy, pct, tr, vnd } from '../ui/format.ts'
import { roundVnd, unitCostBeforeShip } from '../domain/index.ts'
import { errorMessage } from '../data/errors.ts'
import { codesText, daysOpen, isOpen, LOT_SHORT, lotFeePct, lotWarnings, modelsText, nextStatus, sellerOf, summaryOf, UnitCost, UnitCounts, UnitRow2, unitsOfLot, useIsDesk } from './lots/common.tsx'
import { useLotFlow } from './lots/LotFlow.tsx'
import { PayLotButton } from './lots/PayLot.tsx'
import '../styles/lots.css'
import { lotName } from './overview/common.tsx'

/** Link tin Goofish an toàn (chỉ http/https); không có link thì dựng từ item id. */
export function goofishHref(url: string | null, itemId: string | null): string | null {
  if (url && /^https?:\/\//i.test(url.trim())) return url.trim()
  return itemId ? `https://www.goofish.com/item?id=${itemId}` : null
}

/** Ảnh chụp tin (bucket private-images) - xem bằng signed URL 1 giờ (ADR-08). */
export function Screenshot({ path }: { path: string }) {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    setUrl(null); setFailed(false)
    supabase.storage.from('private-images').createSignedUrl(path, 3600).then(({ data, error }) => {
      if (!alive) return
      if (error || !data) setFailed(true)
      else setUrl(data.signedUrl)
    })
    return () => { alive = false }
  }, [path])
  if (!url) return <div className="shot-thumb lot-shot">{failed ? 'Không tải được ảnh' : 'ẢNH TIN'}</div>
  return (
    <a className="shot-thumb lot-shot" href={url} target="_blank" rel="noopener noreferrer" aria-label="Mở ảnh chụp tin">
      <img src={url} alt="Ảnh chụp tin Goofish" />
    </a>
  )
}

export default function LotDetail() {
  const { id = '' } = useParams()
  const d = useData()
  const nav = useNavigate()
  const flow = useLotFlow()
  const desk = useIsDesk()
  const [noteOpen, setNoteOpen] = useState(false)
  const [menu, setMenu] = useState(false)
  const closeNote = useCallback(() => setNoteOpen(false), [])
  const l = d.lots.find((x) => x.id === id)

  if (!l) {
    return (
      <Shell section="kho" title="Cối mua" back="/kho">
        <div className="empty">Không tìm thấy - có thể đã bị xoá. <Link className="link-btn" to="/kho">Về Kho</Link></div>
      </Shell>
    )
  }

  const s = sellerOf(d, l), sum = summaryOf(d, l.id), units = unitsOfLot(d, l.id)
  // CR-006: 1 lô = 1 cối ⇒ trang lô là trang cối
  if (units.length === 1) return <Navigate to={`/kho/${units[0].unit_id}`} replace />
  const open = isOpen(l.status), next = nextStatus(l.status)
  const idx = LOT_FLOW.indexOf(l.status)
  const totalQty = sum?.total_qty ?? units.length
  const href = goofishHref(l.goofish_url, l.goofish_item_id)
  const provisional = sum?.cost_is_provisional ?? l.ship_fee_vnd == null
  const feePct = lotFeePct(l)
  const days = daysOpen(l)
  const warns = lotWarnings(d, l)
  const rate = Number(l.exchange_rate)
  // Đóng menu rồi mới mở sheet khác
  const act = (fn: () => void) => () => { setMenu(false); fn() }

  // LOT-M4: thanh dính đáy - chuyển bước (chính) + phí ship (phụ), chỉ khi lô đang mở
  const savebar = open && next ? (
    <>
      <button className="btn btn-ghost" id="lot-ship" style={{ flex: 1 }} onClick={() => flow.shipFee(l)}>Ship VN → Lumi</button>
      <button className="btn btn-primary" id="lot-next" style={{ flex: 2 }} disabled={flow.busy === l.id} onClick={() => flow.next(l)}>
        {flow.busy === l.id ? <><span className="spin" /> Đang chuyển…</> : next === 'received' ? 'Nhận vào Kho Lumi' : `Chuyển sang: ${LOT_SHORT[next]}`}
      </button>
    </>
  ) : undefined

  return (
    <Shell section="kho" title={lotName(d, l.id)} back="/kho" savebar={savebar}
      actions={<button className="icon-btn more-btn" id="lot-more" aria-label="Thao tác khác" aria-haspopup="dialog" onClick={() => setMenu(true)}>⋯</button>}>
      <div className="lot-detail">
        <div className="lot-sum">
          <LotChip s={l.status} />
          {sum?.is_lot_late && <span className="pill bad">Về trễ</span>}
          <span>{days != null ? `đặt ${days} ngày (${dmy(l.ordered_at)})` : l.status === 'received' ? `nhận ${dmy(l.received_at)}` : `đặt ${dmy(l.ordered_at)}`}</span>
          <span>, <b>{modelsText(d, sum)}</b></span>
          {warns.filter(([t]) => t !== 'Về trễ').map(([t, c]) => <span key={t} className={`pill ${c}`}>{t}</span>)}
        </div>
        <div className="cols">
          <div>
            <div className={`stepper ${l.status === 'cancelled' ? 'cancel' : ''}`}>
              {LOT_FLOW.map((k, i) => (
                <div key={k} className={`st ${i < idx ? 'done' : i === idx ? 'cur' : ''}`}><span className="dot" /><span className="lb">{LOT_SHORT[k]}</span></div>
              ))}
            </div>
            {l.status === 'cancelled' && <div className="warn-box">Lô đã huỷ{l.cancelled_at ? ` ngày ${dmy(l.cancelled_at.slice(0, 10))}` : ''} - không tính vào tồn và công nợ.</div>}
            <div className="calc">
              <div className="ln"><span>Tiền hàng, {cny(Number(sum?.total_cny ?? 0))} × {rate.toLocaleString('vi-VN')}</span><span>{vnd(sum?.goods_vnd ?? 0)}</span></div>
              <div className="ln"><span>Phí mua hộ {pct(feePct)}</span><span>{vnd(sum?.buying_fee_vnd ?? 0)}</span></div>
              <div className="ln"><span>Ship TQ → VN</span><span>{l.ship_fee_vnd == null ? <span className="muted">chưa tất toán</span> : vnd(l.ship_fee_vnd)}</span></div>
              <div className="ln"><span>Ship kho VN → Lumi</span><span>{l.local_ship_vnd ? vnd(l.local_ship_vnd) : <span className="muted">chưa có</span>}</span></div>
              <div className="ln"><span>Ship / chiếc ({totalQty})</span><span>{sum?.ship_per_unit_vnd != null ? vnd(sum.ship_per_unit_vnd) : '-'}</span></div>
              <div className="ln total"><span>Phải trả trung gian</span><span>{vnd(sum?.payable_vnd ?? 0)}</span></div>
              {l.status !== 'cancelled' && sum && <>
                <div className="ln"><span>Đã trả trung gian</span><span>{vnd(sum.paid_vnd)}</span></div>
                <div className="ln"><span><b>{sum.outstanding_vnd < 0 ? 'Trả dư' : 'Còn nợ trung gian'}</b></span><span className={sum.outstanding_vnd > 0 ? 'req' : 'ok-t'}><b>{sum.outstanding_vnd === 0 ? 'đã trả đủ' : vnd(Math.abs(sum.outstanding_vnd))}</b></span></div>
              </>}
              {l.status === 'received' && <div className="formula">Lô đã nhận: phí mua hộ và tỷ giá đã khoá (sai thì ghi Điều chỉnh nợ ở Sổ quỹ).</div>}
              {provisional && l.status !== 'cancelled' && <div className="formula">Giá nhập ₫ đang tạm tính - chưa tất toán ship TQ → VN (Sổ quỹ).</div>}
            </div>
            <PayLotButton lotId={l.id} id="lot-pay" className="btn btn-primary btn-block" />
            {l.status === 'received' && (
              <button className="btn btn-ghost btn-block" id="lot-ship-fix" onClick={() => flow.shipFee(l)}>Sửa ship VN → Lumi</button>
            )}
          </div>
          <div>
            <dl className="kv">
              <dt>Tin Goofish</dt>
              <dd>{href ? <a className="link-btn small lot-ext" href={href} target="_blank" rel="noopener noreferrer">Mở tin <Icon name="ext" /></a> : '-'}</dd>
              <dt>Tiêu đề</dt><dd className="small">{l.listing_title || '-'}</dd>
              <dt>Người bán</dt>
              <dd>{s ? <>{s.profile_url && /^https?:\/\//i.test(s.profile_url) ? <a className="link-btn small lot-ext" href={s.profile_url} target="_blank" rel="noopener noreferrer">{s.nickname} <Icon name="ext" /></a> : <b>{s.nickname}</b>}{s.is_avoided && <> <span className="pill bad">tránh</span></>}</> : '-'}</dd>
              <dt>Khu vực</dt><dd>{s?.region || '-'}</dd>
              {s?.reputation_note && <><dt>Uy tín người bán</dt><dd className="small">{s.reputation_note}</dd></>}
              <dt>Ngày đặt</dt><dd>{dmy(l.ordered_at)}{days != null ? `, ${days} ngày` : ''}</dd>
              <dt>Ngày nhận</dt><dd>{dmy(l.received_at)}</dd>
              <dt>Ghi chú</dt><dd className="small">{l.note || '-'}</dd>
            </dl>
            {l.screenshot_path && <Screenshot path={l.screenshot_path} />}
          </div>
        </div>

        <div className="row lot-units-head">
          <p className="section-title">Các chiếc mua cùng ({units.length})</p>
          <UnitCounts sum={sum} />
        </div>
        {!units.length
          ? <div className="empty">Lô chưa có chiếc nào{open ? <> - bấm <Link className="link-btn" to={`/lo/${l.id}/sua`}>Sửa lô</Link> để thêm nhóm chiếc.</> : '.'}</div>
          : desk ? <UnitTable d={d} units={units} /> : <div className="ulist">{units.map((u) => <UnitRow2 key={u.unit_id} d={d} u={u} />)}</div>}
        {units.length > 0 && l.status !== 'cancelled' && <CostBreakdown units={units} rate={rate} feePct={feePct} shipPer={l.ship_fee_vnd == null && !l.local_ship_vnd ? null : roundVnd(((l.ship_fee_vnd ?? 0) + (l.local_ship_vnd ?? 0)) / units.length)} />}
        {l.status === 'received' && units.length > 0 && <p className="hint">Sửa giá nhập ₫ (sửa tay), giá bán dự kiến, seri, tình trạng: bấm vào chiếc.</p>}
      </div>

      {flow.sheets}
      {noteOpen && <NoteSheet lotId={l.id} onClose={closeNote} />}
      {menu && (
        <Sheet title={`Thao tác ${lotName(d, l.id)}`} onClose={() => setMenu(false)}>
          <div className="list">
            {open && <button className="li" id="m-edit" onClick={act(() => nav(`/lo/${l.id}/sua`))}><div className="main"><b>Sửa lô</b><div className="s">Link, người bán, tỷ giá, nhóm chiếc</div></div><Icon name="chev" size={16} /></button>}
            {open && next !== 'received' && <button className="li" id="m-receive" onClick={act(() => flow.receive(l))}><div className="main"><b>Nhận vào Kho Lumi ngay</b><div className="s">Bỏ qua các bước còn lại</div></div><Icon name="chev" size={16} /></button>}
            <button className="li" id="m-note" onClick={act(() => setNoteOpen(true))}><div className="main"><b>Ghi chú lô</b><div className="s">{l.note || 'Chưa có ghi chú'}</div></div><Icon name="chev" size={16} /></button>
            {open && <button className="li menu-danger" id="m-cancel" onClick={act(() => flow.cancel(l))}><div className="main"><b>Huỷ lô</b><div className="s">Không hoàn tác được</div></div></button>}
          </div>
        </Sheet>
      )}
    </Shell>
  )
}

/** LOT-S3: giá nhập từng chiếc = ¥ × tỷ giá + phí mua hộ % + ship ÷ số chiếc (gom theo model + giá ¥; chiếc sửa tay riêng).
 *  Số ₫ lấy từ v_units (DB tính); chỉ phần "trước ship" tính lại ở client để hiện cách cộng. */
function CostBreakdown({ units, rate, feePct, shipPer }: { units: UnitViewRow[]; rate: number; feePct: number; shipPer: number | null }) {
  const groups = new Map<string, { codes: string[]; prefix: string; cny: number; cost: number }>()
  for (const u of units) {
    if (u.cost_is_overridden) continue
    const k = `${u.model_id}|${Number(u.price_cny)}`
    const g = groups.get(k) ?? { codes: [], prefix: u.code_prefix, cny: Number(u.price_cny), cost: u.cost_vnd_auto }
    g.codes.push(u.code)
    groups.set(k, g)
  }
  const over = units.filter((u) => u.cost_is_overridden)
  return (
    <>
      <p className="section-title">Giá nhập từng chiếc</p>
      <div className="calc lot-calc">
        {[...groups.values()].map((g) => {
          const base = unitCostBeforeShip({ priceCny: g.cny }, { rate, buyingFeePct: feePct })
          return (
            <div className="cb" key={`${g.prefix}|${g.cny}`}>
              <div className="ln"><span>{codesText(g.codes, 3)}</span><span>{vnd(g.cost)}{shipPer == null ? ' + ship' : ''}</span></div>
              <div className="formula">{cny(g.cny)} × {rate.toLocaleString('vi-VN')}{feePct > 0 ? ` + ${pct(feePct)}` : ''} = {tr(base)} + ship {shipPer != null ? tr(shipPer) : 'chưa có'}</div>
            </div>
          )
        })}
        {over.map((u) => (
          <div className="cb" key={u.unit_id}>
            <div className="ln"><span>{u.code}, sửa tay</span><span>{vnd(u.cost_vnd)}</span></div>
            <div className="formula">tự tính {vnd(u.cost_vnd_auto)}</div>
          </div>
        ))}
        <div className="formula cb-f">= giá ¥ × tỷ giá × (1 + phí {pct(feePct)}) + ship ÷ {units.length} chiếc{shipPer == null ? ', chưa có ship' : ''}</div>
      </div>
    </>
  )
}

const holderCode = (d: DbData, u: UnitViewRow) => (u.holding_order_id ? d.orderCode[u.holding_order_id] : undefined)

/** Bảng chiếc (máy tính): mã → chi tiết chiếc; chip giữ/bán → đơn. CR-004: cột Tình trạng. */
function UnitTable({ d, units }: { d: DbData; units: UnitViewRow[] }) {
  const nav = useNavigate()
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead><tr><th>Mã</th><th>Model</th><th>Tình trạng</th><th className="r">Giá ¥</th><th className="r">Giá nhập ₫</th><th className="r">Giá bán dự kiến</th><th>Trạng thái</th></tr></thead>
        <tbody>
          {units.map((u) => {
            const go = () => nav(`/kho/${u.unit_id}`)
            const h = holderCode(d, u)
            return (
              <tr key={u.unit_id} data-act="go" tabIndex={0} onClick={go} onKeyDown={(e) => { if (e.key === 'Enter') go() }}>
                <td><Link className="link-btn" to={`/kho/${u.unit_id}`} onClick={(e) => e.stopPropagation()}>{u.code}</Link>{u.serial_no ? <span className="muted small">, {u.serial_no}</span> : null}</td>
                <td>{u.model_name}</td>
                <td><ConditionChip c={u.condition ?? 'new'} /></td>
                <td className="r">{cny(Number(u.price_cny))}</td>
                <td className="r"><UnitCost u={u} /></td>
                <td className="r">{u.list_price_vnd != null ? vnd(u.list_price_vnd) : '-'}</td>
                <td>
                  {u.holding_order_id
                    ? <Link to={`/don/${u.holding_order_id}`} onClick={(e) => e.stopPropagation()} aria-label={`Mở đơn ${h ?? ''}`}><UnitChip s={u.status} holder={h} lot={u.lot_status} order={u.holding_order_status} /></Link>
                    : <UnitChip s={u.status} lot={u.lot_status} />}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Ghi chú lô - ghi thẳng cột lots.note (được grant), chặn sửa đồng thời bằng version. */
function NoteSheet({ lotId, onClose }: { lotId: string; onClose: () => void }) {
  const d = useData()
  const { reload } = useStore()
  const toast = useToast()
  const l = d.lots.find((x) => x.id === lotId)
  const [note, setNote] = useState(l?.note ?? '')
  const [err, setErr] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  if (!l) return null
  const submit = async () => {
    if (note.length > 2000) return setErr('Ghi chú tối đa 2.000 ký tự.')
    setErr(null); setSending(true)
    const { data, error } = await supabase.from('lots').update({ note: note.trim() || null }).eq('id', l.id).eq('version', l.version).select('id')
    if (error) { setErr(errorMessage(error)); setSending(false); return }
    if (!data?.length) { await reload(); setErr(errorMessage('VERSION_CONFLICT')); setSending(false); return }
    await reload()
    toast('Đã lưu ghi chú')
    onClose()
  }
  return (
    <Sheet title="Ghi chú mua" onClose={onClose}
      footer={<button className="btn btn-primary btn-block" disabled={sending} onClick={submit}>{sending ? <><span className="spin" /> Đang lưu…</> : 'Lưu'}</button>}>
      <label className="f">Ghi chú<textarea className="input" id="lot-note" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} /></label>
      {err && <p className="err-text" role="alert">{err}</p>}
    </Sheet>
  )
}
