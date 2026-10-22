// SC_07 Đơn bán — "Danh sách" (bảng trên máy tính, dòng trên điện thoại) hoặc "Theo trạng thái" (cột).
// Trạng thái xem / lọc giữ trên URL (?v=board, ?f=due|all, ?khach=<id>) để quay lại không mất.
import { useMemo } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useData } from '../data/store.tsx'
import type { OrderStatusDb, OrderSummaryRow } from '../data/types.ts'
import { Icon } from '../ui/icons.tsx'
import { Shell } from '../ui/Shell.tsx'
import { ORDER_LABEL, OrderChip } from '../ui/status.tsx'
import { dmy, tr, vnd } from '../ui/format.ts'
import { makeLookup, OPEN_STATUSES, sortOrders, useIsDesk, type Lookup } from './orders/common.ts'

const FLOW: [OrderStatusDb, string][] = [['preorder', 'var(--way)'], ['confirmed', 'var(--hold)'], ['shipped', 'var(--faint)'], ['completed', 'var(--ok)']]
const FILTERS: [string, string][] = [['open', 'Đang xử lý'], ['due', 'Còn nợ'], ['all', 'Tất cả']]

/** Chip tiền phụ: còn nợ (đỏ) hoặc cần hoàn khách khi đơn huỷ đã thu tiền (Q-009). */
function MoneyPill({ s, long }: { s: OrderSummaryRow; long?: boolean }) {
  if (s.refund_due_vnd > 0) return <span className="pill bad">cần hoàn {tr(s.refund_due_vnd)}</span>
  if (s.receivable_vnd > 0) return <span className="pill bad">{long ? 'còn thu' : 'còn'} {tr(s.receivable_vnd)}</span>
  return null
}

function OrderRowItem({ s, lk, code }: { s: OrderSummaryRow; lk: Lookup; code: string }) {
  return (
    <Link className="shot" to={`/don/${s.order_id}`}>
      <span className="t">{code} · {dmy(s.order_date)} · {s.customer_name}</span>
      <span className="b">{lk.linesText(s.order_id)}</span>
      <span className="r"><OrderChip s={s.status} /><MoneyPill s={s} /></span>
      <span className="f num">{vnd(lk.total(s))}</span>
    </Link>
  )
}

function OrderCard({ s, lk, code }: { s: OrderSummaryRow; lk: Lookup; code: string }) {
  return (
    <Link className="kcard" to={`/don/${s.order_id}`}>
      <span className="t">{code} · {s.customer_name}</span>
      <span className="s">{lk.linesText(s.order_id)}</span>
      <span className="m"><span>{dmy(s.order_date)}</span><span>{tr(lk.total(s))}</span></span>
      {s.receivable_vnd > 0
        ? <span className="pill bad">còn thu {tr(s.receivable_vnd)}</span>
        : s.receivable_vnd < 0 ? <span className="pill hold">trả dư {tr(-s.receivable_vnd)}</span> : <span className="pill ok">đã thu đủ</span>}
    </Link>
  )
}

