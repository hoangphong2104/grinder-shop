// SC_04 Lô nhập — "Theo trạng thái" (bảng 5 cột trên máy tính / chip bước + thẻ trên điện thoại) hoặc "Danh sách".
// v0.2 (CR-001): thẻ / dòng hiện tóm tắt model của lô ("2 × KU, 1 × JU") + đếm chiếc theo trạng thái (v_lot_summary).
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useData } from '../data/store.tsx'
import type { LotStatusDb } from '../data/types.ts'
import { Shell } from '../ui/Shell.tsx'
import { Icon } from '../ui/icons.tsx'
import { LOT_FLOW, LOT_LABEL, LotChip } from '../ui/status.tsx'
import { dmy, vnd } from '../ui/format.ts'
import { byNewest, LotCard, LotRowItem, modelsText, sellerOf, summaryOf, UnitCounts, useIsDesk } from './lots/common.tsx'
import { useLotFlow } from './lots/LotFlow.tsx'

type View = 'board' | 'list'
type Filter = 'open' | 'done' | 'all'
const CC: Record<string, string> = { ordered: 'var(--faint)', cn_shipping: 'var(--way)', at_forwarder: 'var(--way)', vn_shipping: 'var(--hold)', received: 'var(--ok)' }
// Nhớ lựa chọn khi quay lại màn (như prototype).
const memo: { view: View; filter: Filter; stage: LotStatusDb | null } = { view: 'board', filter: 'open', stage: null }

export default function Lots() {
  const d = useData()
  const nav = useNavigate()
  const desk = useIsDesk()
  const flow = useLotFlow()
  const [view, setView] = useState<View>(memo.view)
  const [filter, setFilter] = useState<Filter>(memo.filter)
  const [stage, setStage] = useState<LotStatusDb | null>(memo.stage)
  const pickView = (v: View) => { memo.view = v; setView(v) }
  const pickFilter = (f: Filter) => { memo.filter = f; setFilter(f) }
  const pickStage = (s: LotStatusDb) => { memo.stage = s; setStage(s) }

  const live = d.lots.filter((l) => l.status !== 'cancelled').sort(byNewest)
  const card = (l: (typeof live)[number]) => (
    <LotCard key={l.id} d={d} l={l} withActs={l.status !== 'received'} busy={flow.busy === l.id} onShipFee={flow.shipFee} onNext={flow.next} />
  )

  const seg = (
    <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
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

  let body
  if (!d.lots.length) {
    body = <div className="empty">Chưa có lô nào — bấm <Link className="link-btn" to="/lo/new">Nhập lô Goofish</Link> để thêm lô đầu tiên.</div>
  } else if (view === 'board') {
    if (desk) {
      body = (
        <div className="board" style={{ ['--cols' as string]: 5 }}>
          {LOT_FLOW.map((k) => {
            const ls = live.filter((l) => l.status === k)
            return (
              <div key={k} className="bcol" style={{ ['--cc' as string]: CC[k] }}>
                <h4>{LOT_LABEL[k]}<span className="c">{ls.length}</span></h4>
                {ls.length ? ls.map(card) : <div className="bghost">Trống</div>}
              </div>
            )
          })}
        </div>
      )
    } else {
      const cur = stage ?? LOT_FLOW.find((k) => k !== 'received' && live.some((l) => l.status === k)) ?? 'received'
      const ls = live.filter((l) => l.status === cur)
      body = (
        <>
          <div className="chips stage-chips">
            {LOT_FLOW.map((k) => (
              <button key={k} className="chip" aria-pressed={cur === k} onClick={() => pickStage(k)}>
                {LOT_LABEL[k]}<span className="c">{live.filter((l) => l.status === k).length}</span>
              </button>
            ))}
          </div>
          <div className="stack">{ls.length ? ls.map(card) : <div className="bghost">Không có lô ở bước này</div>}</div>
        </>
      )
    }
  } else {
    const ls = d.lots
      .filter((l) => (filter === 'open' ? l.status !== 'received' && l.status !== 'cancelled' : filter === 'done' ? l.status === 'received' : true))
      .sort(byNewest)
    const emptyMsg = filter === 'open' ? 'Không có lô đang về' : filter === 'done' ? 'Chưa có lô đã nhận' : 'Không có lô'
    body = !ls.length ? <div className="empty">{emptyMsg}</div> : desk ? (
      <div className="tbl-wrap">
        <table className="tbl">
          <thead><tr><th>Lô</th><th>Ngày đặt</th><th>Hàng</th><th>Người bán</th><th>Trạng thái</th><th>Chiếc</th><th className="r">Tiền hàng</th><th className="r">Ship về VN</th><th className="r">Ship / chiếc</th><th className="r">Phải trả TG</th></tr></thead>
          <tbody>
            {ls.map((l) => {
              const s = sellerOf(d, l), sum = summaryOf(d, l.id)
              return (
                <tr key={l.id} data-act="go" tabIndex={0} onClick={() => nav(`/lo/${l.id}`)} onKeyDown={(e) => { if (e.key === 'Enter') nav(`/lo/${l.id}`) }}>
                  <td>{d.lotCode[l.id]}</td>
                  <td>{dmy(l.ordered_at)}</td>
                  <td>{modelsText(d, sum)}</td>
                  <td>{s?.nickname ?? '—'}{s?.is_avoided && <> <span className="pill bad">tránh</span></>}</td>
                  <td><LotChip s={l.status} /></td>
                  <td><UnitCounts sum={sum} /></td>
                  <td className="r">{vnd(sum?.goods_vnd ?? 0)}</td>
                  <td className="r">{l.ship_fee_vnd == null ? <span className="pill bad">chưa nhập</span> : vnd(l.ship_fee_vnd)}</td>
                  <td className="r">{sum?.ship_per_unit_vnd != null ? vnd(sum.ship_per_unit_vnd) : '—'}</td>
                  <td className="r">{vnd(sum?.payable_vnd ?? 0)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    ) : (
      <div className="stack">{ls.map((l) => <LotRowItem key={l.id} d={d} l={l} />)}</div>
    )
  }

  return (
    <Shell section="lo" title="Lô nhập"
      actions={<Link className="btn btn-primary btn-sm" to="/lo/new" aria-label="Nhập lô Goofish"><Icon name="plus" /><span className="only-desk">Nhập lô Goofish</span></Link>}>
      {seg}
      {body}
      {flow.sheets}
    </Shell>
  )
}
