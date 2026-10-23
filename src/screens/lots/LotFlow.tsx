// Thao tác trên lô dùng chung cho danh sách + chi tiết (v0.2, CR-001): chuyển bước, nhận vào kho (BR-02, Q-011,
// A7 tự chốt đơn Đặt trước), phí ship (trước nhận: save_lot; sau nhận: update_lot_ship_fee — A3, A10), huỷ lô
// (LOT_HAS_RESERVED_UNITS ⇒ liệt kê đơn đang giữ chiếc).
import { useCallback, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useData, useStore } from '../../data/store.tsx'
import type { DbData, LotRow, UnitViewRow } from '../../data/types.ts'
import { Sheet, useToast } from '../../ui/feedback.tsx'
import { Icon } from '../../ui/icons.tsx'
import { LOT_LABEL } from '../../ui/status.tsx'
import { cny, dmy, parseNum, todayVn, vnd } from '../../ui/format.ts'
import { autoUnitCost, roundVnd } from '../../domain/index.ts'
import { codesText, nextStatus, unitsOfLot } from './common.tsx'
import { errText, RpcError, useRpcDetail } from './rpc.ts'

/** save_lot nhận tối đa 1050 phần tử p_groups (≤ 1000 chiếc giữ lại + nhóm mới; lô tối đa 1000 chiếc). */
export const MAX_GROUP_ITEMS = 1050

/** Đối số save_lot giữ nguyên mọi trường + mọi chiếc của lô chưa nhận, chỉ đổi phần truyền vào. */
export function saveLotArgs(l: LotRow, units: UnitViewRow[], patch: { ship_fee_vnd?: number | null }) {
  return {
    p_lot_id: l.id,
    p_lot: {
      goofish_url: l.goofish_url, goofish_item_id: l.goofish_item_id, seller_id: l.seller_id, screenshot_path: l.screenshot_path,
      listing_title: l.listing_title, ordered_at: l.ordered_at, exchange_rate: Number(l.exchange_rate),
      ship_fee_vnd: 'ship_fee_vnd' in patch ? patch.ship_fee_vnd : l.ship_fee_vnd, status: l.status, note: l.note,
    },
    p_groups: units.map((u) => ({ unit_id: u.unit_id })),
    p_expected_version: l.version,
  }
}

/** Phí ship gợi ý = phí/chiếc lô gần nhất × số chiếc lô (BR-02). */
export function suggestedShip(d: DbData, qty: number): number | null {
  const per = d.suggestions.last_ship_fee_per_unit_vnd
  return per != null && qty > 0 ? roundVnd(per * qty) : null
}

/** Đọc ô phí ship: số đồng nguyên ≥ 0, trống → null, sai → NaN. */
function readFee(v: string): number | null {
  const n = parseNum(v)
  if (n == null) return null
  return Number.isInteger(n) && n >= 0 ? n : NaN
}

/** Xem trước giá nhập ₫ tự tính với phí ship mới (D2), gom theo model + giá ¥. Chiếc sửa tay giữ giá sửa tay. */
function CostPreview({ units, rate, fee }: { units: UnitViewRow[]; rate: number; fee: number }) {
  if (!units.length) return null
  const groups = new Map<string, { label: string; codes: string[]; cost: number }>()
  for (const u of units) {
    if (u.cost_is_overridden) continue
    const k = `${u.model_id}|${Number(u.price_cny)}`
    const g = groups.get(k) ?? { label: `${u.model_name} @ ${cny(Number(u.price_cny))}`, codes: [], cost: autoUnitCost({ priceCny: Number(u.price_cny) }, { rate, shipFee: fee }, units.length) }
    g.codes.push(u.code)
    groups.set(k, g)
  }
  const over = units.filter((u) => u.cost_is_overridden)
  return (
    <div className="calc">
      {[...groups.values()].map((g) => (
        <div className="ln" key={g.label}><span>{codesText(g.codes, 3)} · {g.label}</span><span>{vnd(g.cost)}</span></div>
      ))}
      {over.length > 0 && <div className="formula">Giữ giá sửa tay: {codesText(over.map((u) => u.code), 3)}</div>}
      <div className="formula">= giá ¥ × tỷ giá + ship lô ÷ {units.length} chiếc</div>
    </div>
  )
}

type Open =
  | { kind: 'receive' | 'ship' | 'cancel'; lotId: string }
  | { kind: 'confirmed'; ids: string[] }
  | null

interface ReceiveResult { units?: { unit_id: string; code: string; cost_vnd: number }[]; auto_confirmed_order_ids?: string[] }

