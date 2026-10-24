// Ghi chú khi bán hàng (CR-002; CR-005 ý 14: danh sách kiểu Apple Notes).
// - Dòng cao bằng nhau: tiêu đề đậm 1 dòng + ngày (ghim) bên phải, 2 dòng xem trước; màu ghi chú = vạch trái nhỏ.
// - Bấm thẻ → màn sửa toàn màn hình, ô chữ tự giãn; Xong / quay lại = tự lưu. Ghim, đổi màu, xoá ngay trong màn sửa.
// - Tìm không dấu; nhóm Đã ghim / Khác. Lưu trên cloud, đồng bộ realtime.
// - CR-007: lịch sử (DB tự lưu bản cũ mỗi lần sửa nội dung / xoá - note_revisions): "Lịch sử" trong màn sửa → dùng lại bản cũ;
//   "Đã xoá gần đây" cuối danh sách → khôi phục ghi chú đã xoá.
import '../styles/notes.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase.ts'
import { useData, useStore } from '../data/store.tsx'
import { errorMessage } from '../data/errors.ts'
import type { NoteColor, NoteRow } from '../data/types.ts'
import { Shell } from '../ui/Shell.tsx'
import { Sheet, useToast } from '../ui/feedback.tsx'
import { Icon } from '../ui/icons.tsx'

const COLORS: [NoteColor, string][] = [['default', 'Trắng'], ['yellow', 'Vàng'], ['green', 'Xanh lá'], ['blue', 'Xanh dương'], ['pink', 'Hồng'], ['purple', 'Tím']]

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
  const [open, setOpen] = useState<NoteRow | 'new' | null>(null)
  const [trash, setTrash] = useState(false)

  const notes = useMemo(() => {
    const f = fold(q.trim())
    return d.notes
      .filter((n) => !f || fold(n.body).includes(f))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  }, [d.notes, q])
  const pinned = notes.filter((n) => n.is_pinned), others = notes.filter((n) => !n.is_pinned)
  const close = useCallback(() => setOpen(null), [])

  const list = (items: NoteRow[]) => (
    <div className="nl-list">{items.map((n) => <NoteLine key={n.id} n={n} q={q} onOpen={() => setOpen(n)} />)}</div>
  )

  return (
    <Shell section="ghichu" title="Ghi chú" actions={<button className="btn btn-primary btn-sm only-desk" onClick={() => setOpen('new')}><Icon name="plus" />Ghi chú mới</button>}>
      <input className="input nk-search" id="note-search" type="search" placeholder="Tìm trong ghi chú…" aria-label="Tìm trong ghi chú" value={q} onChange={(e) => setQ(e.target.value)} />

      {notes.length === 0 ? (
        <div className="nk-empty">
          {d.notes.length === 0
            ? <><b>Chưa có ghi chú nào</b><span>Ghi điều cần lưu ý khi bán: giá đã báo khách, cách đóng gói, lỗi hay gặp…</span><button className="btn btn-primary" onClick={() => setOpen('new')}><Icon name="plus" />Viết ghi chú đầu tiên</button></>
            : <span>Không có ghi chú nào khớp “{q}”.</span>}
        </div>
      ) : (
        <>
          {pinned.length > 0 && <><p className="nk-sec"><PinIcon on />Đã ghim <span className="c">{pinned.length}</span></p>{list(pinned)}</>}
          {others.length > 0 && <><p className="nk-sec">{pinned.length > 0 ? 'Ghi chú khác' : 'Tất cả ghi chú'} <span className="c">{others.length}</span></p>{list(others)}</>}
        </>
      )}

      <button className="link-btn nk-trash" id="note-trash" onClick={() => setTrash(true)}>Đã xoá gần đây</button>
      {trash && <TrashSheet onClose={() => setTrash(false)} />}

      <button className="nk-fab only-mob" onClick={() => setOpen('new')} aria-label="Ghi chú mới"><Icon name="plus" strokeWidth={2} /></button>
      {open && <NoteEditor key={open === 'new' ? 'new' : open.id} note={open === 'new' ? null : open} onClose={close} />}
    </Shell>
  )
}

/** Tiêu đề = dòng đầu; ghi chú chỉ 1 dòng dài ⇒ tách ở cuối câu đầu (≤ 70 ký tự) hoặc ~32 ký tự theo từ, phần còn lại làm xem trước. */
function splitNote(body: string): [string, string] {
  const b = body.trim()
  const nl = b.indexOf('\n')
  if (nl >= 0) return [b.slice(0, nl).trim(), b.slice(nl + 1).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()] // CR-006: giữ xuống dòng
  if (b.length <= 36) return [b, '']
  const m = /^(.{8,70}?[.!?:])\s+(.+)$/.exec(b)
  if (m) return [m[1], m[2]]
  let cut = b.lastIndexOf(' ', 32)
  if (cut < 12) cut = 32
  return [b.slice(0, cut).trim(), b.slice(cut).trim()]
}

