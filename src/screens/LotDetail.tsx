// SC_05 Chi tiết lô: bước trạng thái, chuyển bước / nhận vào kho, khối tiền (số do DB tính), phí ship, thông tin tin Goofish, huỷ.
import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useData, useStore } from '../data/store.tsx'
import { supabase } from '../lib/supabase.ts'
import { Shell } from '../ui/Shell.tsx'
import { Sheet, useToast } from '../ui/feedback.tsx'
import { Icon } from '../ui/icons.tsx'
import { LOT_FLOW, LOT_LABEL } from '../ui/status.tsx'
import { cny, dmy, vnd } from '../ui/format.ts'
import { errorMessage } from '../data/errors.ts'
import { isOpen, lineGoodsVnd, linesOf, nextStatus, sellerOf, summaryOf, UnitCost, variantName } from './lots/common.tsx'
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

  const s = sellerOf(d, l), sum = summaryOf(d, l.id), lines = linesOf(d, l.id)
  const open = isOpen(l.status), next = nextStatus(l.status)
  const idx = LOT_FLOW.indexOf(l.status)
  const totalQty = sum?.total_qty ?? lines.reduce((a, x) => a + x.qty, 0)
  const href = goofishHref(l.goofish_url, l.goofish_item_id)

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
            {lines.map((x) => (
              <div className="ln" key={x.id}><span>{x.qty} × {variantName(d, x.variant_id)} @ {cny(Number(x.price_cny))}</span><span>{vnd(lineGoodsVnd(l, x))}</span></div>
            ))}
            <div className="ln"><span>Tỷ giá</span><span>{Number(l.exchange_rate).toLocaleString('vi-VN')} ₫/¥</span></div>
            <div className="ln"><span>Phí ship về VN (cả lô)</span><span>{l.ship_fee_vnd == null ? <span className="req">chưa nhập</span> : vnd(l.ship_fee_vnd)}</span></div>
            <div className="ln total"><span>Phải trả trung gian</span><span>{vnd(sum?.payable_vnd ?? 0)}</span></div>
            {lines.map((x) => (
              <div className="ln" key={x.id}><span>Giá vốn / chiếc · {d.variants.find((v) => v.id === x.variant_id)?.name ?? '?'}</span><span><UnitCost l={l} x={x} /></span></div>
            ))}
            <div className="formula">= giá web ¥ × tỷ giá + ship lô ÷ {totalQty} chiếc</div>
            {l.ship_fee_vnd == null && l.status !== 'cancelled' && <div className="formula">Giá vốn đang tạm tính — chưa gồm phí ship về VN.</div>}
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
      {flow.sheets}
      {noteOpen && <NoteSheet lotId={l.id} onClose={closeNote} />}
    </Shell>
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