export function useLotFlow(): {
  next: (l: LotRow) => void; receive: (l: LotRow) => void; shipFee: (l: LotRow) => void; cancel: (l: LotRow) => void
  busy: string | null; sheets: ReactNode
} {
  const { rpc } = useStore()
  const toast = useToast()
  const [open, setOpen] = useState<Open>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const close = useCallback(() => setOpen(null), [])

  const next = useCallback(async (l: LotRow) => {
    const n = nextStatus(l.status)
    if (!n) return
    if (n === 'received') { setOpen({ kind: 'receive', lotId: l.id }); return }
    setBusy(l.id)
    try {
      await rpc('set_lot_status', { p_lot_id: l.id, p_status: n, p_expected_version: l.version })
      toast('Lô chuyển: ' + LOT_LABEL[n])
    } catch (e) { toast(errText(e)) } finally { setBusy(null) }
  }, [rpc, toast])

  let sheets: ReactNode = null
  if (open?.kind === 'receive') sheets = <ReceiveSheet lotId={open.lotId} onClose={close} onDone={(ids) => setOpen(ids.length ? { kind: 'confirmed', ids } : null)} />
  else if (open?.kind === 'ship') sheets = <ShipFeeSheet lotId={open.lotId} onClose={close} />
  else if (open?.kind === 'cancel') sheets = <CancelSheet lotId={open.lotId} onClose={close} />
  else if (open?.kind === 'confirmed') sheets = <AutoConfirmedSheet ids={open.ids} onClose={close} />

  return {
    next: (l) => { void next(l) },
    receive: (l) => setOpen({ kind: 'receive', lotId: l.id }),
    shipFee: (l) => setOpen({ kind: 'ship', lotId: l.id }),
    cancel: (l) => setOpen({ kind: 'cancel', lotId: l.id }),
    busy, sheets,
  }
}

/** Nhận vào kho (từ bất kỳ bước mở nào — Q-011). Thiếu phí ship ⇒ hỏi phí (BR-02). Xong ⇒ báo đơn tự chốt (A7). */
function ReceiveSheet({ lotId, onClose, onDone }: { lotId: string; onClose: () => void; onDone: (confirmedIds: string[]) => void }) {
  const d = useData()
  const { rpc } = useStore()
  const toast = useToast()
  const l = d.lots.find((x) => x.id === lotId)
  const [fee, setFee] = useState('')
  const [date, setDate] = useState(todayVn())
  const [err, setErr] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  if (!l) return null
  const units = unitsOfLot(d, l.id), qty = units.length
  const needFee = l.ship_fee_vnd == null
  const sug = suggestedShip(d, qty)
  const feeVal = needFee ? readFee(fee) : l.ship_fee_vnd
  const held = units.filter((u) => u.holding_order_status === 'preorder').length

  const submit = async () => {
    if (needFee && feeVal == null) return setErr('Nhập phí ship về VN của cả lô (BR-02) — có thể dùng gợi ý.')
    if (feeVal != null && Number.isNaN(feeVal)) return setErr('Phí ship phải là số đồng nguyên ≥ 0.')
    if (!date) return setErr('Chọn ngày nhận.')
    setErr(null); setSending(true)
    try {
      const r = await rpc<ReceiveResult>('receive_lot', {
        p_lot_id: l.id, p_ship_fee_vnd: needFee ? feeVal : null, p_received_at: date, p_expected_version: l.version,
      })
      const ids = r.auto_confirmed_order_ids ?? []
      toast(`Đã nhập kho ${r.units?.length ?? qty} chiếc${ids.length ? ` · tự chốt ${ids.length} đơn đặt trước` : ''}`)
      onDone(ids)
    } catch (e) { setErr(errText(e)); setSending(false) }
  }

  return (
    <Sheet title="Nhận hàng vào kho" onClose={onClose}
      footer={<button className="btn btn-primary btn-block" disabled={sending} onClick={submit}>{sending ? <><span className="spin" /> Đang nhận…</> : 'Nhận vào kho'}</button>}>
      {needFee ? (
        <>
          <p className="muted small" style={{ textAlign: 'center', margin: 0 }}>Cần phí ship về VN để tính giá nhập ₫ từng chiếc (BR-02).</p>
          <label className="f">Phí ship về VN cả lô (₫)
            <input className="input money" id="rc-fee" inputMode="numeric" value={fee} placeholder={sug != null ? String(sug) : ''}
              onChange={(e) => setFee(e.target.value)} />
          </label>
          <p className="hint">
            Gợi ý theo lô trước: {sug != null ? <>{vnd(sug)} <button type="button" className="link-btn small" onClick={() => setFee(String(sug))}>Dùng gợi ý</button></> : '—'}
          </p>
        </>
      ) : (
        <p className="muted" style={{ textAlign: 'center', margin: 0 }}>{qty} chiếc vào kho · phí ship {vnd(l.ship_fee_vnd)}.</p>
      )}
      {feeVal != null && !Number.isNaN(feeVal) && <CostPreview units={units} rate={Number(l.exchange_rate)} fee={feeVal} />}
      {held > 0 && <p className="hint">{held} chiếc đang giữ cho đơn Đặt trước — đơn nào đủ mọi chiếc trong kho sẽ tự chuyển Đã chốt (A7).</p>}
      <label className="f">Ngày nhận<input className="input" id="rc-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      {err && <p className="err-text" role="alert">{err}</p>}
    </Sheet>
  )
}

