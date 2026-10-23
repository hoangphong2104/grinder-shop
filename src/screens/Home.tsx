import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useData } from '../data/store.tsx'
import type { OrderSummaryRow, UnitViewRow } from '../data/types.ts'
import { Shell } from '../ui/Shell.tsx'
import { Icon } from '../ui/icons.tsx'
import { todayVn, tr } from '../ui/format.ts'
import {
  Ident, LotRow, OrderRow, Profit, Row2, Tx, UnitRow, codesText, daysSince, kpiAmount, lotModelsText, profitMonth, signed, sortedModelStock, thresholds, useDesk,
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

type Group = { key: string; title: string; tone?: 'bad' | 'way'; count: number; sum?: number; more: string; rows: ReactNode[] }

// SC_01 Tổng quan (CR-001 + CR-004 + CR-005 ý 6, gộp Báo cáo): Tiền (quỹ, lãi tháng, doanh thu) · Vốn đang nằm ở hàng + khách còn nợ
// · Việc cần làm (gom nhóm) · Biểu đồ lãi 6 tháng + model bán chạy. Điện thoại: ô số → Cần làm → biểu đồ → model.
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
  const stockValue = d.modelStock.reduce((a, s) => a + s.stock_value_vnd, 0)
  const incomingValue = d.modelStock.reduce((a, s) => a + (s.incoming_value_vnd ?? 0), 0)
  const cash = d.cashBalance?.balance_vnd ?? 0
  // Khách còn nợ: đơn chưa Hoàn tất (đơn Huỷ / Hoàn hàng = 0 - Q-009); trả dư không trừ
  const dueOrders = d.orderSummary.filter((o) => o.status !== 'completed' && o.receivable_vnd > 0)
  const due = dueOrders.reduce((a, o) => a + o.receivable_vnd, 0)
  const debt = d.balance.balance_vnd

  // ---------- Cần làm ----------
  const byDate = [...d.orderSummary].sort((a, b) => a.order_date.localeCompare(b.order_date))
  const orderRows = (list: OrderSummaryRow[], sub?: (o: OrderSummaryRow) => ReactNode, chip = false) =>
    list.slice(0, PER_GROUP).map((o) => <OrderRow key={o.order_id} d={d} o={o} noChip={!chip} sub={sub?.(o)} />)
  const sentAgo = (o: OrderSummaryRow) => <>gửi {daysSince(o.shipped_at) ?? 0} ngày · {codesText(o.unit_codes)}</>
  const groups: Group[] = []
  const add = (g: Omit<Group, 'rows'> & { rows: ReactNode[] }) => { if (g.count > 0) groups.push(g) }

  const toShip = byDate.filter((o) => o.status === 'confirmed')
  add({ key: 'ship', title: 'Gửi hàng', count: toShip.length, more: '/don?f=wait', rows: orderRows(toShip) })

  const ready = byDate.filter((o) => o.status === 'preorder' && o.all_units_received)
  add({ key: 'ready', title: 'Đủ hàng - chốt đơn', count: ready.length, more: '/don?f=pre', rows: orderRows(ready) })

  const refund = byDate.filter((o) => o.refund_due_vnd > 0)
  add({ key: 'refund', title: 'Cần hoàn tiền', tone: 'bad', count: refund.length, sum: refund.reduce((a, o) => a + o.refund_due_vnd, 0), more: '/don?f=refund',
    rows: orderRows(refund, (o) => o.status === 'returned' ? <>hoàn hàng {daysSince(o.returned_at) ?? 0} ngày trước</> : <>đơn huỷ · {codesText(o.unit_codes)}</>, true) })

  const cod = [...d.orderSummary].filter((o) => o.cod_pending_vnd > 0).sort((a, b) => (a.shipped_at ?? '').localeCompare(b.shipped_at ?? ''))
  add({ key: 'cod', title: 'COD chờ về', tone: 'way', count: cod.length, sum: cod.reduce((a, o) => a + o.cod_pending_vnd, 0), more: '/don?f=cod',
    rows: orderRows(cod, (o) => <>gửi {daysSince(o.shipped_at) ?? 0} ngày{o.tracking_no ? ` · ${o.tracking_no}` : ''}</>) })

  // Còn thu trực tiếp từ khách (phần COD đã có nhóm riêng)
  const directDue = (o: OrderSummaryRow) => o.receivable_vnd - o.cod_pending_vnd
  const dueShipped = byDate.filter((o) => o.status === 'shipped' && directDue(o) > 0)
  add({ key: 'due', title: 'Còn thu', tone: 'bad', count: dueShipped.length, sum: dueShipped.reduce((a, o) => a + directDue(o), 0), more: '/don?f=due', rows: orderRows(dueShipped, sentAgo) })

  const lateShip = d.orderSummary.filter((o) => o.status === 'shipped' && (daysSince(o.shipped_at) ?? 0) > SHIP_LATE_DAYS)
    .sort((a, b) => (a.shipped_at ?? '').localeCompare(b.shipped_at ?? ''))
  add({ key: 'lateship', title: `Đã gửi > ${SHIP_LATE_DAYS} ngày chưa hoàn tất`, tone: 'way', count: lateShip.length, more: '/don?f=sent', rows: orderRows(lateShip, sentAgo) })

  const noShip = d.lots.filter((l) => l.status === 'vn_warehouse' && l.ship_fee_vnd == null)
  add({ key: 'noship', title: 'Thiếu phí ship lô', tone: 'bad', count: noShip.length, more: '/lo', rows: noShip.slice(0, PER_GROUP).map((l) => <LotRow key={l.id} d={d} l={l} />) })

  const lateLotIds = new Set(d.lotSummary.filter((s) => s.is_lot_late).map((s) => s.lot_id))
  const lateLots = d.lots.filter((l) => lateLotIds.has(l.id)).sort((a, b) => a.ordered_at.localeCompare(b.ordered_at))
  add({ key: 'latelot', title: `Lô về trễ (> ${th.lotLate} ngày)`, tone: 'way', count: lateLots.length, more: '/lo', rows: lateLots.slice(0, PER_GROUP).map((l) => <LotRow key={l.id} d={d} l={l} />) })

  const waiting = byDate.filter((o) => o.status === 'preorder' && !o.all_units_received)
  const waitSub = (o: OrderSummaryRow) => {
    const lots = [...new Set(d.unitView.filter((u) => u.holding_order_id === o.order_id && !u.is_received).map((u) => u.lot_id))]
    const oldest = Math.max(0, ...lots.map((id) => daysSince(d.lots.find((l) => l.id === id)?.ordered_at) ?? 0))
    return <>chờ {lots.map((id) => d.lotCode[id]).join(', ') || 'hàng về'} · lô đặt {oldest} ngày</>
  }
  add({ key: 'wait', title: 'Chờ hàng về (đặt trước)', count: waiting.length, more: '/don?f=pre', rows: orderRows(waiting, waitSub) })

  const owing = d.lotSummary.filter((x) => x.status !== 'cancelled' && x.outstanding_vnd > 0).sort((a, b) => a.ordered_at.localeCompare(b.ordered_at))
  add({ key: 'pay', title: 'Trả trung gian', tone: 'bad', count: owing.length, sum: owing.reduce((a, x) => a + x.outstanding_vnd, 0), more: '/congno',
    rows: owing.slice(0, PER_GROUP).map((x) => (
      <Row2 key={x.lot_id} a={<Link className="row" style={{ gap: 8, minWidth: 0, color: 'inherit', textDecoration: 'none' }} to={`/lo/${x.lot_id}`}><Ident id={d.lotCode[x.lot_id] ?? 'Lô'} text={lotModelsText(d, x.lot_id, 'short')} /></Link>}
        b={<span className="neg">{tr(x.outstanding_vnd)}</span>} c={<Tx>{x.paid_vnd > 0 ? `đã trả ${tr(x.paid_vnd)} / ${tr(x.payable_vnd)}` : `phải trả ${tr(x.payable_vnd)}`}</Tx>}
        d={<PayLotButton lotId={x.lot_id} id={`home-pay-${x.lot_id}`} />} />
    )) })

  const low = sortedModelStock(d).filter((m) => m.is_active && (m.sellable_count <= 0 || m.is_low_stock))
  add({ key: 'low', title: 'Sắp hết hàng', tone: 'way', count: low.length, more: '/kho',
    rows: low.slice(0, PER_GROUP).map((m) => (
      <Row2 key={m.model_id} to={`/kho?model=${m.model_id}`} a={<Ident id={m.code_prefix} text={m.model_name} />}
        b={<span className={m.sellable_count <= 0 ? 'neg' : 'age-warn'}>{m.sellable_count <= 0 ? 'hết hàng' : `còn ${m.sellable_count}`}</span>}
        c={<Tx>Kho Lumi {m.in_stock_count} · đang về {m.incoming_count} · đã giữ {m.reserved_count}</Tx>} />
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
            <span>{g.title} <span className="n">({g.count}){g.sum ? ` · ${tr(g.sum)}` : ''}</span></span>
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
      <button type="button" className="kpi" onClick={() => document.getElementById('home-chart')?.scrollIntoView({ behavior: 'smooth' })}><span className="k">Lãi tháng {mNo}</span><span className={`v ${profit < 0 ? 'neg' : profit > 0 ? 'pos' : ''}`}>{desk ? (profit < 0 ? '−' : profit > 0 ? '+' : '') + kpiAmount(Math.abs(profit), desk) : signed(profit)}</span>
        <span className="s">{shippedN} đơn đã gửi{returnedN ? ` · ${returnedN} hoàn` : ''}</span></button>
      <Link className="kpi" to="/don"><span className="k">Doanh thu tháng {mNo}</span><span className="v">{kpiAmount(rev, desk)}</span><span className="s">giá chốt các chiếc đã gửi</span></Link>
      <Link className="kpi" to="/kho"><span className="k">Vốn ở hàng</span><span className="v">{kpiAmount(capital, desk)}</span>
        <span className="s">Kho Lumi {tr(stockValue)}{incomingValue > 0 ? ` + về ${tr(incomingValue)}` : ''}</span></Link>
      <Link className="kpi" to="/don?f=due"><span className="k">Khách còn nợ</span><span className="v">{kpiAmount(due, desk)}</span><span className={`s ${dueOrders.length ? 'bad' : ''}`}>{dueOrders.length ? `${dueOrders.length} đơn chưa đủ` : 'đã thu đủ'}</span></Link>
      <Link className="kpi" to="/congno"><span className="k">Nợ trung gian</span><span className="v">{kpiAmount(Math.abs(debt), desk)}</span><span className={`s ${debt > 0 ? 'bad' : ''}`}>{debt > 0 ? 'còn phải trả' : debt < 0 ? 'đã chuyển dư' : 'không còn nợ'}</span></Link>
    </div>
  )

  // ---------- Biểu đồ lãi 6 tháng (theo profit_date) ----------
  const byMonth = new Map<string, number>()
  d.orderSummary.forEach((o) => { const m = profitMonth(o); if (m) byMonth.set(m, (byMonth.get(m) ?? 0) + (o.profit_vnd ?? 0)) })
  const months = Array.from({ length: 6 }, (_, i) => addMonths(month, i - 5))
  const ps = months.map((m) => byMonth.get(m) ?? 0)
  const max = Math.max(1, ...ps.map((p) => Math.abs(p)))
  const mLabel = (m: string) => `T${Number(m.slice(5))}${m.slice(0, 4) !== month.slice(0, 4) ? `/${m.slice(2, 4)}` : ''}`
  const chart = (
    <div className="stack" id="home-chart">
      <p className="section-title">Lãi 6 tháng <span className="muted">tổng {signed(ps.reduce((a, p) => a + p, 0))}</span></p>
      <div>
        <div className="bars" role="img" aria-label={`Lãi theo tháng: ${months.map((m, i) => `${mLabel(m)} ${signed(ps[i])}`).join(', ')}`}>
          {ps.map((p, i) => (
            <div key={months[i]} className={`b ${months[i] === month ? 'cur' : ''}`}>
              <span>{p === 0 ? '0' : signed(p)}</span><i className={p < 0 ? 'neg' : ''} style={{ height: Math.max(2, Math.round((Math.abs(p) / max) * 100)) }} />
            </div>
          ))}
        </div>
        <div className="bars-x">{months.map((m) => <span key={m}>{mLabel(m)}</span>)}</div>
      </div>
      <p className="hint" style={{ margin: 0 }}>Lãi tính theo ngày gửi hàng (đơn Hoàn hàng: ngày hoàn) = giá chốt − giá nhập − ship shop chịu.</p>
    </div>
  )

  // ---------- Model bán chạy (số chiếc đã bán + lãi theo model, chọn kỳ) ----------
  const inPeriod = (u: UnitViewRow) => {
    const m = u.sold_at?.slice(0, 7)
    if (!m) return false
    if (period === 'thang') return m === month
    if (period === '3thang') return m >= addMonths(month, -2)
    if (period === 'nam') return m.slice(0, 4) === month.slice(0, 4)
    return true
  }
  const sold = d.unitView.filter((u) => u.status === 'sold' && inPeriod(u))
  const best = d.models.map((m) => {
    const us = sold.filter((u) => u.model_id === m.id)
    return { m, n: us.length, rev: us.reduce((a, u) => a + (u.sold_price_vnd ?? 0), 0), p: us.reduce((a, u) => a + (u.actual_profit_vnd ?? 0), 0) }
  }).filter((r) => r.n > 0).sort((a, b) => b.n - a.n || b.p - a.p)
  const bestBlock = (
    <div className="stack">
      <p className="section-title">Model bán chạy</p>
      <div className="chips" role="group" aria-label="Kỳ">
        {PERIODS.map(([k, t]) => <button key={k} className="chip" id={`home-ky-${k}`} aria-pressed={period === k} onClick={() => setPeriod(k)}>{t}</button>)}
      </div>
      {best.length === 0
        ? <p className="muted small" style={{ margin: 0 }}>Chưa bán chiếc nào trong kỳ này.</p>
        : (
          <div className="ov-list">
            {best.map((r) => (
              <Row2 key={r.m.id} to={`/kho?model=${r.m.id}&tt=xong`}
                a={<Ident id={r.m.code_prefix} text={r.m.name} />}
                b={`${r.n} chiếc`}
                c={<Tx>doanh thu {tr(r.rev)}</Tx>}
                d={<Profit n={r.p} prefix="lãi " />} />
            ))}
          </div>
        )}
    </div>
  )

  return (
    <Shell section="home" title="Tổng quan" actions={<span className="muted small only-desk">Tháng {mNo}/{month.slice(0, 4)}</span>}>
      {desk
        ? <>{kpis}<div className="cols">{todo}<div className="stack">{chart}{bestBlock}</div></div></>
        : <>{kpis}{todo}{chart}{bestBlock}</>}
    </Shell>
  )
}
