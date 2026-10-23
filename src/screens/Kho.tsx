import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useData } from '../data/store.tsx'
import type { UnitStatusDb, UnitViewRow } from '../data/types.ts'
import { Shell } from '../ui/Shell.tsx'
import { GrinderArt, Icon, shapeOf } from '../ui/icons.tsx'
import { ModelStockChip, UnitChip } from '../ui/status.tsx'
import { cny, tr, vnd } from '../ui/format.ts'
import { CostCell, GoRow, fold, holderCode, sortUnits, sortedModelStock, unitProfit, useDesk } from './overview/common.tsx'

type StatusFilter = 'avail' | UnitStatusDb | 'all'
const STATUS_TABS: [StatusFilter, string][] = [
  ['avail', 'Còn hàng'], ['in_stock', 'Trong kho'], ['incoming', 'Đang về'], ['reserved', 'Đã giữ'], ['sold', 'Đã bán'], ['all', 'Tất cả'],
]
const AVAIL: UnitStatusDb[] = ['in_stock', 'incoming', 'reserved']
const isStatus = (s: string | null): s is StatusFilter => STATUS_TABS.some(([k]) => k === s)

// SC_02 Kho (CR-001) — danh sách từng chiếc cối. Máy tính: bảng chiếc · điện thoại: thẻ model mở ra danh sách chiếc.
// Lọc: model (?model=), trạng thái (?tt=, mặc định "Còn hàng" = Trong kho + Đang về + Đã giữ), tìm theo mã / seri.
export default function Kho() {
  const d = useData()
  const desk = useDesk()
  const [params, setParams] = useSearchParams()
  const modelF = params.get('model') ?? 'all'
  const ttRaw = params.get('tt')
  const statusF: StatusFilter = isStatus(ttRaw) ? ttRaw : 'avail'
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<Set<string>>(new Set())

  const setParam = (k: string, v: string, def: string) => {
    const p = new URLSearchParams(params)
    if (v === def) p.delete(k); else p.set(k, v)
    setParams(p, { replace: true })
  }

  const stock = sortedModelStock(d)
  const ms = stock.filter((m) => modelF === 'all' || m.model_id === modelF)
  const qq = fold(q.trim())
  const matchStatus = (u: UnitViewRow) => statusF === 'all' || (statusF === 'avail' ? AVAIL.includes(u.status) : u.status === statusF)
  const matchQ = (u: UnitViewRow) => !qq || fold(u.code).includes(qq) || fold(u.serial_no ?? '').includes(qq)
  const units = sortUnits(d, d.unitView.filter((u) => (modelF === 'all' || u.model_id === modelF) && matchStatus(u) && matchQ(u)))
  const stockValue = ms.reduce((a, m) => a + m.stock_value_vnd, 0)
  const sellable = ms.reduce((a, m) => a + m.sellable_count, 0)
  const lowModels = stock.filter((m) => m.is_active && m.is_low_stock)

  const filters = (
    <div className="stack">
      <div className="chips" role="group" aria-label="Lọc theo model">
        <button className="chip" aria-pressed={modelF === 'all'} onClick={() => setParam('model', 'all', 'all')}>Tất cả</button>
        {stock.map((m) => (
          <button key={m.model_id} className="chip" aria-pressed={modelF === m.model_id} onClick={() => setParam('model', m.model_id, 'all')}>
            {m.model_name} <span className="c">{m.in_stock_count + m.incoming_count + m.reserved_count}</span>
          </button>
        ))}
      </div>
      <div className="row-wrap">
        <div className="seg" role="group" aria-label="Lọc theo trạng thái" style={{ overflowX: 'auto', maxWidth: '100%' }}>
          {STATUS_TABS.map(([k, t]) => (
            <button key={k} id={`kho-tt-${k}`} aria-pressed={statusF === k} onClick={() => setParam('tt', k, 'avail')}>{t}</button>
          ))}
        </div>
        <input className="input grow" id="kho-q" type="search" placeholder="Tìm mã / số seri (VD: KU-007)" aria-label="Tìm theo mã hoặc số seri"
          value={q} onChange={(e) => setQ(e.target.value)} style={{ minWidth: 180, maxWidth: desk ? 320 : undefined }} />
      </div>
      {modelF !== 'all' && ms[0] && (
        <p className="muted small row-wrap" style={{ margin: 0 }}>
          <b>{ms[0].model_name}</b> · {ms[0].in_stock_count} trong kho · {ms[0].incoming_count} đang về · {ms[0].reserved_count} đã giữ · {ms[0].sold_count} đã bán <ModelStockChip m={ms[0]} />
        </p>
      )}
      {modelF === 'all' && lowModels.length > 0 && (
        <p className="muted small row-wrap" style={{ margin: 0 }}>
          Cần nhập thêm:
          {lowModels.map((m) => <span key={m.model_id} className="row" style={{ gap: 4 }}>{m.model_name} <ModelStockChip m={m} /></span>)}
        </p>
      )}
    </div>
  )

  const noUnits = d.unitView.length === 0
  const emptyText = noUnits
    ? <div className="empty">Chưa có chiếc cối nào — bấm <Link to="/lo/new">Nhập lô Goofish</Link> để tạo chiếc (mỗi chiếc có mã riêng).</div>
    : <div className="empty">Không có chiếc nào khớp bộ lọc{q.trim() ? ` “${q.trim()}”` : ''}.</div>

  let list
  if (desk) {
    list = units.length === 0 ? emptyText : (
      <div className="tbl-wrap"><table className="tbl">
        <thead><tr>
          <th>Mã</th><th>Model</th><th>Lô</th><th>Trạng thái</th><th className="r">Giá ¥</th><th className="r">Giá nhập ₫</th>
          <th className="r">Giá bán dự kiến</th><th className="r">Lãi</th><th className="r">Ngày tồn</th>
        </tr></thead>
        <tbody>
          {units.map((u) => {
            const p = unitProfit(u)
            return (
              <GoRow key={u.unit_id} to={`/kho/${u.unit_id}`}>
                <td><Link className="cell-link num" to={`/kho/${u.unit_id}`}><b>{u.code}</b></Link>{u.serial_no && <div className="muted small">seri {u.serial_no}</div>}</td>
                <td>{u.model_name}</td>
                <td><Link className="link-btn small" style={{ padding: 0 }} to={`/lo/${u.lot_id}`}>{d.lotCode[u.lot_id] ?? 'Lô'}</Link></td>
                <td><UnitChip s={u.status} holder={holderCode(d, u)} /></td>
                <td className="r">{cny(Number(u.price_cny))}</td>
                <td className="r"><CostCell u={u} /></td>
                <td className="r">{vnd(u.status === 'sold' ? u.sold_price_vnd : u.list_price_vnd)}{u.status === 'sold' && <div className="muted small">giá chốt</div>}</td>
                <td className={`r ${p.value != null && p.value < 0 ? 'req' : ''}`}>{p.value == null ? '—' : vnd(p.value)}<div className="muted small">{p.value == null ? '' : p.actual ? 'thực tế' : 'dự kiến'}</div></td>
                <td className="r">{u.days_in_stock ?? '—'}</td>
              </GoRow>
            )
          })}
          <tr className="tot">
            <td colSpan={4}>{units.length} chiếc</td>
            <td colSpan={5} className="muted" style={{ textAlign: 'right' }}>Vốn trong kho {vnd(stockValue)} · có thể bán {sellable} chiếc</td>
          </tr>
        </tbody>
      </table></div>
    )
  } else {
    const toggle = (id: string) => setOpen((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
    const cards = ms.map((m) => {
      const mu = units.filter((u) => u.model_id === m.model_id)
      // Model đã ẩn: chỉ hiện khi có chiếc khớp bộ lọc
      if (!m.is_active && mu.length === 0) return null
      const expanded = open.has(m.model_id) || qq.length > 0 || modelF === m.model_id
      return (
        <div key={m.model_id} className="mcard">
          <span className="pic"><GrinderArt shape={shapeOf(m.model_name)} /></span>
          <div className="nm">{m.model_name}<small>{m.brand} · {m.in_stock_count} trong kho · {m.incoming_count} đang về · {m.reserved_count} giữ</small></div>
          <div className="big">{m.sellable_count}<small>bán được</small></div>
          <div className="vars"><ModelStockChip m={m} />{!m.is_active && <span className="pill">Đã ẩn</span>}</div>
          <div className="vrow">
            <button onClick={() => toggle(m.model_id)} aria-expanded={expanded}>
              <span>{mu.length} chiếc {STATUS_TABS.find(([k]) => k === statusF)?.[1].toLowerCase()}</span>
              <span className="n">{expanded ? 'Thu gọn' : 'Xem chiếc'}</span>
            </button>
            {expanded && mu.length === 0 && <p className="muted small" style={{ margin: '8px 2px' }}>Không có chiếc nào khớp bộ lọc.</p>}
            {expanded && mu.map((u) => (
              <Link key={u.unit_id} to={`/kho/${u.unit_id}`}>
                <span className="row-wrap"><b className="num">{u.code}</b> <UnitChip s={u.status} holder={holderCode(d, u)} /></span>
                <span className="n">nhập {tr(u.cost_vnd)}{u.cost_is_overridden ? '*' : u.cost_is_provisional ? '~' : ''} · bán {tr(u.status === 'sold' ? u.sold_price_vnd : u.list_price_vnd)}</span>
              </Link>
            ))}
          </div>
          <div className="qa">
            <Link className="btn btn-ghost btn-sm" to={`/lo/new?model=${m.model_id}`}><Icon name="plus" /> Nhập</Link>
            <Link className="btn btn-primary btn-sm" to="/don/new">Bán</Link>
          </div>
        </div>
      )
    })
    list = noUnits && ms.length === 0
      ? <div className="empty">Chưa có model nào — vào <Link to="/danhmuc">Model</Link> để thêm.</div>
      : (
        <>
          {noUnits && emptyText}
          <div className="mcards">{cards}</div>
          <p className="hint" style={{ textAlign: 'center' }}>Vốn trong kho {vnd(stockValue)} · bán được = trong kho + đang về chưa giữ. Giá nhập: * sửa tay, ~ tạm tính (lô chưa có phí ship).</p>
        </>
      )
  }

  return (
    <Shell section="kho" title="Kho" actions={<>
      <Link className="btn btn-ghost btn-sm" to="/danhmuc">Model</Link>
      <Link className="btn btn-primary btn-sm only-desk" to="/lo/new"><Icon name="plus" /> Nhập lô</Link>
    </>}>
      {filters}
      {list}
    </Shell>
  )
}
