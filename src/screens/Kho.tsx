import { Fragment, useCallback, useState, type KeyboardEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useData } from '../data/store.tsx'
import type { DbData, LotRow, UnitConditionDb, UnitViewRow } from '../data/types.ts'
import { Shell } from '../ui/Shell.tsx'
import { Sheet } from '../ui/feedback.tsx'
import { Icon } from '../ui/icons.tsx'
import { CONDITION_LABEL, CONDITION_ORDER } from '../ui/status.tsx'
import { tr } from '../ui/format.ts'
import {
  Profit, UNIT_SORTS, UnitChipShort, UnitRow, agingCls, holderCode, sortUnits, sortedModelStock, unitMatch, unitPrice, useDesk, type UnitSort,
} from './overview/common.tsx'
import { LotCard, LotRow2, byNewest, sellerOf, summaryOf, unitsOfLot } from './lots/common.tsx'
import { useLotFlow } from './lots/LotFlow.tsx'
import '../styles/lots.css'

// SC_03 Kho (CR-006): gộp Lô nhập vào Kho - 1 màn theo trạng thái như bảng lô cũ.
// Kho TQ / Kho VN = các LÔ đang về (nút bước kế); Kho Lumi / Đang giao khách / Đã bán = từng CHIẾC.
// Máy tính: bảng 5 cột. Điện thoại: chip trạng thái + danh sách. Số đếm = số thẻ trong cột (lô ở Kho TQ / VN, chiếc ở các cột sau).
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
  if (u.status === 'in_stock' || u.status === 'reserved') return u.is_received ? 'lumi' : null
  if (u.status === 'sold') return u.holding_order_status === 'shipped' ? 'giao' : 'ban'
  return null
}

/** Chuỗi tìm của lô (chữ thường): mã lô, model, mã chiếc, seri, người bán, tiêu đề tin, ghi chú. */
function lotHay(d: DbData, l: LotRow): string {
  const units = unitsOfLot(d, l.id)
  return [
    d.lotCode[l.id], sellerOf(d, l)?.nickname, l.listing_title, l.goofish_item_id, l.note,
    ...(summaryOf(d, l.id)?.models ?? []).map((m) => m.model_name), ...units.map((u) => `${u.code} ${u.code_prefix} ${u.serial_no ?? ''}`),
  ].filter(Boolean).join(' ').toLowerCase()
}

