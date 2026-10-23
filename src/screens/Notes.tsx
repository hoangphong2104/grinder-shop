// CR-002 — Ghi chú khi bán hàng: ghim lên đầu, tìm kiếm (không phân biệt dấu). Lưu trên cloud, đồng bộ realtime.
import { useCallback, useMemo, useState } from 'react'
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
  const [del, setDel] = useState<NoteRow | null>(null)

  const notes = useMemo(() => {
    const f = fold(q.trim())
    return d.notes
      .filter((n) => !f || fold(n.body).includes(f))
      .sort((a, b) => Number(b.is_pinned) - Number(a.is_pinned) || b.updated_at.localeCompare(a.updated_at))
  }, [d.notes, q])

  async function togglePin(n: NoteRow) {
    const { data, error } = await supabase.from('notes').update({ is_pinned: !n.is_pinned }).eq('id', n.id).eq('version', n.version).select('id')
    if (error) return toast(errorMessage(error))
    if (!data?.length) toast('Ghi chú vừa được sửa trên máy khác — đã tải lại.')
    await reload()
  }

  const close = useCallback(() => setEdit(null), [])
  const closeDel = useCallback(() => setDel(null), [])

  return (
    <Shell section="ghichu" title="Ghi chú" actions={<button className="btn btn-primary btn-sm" onClick={() => setEdit('new')}><Icon name="plus" />Thêm</button>}>
      <label className="f" style={{ maxWidth: 520 }}>
        <span className="sr-only">Tìm trong ghi chú</span>
        <input className="input" id="note-search" type="search" placeholder="Tìm trong ghi chú…" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      {notes.length === 0 ? (
        <div className="empty">
          {d.notes.length === 0 ? <>Chưa có ghi chú nào.<br />Bấm <b>Thêm</b> để ghi điều cần lưu ý khi bán — giá đã báo khách, cách đóng gói, lỗi hay gặp…</> : `Không có ghi chú nào khớp “${q}”.`}
        </div>
      ) : (
        <div className="notes-grid">
          {notes.map((n) => (
            <article key={n.id} className={`card note${n.is_pinned ? ' pinned' : ''}`}>
              <button className="note-body" onClick={() => setEdit(n)} aria-label="Sửa ghi chú">{n.body}</button>
              <div className="note-foot">
                <span className="muted small">{when(n.updated_at)}</span>
                <span className="row">
                  <button className={`btn btn-sm ${n.is_pinned ? 'btn-primary' : 'btn-ghost'}`} onClick={() => togglePin(n)} aria-pressed={n.is_pinned}>{n.is_pinned ? 'Đã ghim' : 'Ghim'}</button>
                  <button className="btn btn-sm btn-ghost" onClick={() => setDel(n)}>Xoá</button>
                </span>
              </div>
            </article>
          ))}
        </div>
      )}
      {edit && <NoteEditor note={edit === 'new' ? null : edit} onClose={close} />}
      {del && (
        <Sheet title="Xoá ghi chú?" onClose={closeDel} footer={
          <button className="btn btn-danger btn-block" onClick={async () => {
            const { error } = await supabase.from('notes').delete().eq('id', del.id)
            if (error) return toast(errorMessage(error))
            setDel(null); await reload(); toast('Đã xoá ghi chú')
          }}>Xoá</button>
        }>
          <p className="muted" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{del.body.slice(0, 200)}{del.body.length > 200 ? '…' : ''}</p>
        </Sheet>
      )}
    </Shell>
  )
}

function NoteEditor({ note, onClose }: { note: NoteRow | null; onClose: () => void }) {
  const { reload } = useStore()
  const toast = useToast()
  const [body, setBody] = useState(note?.body ?? '')
  const [pinned, setPinned] = useState(note?.is_pinned ?? false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function save() {
    const text = body.trim()
    if (!text) return setErr('Viết nội dung ghi chú.')
    setBusy(true); setErr(null)
    const res = note
      ? await supabase.from('notes').update({ body: text, is_pinned: pinned }).eq('id', note.id).eq('version', note.version).select('id')
      : await supabase.from('notes').insert({ body: text, is_pinned: pinned }).select('id')
    setBusy(false)
    if (res.error) return setErr(errorMessage(res.error))
    if (note && !res.data?.length) { await reload(); return setErr('Ghi chú vừa được sửa trên máy khác — đã tải lại, mở lại để sửa.') }
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
    </Sheet>
  )
}
