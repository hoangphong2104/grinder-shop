import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useData } from '../data/store.tsx'
import { Shell } from '../ui/Shell.tsx'
import { GrinderArt, Gpic, Icon, shapeOf } from '../ui/icons.tsx'
import { StockChip } from '../ui/status.tsx'
import { tr, vnd } from '../ui/format.ts'
import { GoRow, sortedStock, useDesk, waitingLot } from './overview/common.tsx'

// SC_02 Kho — máy tính: bảng (A) · điện thoại: thẻ model (D). Chỉ model / màu đang bán.
export default function Kho() {
  const d = useData()
  const desk = useDesk()
  const [filter, setFilter] = useState<string>('all')
  const activeModels = d.models.filter((m) => m.is_active)
  const ms = activeModels.filter((m) => filter === 'all' || m.id === filter)
  const vs = sortedStock(d).filter((s) => ms.some((m) => m.id === s.model_id))
  const tot = vs.reduce((a, s) => ({ h: a.h + s.on_hand, i: a.i + s.incoming, r: a.r + s.reserved, s: a.s + s.sellable, val: a.val + s.stock_value_vnd }),
    { h: 0, i: 0, r: 0, s: 0, val: 0 })

  const chips = (
    <div className="chips">
      <button className="chip" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>Tất cả</button>
      {activeModels.map((m) => <button key={m.id} className="chip" aria-pressed={filter === m.id} onClick={() => setFilter(m.id)}>{m.name}</button>)}
    </div>
  )

  let list
  if (vs.length === 0) {
    list = <div className="empty">Chưa có màu nào đang bán — vào <Link to="/danhmuc">Model & màu</Link> để thêm màu / phiên bản.</div>
  } else if (desk) {
    list = (
      <div className="tbl-wrap"><table className="tbl">
        <thead><tr><th>Model · màu</th><th className="r">Có sẵn</th><th className="r">Đang về</th><th className="r">Đã giữ</th><th className="r">Có thể bán</th><th>Tình trạng</th><th className="r">Giá vốn BQ</th><th className="r">Giá bán</th><th className="r">Lãi / chiếc</th></tr></thead>
        <tbody>
          {vs.map((s) => (
            <GoRow key={s.variant_id} to={`/kho/${s.variant_id}`}>
              <td><Link className="row cell-link" to={`/kho/${s.variant_id}`}><Gpic modelName={s.model_name} />{s.model_name} · {s.variant_name}</Link></td>
              <td className="r">{s.on_hand}</td><td className="r">{s.incoming}</td><td className="r">{s.reserved}</td>
              <td className="r"><b>{s.sellable}</b></td>
              <td><StockChip v={s} waitingLot={waitingLot(d, s.variant_id)} /></td>
              <td className="r">{s.on_hand ? vnd(s.avg_cost_vnd) : '—'}</td>
              <td className="r">{vnd(s.list_price_vnd)}</td>
              <td className="r">{s.on_hand && s.list_price_vnd != null ? vnd(s.list_price_vnd - s.avg_cost_vnd) : '—'}</td>
            </GoRow>
          ))}
          <tr className="tot"><td>Tổng</td><td className="r">{tot.h}</td><td className="r">{tot.i}</td><td className="r">{tot.r}</td><td className="r">{tot.s}</td><td colSpan={4} className="muted">Vốn trong kho {vnd(tot.val)}</td></tr>
        </tbody>
      </table></div>
    )
  } else {
    list = (
      <>
        <div className="mcards">
          {ms.map((m) => {
            const mv = vs.filter((s) => s.model_id === m.id)
            if (mv.length === 0) return null
            const sell = mv.reduce((a, s) => a + s.sellable, 0)
            return (
              <div key={m.id} className="mcard">
                <span className="pic"><GrinderArt shape={shapeOf(m.name)} /></span>
                <div className="nm">{m.name}<small>{m.brand} · {mv.length} màu</small></div>
                <div className="big">{sell}<small>bán được</small></div>
                <div className="vars">{mv.map((s) => <StockChip key={s.variant_id} v={s} waitingLot={waitingLot(d, s.variant_id)} />)}</div>
                <div className="vrow">
                  {mv.map((s) => (
                    <Link key={s.variant_id} to={`/kho/${s.variant_id}`}>
                      <span>{s.variant_name} <span className="muted small">· {tr(s.list_price_vnd)}</span></span>
                      <span className="n">sẵn {s.on_hand} · về {s.incoming} · giữ {s.reserved}</span>
                    </Link>
                  ))}
                </div>
                <div className="qa">
                  <Link className="btn btn-ghost btn-sm" to="/lo/new"><Icon name="plus" /> Nhập</Link>
                  <Link className="btn btn-primary btn-sm" to="/don/new">Bán</Link>
                </div>
              </div>
            )
          })}
        </div>
        <p className="hint" style={{ textAlign: 'center' }}>Vốn trong kho {vnd(tot.val)} · bán được = sẵn + đang về − đã giữ</p>
      </>
    )
  }

  return (
    <Shell section="kho" title="Kho" actions={<Link className="btn btn-ghost btn-sm" to="/danhmuc">Model & màu</Link>}>
      {chips}
      {list}
    </Shell>
  )
}