/** Phí ship về VN của lô. Chưa nhận: save_lot (để trống được). Đã nhận: update_lot_ship_fee (A3, A10). */
function ShipFeeSheet({ lotId, onClose }: { lotId: string; onClose: () => void }) {
  const d = useData()
  const { rpc } = useStore()
  const toast = useToast()
  const l = d.lots.find((x) => x.id === lotId)
  const [fee, setFee] = useState(l?.ship_fee_vnd != null ? String(l.ship_fee_vnd) : '')
  const [err, setErr] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  if (!l) return null
  const units = unitsOfLot(d, l.id), qty = units.length
  const received = l.status === 'received'
  const val = readFee(fee)
  const sug = suggestedShip(d, qty)
  const soldAuto = units.filter((u) => u.status === 'sold' && !u.cost_is_overridden).length
  const overridden = units.filter((u) => u.cost_is_overridden).length
  const tooMany = !received && qty > MAX_GROUP_ITEMS

  const submit = async () => {
    if (val != null && Number.isNaN(val)) return setErr('Phí ship phải là số đồng nguyên ≥ 0.')
    if (received && val == null) return setErr('Lô đã nhận phải có phí ship (BR-02).')
    if (tooMany) return setErr(`Lô có ${qty} chiếc — quá ${MAX_GROUP_ITEMS} chiếc nên chưa sửa phí ship trước khi nhận được. Nhập phí ship lúc bấm "Nhận vào kho".`)
    setErr(null); setSending(true)
    try {
      if (received) await rpc('update_lot_ship_fee', { p_lot_id: l.id, p_ship_fee_vnd: val, p_expected_version: l.version })
      else await rpc('save_lot', saveLotArgs(l, units, { ship_fee_vnd: val }))
      toast(received ? 'Đã lưu phí ship · giá nhập ₫ các chiếc đã tính lại' : 'Đã lưu phí ship')
      onClose()
    } catch (e) { setErr(errText(e)); setSending(false) }
  }

  return (
    <Sheet title="Phí ship về VN" onClose={onClose}
      footer={<button className="btn btn-primary btn-block" disabled={sending} onClick={submit}>{sending ? <><span className="spin" /> Đang lưu…</> : 'Lưu'}</button>}>
      <label className="f">Phí ship cả lô (₫)
        <input className="input money" id="sh-fee" inputMode="numeric" value={fee} placeholder={received ? '' : 'để trống'}
          onChange={(e) => setFee(e.target.value)} />
      </label>
      <p className="hint">
        Chia đều {qty} chiếc; công nợ trung gian tự cập nhật.
        {sug != null && <> Lô trước ~{vnd(sug)} cho {qty} chiếc.</>}
      </p>
      {received && (
        <div className="note-box way">
          <span>
            Lô đã nhận: giá nhập ₫ của <b>mọi chiếc không sửa tay</b> được tính lại theo phí ship mới — kể cả chiếc đã bán
            {soldAuto > 0 ? ` (${soldAuto} chiếc — lãi của đơn đã gửi đổi theo)` : ''} (A3).
            {overridden > 0 ? ` ${overridden} chiếc có giá sửa tay giữ nguyên.` : ''}
          </span>
        </div>
      )}
      {val != null && !Number.isNaN(val) && <CostPreview units={units} rate={Number(l.exchange_rate)} fee={val} />}
      {err && <p className="err-text" role="alert">{err}</p>}
    </Sheet>
  )
}

interface ReservedDetail { order_ids?: string[]; unit_codes?: string[] }

