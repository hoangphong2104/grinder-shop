// SC_13 Khách — danh sách (tên, SĐT, địa chỉ, FB, số đơn, còn nợ); bấm → sheet sửa thông tin, Ẩn / Hiện lại (BR-14), xem đơn.
// Bảng customers ghi trực tiếp được (grant); sửa kèm điều kiện version để bắt sửa đồng thời 2 máy.
import { useCallback, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useData, useStore } from '../data/store.tsx'
import { errorMessage } from '../data/errors.ts'
import type { CustomerRow } from '../data/types.ts'
import { supabase } from '../lib/supabase.ts'
import { Sheet, useToast } from '../ui/feedback.tsx'
import { Shell } from '../ui/Shell.tsx'
import { tr } from '../ui/format.ts'
import { useIsDesk, VERSION_CONFLICT_MSG } from './orders/common.ts'

export default function Customers() {
  const d = useData()
  const desk = useIsDesk()
  const [showHidden, setShowHidden] = useState(false)
  const [editing, setEditing] = useState<CustomerRow | null>(null)
  const close = useCallback(() => setEditing(null), [])

  // Số đơn + còn nợ theo khách (đơn Huỷ không tính nợ — Q-009).
  const stats = useMemo(() => {
    const m = new Map<string, { n: number; due: number }>()
    for (const s of d.orderSummary) {
      const x = m.get(s.customer_id) ?? { n: 0, due: 0 }
      x.n += 1
      x.due += Math.max(0, s.receivable_vnd)
      m.set(s.customer_id, x)
    }
    return m
  }, [d.orderSummary])

  const hiddenCount = d.customers.filter((c) => c.is_hidden).length
  const list = d.customers
    .filter((c) => c.is_hidden === showHidden)
    .sort((a, b) => a.fb_name.localeCompare(b.fb_name, 'vi'))
  // Sheet đang mở dùng bản mới nhất của dòng (realtime / sau khi lưu).
  const cur = editing ? d.customers.find((c) => c.id === editing.id) ?? null : null

  return (
    <Shell section="khach" title="Khách" back={desk ? undefined : '/them'}>
      {(hiddenCount > 0 || showHidden) && (
        <div className="seg" style={{ alignSelf: 'flex-start' }}>
          <button aria-pressed={!showHidden} onClick={() => setShowHidden(false)}>Đang dùng</button>
          <button aria-pressed={showHidden} onClick={() => setShowHidden(true)}>Đã ẩn ({hiddenCount})</button>
        </div>
      )}
      {list.length === 0
        ? <div className="empty">{showHidden ? 'Không có khách nào bị ẩn.' : <><b>Chưa có khách nào</b><br />Khách được tạo khi lưu <Link to="/don/new">đơn bán mới</Link>.</>}</div>
        : (
          <div className="stack">
            {list.map((c) => {
              const st = stats.get(c.id) ?? { n: 0, due: 0 }
              return (
                <button key={c.id} className="shot item" onClick={() => setEditing(c)}>
                  <span className="t">{[c.phone, c.address].filter(Boolean).join(' · ') || 'Chưa có SĐT / địa chỉ'}</span>
                  <span className="b">{c.fb_name}</span>
                  <span className="r num">{st.n} đơn</span>
                  <span className="f">{c.fb_url || '—'}{st.due > 0 && <> · <span className="req">còn nợ {tr(st.due)}</span></>}</span>
                </button>
              )
            })}
          </div>
        )}
      {cur && <CustomerSheet c={cur} orders={stats.get(cur.id)?.n ?? 0} onClose={close} />}
    </Shell>
  )
}

function CustomerSheet({ c, orders, onClose }: { c: CustomerRow; orders: number; onClose: () => void }) {
  const { reload } = useStore()
  const toast = useToast()
  const [f, setF] = useState({ fb_name: c.fb_name, fb_url: c.fb_url ?? '', phone: c.phone ?? '', address: c.address ?? '', note: c.note ?? '' })
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Version lúc mở sheet: máy khác sửa trong lúc đang mở ⇒ báo xung đột thay vì ghi đè.
  const [version] = useState(c.version)
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((p) => ({ ...p, [k]: e.target.value }))

  async function write(patch: Partial<CustomerRow>, ok: string) {
    setBusy(true)
    try {
      const { data: rows, error } = await supabase.from('customers').update(patch).eq('id', c.id).eq('version', version).select('id')
      if (error) throw new Error(errorMessage(error))
      await reload()
      if (!rows?.length) throw new Error(VERSION_CONFLICT_MSG)
      toast(ok)
      onClose()
    } catch (e) {
      toast(e instanceof Error ? e.message : errorMessage(e))
    } finally {
      setBusy(false)
    }
  }
  const save = () => {
    if (!f.fb_name.trim()) { setErr('Nhập tên Facebook của khách.'); return }
    setErr(null)
    write({
      fb_name: f.fb_name.trim(), fb_url: f.fb_url.trim() || null, phone: f.phone.trim() || null,
      address: f.address.trim() || null, note: f.note.trim() || null,
    }, 'Đã lưu khách')
  }

  return (
    <Sheet title={c.fb_name} onClose={onClose}
      footer={<button className="btn btn-primary btn-block" disabled={busy} onClick={save}>Lưu</button>}>
      <label className="f" htmlFor="c-name">Tên Facebook <span className="req">*</span>
        <input className="input" id="c-name" value={f.fb_name} onChange={set('fb_name')} maxLength={120} aria-invalid={!!err} />
        {err && <span className="err-text">{err}</span>}
      </label>
      <label className="f" htmlFor="c-fb">Link Facebook<input className="input" id="c-fb" value={f.fb_url} onChange={set('fb_url')} maxLength={500} /></label>
      <label className="f" htmlFor="c-phone">SĐT<input className="input" id="c-phone" inputMode="tel" value={f.phone} onChange={set('phone')} maxLength={30} /></label>
      <label className="f" htmlFor="c-addr">Địa chỉ giao<input className="input" id="c-addr" value={f.address} onChange={set('address')} maxLength={500} /></label>
      <label className="f" htmlFor="c-note">Ghi chú<textarea className="input" id="c-note" value={f.note} onChange={set('note')} maxLength={2000} /></label>
      <div className="two">
        <Link className="btn btn-ghost" to={`/don?khach=${c.id}&f=all`}>Xem {orders} đơn</Link>
        {c.is_hidden
          ? <button className="btn btn-ghost" disabled={busy} onClick={() => write({ is_hidden: false }, 'Đã hiện lại khách')}>Hiện lại</button>
          : <Link className="btn btn-ghost" to={`/don/new?khach=${c.id}`}>Tạo đơn</Link>}
      </div>
      {!c.is_hidden && (
        <>
          <button className="btn btn-danger btn-block" disabled={busy} onClick={() => write({ is_hidden: true }, 'Đã ẩn khách')}>Ẩn khách</button>
          <p className="hint">Ẩn: không hiện khi chọn khách cho đơn mới; đơn cũ vẫn giữ tên khách (BR-14).</p>
        </>
      )}
    </Sheet>
  )
}
