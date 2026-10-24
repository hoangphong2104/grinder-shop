import { Fragment, useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useData, useStore } from '../data/store.tsx'
import type { CashEntryRow, CashKindDb, DbData, TxnRow } from '../data/types.ts'
import { supabase } from '../lib/supabase.ts'
import { Shell } from '../ui/Shell.tsx'
import { Sheet, useToast } from '../ui/feedback.tsx'
import { Icon } from '../ui/icons.tsx'
import { CASH_KIND_LABEL, LotChip } from '../ui/status.tsx'
import { dmy, parseNum, todayVn, tr, vnd } from '../ui/format.ts'
import { CONFLICT_MSG, Ident, Row2, Tx, lotModelsText, useDesk, writeError } from './overview/common.tsx'
import { PayLotButton } from './lots/PayLot.tsx'

// SC_10 Sổ quỹ (CR-005 ý 15, 1, 2, 5) - thay "Công nợ trung gian".
// - Một quỹ chung bắt đầu từ 0: số dư (v_cash_balance), vào / ra tháng này (v_cash_monthly).
// - Bút toán: tự sinh (thu khách, hoàn tiền, trả trung gian, ship shop chịu, ship chiều về - chỉ đọc, "sửa ở nguồn")
//   + ghi tay (Chi phí khác có loại, Nạp vốn, Rút vốn; Điều chỉnh chỉ còn cho khoản cũ - CR-006) - thêm / sửa / xoá (bảng cash_entries).
// - Công nợ trung gian: tổng còn nợ + từng lô còn nợ với nút "Đã thanh toán" (RPC pay_lot); sửa / xoá khoản Đã chuyển / Điều chỉnh.

type Filter = 'all' | 'thu' | 'tg' | 'ship' | 'hoan' | 'chi' | 'von'
const FILTERS: [Filter, string, CashKindDb[]][] = [
  ['all', 'Tất cả', []], ['thu', 'Thu khách', ['customer_payment']], ['tg', 'Trả trung gian', ['intermediary']], ['ship', 'Ship', ['ship_shop', 'return_ship']],
  ['hoan', 'Hoàn tiền', ['customer_refund']], ['chi', 'Chi phí', ['expense']], ['von', 'Vốn', ['capital_in', 'capital_out', 'adjustment']],
]
type ManualKind = 'expense' | 'capital_in' | 'capital_out' | 'adjustment'
const MANUAL: [ManualKind, string][] = [['expense', 'Chi phí'], ['capital_in', 'Nạp vốn'], ['capital_out', 'Rút vốn'], ['adjustment', 'Điều chỉnh']]
/** CR-006: ghi mới chỉ Chi phí / Nạp vốn / Rút vốn - "Điều chỉnh" trùng ý với nạp / rút nên ẩn; khoản Điều chỉnh cũ vẫn hiện để sửa / xoá. */
const MANUAL_NEW = MANUAL.filter(([k]) => k !== 'adjustment')
const EXPENSE_HINTS = ['Đóng gói', 'Phí sàn / quảng cáo', 'Ship nội thành', 'Sửa chữa', 'Dụng cụ']
const TXN_LABEL = { payable: 'Phải trả', transfer: 'Đã chuyển', adjustment: 'Điều chỉnh nợ' } as const

const amountText = (e: CashEntryRow) => (e.direction === 'in' ? `+${tr(e.amount_vnd)}` : `−${tr(e.amount_vnd)}`)
const dayLabel = (iso: string) => (iso === todayVn() ? 'Hôm nay' : `${dmy(iso)}/${iso.slice(0, 4)}`)

/** Nguồn của bút toán tự sinh: [mô tả, link] - đơn (thu / hoàn / ship) hoặc lô (trả trung gian). */
function sourceOf(d: DbData, e: CashEntryRow): { text: string; to: string | null } {
  const orderId = e.order_id ?? (e.payment_id ? d.payments.find((p) => p.id === e.payment_id)?.order_id ?? null : null)
  if (orderId) {
    const o = d.orderSummary.find((x) => x.order_id === orderId)
    return { text: `${d.orderCode[orderId] ?? 'Đơn'}${o ? ` · ${o.customer_name}` : ''}`, to: `/don/${orderId}` }
  }
  const lotId = e.lot_id ?? (e.txn_id ? d.txns.find((t) => t.id === e.txn_id)?.lot_id ?? null : null)
  if (lotId) return { text: `${d.lotCode[lotId] ?? 'Lô'} · ${lotModelsText(d, lotId, 'short')}`, to: `/lo/${lotId}` }
  return { text: e.kind === 'intermediary' ? 'không gắn lô' : '', to: null }
}

