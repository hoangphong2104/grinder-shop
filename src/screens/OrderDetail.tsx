// SC_08 Chi tiết đơn — bước trạng thái, thao tác theo trạng thái (chốt / gửi / hoàn tất / huỷ), tiền & lãi, thông tin khách.
import { useCallback, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useData, useStore } from '../data/store.tsx'
import { errorMessage } from '../data/errors.ts'
import type { OrderStatusDb, PaymentKindDb, PaymentRow } from '../data/types.ts'
import { supabase } from '../lib/supabase.ts'
import { Sheet, useToast } from '../ui/feedback.tsx'
import { Shell } from '../ui/Shell.tsx'
import { ORDER_LABEL } from '../ui/status.tsx'
import { dmy, parseNum, todayVn, tr, vnd } from '../ui/format.ts'
import { isSentStatus, makeLookup, PAY_LABEL, VERSION_CONFLICT_MSG } from './orders/common.ts'

type SheetKind = 'ship' | 'done' | 'cancel' | 'pay' | 'info' | { delPay: PaymentRow }

export default function OrderDetail() {
  const { id = '' } = useParams()
  const d = useData()
  const { rpc, reload } = useStore()
  const toast = useToast()
  const lk = useMemo(() => makeLookup(d), [d])
  const [sheet, setSheet] = useState<SheetKind | null>(null)
  const [busy, setBusy] = useState(false)
  const close = useCallback(() => setSheet(null), [])

  const o = lk.order(id)
  const s = lk.sum(id)
  if (!o || !s) {
    return <Shell section="don" title="Không tìm thấy" back="/don"><div className="empty"><b>Không tìm thấy đơn</b><br />Đơn có thể đã bị xoá trên máy khác. <Link to="/don">Về danh sách đơn</Link></div></Shell>
  }
  const code = d.orderCode[o.id]
  const c = lk.cust(o.customer_id)
  const lines = lk.lines(o.id)
  const total = lk.total(s)
  const due = s.receivable_vnd
  const sent = isSentStatus(o.status)
  const profit = lk.profit(o.id)
  const payments = d.payments.filter((p) => p.order_id === o.id)

  // Gộp SL theo biến thể (1 biến thể có thể ở nhiều dòng).
  const need = new Map<string, number>()
  for (const x of lines) need.set(x.variant_id, (need.get(x.variant_id) ?? 0) + x.qty)

  // Q-013 / BR-08: chốt được khi mọi biến thể: SL ≤ Có sẵn − SL các đơn Đã chốt khác (đúng như private.order_fillable).
  const confirmedOther = (vid: string) => d.orderLines
    .filter((x) => x.variant_id === vid && x.order_id !== o.id && lk.order(x.order_id)?.status === 'confirmed')
    .reduce((a, x) => a + x.qty, 0)
  const fillable = [...need].every(([vid, q]) => q <= (lk.variant(vid)?.on_hand_qty ?? 0) - confirmedOther(vid))
  // BR-09: gửi được khi Có sẵn ≥ SL từng biến thể.
  const short = [...need].filter(([vid, q]) => (lk.variant(vid)?.on_hand_qty ?? 0) < q)

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true)
    try { await fn(); setSheet(null); toast(ok) } catch (e) { toast(e instanceof Error ? e.message : errorMessage(e)) } finally { setBusy(false) }
  }
  const chot = () => run(() => rpc('confirm_preorder', { p_order_id: o.id, p_expected_version: o.version }), `Đã chốt ${code}`)
  const complete = (force: boolean) => run(() => rpc('complete_order', { p_order_id: o.id, p_force: force, p_expected_version: o.version }), `Hoàn tất ${code}`)
  const onDone = () => (due !== 0 ? setSheet('done') : complete(false))

  const flow: OrderStatusDb[] = [o.status === 'preorder' ? 'preorder' : 'confirmed', 'shipped', 'completed']
  const idx = flow.indexOf(o.status)
  const stepper = (
    <div className={`stepper ${o.status === 'cancelled' ? 'cancel' : ''}`}>
      {flow.map((k, i) => <div key={k} className={`st ${i < idx ? 'done' : i === idx ? 'cur' : ''}`}><span className="dot" /><span className="lb">{ORDER_LABEL[k]}</span></div>)}
    </div>
  )

  let action = null
  if (o.status === 'preorder') {
    action = fillable
      ? <><div className="note-box"><span>Đã đủ hàng có sẵn cho đơn này.</span></div>
        <button className="btn btn-primary btn-block" disabled={busy} onClick={chot}>Chốt đơn</button></>
      : <div className="note-box way"><span>Chờ hàng về — {[...need.keys()].map((vid) => {
        const st = lk.stock(vid)
        return `${lk.vName(vid)}: sẵn ${st?.on_hand ?? 0}, đang về ${st?.incoming ?? 0}`
      }).join('; ')}</span></div>
  } else if (o.status === 'confirmed') {
    action = <button className="btn btn-primary btn-block" disabled={busy} onClick={() => setSheet('ship')}>Gửi hàng</button>
  } else if (o.status === 'shipped') {
    action = <button className="btn btn-primary btn-block" disabled={busy} onClick={onDone}>Hoàn tất</button>
  }

  const canPay = o.status !== 'cancelled' || s.paid_vnd > 0
  const fbIsUrl = !!c?.fb_url && /^https?:\/\//i.test(c.fb_url)

  return (
    <Shell section="don" title={`${code} · ${s.customer_name}`} back="/don"
      actions={(o.status === 'preorder' || o.status === 'confirmed') && <Link className="btn btn-ghost btn-sm" to={`/don/${o.id}/sua`}>Sửa</Link>}>
      <div className="cols">
        <div>
          {stepper}
          {o.status === 'cancelled' && (
            <div className="warn-box"><span>Đơn đã huỷ.{s.refund_due_vnd > 0 && <> Cần hoàn khách {vnd(s.refund_due_vnd)} — ghi “Hoàn tiền” khi đã trả lại.</>}</span></div>
          )}
          {o.completion_forced && o.status === 'completed' && <div className="note-box"><span>Đơn hoàn tất khi chưa thu khớp tiền (đã xác nhận bỏ qua).</span></div>}
          {action}
          <div className="calc">
            {lines.map((x) => (
              <div key={x.id} className="ln"><span>{x.qty} × {lk.vName(x.variant_id)} @ {tr(x.unit_price_vnd)}</span><span>{vnd(x.qty * x.unit_price_vnd)}</span></div>
            ))}
            <div className="ln"><span>Ship VN · {o.ship_fee_payer === 'customer' ? 'khách trả (thu hộ)' : 'shop chịu'}</span><span>{vnd(o.ship_fee_vnd)}</span></div>
            <div className="ln total"><span>Khách phải trả</span><span>{vnd(total)}</span></div>
            {payments.map((p) => (
              <div key={p.id} className="ln">
                <span><button className="link-btn" style={{ padding: 0 }} onClick={() => setSheet({ delPay: p })} aria-label={`Khoản ${PAY_LABEL[p.kind]} ngày ${dmy(p.paid_at)}`}>{dmy(p.paid_at)} · {PAY_LABEL[p.kind]}</button>{p.note ? <span className="small"> · {p.note}</span> : null}</span>
                <span>{p.kind === 'refund' ? '−' : ''}{vnd(p.amount_vnd)}</span>
              </div>
            ))}
            {o.status === 'cancelled'
              ? <div className="ln total"><span>Cần hoàn khách</span><span className={s.refund_due_vnd > 0 ? 'req' : undefined}>{vnd(s.refund_due_vnd)}</span></div>
              : due < 0
                ? <div className="ln total"><span>Khách trả dư</span><span>{vnd(-due)}</span></div>
                : <div className="ln total"><span>Còn phải thu</span><span className={due > 0 ? 'req' : undefined}>{vnd(due)}</span></div>}
          </div>
          {canPay && <button className="btn btn-ghost btn-block" disabled={busy} onClick={() => setSheet('pay')}>Ghi thu tiền</button>}
        </div>
        <div>
          <dl className="kv">
            <dt>Khách</dt><dd>{c ? <Link to={`/don?khach=${c.id}&f=all`}>{c.fb_name}</Link> : s.customer_name}{c?.is_hidden ? <span className="muted small"> (đã ẩn)</span> : null}</dd>
            <dt>Facebook</dt><dd className="small">{fbIsUrl ? <a href={c!.fb_url!} target="_blank" rel="noreferrer">{c!.fb_url}</a> : c?.fb_url || '—'}</dd>
            <dt>SĐT</dt><dd>{c?.phone || '—'}</dd>
            <dt>Địa chỉ</dt><dd className="small">{c?.address || '—'}</dd>
            <dt>Ngày đơn</dt><dd>{dmy(o.order_date)}</dd>
            <dt>Ngày gửi</dt><dd>{dmy(o.shipped_at)}</dd>
            <dt>Mã vận đơn</dt><dd>{o.tracking_no || '—'}</dd>
            <dt>Ghi chú</dt><dd className="small">{o.note || '—'}</dd>
          </dl>
          <button className="btn btn-ghost btn-block" disabled={busy} onClick={() => setSheet('info')}>Sửa mã vận đơn / ghi chú</button>
          <div className="calc">
            {lines.map((x) => {
              const avg = lk.stock(x.variant_id)?.avg_cost_vnd ?? 0
              return (
                <div key={x.id} className="ln"><span>Giá vốn · {lk.variant(x.variant_id)?.name ?? '?'}</span>
                  <span>{x.unit_cost_vnd != null ? vnd(x.unit_cost_vnd) : <span className="muted">~{vnd(avg)} (BQ hiện tại)</span>}</span></div>
              )
            })}
            <div className="ln total"><span>{sent ? 'Lãi đơn' : 'Lãi dự kiến'}</span>
              <span>{profit.value == null ? '—' : profit.est ? `~${vnd(profit.value)}` : vnd(profit.value)}</span></div>
            <div className="formula">Giá vốn chốt lúc gửi hàng (BR-05){o.ship_fee_payer === 'shop' ? ' · đã trừ ship shop chịu' : ''}</div>
          </div>
          {(o.status === 'preorder' || o.status === 'confirmed') && <button className="btn btn-danger btn-block" disabled={busy} onClick={() => setSheet('cancel')}>Huỷ đơn</button>}
        </div>
      </div>

      {sheet === 'ship' && (
        <ShipSheet onClose={close} busy={busy} tracking={o.tracking_no ?? ''}
          shortText={short.map(([vid, q]) => `${lk.vName(vid)}: cần ${q}, có sẵn ${lk.variant(vid)?.on_hand_qty ?? 0}`).join('; ')}
          avgText={[...need.keys()].map((vid) => tr(lk.stock(vid)?.avg_cost_vnd ?? 0)).join(', ')}
          onOk={(tracking, date) => run(() => rpc('ship_order', { p_order_id: o.id, p_tracking_no: tracking || null, p_shipped_at: date || null, p_expected_version: o.version }),
            `Đã gửi ${code}${profit.value != null ? ` · lãi ${tr(profit.value)}` : ''}`)} />
      )}
      {sheet === 'done' && (
        <Sheet title={due > 0 ? 'Khách còn nợ' : 'Khách trả dư'} onClose={close}
          footer={<button className="btn btn-primary btn-block" disabled={busy} onClick={() => complete(true)}>Vẫn hoàn tất</button>}>
          <p className="muted" style={{ textAlign: 'center', margin: 0 }}>
            {due > 0 ? `Còn phải thu ${vnd(due)}. Vẫn hoàn tất đơn? (BR-10)` : `Khách trả dư ${vnd(-due)}. Vẫn hoàn tất đơn? (Q-010)`}
          </p>
        </Sheet>
      )}
      {sheet === 'cancel' && (
        <Sheet title="Huỷ đơn?" onClose={close}
          footer={<button className="btn btn-danger btn-block" disabled={busy}
            onClick={() => run(() => rpc('cancel_order', { p_order_id: o.id, p_expected_version: o.version }),
              s.paid_vnd > 0 ? `Đã huỷ ${code} · cần hoàn ${tr(s.paid_vnd)}` : `Đã huỷ ${code}`)}>Huỷ đơn</button>}>
          <p className="muted" style={{ textAlign: 'center', margin: 0 }}>
            Bỏ giữ hàng cho {code}. Tiền cọc đã thu cần ghi “Hoàn tiền” nếu trả lại khách.{s.paid_vnd > 0 ? ` Đã thu ${vnd(s.paid_vnd)}.` : ''}
          </p>
        </Sheet>
      )}
      {sheet === 'pay' && (
        <PaySheet onClose={close} busy={busy} cancelled={o.status === 'cancelled'}
          prefill={o.status === 'cancelled' ? s.refund_due_vnd : Math.abs(due)} defaultKind={o.status === 'cancelled' || due < 0 ? 'refund' : 'payment'}
          onOk={(amount, kind, date, note) => run(async () => {
            const { error } = await supabase.from('payments').insert({ order_id: o.id, paid_at: date, kind, amount_vnd: amount, note: note || null })
            if (error) throw new Error(errorMessage(error))
            await reload()
          }, `Đã ghi ${PAY_LABEL[kind].toLowerCase()} ${vnd(amount)}`)} />
      )}
      {sheet === 'info' && (
        <InfoSheet onClose={close} busy={busy} tracking={o.tracking_no ?? ''} note={o.note ?? ''} version={o.version}
          onOk={(tracking, note, version) => run(async () => {
            const { data: rows, error } = await supabase.from('orders').update({ tracking_no: tracking || null, note: note || null })
              .eq('id', o.id).eq('version', version).select('id')
            if (error) throw new Error(errorMessage(error))
            await reload()
            if (!rows?.length) throw new Error(VERSION_CONFLICT_MSG)
          }, 'Đã lưu')} />
      )}
      {sheet && typeof sheet === 'object' && (
        <Sheet title="Xoá khoản thu?" onClose={close}
          footer={<button className="btn btn-danger btn-block" disabled={busy} onClick={() => run(async () => {
            const { error } = await supabase.from('payments').delete().eq('id', sheet.delPay.id)
            if (error) throw new Error(errorMessage(error))
            await reload()
          }, 'Đã xoá khoản thu')}>Xoá khoản thu</button>}>
          <p className="muted" style={{ textAlign: 'center', margin: 0 }}>
            {PAY_LABEL[sheet.delPay.kind]} {vnd(sheet.delPay.amount_vnd)} ngày {dmy(sheet.delPay.paid_at)}. Chỉ xoá khi ghi nhầm — còn phải thu sẽ tính lại.
          </p>
        </Sheet>
      )}
    </Shell>
  )
}