/** Thẻ chiếc trong bảng cột (cùng kiểu thẻ lô). */
function UnitCard({ d, u }: { d: DbData; u: UnitViewRow }) {
  const nav = useNavigate()
  const go = () => nav(`/kho/${u.unit_id}`)
  const key = (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go() } }
  const price = unitPrice(u)
  return (
    <div className="kcard" role="button" tabIndex={0} onClick={go} onKeyDown={key}>
      <span className="t">{u.code} · {u.model_name}</span>
      <span className="row-wrap">
        {(u.status !== 'in_stock' || u.condition !== 'new') && <UnitChipShort u={u} holder={holderCode(d, u)} />}
        {u.condition && u.condition !== 'new' && <span className={`pill ${u.condition === 'defect' ? 'bad' : 'neu'}`}>{CONDITION_LABEL[u.condition]}</span>}
        {u.status !== 'sold' && u.days_in_stock != null && <span className={`small ${agingCls(u.aging_level)}`}>{u.days_in_stock} ngày</span>}
      </span>
      <span className="m">
        <span>{price != null ? tr(price) : '-'}</span>
        {u.status === 'sold' ? <Profit n={u.actual_profit_vnd} prefix="lãi " /> : <span className="muted">nhập {tr(u.cost_vnd)}</span>}
      </span>
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

  // Lô đang về (Kho TQ / Kho VN): lọc theo tìm + model (lô có chiếc của model)
  const lots = d.lots.filter((l) => (l.status === 'cn_warehouse' || l.status === 'vn_warehouse')
    && (!needle || lotHay(d, l).includes(needle))
    && (modelF === 'all' || (summaryOf(d, l.id)?.models ?? []).some((m) => m.model_id === modelF))).sort(byNewest)
  const lotsAt = (st: 'cn_warehouse' | 'vn_warehouse') => lots.filter((l) => l.status === st)

  // Chiếc (Kho Lumi / Đang giao / Đã bán)
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
    return st === 'lumi' ? sortUnits(d, us, sx) : us.sort((a, b) => (b.sold_at ?? '').localeCompare(a.sold_at ?? ''))
  }

  const cols: Record<Stage, { n: number; lots?: LotRow[]; units?: UnitViewRow[] }> = {
    tq: { n: lotsAt('cn_warehouse').length, lots: lotsAt('cn_warehouse') },
    vn: { n: lotsAt('vn_warehouse').length, lots: lotsAt('vn_warehouse') },
    lumi: { n: 0, units: unitsAt('lumi') }, giao: { n: 0, units: unitsAt('giao') }, ban: { n: 0, units: unitsAt('ban') },
  }
  for (const k of ['lumi', 'giao', 'ban'] as const) cols[k].n = cols[k].units!.length
  // Điện thoại: cột đang chọn - mặc định Kho Lumi, trống thì cột đầu có hàng
  const stage: Stage = isStage(ttRaw) ? ttRaw : (ttRaw && ALIAS[ttRaw]) || (cols.lumi.n ? 'lumi' : STAGES.find(([k]) => cols[k].n)?.[0] ?? 'lumi')
  const filtering = modelF !== 'all' || condF != null || sx !== 'ma'

  const top = (
    <div className="ov-filter">
      <div className="line">
        <input className="input" id="kho-q" type="search" placeholder="Tìm mã, seri, model, lô, người bán" aria-label="Tìm chiếc hoặc lô"
          value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 0, maxWidth: desk ? 420 : undefined }} />
        <button className="btn btn-ghost btn-sm fbtn" id="kho-filter" onClick={() => setSheet(true)} aria-haspopup="dialog">
          Lọc{filtering && <span className="dot" aria-label="đang lọc" />}
        </button>
      </div>
      {!desk && (
        <div className="chips stage-chips" role="group" aria-label="Lọc theo trạng thái">
          {STAGES.map(([k, t]) => (
            <button key={k} type="button" className="chip" id={`kho-tt-${k}`} aria-pressed={stage === k} onClick={() => setParam('tt', k)}>
              {t}<span className="c">{cols[k].n}</span>
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
    ? <div className="empty">Chưa có hàng - bấm <Link to="/lo/new">Nhập lô Goofish</Link> để thêm lô đầu tiên.</div>
    : null

  let body
  if (empty) body = empty
  else if (desk) {
    body = (
      <div className="board" style={{ ['--cols' as string]: STAGES.length }}>
        {STAGES.map(([k, t, cc]) => {
          const c = cols[k]
          const us = k === 'ban' && !allSold ? c.units!.slice(0, SOLD_PAGE) : c.units
          return (
            <div key={k} className="bcol" style={{ ['--cc' as string]: cc }}>
              <h4>{t}<span className="c">{c.n}</span></h4>
              {c.lots?.map((l) => <LotCard key={l.id} d={d} l={l} withActs busy={flow.busy === l.id} onNext={flow.next} />)}
              {us?.map((u) => <UnitCard key={u.unit_id} d={d} u={u} />)}
              {k === 'ban' && !allSold && c.n > SOLD_PAGE && <button className="link-btn small" onClick={() => setAllSold(true)}>Xem thêm {c.n - SOLD_PAGE} chiếc</button>}
              {c.n === 0 && <div className="bghost">Trống</div>}
            </div>
          )
        })}
      </div>
    )
  } else {
    const c = cols[stage]
    if (c.lots) {
      body = c.lots.length
        ? <div className="ulist">{c.lots.map((l) => <LotRow2 key={l.id} d={d} l={l} busy={flow.busy === l.id} onNext={flow.next} />)}</div>
        : <div className="empty">{needle || modelF !== 'all' ? 'Không có lô khớp bộ lọc.' : `Không có lô nào ở ${STAGES.find(([k]) => k === stage)![1]}.`}</div>
    } else {
      const us = c.units!
      body = us.length ? (
        <div className="ov-list">
          {us.map((u, i) => {
            const head = stage === 'lumi' && sx === 'ma' && (i === 0 || us[i - 1].model_id !== u.model_id)
            const m = hit.get(u.unit_id)
            return (
              <Fragment key={u.unit_id}>
                {head && <div className="ov-gh"><span>{u.model_name}</span><span className="muted">{us.filter((x) => x.model_id === u.model_id).length} chiếc</span></div>}
                <UnitRow d={d} u={u} sub={m === 'serial' && q.trim() ? <>seri {u.serial_no}</> : undefined} />
              </Fragment>
            )
          })}
        </div>
      ) : <div className="empty">{needle || filtering ? 'Không có chiếc nào khớp bộ lọc.' : `Không có chiếc nào ở ${STAGES.find(([k]) => k === stage)![1]}.`}</div>
    }
  }

  return (
    <Shell section="kho" title="Kho" actions={<>
      <Link className="btn btn-ghost btn-sm only-desk" to="/danhmuc">Model</Link>
      <Link className="btn btn-primary btn-sm only-desk" to="/lo/new"><Icon name="plus" /> Nhập lô</Link>
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
