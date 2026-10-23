// SC_13 Khách — CR-004 TIEN-S4: dòng 2 dòng (tên | còn nợ; SĐT · địa chỉ | số đơn), ô tìm + chip lọc Còn nợ / Đã ẩn.
// Danh sách (tên, SĐT, địa chỉ, FB, số đơn, còn nợ); bấm → sheet sửa thông tin, Ẩn / Hiện lại (BR-14), xem đơn.
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
import { fold, useIsDesk, VERSION_CONFLICT_MSG } from './orders/common.ts'
import '../styles/orders.css'

export default function Customers() {
  const d = useData()
  const desk = useIsDesk()
  const [tab, setTab] = useState<'all' | 'due' | 'hidden'>('all')
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<CustomerRow | null>(null)
  const close = useCallback(() => setEditing(null), [])

  // Số đơn + còn nợ theo khách (đơn Huỷ không tính nợ — Q-009).
  const stats = useMemo(() => {
    const m = new Map<string, { n: number; due: number; refund: number }>()
    for (const s of d.orderSummary) {
      const x = m.get(s.customer_id) ?? { n: 0, due: 0, refund: 0 }
      x.n += 1
      x.due += Math.max(0, s.receivable_vnd)
      x.refund += s.refund_due_vnd
      m.set(s.customer_id, x)
    }
    return m
  }, [d.orderSummary])

  const qq = fold(q.trim())
  const found = d.customers.filter((c) => !qq || fold(c.fb_name).includes(qq) || fold(c.phone ?? '').replace(/\s/g, '').includes(qq.replace(/\s/g, '')))
  const visible = found.filter((c) => !c.is_hidden)
  const hasDue = (id: string) => (stats.get(id)?.due ?? 0) > 0
  const cnt = { all: visible.length, due: visible.filter((c) => hasDue(c.id)).length, hidden: found.filter((c) => c.is_hidden).length }
  const list = (tab === 'hidden' ? found.filter((c) => c.is_hidden) : tab === 'due' ? visible.filter((c) => hasDue(c.id)) : visible)
    // Còn nợ: nợ nhiều trước; khác: theo tên
    .sort((a, b) => tab === 'due' ? (stats.get(b.id)?.due ?? 0) - (stats.get(a.id)?.due ?? 0) : a.fb_name.localeCompare(b.fb_name, 'vi'))
  const totalDue = list.reduce((a, c) => a + (stats.get(c.id)?.due ?? 0), 0)
  // Sheet đang mở dùng bản mới nhất của dòng (realtime / sau khi lưu).
  const cur = editing ? d.customers.find((c) => c.id === editing.id) ?? null : null

  return (
    <Shell section="khach" title="Khách" back={desk ? undefined : '/them'}>
      {d.customers.length > 0 && (
        <div className="o-filter">
          <div className="o-top"><input className="input" id="c-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm tên Facebook hoặc SĐT" aria-label="Tìm khách" /></div>
          <div className="chips" role="group" aria-label="Lọc khách">
            <button type="button" className="chip" aria-pressed={tab === 'all'} onClick={() => setTab('all')}>Đang dùng<span className="c">{cnt.all}</span></button>
            <button type="button" className="chip" aria-pressed={tab === 'due'} onClick={() => setTab('due')}>Còn nợ<span className="c">{cnt.due}</span></button>
            {(cnt.hidden > 0 || tab === 'hidden') && <button type="button" className="chip" aria-pressed={tab === 'hidden'} onClick={() => setTab('hidden')}>Đã ẩn<span className="c">{cnt.hidden}</span></button>}
          </div>
        </div>
      )}
      {tab === 'due' && list.length > 0 && <div className="o-sum"><span>{list.length} khách còn nợ</span><b className="tone-bad">{tr(totalDue)}</b></div>}
      {list.length === 0
        ? <div className="empty">{d.customers.length === 0
          ? <><b>Chưa có khách nào</b><br />Khách được tạo khi lưu đơn bán mới.<br /><br /><Link className="btn btn-primary" to="/don/new">Tạo đơn bán</Link></>
          : q ? `Không có khách khớp “${q}”.` : tab === 'due' ? 'Không khách nào còn nợ.' : tab === 'hidden' ? 'Không có khách nào bị ẩn.' : 'Không có khách.'}</div>
        : (
          <div className="olist">
            {list.map((c) => {
              const st = stats.get(c.id) ?? { n: 0, due: 0, refund: 0 }
              return (
                <button key={c.id} type="button" className="orow" onClick={() => setEditing(c)}>
                  <span className="l1"><span className="nm" style={{ fontWeight: 500 }}>{c.fb_name}</span></span>
                  <span className={`r1 ${st.due > 0 || st.refund > 0 ? 'tone-bad' : ''}`} style={{ fontSize: 14 }}>{st.due > 0 ? `còn nợ ${tr(st.due)}` : st.refund > 0 ? `cần hoàn ${tr(st.refund)}` : ''}</span>
                  <span className="l2"><span className="meta">{[c.phone, c.address].filter(Boolean).join(' · ') || 'Chưa có SĐT / địa chỉ'}</span></span>
                  <span className="r2 tone-neu">{st.n} đơn</span>
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
