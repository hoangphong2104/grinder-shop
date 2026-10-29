// Thao tác trên cối dùng chung cho danh sách + chi tiết (v0.2, CR-001): chuyển bước, nhận vào kho (Q-011,
// A7 tự chốt đơn Đặt trước; CR-004 LOT-S1 tình trạng + seri từng chiếc), huỷ (LOT_HAS_RESERVED_UNITS ⇒ liệt kê đơn đang giữ chiếc).
// CR-009: ô phí ship = ship kho VN → Lumi (shop trả ngay: set_lot_local_ship / receive_lot p_local_ship_vnd);
// ship TQ → VN tất toán gộp ở Sổ quỹ (settle_cn_ship), không hỏi lúc nhận.
import { useCallback, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useData, useStore } from '../../data/store.tsx'
import type { LotRow, UnitConditionDb, UnitViewRow } from '../../data/types.ts'
import { Sheet, useToast } from '../../ui/feedback.tsx'
import { Icon } from '../../ui/icons.tsx'
import { CONDITION_LABEL, CONDITION_ORDER, LOT_LABEL } from '../../ui/status.tsx'
import { cny, dmy, parseNum, pct, todayVn, vnd } from '../../ui/format.ts'
import { autoUnitCost } from '../../domain/index.ts'
import { codesText, lotFeePct, nextStatus, unitsOfLot } from './common.tsx'
import { errText, RpcError, useRpcDetail } from './rpc.ts'
import { MoneyInput } from '../../ui/MoneyInput.tsx'
import { lotName } from '../overview/common.tsx'

/** save_lot nhận tối đa 1050 phần tử p_groups (≤ 1000 chiếc giữ lại + nhóm mới; lô tối đa 1000 chiếc). */
export const MAX_GROUP_ITEMS = 1050

/** Đối số save_lot giữ nguyên mọi trường + mọi chiếc của lô chưa nhận, chỉ đổi phần truyền vào.
 *  Không gửi buying_fee_pct ⇒ DB giữ nguyên phí mua hộ của lô (CR-003). */
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

/** Đọc ô phí ship: số đồng nguyên ≥ 0, trống → null, sai → NaN. */
function readFee(v: string): number | null {
  const n = parseNum(v)
  if (n == null) return null
  return Number.isInteger(n) && n >= 0 ? n : NaN
}

/** Xem trước giá nhập ₫ tự tính với ship VN → Lumi mới (D2 + CR-003 phí mua hộ + CR-009), gom theo model + giá ¥. Chiếc sửa tay giữ giá sửa tay. */
function CostPreview({ units, l, local }: { units: UnitViewRow[]; l: LotRow; local: number | null }) {
  const rate = Number(l.exchange_rate), feePct = lotFeePct(l)
  if (!units.length) return null
  const groups = new Map<string, { label: string; codes: string[]; cost: number }>()
  for (const u of units) {
    if (u.cost_is_overridden) continue
    const k = `${u.model_id}|${Number(u.price_cny)}`
    const g = groups.get(k) ?? { label: `${u.model_name} @ ${cny(Number(u.price_cny))}`, codes: [], cost: autoUnitCost({ priceCny: Number(u.price_cny) }, { rate, shipFee: l.ship_fee_vnd, localShip: local, buyingFeePct: feePct }, units.length) }
    g.codes.push(u.code)
    groups.set(k, g)
  }
  const over = units.filter((u) => u.cost_is_overridden)
  return (
    <div className="calc lot-calc">
      {[...groups.values()].map((g) => (
        <div className="ln" key={g.label}><span>{codesText(g.codes, 3)}, {g.label}</span><span>{vnd(g.cost)}</span></div>
      ))}
      {over.length > 0 && <div className="formula">Giữ giá sửa tay: {codesText(over.map((u) => u.code), 3)}</div>}
      <div className="formula">= giá ¥ × tỷ giá × (1 + phí {pct(feePct)}) + ship TQ → VN {l.ship_fee_vnd != null ? vnd(l.ship_fee_vnd) : '(chưa tất toán)'} + ship VN → Lumi{units.length > 1 ? ` ÷ ${units.length} chiếc` : ''}</div>
    </div>
  )
}

type Open =
  | { kind: 'receive' | 'ship' | 'cancel'; lotId: string }
  | { kind: 'confirmed'; ids: string[] }
  | null

interface ReceiveResult { units?: { unit_id: string; code: string; cost_vnd: number; condition?: UnitConditionDb; serial_no?: string | null }[]; auto_confirmed_order_ids?: string[] }

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
      toast('Cối chuyển: ' + LOT_LABEL[n])
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

interface RcUnit { condition: UnitConditionDb; serial: string }

