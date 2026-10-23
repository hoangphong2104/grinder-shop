// Ghi chú khi bán hàng (CR-002, làm lại theo kiểu Google Keep / Apple Notes - Chủ dự án 2026-10-23: "không bắt mắt, không hiện hết ghi chú").
// - Thẻ màu, dòng đầu = tiêu đề, HIỆN ĐỦ nội dung (ghi chú rất dài: gập + "Xem thêm" mở ngay trên thẻ).
// - Bấm thẻ → màn sửa toàn màn hình, ô chữ tự giãn; Xong / quay lại = tự lưu. Ghim, đổi màu, xoá ngay trong màn sửa.
// - Tìm không dấu; nhóm Đã ghim / Khác. Lưu trên cloud, đồng bộ realtime.
import '../styles/notes.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase.ts'
import { useData, useStore } from '../data/store.tsx'
import { errorMessage } from '../data/errors.ts'
import type { NoteColor, NoteRow } from '../data/types.ts'
import { Shell } from '../ui/Shell.tsx'
import { useToast } from '../ui/feedback.tsx'
import { Icon } from '../ui/icons.tsx'

const COLORS: [NoteColor, string][] = [['default', 'Trắng'], ['yellow', 'Vàng'], ['green', 'Xanh lá'], ['blue', 'Xanh dương'], ['pink', 'Hồng'], ['purple', 'Tím']]
const LONG = 600 // ký tự; dài hơn thì gập trên thẻ

/** Bỏ dấu tiếng Việt + chữ thường để tìm "phi ship" khớp "phí ship". */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase()

/** "14:05" hôm nay · "Hôm qua" · "23/10" (cùng năm) · "23/10/2025". */
function when(iso: string) {
  const tz = 'Asia/Ho_Chi_Minh'
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d)
  const d = new Date(iso), now = new Date()
  if (day(d) === day(now)) return new Intl.DateTimeFormat('vi-VN', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(d)
  if (day(d) === day(new Date(now.getTime() - 864e5))) return 'Hôm qua'
  const sameYear = day(d).slice(0, 4) === day(now).slice(0, 4)
  return new Intl.DateTimeFormat('vi-VN', { timeZone: tz, day: '2-digit', month: '2-digit', ...(sameYear ? {} : { year: 'numeric' }) }).format(d)
}

const PinIcon = ({ on }: { on: boolean }) => (
  <svg viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 4h6l-1 6 3 3H7l3-3z" /><path d="M12 13v7" />
  </svg>
)

export default function Notes() {
  const d = useData()
  const [q, setQ] = useState('')
  const [onlyPinned, setOnlyPinned] = useState(false)
  const [open, setOpen] = useState<NoteRow | 'new' | null>(null)

  const notes = useMemo(() => {
    const f = fold(q.trim())
    return d.notes
      .filter((n) => (!f || fold(n.body).includes(f)) && (!onlyPinned || n.is_pinned))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  }, [d.notes, q, onlyPinned])
  const pinned = notes.filter((n) => n.is_pinned), others = notes.filter((n) => !n.is_pinned)
  const close = useCallback(() => setOpen(null), [])

  const grid = (list: NoteRow[]) => (
    <div className="nk-grid">{list.map((n) => <NoteCard key={n.id} n={n} q={q} onOpen={() => setOpen(n)} />)}</div>
  )

  return (
    <Shell section="ghichu" title="Ghi chú" actions={<button className="btn btn-primary btn-sm only-desk" onClick={() => setOpen('new')}><Icon name="plus" />Ghi chú mới</button>}>
      <div className="nk-bar">
        <input className="input nk-search" id="note-search" type="search" placeholder="Tìm trong ghi chú…" aria-label="Tìm trong ghi chú" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="chips" role="group" aria-label="Lọc ghi chú">
          <button className="chip" aria-pressed={!onlyPinned} onClick={() => setOnlyPinned(false)}>Tất cả <span className="c">{d.notes.length}</span></button>
          <button className="chip" aria-pressed={onlyPinned} onClick={() => setOnlyPinned(true)}>Đã ghim <span className="c">{d.notes.filter((n) => n.is_pinned).length}</span></button>
        </div>
      </div>

      {notes.length === 0 ? (
        <div className="nk-empty">
          {d.notes.length === 0
            ? <><b>Chưa có ghi chú nào</b><span>Ghi điều cần lưu ý khi bán: giá đã báo khách, cách đóng gói, lỗi hay gặp…</span><button className="btn btn-primary" onClick={() => setOpen('new')}><Icon name="plus" />Viết ghi chú đầu tiên</button></>
            : <span>Không có ghi chú nào khớp “{q || 'Đã ghim'}”.</span>}
        </div>
      ) : (
        <>
          {pinned.length > 0 && <><p className="nk-sec"><PinIcon on />Đã ghim</p>{grid(pinned)}</>}
          {others.length > 0 && <>{pinned.length > 0 && <p className="nk-sec">Khác</p>}{grid(others)}</>}
        </>
      )}

      <button className="nk-fab only-mob" onClick={() => setOpen('new')} aria-label="Ghi chú mới"><Icon name="plus" strokeWidth={2} /></button>
      {open && <NoteEditor key={open === 'new' ? 'new' : open.id} note={open === 'new' ? null : open} onClose={close} />}
    </Shell>
  )
}

