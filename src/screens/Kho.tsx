import { Fragment, useCallback, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useData } from '../data/store.tsx'
import type { UnitConditionDb, UnitViewRow } from '../data/types.ts'
import { Shell } from '../ui/Shell.tsx'
import { LotsPanel } from './Lots.tsx'
import { Sheet } from '../ui/feedback.tsx'
import { Icon } from '../ui/icons.tsx'
import { CONDITION_LABEL, CONDITION_ORDER, ConditionChip, UnitChip } from '../ui/status.tsx'
import { cny, tr, vnd } from '../ui/format.ts'
import {
  CostCell, GoRow, Profit, UNIT_SORTS, UnitRow, agingCls, daysSince, holderCode, sortUnits, sortedModelStock, unitMatch, unitPrice,
  unitProfit, useDesk, type UnitSort,
} from './overview/common.tsx'

// CR-006: trạng thái chiếc giống tab Lô (Kho TQ → Kho VN → Kho Lumi) theo vị trí của chiếc, cộng "Đã bán".
// Chiếc khách đã đặt vẫn nằm ở kho của nó (ghi "khách đặt" trên dòng). Lô nhập gộp vào đây: nút "Theo lô" (?xem=lo).
type StatusFilter = 'avail' | 'tq' | 'vn' | 'lumi' | 'ban' | 'all' | 'giu' | 'giao' | 'xong' | 've'
const CHIPS: [StatusFilter, string][] = [['avail', 'Còn hàng'], ['tq', 'Kho TQ'], ['vn', 'Kho VN'], ['lumi', 'Kho Lumi'], ['ban', 'Đã bán'], ['all', 'Tất cả']]
/** Lọc ẩn (link từ Tổng quan / link cũ) - hiện chip ✕ để bỏ. */
const HIDDEN: Partial<Record<StatusFilter, string>> = { giu: 'Khách đã đặt', giao: 'Đang giao tới khách', xong: 'Đã giao', ve: 'Đang về' }
const ALIAS: Record<string, StatusFilter> = { in_stock: 'lumi', reserved: 'giu', incoming: 've', sold: 'ban' }
const ALL_KEYS: StatusFilter[] = ['avail', 'tq', 'vn', 'lumi', 'ban', 'all', 'giu', 'giao', 'xong', 've']
const parseStatus = (s: string | null): StatusFilter => (s && ALL_KEYS.includes(s as StatusFilter) ? (s as StatusFilter) : (s && ALIAS[s]) || 'avail')
const isSort = (s: string | null): s is UnitSort => UNIT_SORTS.some(([k]) => k === s)
const isCond = (s: string | null): s is UnitConditionDb => CONDITION_ORDER.includes(s as UnitConditionDb)
const unsold = (u: UnitViewRow) => u.status === 'in_stock' || u.status === 'incoming' || u.status === 'reserved'
function matchStatus(u: UnitViewRow, f: StatusFilter): boolean {
  switch (f) {
    case 'all': return true
    case 'avail': return unsold(u)
    case 'tq': return unsold(u) && !u.is_received && u.lot_status === 'cn_warehouse'
    case 'vn': return unsold(u) && !u.is_received && u.lot_status === 'vn_warehouse'
    case 've': return unsold(u) && !u.is_received
    case 'lumi': return unsold(u) && u.is_received
    case 'giu': return u.status === 'reserved'
    case 'giao': return u.status === 'sold' && u.holding_order_status === 'shipped'
    case 'xong': return u.status === 'sold' && u.holding_order_status !== 'shipped'
    case 'ban': return u.status === 'sold'
  }
}
/** Vốn Kho Lumi = giá nhập chiếc đã về kho chưa bán (Kho Lumi + Đã giữ đã về) - như v_model_stock.stock_value_vnd. */
const onHand = (u: UnitViewRow) => u.is_received && (u.status === 'in_stock' || u.status === 'reserved')
/** Vốn đang về = giá nhập chiếc chưa về (Kho TQ / Kho VN, gồm chiếc đã giữ) - như incoming_value_vnd. */
const onTheWay = (u: UnitViewRow) => !u.is_received && (u.status === 'incoming' || u.status === 'reserved')

