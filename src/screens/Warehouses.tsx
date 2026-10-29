// CR-008 Danh bạ kho (dưới Khách): tên kho, SĐT, địa chỉ, ghi chú. Ô tìm; bấm dòng → sheet sửa / gọi / xoá; nút Thêm kho.
// Bảng warehouses ghi trực tiếp được (grant); sửa / xoá kèm điều kiện version để bắt sửa đồng thời 2 máy.
import { useCallback, useState } from 'react'
import { useData, useStore } from '../data/store.tsx'
import { errorMessage } from '../data/errors.ts'
import type { WarehouseRow } from '../data/types.ts'
import { supabase } from '../lib/supabase.ts'
import { Sheet, useToast } from '../ui/feedback.tsx'
import { Icon } from '../ui/icons.tsx'
import { Shell } from '../ui/Shell.tsx'
import { fold, useIsDesk, VERSION_CONFLICT_MSG } from './orders/common.ts'
import '../styles/orders.css'

export default function Warehouses() {
  const d = useData()
  const desk = useIsDesk()
  const rows = d.warehouses ?? []
  const [q, setQ] = useState('')
  // null = đóng; 'new' = thêm kho; còn lại = id kho đang sửa
  const [open, setOpen] = useState<string | null>(null)
  const close = useCallback(() => setOpen(null), [])

  const qq = fold(q.trim())
  const list = rows
    .filter((w) => !qq || fold(w.name).includes(qq) || fold(w.address ?? '').includes(qq) || (w.phone ?? '').replace(/\s/g, '').includes(qq.replace(/\s/g, '')))
    .sort((a, b) => a.name.localeCompare(b.name, 'vi'))
  // Sheet đang mở dùng bản mới nhất của dòng (realtime / sau khi lưu).
  const cur = open && open !== 'new' ? rows.find((w) => w.id === open) ?? null : null

  return (
    <Shell section="dbkho" title="Danh bạ kho" back={desk ? undefined : '/them'}
      actions={<button className="icon-btn" id="w-add" onClick={() => setOpen('new')} aria-label="Thêm kho"><Icon name="plus" /></button>}>
      {rows.length > 0 && (
        <div className="o-filter">
          <div className="o-top"><input className="input" id="w-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm tên kho, SĐT, địa chỉ" aria-label="Tìm kho" /></div>
        </div>
      )}
      {list.length === 0
        ? <div className="empty">{rows.length === 0
          ? <><b>Chưa có kho nào</b><br />Ghi tên, SĐT, địa chỉ các kho (Kho TQ, Kho VN, kho trung gian…) để tra nhanh.<br /><br /><button className="btn btn-primary" onClick={() => setOpen('new')}>Thêm kho</button></>
          : `Không có kho khớp “${q}”.`}</div>
        : (
          <div className="olist">
            {list.map((w) => (
              <button key={w.id} type="button" className="orow" onClick={() => setOpen(w.id)}>
                <span className="l1"><span className="nm" style={{ fontWeight: 500 }}>{w.name}</span></span>
                <span className="r1 num" style={{ fontSize: 14 }}>{w.phone ?? ''}</span>
                <span className="l2"><span className="meta">{w.address || w.note || 'Chưa có địa chỉ'}</span></span>
                <span className="r2" />
              </button>
            ))}
          </div>
        )}
      {open === 'new' && <WarehouseSheet w={null} onClose={close} />}
      {cur && <WarehouseSheet w={cur} onClose={close} />}
    </Shell>
  )
}

function WarehouseSheet({ w, onClose }: { w: WarehouseRow | null; onClose: () => void }) {
  const { reload } = useStore()
  const toast = useToast()
  const [f, setF] = useState({ name: w?.name ?? '', phone: w?.phone ?? '', address: w?.address ?? '', note: w?.note ?? '' })
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  // Version lúc mở sheet: máy khác sửa trong lúc đang mở ⇒ báo xung đột thay vì ghi đè.
  const [version] = useState(w?.version ?? 0)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }))

  async function run(fn: () => PromiseLike<{ data: { id: string }[] | null; error: unknown }>, ok: string) {
    setBusy(true)
    try {
      const { data: res, error } = await fn()
      if (error) throw new Error(errorMessage(error))
      await reload()
      if (!res?.length) throw new Error(VERSION_CONFLICT_MSG)
      toast(ok)
      onClose()
    } catch (e) {
      toast(e instanceof Error ? e.message : errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const save = () => {
    if (!f.name.trim()) { setErr('Nhập tên kho.'); return }
    setErr(null)
    const row = { name: f.name.trim(), phone: f.phone.trim() || null, address: f.address.trim() || null, note: f.note.trim() || null }
    run(() => w
      ? supabase.from('warehouses').update(row).eq('id', w.id).eq('version', version).select('id')
      : supabase.from('warehouses').insert(row).select('id'), w ? 'Đã lưu kho' : 'Đã thêm kho')
  }
  const remove = () => w && run(() => supabase.from('warehouses').delete().eq('id', w.id).eq('version', version).select('id'), 'Đã xoá kho')
  const tel = (w?.phone ?? '').replace(/[^0-9+]/g, '')

  return (
    <Sheet title={w ? w.name : 'Thêm kho'} onClose={onClose}
      footer={confirmDel
        ? <div className="two"><button className="btn btn-ghost" onClick={() => setConfirmDel(false)}>Không</button><button className="btn btn-danger" onClick={remove} disabled={busy}>{busy ? 'Đang xoá…' : 'Xoá vĩnh viễn'}</button></div>
        : <button className="btn btn-primary btn-block" disabled={busy} onClick={save}>{w ? 'Lưu' : 'Thêm kho'}</button>}>
      <label className="f" htmlFor="w-name">Tên kho <span className="req">*</span>
        <input className="input" id="w-name" value={f.name} onChange={set('name')} maxLength={120} placeholder="VD: Kho VN Hà Nội" aria-invalid={!!err} />
        {err && <span className="err-text">{err}</span>}
      </label>
      <label className="f" htmlFor="w-phone">SĐT<input className="input" id="w-phone" inputMode="tel" value={f.phone} onChange={set('phone')} maxLength={30} /></label>
      <label className="f" htmlFor="w-addr">Địa chỉ<textarea className="input" id="w-addr" value={f.address} onChange={set('address')} maxLength={500} /></label>
      <label className="f" htmlFor="w-note">Ghi chú<textarea className="input" id="w-note" value={f.note} onChange={set('note')} maxLength={2000} placeholder="Người liên hệ, giờ nhận hàng…" /></label>
      {w && !confirmDel && (
        <div className="two">
          {tel ? <a className="btn btn-ghost" href={`tel:${tel}`}>Gọi {w.phone}</a> : <span />}
          <button className="btn btn-ghost" disabled={busy} onClick={() => setConfirmDel(true)}>Xoá kho</button>
        </div>
      )}
    </Sheet>
  )
}
