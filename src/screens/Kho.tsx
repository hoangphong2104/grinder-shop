import { Fragment, useCallback, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useData } from '../data/store.tsx'
import type { UnitConditionDb, UnitStatusDb, UnitViewRow } from '../data/types.ts'
import { Shell } from '../ui/Shell.tsx'
import { Sheet } from '../ui/feedback.tsx'
import { Icon } from '../ui/icons.tsx'
import { CONDITION_LABEL, CONDITION_ORDER, ConditionChip, UnitChip } from '../ui/status.tsx'
import { cny, tr, vnd } from '../ui/format.ts'
import {
  CostCell, GoRow, HowTo, UNIT_SORTS, UnitRow, agingCls, daysSince, holderCode, sortUnits, sortedModelStock, thresholds, unitMatch, unitPrice,
  unitProfit, useDesk, type UnitSort,
} from './overview/common.tsx'

type StatusFilter = 'avail' | UnitStatusDb | 'all'
const STATUS_TABS: [StatusFilter, string][] = [
  ['avail', 'Còn hàng'], ['in_stock', 'Trong kho'], ['incoming', 'Đang về'], ['reserved', 'Đã giữ'], ['sold', 'Đã bán'], ['all', 'Tất cả'],
]
const AVAIL: UnitStatusDb[] = ['in_stock', 'incoming', 'reserved']
const isStatus = (s: string | null): s is StatusFilter => STATUS_TABS.some(([k]) => k === s)
const isSort = (s: string | null): s is UnitSort => UNIT_SORTS.some(([k]) => k === s)
const isCond = (s: string | null): s is UnitConditionDb => CONDITION_ORDER.includes(s as UnitConditionDb)
const matchStatus = (u: UnitViewRow, f: StatusFilter) => f === 'all' || (f === 'avail' ? AVAIL.includes(u.status) : u.status === f)
/** Vốn trong kho = giá nhập chiếc đã về kho chưa bán (Trong kho + Đã giữ đã về) - như v_model_stock.stock_value_vnd. */
const onHand = (u: UnitViewRow) => u.is_received && (u.status === 'in_stock' || u.status === 'reserved')