export default function Debt() {
  const d = useData()
  const desk = useDesk()
  const [params, setParams] = useSearchParams()
  const [filter, setFilter] = useState<Filter>('all')
  const [cashForm, setCashForm] = useState<{ kind: ManualKind; entry?: CashEntryRow } | null>(null)
  const [autoInfo, setAutoInfo] = useState<CashEntryRow | null>(null)
  const [txnForm, setTxnForm] = useState<{ kind: 'transfer' | 'adjustment'; txn?: TxnRow } | null>(params.get('chuyen') === '1' ? { kind: 'transfer' } : null)

  // ?chuyen=1 (link cũ) mở ngay sheet ghi chuyển tiền trung gian
  useEffect(() => {
    if (params.get('chuyen') === '1') { setTxnForm({ kind: 'transfer' }); setParams({}, { replace: true }) }
  }, [params, setParams])
  const closeCash = useCallback(() => setCashForm(null), [])
  const closeAuto = useCallback(() => setAutoInfo(null), [])
  const closeTxn = useCallback(() => setTxnForm(null), [])

  const entries = [...(d.cashEntries ?? [])].sort((a, b) => b.entry_date.localeCompare(a.entry_date) || b.created_at.localeCompare(a.created_at))
  const bal = d.cashBalance ?? { balance_vnd: 0, total_in_vnd: 0, total_out_vnd: 0, entry_count: 0 }
  const month = todayVn().slice(0, 7)
  const cm = (d.cashMonthly ?? []).find((m) => m.month.slice(0, 7) === month)
  const kindsOf = (f: Filter) => FILTERS.find(([k]) => k === f)![2]
  const match = (e: CashEntryRow, f: Filter) => f === 'all' || kindsOf(f).includes(e.kind)
  const shown = entries.filter((e) => match(e, filter))

  // Công nợ trung gian theo lô
  const owing = d.lotSummary.filter((s) => s.status !== 'cancelled' && s.outstanding_vnd > 0)
    .sort((a, b) => a.ordered_at.localeCompare(b.ordered_at))
  const debt = d.balance.balance_vnd
  const manualTxns = [...d.txns].filter((t) => t.kind !== 'payable')
    .sort((a, b) => b.txn_date.localeCompare(a.txn_date) || b.created_at.localeCompare(a.created_at))
  const [allTxns, setAllTxns] = useState(false)

  const openEntry = (e: CashEntryRow) => {
    if (!e.is_auto) { setCashForm({ kind: e.kind as ManualKind, entry: e }); return }
    // Trả trung gian: nguồn là khoản Đã chuyển - sửa ngay ở đây
    const t = e.txn_id ? d.txns.find((x) => x.id === e.txn_id) : undefined
    if (t && t.kind === 'transfer') { setTxnForm({ kind: 'transfer', txn: t }); return }
    setAutoInfo(e)
  }

  const hero = (
    <div className="stack">
      <div className="cash-hero">
        <span className="k">Quỹ hiện có</span>
        <span className={`v ${bal.balance_vnd < 0 ? 'neg' : ''}`}>{bal.balance_vnd < 0 ? '−' : ''}{vnd(Math.abs(bal.balance_vnd))}</span>
        <span className="io">
          <span>Tháng {Number(month.slice(5))}: vào <b className="pos">+{tr(cm?.in_vnd ?? 0)}</b></span>
          <span>ra <b className="neg">−{tr(cm?.out_vnd ?? 0)}</b></span>
        </span>
      </div>
      <div className="cash-acts" role="group" aria-label="Ghi khoản thu chi">
        {MANUAL_NEW.map(([k, t]) => (
          <button key={k} className={`btn ${k === 'expense' ? 'btn-primary' : 'btn-ghost'}`} id={`cash-add-${k}`} onClick={() => setCashForm({ kind: k })}>
            {k === 'expense' && <Icon name="plus" />}{t}
          </button>
        ))}
      </div>
    </div>
  )

  const intermediary = (
    <div className="stack">
      <p className="section-title">Công nợ trung gian <span className={debt > 0 ? 'neg' : 'muted'}>{debt > 0 ? `còn nợ ${tr(debt)}` : debt < 0 ? `trả dư ${tr(-debt)}` : 'hết nợ'}</span></p>
      {owing.length === 0
        ? <p className="muted small" style={{ margin: 0 }}>Không lô nào còn nợ trung gian.</p>
        : (
          <div className="ov-list">
            {owing.map((s) => (
              <Row2 key={s.lot_id}
                a={<Link className="row" style={{ gap: 8, minWidth: 0, color: 'inherit', textDecoration: 'none' }} to={`/lo/${s.lot_id}`}><Ident id={d.lotCode[s.lot_id] ?? 'Lô'} text={lotModelsText(d, s.lot_id, 'short')} /></Link>}
                b={<span className="neg">{tr(s.outstanding_vnd)}</span>}
                c={<><LotChip s={s.status} /><Tx>{s.paid_vnd > 0 ? `đã trả ${tr(s.paid_vnd)} / ${tr(s.payable_vnd)}` : `phải trả ${tr(s.payable_vnd)}`}</Tx></>}
                d={<PayLotButton lotId={s.lot_id} id={`pay-${s.lot_id}`} />} />
            ))}
          </div>
        )}
      <div className="btn-row">
        <button className="btn btn-ghost" id="debt-transfer" onClick={() => setTxnForm({ kind: 'transfer' })}>Ghi đã chuyển</button>
        <button className="btn btn-ghost" id="debt-adjust" onClick={() => setTxnForm({ kind: 'adjustment' })}>Điều chỉnh nợ</button>
      </div>
      {manualTxns.length > 0 && (
        <button type="button" className="link-btn small" id="debt-txns" style={{ alignSelf: 'flex-start' }} aria-expanded={allTxns} onClick={() => setAllTxns((v) => !v)}>
          {allTxns ? 'Ẩn' : 'Xem'} khoản đã chuyển / điều chỉnh nợ ({manualTxns.length}) <Icon name="chev" size={14} />
        </button>
      )}
      {allTxns && (
        <div className="ov-list">
          {manualTxns.map((t) => (
            <Row2 key={t.id} onClick={() => setTxnForm({ kind: t.kind as 'transfer' | 'adjustment', txn: t })}
              a={<><b className="id muted">{dmy(t.txn_date)}</b><span className="tx"><b>{TXN_LABEL[t.kind]}</b>{t.lot_id ? ` · ${d.lotCode[t.lot_id] ?? ''}` : ''}</span></>}
              b={t.kind === 'transfer' ? tr(t.amount_vnd) : `${t.amount_vnd > 0 ? '+' : '−'}${tr(Math.abs(t.amount_vnd))}`}
              c={<Tx>{t.note || (t.kind === 'adjustment' ? (t.amount_vnd > 0 ? 'tăng nợ' : 'giảm nợ') : '-')}</Tx>}
              d="sửa / xoá" />
          ))}
        </div>
      )}
    </div>
  )

  const book = (
    <div className="stack">
      <p className="section-title">Thu chi <span className="muted">{shown.length}</span></p>
      <div className="chips" role="group" aria-label="Lọc loại thu chi">
        {FILTERS.map(([k, t]) => (
          <button key={k} className="chip" id={`cash-f-${k}`} aria-pressed={filter === k} onClick={() => setFilter(k)}>
            {t} <span className="c">{entries.filter((e) => match(e, k)).length}</span>
          </button>
        ))}
      </div>
      {shown.length === 0
        ? <div className="empty">{entries.length === 0 ? 'Chưa có khoản thu chi - khoản thu khách, trả trung gian, ship sẽ tự ghi vào đây. Bấm "Nạp vốn" để ghi tiền vốn ban đầu.' : 'Không có khoản nào loại này.'}</div>
        : (
          <div className="ov-list">
            {shown.map((e, i) => {
              const head = i === 0 || shown[i - 1].entry_date !== e.entry_date
              const src = e.is_auto ? sourceOf(d, e) : null
              const title = e.kind === 'expense' && e.expense_category ? e.expense_category : CASH_KIND_LABEL[e.kind]
              const sub = e.is_auto ? [src?.text, e.note].filter(Boolean).join(' · ') : [e.kind === 'expense' ? 'Chi phí khác' : null, e.note].filter(Boolean).join(' · ')
              return (
                <Fragment key={e.id}>
                  {head && <div className="ov-gh"><span>{dayLabel(e.entry_date)}</span></div>}
                  <Row2 onClick={() => openEntry(e)} label={`${title} ${amountText(e)}`}
                    a={<span className="tx"><b>{title}</b></span>}
                    b={<span className={e.direction === 'in' ? 'pos' : ''}>{amountText(e)}</span>}
                    c={<Tx>{sub || '-'}</Tx>}
                    d={e.is_auto ? 'tự động' : 'ghi tay'} />
                </Fragment>
              )
            })}
          </div>
        )}
    </div>
  )

  return (
    <Shell section="congno" title="Sổ quỹ" back={desk ? undefined : '/them'}>
      {desk
        ? <div className="cols"><div className="stack">{hero}{intermediary}</div>{book}</div>
        : <>{hero}{intermediary}{book}</>}
      {cashForm && <CashSheet kind={cashForm.kind} entry={cashForm.entry} onClose={closeCash} />}
      {autoInfo && <AutoSheet e={autoInfo} onClose={closeAuto} />}
      {txnForm && <TxnSheet kind={txnForm.kind} txn={txnForm.txn} onClose={closeTxn} />}
    </Shell>
  )
}

