import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useData, useStore } from '../data/store.tsx'
import type { UnitConditionDb, UnitViewRow } from '../data/types.ts'
import { Shell } from '../ui/Shell.tsx'
import { Sheet, useToast } from '../ui/feedback.tsx'
import { Gpic, Icon } from '../ui/icons.tsx'
import { CONDITION_LABEL, CONDITION_ORDER, ConditionChip, ORDER_LABEL, UnitChip } from '../ui/status.tsx'
import { cny, dmy, parseNum, pct, vnd } from '../ui/format.ts'
import { CostCell, Profit, OrderRow, agingCls, daysSince, holderCode, thresholds, unitProfit } from './overview/common.tsx'
import { roundVnd } from '../domain/index.ts'
import { isOpen, LOT_SHORT, nextStatus } from './lots/common.tsx'
import { useLotFlow } from './lots/LotFlow.tsx'
import { PayLotButton } from './lots/PayLot.tsx'
import { goofishHref, Screenshot } from './LotDetail.tsx'
import '../styles/lots.css'
import { MoneyInput } from '../ui/MoneyInput.tsx'

const fullDate = (iso: string | null | undefined) => (iso ? `${dmy(iso)}/${iso.slice(0, 4)}` : '-')
const numStr = (n: number | null | undefined) => (n == null ? '' : String(n))

// SC_03 Chi tiết 1 chiếc cối (CR-001). CR-006: 1 lô = 1 cối ⇒ trang này gộp cả thông tin lô: 5 bước Kho TQ → Kho VN →
// Kho Lumi → Đang giao khách → Đã bán, nút bước kế ở thanh đáy, tiền mua + trả trung gian, tin Goofish / người bán.
// Trước đây: SC_03 Chi tiết 1 chiếc cối (CR-001): mã, model, seri, lô, người bán, trạng thái + đơn giữ / bán;
// giá ¥, tỷ giá, ship/chiếc, giá nhập tự tính / sửa tay, giá bán dự kiến, lãi. Sửa qua RPC update_unit.
// CR-004: tình trạng (KHO-S3, patch `condition`), tuổi tồn có màu (KHO-S1), thanh dính đáy "Bán chiếc này" (UI-S1).
export default function UnitDetail() {
  const { id = '' } = useParams()
  const d = useData()
  const u = d.unitView.find((x) => x.unit_id === id)
  if (!u) {
    return <Shell section="kho" title="Không tìm thấy" back="/kho"><div className="empty"><b>Không tìm thấy chiếc cối này</b><br />Có thể cối đã bị xoá - quay lại Kho.</div></Shell>
  }
  return <UnitView u={u} />
}

/** CR-006: 5 bước của 1 cối - 2 bước đầu là bước của lô (1 lô = 1 cối), 3 bước sau theo đơn bán. */
const STEPS = ['Kho TQ', 'Kho VN', 'Kho Lumi', 'Đang giao khách', 'Đã bán']
function stepOf(u: UnitViewRow): number {
  if (u.status === 'cancelled') return -1
  if (!u.is_received) return u.lot_status === 'vn_warehouse' ? 1 : 0
  if (u.status === 'sold') return u.holding_order_status === 'shipped' ? 3 : 4
  return 2
}