// SC_02 Kho (CR-001 + CR-004) - danh sách TỪNG CHIẾC cối. Máy tính: bảng · điện thoại: dòng 2 dòng (research §2.4).
// Thanh lọc chuẩn (KHO-M2): ô tìm + 1 hàng chip trạng thái có đếm + nút "Lọc" (model, tình trạng, sắp xếp).
// URL: ?model= · ?tt= (mặc định "Còn hàng") · ?sx= (KHO-M3, mặc định "ma") · ?tinhtrang= (KHO-S3).
export default function Kho() {
  const d = useData()
  const desk = useDesk()
  const [params, setParams] = useSearchParams()
  const modelF = params.get('model') ?? 'all'
  const ttRaw = params.get('tt'), sxRaw = params.get('sx'), condRaw = params.get('tinhtrang')
  const statusF: StatusFilter = isStatus(ttRaw) ? ttRaw : 'avail'
  const sx: UnitSort = isSort(sxRaw) ? sxRaw : 'ma'
  const condF: UnitConditionDb | null = isCond(condRaw) ? condRaw : null
  const [q, setQ] = useState('')
  const [sheet, setSheet] = useState(false)
  const closeSheet = useCallback(() => setSheet(false), [])
  const th = thresholds(d)

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
  // KHO-M4: dải tóm tắt theo bộ lọc hiện tại
  const sellable = units.filter((u) => u.status === 'in_stock' || u.status === 'incoming').length
  const capital = units.filter(onHand).reduce((a, u) => a + u.cost_vnd, 0)
  const ms = modelF !== 'all' ? stock.find((m) => m.model_id === modelF) : undefined
  const lowModels = stock.filter((m) => m.is_active && (m.is_low_stock || m.sellable_count <= 0))
  const filtering = modelF !== 'all' || condF != null || sx !== 'ma'

  const filters = (
    <div className="ov-filter">
      <input className="input" id="kho-q" type="search" placeholder="Tìm mã, seri, model, ghi chú (VD: zp6 1)" aria-label="Tìm chiếc theo mã, số seri, model hoặc ghi chú"
        value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: desk ? 420 : undefined }} />
      <div className="line">
        <div className="chips" role="group" aria-label="Lọc theo trạng thái">
          {modelF !== 'all' && (
            <button className="chip x" id="kho-model-x" onClick={() => setParam('model', null)} aria-label={`Bỏ lọc model ${modelName ?? ''}`}>{modelName ?? 'Model'} ✕</button>
          )}
          {condF && <button className="chip x" id="kho-cond-x" onClick={() => setParam('tinhtrang', null)} aria-label="Bỏ lọc tình trạng">{CONDITION_LABEL[condF]} ✕</button>}
          {STATUS_TABS.map(([k, t]) => (
            <button key={k} className="chip" id={`kho-tt-${k}`} aria-pressed={statusF === k} onClick={() => setParam('tt', k, 'avail')}>
              {t} <span className="c">{count(k)}</span>
            </button>
          ))}
        </div>
        <button className="btn btn-ghost btn-sm fbtn" id="kho-filter" onClick={() => setSheet(true)} aria-haspopup="dialog">
          Lọc{filtering && <span className="dot" aria-label="đang lọc" />}
        </button>
      </div>
      {ms ? (
        <p className="ov-strip"><b>{ms.code_prefix}</b> · {ms.in_stock_count} trong kho · {ms.incoming_count} đang về · {ms.reserved_count} đã giữ
          {ms.sellable_count <= 0 ? <> · <span className="neg">Hết hàng</span></> : ms.is_low_stock ? <> · <span className="age-warn">Sắp hết</span></> : null}</p>
      ) : (
        <p className="ov-strip"><b>{units.length} chiếc</b> · bán được {sellable} · vốn {tr(capital)}</p>
      )}
      {modelF === 'all' && lowModels.length > 0 && (
        <Link className="ov-banner" to="/lo/new" id="kho-low">
          <Icon name="warn" size={16} /><span>Cần nhập thêm: {lowModels.map((m) => `${m.code_prefix}${m.sellable_count <= 0 ? ' (hết)' : ''}`).join(', ')}</span><Icon name="chev" size={16} />
        </Link>
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
                <td><UnitChip s={u.status} holder={holderCode(d, u)} /></td>
                <td><ConditionChip c={u.condition ?? 'new'} /></td>
                <td className="r">{cny(Number(u.price_cny))}</td>
                <td className="r"><CostCell u={u} /></td>
                <td className="r">{vnd(unitPrice(u))}{u.status === 'sold' && <div className="muted small">giá chốt</div>}</td>
                <td className={`r ${p.value != null && p.value < 0 ? 'req' : ''}`}>{p.value == null ? '-' : vnd(p.value)}<div className="muted small">{p.value == null ? '' : p.actual ? 'thực tế' : 'dự kiến'}</div></td>
                <td className={`r ${agingCls(u.aging_level)}`}>{u.days_in_stock ?? (ordered != null ? <span className="muted">đặt {ordered}</span> : '-')}</td>
              </GoRow>
            )
          })}
          <tr className="tot">
            <td colSpan={5}>{units.length} chiếc · bán được {sellable}</td>
            <td colSpan={5} className="muted" style={{ textAlign: 'right' }}>Vốn trong kho (đã về, chưa bán) {vnd(capital)}</td>
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
      {units.length > 0 && (
        <HowTo title="Màu số ngày tồn">
          Số ngày tồn tính từ ngày nhận lô: tới {th.warn} ngày màu thường, {th.warn + 1}–{th.alert} ngày <span className="age-warn">cam</span>, trên {th.alert} ngày <span className="age-alert">đỏ</span> (đổi ngưỡng ở Cài đặt).
          Chiếc đang về hiện “đặt N ngày”. Giá bên phải: giá bán dự kiến (chiếc đã bán: giá chốt, dòng dưới là lãi). Giá nhập sửa tay / tạm tính xem ở chi tiết chiếc.
        </HowTo>
      )}
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
                {m.model_name} <span className="c">{m.in_stock_count + m.incoming_count + m.reserved_count}</span>
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
