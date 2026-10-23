// SC_09 Đơn bán mới (/don/new) và Sửa đơn chưa gửi (/don/:id/sua) — CR-001: mỗi dòng = 1 chiếc cụ thể (A6).
// Lưu 1 lệnh RPC save_order: tạo khách mới (p_order.new_customer) + đơn + cọc (p_order.deposit_vnd) trong cùng
// transaction; DB quyết trạng thái (có chiếc Đang về ⇒ Đặt trước, tất cả Trong kho ⇒ Đã chốt).
import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useData, useStore } from '../data/store.tsx'
import { errorMessage } from '../data/errors.ts'
import type { DbData, OrderStatusDb, ShipPayerDb, UnitViewRow } from '../data/types.ts'
import { Sheet, useToast } from '../ui/feedback.tsx'
import { Shell } from '../ui/Shell.tsx'
import { ORDER_LABEL } from '../ui/status.tsx'
import { parseNum, todayVn, vnd } from '../ui/format.ts'
import { fold, makeLookup, unitAvailability } from './orders/common.ts'
import '../styles/orders.css'

interface LineDraft { unitId: string; price: string }
interface Draft {
  custId: string; newName: string; newFb: string; newPhone: string; newAddr: string
  lines: LineDraft[]; shipFee: string; shipPayer: ShipPayerDb; deposit: string; date: string; note: string
}
type Errs = Partial<Record<string, string>>
const MAX_LINES = 50 // save_order: TOO_MANY_LINES khi > 50
const fmt = (n: number | null | undefined) => (n != null ? n.toLocaleString('vi-VN') : '')

function initDraft(d: DbData, orderId: string | null, presetCust: string | null, presetUnit: string | null = null): Draft {
  const o = orderId ? d.orders.find((x) => x.id === orderId) : undefined
  if (o) {
    return {
      custId: o.customer_id, newName: '', newFb: '', newPhone: '', newAddr: '',
      lines: d.orderLines.filter((x) => x.order_id === o.id && !x.cancelled).map((x) => ({ unitId: x.unit_id, price: fmt(x.unit_price_vnd) })),
      shipFee: o.ship_fee_vnd ? fmt(o.ship_fee_vnd) : '', shipPayer: o.ship_fee_payer, deposit: '', date: o.order_date, note: o.note ?? '',
    }
  }
  const cust = presetCust && d.customers.some((c) => c.id === presetCust && !c.is_hidden) ? presetCust : ''
  // ?chiec=<unitId> (nút "Bán" ở Kho / chi tiết chiếc): điền sẵn chiếc nếu còn bán được (A6)
  const u = presetUnit ? d.unitView.find((x) => x.unit_id === presetUnit && (x.status === 'in_stock' || x.status === 'incoming')) : undefined
  return {
    custId: cust, newName: '', newFb: '', newPhone: '', newAddr: '',
    lines: u ? [{ unitId: u.unit_id, price: u.list_price_vnd != null ? fmt(u.list_price_vnd) : '' }] : [], shipFee: '', shipPayer: d.settings?.default_ship_fee_payer ?? 'customer', deposit: '', date: todayVn(), note: '',
  }
}

// key theo id ⇒ chuyển giữa /don/new và /don/:id/sua luôn dựng form mới.
export default function OrderNew() {
  const { id } = useParams()
  return <OrderForm key={id ?? 'new'} editId={id ?? null} />
}

