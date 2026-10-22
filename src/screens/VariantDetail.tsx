import { useParams } from 'react-router-dom'
import { useData } from '../data/store.tsx'
import { Shell } from '../ui/Shell.tsx'
import { Gpic } from '../ui/icons.tsx'
import { StockChip } from '../ui/status.tsx'
import { vnd } from '../ui/format.ts'
import { LotShot, OrderShot, waitingLot } from './overview/common.tsx'

// SC_03 Chi tiết biến thể: số tồn, giá vốn BQ, các lô và đơn có màu này.
export default function VariantDetail() {
  const { id = '' } = useParams()
  const d = useData()
  const v = d.variants.find((x) => x.id === id)
  const s = d.stock.find((x) => x.variant_id === id)
  if (!v || !s) {
    return <Shell section="kho" title="Không tìm thấy" back="/kho"><div className="empty"><b>Không tìm thấy model / màu này</b><br />Có thể đã bị xoá — quay lại Kho.</div></Shell>
  }
  const m = d.models.find((x) => x.id === v.model_id)
  const name = `${s.model_name} · ${s.variant_name}`
  const lotIds = new Set(d.lotLines.filter((x) => x.variant_id === id).map((x) => x.lot_id))
  const lots = d.lots.filter((l) => lotIds.has(l.id)).reverse()
  const orderIds = new Set(d.orderLines.filter((x) => x.variant_id === id).map((x) => x.order_id))
  const ords = d.orders.filter((o) => orderIds.has(o.id)).reverse()

  return (
    <Shell section="kho" title={name} back="/kho">
      <div className="cols">
        <div>
          <div className="hero-g"><Gpic modelName={s.model_name} /></div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 20 }}>{name}</div>
            <div className="muted small">{m?.brand} · giá bán {vnd(s.list_price_vnd)}</div>
            <div style={{ marginTop: 6 }}><StockChip v={s} waitingLot={waitingLot(d, id)} />{!s.is_active && <> <span className="pill">Đã ẩn</span></>}</div>
          </div>
          <div className="kpis">
            <div className="kpi"><span className="k">Có sẵn</span><span className="v">{s.on_hand}</span></div>
            <div className="kpi"><span className="k">Đang về</span><span className="v">{s.incoming}</span></div>
            <div className="kpi"><span className="k">Đã giữ</span><span className="v">{s.reserved}</span></div>
            <div className="kpi"><span className="k">Có thể bán</span><span className="v">{s.sellable}</span></div>
          </div>
          <dl className="kv">
            <dt>Giá vốn bình quân</dt><dd className="num">{s.on_hand ? vnd(s.avg_cost_vnd) : '— (hết hàng)'}</dd>
            <dt>Lãi dự kiến / chiếc</dt><dd className="num">{s.on_hand && s.list_price_vnd != null ? vnd(s.list_price_vnd - s.avg_cost_vnd) : '—'}</dd>
            <dt>Giá trị tồn</dt><dd className="num">{vnd(s.stock_value_vnd)}</dd>
          </dl>
          <p className="hint">Giá vốn bình quân chỉ đổi khi một lô chuyển “Đã nhận” (BR-04).</p>
        </div>
        <div>
          <p className="section-title">Lô nhập</p>
          <div className="stack">{lots.length ? lots.map((l) => <LotShot key={l.id} d={d} l={l} />) : <p className="muted small">Chưa có lô nào có màu này</p>}</div>
          <p className="section-title">Đơn bán</p>
          <div className="stack">{ords.length ? ords.map((o) => <OrderShot key={o.id} d={d} o={o} />) : <p className="muted small">Chưa có đơn nào có màu này</p>}</div>
        </div>
      </div>
    </Shell>
  )
}
