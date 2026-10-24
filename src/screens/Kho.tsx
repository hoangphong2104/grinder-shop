import { Fragment, useCallback, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useData } from '../data/store.tsx'
import type { DbData, UnitConditionDb, UnitViewRow } from '../data/types.ts'
import { Shell } from '../ui/Shell.tsx'
import { Sheet } from '../ui/feedback.tsx'
import { Icon } from '../ui/icons.tsx'
import { CONDITION_LABEL, CONDITION_ORDER } from '../ui/status.tsx'
import { tr } from '../ui/format.ts'
import {
  Profit, UNIT_SORTS, UnitChipShort, UnitRow, agingCls, daysSince, holderCode, sortUnits, sortedModelStock, unitMatch, unitPrice, useDesk, type UnitSort,
} from './overview/common.tsx'
import { LOT_SHORT, nextStatus } from './lots/common.tsx'
import { useLotFlow } from './lots/LotFlow.tsx'
import '../styles/lots.css'

// SC_03 Kho (CR-006): gộp Lô nhập vào Kho - 1 màn theo trạng thái như bảng lô cũ.
// CR-006 vòng 3: 1 lô = 1 cối ⇒ mọi cột đều là từng CỐI; ở Kho TQ / Kho VN có nút bước kế (chuyển cả lô của cối).
// Máy tính: bảng 5 cột. Điện thoại: chip trạng thái + danh sách. Số đếm = số cối trong cột.
type Stage = 'tq' | 'vn' | 'lumi' | 'giao' | 'ban'
const STAGES: [Stage, string, string][] = [
  ['tq', 'Kho TQ', 'var(--way)'], ['vn', 'Kho VN', 'var(--hold)'], ['lumi', 'Kho Lumi', 'var(--ok)'],
  ['giao', 'Đang giao khách', 'var(--way)'], ['ban', 'Đã bán', 'var(--line)'],
]
/** Link cũ (?tt=…) → cột mới. */
const ALIAS: Record<string, Stage> = { in_stock: 'lumi', avail: 'lumi', giu: 'lumi', reserved: 'lumi', incoming: 'tq', ve: 'tq', sold: 'ban', xong: 'ban' }
const isStage = (s: string | null): s is Stage => STAGES.some(([k]) => k === s)
const isSort = (s: string | null): s is UnitSort => UNIT_SORTS.some(([k]) => k === s)
const isCond = (s: string | null): s is UnitConditionDb => CONDITION_ORDER.includes(s as UnitConditionDb)
const SOLD_PAGE = 20

function unitStage(u: UnitViewRow): Stage | null {
  if (u.status === 'incoming' || ((u.status === 'in_stock' || u.status === 'reserved') && !u.is_received)) return u.lot_status === 'vn_warehouse' ? 'vn' : u.lot_status === 'cn_warehouse' ? 'tq' : null
  if (u.status === 'in_stock' || u.status === 'reserved') return 'lumi'
  if (u.status === 'sold') return u.holding_order_status === 'shipped' ? 'giao' : 'ban'
  return null
}

/** Thẻ chiếc trong bảng cột (cùng kiểu thẻ lô). */
function UnitCard({ d, u, next }: { d: DbData; u: UnitViewRow; next?: ReactNode }) {
  const nav = useNavigate()
  const go = () => nav(`/kho/${u.unit_id}`)
  const key = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go() } }
  const price = unitPrice(u)
  return (
    <div className="kcard" role="button" tabIndex={0} onClick={go} onKeyDown={key}>
      <span className="t">{u.code} · {u.model_name}</span>
      <span className="row-wrap">
        {(u.status === 'reserved' || u.status === 'sold') && <UnitChipShort u={u} holder={holderCode(d, u)} />}
        {u.condition && u.condition !== 'new' && <span className={`pill ${u.condition === 'defect' ? 'bad' : 'neu'}`}>{CONDITION_LABEL[u.condition]}</span>}
        {u.status !== 'sold' && u.days_in_stock != null && <span className={`small ${agingCls(u.aging_level)}`}>{u.days_in_stock} ngày</span>}
        {!u.is_received && u.status !== 'cancelled' && <span className="small muted">đặt {daysSince(u.ordered_at) ?? 0} ngày</span>}
      </span>
      <span className="m">
        <span>{price != null ? tr(price) : '-'}</span>
        {u.status === 'sold' ? <Profit n={u.actual_profit_vnd} prefix="lãi " /> : <span className="muted">nhập {tr(u.cost_vnd)}</span>}
      </span>
      {next && <div className="acts">{next}</div>}
    </div>
  )
}