/** Dòng kiểu Apple Notes: tiêu đề đậm 1 dòng + ngày / ghim bên phải, nội dung giữ xuống dòng, tối đa 8 dòng (CR-006: đọc ngay ở danh sách). Màu = vạch trái. */
function NoteLine({ n, q, onOpen }: { n: NoteRow; q: string; onOpen: () => void }) {
  const [title, rest] = splitNote(n.body)
  return (
    <button type="button" className={`nl-row c-${n.color}`} onClick={onOpen} aria-label={`Mở ghi chú: ${title}`}>
      <span className="t"><Hi text={title || '(Không tiêu đề)'} q={q} /></span>
      <span className="w">{n.is_pinned && <PinIcon on />}{when(n.updated_at)}</span>
      <span className="p">{rest ? <Hi text={rest} q={q} /> : <span className="none">Không có nội dung thêm</span>}</span>
    </button>
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
  const [hist, setHist] = useState(false)
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
        {note && !confirmDel && <button className="btn btn-ghost btn-sm" id="note-hist" onClick={() => setHist(true)}>Lịch sử</button>}
        {note && (confirmDel
          ? <span className="row"><button className="btn btn-ghost btn-sm" onClick={() => setConfirmDel(false)}>Không</button><button className="btn btn-danger btn-sm" onClick={remove} disabled={busy}>Xoá vĩnh viễn</button></span>
          : <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDel(true)}>Xoá</button>)}
      </footer>
      {hist && note && <HistorySheet noteId={note.id} onPick={(r) => { setBody(r.body); setHist(false); toast('Đã lấy bản cũ - bấm Xong để lưu (bản hiện tại vẫn còn trong lịch sử)') }} onClose={() => setHist(false)} />}
    </div>
  )
}

interface Revision { id: string; note_id: string; body: string; color: NoteColor; is_pinned: boolean; action: 'edit' | 'delete'; created_at: string }

/** Ngày giờ đầy đủ cho lịch sử: "24/10 14:05". */
const stamp = (iso: string) => new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))

/** Tải lịch sử khi mở (không giữ trong store - chỉ cần lúc xem). */
function useRevisions(build: () => PromiseLike<{ data: unknown; error: { message: string } | null }>) {
  const [rows, setRows] = useState<Revision[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const load = useCallback(async () => {
    const { data, error } = await build()
    if (error) setErr(errorMessage(error)); else setRows((data ?? []) as Revision[])
  }, [build])
  useEffect(() => { void load() }, [load])
  return { rows, err, load }
}

function RevisionList({ rows, err, empty, act }: { rows: Revision[] | null; err: string | null; empty: string; act: (r: Revision) => React.ReactNode }) {
  if (err) return <p className="err-text">{err}</p>
  if (!rows) return <p className="muted small"><span className="spin" /> Đang tải…</p>
  if (!rows.length) return <p className="muted small">{empty}</p>
  return (
    <div className="nl-list nk-hist">
      {rows.map((r) => (
        <div key={r.id} className={`nl-row c-${r.color}`} style={{ cursor: 'default' }}>
          <span className="t">{r.body.split('\n')[0] || '(Không tiêu đề)'}</span>
          <span className="w">{stamp(r.created_at)}</span>
          <span className="p">{r.body.split('\n').slice(1).join('\n').trim() || <span className="none">Không có nội dung thêm</span>}</span>
          <span className="a">{act(r)}</span>
        </div>
      ))}
    </div>
  )
}

/** Các bản cũ của 1 ghi chú (mới nhất trước) → "Dùng bản này" đưa nội dung vào màn sửa. */
function HistorySheet({ noteId, onPick, onClose }: { noteId: string; onPick: (r: Revision) => void; onClose: () => void }) {
  const build = useCallback(() => supabase.from('note_revisions').select('*').eq('note_id', noteId).eq('action', 'edit').order('created_at', { ascending: false }).limit(50), [noteId])
  const { rows, err } = useRevisions(build)
  return (
    <Sheet title="Lịch sử ghi chú" onClose={onClose}>
      <p className="hint" style={{ margin: 0 }}>Mỗi lần sửa nội dung, app giữ lại bản trước đó (tối đa 50 bản).</p>
      <RevisionList rows={rows} err={err} empty="Chưa có bản cũ - ghi chú chưa bị sửa nội dung lần nào."
        act={(r) => <button className="btn btn-ghost btn-sm" onClick={() => onPick(r)}>Dùng bản này</button>} />
    </Sheet>
  )
}

/** Ghi chú đã xoá (30 cái gần nhất) → khôi phục = thêm lại ghi chú từ bản cuối, rồi bỏ bản "đã xoá". */
function TrashSheet({ onClose }: { onClose: () => void }) {
  const { reload } = useStore()
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const build = useCallback(() => supabase.from('note_revisions').select('*').eq('action', 'delete').order('created_at', { ascending: false }).limit(30), [])
  const { rows, err, load } = useRevisions(build)
  async function restore(r: Revision) {
    setBusy(r.id)
    const { error } = await supabase.from('notes').insert({ body: r.body, color: r.color, is_pinned: r.is_pinned })
    if (!error) await supabase.from('note_revisions').delete().eq('id', r.id)
    setBusy(null)
    if (error) { toast(errorMessage(error)); return }
    await Promise.all([reload(), load()])
    toast('Đã khôi phục ghi chú')
  }
  return (
    <Sheet title="Đã xoá gần đây" onClose={onClose}>
      <RevisionList rows={rows} err={err} empty="Không có ghi chú nào bị xoá."
        act={(r) => <button className="btn btn-ghost btn-sm" disabled={busy === r.id} onClick={() => void restore(r)}>{busy === r.id ? 'Đang khôi phục…' : 'Khôi phục'}</button>} />
    </Sheet>
  )
}