export default function Kho() {
  const d = useData()
  const desk = useDesk()
  const [params, setParams] = useSearchParams()
  const modelF = params.get('model') ?? 'all'
  const ttRaw = params.get('tt'), sxRaw = params.get('sx'), condRaw = params.get('tinhtrang')
  const statusF: StatusFilter = parseStatus(ttRaw)
  const sx: UnitSort = isSort(sxRaw) ? sxRaw : 'ma'
  const condF: UnitConditionDb | null = isCond(condRaw) ? condRaw : null
  const byLot = params.get('xem') === 'lo'
  const [q, setQ] = useState('')
  const [sheet, setSheet] = useState(false)
  const closeSheet = useCallback(() => setSheet(false), [])

  const setParam = (k: string, v: string | null, def: string | null = null) => {
    const p = new URLSearchParams(params)
    if (v == null || v === def) p.delete(k); else p.set(k, v)
    setParams(p, { replace: true })
  }

  const stock = sortedModelStock(d)
  const openLots = d.lots.filter((l) => l.status !== 'received' && l.status !== 'cancelled').length
  const modelName = d.models.find((m) => m.id === modelF)?.code_prefix ?? d.models.find((m) => m.id === modelF)?.name
  // Lọc nền (model + tình trạng + tìm) - đếm chip trạng thái trên tập này
  const hit = new Map<string, ReturnType<typeof unitMatch>>()
  const base = d.unitView.filter((u) => {
    if (modelF !== 'all' && u.model_id !== modelF) return false
    if (condF && u.condition !== condF) return false
    const m = unitMatch(u, q)
    if (!m) return false
    hit.set(u.unit_id, m)
    return true
  })
  const count = (f: StatusFilter) => base.filter((u) => matchStatus(u, f)).length
  const units = sortUnits(d, base.filter((u) => matchStatus(u, statusF)), sx)
  // Tiền hàng chưa bán (theo model / tình trạng / tìm đang chọn): đang về (Kho TQ / Kho VN) và đã về Kho Lumi
  const sellable = units.filter((u) => u.status === 'in_stock' || u.status === 'incoming').length
  const capital = base.filter(onHand).reduce((a, u) => a + u.cost_vnd, 0)
  const incomingCap = base.filter(onTheWay).reduce((a, u) => a + u.cost_vnd, 0)
  // CR-005 ý 8: cảnh báo rõ theo từng model (đang bán): hết / còn N chiếc bán được (Kho Lumi + đang về chưa giữ)
  const lowModels = stock.filter((m) => m.is_active && (m.is_low_stock || m.sellable_count <= 0) && (modelF === 'all' || m.model_id === modelF))
  const filtering = modelF !== 'all' || condF != null || sx !== 'ma'
  const capText = capital + incomingCap > 0 ? `Chưa bán: ${[incomingCap > 0 && `${tr(incomingCap)} đang về`, capital > 0 && `${tr(capital)} ở Kho Lumi`].filter(Boolean).join(' · ')}` : ''

  const filters = (
    <div className="ov-filter">
      <div className="line">
        <input className="input" id="kho-q" type="search" placeholder="Tìm mã, seri, model, ghi chú" aria-label="Tìm chiếc theo mã, số seri, model hoặc ghi chú"
          value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 0, maxWidth: desk ? 420 : undefined }} />
        <button className="btn btn-ghost btn-sm fbtn" id="kho-filter" onClick={() => setSheet(true)} aria-haspopup="dialog">
          Lọc{filtering && <span className="dot" aria-label="đang lọc" />}
        </button>
      </div>
      <div className="chips stage-chips" role="group" aria-label="Lọc theo trạng thái">
        {CHIPS.map(([k, t]) => (
          <button key={k} type="button" className="chip" id={`kho-tt-${k}`} aria-pressed={statusF === k} onClick={() => setParam('tt', k, 'avail')}>
            {t}<span className="c">{count(k)}</span>
          </button>
        ))}
      </div>
      {capText && <p className="ov-strip">{capText}</p>}
      {(modelF !== 'all' || condF || HIDDEN[statusF]) && (
        <div className="chips" role="group" aria-label="Đang lọc">
          {modelF !== 'all' && (
            <button className="chip x" id="kho-model-x" onClick={() => setParam('model', null)} aria-label={`Bỏ lọc model ${modelName ?? ''}`}>{modelName ?? 'Model'} ✕</button>
          )}
          {condF && <button className="chip x" id="kho-cond-x" onClick={() => setParam('tinhtrang', null)} aria-label="Bỏ lọc tình trạng">{CONDITION_LABEL[condF]} ✕</button>}
          {HIDDEN[statusF] && <button className="chip x" id="kho-tt-x" onClick={() => setParam('tt', null)}>{HIDDEN[statusF]} ✕</button>}
        </div>
      )}
      {lowModels.length > 0 && (
        <div className="kho-low" id="kho-low" role="note" aria-label="Model sắp hết">
          {lowModels.map((m) => (
            <Link key={m.model_id} className="ln" to={`/kho?model=${m.model_id}`}>
              <Icon name="warn" size={15} /><span className="nm">{m.model_name}</span>
              <span className={m.sellable_count <= 0 ? 'neg' : 'age-warn'}>{m.sellable_count <= 0 ? 'hết hàng' : `còn ${m.sellable_count} chiếc chưa ai đặt`}</span>
            </Link>
          ))}
          <Link className="link-btn small" to="/lo/new">Nhập lô Goofish <Icon name="chev" size={14} /></Link>
        </div>
      )}
    </div>
  )

  const noUnits = d.unitView.length === 0
  const emptyText = noUnits
    ? <div className="empty">Chưa có chiếc cối nào - bấm <Link to="/lo/new">Nhập lô Goofish</Link> để tạo chiếc (mỗi chiếc có mã riêng).</div>
    : <div className="empty">Không có chiếc nào khớp bộ lọc{q.trim() ? ` “${q.trim()}”` : ''}.</div>

  // Tiêu đề cột sắp xếp được (máy tính) - bấm lần nữa về sắp theo mã
  const sortTh = (k: UnitSort, label: string, r?: boolean) => (
    <th className={r ? 'r' : undefined} aria-sort={sx === k ? (k === 'ma' ? 'ascending' : 'descending') : 'none'}>
      <button className="sort" id={`kho-th-${k}`} onClick={() => setParam('sx', sx === k ? 'ma' : k, 'ma')}>{label}{sx === k && k !== 'ma' ? ' ↓' : ''}</button>
    </th>
  )

  let list
  if (units.length === 0) list = emptyText
  else if (desk) {
    list = (
      <div className="tbl-wrap"><table className="tbl">
        <thead><tr>
          {sortTh('ma', 'Mã')}<th>Model</th><th>Lô</th><th>Trạng thái</th><th>Tình trạng</th><th className="r">Giá ¥</th>
          <th className="r">Giá nhập ₫</th>{sortTh('gia', 'Giá bán dự kiến', true)}{sortTh('lai', 'Lãi', true)}{sortTh('ton', 'Ngày tồn', true)}
        </tr></thead>
        <tbody>
          {units.map((u) => {
            const p = unitProfit(u)
            const ordered = u.status === 'incoming' ? daysSince(u.ordered_at) : null
            return (
              <GoRow key={u.unit_id} to={`/kho/${u.unit_id}`}>
                <td><Link className="cell-link num" to={`/kho/${u.unit_id}`}><b>{u.code}</b></Link>{u.serial_no && <div className="muted small">seri {u.serial_no}</div>}</td>
                <td>{u.model_name}</td>
                <td><Link className="link-btn small" style={{ padding: 0 }} to={`/lo/${u.lot_id}`}>{d.lotCode[u.lot_id] ?? 'Lô'}</Link></td>
                <td><UnitChip s={u.status} holder={holderCode(d, u)} lot={u.lot_status} order={u.holding_order_status} /></td>
                <td><ConditionChip c={u.condition ?? 'new'} /></td>
                <td className="r">{cny(Number(u.price_cny))}</td>
                <td className="r"><CostCell u={u} /></td>
                <td className="r">{vnd(unitPrice(u))}{u.status === 'sold' && <div className="muted small">giá chốt</div>}</td>
                <td className="r"><Profit n={p.value} full />{p.value != null && !p.actual && <div className="muted small">dự kiến</div>}</td>
                <td className={`r ${agingCls(u.aging_level)}`}>{u.days_in_stock ?? (ordered != null ? <span className="muted">đặt {ordered}</span> : '-')}</td>
              </GoRow>
            )
          })}
          <tr className="tot">
            <td colSpan={5}>{units.length} chiếc · {sellable} chưa ai đặt</td>
            <td colSpan={5} className="muted" style={{ textAlign: 'right' }}>{capText}</td>
          </tr>
        </tbody>
      </table></div>
    )
  } else {
    // Điện thoại (KHO-M1): danh sách phẳng từng chiếc; sắp theo mã thì chèn tiêu đề nhóm dính theo model (KHO-S5)
    list = (
      <div className="ov-list">
        {units.map((u, i) => {
          const head = sx === 'ma' && (i === 0 || units[i - 1].model_id !== u.model_id)
          const n = head ? units.filter((x) => x.model_id === u.model_id).length : 0
          const m = hit.get(u.unit_id)
          return (
            <Fragment key={u.unit_id}>
              {head && <div className="ov-gh"><span>{u.model_name}</span><span className="muted">{n} chiếc</span></div>}
              <UnitRow d={d} u={u} sub={m === 'serial' && q.trim() ? <>seri {u.serial_no}</> : undefined} />
            </Fragment>
          )
        })}
      </div>
    )
  }

  return (
    <Shell section="kho" title="Kho" actions={<>
      <Link className="btn btn-ghost btn-sm only-desk" to="/danhmuc">Model</Link>
      <Link className="btn btn-primary btn-sm only-desk" to="/lo/new"><Icon name="plus" /> Nhập lô</Link>
    </>}>
      <div className="seg kho-view" role="group" aria-label="Xem kho">
        <button id="kho-xem-chiec" aria-pressed={!byLot} onClick={() => setParam('xem', null)}>Từng chiếc</button>
        <button id="kho-xem-lo" aria-pressed={byLot} onClick={() => setParam('xem', 'lo')}>Theo lô{openLots ? <span className="c"> {openLots} đang về</span> : null}</button>
      </div>
      {byLot ? <LotsPanel /> : <>{filters}{list}</>}
      {!byLot && sheet && (
        <Sheet title="Lọc & sắp xếp" onClose={closeSheet}>
          <p className="ov-sheet-t">Sắp xếp</p>
          <div className="ov-opts" role="radiogroup" aria-label="Sắp xếp">
            {UNIT_SORTS.map(([k, t]) => (
              <button key={k} className="chip" role="radio" id={`kho-sx-${k}`} aria-checked={sx === k} aria-pressed={sx === k} onClick={() => setParam('sx', k, 'ma')}>{t}</button>
            ))}
          </div>
          <p className="ov-sheet-t">Model</p>
          <div className="ov-opts" role="group" aria-label="Lọc theo model">
            <button className="chip" id="kho-m-all" aria-pressed={modelF === 'all'} onClick={() => setParam('model', null)}>Tất cả</button>
            {stock.map((m) => (
              <button key={m.model_id} className="chip" id={`kho-m-${m.code_prefix}`} aria-pressed={modelF === m.model_id} onClick={() => setParam('model', m.model_id)}>
                {m.model_name} <span className="c">{m.sellable_count + m.reserved_count}</span>
              </button>
            ))}
          </div>
          <p className="ov-sheet-t">Tình trạng</p>
          <div className="ov-opts" role="group" aria-label="Lọc theo tình trạng">
            <button className="chip" id="kho-c-all" aria-pressed={!condF} onClick={() => setParam('tinhtrang', null)}>Tất cả</button>
            {CONDITION_ORDER.map((c) => (
              <button key={c} className="chip" id={`kho-c-${c}`} aria-pressed={condF === c} onClick={() => setParam('tinhtrang', c)}>{CONDITION_LABEL[c]}</button>
            ))}
          </div>
          <Link className="link-btn" to="/danhmuc" style={{ alignSelf: 'flex-start' }}>Sửa danh mục model <Icon name="chev" size={16} /></Link>
        </Sheet>
      )}
    </Shell>
  )
}
