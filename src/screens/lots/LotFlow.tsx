// Thao tác trên lô dùng chung cho danh sách + chi tiết: chuyển bước, nhận vào kho (BR-02, BR-08, Q-011),
// phí ship (trước nhận: save_lot; sau nhận: update_lot_ship_fee — Q-008/Q-014), huỷ lô (cảnh báo bán quá).
import { useCallback, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useData, useStore } from '../../data/store.tsx'
import type { DbData, LotLineRow, LotRow } from '../../data/types.ts'
import { Sheet, useToast } from '../../ui/feedback.tsx'
import { Icon } from '../../ui/icons.tsx'
import { LOT_LABEL } from '../../ui/status.tsx'
import { dmy, parseNum, todayVn, tr, vnd } from '../../ui/format.ts'
import { roundVnd, unitCost, type Lot } from '../../domain/index.ts'
import { linesOf, nextStatus, variantName } from './common.tsx'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Lô DB → Lot của domain (để xem trước giá vốn với phí ship mới). */
export function toDomainLot(l: LotRow, lines: LotLineRow[], shipFee: number | null): Lot {
  return {
    id: l.id, orderedAt: l.ordered_at, rate: Number(l.exchange_rate), shipFee, status: 'dat', receivedAt: null,
    lines: lines.map((x) => ({ variantId: x.variant_id, qty: x.qty, cny: Number(x.price_cny) })),
  }
}

/** Đối số save_lot giữ nguyên mọi trường của lô chưa nhận, chỉ đổi phần truyền vào. */
export function saveLotArgs(l: LotRow, lines: LotLineRow[], patch: { ship_fee_vnd?: number | null }) {
  return {
    p_lot_id: l.id,
    p_lot: {
      goofish_url: l.goofish_url, goofish_item_id: l.goofish_item_id, seller_id: l.seller_id, screenshot_path: l.screenshot_path,
      listing_title: l.listing_title, ordered_at: l.ordered_at, exchange_rate: Number(l.exchange_rate),
      ship_fee_vnd: 'ship_fee_vnd' in patch ? patch.ship_fee_vnd : l.ship_fee_vnd, status: l.status, note: l.note,
    },
    p_lines: lines.map((x) => ({ variant_id: x.variant_id, qty: x.qty, price_cny: Number(x.price_cny) })),
    p_expected_version: l.version,
  }
}

/** Phí ship gợi ý = phí/chiếc lô gần nhất × SL lô (BR-02). */
export function suggestedShip(d: DbData, lotId: string): number | null {
  const per = d.suggestions.last_ship_fee_per_unit_vnd
  const qty = linesOf(d, lotId).reduce((a, x) => a + x.qty, 0)
  return per != null && qty > 0 ? roundVnd(per * qty) : null
}

/** Đọc ô phí ship: số đồng nguyên ≥ 0, trống → null, sai → NaN. */
function readFee(v: string): number | null {
  const n = parseNum(v)
  if (n == null) return null
  return Number.isInteger(n) && n >= 0 ? n : NaN
}

type Open =
  | { kind: 'receive' | 'ship' | 'cancel'; lotId: string }
  | { kind: 'preorders'; ids: string[] }
  | { kind: 'oversold'; code: string; items: { variant_id: string; sellable: number }[] }
  | null

interface ReceiveResult { lines: { variant_id: string; qty: number; avg_cost_after_vnd: number }[]; fillable_preorder_ids: string[] }
interface CancelResult { oversold_variants: { variant_id: string; sellable: number }[] }

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
    } catch (e) { toast(msg(e)) } finally { setBusy(null) }
  }, [rpc, toast])

  let sheets: ReactNode = null
  if (open?.kind === 'receive') sheets = <ReceiveSheet lotId={open.lotId} onClose={close} onDone={(ids) => setOpen(ids.length ? { kind: 'preorders', ids } : null)} />
  else if (open?.kind === 'ship') sheets = <ShipFeeSheet lotId={open.lotId} onClose={close} />
  else if (open?.kind === 'cancel') sheets = <CancelSheet lotId={open.lotId} onClose={close} onOversold={(code, items) => setOpen(items.length ? { kind: 'oversold', code, items } : null)} />
  else if (open?.kind === 'preorders') sheets = <PreorderSheet ids={open.ids} onClose={close} />
  else if (open?.kind === 'oversold') sheets = <OversoldSheet code={open.code} items={open.items} onClose={close} />

  return {
    next: (l) => { void next(l) },
    receive: (l) => setOpen({ kind: 'receive', lotId: l.id }),
    shipFee: (l) => setOpen({ kind: 'ship', lotId: l.id }),
    cancel: (l) => setOpen({ kind: 'cancel', lotId: l.id }),
    busy, sheets,
  }
}

