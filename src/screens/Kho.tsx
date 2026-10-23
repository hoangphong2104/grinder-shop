import { Fragment, useCallback, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useData } from '../data/store.tsx'
import type { UnitConditionDb, UnitViewRow } from '../data/types.ts'
import { Shell } from '../ui/Shell.tsx'
import { Sheet } from '../ui/feedback.tsx'
import { Icon } from '../ui/icons.tsx'
import { CONDITION_LABEL, CONDITION_ORDER, ConditionChip, UnitChip } from '../ui/status.tsx'
import { cny, tr, vnd } from '../ui/format.ts'
import {
  CostCell, GoRow, Profit, UNIT_SORTS, UnitRow, agingCls, daysSince, holderCode, sortUnits, sortedModelStock, unitMatch, unitPrice,
  unitProfit, useDesk, type UnitSort,
} from './overview/common.tsx'

// Ô tóm tắt không trùng nhau: Kho TQ / Kho VN = chiếc đang về CHƯA giữ; Đã giữ = mọi chiếc giữ cho đơn (đã về hay chưa).
// CR-005 (ý 4, 7–10): trạng thái chiếc theo vị trí - Kho TQ / Kho VN (đang về) → Kho Lumi (bán được) → Giữ cho đơn → Vận chuyển tới khách → Đã giao.
// Tham khảo Shopify (Incoming / On hand / Committed / Available) + KiotViet / Sapo (thẻ tóm tắt bấm để lọc, cảnh báo tồn theo từng mặt hàng).
type StatusFilter = 'avail' | 'tq' | 'vn' | 'lumi' | 'giu' | 'giao' | 'xong' | 've' | 'ban' | 'all'
const TILES: [StatusFilter, string][] = [['tq', 'Kho TQ'], ['vn', 'Kho VN'], ['lumi', 'Kho Lumi'], ['giu', 'Đã giữ'], ['giao', 'Đang giao']]
const CHIPS: [StatusFilter, string][] = [['avail', 'Còn hàng'], ['xong', 'Đã giao'], ['all', 'Tất cả']]
/** Lọc ẩn (link cũ ?tt=incoming / sold …) - hiện chip ✕ để bỏ. */
const HIDDEN: Partial<Record<StatusFilter, string>> = { ve: 'Đang về', ban: 'Đã bán' }
const ALIAS: Record<string, StatusFilter> = { in_stock: 'lumi', reserved: 'giu', incoming: 've', sold: 'ban' }
const ALL_KEYS: StatusFilter[] = ['avail', 'tq', 'vn', 'lumi', 'giu', 'giao', 'xong', 've', 'ban', 'all']
const parseStatus = (s: string | null): StatusFilter => (s && ALL_KEYS.includes(s as StatusFilter) ? (s as StatusFilter) : (s && ALIAS[s]) || 'avail')
const isSort = (s: string | null): s is UnitSort => UNIT_SORTS.some(([k]) => k === s)
const isCond = (s: string | null): s is UnitConditionDb => CONDITION_ORDER.includes(s as UnitConditionDb)
function matchStatus(u: UnitViewRow, f: StatusFilter): boolean {
  switch (f) {
    case 'all': return true
    case 'avail': return u.status === 'in_stock' || u.status === 'incoming' || u.status === 'reserved'
    case 'tq': return u.status === 'incoming' && u.lot_status === 'cn_warehouse'
    case 'vn': return u.status === 'incoming' && u.lot_status === 'vn_warehouse'
    case 've': return !u.is_received && (u.status === 'incoming' || u.status === 'reserved')
    case 'lumi': return u.status === 'in_stock'
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
  const [q, setQ] = useState('')
  const [sheet, setSheet] = useState(false)
  const closeSheet = useCallback(() => setSheet(false), [])

  const setParam = (k: string, v: string | null, def: string | null = null) => {
    const p = new URLSearchParams(params)
    if (v == null || v === def) p.delete(k); else p.set(k, v)
    setParams(p, { replace: true })
  }

  const stock = sortedModelStock(d)
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
  // CR-005 ý 9: tóm tắt có ích - số chiếc theo vị trí (bấm để lọc) + vốn Kho Lumi / vốn đang về (theo model / tình trạng / tìm đang chọn)
  const sellable = units.filter((u) => u.status === 'in_stock' || u.status === 'incoming').length
  const capital = base.filter(onHand).reduce((a, u) => a + u.cost_vnd, 0)
  const incomingCap = base.filter(onTheWay).reduce((a, u) => a + u.cost_vnd, 0)
  // CR-005 ý 8: cảnh báo rõ theo từng model (đang bán): hết / còn N chiếc bán được (Kho Lumi + đang về chưa giữ)
  const lowModels = stock.filter((m) => m.is_active && (m.is_low_stock || m.sellable_count <= 0) && (modelF === 'all' || m.model_id === modelF))
  const filtering = modelF !== 'all' || condF != null || sx !== 'ma'
  const capText = [capital > 0 && `vốn Kho Lumi ${tr(capital)}`, incomingCap > 0 && `vốn đang về ${tr(incomingCap)}`].filter(Boolean).join(' · ')

  const filters = (
    <div className="ov-filter">
      <input className="input" id="kho-q" type="search" placeholder="Tìm mã, seri, model, ghi chú (VD: zp6 1)" aria-label="Tìm chiếc theo mã, số seri, model hoặc ghi chú"
        value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: desk ? 420 : undefined }} />
      <div className="kho-tiles" role="group" aria-label="Số chiếc theo vị trí - bấm để lọc">
        {TILES.map(([k, t]) => (
          <button key={k} type="button" className="kho-tile" id={`kho-tt-${k}`} aria-pressed={statusF === k} onClick={() => setParam('tt', statusF === k ? null : k, 'avail')}>
            <span className="v">{count(k)}</span><span className="k">{t}</span>
          </button>
        ))}
      </div>
      {capText && <p className="ov-strip">{capText}</p>}
      <div className="line">
        <div className="chips" role="group" aria-label="Lọc theo trạng thái">
          {modelF !== 'all' && (
            <button className="chip x" id="kho-model-x" onClick={() => setParam('model', null)} aria-label={`Bỏ lọc model ${modelName ?? ''}`}>{modelName ?? 'Model'} ✕</button>
          )}
          {condF && <button className="chip x" id="kho-cond-x" onClick={() => setParam('tinhtrang', null)} aria-label="Bỏ lọc tình trạng">{CONDITION_LABEL[condF]} ✕</button>}
          {HIDDEN[statusF] && <button className="chip x" id="kho-tt-x" onClick={() => setParam('tt', null)}>{HIDDEN[statusF]} ✕</button>}
          {TILES.some(([k]) => k === statusF) && <button className="chip x" id="kho-tt-x" onClick={() => setParam('tt', null)}>{TILES.find(([k]) => k === statusF)![1]} ✕</button>}
          {CHIPS.map(([k, t]) => (
            <button key={k} className="chip" id={`kho-tt-${k}`} aria-pressed={statusF === k} onClick={() => setParam('tt', k, 'avail')}>
              {t} <span className="c">{count(k)}</span>
            </button>
          ))}
        </div>
        <button className="btn btn-ghost btn-sm fbtn" id="kho-filter" onClick={() => setSheet(true)} aria-haspopup="dialog">
          Lọc{filtering && <span className="dot" aria-label="đang lọc" />}
        </button>
      </div>
      {lowModels.length > 0 && (
        <div className="kho-low" id="kho-low" role="note" aria-label="Model sắp hết">
          {lowModels.map((m) => (
            <Link key={m.model_id} className="ln" to={`/kho?model=${m.model_id}`}>
              <Icon name="warn" size={15} /><span className="nm">{m.model_name}</span>
              <span className={m.sellable_count <= 0 ? 'neg' : 'age-warn'}>{m.sellable_count <= 0 ? 'hết hàng bán được' : `còn ${m.sellable_count} bán được`}</span>
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
            <td colSpan={5}>{units.length} chiếc · bán được {sellable}</td>
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
      {filters}
      {list}
      {sheet && (
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
