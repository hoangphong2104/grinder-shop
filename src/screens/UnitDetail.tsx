import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useData, useStore } from '../data/store.tsx'
import type { UnitConditionDb, UnitViewRow } from '../data/types.ts'
import { Shell } from '../ui/Shell.tsx'
import { useToast } from '../ui/feedback.tsx'
import { Gpic } from '../ui/icons.tsx'
import { CONDITION_LABEL, CONDITION_ORDER, ConditionChip, LotChip, ORDER_LABEL, UnitChip } from '../ui/status.tsx'
import { cny, dmy, parseNum, pct, vnd } from '../ui/format.ts'
import { CostCell, HowTo, Profit, LotRow, OrderRow, agingCls, daysSince, holderCode, thresholds, unitProfit } from './overview/common.tsx'

const fullDate = (iso: string | null | undefined) => (iso ? `${dmy(iso)}/${iso.slice(0, 4)}` : '-')
const numStr = (n: number | null | undefined) => (n == null ? '' : String(n))

// SC_03 Chi tiết 1 chiếc cối (CR-001): mã, model, seri, lô, người bán, trạng thái + đơn giữ / bán;
// giá ¥, tỷ giá, ship/chiếc, giá nhập tự tính / sửa tay, giá bán dự kiến, lãi. Sửa qua RPC update_unit.
// CR-004: tình trạng (KHO-S3, patch `condition`), tuổi tồn có màu (KHO-S1), thanh dính đáy "Bán chiếc này" (UI-S1).
export default function UnitDetail() {
  const { id = '' } = useParams()
  const d = useData()
  const u = d.unitView.find((x) => x.unit_id === id)
  if (!u) {
    return <Shell section="kho" title="Không tìm thấy" back="/kho"><div className="empty"><b>Không tìm thấy chiếc cối này</b><br />Có thể chiếc đã bị bỏ khỏi lô - quay lại Kho.</div></Shell>
  }
  return <UnitView u={u} />
}