/** Nhận vào kho (từ bất kỳ bước mở nào — Q-011). Thiếu phí ship ⇒ hỏi phí (BR-02). */
function ReceiveSheet({ lotId, onClose, onDone }: { lotId: string; onClose: () => void; onDone: (preorderIds: string[]) => void }) {
  const d = useData()
  const { rpc } = useStore()
  const toast = useToast()
  const l = d.lots.find((x) => x.id === lotId)
  const [fee, setFee] = useState('')
  const [date, setDate] = useState(todayVn())
  const [err, setErr] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  if (!l) return null
  const lines = linesOf(d, l.id), qty = lines.reduce((a, x) => a + x.qty, 0)
  const needFee = l.ship_fee_vnd == null
  const sug = suggestedShip(d, l.id)
  const feeVal = needFee ? readFee(fee) : l.ship_fee_vnd
  const preview = feeVal != null && !Number.isNaN(feeVal) ? toDomainLot(l, lines, feeVal) : null

  const submit = async () => {
    if (needFee && feeVal == null) return setErr('Nhập phí ship về VN của cả lô (BR-02) — có thể dùng gợi ý.')
    if (feeVal != null && Number.isNaN(feeVal)) return setErr('Phí ship phải là số đồng nguyên ≥ 0.')
    if (!date) return setErr('Chọn ngày nhận.')
    setErr(null); setSending(true)
    try {
      const r = await rpc<ReceiveResult>('receive_lot', {
        p_lot_id: l.id, p_ship_fee_vnd: needFee ? feeVal : null, p_received_at: date, p_expected_version: l.version,
      })
      const first = r.lines?.[0]
      toast(`Đã nhập kho ${qty} chiếc${first ? ` · BQ ${variantName(d, first.variant_id)} ${tr(first.avg_cost_after_vnd)}` : ''}`)
      onDone(r.fillable_preorder_ids ?? [])
    } catch (e) { setErr(msg(e)); setSending(false) }
  }

  return (
    <Sheet title="Nhận hàng vào kho" onClose={onClose}
      footer={<button className="btn btn-primary btn-block" disabled={sending} onClick={submit}>{sending ? <><span className="spin" /> Đang nhận…</> : 'Nhận vào kho'}</button>}>
      {needFee ? (
        <>
          <p className="muted small" style={{ textAlign: 'center', margin: 0 }}>Cần phí ship về VN để tính giá vốn (BR-02).</p>
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
      {preview && (
        <div className="calc">
          {preview.lines.map((x, i) => (
            <div className="ln" key={i}><span>Giá vốn / chiếc · {variantName(d, x.variantId)}</span><span>{vnd(unitCost(preview, x))}</span></div>
          ))}
        </div>
      )}
      <label className="f">Ngày nhận<input className="input" id="rc-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
      {err && <p className="err-text" role="alert">{err}</p>}
    </Sheet>
  )
}

/** Phí ship về VN của lô. Chưa nhận: save_lot (để trống được). Đã nhận: update_lot_ship_fee (Q-008). */
function ShipFeeSheet({ lotId, onClose }: { lotId: string; onClose: () => void }) {
  const d = useData()
  const { rpc } = useStore()
  const toast = useToast()
  const l = d.lots.find((x) => x.id === lotId)
  const [fee, setFee] = useState(l?.ship_fee_vnd != null ? String(l.ship_fee_vnd) : '')
  const [err, setErr] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  if (!l) return null
  const lines = linesOf(d, l.id), qty = lines.reduce((a, x) => a + x.qty, 0)
  const received = l.status === 'received'
  const val = readFee(fee)
  const sug = suggestedShip(d, l.id)
  const preview = val != null && !Number.isNaN(val) ? toDomainLot(l, lines, val) : null

  const submit = async () => {
    if (val != null && Number.isNaN(val)) return setErr('Phí ship phải là số đồng nguyên ≥ 0.')
    if (received && val == null) return setErr('Lô đã nhận phải có phí ship (BR-02).')
    setErr(null); setSending(true)
    try {
      if (received) await rpc('update_lot_ship_fee', { p_lot_id: l.id, p_ship_fee_vnd: val, p_expected_version: l.version })
      else await rpc('save_lot', saveLotArgs(l, lines, { ship_fee_vnd: val }))
      toast('Đã lưu phí ship')
      onClose()
    } catch (e) { setErr(msg(e)); setSending(false) }
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
        <div className="note-box way"><span>Lô đã nhận: giá vốn dòng lô và giá BQ của hàng còn trong kho được tính lại. Đơn đã gửi giữ nguyên giá vốn đã chốt lúc gửi (Q-008).</span></div>
      )}
      {preview && (
        <div className="calc">
          {preview.lines.map((x, i) => (
            <div className="ln" key={i}><span>Giá vốn / chiếc · {variantName(d, x.variantId)}</span><span>{vnd(unitCost(preview, x))}</span></div>
          ))}
        </div>
      )}
      {err && <p className="err-text" role="alert">{err}</p>}
    </Sheet>
  )
}

