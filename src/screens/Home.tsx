import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useData } from '../data/store.tsx'
import type { OrderSummaryRow, UnitViewRow } from '../data/types.ts'
import { Shell } from '../ui/Shell.tsx'
import { Icon } from '../ui/icons.tsx'
import { dmy, todayVn, tr } from '../ui/format.ts'
import {
  Ident, unitPrice, OrderRow, Row2, Tx, UnitRow, codesText, daysSince, kpiAmount, lotModelsText, profitMonth, signed, sortedModelStock, thresholds, useDesk,
} from './overview/common.tsx'
import { PayLotButton } from './lots/PayLot.tsx'

type Period = 'thang' | '3thang' | 'nam' | 'all'
const PERIODS: [Period, string][] = [['thang', 'Tháng này'], ['3thang', '3 tháng'], ['nam', 'Năm nay'], ['all', 'Tất cả']]
const addMonths = (ym: string, k: number) => {
  const [y, m] = ym.split('-').map(Number)
  const t = y * 12 + (m - 1) + k
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`
}

/** Đơn Đã gửi quá số ngày này mà chưa Hoàn tất → nhắc (HOME-S1; Cài đặt chưa có cột riêng nên cố định 7 ngày). */
const SHIP_LATE_DAYS = 7
const PER_GROUP = 3
/** "1 đang về · 1 khách đặt" - chỉ ghi phần khác 0 (CR-006). */
const stockText = (m: { in_stock_count: number; incoming_count: number; reserved_count: number }) =>
  [m.in_stock_count && `${m.in_stock_count} ở Kho Lumi`, m.incoming_count && `${m.incoming_count} đang về`, m.reserved_count && `${m.reserved_count} khách đặt`]
    .filter(Boolean).join(', ') || 'không còn chiếc nào'

type Group = { key: string; title: string; tone?: 'bad' | 'way'; count: number; sum?: number; more: string; rows: ReactNode[] }

// SC_01 Tổng quan (CR-001 + CR-004 + CR-005 ý 6, gộp Báo cáo): Tiền (quỹ, lãi tháng, doanh thu) · Vốn đang nằm ở hàng + khách còn nợ
// · Việc cần làm (gom nhóm) · Lãi theo model (CR-006, thay biểu đồ 6 tháng). Điện thoại: ô số → Cần làm → lãi theo model.
// Cần làm gom theo loại có số đếm, mỗi nhóm tối đa 3 việc + "Xem tất cả" (HOME-M1); thêm việc theo tuổi (HOME-S1).
// Lãi tháng gom theo profit_date (ngày gửi; đơn Hoàn hàng = ngày hoàn) - số chính thức v_order_summary.
export default function Home() {
  const d = useData()
  const desk = useDesk()
  const th = thresholds(d)
  const month = todayVn().slice(0, 7)
  const mNo = Number(month.slice(5))

  // KPI: lãi tháng (HOME-M2 - dòng phụ 1 dòng, rút gọn)
  const inMonth = d.orderSummary.filter((o) => profitMonth(o) === month)
  const profit = inMonth.reduce((a, o) => a + (o.profit_vnd ?? 0), 0)
  const shippedN = inMonth.filter((o) => o.status !== 'returned').length
  const returnedN = inMonth.length - shippedN
  const rev = inMonth.filter((o) => o.status !== 'returned').reduce((a, o) => a + o.goods_vnd, 0)
  const [period, setPeriod] = useState<Period>('thang')
  // Vốn đang nằm ở hàng (CR-005 ý 4): Kho Lumi + đang về (Kho TQ / Kho VN) - v_model_stock.total_capital_vnd
  const capital = d.modelStock.reduce((a, s) => a + (s.total_capital_vnd ?? s.stock_value_vnd), 0)
  const cash = d.cashBalance?.balance_vnd ?? 0
  const unsoldN = d.unitView.filter((u) => u.status === 'incoming' || u.status === 'in_stock' || u.status === 'reserved').length
  // Khách còn nợ: đơn chưa Hoàn tất (đơn Huỷ / Hoàn hàng = 0 - Q-009); trả dư không trừ
  const dueOrders = d.orderSummary.filter((o) => o.status !== 'completed' && o.receivable_vnd > 0)
  const due = dueOrders.reduce((a, o) => a + o.receivable_vnd, 0)
  const debt = d.balance.balance_vnd

  // ---------- Cần làm ----------
  const byDate = [...d.orderSummary].sort((a, b) => a.order_date.localeCompare(b.order_date))
  const orderRows = (list: OrderSummaryRow[], sub?: (o: OrderSummaryRow) => ReactNode, chip = false) =>
    list.slice(0, PER_GROUP).map((o) => <OrderRow key={o.order_id} d={d} o={o} noChip={!chip} sub={sub?.(o)} />)
  const sentAgo = (o: OrderSummaryRow) => <>gửi {daysSince(o.shipped_at) ?? 0} ngày, {codesText(o.unit_codes)}</>
  const groups: Group[] = []
  const add = (g: Omit<Group, 'rows'> & { rows: ReactNode[] }) => { if (g.count > 0) groups.push(g) }

  const toShip = byDate.filter((o) => o.status === 'confirmed')
  add({ key: 'ship', title: 'Gửi hàng', count: toShip.length, more: '/don?f=wait', rows: orderRows(toShip) })

  const ready = byDate.filter((o) => o.status === 'preorder' && o.all_units_received)
  add({ key: 'ready', title: 'Đủ hàng - chốt đơn', count: ready.length, more: '/don?f=pre', rows: orderRows(ready) })

  const refund = byDate.filter((o) => o.refund_due_vnd > 0)
  add({ key: 'refund', title: 'Cần hoàn tiền', tone: 'bad', count: refund.length, sum: refund.reduce((a, o) => a + o.refund_due_vnd, 0), more: '/don?f=refund',
    rows: orderRows(refund, (o) => o.status === 'returned' ? <>hoàn hàng {daysSince(o.returned_at) ?? 0} ngày trước</> : <>đơn huỷ, {codesText(o.unit_codes)}</>, true) })

  const cod = [...d.orderSummary].filter((o) => o.cod_pending_vnd > 0).sort((a, b) => (a.shipped_at ?? '').localeCompare(b.shipped_at ?? ''))
  add({ key: 'cod', title: 'COD chờ về', tone: 'way', count: cod.length, sum: cod.reduce((a, o) => a + o.cod_pending_vnd, 0), more: '/don?f=cod',
    rows: orderRows(cod, (o) => <>gửi {daysSince(o.shipped_at) ?? 0} ngày{o.tracking_no ? `, ${o.tracking_no}` : ''}</>) })

  // Còn thu trực tiếp từ khách (phần COD đã có nhóm riêng)
  const directDue = (o: OrderSummaryRow) => o.receivable_vnd - o.cod_pending_vnd
  const dueShipped = byDate.filter((o) => o.status === 'shipped' && directDue(o) > 0)
  add({ key: 'due', title: 'Còn thu', tone: 'bad', count: dueShipped.length, sum: dueShipped.reduce((a, o) => a + directDue(o), 0), more: '/don?f=due', rows: orderRows(dueShipped, sentAgo) })

  const lateShip = d.orderSummary.filter((o) => o.status === 'shipped' && (daysSince(o.shipped_at) ?? 0) > SHIP_LATE_DAYS)
    .sort((a, b) => (a.shipped_at ?? '').localeCompare(b.shipped_at ?? ''))
  add({ key: 'lateship', title: `Đã gửi > ${SHIP_LATE_DAYS} ngày chưa hoàn tất`, tone: 'way', count: lateShip.length, more: '/don?f=sent', rows: orderRows(lateShip, sentAgo) })

  const noShip = d.lots.filter((l) => l.status === 'vn_warehouse' && l.ship_fee_vnd == null)
  // CR-006: 1 lô = 1 cối ⇒ việc của lô hiện theo cối
  const unitsOf = (ids: string[]) => d.unitView.filter((u) => ids.includes(u.lot_id))
  const noShipU = unitsOf(noShip.map((l) => l.id))
  add({ key: 'noship', title: 'Thiếu phí ship về VN', tone: 'bad', count: noShipU.length, more: '/kho?tt=vn', rows: noShipU.slice(0, PER_GROUP).map((u) => <UnitRow key={u.unit_id} d={d} u={u} />) })

  const lateLotIds = new Set(d.lotSummary.filter((s) => s.is_lot_late).map((s) => s.lot_id))
  const lateLots = d.lots.filter((l) => lateLotIds.has(l.id)).sort((a, b) => a.ordered_at.localeCompare(b.ordered_at))
  const lateU = unitsOf(lateLots.map((l) => l.id)).filter((u) => !u.is_received)
  add({ key: 'latelot', title: `Về trễ (> ${th.lotLate} ngày)`, tone: 'way', count: lateU.length, more: '/kho?tt=tq', rows: lateU.slice(0, PER_GROUP).map((u) => <UnitRow key={u.unit_id} d={d} u={u} />) })

  const waiting = byDate.filter((o) => o.status === 'preorder' && !o.all_units_received)
  const waitSub = (o: OrderSummaryRow) => {
    const lots = [...new Set(d.unitView.filter((u) => u.holding_order_id === o.order_id && !u.is_received).map((u) => u.lot_id))]
    const oldest = Math.max(0, ...lots.map((id) => daysSince(d.lots.find((l) => l.id === id)?.ordered_at) ?? 0))
    return <>chờ {lots.map((id) => d.lotCode[id]).join(', ') || 'hàng về'}, lô đặt {oldest} ngày</>
  }
  add({ key: 'wait', title: 'Chờ hàng về (đặt trước)', count: waiting.length, more: '/don?f=pre', rows: orderRows(waiting, waitSub) })

  const owing = d.lotSummary.filter((x) => x.status !== 'cancelled' && x.outstanding_vnd > 0).sort((a, b) => a.ordered_at.localeCompare(b.ordered_at))
  add({ key: 'pay', title: 'Trả trung gian', tone: 'bad', count: owing.length, sum: owing.reduce((a, x) => a + x.outstanding_vnd, 0), more: '/congno',
    rows: owing.slice(0, PER_GROUP).map((x) => (
      <Row2 key={x.lot_id} a={<Link className="row" style={{ gap: 8, minWidth: 0, color: 'inherit', textDecoration: 'none' }} to={`/lo/${x.lot_id}`}><Ident id={codesText(d.unitView.filter((u) => u.lot_id === x.lot_id).map((u) => u.code), 2) || (d.lotCode[x.lot_id] ?? 'Lô')} text={lotModelsText(d, x.lot_id, 'short')} /></Link>}
        b={<span className="neg">{tr(x.outstanding_vnd)}</span>} c={<Tx>{x.paid_vnd > 0 ? `đã trả ${tr(x.paid_vnd)} / ${tr(x.payable_vnd)}` : `phải trả ${tr(x.payable_vnd)}`}</Tx>}
        d={<PayLotButton lotId={x.lot_id} id={`home-pay-${x.lot_id}`} />} />
    )) })

  const low = sortedModelStock(d).filter((m) => m.is_active && (m.sellable_count <= 0 || m.is_low_stock))
  add({ key: 'low', title: 'Sắp hết hàng', tone: 'way', count: low.length, more: '/kho',
    rows: low.slice(0, PER_GROUP).map((m) => (
      <Row2 key={m.model_id} to={`/kho?model=${m.model_id}`} a={<Ident id={m.model_name} />}
        b={<span className={m.sellable_count <= 0 ? 'neg' : 'age-warn'}>{m.sellable_count <= 0 ? 'hết hàng' : `còn ${m.sellable_count}`}</span>}
        c={<Tx>{stockText(m)}</Tx>} />
    )) })

  const aged = d.unitView.filter((u) => u.aging_level === 'alert').sort((a, b) => (b.days_in_stock ?? 0) - (a.days_in_stock ?? 0))
  add({ key: 'aged', title: `Tồn lâu > ${th.alert} ngày`, tone: 'bad', count: aged.length, sum: aged.reduce((a, u) => a + u.cost_vnd, 0), more: '/kho?sx=ton',
    rows: aged.slice(0, PER_GROUP).map((u) => <UnitRow key={u.unit_id} d={d} u={u} />) })

  const todoCount = groups.reduce((a, g) => a + g.count, 0)
  const todo = (
    <div className="ov-todo">
      <p className="section-title">Việc cần làm <span className="muted">{todoCount}</span></p>
      {groups.length === 0 && <div className="empty">Không có việc tồn - đơn, lô và kho đều ổn.</div>}
      {groups.map((g) => (
        <section key={g.key} className="ov-todo" aria-label={g.title}>
          <h3 className={`ov-todo-h ${g.tone ?? ''}`}>
            <span>{g.title} <span className="n">({g.count}){g.sum ? `: ${tr(g.sum)}` : ''}</span></span>
            <Link className="link-btn" id={`todo-more-${g.key}`} to={g.more}>Xem tất cả <Icon name="chev" size={14} /></Link>
          </h3>
          <div className="ov-list">{g.rows}</div>
        </section>
      ))}
    </div>
  )

  const kpis = (
    <div className="kpis ov-k6">
      <Link className="kpi hero" to="/congno"><span className="k">Quỹ hiện có</span><span className={`v ${cash < 0 ? 'neg' : ''}`}>{cash < 0 ? '−' : ''}{kpiAmount(Math.abs(cash), desk)}</span>
        <span className="s">tiền mặt + tài khoản</span></Link>
      <button type="button" className="kpi" onClick={() => document.getElementById('home-margin')?.scrollIntoView({ behavior: 'smooth' })}><span className="k">Lãi tháng {mNo}</span><span className={`v ${profit < 0 ? 'neg' : profit > 0 ? 'pos' : ''}`}>{desk ? (profit < 0 ? '−' : profit > 0 ? '+' : '') + kpiAmount(Math.abs(profit), desk) : signed(profit)}</span>
        <span className="s">{shippedN} đơn đã gửi{returnedN ? `, ${returnedN} hoàn` : ''}</span></button>
      <Link className="kpi" to="/don"><span className="k">Doanh thu tháng {mNo}</span><span className="v">{kpiAmount(rev, desk)}</span><span className="s">giá chốt các chiếc đã gửi</span></Link>
      <Link className="kpi" to="/kho"><span className="k">Tiền nằm ở hàng</span><span className="v">{kpiAmount(capital, desk)}</span>
        <span className="s">{unsoldN} cối chưa bán</span></Link>
      <Link className="kpi" to="/don?f=due"><span className="k">Khách còn nợ</span><span className="v">{kpiAmount(due, desk)}</span><span className={`s ${dueOrders.length ? 'bad' : ''}`}>{dueOrders.length ? `${dueOrders.length} đơn chưa đủ` : 'đã thu đủ'}</span></Link>
      <Link className="kpi" to="/congno"><span className="k">Nợ trung gian</span><span className="v">{kpiAmount(Math.abs(debt), desk)}</span><span className={`s ${debt > 0 ? 'bad' : ''}`}>{debt > 0 ? 'còn phải trả' : debt < 0 ? 'đã chuyển dư' : 'không còn nợ'}</span></Link>
    </div>
  )

  // ---------- CR-006: Lãi theo model (thay biểu đồ 6 tháng) - tỷ lệ lãi = lãi ÷ giá chốt; chưa bán chiếc nào thì lấy lãi dự kiến
  // của các chiếc đang có (giá bán dự kiến − giá nhập) để vẫn so được model nào lãi tốt.
  const inPeriod = (u: UnitViewRow) => {
    const m = u.sold_at?.slice(0, 7)
    if (!m) return false
    if (period === 'thang') return m === month
    if (period === '3thang') return m >= addMonths(month, -2)
    if (period === 'nam') return m.slice(0, 4) === month.slice(0, 4)
    return true
  }
  const rate = (p: number, r: number) => (r > 0 ? p / r : null)
  const margins = d.models.map((m) => {
    const sold = d.unitView.filter((u) => u.model_id === m.id && u.status === 'sold' && inPeriod(u))
    const rev = sold.reduce((a, u) => a + (u.sold_price_vnd ?? 0), 0)
    const p = sold.reduce((a, u) => a + (u.actual_profit_vnd ?? 0), 0)
    const left = d.unitView.filter((u) => u.model_id === m.id && u.status !== 'sold' && u.status !== 'cancelled' && u.expected_profit_vnd != null)
    const ep = left.reduce((a, u) => a + (u.expected_profit_vnd ?? 0), 0)
    const er = left.reduce((a, u) => a + (unitPrice(u) ?? 0), 0)
    return { m, n: sold.length, rev, p, r: rate(p, rev), left: left.length, ep, er: rate(ep, er) }
  }).filter((x) => x.n > 0 || x.left > 0)
    .sort((a, b) => (b.n > 0 ? 1 : 0) - (a.n > 0 ? 1 : 0) || ((b.n ? b.r : b.er) ?? -1) - ((a.n ? a.r : a.er) ?? -1))
  const maxRate = Math.max(0.01, ...margins.map((x) => Math.abs((x.n ? x.r : x.er) ?? 0)))
  const pctText = (x: number | null) => (x == null ? '-' : `${Math.round(x * 100)}%`)
  // ---------- CR-008: Thời gian hàng về - TB số ngày đặt → về Kho Lumi (cối đã về), ngày dự kiến về của cối đang về
  const dayDiff = (a: string, b: string) => Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 864e5)
  const arrived = d.unitView.filter((u) => u.received_at && u.ordered_at && u.status !== 'cancelled').map((u) => dayDiff(u.ordered_at!, u.received_at!)).filter((n) => n >= 0)
  const avgDays = arrived.length ? Math.round(arrived.reduce((a, n) => a + n, 0) / arrived.length) : null
  const today = todayVn()
  const addDays = (iso: string, n: number) => new Date(Date.parse(iso.slice(0, 10)) + n * 864e5).toISOString().slice(0, 10)
  const coming = d.unitView.filter((u) => !u.is_received && u.status !== 'cancelled' && u.ordered_at)
    .map((u) => ({ u, eta: avgDays != null ? addDays(u.ordered_at!, avgDays) : null, age: dayDiff(u.ordered_at!, today) }))
    .sort((a, b) => b.age - a.age)
  const arriveBlock = (
    <div className="stack" id="home-arrive">
      <p className="section-title">Thời gian hàng về</p>
      <div className="ar-stat">
        {avgDays != null
          ? <><span className="v">{avgDays} ngày</span><span className="s">trung bình từ lúc đặt tới khi về Kho Lumi, {arrived.length} cối
            {arrived.length > 1 ? `, nhanh nhất ${Math.min(...arrived)}, lâu nhất ${Math.max(...arrived)} ngày` : ''}</span></>
          : <span className="s">Chưa có cối nào về Kho Lumi - nhận cối đầu tiên để app tính thời gian hàng về.</span>}
      </div>
      {coming.length > 0 && (
        <div className="ov-list">
          {coming.slice(0, 5).map(({ u, eta, age }) => {
            const left = eta ? dayDiff(today, eta) : null
            return (
              <Row2 key={u.unit_id} to={`/kho/${u.unit_id}`}
                a={<Ident id={u.code} text={u.model_name} />}
                b={left == null ? `đặt ${age} ngày` : left > 0 ? `còn ~${left} ngày` : left === 0 ? 'dự kiến hôm nay' : <span className="neg">trễ {-left} ngày</span>}
                c={<Tx>{u.lot_status === 'vn_warehouse' ? 'Kho VN' : 'Kho TQ'}, đặt {dmy(u.ordered_at)}{eta ? `, về ~${dmy(eta)}` : ''}</Tx>} />
            )
          })}
        </div>
      )}
      {coming.length > 5 && <Link className="link-btn small" to="/kho?tt=tq">Xem cả {coming.length} cối đang về <Icon name="chev" size={14} /></Link>}
    </div>
  )

  // ---------- CR-008: So với tháng trước - lãi, doanh thu, số cối bán (cùng cách tính ô số)
  const prevMonth = addMonths(month, -1)
  const monthStats = (ym: string) => {
    const os = d.orderSummary.filter((o) => profitMonth(o) === ym)
    return {
      profit: os.reduce((a, o) => a + (o.profit_vnd ?? 0), 0),
      rev: os.filter((o) => o.status !== 'returned').reduce((a, o) => a + o.goods_vnd, 0),
      units: d.unitView.filter((u) => u.status === 'sold' && u.sold_at?.slice(0, 7) === ym).length,
    }
  }
  const cur = monthStats(month), prev = monthStats(prevMonth)
  const delta = (a: number, b: number) => {
    if (b === 0) return a === 0 ? <span className="muted">bằng</span> : <span className="muted">mới</span>
    const p = Math.round(((a - b) / Math.abs(b)) * 100)
    return <span className={p > 0 ? 'pos' : p < 0 ? 'neg' : 'muted'}>{p > 0 ? '▲' : p < 0 ? '▼' : ''} {Math.abs(p)}%</span>
  }
  const cmpRows: [string, number, number, (n: number) => string][] = [
    ['Lãi', cur.profit, prev.profit, signed], ['Doanh thu', cur.rev, prev.rev, tr], ['Cối bán', cur.units, prev.units, (n) => `${n} cối`],
  ]
  const compareBlock = (
    <div className="stack" id="home-compare">
      <p className="section-title">Tháng {mNo} so với tháng {Number(prevMonth.slice(5))}</p>
      <div className="ov-list">
        {cmpRows.map(([k, a, b, f]) => (
          <Row2 key={k} a={<b>{k}</b>} b={f(a)} c={<Tx>tháng trước {f(b)}</Tx>} d={delta(a, b)} />
        ))}
      </div>
    </div>
  )

  // ---------- CR-008: Giá Goofish theo model - giá ¥ các lần mua (lần mới nhất so với lần trước, thấp / cao nhất)
  const priceRows = d.models.map((m) => {
    const buys = d.unitView.filter((u) => u.model_id === m.id && u.status !== 'cancelled')
      .sort((a, b) => a.ordered_at.localeCompare(b.ordered_at) || a.code.localeCompare(b.code))
    const ps = buys.map((u) => Number(u.price_cny))
    return { m, n: ps.length, last: ps[ps.length - 1], before: ps.length > 1 ? ps[ps.length - 2] : null, lo: Math.min(...ps), hi: Math.max(...ps), when: buys[buys.length - 1]?.ordered_at }
  }).filter((x) => x.n > 0)
  const cnyT = (n: number) => `¥${n.toLocaleString('vi-VN')}`
  const priceBlock = (
    <div className="stack" id="home-price">
      <p className="section-title">Giá Goofish theo model</p>
      {priceRows.length === 0 ? <p className="muted small" style={{ margin: 0 }}>Chưa nhập cối nào.</p> : (
        <div className="ov-list">
          {priceRows.map((x) => (
            <Row2 key={x.m.id} to={`/kho?model=${x.m.id}&tt=all`} a={<Ident id={x.m.name} />} b={cnyT(x.last)}
              c={<Tx>{x.n > 1 ? `${x.n} lần mua, ${x.lo === x.hi ? cnyT(x.lo) : `${cnyT(x.lo)} - ${cnyT(x.hi)}`}` : `mua 1 lần, ${dmy(x.when)}`}</Tx>}
              d={x.before == null || x.last === x.before ? undefined
                : <span className={x.last > x.before ? 'neg' : 'pos'} title="so với lần mua trước">{x.last > x.before ? '▲' : '▼'} {cnyT(Math.abs(x.last - x.before))}</span>} />
          ))}
        </div>
      )}
    </div>
  )

  // ---------- CR-008: Người bán Goofish - số cối đã mua, thời gian về TB, số cối có lỗi / đã dùng khi nhận
  const sellerRows = d.sellers.map((sl) => {
    const us = d.unitView.filter((u) => u.seller_id === sl.id && u.status !== 'cancelled')
    const days = us.filter((u) => u.received_at).map((u) => dayDiff(u.ordered_at, u.received_at!)).filter((n) => n >= 0)
    const bad = us.filter((u) => u.is_received && (u.condition === 'defect' || u.condition === 'used')).length
    return { sl, n: us.length, avg: days.length ? Math.round(days.reduce((a, n) => a + n, 0) / days.length) : null, bad }
  }).filter((x) => x.n > 0).sort((a, b) => Number(a.sl.is_avoided) - Number(b.sl.is_avoided) || a.bad - b.bad || b.n - a.n)
  const sellerBlock = (
    <div className="stack" id="home-sellers">
      <p className="section-title">Người bán Goofish</p>
      {sellerRows.length === 0 ? <p className="muted small" style={{ margin: 0 }}>Chưa có người bán nào - nhập cối kèm tên người bán để theo dõi.</p> : (
        <div className="ov-list">
          {sellerRows.slice(0, 6).map((x) => (
            <Row2 key={x.sl.id} a={<Ident id={x.sl.nickname} text={x.sl.region ?? undefined} />} b={`${x.n} cối`}
              c={<Tx>{x.avg != null ? `về TB ${x.avg} ngày` : 'chưa có cối về'}{x.sl.is_avoided ? ', đang đánh dấu tránh' : ''}</Tx>}
              d={x.bad > 0 ? <span className="neg">{x.bad} cối lỗi / đã dùng</span> : x.avg != null ? <span className="pos">hàng ổn</span> : undefined} />
          ))}
        </div>
      )}
    </div>
  )

  const marginBlock = (
    <div className="stack" id="home-margin">
      <p className="section-title">Lãi theo model</p>
      <div className="chips" role="group" aria-label="Kỳ">
        {PERIODS.map(([k, t]) => <button key={k} className="chip" id={`home-ky-${k}`} aria-pressed={period === k} onClick={() => setPeriod(k)}>{t}</button>)}
      </div>
      {margins.length === 0
        ? <p className="muted small" style={{ margin: 0 }}>Chưa có chiếc nào - nhập cối để xem lãi theo model.</p>
        : (
          <div className="mg-list">
            {margins.map((x) => {
              const sold = x.n > 0
              const r = (sold ? x.r : x.er) ?? 0
              return (
                <Link key={x.m.id} className="mg-row" to={sold ? `/kho?model=${x.m.id}&tt=ban` : `/kho?model=${x.m.id}`}>
                  <span className="nm">{x.m.name}</span>
                  <span className={`pc ${sold ? (r < 0 ? 'neg' : '') : 'est'}`}>{pctText(sold ? x.r : x.er)}</span>
                  <span className="track"><span className={`fill ${sold ? (r < 0 ? 'neg' : '') : 'est'}`} style={{ width: `${Math.max(2, Math.round((Math.abs(r) / maxRate) * 100))}%` }} /></span>
                  <span className="sub">{sold
                    ? <>đã bán {x.n}, lãi {signed(x.p)}, TB {signed(Math.round(x.p / x.n))}/chiếc</>
                    : <>chưa bán, dự kiến {signed(Math.round(x.ep / x.left))}/chiếc ({x.left} chiếc)</>}</span>
                </Link>
              )
            })}
          </div>
        )}
      <p className="hint" style={{ margin: 0 }}>% = lãi ÷ giá bán. Thanh gạch chéo = chưa bán, tính theo giá bán dự kiến.</p>
    </div>
  )

  return (
    <Shell section="home" title="Tổng quan" actions={<span className="muted small only-desk">Tháng {mNo}/{month.slice(0, 4)}</span>}>
      {desk
        // CR-008: máy tính xem gọn trong 1 màn - 6 ô số 1 hàng + lưới 2 cột, Việc cần làm ở dưới cùng; mỗi ô tự cuộn bên trong
        ? (
          <div className="ov-desk">
            {kpis}
            <div className="ov-dash">
              <section className="ov-panel">{compareBlock}{arriveBlock}</section>
              <section className="ov-panel">{marginBlock}</section>
              <section className="ov-panel">{priceBlock}</section>
              <section className="ov-panel">{sellerBlock}</section>
              <section className="ov-panel todo">{todo}</section>
            </div>
          </div>
        )
        : <>{kpis}{compareBlock}{todo}{arriveBlock}{marginBlock}{priceBlock}{sellerBlock}</>}
    </Shell>
  )
}