export default function Kho() {
  const d = useData()
  const desk = useDesk()
  const flow = useLotFlow()
  const [params, setParams] = useSearchParams()
  const modelF = params.get('model') ?? 'all'
  const ttRaw = params.get('tt'), sxRaw = params.get('sx'), condRaw = params.get('tinhtrang')
  const sx: UnitSort = isSort(sxRaw) ? sxRaw : 'ma'
  const condF: UnitConditionDb | null = isCond(condRaw) ? condRaw : null
  const [q, setQ] = useState('')
  const [sheet, setSheet] = useState(false)
  const [allSold, setAllSold] = useState(false)
  const closeSheet = useCallback(() => setSheet(false), [])

  const setParam = (k: string, v: string | null) => {
    const p = new URLSearchParams(params)
    if (v == null) p.delete(k); else p.set(k, v)
    p.delete('xem')
    setParams(p, { replace: true })
  }

  const stock = sortedModelStock(d)
  const modelName = d.models.find((m) => m.id === modelF)?.code_prefix ?? d.models.find((m) => m.id === modelF)?.name
  const needle = q.trim().toLowerCase()

  // Cối theo cột
  const hit = new Map<string, ReturnType<typeof unitMatch>>()
  const units = d.unitView.filter((u) => {
    if (!unitStage(u)) return false
    if (modelF !== 'all' && u.model_id !== modelF) return false
    if (condF && u.condition !== condF) return false
    const m = unitMatch(u, q)
    if (!m) return false
    hit.set(u.unit_id, m)
    return true
  })
  const unitsAt = (st: Stage) => {
    const us = units.filter((u) => unitStage(u) === st)
    return st === 'giao' || st === 'ban' ? us.sort((a, b) => (b.sold_at ?? '').localeCompare(a.sold_at ?? '')) : sortUnits(d, us, sx)
  }

  const cols = Object.fromEntries(STAGES.map(([k]) => [k, unitsAt(k)])) as Record<Stage, UnitViewRow[]>
  // Nút bước kế (Kho TQ → Kho VN → Nhận hàng) - chuyển lô của cối
  const nextBtn = (u: UnitViewRow, cls: string) => {
    const l = d.lots.find((x) => x.id === u.lot_id)
    const n = l ? nextStatus(l.status) : null
    if (!l || !n) return undefined
    return (
      <button type="button" className={cls} disabled={flow.busy === l.id} onClick={(e) => { e.preventDefault(); e.stopPropagation(); flow.next(l) }}>
        {n === 'received' ? 'Nhận hàng' : `→ ${LOT_SHORT[n]}`}
      </button>
    )
  }
  // Điện thoại: cột đang chọn - mặc định Kho Lumi, trống thì cột đầu có hàng
  const stage: Stage = isStage(ttRaw) ? ttRaw : (ttRaw && ALIAS[ttRaw]) || (cols.lumi.length ? 'lumi' : STAGES.find(([k]) => cols[k].length)?.[0] ?? 'lumi')
  const filtering = modelF !== 'all' || condF != null || sx !== 'ma'

  const top = (
    <div className="ov-filter">
      <div className="line">
        <input className="input" id="kho-q" type="search" placeholder="Tìm mã, seri, model, ghi chú" aria-label="Tìm cối"
          value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 0, maxWidth: desk ? 420 : undefined }} />
        <button className="btn btn-ghost btn-sm fbtn" id="kho-filter" onClick={() => setSheet(true)} aria-haspopup="dialog">
          Lọc{filtering && <span className="dot" aria-label="đang lọc" />}
        </button>
      </div>
      {!desk && (
        <div className="chips stage-chips" role="group" aria-label="Lọc theo trạng thái">
          {STAGES.map(([k, t]) => (
            <button key={k} type="button" className="chip" id={`kho-tt-${k}`} aria-pressed={stage === k} onClick={() => setParam('tt', k)}>
              {t}<span className="c">{cols[k].length}</span>
            </button>
          ))}
        </div>
      )}
      {(modelF !== 'all' || condF) && (
        <div className="chips" role="group" aria-label="Đang lọc">
          {modelF !== 'all' && <button className="chip x" id="kho-model-x" onClick={() => setParam('model', null)} aria-label={`Bỏ lọc model ${modelName ?? ''}`}>{modelName ?? 'Model'} ✕</button>}
          {condF && <button className="chip x" id="kho-cond-x" onClick={() => setParam('tinhtrang', null)} aria-label="Bỏ lọc tình trạng">{CONDITION_LABEL[condF]} ✕</button>}
        </div>
      )}
    </div>
  )

  const empty = d.unitView.length === 0
    ? <div className="empty">Chưa có hàng - bấm <Link to="/lo/new">Nhập cối</Link> để thêm cối đầu tiên.</div>
    : null

  let body
  if (empty) body = empty
  else if (desk) {
    body = (
      <div className="board" style={{ ['--cols' as string]: STAGES.length }}>
        {STAGES.map(([k, t, cc]) => {
          const all = cols[k]
          const us = k === 'ban' && !allSold ? all.slice(0, SOLD_PAGE) : all
          return (
            <div key={k} className="bcol" style={{ ['--cc' as string]: cc }}>
              <h4>{t}<span className="c">{all.length}</span></h4>
              {us.map((u) => <UnitCard key={u.unit_id} d={d} u={u} next={k === 'tq' || k === 'vn' ? nextBtn(u, 'btn btn-primary btn-sm') : undefined} />)}
              {k === 'ban' && !allSold && all.length > SOLD_PAGE && <button className="link-btn small" onClick={() => setAllSold(true)}>Xem thêm {all.length - SOLD_PAGE} cối</button>}
              {all.length === 0 && <div className="bghost">Trống</div>}
            </div>
          )
        })}
      </div>
    )
  } else {
    const us = cols[stage]
    body = us.length ? (
      <div className="ov-list">
        {us.map((u, i) => {
          const head = stage === 'lumi' && sx === 'ma' && (i === 0 || us[i - 1].model_id !== u.model_id)
          const m = hit.get(u.unit_id)
          return (
            <Fragment key={u.unit_id}>
              {head && <div className="ov-gh"><span>{u.model_name}</span><span className="muted">{us.filter((x) => x.model_id === u.model_id).length} cối</span></div>}
              <UnitRow d={d} u={u} sub={m === 'serial' && q.trim() ? <>seri {u.serial_no}</> : undefined}
                right2={stage === 'tq' || stage === 'vn' ? nextBtn(u, 'btn btn-ghost nx') : undefined} />
            </Fragment>
          )
        })}
      </div>
    ) : <div className="empty">{needle || filtering ? 'Không có cối nào khớp bộ lọc.' : `Không có cối nào ở ${STAGES.find(([k]) => k === stage)![1]}.`}</div>
  }

  return (
    <Shell section="kho" title="Kho" actions={<>
      <Link className="btn btn-ghost btn-sm only-desk" to="/danhmuc">Model</Link>
      <Link className="btn btn-primary btn-sm only-desk" to="/lo/new"><Icon name="plus" /> Nhập cối</Link>
    </>}>
      {top}
      {body}
      {flow.sheets}
      {sheet && (
        <Sheet title="Lọc & sắp xếp" onClose={closeSheet}>
          <p className="ov-sheet-t">Sắp xếp chiếc ở Kho Lumi</p>
          <div className="ov-opts" role="radiogroup" aria-label="Sắp xếp">
            {UNIT_SORTS.map(([k, t]) => (
              <button key={k} className="chip" role="radio" id={`kho-sx-${k}`} aria-checked={sx === k} aria-pressed={sx === k} onClick={() => setParam('sx', k === 'ma' ? null : k)}>{t}</button>
            ))}
          </div>
          <p className="ov-sheet-t">Model</p>
          <div className="ov-opts" role="group" aria-label="Lọc theo model">
            <button className="chip" id="kho-m-all" aria-pressed={modelF === 'all'} onClick={() => setParam('model', null)}>Tất cả</button>
            {stock.map((m) => (
              <button key={m.model_id} className="chip" id={`kho-m-${m.code_prefix}`} aria-pressed={modelF === m.model_id} onClick={() => setParam('model', m.model_id)}>{m.model_name}</button>
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