function CancelSheet({ lotId, onClose, onOversold }: { lotId: string; onClose: () => void; onOversold: (code: string, items: CancelResult['oversold_variants']) => void }) {
  const d = useData()
  const { rpc } = useStore()
  const toast = useToast()
  const l = d.lots.find((x) => x.id === lotId)
  const [err, setErr] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  if (!l) return null
  const code = d.lotCode[l.id]
  const submit = async () => {
    setErr(null); setSending(true)
    try {
      const r = await rpc<CancelResult>('cancel_lot', { p_lot_id: l.id, p_expected_version: l.version })
      toast('Đã huỷ ' + code)
      onOversold(code, r.oversold_variants ?? [])
    } catch (e) { setErr(msg(e)); setSending(false) }
  }
  return (
    <Sheet title="Huỷ lô?" onClose={onClose}
      footer={<button className="btn btn-danger btn-block" disabled={sending} onClick={submit}>{sending ? <><span className="spin" /> Đang huỷ…</> : 'Huỷ lô'}</button>}>
      <p className="muted" style={{ textAlign: 'center', margin: 0 }}>{code} sẽ không tính vào hàng đang về và công nợ trung gian. Không hoàn tác được.</p>
      {err && <p className="err-text" role="alert">{err}</p>}
    </Sheet>
  )
}

/** BR-08: đơn Đặt trước giờ đủ hàng — người dùng tự mở đơn để chốt (Q-013). */
function PreorderSheet({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const d = useData()
  const orders = ids.map((id) => d.orders.find((o) => o.id === id)).filter((o) => o != null)
  return (
    <Sheet title="Hàng đặt trước đã về" onClose={onClose}>
      <p className="muted" style={{ textAlign: 'center', margin: 0 }}>{orders.length} đơn đặt trước có thể chốt (BR-08):</p>
      <div className="list">
        {orders.map((o) => (
          <Link key={o.id} className="li" to={`/don/${o.id}`}>
            <div className="main">
              <b>{d.orderCode[o.id]} · {d.customers.find((c) => c.id === o.customer_id)?.fb_name ?? '?'}</b>
              <div className="s">{d.orderLines.filter((x) => x.order_id === o.id).map((x) => `${x.qty} × ${variantName(d, x.variant_id)}`).join(', ')} · đặt {dmy(o.order_date)}</div>
            </div>
            <Icon name="chev" size={16} />
          </Link>
        ))}
      </div>
    </Sheet>
  )
}

function OversoldSheet({ code, items, onClose }: { code: string; items: CancelResult['oversold_variants']; onClose: () => void }) {
  const d = useData()
  return (
    <Sheet title="Cảnh báo bán quá" onClose={onClose}>
      <div className="warn-box"><Icon name="warn" size={18} /><span>Đã huỷ {code}. Các model · màu dưới đây giờ có số Có thể bán âm — kiểm tra lại đơn Đặt trước / Đã chốt.</span></div>
      <div className="list">
        {items.map((x) => (
          <Link key={x.variant_id} className="li" to={`/kho/${x.variant_id}`}>
            <div className="main"><b>{variantName(d, x.variant_id)}</b></div>
            <span className="v">Có thể bán {x.sellable}</span>
            <Icon name="chev" size={16} />
          </Link>
        ))}
      </div>
    </Sheet>
  )
}
