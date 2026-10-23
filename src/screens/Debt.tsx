import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useData, useStore } from '../data/store.tsx'
import type { TxnRow } from '../data/types.ts'
import { supabase } from '../lib/supabase.ts'
import { Shell } from '../ui/Shell.tsx'
import { Sheet, useToast } from '../ui/feedback.tsx'
import { dmy, parseNum, pct, todayVn, tr, vnd } from '../ui/format.ts'
import { CONFLICT_MSG, lotModelsText, useDesk, writeError } from './overview/common.tsx'

const KIND_LABEL = { payable: 'Phải trả', transfer: 'Đã chuyển', adjustment: 'Điều chỉnh' } as const
/** Ảnh hưởng tới dư nợ: phải trả +, đã chuyển −, điều chỉnh theo dấu (BR-12). */
const effect = (t: TxnRow) => (t.kind === 'transfer' ? -t.amount_vnd : t.amount_vnd)

// SC_10 Công nợ trung gian: số dư, ghi đã chuyển / điều chỉnh, sổ giao dịch (mới nhất trước, kèm dư nợ sau giao dịch).
export default function Debt() {
  const d = useData()
  const desk = useDesk()
  const [params, setParams] = useSearchParams()
  const [form, setForm] = useState<'transfer' | 'adjustment' | null>(params.get('chuyen') === '1' ? 'transfer' : null)
  const [picked, setPicked] = useState<TxnRow | null>(null)

  // ?chuyen=1 (từ nút + giữa) mở ngay sheet ghi chuyển tiền
  useEffect(() => {
    if (params.get('chuyen') === '1') { setForm('transfer'); setParams({}, { replace: true }) }
  }, [params, setParams])
  const closeForm = useCallback(() => setForm(null), [])
  const closePicked = useCallback(() => setPicked(null), [])

  // Dư nợ lũy kế theo thứ tự thời gian, rồi hiển thị mới nhất trước
  const asc = [...d.txns].sort((a, b) => a.txn_date.localeCompare(b.txn_date) || a.created_at.localeCompare(b.created_at))
  let run = 0
  const rows = asc.map((t) => { run += effect(t); return { t, bal: run } }).reverse()
  const b = d.balance

  return (
    <Shell section="congno" title="Công nợ trung gian" back={desk ? undefined : '/them'}>
      <div className="cols">
        <div>
          <div className="kpis" style={{ gridTemplateColumns: '1fr' }}>
            <div className="kpi hero"><span className="k">Còn nợ trung gian</span><span className="v">{vnd(b.balance_vnd)}</span><span className="s">= tổng phải trả các lô − đã chuyển ± điều chỉnh</span></div>
          </div>
          <dl className="kv">
            <dt>Tổng phải trả (các lô)</dt><dd className="num">{vnd(b.total_payable_vnd)}</dd>
            <dt>Đã chuyển</dt><dd className="num">{vnd(b.total_transferred_vnd)}</dd>
            <dt>Điều chỉnh</dt><dd className="num">{b.total_adjustment_vnd > 0 ? '+' : ''}{vnd(b.total_adjustment_vnd)}</dd>
          </dl>
          <button className="btn btn-primary btn-block" onClick={() => setForm('transfer')}>Ghi đã chuyển tiền</button>
          <button className="btn btn-ghost btn-block" onClick={() => setForm('adjustment')}>Ghi điều chỉnh</button>
          <p className="hint">Mỗi lô tự ghi “phải trả” = Σ giá web các chiếc × tỷ giá × (1 + phí mua hộ %) + phí ship (BR-12, CR-003; không theo giá nhập sửa tay). Phí ship nhập sau sẽ tự cộng thêm. Điều chỉnh dùng khi trung gian tính khác (phí, chênh tỷ giá…).</p>
        </div>
        <div>
          <p className="section-title">Sổ giao dịch <span className="muted">{rows.length}</span></p>
          <div className="stack">
            {rows.length === 0 && <div className="empty">Chưa có giao dịch — mỗi lô Goofish lưu xong sẽ tự ghi “phải trả”.</div>}
            {rows.map(({ t, bal }) => {
              const a = effect(t)
              const amount = <span className="r"><span className="num" style={{ fontSize: 15 }}>{a >= 0 ? '+' : '−'}{tr(Math.abs(a))}</span><span className="ledger-bal">dư {tr(bal)}</span></span>
              if (t.kind === 'payable' && t.lot_id) {
                const l = d.lots.find((x) => x.id === t.lot_id)
                const fee = Number(l?.buying_fee_pct ?? 0)
                const feeTxt = fee > 0 ? ` · gồm phí mua hộ ${pct(fee)}` : ''
                const sub = !l ? '' : l.status === 'cancelled' ? 'Lô huỷ' : (l.ship_fee_vnd == null ? 'chưa gồm ship' : `gồm ship ${tr(l.ship_fee_vnd)}`) + feeTxt
                return (
                  <Link key={t.id} className="shot item" to={`/lo/${t.lot_id}`}>
                    <span className="t">{dmy(t.txn_date)} · Phải trả</span>
                    <span className="b">{d.lotCode[t.lot_id]} · {lotModelsText(d, t.lot_id)}</span>
                    {amount}
                    <span className="f">{l?.ship_fee_vnd == null && l?.status !== 'cancelled' ? <span className="req">{sub}</span> : sub}</span>
                  </Link>
                )
              }
              return (
                <button key={t.id} className="shot item" onClick={() => setPicked(t)}>
                  <span className="t">{dmy(t.txn_date)}</span>
                  <span className="b">{KIND_LABEL[t.kind]}</span>
                  {amount}
                  <span className="f">{t.note || '—'}</span>
                </button>
              )
            })}
          </div>
        </div>
      </div>
      {form && <TxnSheet kind={form} onClose={closeForm} />}
      {picked && <TxnInfoSheet t={picked} onClose={closePicked} />}
    </Shell>
  )
}

