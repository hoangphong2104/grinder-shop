// SC_04 Lô nhập. CR-004: điện thoại = 1 danh sách + hàng chip bước có đếm (LOT-M2), dòng lô 2 dòng (LOT-M1),
// 1 nút bước kế trên dòng (LOT-M3), "đặt N ngày" + chip "Về trễ" (LOT-S2). Máy tính giữ "Theo trạng thái" (bảng cột)
// / "Danh sách" (bảng). Ô tìm theo mã lô, mã chiếc, seri, model, người bán, tiêu đề tin.
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useData } from '../data/store.tsx'
import type { DbData, LotRow, LotStatusDb } from '../data/types.ts'
import { Shell } from '../ui/Shell.tsx'
import { Icon } from '../ui/icons.tsx'
import { LOT_FLOW, LOT_LABEL, LotChip } from '../ui/status.tsx'
import { dmy, pct, vnd } from '../ui/format.ts'
import { byNewest, daysOpen, isLate, isOpen, LOT_SHORT, LotCard, LotRow2, lotFeePct, modelsText, sellerOf, summaryOf, UnitCounts, unitsOfLot, useIsDesk } from './lots/common.tsx'
import { useLotFlow } from './lots/LotFlow.tsx'
import '../styles/lots.css'

type View = 'board' | 'list'
type Filter = 'open' | 'done' | 'all'
/** Chip bước trên điện thoại: 'open' = mọi bước chưa nhận (mặc định), 1 bước cụ thể, hoặc 'all' (kể cả lô huỷ). */
type Stage = 'open' | LotStatusDb | 'all'
const CC: Record<string, string> = { ordered: 'var(--faint)', cn_shipping: 'var(--way)', at_forwarder: 'var(--way)', vn_shipping: 'var(--hold)', received: 'var(--ok)' }
// Nhớ lựa chọn khi quay lại màn (như prototype).
const memo: { view: View; filter: Filter; stage: Stage; q: string } = { view: 'board', filter: 'open', stage: 'open', q: '' }

/** Chuỗi tìm của lô (chữ thường): mã lô, model + tiền tố, mã chiếc, seri, người bán, tiêu đề tin, mã tin. */
function haystack(d: DbData, l: LotRow): string {
  const sum = summaryOf(d, l.id)
  const units = unitsOfLot(d, l.id)
  return [
    d.lotCode[l.id], sellerOf(d, l)?.nickname, l.listing_title, l.goofish_item_id, l.note,
    ...(sum?.models ?? []).map((m) => m.model_name), ...units.map((u) => `${u.code} ${u.code_prefix} ${u.serial_no ?? ''}`),
  ].filter(Boolean).join(' ').toLowerCase()
}

const matchStage = (st: Stage, l: LotRow) =>
  st === 'all' ? true : st === 'open' ? isOpen(l.status) : l.status === st