/** Thêm / sửa / xoá khoản ghi tay (cash_entries: expense / capital_in / capital_out / adjustment). */
function CashSheet({ kind: kind0, entry, onClose }: { kind: ManualKind; entry?: CashEntryRow; onClose: () => void }) {
  const d = useData()
  const { reload } = useStore()
  const toast = useToast()
  const [kind, setKind] = useState<ManualKind>(kind0)
  const [dir, setDir] = useState<'in' | 'out'>(entry?.direction ?? 'out')
  const [amt, setAmt] = useState(entry ? String(entry.amount_vnd) : '')
  const [date, setDate] = useState(entry?.entry_date ?? todayVn())
  const [cat, setCat] = useState(entry?.expense_category ?? '')
  const [note, setNote] = useState(entry?.note ?? '')
  const [err, setErr] = useState<{ amt?: string; date?: string; cat?: string; form?: string }>({})
  const [busy, setBusy] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const cats = [...new Set([...(d.cashEntries ?? []).map((e) => e.expense_category).filter((c): c is string => !!c), ...EXPENSE_HINTS])]

  async function save() {
    const a = parseNum(amt)
    const e: typeof err = {}
    if (a == null || a <= 0 || !Number.isInteger(a)) e.amt = 'Nhập số tiền lớn hơn 0, đơn vị đồng (VD: 200.000).'
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) e.date = 'Chọn ngày.'
    else if (date > todayVn()) e.date = 'Ngày không được sau hôm nay.'
    if (kind === 'expense' && cat.trim().length > 60) e.cat = 'Loại chi phí tối đa 60 ký tự.'
    setErr(e)
    if (e.amt || e.date || e.cat) return
    setBusy(true)
    const direction = kind === 'capital_in' ? 'in' : kind === 'adjustment' ? dir : 'out'
    const row = { entry_date: date, direction, amount_vnd: a, kind, expense_category: kind === 'expense' ? cat.trim() || null : null, note: note.trim() || null }
    const res = entry
      ? await supabase.from('cash_entries').update(row).eq('id', entry.id).eq('version', entry.version).select('id')
      : await supabase.from('cash_entries').insert(row).select('id')
    if (res.error || (entry && !res.data?.length)) { setBusy(false); setErr({ form: res.error ? writeError(res.error) : CONFLICT_MSG }); await reload(); return }
    await reload()
    setBusy(false)
    toast(`${entry ? 'Đã sửa' : 'Đã ghi'} ${MANUAL.find(([k]) => k === kind)![1].toLowerCase()} ${direction === 'in' ? '+' : '−'}${tr(a!)}`)
    onClose()
  }
  async function del() {
    if (!entry) return
    setBusy(true)
    const { data, error } = await supabase.from('cash_entries').delete().eq('id', entry.id).eq('version', entry.version).select('id')
    if (error || !data?.length) { setBusy(false); setErr({ form: error ? writeError(error) : CONFLICT_MSG }); await reload(); return }
    await reload()
    setBusy(false)
    toast('Đã xoá khoản thu chi')
    onClose()
  }

  return (
    <Sheet title={entry ? 'Sửa khoản thu chi' : 'Ghi khoản thu chi'} onClose={onClose}
      footer={confirmDel
        ? <div className="btn-row"><button className="btn btn-ghost" onClick={() => setConfirmDel(false)}>Không</button><button className="btn btn-danger" onClick={del} disabled={busy}>{busy ? 'Đang xoá…' : 'Xoá vĩnh viễn'}</button></div>
        : <div className={entry ? 'btn-row' : ''}>
          {entry && <button className="btn btn-ghost" id="cash-del" onClick={() => setConfirmDel(true)}>Xoá</button>}
          <button className="btn btn-primary btn-block" id="cash-save" onClick={save} disabled={busy}>{busy ? 'Đang lưu…' : 'Lưu'}</button>
        </div>}>
      <div className="cash-sheet-kinds" role="radiogroup" aria-label="Loại khoản">
        {(kind0 === 'adjustment' ? MANUAL : MANUAL_NEW).map(([k, t]) => <button key={k} className="chip" role="radio" id={`cash-k-${k}`} aria-checked={kind === k} aria-pressed={kind === k} onClick={() => setKind(k)}>{t}</button>)}
      </div>
      {kind === 'adjustment' && (
        <div className="seg" role="group" aria-label="Chiều điều chỉnh">
          <button id="cash-dir-in" aria-pressed={dir === 'in'} onClick={() => setDir('in')}>Tăng quỹ (+)</button>
          <button id="cash-dir-out" aria-pressed={dir === 'out'} onClick={() => setDir('out')}>Giảm quỹ (−)</button>
        </div>
      )}
      <label className="f">Số tiền (₫)
        <input className={`input money ${err.amt ? 'invalid' : ''}`} id="cash-amt" inputMode="numeric" value={amt} onChange={(e) => setAmt(e.target.value)} />
        {err.amt && <span className="field-err">{err.amt}</span>}
      </label>
      {kind === 'expense' && (
        <label className="f">Loại chi phí
          <input className={`input ${err.cat ? 'invalid' : ''}`} id="cash-cat" list="cash-cats" maxLength={60} placeholder="VD: Đóng gói" value={cat} onChange={(e) => setCat(e.target.value)} />
          <datalist id="cash-cats">{cats.map((c) => <option key={c} value={c} />)}</datalist>
          {err.cat && <span className="field-err">{err.cat}</span>}
        </label>
      )}
      <label className="f">Ngày
        <input className={`input ${err.date ? 'invalid' : ''}`} id="cash-date" type="date" max={todayVn()} value={date} onChange={(e) => setDate(e.target.value)} />
        {err.date && <span className="field-err">{err.date}</span>}
      </label>
      <label className="f">Ghi chú
        <input className="input" id="cash-note" maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {confirmDel && <p className="warn-box">Xoá khoản này? Quỹ sẽ {entry?.direction === 'in' ? 'giảm' : 'tăng'} {vnd(entry?.amount_vnd ?? 0)}. Không hoàn tác được.</p>}
      {err.form && <p className="err-text">{err.form}</p>}
    </Sheet>
  )
}