function NoteCard({ n, q, onOpen }: { n: NoteRow; q: string; onOpen: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const nl = n.body.indexOf('\n')
  const title = (nl < 0 ? n.body : n.body.slice(0, nl)).trim()
  const rest = nl < 0 ? '' : n.body.slice(nl + 1).replace(/^\n+/, '')
  const long = rest.length > LONG || rest.split('\n').length > 14
  return (
    <article className={`nk-card c-${n.color}${n.is_pinned ? ' pinned' : ''}`}>
      <button className="nk-open" onClick={onOpen} aria-label={`Mở ghi chú: ${title}`}>
        <h3 className="nk-title"><Hi text={title || '(Không tiêu đề)'} q={q} /></h3>
        {rest && <div className={`nk-body${long && !expanded ? ' clamp' : ''}`}><Hi text={rest} q={q} /></div>}
      </button>
      <div className="nk-foot">
        <span className="nk-when">{when(n.updated_at)}</span>
        {long && <button className="nk-more" onClick={() => setExpanded((v) => !v)}>{expanded ? 'Thu gọn' : 'Xem thêm'}</button>}
        {n.is_pinned && <span className="nk-pin" title="Đã ghim"><PinIcon on /></span>}
      </div>
    </article>
  )
}

/** Tô chữ khớp ô tìm (không dấu). */
function Hi({ text, q }: { text: string; q: string }) {
  const f = fold(q.trim())
  if (!f) return <>{text}</>
  const ft = fold(text), out: (string | JSX.Element)[] = []
  let i = 0, k = 0
  for (let at = ft.indexOf(f); at >= 0; at = ft.indexOf(f, i)) {
    out.push(text.slice(i, at), <mark key={k++}>{text.slice(at, at + f.length)}</mark>)
    i = at + f.length
  }
  out.push(text.slice(i))
  return <>{out}</>
}

/** Màn sửa toàn màn hình (Apple Notes): Xong / quay lại = tự lưu nếu có thay đổi. */
function NoteEditor({ note, onClose }: { note: NoteRow | null; onClose: () => void }) {
  const { reload } = useStore()
  const toast = useToast()
  const [body, setBody] = useState(note?.body ?? '')
  const [pinned, setPinned] = useState(note?.is_pinned ?? false)
  const [color, setColor] = useState<NoteColor>(note?.color ?? 'default')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [confirmDel, setConfirmDel] = useState(false)
  const ta = useRef<HTMLTextAreaElement>(null)
  const dirty = body.trim() !== (note?.body ?? '').trim() || pinned !== (note?.is_pinned ?? false) || color !== (note?.color ?? 'default')

  // Ô chữ tự giãn theo nội dung; ghi chú mới thì focus ngay
  useEffect(() => { const t = ta.current; if (!t) return; t.style.height = 'auto'; t.style.height = `${t.scrollHeight}px` }, [body])
  useEffect(() => { if (!note) ta.current?.focus() }, [note])

  const save = useCallback(async (andClose: boolean) => {
    const text = body.trim()
    if (!dirty) { if (andClose) onClose(); return }
    if (!text) { if (!note) { onClose(); return } setErr('Ghi chú đang trống - viết nội dung hoặc bấm Xoá.'); return }
    setBusy(true); setErr(null)
    const res = note
      ? await supabase.from('notes').update({ body: text, is_pinned: pinned, color }).eq('id', note.id).eq('version', note.version).select('id')
      : await supabase.from('notes').insert({ body: text, is_pinned: pinned, color }).select('id')
    setBusy(false)
    if (res.error) { setErr(errorMessage(res.error)); return }
    if (note && !res.data?.length) { await reload(); setErr('Ghi chú vừa được sửa trên máy khác - đã tải lại; đóng rồi mở lại để sửa.'); return }
    await reload(); toast(note ? 'Đã lưu' : 'Đã thêm ghi chú')
    if (andClose) onClose()
  }, [body, pinned, color, dirty, note, onClose, reload, toast])

  async function remove() {
    if (!note) return
    setBusy(true)
    const { error } = await supabase.from('notes').delete().eq('id', note.id)
    setBusy(false)
    if (error) { setErr(errorMessage(error)); return }
    await reload(); toast('Đã xoá ghi chú'); onClose()
  }

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') void save(true); if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void save(true) }
    addEventListener('keydown', k); return () => removeEventListener('keydown', k)
  }, [save])

  return (
    <div className={`nk-editor c-${color}`} role="dialog" aria-modal="true" aria-label={note ? 'Sửa ghi chú' : 'Ghi chú mới'}>
      <header className="nk-ehdr">
        <button className="icon-btn" onClick={() => void save(true)} aria-label="Lưu và quay lại"><Icon name="back" /></button>
        <span className="nk-estate">{busy ? 'Đang lưu…' : note ? `Sửa ${when(note.updated_at)}` : 'Ghi chú mới'}</span>
        <button className={`icon-btn nk-pinbtn${pinned ? ' on' : ''}`} onClick={() => setPinned((v) => !v)} aria-pressed={pinned} aria-label={pinned ? 'Bỏ ghim' : 'Ghim lên đầu'} title={pinned ? 'Bỏ ghim' : 'Ghim'}><PinIcon on={pinned} /></button>
        <button className="btn btn-primary btn-sm" onClick={() => void save(true)} disabled={busy}>Xong</button>
      </header>
      <div className="nk-ebody">
        <textarea ref={ta} className="nk-ta" id="note-body" maxLength={10000} value={body} onChange={(e) => setBody(e.target.value)}
          placeholder={'Tiêu đề (dòng đầu)\nNội dung ghi chú…\n\nVD: KU đen lô L-004 - khách Đức Anh đã cọc 1tr, hẹn giao trước 30/10'} />
        {err && <div className="err-text" role="alert">{err}</div>}
      </div>
      <footer className="nk-efoot">
        <div className="nk-colors" role="radiogroup" aria-label="Màu thẻ">
          {COLORS.map(([c, label]) => (
            <button key={c} role="radio" aria-checked={color === c} aria-label={label} title={label} className={`nk-dot c-${c}`} onClick={() => setColor(c)} />
          ))}
        </div>
        {note && (confirmDel
          ? <span className="row"><button className="btn btn-ghost btn-sm" onClick={() => setConfirmDel(false)}>Không</button><button className="btn btn-danger btn-sm" onClick={remove} disabled={busy}>Xoá vĩnh viễn</button></span>
          : <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDel(true)}>Xoá</button>)}
      </footer>
    </div>
  )
}