function UnitView({ u }: { u: UnitViewRow }) {
  const d = useData()
  const nav = useNavigate()
  const flow = useLotFlow()
  const [menu, setMenu] = useState(false)
  const lot = d.lots.find((l) => l.id === u.lot_id)
  const ls = d.lotSummary.find((x) => x.lot_id === u.lot_id)
  const seller = d.sellers.find((s) => s.id === u.seller_id)
  const order = u.holding_order_id ? d.orders.find((o) => o.id === u.holding_order_id) : undefined
  const os = order ? d.orderSummary.find((x) => x.order_id === order.id) : undefined
  const holder = holderCode(d, u)
  const p = unitProfit(u)
  const qty = ls?.total_qty ?? 1
  const single = qty === 1
  const step = stepOf(u)
  const next = lot && isOpen(lot.status) ? nextStatus(lot.status) : null
  const feePct = Number(lot?.buying_fee_pct ?? 0)
  const href = lot ? goofishHref(lot.goofish_url, lot.goofish_item_id) : null
  const act = (fn: () => void) => () => { setMenu(false); fn() }

  // Thanh dính đáy: bước kế của cối
  let savebar
  if (lot && next) {
    savebar = (
      <button className="btn btn-primary btn-block" id="u-next" disabled={flow.busy === lot.id} onClick={() => flow.next(lot)}>
        {flow.busy === lot.id ? <><span className="spin" /> Đang chuyển…</> : next === 'received' ? 'Nhận vào Kho Lumi' : `Chuyển sang ${LOT_SHORT[next]}`}
      </button>
    )
  } else if (u.status === 'in_stock') savebar = <Link className="btn btn-primary btn-block" id="u-sell" to={`/don/new?chiec=${u.unit_id}`}>Bán chiếc này</Link>
  else if (order && (u.status === 'reserved' || step === 3)) savebar = <Link className="btn btn-primary btn-block" id="u-order" to={`/don/${order.id}`}>Mở đơn {holder}</Link>

  return (
    <Shell section="kho" title={u.code} back="/kho" savebar={savebar}
      actions={<button className="icon-btn more-btn" id="u-more" aria-label="Thao tác khác" aria-haspopup="dialog" onClick={() => setMenu(true)}>⋯</button>}>
      <div className="cols">
        <div>
          <div className="hero-g"><Gpic modelName={u.model_name} /></div>
          <div style={{ textAlign: 'center' }}>
            <div className="num" style={{ fontSize: 22, fontWeight: 600 }}>{u.code}</div>
            <div className="muted small">{u.model_name}{u.serial_no ? `, seri ${u.serial_no}` : ''}</div>
            <div className="row" style={{ marginTop: 6, justifyContent: 'center' }}>
              <UnitChip s={u.status} holder={holder} lot={u.lot_status} order={u.holding_order_status} /><ConditionChip c={u.condition ?? 'new'} />
              {ls?.is_lot_late && <span className="pill bad">Về trễ</span>}
            </div>
            {order && (
              <div className="small" style={{ marginTop: 4 }}>
                <Link className="link-btn small" to={`/don/${order.id}`}>{holder}, {u.holding_customer_name ?? ''}, {ORDER_LABEL[order.status]}</Link>
              </div>
            )}
          </div>

          {step >= 0
            ? (
              <div className="stepper">
                {STEPS.map((t, i) => (
                  <div key={t} className={`st ${i < step ? 'done' : i === step ? 'cur' : ''}`}><span className="dot" /><span className="lb">{t}</span></div>
                ))}
              </div>
            )
            : <div className="warn-box">Cối đã huỷ{lot?.cancelled_at ? ` ngày ${dmy(lot.cancelled_at.slice(0, 10))}` : ''} - không tính vào tồn và công nợ.</div>}

          <p className="section-title">Tiền</p>
          <div className="calc">
            <div className="ln"><span>Giá web, {cny(Number(u.price_cny))} × {Number(u.exchange_rate).toLocaleString('vi-VN')}</span><span>{vnd(roundVnd(Number(u.price_cny) * Number(u.exchange_rate)))}</span></div>
            <div className="ln"><span>Phí mua hộ {pct(feePct)}</span><span>{vnd(roundVnd(Number(u.price_cny) * Number(u.exchange_rate) * feePct / 100))}</span></div>
            <div className="ln"><span>Ship TQ → VN{single ? '' : ` (${qty} chiếc, chia đều)`}</span><span>{ls?.ship_per_unit_vnd != null ? vnd(ls.ship_per_unit_vnd) : <span className="muted">chưa tất toán</span>}</span></div>
            <div className="ln"><span>Ship kho VN → Lumi{single ? '' : ` (${qty} chiếc, chia đều)`}</span><span>{lot?.local_ship_vnd ? vnd(roundVnd(lot.local_ship_vnd / qty)) : <span className="muted">chưa có</span>}</span></div>
            <div className="ln total"><span>Giá nhập</span><span><CostCell u={u} /></span></div>
            <div className="ln"><span>Giá bán dự kiến</span><span>{vnd(u.list_price_vnd)}</span></div>
            {u.order_unit_price_vnd != null && <div className="ln"><span>{u.status === 'sold' ? 'Giá chốt' : 'Giá chốt trên đơn'}</span><span>{vnd(u.order_unit_price_vnd)}</span></div>}
            <div className="ln total"><span>{p.actual ? 'Lãi' : 'Lãi dự kiến'}</span><span><Profit n={p.value} full /></span></div>
            {u.cost_is_overridden && <div className="formula">Giá nhập đã sửa tay (tự tính {vnd(u.cost_vnd_auto)}).</div>}
          </div>
          {ls && ls.status !== 'cancelled' && (
            <>
              <p className="section-title">Trả trung gian</p>
              <div className="calc">
                <div className="ln"><span>Phải trả{single ? '' : ` (cả ${qty} chiếc mua cùng)`}</span><span>{vnd(ls.payable_vnd)}</span></div>
                <div className="ln"><span>Đã trả</span><span>{vnd(ls.paid_vnd)}</span></div>
                <div className="ln total"><span>{ls.outstanding_vnd < 0 ? 'Trả dư' : 'Còn nợ'}</span><span className={ls.outstanding_vnd > 0 ? 'req' : 'ok-t'}>{ls.outstanding_vnd === 0 ? 'đã trả đủ' : vnd(Math.abs(ls.outstanding_vnd))}</span></div>
              </div>
              <PayLotButton lotId={u.lot_id} id="u-pay" className="btn btn-ghost btn-block" />
            </>
          )}
        </div>
        <div>
          <p className="section-title">Thông tin mua</p>
          <dl className="kv">
            {href && <><dt>Tin Goofish</dt><dd><a className="link-btn small lot-ext" href={href} target="_blank" rel="noopener noreferrer">Mở tin <Icon name="ext" /></a></dd></>}
            {lot?.listing_title && <><dt>Tiêu đề</dt><dd className="small">{lot.listing_title}</dd></>}
            {seller && <><dt>Người bán</dt><dd><>{seller.profile_url && /^https?:\/\//i.test(seller.profile_url) ? <a className="link-btn small lot-ext" href={seller.profile_url} target="_blank" rel="noopener noreferrer">{seller.nickname} <Icon name="ext" /></a> : seller.nickname}{seller.region ? `, ${seller.region}` : ''}{seller.is_avoided && <> <span className="pill bad">tránh</span></>}</></dd></>}
            <dt>Ngày đặt</dt><dd>{fullDate(u.ordered_at)}{!u.is_received && u.status !== 'cancelled' ? `, ${daysSince(u.ordered_at) ?? 0} ngày` : ''}</dd>
            {u.received_at ? <><dt>Ngày nhận</dt><dd>{fullDate(u.received_at)}</dd></> : u.status !== 'cancelled' && <><dt>Ngày nhận</dt><dd>Đang về</dd></>}
            {u.days_in_stock != null && <><dt>{u.status === 'sold' ? 'Số ngày tồn (tới lúc gửi)' : 'Số ngày tồn'}</dt><dd className="num"><Aging u={u} /></dd></>}
            {u.status === 'sold' && <><dt>Ngày gửi khách</dt><dd>{fullDate(u.sold_at)}</dd></>}
            {!single && <><dt>Mua cùng</dt><dd><Link className="link-btn" style={{ padding: 0 }} to={`/lo/${u.lot_id}`}>{qty} chiếc</Link></dd></>}
            {lot?.note && <><dt>Ghi chú mua</dt><dd className="small">{lot.note}</dd></>}
          </dl>
          {lot?.screenshot_path && <Screenshot path={lot.screenshot_path} />}
          {order && os && (
            <>
              <p className="section-title">{u.status === 'sold' ? 'Đơn đã bán' : 'Đơn khách đặt'}</p>
              <div className="ov-list"><OrderRow d={d} o={os} /></div>
            </>
          )}
          <UnitEditor u={u} />
        </div>
      </div>

      {flow.sheets}
      {menu && lot && (
        <Sheet title={`Thao tác ${u.code}`} onClose={() => setMenu(false)}>
          <div className="list">
            {isOpen(lot.status) && <button className="li" id="m-edit" onClick={act(() => nav(`/lo/${lot.id}/sua`))}><div className="main"><b>Sửa thông tin mua</b><div className="s">Link, người bán, giá ¥, tỷ giá, phí mua hộ</div></div><Icon name="chev" size={16} /></button>}
            {next && next !== 'received' && <button className="li" id="m-receive" onClick={act(() => flow.receive(lot))}><div className="main"><b>Nhận vào Kho Lumi ngay</b><div className="s">Bỏ qua Kho VN</div></div><Icon name="chev" size={16} /></button>}
            {u.status === 'incoming' && <Link className="li" id="m-preorder" to={`/don/new?chiec=${u.unit_id}`}><div className="main"><b>Bán trước (khách đặt)</b><div className="s">Tạo đơn đặt trước, giữ cối này</div></div><Icon name="chev" size={16} /></Link>}
            {lot.status !== 'cancelled' && <button className="li" id="m-ship" onClick={act(() => flow.shipFee(lot))}><div className="main"><b>Sửa ship kho VN → Lumi</b><div className="s">{lot.local_ship_vnd ? vnd(lot.local_ship_vnd) : 'chưa có'}</div></div><Icon name="chev" size={16} /></button>}
            {isOpen(lot.status) && single && <button className="li menu-danger" id="m-cancel" onClick={act(() => flow.cancel(lot))}><div className="main"><b>Huỷ cối này</b><div className="s">Không mua nữa - không hoàn tác được</div></div></button>}
          </div>
        </Sheet>
      )}
    </Shell>
  )
}

/** Tuổi tồn có màu (KHO-S1) + giải thích ngưỡng; chiếc đang về: số ngày từ lúc đặt. */
function Aging({ u }: { u: UnitViewRow }) {
  const d = useData()
  const th = thresholds(d)
  if (u.days_in_stock == null) {
    const n = u.status === 'incoming' ? daysSince(u.ordered_at) : null
    return <>{n != null ? <span className="muted">Đã đặt {n} ngày</span> : 'Chưa có'}</>
  }
  const note = u.aging_level === 'alert' ? `, tồn lâu, quá ${th.alert} ngày` : u.aging_level === 'warn' ? `, quá ${th.warn} ngày` : ''
  return <span className={agingCls(u.aging_level)}>{u.days_in_stock} ngày{note}</span>
}

/** Sửa giá nhập sửa tay / giá bán dự kiến / seri / ghi chú (A10: sửa được mọi lúc). */
function UnitEditor({ u }: { u: UnitViewRow }) {
  const d = useData()
  const { rpc } = useStore()
  const toast = useToast()
  const [cost, setCost] = useState(numStr(u.cost_vnd_override))
  const [price, setPrice] = useState(numStr(u.list_price_vnd))
  const [serial, setSerial] = useState(u.serial_no ?? '')
  const [note, setNote] = useState(u.note ?? '')
  const [cond, setCond] = useState<UnitConditionDb>(u.condition ?? 'new')
  const [errs, setErrs] = useState<{ cost?: string; price?: string; form?: string }>({})
  const [busy, setBusy] = useState(false)

  // Dữ liệu đổi (vừa lưu / máy khác sửa) → nạp lại ô
  useEffect(() => {
    setCost(numStr(u.cost_vnd_override)); setPrice(numStr(u.list_price_vnd)); setSerial(u.serial_no ?? ''); setNote(u.note ?? ''); setCond(u.condition ?? 'new')
  }, [u.version, u.cost_vnd_override, u.list_price_vnd, u.serial_no, u.note, u.condition])

  async function send(patch: Record<string, unknown>, okMsg: string) {
    setBusy(true); setErrs({})
    try {
      await rpc('update_unit', { p_unit_id: u.unit_id, p_patch: patch, p_expected_version: u.version })
      toast(okMsg)
    } catch (e) {
      setErrs({ form: (e as Error).message })
    } finally { setBusy(false) }
  }

  function save() {
    const e: typeof errs = {}
    const c = cost.trim() ? parseNum(cost) : null
    const pr = price.trim() ? parseNum(price) : null
    if (cost.trim() && (c == null || c < 0 || !Number.isInteger(c))) e.cost = 'Nhập giá nhập bằng đồng (VD: 3.650.000) hoặc để trống để dùng giá tự tính.'
    if (price.trim() && (pr == null || pr < 0 || !Number.isInteger(pr))) e.price = 'Nhập giá bán bằng đồng (VD: 5.400.000) hoặc để trống.'
    if (serial.trim().length > 100) e.form = 'Số seri tối đa 100 ký tự.'
    setErrs(e)
    if (e.cost || e.price || e.form) return
    // Chỉ gửi khoá thay đổi
    const patch: Record<string, unknown> = {}
    if (c !== u.cost_vnd_override) patch.cost_vnd_override = c
    if (pr !== u.list_price_vnd) patch.list_price_vnd = pr
    if ((serial.trim() || null) !== (u.serial_no ?? null)) patch.serial_no = serial.trim() || null
    if ((note.trim() || null) !== (u.note ?? null)) patch.note = note.trim() || null
    if (cond !== (u.condition ?? 'new')) patch.condition = cond
    if (Object.keys(patch).length === 0) return
    void send(patch, `Đã lưu ${u.code}`)
  }

  const dirty = cost !== numStr(u.cost_vnd_override) || price !== numStr(u.list_price_vnd) || serial !== (u.serial_no ?? '') || note !== (u.note ?? '')
    || cond !== (u.condition ?? 'new')

  return (
    <div className="stack">
      <p className="section-title">Sửa cối này</p>
      <div className="f" role="group" aria-labelledby="u-cond-l">
        <span id="u-cond-l" className="muted small" style={{ fontWeight: 500 }}>Tình trạng</span>
        <div className="ov-seg4" style={{ marginTop: 5 }}>
          {CONDITION_ORDER.map((c) => (
            <button key={c} type="button" className="chip" id={`u-cond-${c}`} aria-pressed={cond === c} disabled={busy} onClick={() => setCond(c)}>{CONDITION_LABEL[c]}</button>
          ))}
        </div>
      </div>
      <div className="two ov-two">
        <label className="f">Giá nhập (sửa tay, ₫)
          <MoneyInput className={`input money ${errs.cost ? 'invalid' : ''}`} id="u-cost" placeholder={`tự tính ${vnd(u.cost_vnd_auto)}`}
            value={cost} onValue={(v) => setCost(v)} />
          {errs.cost && <span className="field-err">{errs.cost}</span>}
        </label>
        <label className="f">Giá bán dự kiến (₫)
          <MoneyInput className={`input money ${errs.price ? 'invalid' : ''}`} id="u-price" value={price} onValue={(v) => setPrice(v)} />
          {errs.price && <span className="field-err">{errs.price}</span>}
        </label>
      </div>
      {u.cost_vnd_override != null && (
        <button className="link-btn small" id="u-cost-auto" style={{ alignSelf: 'flex-start' }} disabled={busy}
          onClick={() => send({ cost_vnd_override: null }, `${u.code}: về giá tự tính ${vnd(u.cost_vnd_auto)}`)}>
          Về giá tự tính ({vnd(u.cost_vnd_auto)})
        </button>
      )}
      {u.status === 'sold' && <p className="hint">Chiếc đã bán: đổi giá nhập sẽ đổi lãi của đơn {holderCode(d, u) ?? ''} (A3). Giá bán dự kiến không đổi giá chốt trên đơn.</p>}
      <label className="f">Số seri
        <input className="input" id="u-serial" maxLength={100} placeholder="VD: số in dưới đáy cối" value={serial} onChange={(e) => setSerial(e.target.value)} />
      </label>
      <label className="f">Ghi chú
        <textarea className="input" id="u-note" maxLength={2000} placeholder="VD: trầy nhẹ nắp, đủ hộp" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      {errs.form && <p className="err-text">{errs.form}</p>}
      <button className="btn btn-primary" id="u-save" disabled={busy || !dirty} onClick={save}>{busy ? 'Đang lưu…' : 'Lưu thay đổi'}</button>
    </div>
  )
}