function UnitView({ u }: { u: UnitViewRow }) {
  const d = useData()
  const lot = d.lots.find((l) => l.id === u.lot_id)
  const ls = d.lotSummary.find((x) => x.lot_id === u.lot_id)
  const seller = d.sellers.find((s) => s.id === u.seller_id)
  const order = u.holding_order_id ? d.orders.find((o) => o.id === u.holding_order_id) : undefined
  const os = order ? d.orderSummary.find((x) => x.order_id === order.id) : undefined
  const holder = holderCode(d, u)
  const p = unitProfit(u)

  return (
    <Shell section="kho" title={u.code} back="/kho"
      savebar={(u.status === 'in_stock' || u.status === 'incoming') ? <Link className="btn btn-primary btn-block" id="u-sell" to={`/don/new?chiec=${u.unit_id}`}>Bán chiếc này</Link> : undefined}>
      <div className="cols">
        <div>
          <div className="hero-g"><Gpic modelName={u.model_name} /></div>
          <div style={{ textAlign: 'center' }}>
            <div className="num" style={{ fontSize: 22, fontWeight: 600 }}>{u.code}</div>
            <div className="muted small">{u.model_name}{u.serial_no ? ` · seri ${u.serial_no}` : ''}</div>
            <div className="row" style={{ marginTop: 6, justifyContent: 'center' }}><UnitChip s={u.status} holder={holder} lot={u.lot_status} order={u.holding_order_status} /><ConditionChip c={u.condition ?? 'new'} /></div>
            {order && (
              <div className="small" style={{ marginTop: 4 }}>
                <Link className="link-btn small" to={`/don/${order.id}`}>{holder} · {u.holding_customer_name ?? ''} · {ORDER_LABEL[order.status]}</Link>
              </div>
            )}
          </div>

          <p className="section-title">Thông tin</p>
          <dl className="kv">
            <dt>Model</dt><dd>{u.model_name}</dd>
            <dt>Lô nhập</dt><dd><Link className="link-btn" style={{ padding: 0 }} to={`/lo/${u.lot_id}`}>{d.lotCode[u.lot_id] ?? 'Lô'}</Link> <LotChip s={u.lot_status} /></dd>
            <dt>Người bán</dt><dd>{seller ? <>{seller.nickname}{seller.is_avoided && <> <span className="pill bad">tránh</span></>}</> : '-'}</dd>
            <dt>Ngày đặt</dt><dd>{fullDate(u.ordered_at)}</dd>
            <dt>Ngày nhận</dt><dd>{u.received_at ? fullDate(u.received_at) : u.status === 'cancelled' ? '- (lô huỷ)' : '- (đang về)'}</dd>
            <dt>Tình trạng</dt><dd>{CONDITION_LABEL[u.condition ?? 'new']}</dd>
            <dt>{u.status === 'sold' ? 'Số ngày tồn (tới lúc gửi)' : 'Số ngày tồn'}</dt><dd className="num"><Aging u={u} /></dd>
            {u.status === 'sold' && <><dt>Ngày gửi</dt><dd>{fullDate(u.sold_at)}</dd></>}
          </dl>

          <p className="section-title">Giá</p>
          <dl className="kv">
            <dt>Giá web</dt><dd className="num">{cny(Number(u.price_cny))}</dd>
            <dt>Tỷ giá</dt><dd className="num">{Number(u.exchange_rate).toLocaleString('vi-VN')}</dd>
            <dt>Phí mua hộ</dt><dd className="num">{pct(Number(lot?.buying_fee_pct ?? 0))}</dd>
            <dt>Ship / chiếc</dt><dd className="num">{ls?.ship_per_unit_vnd != null ? vnd(ls.ship_per_unit_vnd) : <span className="req">chưa nhập phí ship lô</span>}</dd>
            <dt>Giá nhập tự tính</dt><dd className="num">{vnd(u.cost_vnd_auto)}{u.lot_ship_fee_vnd == null && <> <span className="pill way">tạm tính</span></>}</dd>
            <dt>Giá nhập sửa tay</dt><dd className="num">{u.cost_vnd_override != null ? vnd(u.cost_vnd_override) : '-'}</dd>
            <dt><b>Giá nhập dùng tính lãi</b></dt><dd className="num"><b><CostCell u={u} /></b></dd>
            <dt>Giá bán dự kiến</dt><dd className="num">{vnd(u.list_price_vnd)}</dd>
            {u.order_unit_price_vnd != null && <><dt>{u.status === 'sold' ? 'Giá chốt (đã bán)' : 'Giá chốt trên đơn'}</dt><dd className="num">{vnd(u.order_unit_price_vnd)}</dd></>}
            <dt>{p.actual ? 'Lãi thực tế' : 'Lãi dự kiến'}</dt><dd className="num"><Profit n={p.value} full est={!p.actual} /></dd>
          </dl>
          <HowTo>Giá nhập tự tính = giá web × tỷ giá × (1 + phí mua hộ {pct(Number(lot?.buying_fee_pct ?? 0))}) + phí ship lô ÷ {ls?.total_qty ?? 'số'} chiếc; tự cập nhật khi đổi tỷ giá / phí mua hộ / phí ship (kể cả chiếc đã bán). Đã sửa tay thì giữ số sửa tay.</HowTo>
        </div>
        <div>
          <UnitEditor u={u} />
          <p className="section-title">Lô nhập</p>
          {lot ? <div className="ov-list"><LotRow d={d} l={lot} /></div> : <p className="muted small">Không tìm thấy lô</p>}
          {order && (
            <>
              <p className="section-title">{u.status === 'sold' ? 'Đơn đã bán' : 'Đơn đang giữ'}</p>
              {os ? <div className="ov-list"><OrderRow d={d} o={os} /></div> : null}
            </>
          )}
        </div>
      </div>
    </Shell>
  )
}

/** Tuổi tồn có màu (KHO-S1) + giải thích ngưỡng; chiếc đang về: số ngày từ lúc đặt. */
function Aging({ u }: { u: UnitViewRow }) {
  const d = useData()
  const th = thresholds(d)
  if (u.days_in_stock == null) {
    const n = u.status === 'incoming' ? daysSince(u.ordered_at) : null
    return <>{n != null ? <span className="muted">- (đã đặt {n} ngày)</span> : '-'}</>
  }
  const note = u.aging_level === 'alert' ? ` · tồn lâu, quá ${th.alert} ngày` : u.aging_level === 'warn' ? ` · quá ${th.warn} ngày` : ''
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
      <p className="section-title">Sửa chiếc này</p>
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
          <input className={`input money ${errs.cost ? 'invalid' : ''}`} id="u-cost" inputMode="numeric" placeholder={`tự tính ${vnd(u.cost_vnd_auto)}`}
            value={cost} onChange={(e) => setCost(e.target.value)} />
          {errs.cost && <span className="field-err">{errs.cost}</span>}
        </label>
        <label className="f">Giá bán dự kiến (₫)
          <input className={`input money ${errs.price ? 'invalid' : ''}`} id="u-price" inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} />
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
