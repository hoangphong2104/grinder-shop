import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useData } from '../data/store.tsx'
import type { OrderSummaryRow } from '../data/types.ts'
import { Shell } from '../ui/Shell.tsx'
import { Gpic, Icon } from '../ui/icons.tsx'
import { ModelStockChip } from '../ui/status.tsx'
import { todayVn, tr, vnd } from '../ui/format.ts'
import {
  GoRow, Ident, LotRow, OrderRow, Row2, Tx, UnitRow, codesText, daysSince, kpiAmount, profitMonth, sortedModelStock, thresholds, useDesk,
} from './overview/common.tsx'

/** Đơn Đã gửi quá số ngày này mà chưa Hoàn tất → nhắc (HOME-S1; Cài đặt chưa có cột riêng nên cố định 7 ngày). */
const SHIP_LATE_DAYS = 7
const PER_GROUP = 3

type Group = { key: string; title: string; tone?: 'bad' | 'way'; count: number; sum?: number; more: string; rows: ReactNode[] }

// SC_01 Tổng quan (CR-001 + CR-004): dashboard vận hành.
// Điện thoại: Cần làm → ô số → Tồn kho rút gọn (HOME-M3). Máy tính: ô số trên, Tồn kho | Cần làm.
// Cần làm gom theo loại có số đếm, mỗi nhóm tối đa 3 việc + "Xem tất cả" (HOME-M1); thêm việc theo tuổi (HOME-S1).
// Lãi tháng gom theo profit_date (ngày gửi; đơn Hoàn hàng = ngày hoàn) — số chính thức v_order_summary.
export default function Home() {
  const d = useData()
  const desk = useDesk()
  const th = thresholds(d)
  const month = todayVn().slice(0, 7)
  const mNo = Number(month.slice(5))

  // KPI: lãi tháng (HOME-M2 — dòng phụ 1 dòng, rút gọn)
  const inMonth = d.orderSummary.filter((o) => profitMonth(o) === month)
  const profit = inMonth.reduce((a, o) => a + (o.profit_vnd ?? 0), 0)
  const shippedN = inMonth.filter((o) => o.status !== 'returned').length
  const returnedN = inMonth.length - shippedN
  const rev = inMonth.filter((o) => o.status !== 'returned').reduce((a, o) => a + o.goods_vnd, 0)
  const stockValue = d.modelStock.reduce((a, s) => a + s.stock_value_vnd, 0)
  const onHand = d.modelStock.reduce((a, s) => a + s.on_hand_count, 0)
  const incoming = d.modelStock.reduce((a, s) => a + s.incoming_count, 0)
  // Khách còn nợ: đơn chưa Hoàn tất (đơn Huỷ / Hoàn hàng = 0 — Q-009); trả dư không trừ
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
  add({ key: 'ready', title: 'Đủ hàng — chốt đơn', count: ready.length, more: '/don?f=pre', rows: orderRows(ready) })

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

  const noShip = d.lots.filter((l) => (l.status === 'at_forwarder' || l.status === 'vn_shipping') && l.ship_fee_vnd == null)
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

  const aged = d.unitView.filter((u) => u.aging_level === 'alert').sort((a, b) => (b.days_in_stock ?? 0) - (a.days_in_stock ?? 0))
  add({ key: 'aged', title: `Tồn lâu > ${th.alert} ngày`, tone: 'bad', count: aged.length, sum: aged.reduce((a, u) => a + u.cost_vnd, 0), more: '/kho?sx=ton',
    rows: aged.slice(0, PER_GROUP).map((u) => <UnitRow key={u.unit_id} d={d} u={u} />) })

  const todoCount = groups.reduce((a, g) => a + g.count, 0)
  const todo = (
    <div className="ov-todo">
      <p className="section-title">Cần làm <span className="muted">{todoCount}</span></p>
      {groups.length === 0 && <div className="empty">Không có việc tồn — đơn, lô và kho đều ổn.</div>}
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
    <div className="kpis">
      <Link className="kpi hero" to="/baocao"><span className="k">Lãi tháng {mNo}</span><span className="v">{kpiAmount(profit, desk)}</span>
        <span className="s">{shippedN} đơn · DT {tr(rev)}{returnedN ? ` · ${returnedN} hoàn` : ''}</span></Link>
      <Link className="kpi" to="/kho"><span className="k">Vốn trong kho</span><span className="v">{kpiAmount(stockValue, desk)}</span><span className="s">{onHand} về kho · {incoming} đang về</span></Link>
      <Link className="kpi" to="/don?f=due"><span className="k">Khách còn nợ</span><span className="v">{kpiAmount(due, desk)}</span><span className={`s ${dueOrders.length ? 'bad' : ''}`}>{dueOrders.length ? `${dueOrders.length} đơn chưa đủ` : 'đã thu đủ'}</span></Link>
      <Link className="kpi" to="/congno"><span className="k">Nợ trung gian</span><span className="v">{kpiAmount(debt, desk)}</span><span className={`s ${debt > 0 ? 'bad' : ''}`}>{debt > 0 ? 'còn phải trả' : debt < 0 ? 'đã chuyển dư' : 'không còn nợ'}</span></Link>
    </div>
  )

  // Tồn kho: máy tính bảng; điện thoại 1 dòng / model, model có cảnh báo lên trước (HOME-S2)
  const ms = sortedModelStock(d)
  const warnRank = (s: (typeof ms)[number]) => (s.sellable_count <= 0 ? 0 : s.is_low_stock ? 1 : 2)
  const kho = (id: string) => `/kho?model=${id}`
  const stockList = ms.length === 0
    ? <div className="empty">Chưa có model đang bán — vào <Link to="/danhmuc">Model</Link> để thêm.</div>
    : desk
      ? (
        <div className="tbl-wrap"><table className="tbl">
          <thead><tr><th>Model</th><th className="r">Có thể bán</th><th className="r">Trong kho</th><th className="r">Đang về</th><th className="r">Đã giữ</th><th>Tình trạng</th><th className="r">Vốn tồn</th></tr></thead>
          <tbody>
            {ms.map((s) => (
              <GoRow key={s.model_id} to={kho(s.model_id)}>
                <td><Link className="row cell-link" to={kho(s.model_id)}><Gpic modelName={s.model_name} />{s.model_name}</Link></td>
                <td className="r"><b>{s.sellable_count}</b></td><td className="r">{s.in_stock_count}</td><td className="r">{s.incoming_count}</td><td className="r">{s.reserved_count}</td>
                <td><ModelStockChip m={s} /></td>
                <td className="r">{s.stock_value_vnd ? vnd(s.stock_value_vnd) : '—'}</td>
              </GoRow>
            ))}
          </tbody>
        </table></div>
      )
      : (
        <div className="ov-list">
          {[...ms].sort((a, b) => warnRank(a) - warnRank(b)).map((s) => (
            <Row2 key={s.model_id} to={kho(s.model_id)}
              a={<Ident id={s.code_prefix} text={s.model_name} />}
              b={`${s.sellable_count} bán được`}
              c={<>{s.sellable_count <= 0 ? <span className="pill bad">Hết</span> : s.is_low_stock ? <span className="pill hold">Sắp hết</span> : null}
                <Tx>kho {s.in_stock_count} · về {s.incoming_count} · giữ {s.reserved_count}</Tx></>}
              d={s.stock_value_vnd ? `vốn ${tr(s.stock_value_vnd)}` : ''} />
          ))}
        </div>
      )
  const stock = (
    <div className="stack">
      <p className="section-title">Tồn kho <Link className="link-btn small" to="/kho">Xem kho <Icon name="chev" size={16} /></Link></p>
      {stockList}
    </div>
  )

  return (
    <Shell section="home" title="Tổng quan" actions={<span className="muted small only-desk">Tháng {mNo}/{month.slice(0, 4)}</span>}>
      {desk
        ? <>{kpis}<div className="cols">{stock}{todo}</div></>
        : <>{todo}{kpis}{stock}</>}
    </Shell>
  )
}
