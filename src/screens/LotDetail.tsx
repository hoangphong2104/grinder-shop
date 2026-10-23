// SC_05 Chi tiết lô: bước trạng thái, chuyển bước / nhận vào kho, khối tiền (v_lot_summary — số do DB tính), phí ship,
// danh sách chiếc của lô (v_units, CR-001), thông tin tin Goofish, huỷ.
import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useData, useStore } from '../data/store.tsx'
import { supabase } from '../lib/supabase.ts'
import { Shell } from '../ui/Shell.tsx'
import { Sheet, useToast } from '../ui/feedback.tsx'
import { Icon } from '../ui/icons.tsx'
import type { DbData, UnitViewRow } from '../data/types.ts'
import { LOT_FLOW, LOT_LABEL, UnitChip } from '../ui/status.tsx'
import { cny, dmy, vnd } from '../ui/format.ts'
import { errorMessage } from '../data/errors.ts'
import { isOpen, modelsText, nextStatus, sellerOf, summaryOf, UnitCost, UnitCounts, unitsOfLot, useIsDesk } from './lots/common.tsx'
import { useLotFlow } from './lots/LotFlow.tsx'
import '../styles/lots.css'

/** Link tin Goofish an toàn (chỉ http/https); không có link thì dựng từ item id. */
function goofishHref(url: string | null, itemId: string | null): string | null {
  if (url && /^https?:\/\//i.test(url.trim())) return url.trim()
  return itemId ? `https://www.goofish.com/item?id=${itemId}` : null
}

/** Ảnh chụp tin (bucket private-images) — xem bằng signed URL 1 giờ (ADR-08). */
function Screenshot({ path }: { path: string }) {
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
  const flow = useLotFlow()
  const desk = useIsDesk()
  const [noteOpen, setNoteOpen] = useState(false)
  const closeNote = useCallback(() => setNoteOpen(false), [])
  const l = d.lots.find((x) => x.id === id)

  if (!l) {
    return (
      <Shell section="lo" title="Lô nhập" back="/lo">
        <div className="empty">Không tìm thấy lô — có thể đã bị xoá. <Link className="link-btn" to="/lo">Về danh sách lô</Link></div>
      </Shell>
    )
  }

  const s = sellerOf(d, l), sum = summaryOf(d, l.id), units = unitsOfLot(d, l.id)
  const open = isOpen(l.status), next = nextStatus(l.status)
  const idx = LOT_FLOW.indexOf(l.status)
  const totalQty = sum?.total_qty ?? units.length
  const href = goofishHref(l.goofish_url, l.goofish_item_id)
  const provisional = sum?.cost_is_provisional ?? l.ship_fee_vnd == null

  return (
    <Shell section="lo" title={d.lotCode[l.id] ?? 'Lô'} back="/lo"
      actions={open ? <Link className="btn btn-ghost btn-sm" to={`/lo/${l.id}/sua`}>Sửa lô</Link> : undefined}>
      <div className="cols">
        <div>
          <div className={`stepper ${l.status === 'cancelled' ? 'cancel' : ''}`}>
            {LOT_FLOW.map((k, i) => (
              <div key={k} className={`st ${i < idx ? 'done' : i === idx ? 'cur' : ''}`}><span className="dot" /><span className="lb">{LOT_LABEL[k]}</span></div>
            ))}
          </div>
          {l.status === 'cancelled' && <div className="warn-box">Lô đã huỷ{l.cancelled_at ? ` ngày ${dmy(l.cancelled_at.slice(0, 10))}` : ''} — không tính vào tồn và công nợ.</div>}
          {open && next && (
            <button className="btn btn-primary btn-block" disabled={flow.busy === l.id} onClick={() => flow.next(l)}>Chuyển sang: {LOT_LABEL[next]}</button>
          )}
          {open && next !== 'received' && (
            <button className="btn btn-ghost btn-block" onClick={() => flow.receive(l)}>Nhận vào kho ngay</button>
          )}
          <div className="calc">
            <div className="ln"><span>Hàng</span><span>{modelsText(d, sum)}</span></div>
            <div className="ln"><span>Tiền hàng ({cny(Number(sum?.total_cny ?? 0))} × tỷ giá)</span><span>{vnd(sum?.goods_vnd ?? 0)}</span></div>
            <div className="ln"><span>Tỷ giá</span><span>{Number(l.exchange_rate).toLocaleString('vi-VN')} ₫/¥</span></div>
            <div className="ln"><span>Phí ship về VN (cả lô)</span><span>{l.ship_fee_vnd == null ? <span className="req">chưa nhập</span> : vnd(l.ship_fee_vnd)}</span></div>
            <div className="ln"><span>Ship / chiếc ({totalQty} chiếc)</span><span>{sum?.ship_per_unit_vnd != null ? vnd(sum.ship_per_unit_vnd) : '—'}</span></div>
            <div className="ln total"><span>Phải trả trung gian</span><span>{vnd(sum?.payable_vnd ?? 0)}</span></div>
            <div className="formula">Giá nhập ₫ / chiếc = giá ¥ của chiếc × tỷ giá + ship lô ÷ {totalQty} chiếc (sửa tay được từng chiếc)</div>
            {provisional && l.status !== 'cancelled' && <div className="formula">Giá nhập ₫ đang tạm tính — chưa gồm phí ship về VN.</div>}
          </div>
          {l.status !== 'cancelled' && (
            <button className="btn btn-ghost btn-block" onClick={() => flow.shipFee(l)}>{l.ship_fee_vnd == null ? 'Nhập phí ship về VN' : 'Sửa phí ship'}</button>
          )}
        </div>
        <div>
          <dl className="kv">
            <dt>Tin Goofish</dt>
            <dd>{href ? <a className="link-btn small" href={href} target="_blank" rel="noopener noreferrer">Mở tin <Icon name="ext" /></a> : '—'}</dd>
            <dt>Tiêu đề</dt><dd className="small">{l.listing_title || '—'}</dd>
            <dt>Người bán</dt>
            <dd>{s ? <><Link className="link-btn small" to={`/nguoiban/${s.id}`}>{s.nickname}</Link>{s.is_avoided && <> <span className="pill err">tránh</span></>}</> : '—'}</dd>
            <dt>Khu vực</dt><dd>{s?.region || '—'}</dd>
            <dt>Ngày đặt</dt><dd>{dmy(l.ordered_at)}</dd>
            <dt>Ngày nhận</dt><dd>{dmy(l.received_at)}</dd>
            <dt>Ghi chú</dt>
            <dd className="small">{l.note || '—'} <button className="link-btn small" onClick={() => setNoteOpen(true)}>Sửa</button></dd>
          </dl>
          {l.screenshot_path && <Screenshot path={l.screenshot_path} />}
          {open && <button className="btn btn-danger btn-block" onClick={() => flow.cancel(l)}>Huỷ lô</button>}
        </div>
      </div>

      <div className="row lot-units-head">
        <p className="section-title">Các chiếc trong lô ({units.length})</p>
        <UnitCounts sum={sum} />
      </div>
      {!units.length
        ? <div className="empty">Lô chưa có chiếc nào{open ? <> — bấm <Link className="link-btn" to={`/lo/${l.id}/sua`}>Sửa lô</Link> để thêm nhóm chiếc.</> : '.'}</div>
        : desk ? <UnitTable d={d} units={units} /> : <UnitList d={d} units={units} />}
      {l.status === 'received' && units.length > 0 && <p className="hint">Sửa giá nhập ₫ (sửa tay), giá bán dự kiến, số seri từng chiếc: bấm vào chiếc (A10).</p>}

      {flow.sheets}
      {noteOpen && <NoteSheet lotId={l.id} onClose={closeNote} />}
    </Shell>
  )
}

const holderCode = (d: DbData, u: UnitViewRow) => (u.holding_order_id ? d.orderCode[u.holding_order_id] : undefined)

/** Bảng chiếc (máy tính): mã → chi tiết chiếc; chip giữ/bán → đơn. */
function UnitTable({ d, units }: { d: DbData; units: UnitViewRow[] }) {
  const nav = useNavigate()
  return (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead><tr><th>Mã</th><th>Model</th><th className="r">Giá ¥</th><th className="r">Giá nhập ₫</th><th className="r">Giá bán dự kiến</th><th>Trạng thái</th></tr></thead>
        <tbody>
          {units.map((u) => {
            const go = () => nav(`/kho/${u.unit_id}`)
            const h = holderCode(d, u)
            return (
              <tr key={u.unit_id} data-act="go" tabIndex={0} onClick={go} onKeyDown={(e) => { if (e.key === 'Enter') go() }}>
                <td><Link className="link-btn" to={`/kho/${u.unit_id}`} onClick={(e) => e.stopPropagation()}>{u.code}</Link>{u.serial_no ? <span className="muted small"> · {u.serial_no}</span> : null}</td>
                <td>{u.model_name}</td>
                <td className="r">{cny(Number(u.price_cny))}</td>
                <td className="r"><UnitCost u={u} /></td>
                <td className="r">{u.list_price_vnd != null ? vnd(u.list_price_vnd) : '—'}</td>
                <td>
                  {u.holding_order_id
                    ? <Link to={`/don/${u.holding_order_id}`} onClick={(e) => e.stopPropagation()} aria-label={`Mở đơn ${h ?? ''}`}><UnitChip s={u.status} holder={h} /></Link>
                    : <UnitChip s={u.status} />}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Danh sách chiếc (điện thoại): mỗi dòng mở chi tiết chiếc. */
function UnitList({ d, units }: { d: DbData; units: UnitViewRow[] }) {
  return (
    <div className="list">
      {units.map((u) => (
        <Link key={u.unit_id} className="li" to={`/kho/${u.unit_id}`}>
          <div className="main">
            <b>{u.code}</b> <span className="muted small">{u.model_name}</span>
            <div className="s">{cny(Number(u.price_cny))} · nhập <UnitCost u={u} /></div>
            <div className="s">Bán dự kiến {u.list_price_vnd != null ? vnd(u.list_price_vnd) : '—'}</div>
          </div>
          <UnitChip s={u.status} holder={holderCode(d, u)} />
          <Icon name="chev" size={16} />
        </Link>
      ))}
    </div>
  )
}

/** Ghi chú lô — ghi thẳng cột lots.note (được grant), chặn sửa đồng thời bằng version. */
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
    <Sheet title="Ghi chú lô" onClose={onClose}
      footer={<button className="btn btn-primary btn-block" disabled={sending} onClick={submit}>{sending ? <><span className="spin" /> Đang lưu…</> : 'Lưu'}</button>}>
      <label className="f">Ghi chú<textarea className="input" id="lot-note" value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} /></label>
      {err && <p className="err-text" role="alert">{err}</p>}
    </Sheet>
  )
}
