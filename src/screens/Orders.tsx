// SC_07 Đơn bán — CR-004: ô tìm + 1 hàng chip lọc có đếm (DON-M2), dòng 2 dòng (DON-M1), chip trạng thái đơn và
// thanh toán tách riêng (DON-M4). Máy tính: bảng hoặc "Theo trạng thái" (cột, gồm cột Hoàn hàng).
// Trạng thái xem / lọc giữ trên URL (?v=board, ?f=todo|pre|wait|sent|cod|due|refund|ret|all, ?khach=<id>, ?q=) để quay lại không mất.
import { useMemo } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useData } from '../data/store.tsx'
import type { OrderStatusDb, OrderSummaryRow } from '../data/types.ts'
import { Icon } from '../ui/icons.tsx'
import { Shell } from '../ui/Shell.tsx'
import { ORDER_LABEL, OrderChip } from '../ui/status.tsx'
import { dmy, todayVn, tr, vnd } from '../ui/format.ts'
import { codesText, daysBetween, fold, makeLookup, ORDER_FILTERS, parseOrderFilter, payState, sortOrders, useIsDesk, type Lookup, type OrderFilter } from './orders/common.ts'
import { OrderRow2 } from './orders/OrderRow.tsx'
import '../styles/orders.css'

// Cột "Theo trạng thái" (máy tính): luồng chính + Hoàn hàng ở cuối (đơn Huỷ không có cột — xem chip "Tất cả").
const FLOW: [OrderStatusDb, string][] = [['preorder', 'var(--way)'], ['confirmed', 'var(--hold)'], ['shipped', 'var(--faint)'], ['completed', 'var(--ok)'], ['returned', 'var(--bad)']]

function PayPill({ s }: { s: OrderSummaryRow }) {
  const p = payState(s)
  return p ? <span className={`pill ${p.tone}`}>{p.long}</span> : null
}

function OrderCard({ s, lk, code }: { s: OrderSummaryRow; lk: Lookup; code: string }) {
  return (
    <Link className="kcard" to={`/don/${s.order_id}`}>
      <span className="t">{code} · {s.customer_name}</span>
      <span className="s">{codesText(s.unit_codes, 3)}</span>
      <span className="m"><span>{dmy(s.status === 'returned' ? s.returned_at : s.order_date)}</span><span>{tr(lk.total(s))}</span></span>
      <PayPill s={s} />
    </Link>
  )
}

/** Tuổi đơn cho lọc nợ / COD: "gửi 12 ngày" (đã gửi) hoặc "đặt 5 ngày" (chưa gửi). */
const ageText = (s: OrderSummaryRow, today: string) =>
  s.shipped_at ? `gửi ${daysBetween(s.shipped_at, today)} ngày` : `đặt ${daysBetween(s.order_date, today)} ngày`