function ShipSheet({ onClose, onOk, busy, tracking, shortText, avgText }: {
  onClose: () => void; onOk: (tracking: string, date: string) => void; busy: boolean; tracking: string; shortText: string; avgText: string
}) {
  const [tk, setTk] = useState(tracking)
  const [date, setDate] = useState(todayVn())
  return (
    <Sheet title="Gửi hàng" onClose={onClose}
      footer={<button className="btn btn-primary btn-block" disabled={busy || !!shortText || !date} onClick={() => onOk(tk.trim(), date)}>Xác nhận đã gửi</button>}>
      {shortText && <div className="warn-box"><span>Không đủ hàng có sẵn để gửi (BR-09) — {shortText}.</span></div>}
      <label className="f" htmlFor="sh-tracking">Mã vận đơn<input className="input" id="sh-tracking" value={tk} onChange={(e) => setTk(e.target.value)} placeholder="VD: GHTK 1234" maxLength={100} /></label>
      <label className="f" htmlFor="sh-date">Ngày gửi<input className="input" id="sh-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      <p className="hint">Trừ kho và chốt giá vốn = BQ hiện tại ({avgText}). Không hoàn tác được.</p>
    </Sheet>
  )
}

function PaySheet({ onClose, onOk, busy, prefill, defaultKind, cancelled }: {
  onClose: () => void; onOk: (amount: number, kind: PaymentKindDb, date: string, note: string) => void
  busy: boolean; prefill: number; defaultKind: PaymentKindDb; cancelled: boolean
}) {
  const [amt, setAmt] = useState(prefill > 0 ? prefill.toLocaleString('vi-VN') : '')
  const [kind, setKind] = useState<PaymentKindDb>(defaultKind)
  const [date, setDate] = useState(todayVn())
  const [note, setNote] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const kinds: PaymentKindDb[] = cancelled ? ['refund'] : ['payment', 'deposit', 'refund']
  const submit = () => {
    const a = parseNum(amt)
    if (a == null || a <= 0 || !Number.isInteger(a)) { setErr('Nhập số tiền lớn hơn 0 (đồng, số nguyên).'); return }
    if (!date) { setErr('Chọn ngày thu.'); return }
    setErr(null)
    onOk(a, kind, date, note.trim())
  }
  return (
    <Sheet title="Ghi thu tiền" onClose={onClose}
      footer={<button className="btn btn-primary btn-block" disabled={busy} onClick={submit}>Lưu</button>}>
      <label className="f" htmlFor="p-amt">Số tiền (₫)
        <input className="input money" id="p-amt" inputMode="numeric" value={amt} onChange={(e) => setAmt(e.target.value)} aria-invalid={!!err} />
        {err && <span className="err-text">{err}</span>}
      </label>
      <div className="seg" id="p-kind" role="group" aria-label="Loại khoản thu">
        {kinds.map((k) => <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>{PAY_LABEL[k]}</button>)}
      </div>
      {kind === 'refund' && <p className="hint">Hoàn tiền trừ vào số đã thu của đơn.</p>}
      <label className="f" htmlFor="p-date">Ngày<input className="input" id="p-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      <label className="f" htmlFor="p-note">Ghi chú<input className="input" id="p-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="VD: CK Vietcombank" maxLength={1000} /></label>
    </Sheet>
  )
}

function InfoSheet({ onClose, onOk, busy, tracking, note, version }: {
  onClose: () => void; onOk: (tracking: string, note: string, version: number) => void; busy: boolean; tracking: string; note: string; version: number
}) {
  // Version lúc mở sheet: máy khác sửa trong lúc đang mở ⇒ báo xung đột thay vì ghi đè.
  const [ver] = useState(version)
  const [tk, setTk] = useState(tracking)
  const [nt, setNt] = useState(note)
  return (
    <Sheet title="Mã vận đơn / ghi chú" onClose={onClose}
      footer={<button className="btn btn-primary btn-block" disabled={busy} onClick={() => onOk(tk.trim(), nt.trim(), ver)}>Lưu</button>}>
      <label className="f" htmlFor="od-tracking">Mã vận đơn<input className="input" id="od-tracking" value={tk} onChange={(e) => setTk(e.target.value)} maxLength={100} /></label>
      <label className="f" htmlFor="od-note">Ghi chú<textarea className="input" id="od-note" value={nt} onChange={(e) => setNt(e.target.value)} maxLength={2000} /></label>
    </Sheet>
  )
}
