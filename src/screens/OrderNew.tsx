// SC_09 Đơn bán mới (/don/new) và Sửa đơn chưa gửi (/don/:id/sua).
// Lưu qua RPC save_order (BR-07 do DB quyết trạng thái). Khách mới: tạo dòng customers trước (bảng ghi trực tiếp được);
// tiền cọc: ghi 1 khoản payments kind 'deposit' sau khi đơn đã lưu (save_order không nhận cọc).
import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useData, useStore } from '../data/store.tsx'
import { errorMessage } from '../data/errors.ts'
import type { DbData, OrderStatusDb, ShipPayerDb } from '../data/types.ts'
import { supabase } from '../lib/supabase.ts'
import { useToast } from '../ui/feedback.tsx'
import { Shell } from '../ui/Shell.tsx'
import { ORDER_LABEL } from '../ui/status.tsx'
import { parseNum, todayVn, vnd } from '../ui/format.ts'
import { makeLookup } from './orders/common.ts'

interface LineDraft { key: number; variantId: string; qty: string; price: string }
interface Draft {
  custId: string; newName: string; newFb: string; newPhone: string; newAddr: string
  lines: LineDraft[]; shipFee: string; shipPayer: ShipPayerDb; deposit: string; date: string; note: string
}
type Errs = Partial<Record<string, string>>
const MAX_LINES = 20
let lineSeq = 1