export default function Lots() {
  const d = useData()
  const nav = useNavigate()
  const desk = useIsDesk()
  const flow = useLotFlow()
  const [view, setView] = useState<View>(memo.view)
  const [filter, setFilter] = useState<Filter>(memo.filter)
  const [stage, setStage] = useState<Stage>(memo.stage)
  const [q, setQ] = useState(memo.q)
  const pickView = (v: View) => { memo.view = v; setView(v) }
  const pickFilter = (f: Filter) => { memo.filter = f; setFilter(f) }
  const pickStage = (s: Stage) => { memo.stage = s; setStage(s) }
  const typeQ = (v: string) => { memo.q = v; setQ(v) }

  const needle = q.trim().toLowerCase()
  const found = (needle ? d.lots.filter((l) => haystack(d, l).includes(needle)) : d.lots).slice().sort(byNewest)
  const live = found.filter((l) => l.status !== 'cancelled')

  const search = (
    <input className="input" id="lot-q" type="search" value={q} placeholder="Tìm mã lô, mã chiếc, seri, model, người bán…"
      aria-label="Tìm lô" autoComplete="off" onChange={(e) => typeQ(e.target.value)} />
  )

  let body
  if (!d.lots.length) {
    body = <div className="empty">Chưa có lô nào - bấm <Link className="link-btn" to="/lo/new">Nhập lô Goofish</Link> để thêm lô đầu tiên.</div>
  } else if (!desk) {
    // Điện thoại: 1 danh sách + chip bước (LOT-M2)
    const chips: [Stage, string][] = [['open', 'Đang về'], ...LOT_FLOW.map((k): [Stage, string] => [k, LOT_SHORT[k]]), ['all', 'Tất cả']]
    const ls = found.filter((l) => matchStage(stage, l))
    const emptyMsg = needle ? 'Không có lô khớp tìm kiếm ở bước này' : stage === 'open' ? 'Không có lô đang về - lô mới bấm nút + → Nhập lô Goofish'
      : stage === 'received' ? 'Chưa có lô đã nhận' : stage === 'all' ? 'Không có lô' : `Không có lô ở bước ${LOT_LABEL[stage as LotStatusDb]}`
    body = (
      <>
        {search}
        <div className="chips stage-chips" role="group" aria-label="Lọc theo bước">
          {chips.map(([k, t]) => (
            <button key={k} type="button" className="chip" aria-pressed={stage === k} onClick={() => pickStage(k)}>
              {t}<span className="c">{found.filter((l) => matchStage(k, l)).length}</span>
            </button>
          ))}
        </div>
        {ls.length
          ? <div className="ulist">{ls.map((l) => <LotRow2 key={l.id} d={d} l={l} busy={flow.busy === l.id} onNext={flow.next} />)}</div>
          : <div className="empty">{emptyMsg}</div>}
      </>
    )
  } else if (view === 'board') {
    body = (
      <>
        {search}
        <div className="board" style={{ ['--cols' as string]: 5 }}>
          {LOT_FLOW.map((k) => {
            const ls = live.filter((l) => l.status === k)
            return (
              <div key={k} className="bcol" style={{ ['--cc' as string]: CC[k] }}>
                <h4>{LOT_LABEL[k]}<span className="c">{ls.length}</span></h4>
                {ls.length
                  ? ls.map((l) => <LotCard key={l.id} d={d} l={l} withActs={l.status !== 'received'} busy={flow.busy === l.id} onNext={flow.next} />)
                  : <div className="bghost">Trống</div>}
              </div>
            )
          })}
        </div>
      </>
    )
  } else {
    const ls = found.filter((l) => (filter === 'open' ? isOpen(l.status) : filter === 'done' ? l.status === 'received' : true))
    const emptyMsg = needle ? 'Không có lô khớp tìm kiếm' : filter === 'open' ? 'Không có lô đang về' : filter === 'done' ? 'Chưa có lô đã nhận' : 'Không có lô'
    body = (
      <>
        {search}
        {!ls.length ? <div className="empty">{emptyMsg}</div> : (
          <div className="tbl-wrap">
            <table className="tbl">
              <thead><tr><th>Lô</th><th>Ngày đặt</th><th>Hàng</th><th>Người bán</th><th>Trạng thái</th><th>Chiếc</th><th className="r">Tiền hàng</th><th className="r">Phí mua hộ</th><th className="r">Ship về VN</th><th className="r">Ship / chiếc</th><th className="r">Phải trả TG</th></tr></thead>
              <tbody>
                {ls.map((l) => {
                  const s = sellerOf(d, l), sum = summaryOf(d, l.id), days = daysOpen(l)
                  return (
                    <tr key={l.id} data-act="go" tabIndex={0} onClick={() => nav(`/lo/${l.id}`)} onKeyDown={(e) => { if (e.key === 'Enter') nav(`/lo/${l.id}`) }}>
                      <td>{d.lotCode[l.id]}</td>
                      <td>{dmy(l.ordered_at)}{days != null && <span className="muted small"> · {days} ngày</span>}</td>
                      <td>{modelsText(d, sum)}</td>
                      <td>{s?.nickname ?? '-'}{s?.is_avoided && <> <span className="pill bad">tránh</span></>}</td>
                      <td><LotChip s={l.status} />{isLate(d, l) && <> <span className="pill bad">Về trễ</span></>}</td>
                      <td><UnitCounts sum={sum} /></td>
                      <td className="r">{vnd(sum?.goods_vnd ?? 0)}</td>
                      <td className="r">{vnd(sum?.buying_fee_vnd ?? 0)} <span className="muted small">{pct(lotFeePct(l))}</span></td>
                      <td className="r">{l.ship_fee_vnd == null ? <span className="pill bad">chưa nhập</span> : vnd(l.ship_fee_vnd)}</td>
                      <td className="r">{sum?.ship_per_unit_vnd != null ? vnd(sum.ship_per_unit_vnd) : '-'}</td>
                      <td className="r">{vnd(sum?.payable_vnd ?? 0)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </>
    )
  }

  // Máy tính: chọn cách xem (bảng cột / bảng) - điện thoại không có (LOT-M2)
  const seg = desk && d.lots.length > 0 && (
    <div className="row" style={{ justifyContent: 'space-between' }}>
      <div className="seg">
        <button aria-pressed={view === 'board'} onClick={() => pickView('board')}>Theo trạng thái</button>
        <button aria-pressed={view === 'list'} onClick={() => pickView('list')}>Danh sách</button>
      </div>
      {view === 'list' && (
        <div className="seg">
          {([['open', 'Đang về'], ['done', 'Đã nhận'], ['all', 'Tất cả']] as [Filter, string][]).map(([k, t]) => (
            <button key={k} aria-pressed={filter === k} onClick={() => pickFilter(k)}>{t}</button>
          ))}
        </div>
      )}
    </div>
  )

  return (
    <Shell section="lo" title="Lô nhập"
      actions={<Link className="btn btn-primary btn-sm" to="/lo/new" aria-label="Nhập lô Goofish"><Icon name="plus" /><span className="only-desk">Nhập lô Goofish</span></Link>}>
      {seg}
      {body}
      {flow.sheets}
    </Shell>
  )
}