/** Sheet ghi Đã chuyển / Điều chỉnh (ghi thẳng bảng intermediary_txns — RLS chỉ cho 2 loại này). */
function TxnSheet({ kind, onClose }: { kind: 'transfer' | 'adjustment'; onClose: () => void }) {
  const d = useData()
  const { reload } = useStore()
  const toast = useToast()
  const [amt, setAmt] = useState('')
  const [date, setDate] = useState(todayVn())
  const [note, setNote] = useState('')
  const [sign, setSign] = useState<1 | -1>(-1)
  const [err, setErr] = useState<{ amt?: string; date?: string; form?: string }>({})
  const [busy, setBusy] = useState(false)

  async function save() {
    const a = parseNum(amt)
    const e: typeof err = {}
    if (a == null || a <= 0 || !Number.isInteger(a)) e.amt = 'Nhập số tiền lớn hơn 0, đơn vị đồng (VD: 5.000.000).'
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) e.date = 'Chọn ngày.'
    else if (date > todayVn()) e.date = 'Ngày không được sau hôm nay.'
    setErr(e)
    if (e.amt || e.date) return
    setBusy(true)
    const amount = kind === 'adjustment' ? sign * (a as number) : (a as number)
    const { error } = await supabase.from('intermediary_txns').insert({ txn_date: date, kind, amount_vnd: amount, note: note.trim() || null })
    if (error) { setBusy(false); setErr({ form: writeError(error) }); return }
    await reload()
    setBusy(false)
    toast(kind === 'transfer' ? `Đã ghi chuyển ${tr(amount)}` : `Đã ghi điều chỉnh ${amount > 0 ? '+' : '−'}${tr(Math.abs(amount))}`)
    onClose()
  }

  return (
    <Sheet title={kind === 'transfer' ? 'Ghi đã chuyển tiền' : 'Ghi điều chỉnh công nợ'} onClose={onClose}
      footer={<button className="btn btn-primary btn-block" onClick={save} disabled={busy}>{busy ? 'Đang lưu…' : 'Lưu'}</button>}>
      <p className="muted small confirm-text">Đang nợ trung gian {vnd(d.balance.balance_vnd)}</p>
      {kind === 'adjustment' && (
        <div className="seg" role="group" aria-label="Chiều điều chỉnh">
          <button id="adj-minus" aria-pressed={sign === -1} onClick={() => setSign(-1)}>Giảm nợ (−)</button>
          <button id="adj-plus" aria-pressed={sign === 1} onClick={() => setSign(1)}>Tăng nợ (+)</button>
        </div>
      )}
      <label className="f">{kind === 'transfer' ? 'Số tiền đã chuyển (₫)' : 'Số tiền điều chỉnh (₫)'}
        <input className={`input money ${err.amt ? 'invalid' : ''}`} id="t-amt" inputMode="numeric" value={amt} onChange={(e) => setAmt(e.target.value)} />
        {err.amt && <span className="field-err">{err.amt}</span>}
      </label>
      <label className="f">Ngày
        <input className={`input ${err.date ? 'invalid' : ''}`} id="t-date" type="date" max={todayVn()} value={date} onChange={(e) => setDate(e.target.value)} />
        {err.date && <span className="field-err">{err.date}</span>}
      </label>
      <label className="f">Ghi chú
        <input className="input" id="t-note" maxLength={1000} placeholder={kind === 'transfer' ? 'VD: CK Vietcombank' : 'VD: trung gian tính thêm phí đóng gói'} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {err.form && <p className="err-text">{err.form}</p>}
    </Sheet>
  )
}

/** Xem / xoá một giao dịch ghi tay (Phải trả do hệ thống sinh — không xoá được). */
function TxnInfoSheet({ t, onClose }: { t: TxnRow; onClose: () => void }) {
  const { reload } = useStore()
  const toast = useToast()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  async function del() {
    setBusy(true)
    const { data, error } = await supabase.from('intermediary_txns').delete().eq('id', t.id).eq('version', t.version).select('id')
    if (error || !data?.length) { setBusy(false); setErr(error ? writeError(error) : CONFLICT_MSG); await reload(); return }
    await reload()
    setBusy(false)
    toast('Đã xoá giao dịch')
    onClose()
  }
  const a = effect(t)
  return (
    <Sheet title={KIND_LABEL[t.kind]} onClose={onClose}
      footer={confirming
        ? <button className="btn btn-danger btn-block" onClick={del} disabled={busy}>{busy ? 'Đang xoá…' : 'Xoá vĩnh viễn'}</button>
        : <button className="btn btn-danger btn-block" onClick={() => setConfirming(true)}>Xoá giao dịch</button>}>
      <dl className="kv">
        <dt>Ngày</dt><dd>{dmy(t.txn_date)}/{t.txn_date.slice(0, 4)}</dd>
        <dt>Ảnh hưởng dư nợ</dt><dd className="num">{a >= 0 ? '+' : '−'}{vnd(Math.abs(a))}</dd>
        <dt>Ghi chú</dt><dd>{t.note || '—'}</dd>
      </dl>
      {confirming && <p className="warn-box">Xoá giao dịch này? Công nợ trung gian sẽ {a < 0 ? 'tăng' : 'giảm'} {vnd(Math.abs(a))}. Không hoàn tác được.</p>}
      {err && <p className="err-text">{err}</p>}
    </Sheet>
  )
}