function initDraft(d: DbData, orderId: string | null, presetCust: string | null): Draft {
  const o = orderId ? d.orders.find((x) => x.id === orderId) : undefined
  if (o) {
    return {
      custId: o.customer_id, newName: '', newFb: '', newPhone: '', newAddr: '',
      lines: d.orderLines.filter((x) => x.order_id === o.id).map((x) => ({ key: lineSeq++, variantId: x.variant_id, qty: String(x.qty), price: x.unit_price_vnd.toLocaleString('vi-VN') })),
      shipFee: o.ship_fee_vnd ? o.ship_fee_vnd.toLocaleString('vi-VN') : '', shipPayer: o.ship_fee_payer, deposit: '', date: o.order_date, note: o.note ?? '',
    }
  }
  const cust = presetCust && d.customers.some((c) => c.id === presetCust && !c.is_hidden) ? presetCust : ''
  return {
    custId: cust, newName: '', newFb: '', newPhone: '', newAddr: '',
    lines: [{ key: lineSeq++, variantId: '', qty: '1', price: '' }],
    shipFee: '', shipPayer: d.settings?.default_ship_fee_payer ?? 'customer', deposit: '', date: todayVn(), note: '',
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
  const { rpc, reload } = useStore()
  const toast = useToast()
  const nav = useNavigate()
  const lk = useMemo(() => makeLookup(d), [d])
  const [f, setF] = useState<Draft>(() => initDraft(d, editId, sp.get('khach')))
  const [errs, setErrs] = useState<Errs>({})
  const [busy, setBusy] = useState(false)

  const order = editId ? lk.order(editId) : undefined
  const back = editId ? `/don/${editId}` : '/don'
  if (editId && !order) {
    return <Shell section="don" title="Không tìm thấy" back="/don"><div className="empty"><b>Không tìm thấy đơn</b><br /><Link to="/don">Về danh sách đơn</Link></div></Shell>
  }
  if (order && order.status !== 'preorder' && order.status !== 'confirmed') {
    return <Shell section="don" title={`Sửa ${d.orderCode[order.id]}`} back={back}>
      <div className="warn-box"><span>Đơn đã {order.status === 'cancelled' ? 'huỷ' : 'gửi'} — không sửa được hàng / giá. Mã vận đơn và ghi chú sửa ở chi tiết đơn.</span></div>
      <Link className="btn btn-ghost btn-block" to={back}>Về chi tiết đơn</Link>
    </Shell>
  }

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setF((p) => ({ ...p, [k]: v }))
  const setLine = (key: number, patch: Partial<LineDraft>) => setF((p) => ({ ...p, lines: p.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }))

  // SL của chính đơn đang sửa đang được giữ ⇒ cộng lại khi tính (save_order loại đơn này khỏi "Đã giữ").
  const ownQty = (vid: string) => (editId ? d.orderLines.filter((x) => x.order_id === editId && x.variant_id === vid).reduce((a, x) => a + x.qty, 0) : 0)
  const avail = (vid: string) => {
    const st = lk.stock(vid)
    const own = ownQty(vid)
    return { free: (st?.free_on_hand ?? 0) + own, sellable: (st?.sellable ?? 0) + own, incoming: st?.incoming ?? 0, avg: st?.avg_cost_vnd ?? 0 }
  }

  // Danh sách chọn: biến thể đang bán (+ biến thể đã có trong đơn đang sửa dù đã ẩn), theo thứ tự model.
  const modelOrder = new Map(d.models.map((m, i) => [m.id, i]))
  const usedVids = new Set(f.lines.map((l) => l.variantId))
  const variantOpts = d.stock
    .filter((s) => s.is_active || usedVids.has(s.variant_id))
    .sort((a, b) => (modelOrder.get(a.model_id) ?? 0) - (modelOrder.get(b.model_id) ?? 0) || a.variant_name.localeCompare(b.variant_name, 'vi'))
  const custOpts = d.customers
    .filter((c) => !c.is_hidden || c.id === f.custId)
    .sort((a, b) => a.fb_name.localeCompare(b.fb_name, 'vi'))
  const selCust = f.custId ? lk.cust(f.custId) : undefined

  // Từng dòng: SL, giá (trống = giá niêm yết).
  const rows = f.lines.map((l) => {
    const st = l.variantId ? lk.stock(l.variantId) : undefined
    const q = parseNum(l.qty)
    const price = parseNum(l.price) ?? st?.list_price_vnd ?? null
    return { l, st, q: q != null && Number.isInteger(q) && q > 0 ? q : 0, price }
  })

  // BR-07 xem trước — gộp SL theo biến thể.
  const need = new Map<string, number>()
  for (const r of rows) if (r.st && r.q > 0) need.set(r.l.variantId, (need.get(r.l.variantId) ?? 0) + r.q)
  let preview: { st: OrderStatusDb | 'block'; msg: string } | null = null
  if (need.size) {
    const over = [...need].filter(([vid, q]) => q > avail(vid).sellable)
    const notReady = [...need].filter(([vid, q]) => q > avail(vid).free)
    if (over.length) {
      preview = { st: 'block', msg: `Vượt số có thể bán — ${over.map(([vid]) => `${lk.vName(vid)} (${Math.max(0, avail(vid).sellable)})`).join('; ')}. Nhập thêm lô trước.` }
    } else if (notReady.length) {
      const single = need.size === 1
      preview = {
        st: 'preorder',
        msg: single
          ? `Không đủ hàng sẵn (còn ${Math.max(0, avail(notReady[0][0]).free)} chưa giữ), đang về ${avail(notReady[0][0]).incoming} → đơn sẽ là “Đặt trước”, chờ hàng về.`
          : `Không đủ hàng sẵn: ${notReady.map(([vid]) => `${lk.vName(vid)} (còn ${Math.max(0, avail(vid).free)} chưa giữ, đang về ${avail(vid).incoming})`).join('; ')} → đơn sẽ là “Đặt trước”, chờ hàng về.`,
      }
    } else {
      const [vid] = [...need.keys()]
      preview = { st: 'confirmed', msg: need.size === 1 ? `Có sẵn ${avail(vid).free} chiếc chưa giữ → đơn sẽ là “Đã chốt”.` : 'Đủ hàng có sẵn chưa giữ → đơn sẽ là “Đã chốt”.' }
    }
  }

  // Tiền xem trước (số chính thức do DB tính sau khi lưu).
  const ship = parseNum(f.shipFee) ?? 0
  const dep = parseNum(f.deposit) ?? 0
  const priced = rows.filter((r) => r.st && r.q > 0)
  const allPriced = priced.length > 0 && priced.every((r) => r.price != null)
  const goods = allPriced ? priced.reduce((a, r) => a + r.q * (r.price ?? 0), 0) : null
  const total = goods != null ? goods + (f.shipPayer === 'customer' ? ship : 0) : null
  const paidBefore = editId ? lk.sum(editId)?.paid_vnd ?? 0 : 0
  const avgKnown = priced.every((r) => (r.st?.avg_cost_vnd ?? 0) > 0)
  const profit = allPriced && avgKnown
    ? priced.reduce((a, r) => a + r.q * ((r.price ?? 0) - (r.st?.avg_cost_vnd ?? 0)), 0) - (f.shipPayer === 'shop' ? ship : 0)
    : null

  function validate(): Errs {
    const e: Errs = {}
    if (!f.custId && !f.newName.trim()) e['o-name'] = 'Nhập tên Facebook của khách.'
    if (f.custId && !selCust) e['o-cust'] = 'Khách không còn — chọn lại.'
    f.lines.forEach((l) => {
      if (!l.variantId) e[`o-variant-${l.key}`] = 'Chọn model · biến thể.'
      const q = parseNum(l.qty)
      if (q == null || !Number.isInteger(q) || q < 1 || q > 1000) e[`o-qty-${l.key}`] = 'Số lượng là số nguyên 1–1000.'
      const st = l.variantId ? lk.stock(l.variantId) : undefined
      const p = parseNum(l.price)
      if (l.price.trim() && (p == null || p < 0 || !Number.isInteger(p))) e[`o-price-${l.key}`] = 'Giá chốt là số đồng ≥ 0.'
      else if (p == null && st && st.list_price_vnd == null) e[`o-price-${l.key}`] = 'Biến thể chưa có giá niêm yết — nhập giá chốt.'
    })
    if (f.shipFee.trim() && (parseNum(f.shipFee) == null || ship < 0 || !Number.isInteger(ship))) e['o-ship'] = 'Phí ship là số đồng ≥ 0.'
    if (f.deposit.trim() && (parseNum(f.deposit) == null || dep < 0 || !Number.isInteger(dep))) e['o-dep'] = 'Tiền cọc là số đồng ≥ 0.'
    if (!f.date) e['o-date'] = 'Chọn ngày.'
    if (preview?.st === 'block') e.form = 'Vượt số có thể bán (BR-07) — giảm số lượng hoặc nhập thêm lô.'
    return e
  }

  async function save() {
    const e = validate()
    setErrs(e)
    if (Object.keys(e).length) { toast(e.form ?? 'Kiểm tra lại các ô báo đỏ.'); return }
    setBusy(true)
    try {
      // 1. Khách mới → tạo trước; giữ id trong form để bấm lưu lại không tạo trùng.
      let custId = f.custId
      if (!custId) {
        const { data: row, error } = await supabase.from('customers')
          .insert({ fb_name: f.newName.trim(), fb_url: f.newFb.trim() || null, phone: f.newPhone.trim() || null, address: f.newAddr.trim() || null })
          .select('id').single()
        if (error) throw new Error(errorMessage(error))
        custId = row.id as string
        setF((p) => ({ ...p, custId }))
      }
      // 2. Đơn + dòng (BR-07 trong DB).
      const res = await rpc<{ order_id: string; status: OrderStatusDb }>('save_order', {
        p_order_id: editId,
        p_order: {
          customer_id: custId, order_date: f.date, ship_fee_vnd: ship, ship_fee_payer: f.shipPayer,
          tracking_no: order?.tracking_no ?? null, note: f.note.trim() || null,
        },
        p_lines: rows.map((r) => ({ variant_id: r.l.variantId, qty: r.q, unit_price_vnd: r.price })),
        p_expected_version: order?.version ?? null,
      })
      const code = editId ? d.orderCode[editId] : `D-${String(d.orders.length + 1).padStart(3, '0')}`
      // 3. Cọc (chỉ khi tạo mới).
      let depMsg = ''
      if (!editId && dep > 0) {
        const { error } = await supabase.from('payments').insert({ order_id: res.order_id, paid_at: f.date, kind: 'deposit', amount_vnd: dep })
        if (error) depMsg = ' · CHƯA ghi được cọc, ghi lại ở chi tiết đơn'
        await reload()
      }
      toast(`Đã lưu ${code} · ${ORDER_LABEL[res.status]}${depMsg}`)
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

        <p className="section-title full">Hàng</p>
        {f.lines.map((l, i) => {
          const st = l.variantId ? lk.stock(l.variantId) : undefined
          return (
            <div key={l.key} className="full form-grid" style={{ gap: 10 }}>
              <label className="f" htmlFor={`o-variant-${l.key}`}>
                <span className="lrow"><span>Model · biến thể <span className="req">*</span>{f.lines.length > 1 ? ` (dòng ${i + 1})` : ''}</span>
                  {f.lines.length > 1 && <button type="button" className="link-btn" style={{ padding: 0 }} onClick={() => setF((p) => ({ ...p, lines: p.lines.filter((x) => x.key !== l.key) }))}>Xoá dòng</button>}</span>
                <select className="input" id={`o-variant-${l.key}`} value={l.variantId} onChange={(e) => setLine(l.key, { variantId: e.target.value, price: '' })} aria-invalid={!!errs[`o-variant-${l.key}`]}>
                  <option value="">Chọn…</option>
                  {variantOpts.map((s) => <option key={s.variant_id} value={s.variant_id}>{s.model_name} · {s.variant_name} — có thể bán {s.sellable + ownQty(s.variant_id)}</option>)}
                </select>
                <Err k={`o-variant-${l.key}`} />
              </label>
              <div className="two">
                <label className="f" htmlFor={`o-qty-${l.key}`}>Số lượng
                  <input className="input money" id={`o-qty-${l.key}`} inputMode="numeric" value={l.qty} onChange={(e) => setLine(l.key, { qty: e.target.value })} aria-invalid={!!errs[`o-qty-${l.key}`]} />
                  <Err k={`o-qty-${l.key}`} />
                </label>
                <label className="f" htmlFor={`o-price-${l.key}`}>Giá chốt / chiếc
                  <input className="input money" id={`o-price-${l.key}`} inputMode="numeric" value={l.price} onChange={(e) => setLine(l.key, { price: e.target.value })}
                    placeholder={st?.list_price_vnd != null ? st.list_price_vnd.toLocaleString('vi-VN') : ''} aria-invalid={!!errs[`o-price-${l.key}`]} />
                  <Err k={`o-price-${l.key}`} />
                </label>
              </div>
            </div>
          )
        })}
        {f.lines.length < MAX_LINES && (
          <button type="button" className="btn btn-ghost full" onClick={() => setF((p) => ({ ...p, lines: [...p.lines, { key: lineSeq++, variantId: '', qty: '1', price: '' }] }))}>+ Thêm dòng</button>
        )}
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
          <div className="ln"><span>Khách phải trả</span><span>{vnd(total)}</span></div>
          {editId
            ? <div className="ln"><span>Đã thu</span><span>{vnd(paidBefore)}</span></div>
            : <div className="ln"><span>Cọc</span><span>{vnd(dep)}</span></div>}
          <div className="ln total"><span>Còn phải thu</span><span>{total != null ? vnd(total - (editId ? paidBefore : dep)) : '—'}</span></div>
          <div className="ln"><span>Lãi dự kiến (theo giá vốn BQ hiện tại)</span><span>{profit != null ? vnd(profit) : '—'}</span></div>
        </div>
      </div>
    </Shell>
  )
}