function OrderForm({ editId }: { editId: string | null }) {
  const [sp] = useSearchParams()
  const d = useData()
  const { rpc } = useStore()
  const toast = useToast()
  const nav = useNavigate()
  const lk = useMemo(() => makeLookup(d), [d])
  const [f, setF] = useState<Draft>(() => initDraft(d, editId, sp.get('khach'), sp.get('chiec')))
  const [errs, setErrs] = useState<Errs>({})
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState(false)

  const order = editId ? lk.order(editId) : undefined
  const back = editId ? `/don/${editId}` : '/don'
  if (editId && !order) {
    return <Shell section="don" title="Không tìm thấy" back="/don"><div className="empty"><b>Không tìm thấy đơn</b><br /><Link to="/don">Về danh sách đơn</Link></div></Shell>
  }
  if (order && order.status !== 'preorder' && order.status !== 'confirmed') {
    return <Shell section="don" title={`Sửa ${d.orderCode[order.id]}`} back={back}>
      <div className="warn-box"><span>Đơn đã {order.status === 'cancelled' ? 'huỷ' : 'gửi'} — không sửa được chiếc / giá. Mã vận đơn và ghi chú sửa ở chi tiết đơn.</span></div>
      <Link className="btn btn-ghost btn-block" to={back}>Về chi tiết đơn</Link>
    </Shell>
  }

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setF((p) => ({ ...p, [k]: v }))
  const setPrice = (unitId: string, price: string) => setF((p) => ({ ...p, lines: p.lines.map((l) => (l.unitId === unitId ? { ...l, price } : l)) }))
  const removeLine = (unitId: string) => setF((p) => ({ ...p, lines: p.lines.filter((l) => l.unitId !== unitId) }))
  const toggleUnit = (u: UnitViewRow) => setF((p) => (p.lines.some((l) => l.unitId === u.unit_id)
    ? { ...p, lines: p.lines.filter((l) => l.unitId !== u.unit_id) }
    : p.lines.length >= MAX_LINES ? p : { ...p, lines: [...p.lines, { unitId: u.unit_id, price: fmt(u.list_price_vnd) }] }))

  const custOpts = d.customers
    .filter((c) => !c.is_hidden || c.id === f.custId)
    .sort((a, b) => a.fb_name.localeCompare(b.fb_name, 'vi'))
  const selCust = f.custId ? lk.cust(f.custId) : undefined

  // Từng dòng: chiếc (v_units), nơi đang ở (A6), giá chốt.
  const rows = f.lines.map((l) => {
    const u = lk.unit(l.unitId)
    const where = u ? unitAvailability(u, editId) : null
    return { l, u, where, price: parseNum(l.price) }
  })
  // Chiếc vừa bị máy khác giữ / bán / lô huỷ trong lúc đang nhập (realtime) ⇒ chặn lưu.
  const lost = rows.filter((r) => !r.u || !r.where)
  const incomingLots = [...new Set(rows.filter((r) => r.where === 'incoming').map((r) => r.u!.lot_id))]

  // A6 xem trước (DB quyết lại lúc lưu).
  let preview: { st: OrderStatusDb | 'block'; msg: string } | null = null
  if (lost.length) {
    preview = {
      st: 'block',
      msg: `Không còn chọn được: ${lost.map((r) => {
        const u = r.u
        if (!u) return 'một chiếc đã bị xoá'
        if (u.lot_status === 'cancelled') return `${u.code} (lô đã huỷ)`
        const by = u.holding_order_id ? d.orderCode[u.holding_order_id] ?? 'đơn khác' : 'đơn khác'
        return `${u.code} (${u.status === 'sold' ? `đã bán · ${by}` : `đã giữ cho ${by}`})`
      }).join(', ')} — bỏ chiếc này khỏi đơn.`,
    }
  } else if (rows.length) {
    preview = incomingLots.length
      ? { st: 'preorder', msg: `→ Đặt trước, chờ ${incomingLots.map((id) => d.lotCode[id] ?? 'lô').join(', ')} về. Khi lô nhận vào kho, đơn tự chuyển Đã chốt.` }
      : { st: 'confirmed', msg: '→ Đã chốt — mọi chiếc đều đang trong kho.' }
  }

  // Tiền xem trước (số chính thức do DB tính sau khi lưu).
  const ship = parseNum(f.shipFee) ?? 0
  const dep = parseNum(f.deposit) ?? 0
  const allPriced = rows.length > 0 && rows.every((r) => r.price != null)
  const goods = allPriced ? rows.reduce((a, r) => a + (r.price ?? 0), 0) : null
  const total = goods != null ? goods + (f.shipPayer === 'customer' ? ship : 0) : null
  const paidBefore = editId ? lk.sum(editId)?.paid_vnd ?? 0 : 0
  const costKnown = rows.every((r) => r.u)
  const profit = allPriced && costKnown
    ? rows.reduce((a, r) => a + (r.price ?? 0) - (r.u?.cost_vnd ?? 0), 0) - (f.shipPayer === 'shop' ? ship : 0)
    : null
  const provisional = rows.some((r) => r.u?.cost_is_provisional)

  function validate(): Errs {
    const e: Errs = {}
    if (!f.custId && !f.newName.trim()) e['o-name'] = 'Nhập tên Facebook của khách.'
    if (f.custId && !selCust) e['o-cust'] = 'Khách không còn — chọn lại.'
    if (!f.lines.length) e['o-units'] = 'Chọn ít nhất 1 chiếc — bấm "+ Chọn chiếc".'
    for (const r of rows) {
      const p = r.price
      if (!r.l.price.trim()) e[`o-price-${r.l.unitId}`] = 'Nhập giá chốt cho chiếc này.'
      else if (p == null || p < 0 || !Number.isInteger(p)) e[`o-price-${r.l.unitId}`] = 'Giá chốt là số đồng ≥ 0.'
    }
    if (f.shipFee.trim() && (parseNum(f.shipFee) == null || ship < 0 || !Number.isInteger(ship))) e['o-ship'] = 'Phí ship là số đồng ≥ 0.'
    if (!editId && f.deposit.trim() && (parseNum(f.deposit) == null || dep < 0 || !Number.isInteger(dep))) e['o-dep'] = 'Tiền cọc là số đồng ≥ 0.'
    if (!f.date) e['o-date'] = 'Chọn ngày.'
    if (preview?.st === 'block') e.form = preview.msg
    return e
  }

  async function save() {
    const e = validate()
    setErrs(e)
    if (Object.keys(e).length) { toast(e.form ?? e['o-units'] ?? 'Kiểm tra lại các ô báo đỏ.'); return }
    setBusy(true)
    try {
      const cust = f.custId
        ? { customer_id: f.custId }
        : { new_customer: { fb_name: f.newName.trim(), fb_url: f.newFb.trim() || null, phone: f.newPhone.trim() || null, address: f.newAddr.trim() || null } }
      const res = await rpc<{ order_id: string; status: OrderStatusDb }>('save_order', {
        p_order_id: editId,
        p_order: {
          ...cust, order_date: f.date, ship_fee_vnd: ship, ship_fee_payer: f.shipPayer,
          tracking_no: order?.tracking_no ?? null, note: f.note.trim() || null,
          // Cọc chỉ khi tạo (sửa đơn mà gửi cọc ⇒ DEPOSIT_ONLY_ON_CREATE).
          ...(editId ? {} : { deposit_vnd: dep, deposit_paid_at: f.date }),
        },
        p_lines: rows.map((r) => ({ unit_id: r.l.unitId, unit_price_vnd: r.price })),
        p_expected_version: order?.version ?? null,
      })
      const code = editId ? d.orderCode[editId] : `D-${String(d.orders.length + 1).padStart(3, '0')}`
      toast(`Đã lưu ${code} · ${ORDER_LABEL[res.status]}${!editId && dep > 0 ? ` · cọc ${vnd(dep)}` : ''}`)
      nav(`/don/${res.order_id}`, { replace: true })
    } catch (err) {
      toast(err instanceof Error ? err.message : errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const Err = ({ k }: { k: string }) => (errs[k] ? <span className="err-text">{errs[k]}</span> : null)
  const title = editId ? `Sửa ${d.orderCode[editId]}` : 'Đơn bán mới'

  return (
    <Shell section="don" title={title} back={back}
      savebar={<button className="btn btn-primary btn-block" disabled={busy || preview?.st === 'block'} onClick={save}>{busy ? 'Đang lưu…' : 'Lưu đơn'}</button>}>
      <div className="form-grid">
        <label className="f" htmlFor="o-cust">Khách
          <select className="input" id="o-cust" value={f.custId} onChange={(e) => set('custId', e.target.value)}>
            <option value="">+ Khách mới</option>
            {custOpts.map((c) => <option key={c.id} value={c.id}>{c.fb_name}{c.phone ? ` · ${c.phone}` : ''}{c.is_hidden ? ' (đã ẩn)' : ''}</option>)}
          </select>
          <Err k="o-cust" />
        </label>
        {f.custId
          ? <div className="hint" style={{ alignSelf: 'end' }}>{selCust?.address || 'Chưa có địa chỉ'}</div>
          : <>
            <label className="f" htmlFor="o-name">Tên Facebook <span className="req">*</span>
              <input className="input" id="o-name" value={f.newName} onChange={(e) => set('newName', e.target.value)} maxLength={120} aria-invalid={!!errs['o-name']} />
              <Err k="o-name" />
            </label>
            <label className="f" htmlFor="o-fb">Link Facebook<input className="input" id="o-fb" value={f.newFb} onChange={(e) => set('newFb', e.target.value)} maxLength={500} /></label>
            <label className="f" htmlFor="o-phone">SĐT<input className="input" id="o-phone" inputMode="tel" value={f.newPhone} onChange={(e) => set('newPhone', e.target.value)} maxLength={30} /></label>
            <label className="f full" htmlFor="o-addr">Địa chỉ giao<input className="input" id="o-addr" value={f.newAddr} onChange={(e) => set('newAddr', e.target.value)} maxLength={500} /></label>
          </>}

        <p className="section-title full">Chiếc bán{rows.length ? ` · ${rows.length}` : ''}</p>
        {rows.length === 0 && <div className="empty full">Chưa chọn chiếc nào — bấm “+ Chọn chiếc”.</div>}
        {rows.map((r) => (
          <div key={r.l.unitId} className="full ord-line">
            <div className="lrow">
              <span className="ord-unit">
                <b className="num">{r.u?.code ?? '?'}</b> · {r.u?.model_name ?? 'Không tìm thấy chiếc'}
                {r.where === 'in_stock' && <span className="pill ok">Trong kho</span>}
                {r.where === 'incoming' && <span className="pill way">Đang về ({d.lotCode[r.u!.lot_id] ?? 'lô'})</span>}
                {!r.where && <span className="pill bad">Không còn chọn được</span>}
              </span>
              <button type="button" className="link-btn" onClick={() => removeLine(r.l.unitId)} aria-label={`Bỏ ${r.u?.code ?? 'chiếc'}`}>Bỏ</button>
            </div>
            <label className="f" htmlFor={`o-price-${r.l.unitId}`}>Giá chốt
              <input className="input money" id={`o-price-${r.l.unitId}`} inputMode="numeric" value={r.l.price} onChange={(e) => setPrice(r.l.unitId, e.target.value)}
                placeholder={fmt(r.u?.list_price_vnd)} aria-invalid={!!errs[`o-price-${r.l.unitId}`]} />
              <Err k={`o-price-${r.l.unitId}`} />
              {r.u && <span className="hint">Giá bán dự kiến {vnd(r.u.list_price_vnd)} · giá nhập {vnd(r.u.cost_vnd)}{r.u.cost_is_provisional ? ' (tạm tính, chưa có ship lô)' : ''}</span>}
            </label>
          </div>
        ))}
        {f.lines.length < MAX_LINES && (
          <button type="button" id="o-units" className="btn btn-ghost full" onClick={() => setPicking(true)}>+ Chọn chiếc</button>
        )}
        {errs['o-units'] && <span className="err-text full">{errs['o-units']}</span>}
        {preview && (
          <div className={`${preview.st === 'block' ? 'warn-box' : 'note-box'} full`}>
            <span>{preview.msg}</span>
            {preview.st !== 'block' && <span className="pill solid">{ORDER_LABEL[preview.st]}</span>}
          </div>
        )}

        <p className="section-title full">Ship & tiền</p>
        <label className="f" htmlFor="o-ship">Phí ship trong VN
          <input className="input money" id="o-ship" inputMode="numeric" value={f.shipFee} onChange={(e) => set('shipFee', e.target.value)} placeholder="0" aria-invalid={!!errs['o-ship']} />
          <Err k="o-ship" />
        </label>
        <div className="f">
          <span className="small muted" id="o-payer-l">Ai trả ship</span>
          <div className="seg" id="o-payer" role="group" aria-labelledby="o-payer-l" style={{ justifyContent: 'flex-start' }}>
            <button type="button" aria-pressed={f.shipPayer === 'customer'} onClick={() => set('shipPayer', 'customer')}>Khách trả</button>
            <button type="button" aria-pressed={f.shipPayer === 'shop'} onClick={() => set('shipPayer', 'shop')}>Shop chịu</button>
          </div>
          <span className="hint">{f.shipPayer === 'customer' ? 'Thu hộ — cộng vào tiền khách trả, không tính lãi.' : 'Shop chịu — trừ vào lãi đơn.'}</span>
        </div>
        {editId
          ? <div className="hint" style={{ alignSelf: 'end' }}>Cọc / thu tiền ghi ở chi tiết đơn (đã thu {vnd(paidBefore)}).</div>
          : <label className="f" htmlFor="o-dep">Tiền cọc
            <input className="input money" id="o-dep" inputMode="numeric" value={f.deposit} onChange={(e) => set('deposit', e.target.value)} placeholder="0" aria-invalid={!!errs['o-dep']} />
            <Err k="o-dep" />
          </label>}
        <label className="f" htmlFor="o-date">Ngày
          <input className="input" id="o-date" type="date" value={f.date} onChange={(e) => set('date', e.target.value)} aria-invalid={!!errs['o-date']} />
          <Err k="o-date" />
        </label>
        <label className="f full" htmlFor="o-note">Ghi chú<input className="input" id="o-note" value={f.note} onChange={(e) => set('note', e.target.value)} maxLength={2000} /></label>

        <div className="calc full">
          <div className="ln"><span>Tiền hàng ({rows.length} chiếc)</span><span>{vnd(goods)}</span></div>
          <div className="ln"><span>Ship {f.shipPayer === 'customer' ? 'khách trả (thu hộ)' : 'shop chịu'}</span><span>{vnd(ship)}</span></div>
          <div className="ln total"><span>Khách phải trả</span><span>{vnd(total)}</span></div>
          {editId
            ? <div className="ln"><span>Đã thu</span><span>{vnd(paidBefore)}</span></div>
            : <div className="ln"><span>Cọc</span><span>{vnd(dep)}</span></div>}
          <div className="ln total"><span>Còn phải thu</span><span>{total != null ? vnd(total - (editId ? paidBefore : dep)) : '—'}</span></div>
          <div className="ln"><span>Lãi dự kiến</span><span>{profit != null ? vnd(profit) : '—'}</span></div>
          <div className="formula">= Σ(giá chốt − giá nhập ₫ hiện tại){f.shipPayer === 'shop' ? ' − ship shop chịu' : ''}{provisional ? ' · có chiếc giá nhập tạm tính' : ''}</div>
        </div>
      </div>

      {picking && <UnitPicker d={d} editId={editId} chosen={new Set(f.lines.map((l) => l.unitId))} full={f.lines.length >= MAX_LINES}
        onToggle={toggleUnit} onClose={() => setPicking(false)} />}
    </Shell>
  )
}

/** Sheet chọn chiếc: lọc theo model (chip) + tìm theo mã / số seri; chỉ chiếc chọn được theo A6. */
function UnitPicker({ d, editId, chosen, full, onToggle, onClose }: {
  d: DbData; editId: string | null; chosen: Set<string>; full: boolean; onToggle: (u: UnitViewRow) => void; onClose: () => void
}) {
  const [model, setModel] = useState<string>('')
  const [q, setQ] = useState('')
  const avail = useMemo(() => {
    const modelOrder = new Map(d.models.map((m, i) => [m.id, i]))
    return d.unitView
      .filter((u) => unitAvailability(u, editId) != null)
      // Trong kho trước, rồi Đang về; trong nhóm theo thứ tự model rồi mã.
      .sort((a, b) => Number(b.is_received) - Number(a.is_received)
        || (modelOrder.get(a.model_id) ?? 0) - (modelOrder.get(b.model_id) ?? 0) || a.code.localeCompare(b.code))
  }, [d.unitView, d.models, editId])
  const models = useMemo(() => {
    const m = new Map<string, { name: string; n: number }>()
    for (const u of avail) {
      const x = m.get(u.model_id) ?? { name: u.model_name, n: 0 }
      x.n += 1
      m.set(u.model_id, x)
    }
    return [...m]
  }, [avail])
  const qq = fold(q.trim())
  const list = avail.filter((u) => (!model || u.model_id === model)
    && (!qq || fold(u.code).includes(qq) || fold(u.serial_no ?? '').includes(qq) || fold(u.model_name).includes(qq)))

  return (
    <Sheet title="Chọn chiếc" onClose={onClose}
      footer={<button className="btn btn-primary btn-block" onClick={onClose}>Xong{chosen.size ? ` · đã chọn ${chosen.size}` : ''}</button>}>
      <input className="input" id="up-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Tìm mã (KU-007) hoặc số seri" aria-label="Tìm chiếc" />
      {models.length > 1 && (
        <div className="chips" role="group" aria-label="Lọc theo model">
          <button type="button" className="chip" aria-pressed={!model} onClick={() => setModel('')}>Tất cả<span className="c">{avail.length}</span></button>
          {models.map(([id, m]) => <button key={id} type="button" className="chip" aria-pressed={model === id} onClick={() => setModel(id)}>{m.name}<span className="c">{m.n}</span></button>)}
        </div>
      )}
      {full && <p className="hint">Đơn đã đủ {MAX_LINES} chiếc — tối đa {MAX_LINES} chiếc / đơn.</p>}
      {avail.length === 0
        ? <div className="empty">Không còn chiếc nào Trong kho / Đang về chưa giữ. <Link to="/lo/new">Nhập lô Goofish</Link> trước.</div>
        : list.length === 0
          ? <div className="empty">Không có chiếc khớp — đổi model hoặc từ khoá.</div>
          : (
            <div className="list up-list">
              {list.map((u) => {
                const on = chosen.has(u.unit_id)
                return (
                  <button key={u.unit_id} type="button" className="li" aria-pressed={on} disabled={!on && full} onClick={() => onToggle(u)}>
                    <span className={`up-check ${on ? 'on' : ''}`} aria-hidden="true" />
                    <span className="main">
                      <b className="num">{u.code}</b> · {u.model_name}
                      <span className="s">
                        {u.is_received ? <span className="pill ok">Trong kho</span> : <span className="pill way">Đang về ({d.lotCode[u.lot_id] ?? 'lô'})</span>}
                        {u.serial_no ? ` · seri ${u.serial_no}` : ''}
                      </span>
                    </span>
                    <span className="v">{vnd(u.list_price_vnd)}</span>
                  </button>
                )
              })}
            </div>
          )}
    </Sheet>
  )
}