function CancelSheet({ lotId, onClose }: { lotId: string; onClose: () => void }) {
  const d = useData()
  const call = useRpcDetail()
  const toast = useToast()
  const l = d.lots.find((x) => x.id === lotId)
  const [err, setErr] = useState<string | null>(null)
  const [blocked, setBlocked] = useState<ReservedDetail | null>(null)
  const [sending, setSending] = useState(false)
  if (!l) return null
  const code = d.lotCode[l.id]
  const submit = async () => {
    setErr(null); setBlocked(null); setSending(true)
    try {
      await call('cancel_lot', { p_lot_id: l.id, p_expected_version: l.version })
      toast('Đã huỷ ' + code)
      onClose()
    } catch (e) {
      if (e instanceof RpcError && e.code === 'LOT_HAS_RESERVED_UNITS') {
        const det = (e.detail && typeof e.detail === 'object' ? e.detail : {}) as ReservedDetail
        // Không có detail ⇒ tự tìm trong v_units
        const units = unitsOfLot(d, l.id).filter((u) => u.holding_order_id)
        setBlocked({
          order_ids: det.order_ids?.length ? det.order_ids : [...new Set(units.map((u) => u.holding_order_id!))],
          unit_codes: det.unit_codes?.length ? det.unit_codes : units.map((u) => u.code),
        })
      } else setErr(errText(e))
      setSending(false)
    }
  }
  const unitsByOrder = (oid: string) => unitsOfLot(d, l.id).filter((u) => u.holding_order_id === oid).map((u) => u.code)
  return (
    <Sheet title="Huỷ lô?" onClose={onClose}
      footer={blocked ? undefined : <button className="btn btn-danger btn-block" disabled={sending} onClick={submit}>{sending ? <><span className="spin" /> Đang huỷ…</> : 'Huỷ lô'}</button>}>
      {!blocked && <p className="muted" style={{ textAlign: 'center', margin: 0 }}>{code} và {unitsOfLot(d, l.id).length} chiếc của lô sẽ chuyển Huỷ — không tính vào hàng đang về và công nợ trung gian. Không hoàn tác được.</p>}
      {blocked && (
        <>
          <div className="warn-box"><Icon name="warn" size={18} /><span>Chưa huỷ được {code}: có chiếc đang được giữ cho đơn{blocked.unit_codes?.length ? ` (${codesText(blocked.unit_codes, 6)})` : ''}. Đổi chiếc trong đơn hoặc huỷ đơn trước, rồi huỷ lô.</span></div>
          <div className="list">
            {(blocked.order_ids ?? []).map((oid) => {
              const o = d.orders.find((x) => x.id === oid)
              const cs = unitsByOrder(oid)
              return (
                <Link key={oid} className="li" to={`/don/${oid}`}>
                  <div className="main">
                    <b>{d.orderCode[oid] ?? 'Đơn'}{o ? ` · ${d.customers.find((c) => c.id === o.customer_id)?.fb_name ?? '?'}` : ''}</b>
                    {cs.length > 0 && <div className="s">Giữ {codesText(cs, 4)}</div>}
                  </div>
                  <Icon name="chev" size={16} />
                </Link>
              )
            })}
          </div>
        </>
      )}
      {err && <p className="err-text" role="alert">{err}</p>}
    </Sheet>
  )
}

/** A7: đơn Đặt trước đã đủ mọi chiếc trong kho ⇒ DB tự chuyển Đã chốt khi nhận lô. */
function AutoConfirmedSheet({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const d = useData()
  return (
    <Sheet title="Đơn đặt trước đã tự chốt" onClose={onClose}>
      <div className="list">
        {ids.map((id) => {
          const o = d.orders.find((x) => x.id === id)
          const os = d.orderSummary.find((x) => x.order_id === id)
          return (
            <Link key={id} className="li" to={`/don/${id}`}>
              <div className="main">
                <b>Đã tự chốt {d.orderCode[id] ?? 'đơn'} vì đủ hàng</b>
                <div className="s">
                  {o ? d.customers.find((c) => c.id === o.customer_id)?.fb_name ?? '?' : ''}
                  {os?.unit_codes?.length ? ` · ${codesText(os.unit_codes, 4)}` : ''}
                  {o ? ` · đặt ${dmy(o.order_date)}` : ''}
                </div>
              </div>
              <Icon name="chev" size={16} />
            </Link>
          )
        })}
      </div>
      <p className="hint" style={{ textAlign: 'center' }}>Mở đơn để gửi hàng cho khách (A7).</p>
    </Sheet>
  )
}