/** Nhận vào kho (từ bất kỳ bước mở nào - Q-011). CR-004 LOT-S1: tình trạng (mặc định Mới) + seri (tuỳ chọn) từng chiếc
 *  → receive_lot p_units. CR-009: ship kho VN → Lumi (tuỳ chọn, shop trả ngay) → p_local_ship_vnd; ship TQ → VN không hỏi.
 *  Xong ⇒ báo đơn Đặt trước tự chốt (A7). */
function ReceiveSheet({ lotId, onClose, onDone }: { lotId: string; onClose: () => void; onDone: (confirmedIds: string[]) => void }) {
  const d = useData()
  const { rpc } = useStore()
  const toast = useToast()
  const l = d.lots.find((x) => x.id === lotId)
  const [fee, setFee] = useState(l?.local_ship_vnd != null ? String(l.local_ship_vnd) : '')
  const [date, setDate] = useState(todayVn())
  const [rc, setRc] = useState<Record<string, RcUnit>>(() =>
    Object.fromEntries(unitsOfLot(d, lotId).map((u) => [u.unit_id, { condition: u.condition ?? 'new', serial: u.serial_no ?? '' }])))
  const [err, setErr] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  if (!l) return null
  const units = unitsOfLot(d, l.id), qty = units.length
  const feeVal = readFee(fee)
  const held = units.filter((u) => u.holding_order_status === 'preorder').length
  const cur = (u: UnitViewRow): RcUnit => rc[u.unit_id] ?? { condition: u.condition ?? 'new', serial: u.serial_no ?? '' }
  const setU = (id: string, patch: Partial<RcUnit>) => setRc((m) => {
    const u = units.find((x) => x.unit_id === id)
    const base = m[id] ?? { condition: u?.condition ?? 'new', serial: u?.serial_no ?? '' }
    return { ...m, [id]: { ...base, ...patch } }
  })
  const setAll = (c: UnitConditionDb) => setRc((m) => Object.fromEntries(units.map((u) => [u.unit_id, { ...(m[u.unit_id] ?? cur(u)), condition: c }])))
  const allSame = units.length > 0 && units.every((u) => cur(u).condition === cur(units[0]).condition) ? cur(units[0]).condition : ''

  const submit = async () => {
    if (feeVal != null && Number.isNaN(feeVal)) return setErr('Phí ship phải là số đồng nguyên ≥ 0.')
    if (!date) return setErr('Chọn ngày nhận.')
    const long = units.find((u) => cur(u).serial.trim().length > 100)
    if (long) return setErr(`Seri của ${long.code} tối đa 100 ký tự.`)
    setErr(null); setSending(true)
    try {
      const r = await rpc<ReceiveResult>('receive_lot', {
        p_lot_id: l.id, p_local_ship_vnd: feeVal ?? 0, p_received_at: date, p_expected_version: l.version,
        p_units: units.map((u) => ({ unit_id: u.unit_id, condition: cur(u).condition, serial_no: cur(u).serial.trim() })),
      })
      const ids = r.auto_confirmed_order_ids ?? []
      toast(`Đã nhận ${r.units?.length === 1 ? r.units[0].code : `${r.units?.length ?? qty} chiếc`} vào Kho Lumi${feeVal ? `, ghi chi ship ${vnd(feeVal)}` : ''}${ids.length ? `, tự chốt ${ids.length} đơn đặt trước` : ''}`)
      onDone(ids)
    } catch (e) { setErr(errText(e)); setSending(false) }
  }

  return (
    <Sheet title={`Nhận ${codesText(units.map((u) => u.code), 2) || 'cối'} vào Kho Lumi`} onClose={onClose}
      footer={<button className="btn btn-primary btn-block" id="rc-submit" disabled={sending} onClick={submit}>{sending ? <><span className="spin" /> Đang nhận…</> : `Nhận vào Kho Lumi (${qty} chiếc)`}</button>}>
      <div className="two">
        <label className="f"><span className="flab">Ship kho VN → Lumi ₫</span>
          <MoneyInput className="input money" id="rc-fee" value={fee} placeholder="0"
            onValue={(v) => setFee(v)} />
        </label>
        <label className="f"><span className="flab">Ngày nhận</span>
          <input className="input" id="rc-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
      </div>
      <p className="hint two-hint">Bạn trả ngay: cộng vào giá nhập và ghi chi ở Sổ quỹ. Ship TQ → VN tất toán gộp sau ở Sổ quỹ.</p>
      {(feeVal == null || !Number.isNaN(feeVal)) && <CostPreview units={units} l={l} local={feeVal} />}

      {qty > 0 && (
        <>
          <div className="rc-all">
            <span>Tình trạng, seri (tuỳ chọn)</span>
            {qty > 1 && (
              <select className="input" id="rc-all" aria-label="Đặt tình trạng cho mọi chiếc" value={allSame}
                onChange={(e) => { if (e.target.value) setAll(e.target.value as UnitConditionDb) }}>
                <option value="">Tất cả là…</option>
                {CONDITION_ORDER.map((c) => <option key={c} value={c}>Tất cả: {CONDITION_LABEL[c]}</option>)}
              </select>
            )}
          </div>
          <div className="rc-units">
            {units.map((u) => {
              const v = cur(u)
              return (
                <div className="rc-unit" key={u.unit_id}>
                  <span className="uh">
                    <b className="num">{u.code}</b><span className="nm">{u.model_name}</span>
                    {u.holding_order_id && <span className="pill hold">Khách đặt {d.orderCode[u.holding_order_id] ?? 'đơn'}</span>}
                  </span>
                  <select className="input" id={`rc-cond-${u.code}`} aria-label={`Tình trạng ${u.code}`} value={v.condition}
                    onChange={(e) => setU(u.unit_id, { condition: e.target.value as UnitConditionDb })}>
                    {CONDITION_ORDER.map((c) => <option key={c} value={c}>{CONDITION_LABEL[c]}</option>)}
                  </select>
                  <input className="input" id={`rc-serial-${u.code}`} aria-label={`Seri ${u.code}`} value={v.serial} maxLength={100}
                    placeholder="Seri (tuỳ chọn)" autoComplete="off" onChange={(e) => setU(u.unit_id, { serial: e.target.value })} />
                </div>
              )
            })}
          </div>
        </>
      )}
      {held > 0 && <p className="hint">{held} chiếc đang giữ cho đơn Đặt trước - đơn nào đủ mọi chiếc trong kho sẽ tự chuyển Đã chốt (A7).</p>}
      {err && <p className="err-text" role="alert">{err}</p>}
    </Sheet>
  )
}

