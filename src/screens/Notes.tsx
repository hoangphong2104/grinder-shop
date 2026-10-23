// CR-002 - Ghi chú khi bán hàng: ghim lên đầu, tìm kiếm (không phân biệt dấu). Lưu trên cloud, đồng bộ realtime.
// CR-004: thẻ xem trước tối đa 3 dòng (NOTE-M1), ghim = nút biểu tượng 44px, Xoá chuyển vào sheet sửa (NOTE-M2), nhóm Đã ghim / Khác (NOTE-S1).
import '../styles/overview.css'
import { Fragment, useCallback, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase.ts'
import { useData, useStore } from '../data/store.tsx'
import { errorMessage } from '../data/errors.ts'
import type { NoteRow } from '../data/types.ts'
import { Shell } from '../ui/Shell.tsx'
import { Sheet, useToast } from '../ui/feedback.tsx'
import { Icon } from '../ui/icons.tsx'

/** Bỏ dấu tiếng Việt + chữ thường để tìm "ship" khớp "Ship", "phi" khớp "phí". */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase()

const when = (iso: string) => {
  const d = new Date(iso)
  return new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d)
}

export default function Notes() {
  const d = useData()
  const { reload } = useStore()
  const toast = useToast()
  const [q, setQ] = useState('')
  const [edit, setEdit] = useState<NoteRow | 'new' | null>(null)

  const notes = useMemo(() => {
    const f = fold(q.trim())
    return d.notes
      .filter((n) => !f || fold(n.body).includes(f))
      .sort((a, b) => Number(b.is_pinned) - Number(a.is_pinned) || b.updated_at.localeCompare(a.updated_at))
  }, [d.notes, q])
  const pinnedN = notes.filter((n) => n.is_pinned).length

  async function togglePin(n: NoteRow) {
    const { data, error } = await supabase.from('notes').update({ is_pinned: !n.is_pinned }).eq('id', n.id).eq('version', n.version).select('id')
    if (error) return toast(errorMessage(error))
    if (!data?.length) toast('Ghi chú vừa được sửa trên máy khác - đã tải lại.')
    await reload()
  }

  const close = useCallback(() => setEdit(null), [])

  return (
    <Shell section="ghichu" title="Ghi chú" actions={<button className="btn btn-primary btn-sm" onClick={() => setEdit('new')}><Icon name="plus" />Thêm</button>}>
      <label className="f" style={{ maxWidth: 520 }}>
        <span className="sr-only">Tìm trong ghi chú</span>
        <input className="input" id="note-search" type="search" placeholder="Tìm trong ghi chú…" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      {notes.length === 0 ? (
        <div className="empty">
          {d.notes.length === 0 ? <>Chưa có ghi chú nào.<br />Bấm <b>Thêm</b> để ghi điều cần lưu ý khi bán - giá đã báo khách, cách đóng gói, lỗi hay gặp…</> : `Không có ghi chú nào khớp “${q}”.`}
        </div>
      ) : (
        <div className="notes-grid">
          {notes.map((n, i) => {
            // NOTE-S1: nhóm "Đã ghim" / "Khác" (chỉ hiện tiêu đề khi có ghim)
            const head = pinnedN > 0 && (i === 0 || notes[i - 1].is_pinned !== n.is_pinned)
            const [first, ...rest] = n.body.split('\n')
            return (
              <Fragment key={n.id}>
                {head && <p className="section-title">{n.is_pinned ? 'Đã ghim' : 'Khác'} <span className="muted">{n.is_pinned ? pinnedN : notes.length - pinnedN}</span></p>}
                <article className={`card ov-note${n.is_pinned ? ' pinned' : ''}`}>
                  <button className="open" onClick={() => setEdit(n)} aria-label="Mở / sửa ghi chú">
                    <span className="l1"><b className={rest.join('\n').trim() ? '' : 'wrap'}>{first || '(trống)'}</b><span className="when">{when(n.updated_at)}</span></span>
                    {rest.join('\n').trim() && <span className="rest">{rest.join('\n').trim()}</span>}
                  </button>
                  <button className="pin" onClick={() => togglePin(n)} aria-pressed={n.is_pinned} aria-label={n.is_pinned ? 'Bỏ ghim' : 'Ghim lên đầu'} title={n.is_pinned ? 'Bỏ ghim' : 'Ghim'}>
                    <PinIcon on={n.is_pinned} />
                  </button>
                </article>
              </Fragment>
            )
          })}
        </div>
      )}
      {edit && <NoteEditor note={edit === 'new' ? null : edit} onClose={close} />}
    </Shell>
  )
}

/** Biểu tượng ghim (nét như icons.tsx). */
const PinIcon = ({ on }: { on: boolean }) => (
  <svg viewBox="0 0 24 24" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9 4h6l-1 6 3 3H7l3-3z" /><path d="M12 13v7" />
  </svg>
)

function NoteEditor({ note, onClose }: { note: NoteRow | null; onClose: () => void }) {
  const { reload } = useStore()
  const toast = useToast()
  const [body, setBody] = useState(note?.body ?? '')
  const [pinned, setPinned] = useState(note?.is_pinned ?? false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [confirmDel, setConfirmDel] = useState(false)

  async function remove() {
    if (!note) return
    setBusy(true); setErr(null)
    const { error } = await supabase.from('notes').delete().eq('id', note.id)
    setBusy(false)
    if (error) return setErr(errorMessage(error))
    await reload(); toast('Đã xoá ghi chú'); onClose()
  }

  async function save() {
    const text = body.trim()
    if (!text) return setErr('Viết nội dung ghi chú.')
    setBusy(true); setErr(null)
    const res = note
      ? await supabase.from('notes').update({ body: text, is_pinned: pinned }).eq('id', note.id).eq('version', note.version).select('id')
      : await supabase.from('notes').insert({ body: text, is_pinned: pinned }).select('id')
    setBusy(false)
    if (res.error) return setErr(errorMessage(res.error))
    if (note && !res.data?.length) { await reload(); return setErr('Ghi chú vừa được sửa trên máy khác - đã tải lại, mở lại để sửa.') }
    await reload(); toast(note ? 'Đã lưu ghi chú' : 'Đã thêm ghi chú'); onClose()
  }

  return (
    <Sheet title={note ? 'Sửa ghi chú' : 'Ghi chú mới'} onClose={onClose} footer={
      <button className="btn btn-primary btn-block" onClick={save} disabled={busy}>{busy ? 'Đang lưu…' : 'Lưu'}</button>
    }>
      <label className="f">Nội dung
        <textarea className="input" id="note-body" rows={8} maxLength={10000} value={body} onChange={(e) => setBody(e.target.value)} placeholder="VD: KU đen lô L-004 khách Đức Anh đã cọc 1tr, hẹn giao trước 30/10" />
      </label>
      <label className="row" style={{ gap: 10 }}>
        <input type="checkbox" className="switch" id="note-pin" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
        <span>Ghim lên đầu</span>
      </label>
      {err && <div className="err-text" role="alert">{err}</div>}
      {note && (confirmDel
        ? <>
          <p className="warn-box">Xoá vĩnh viễn ghi chú này? Không hoàn tác được.</p>
          <button className="btn btn-danger btn-block" id="note-del-confirm" onClick={remove} disabled={busy}>{busy ? 'Đang xoá…' : 'Xoá vĩnh viễn'}</button>
        </>
        : <button className="btn btn-danger btn-block" id="note-del" onClick={() => setConfirmDel(true)} disabled={busy}>Xoá ghi chú</button>)}
    </Sheet>
  )
}