export default function Orders() {
  const d = useData()
  const desk = useIsDesk()
  const nav = useNavigate()
  const [sp, setSp] = useSearchParams()
  const view = sp.get('v') === 'board' ? 'board' : 'list'
  const filter = sp.get('f') === 'due' || sp.get('f') === 'all' ? sp.get('f')! : 'open'
  const khach = sp.get('khach')
  const lk = useMemo(() => makeLookup(d), [d])
  const set = (k: string, v: string | null) => {
    const n = new URLSearchParams(sp)
    if (v == null) n.delete(k); else n.set(k, v)
    setSp(n, { replace: true })
  }

  const base = khach ? d.orderSummary.filter((s) => s.customer_id === khach) : d.orderSummary
  const custName = khach ? lk.cust(khach)?.fb_name ?? '?' : null

  const seg = (
    <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
      <div className="seg">
        <button aria-pressed={view === 'list'} onClick={() => set('v', null)}>Danh sách</button>
        <button aria-pressed={view === 'board'} onClick={() => set('v', 'board')}>Theo trạng thái</button>
      </div>
      {view === 'list' && (
        <div className="seg">
          {FILTERS.map(([k, t]) => <button key={k} aria-pressed={filter === k} onClick={() => set('f', k === 'open' ? null : k)}>{t}</button>)}
        </div>
      )}
    </div>
  )
  const custBar = custName && (
    <div className="note-box way">
      <span>Đơn của khách <b>{custName}</b></span>
      <button className="link-btn" onClick={() => set('khach', null)}>Bỏ lọc</button>
    </div>
  )

  let body
  if (d.orders.length === 0) {
    body = <div className="empty"><b>Chưa có đơn nào</b><br />Bấm <Link to="/don/new">+ Đơn bán</Link> để ghi đơn đầu tiên.</div>
  } else if (view === 'board') {
    body = (
      <div className="board" style={{ ['--cols' as string]: 4 }}>
        {FLOW.map(([k, cc]) => {
          const os = sortOrders(d, base.filter((s) => s.status === k))
          return (
            <div key={k} className="bcol" style={{ ['--cc' as string]: cc }}>
              <h4>{ORDER_LABEL[k]}<span className="c">{os.length}</span></h4>
              {os.length ? os.map((s) => <OrderCard key={s.order_id} s={s} lk={lk} code={d.orderCode[s.order_id]} />) : <div className="bghost">Trống</div>}
            </div>
          )
        })}
      </div>
    )
  } else {
    // "Đang xử lý" gồm cả đơn huỷ còn tiền phải hoàn khách (Q-009) — vẫn còn việc phải làm.
    const os = sortOrders(d, base.filter((s) =>
      filter === 'open' ? OPEN_STATUSES.includes(s.status) || s.refund_due_vnd > 0
        : filter === 'due' ? s.receivable_vnd > 0 : true))
    const empty = filter === 'due' ? 'Không có đơn nào còn nợ.' : filter === 'open' ? 'Không có đơn đang xử lý — xem "Tất cả" hoặc tạo đơn mới.' : 'Không có đơn.'
    if (!os.length) body = <div className="empty">{empty}</div>
    else if (desk) {
      body = (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Đơn</th><th>Ngày</th><th>Khách</th><th>Hàng</th><th>Trạng thái</th><th className="r">Tổng</th><th className="r">Đã thu</th><th className="r">Còn thu</th><th className="r">Lãi</th></tr></thead>
            <tbody>
              {os.map((s) => {
                const p = lk.profit(s.order_id)
                return (
                  <tr key={s.order_id} data-act="go" onClick={() => nav(`/don/${s.order_id}`)}>
                    <td><Link to={`/don/${s.order_id}`} onClick={(e) => e.stopPropagation()} style={{ color: 'inherit' }}>{d.orderCode[s.order_id]}</Link></td>
                    <td>{dmy(s.order_date)}</td>
                    <td>{s.customer_name}</td>
                    <td>{lk.linesText(s.order_id)}</td>
                    <td><OrderChip s={s.status} /></td>
                    <td className="r">{vnd(lk.total(s))}</td>
                    <td className="r">{vnd(s.paid_vnd)}</td>
                    <td className="r">
                      {s.refund_due_vnd > 0 ? <span className="req">Cần hoàn {vnd(s.refund_due_vnd)}</span>
                        : s.receivable_vnd > 0 ? <span className="req">{vnd(s.receivable_vnd)}</span>
                          : s.receivable_vnd < 0 ? <span className="muted">trả dư {vnd(-s.receivable_vnd)}</span> : '—'}
                    </td>
                    <td className="r">{p.value == null ? '—' : p.est ? <span className="muted">~{vnd(p.value)}</span> : vnd(p.value)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )
    } else {
      body = <div className="stack">{os.map((s) => <OrderRowItem key={s.order_id} s={s} lk={lk} code={d.orderCode[s.order_id]} />)}</div>
    }
  }

  return (
    <Shell section="don" title="Đơn bán"
      actions={<Link className="btn btn-primary btn-sm" to={khach ? `/don/new?khach=${khach}` : '/don/new'}><Icon name="plus" /><span className="only-desk">Đơn bán</span></Link>}>
      {seg}
      {custBar}
      {body}
    </Shell>
  )
}