/** CR-009 ship kho VN → Lumi của cối (shop trả ngay): set_lot_local_ship - giá nhập tính lại (A3), bút toán sổ quỹ theo. */
function ShipFeeSheet({ lotId, onClose }: { lotId: string; onClose: () => void }) {
  const d = useData()
  const { rpc } = useStore()
  const toast = useToast()
  const l = d.lots.find((x) => x.id === lotId)
  const [fee, setFee] = useState(l?.local_ship_vnd != null ? String(l.local_ship_vnd) : '')
  const [err, setErr] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  if (!l) return null
  const units = unitsOfLot(d, l.id)
  const val = readFee(fee)
  const soldAuto = units.filter((u) => u.status === 'sold' && !u.cost_is_overridden).length

  const submit = async () => {
    if (val != null && Number.isNaN(val)) return setErr('Phí ship phải là số đồng nguyên ≥ 0.')
    setErr(null); setSending(true)
    try {
      await rpc('set_lot_local_ship', { p_lot_id: l.id, p_local_ship_vnd: val ?? 0, p_expected_version: l.version })
      toast(val ? `Đã lưu ship ${vnd(val)}, giá nhập đã tính lại` : 'Đã bỏ phí ship VN → Lumi')
      onClose()
    } catch (e) { setErr(errText(e)); setSending(false) }
  }

  return (
    <Sheet title="Ship kho VN → Lumi" onClose={onClose}
      footer={<button className="btn btn-primary btn-block" disabled={sending} onClick={submit}>{sending ? <><span className="spin" /> Đang lưu…</> : 'Lưu'}</button>}>
      <label className="f">Phí ship (₫)
        <MoneyInput className="input money" id="sh-fee" value={fee} placeholder="0" onValue={(v) => setFee(v)} />
      </label>
      <p className="hint">Bạn trả ngay: cộng vào giá nhập và ghi chi ở Sổ quỹ (sửa / xoá theo). Không tính vào nợ trung gian.</p>
      {soldAuto > 0 && <div className="note-box way"><span>Cối đã bán: lãi của đơn đổi theo giá nhập mới (A3).</span></div>}
      {(val == null || !Number.isNaN(val)) && <CostPreview units={units} l={l} local={val} />}
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
  const code = lotName(d, l.id)
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
      footer={blocked ? undefined : <button className="btn btn-danger btn-block" disabled={sending} onClick={submit}>{sending ? <><span className="spin" /> Đang huỷ…</> : 'Huỷ cối'}</button>}>
      {!blocked && <p className="muted" style={{ textAlign: 'center', margin: 0 }}>{code} sẽ chuyển Huỷ - không tính vào hàng đang về và công nợ trung gian. Không hoàn tác được.</p>}
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
                    <b>{d.orderCode[oid] ?? 'Đơn'}{o ? `, ${d.customers.find((c) => c.id === o.customer_id)?.fb_name ?? '?'}` : ''}</b>
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
                  {os?.unit_codes?.length ? `, ${codesText(os.unit_codes, 4)}` : ''}
                  {o ? `, đặt ${dmy(o.order_date)}` : ''}
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