/** Bút toán tự sinh: chỉ xem - sửa ở nguồn (đơn / lô). */
function AutoSheet({ e, onClose }: { e: CashEntryRow; onClose: () => void }) {
  const d = useData()
  const src = sourceOf(d, e)
  return (
    <Sheet title={CASH_KIND_LABEL[e.kind]} onClose={onClose}
      footer={src.to ? <Link className="btn btn-primary btn-block" to={src.to} onClick={onClose}>Sửa ở nguồn: mở {src.text.split(' · ')[0]}</Link> : undefined}>
      <dl className="kv">
        <dt>Ngày</dt><dd>{dmy(e.entry_date)}/{e.entry_date.slice(0, 4)}</dd>
        <dt>Số tiền</dt><dd className={`num ${e.direction === 'in' ? 'pos' : 'neg'}`}>{e.direction === 'in' ? '+' : '−'}{vnd(e.amount_vnd)}</dd>
        <dt>Nguồn</dt><dd>{src.text || '-'}</dd>
        <dt>Ghi chú</dt><dd>{e.note || '-'}</dd>
      </dl>
      <p className="hint">Khoản tự động - sửa / xoá ở {src.to?.startsWith('/don') ? 'đơn bán (khoản thu / phí ship)' : 'nguồn'}; sổ quỹ tự cập nhật theo.</p>
    </Sheet>
  )
}