export default function Orders() {
  const d = useData()
  const desk = useIsDesk()
  const nav = useNavigate()
  const [sp, setSp] = useSearchParams()
  // Bảng cột chỉ trên máy tính (DON-M2); điện thoại luôn là danh sách.
  const view = desk && sp.get('v') === 'board' ? 'board' : 'list'
  const filter = parseOrderFilter(sp.get('f'))
  const khach = sp.get('khach')
  const q = sp.get('q') ?? ''
  const lk = useMemo(() => makeLookup(d), [d])
  const today = todayVn()
  const set = (k: string, v: string | null) => {
    const n = new URLSearchParams(sp)
    if (v == null || v === '') n.delete(k); else n.set(k, v)
    setSp(n, { replace: true })
  }

  // Lọc khách + từ khoá (mã đơn, tên khách, mã chiếc, mã vận đơn) trước, rồi đếm theo chip.
  const base = useMemo(() => {
    const qq = fold(q.trim())
    return d.orderSummary.filter((s) => (!khach || s.customer_id === khach) && (!qq
      || fold(d.orderCode[s.order_id] ?? '').includes(qq) || fold(s.customer_name).includes(qq)
      || s.unit_codes?.some((c) => fold(c).includes(qq)) || fold(s.tracking_no ?? '').includes(qq)))
  }, [d.orderSummary, d.orderCode, khach, q])
  const counts = useMemo(() => Object.fromEntries(ORDER_FILTERS.map((f) => [f.k, base.filter(f.test).length])) as Record<OrderFilter, number>, [base])
  const custName = khach ? lk.cust(khach)?.fb_name ?? '?' : null

  const search = (
    <input className="input" id="o-search" type="search" value={q} onChange={(e) => set('q', e.target.value)}
      placeholder="Tìm mã đơn, khách, mã chiếc…" aria-label="Tìm đơn" />
  )
  const chips = (
    <div className="chips" role="group" aria-label="Lọc đơn">
      {ORDER_FILTERS.filter((f) => !f.optional || counts[f.k] > 0 || filter === f.k).map((f) => (
        <button key={f.k} type="button" className="chip" aria-pressed={filter === f.k} onClick={() => set('f', f.k === 'todo' ? null : f.k)}>
          {f.t}<span className="c">{counts[f.k]}</span>
        </button>
      ))}
    </div>
  )
  const filterBar = (
    <div className="o-filter">
      <div className="o-top">
        {search}
        {desk && (
          <div className="seg">
            <button aria-pressed={view === 'list'} onClick={() => set('v', null)}>Danh sách</button>
            <button aria-pressed={view === 'board'} onClick={() => set('v', 'board')}>Theo trạng thái</button>
          </div>
        )}
      </div>
      {view === 'list' && chips}
    </div>
  )
  const custBar = custName && (
    <div className="note-box way">
      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Đơn của <b>{custName}</b></span>
      <span className="row" style={{ flex: 'none', gap: 2 }}>
        <Link className="link-btn" to={`/don/new?khach=${khach}`}>+ Đơn</Link>
        <button className="link-btn" onClick={() => set('khach', null)}>Bỏ lọc</button>
      </span>
    </div>
  )

  let body
  let summary = null
  if (d.orders.length === 0) {
    body = <div className="empty"><b>Chưa có đơn nào</b><br />Ghi đơn đầu tiên khi khách chốt mua.<br /><br /><Link className="btn btn-primary" to="/don/new"><Icon name="plus" /> Đơn bán</Link></div>
  } else if (view === 'board') {
    body = (
      <div className="board" style={{ ['--cols' as string]: FLOW.length }}>
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
    const f = ORDER_FILTERS.find((x) => x.k === filter)!
    let os = sortOrders(d, base.filter(f.test))
    // TIEN-S3: Còn nợ / COD chờ về ⇒ nợ lâu nhất trước, Dòng 2 hiện tuổi đơn thay ngày đơn.
    const aged = filter === 'due' || filter === 'cod'
    if (aged) os = [...os].sort((a, b) => (a.shipped_at ?? a.order_date).localeCompare(b.shipped_at ?? b.order_date))
    if (filter === 'due' && os.length) summary = <div className="o-sum"><span>{os.length} đơn còn nợ</span><b className="tone-bad">{tr(os.reduce((a, s) => a + s.receivable_vnd, 0))}</b></div>
    if (filter === 'cod' && os.length) summary = <div className="o-sum"><span>{os.length} đơn chờ hãng chuyển COD</span><b className="tone-way">{tr(os.reduce((a, s) => a + s.cod_pending_vnd, 0))}</b></div>
    if ((filter === 'refund' || filter === 'ret') && os.some((s) => s.refund_due_vnd > 0)) {
      summary = <div className="o-sum"><span>Cần hoàn khách</span><b className="tone-bad">{tr(os.reduce((a, s) => a + s.refund_due_vnd, 0))}</b></div>
    }
    const EMPTY: Record<OrderFilter, string> = {
      todo: 'Không có đơn cần xử lý.', pre: 'Không có đơn đặt trước.', wait: 'Không có đơn chờ gửi.', sent: 'Không có đơn đang gửi.',
      cod: 'Không có tiền COD đang chờ hãng chuyển về.', due: 'Không có đơn nào còn nợ.', refund: 'Không có đơn cần hoàn tiền.',
      ret: 'Chưa có đơn hoàn hàng.', all: 'Không có đơn.',
    }
    if (!os.length) {
      body = <div className="empty">{q ? `Không có đơn khớp “${q}”.` : EMPTY[filter]}<br /><br />
        {q ? <button className="btn btn-ghost" onClick={() => set('q', null)}>Xoá từ khoá</button>
          : filter !== 'all' ? <button className="btn btn-ghost" onClick={() => set('f', 'all')}>Xem tất cả đơn</button> : null}</div>
    } else if (desk) {
      body = (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead><tr><th>Đơn</th><th>Ngày</th><th>Khách</th><th>Chiếc</th><th>Trạng thái</th><th>Thanh toán</th><th className="r">Tổng</th><th className="r">Đã thu</th><th className="r">Còn thu</th><th className="r">Lãi</th></tr></thead>
            <tbody>
              {os.map((s) => {
                const p = lk.profit(s.order_id)
                return (
                  <tr key={s.order_id} data-act="go" onClick={() => nav(`/don/${s.order_id}`)}>
                    <td className="num"><Link to={`/don/${s.order_id}`} onClick={(e) => e.stopPropagation()} style={{ color: 'inherit' }}>{d.orderCode[s.order_id]}</Link></td>
                    <td>{aged ? ageText(s, today) : dmy(s.order_date)}</td>
                    <td>{s.customer_name}</td>
                    <td className="num">{codesText(s.unit_codes, 3)}</td>
                    <td><OrderChip s={s.status} /></td>
                    <td><PayPill s={s} /></td>
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
      body = <div className="olist">{os.map((s) => <OrderRow2 key={s.order_id} s={s} code={d.orderCode[s.order_id]} meta={aged ? ageText(s, today) : undefined} />)}</div>
    }
  }

  // NAV-M2: trên điện thoại tạo đơn qua nút "+" giữa thanh tab — header không lặp nút "+".
  return (
    <Shell section="don" title="Đơn bán"
      actions={desk && <Link className="btn btn-primary btn-sm" to={khach ? `/don/new?khach=${khach}` : '/don/new'}><Icon name="plus" />Đơn bán</Link>}>
      {d.orders.length > 0 && filterBar}
      {custBar}
      {summary}
      {body}
    </Shell>
  )
}