/** Ghi / sửa / xoá khoản Đã chuyển hoặc Điều chỉnh công nợ trung gian (bảng intermediary_txns - được grant). */
function TxnSheet({ kind, txn, onClose }: { kind: 'transfer' | 'adjustment'; txn?: TxnRow; onClose: () => void }) {
  const d = useData()
  const { reload } = useStore()
  const toast = useToast()
  const [amt, setAmt] = useState(txn ? String(Math.abs(txn.amount_vnd)) : '')
  const [date, setDate] = useState(txn?.txn_date ?? todayVn())
  const [note, setNote] = useState(txn?.note ?? '')
  const [lotId, setLotId] = useState(txn?.lot_id ?? '')
  const [sign, setSign] = useState<1 | -1>(txn && txn.amount_vnd > 0 ? 1 : -1)
  const [err, setErr] = useState<{ amt?: string; date?: string; form?: string }>({})
  const [busy, setBusy] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const lots = d.lotSummary.filter((s) => s.status !== 'cancelled' && (s.outstanding_vnd > 0 || s.lot_id === txn?.lot_id))

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
    const row: Record<string, unknown> = { txn_date: date, amount_vnd: amount, note: note.trim() || null }
    if (kind === 'transfer') row.lot_id = lotId || null
    const res = txn
      ? await supabase.from('intermediary_txns').update(row).eq('id', txn.id).eq('version', txn.version).select('id')
      : await supabase.from('intermediary_txns').insert({ ...row, kind }).select('id')
    if (res.error || (txn && !res.data?.length)) { setBusy(false); setErr({ form: res.error ? writeError(res.error) : CONFLICT_MSG }); await reload(); return }
    await reload()
    setBusy(false)
    toast(kind === 'transfer' ? `${txn ? 'Đã sửa' : 'Đã ghi'} chuyển ${tr(amount)}` : `${txn ? 'Đã sửa' : 'Đã ghi'} điều chỉnh ${amount > 0 ? '+' : '−'}${tr(Math.abs(amount))}`)
    onClose()
  }
  async function del() {
    if (!txn) return
    setBusy(true)
    const { data, error } = await supabase.from('intermediary_txns').delete().eq('id', txn.id).eq('version', txn.version).select('id')
    if (error || !data?.length) { setBusy(false); setErr({ form: error ? writeError(error) : CONFLICT_MSG }); await reload(); return }
    await reload()
    setBusy(false)
    toast('Đã xoá khoản')
    onClose()
  }

  return (
    <Sheet title={`${txn ? 'Sửa' : 'Ghi'} ${kind === 'transfer' ? 'khoản đã chuyển trung gian' : 'điều chỉnh nợ trung gian'}`} onClose={onClose}
      footer={confirmDel
        ? <div className="btn-row"><button className="btn btn-ghost" onClick={() => setConfirmDel(false)}>Không</button><button className="btn btn-danger" onClick={del} disabled={busy}>{busy ? 'Đang xoá…' : 'Xoá vĩnh viễn'}</button></div>
        : <div className={txn ? 'btn-row' : ''}>
          {txn && <button className="btn btn-ghost" id="t-del" onClick={() => setConfirmDel(true)}>Xoá</button>}
          <button className="btn btn-primary btn-block" id="t-save" onClick={save} disabled={busy}>{busy ? 'Đang lưu…' : 'Lưu'}</button>
        </div>}>
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
      {kind === 'transfer' && (
        <label className="f">Trả cho lô (tuỳ chọn)
          <select className="input" id="t-lot" value={lotId} onChange={(e) => {
            const v = e.target.value
            setLotId(v)
            const s = d.lotSummary.find((x) => x.lot_id === v)
            if (s && !amt && s.outstanding_vnd > 0) setAmt(String(s.outstanding_vnd))
          }}>
            <option value="">Không gắn lô</option>
            {lots.map((s) => <option key={s.lot_id} value={s.lot_id}>{d.lotCode[s.lot_id]} · còn nợ {tr(s.outstanding_vnd)}</option>)}
          </select>
        </label>
      )}
      <label className="f">Ngày
        <input className={`input ${err.date ? 'invalid' : ''}`} id="t-date" type="date" max={todayVn()} value={date} onChange={(e) => setDate(e.target.value)} />
        {err.date && <span className="field-err">{err.date}</span>}
      </label>
      <label className="f">Ghi chú
        <input className="input" id="t-note" maxLength={1000} placeholder={kind === 'transfer' ? 'VD: CK Vietcombank' : 'VD: trung gian tính thêm phí đóng gói'} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {confirmDel && <p className="warn-box">Xoá khoản này? Công nợ trung gian {kind === 'transfer' ? 'tăng' : 'đổi'} {vnd(Math.abs(txn?.amount_vnd ?? 0))}{kind === 'transfer' ? ', quỹ tăng lại' : ''}. Không hoàn tác được.</p>}
      {err.form && <p className="err-text">{err.form}</p>}
    </Sheet>
  )
}
