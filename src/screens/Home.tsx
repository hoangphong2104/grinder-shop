import { Link } from 'react-router-dom'
import { useData } from '../data/store.tsx'
import { Shell } from '../ui/Shell.tsx'
import { Gpic, Icon } from '../ui/icons.tsx'
import { LOT_LABEL, StockChip } from '../ui/status.tsx'
import { dmy, todayVn, tr, vnd } from '../ui/format.ts'
import { GoRow, kpiAmount, lotLinesText, orderLinesText, sortedStock, useDesk, waitingLot } from './overview/common.tsx'

type Todo = { to: string; title: string; sub: string; tone: 'hold' | 'way' | 'bad'; chip: string }

// SC_01 Tổng quan (hướng A): 4 ô số, Tồn kho, Cần làm. Điện thoại: "Cần làm" lên trên (home-cols).
export default function Home() {
  const d = useData()
  const desk = useDesk()
  const month = todayVn().slice(0, 7)
  const mNo = Number(month.slice(5))

  // Lãi tháng: đơn đã gửi trong tháng (theo ngày gửi) — số chính thức từ v_order_summary (BR-11)
  const shippedThisMonth = d.orderSummary.filter((o) => o.profit_vnd != null && o.shipped_at?.startsWith(month))
  const pm = shippedThisMonth.reduce((a, o) => ({ p: a.p + (o.profit_vnd ?? 0), rev: a.rev + o.goods_vnd }), { p: 0, rev: 0 })
  const stockValue = d.stock.reduce((a, s) => a + s.stock_value_vnd, 0)
  const onHand = d.stock.reduce((a, s) => a + s.on_hand, 0)
  const incoming = d.lotSummary.filter((l) => l.status !== 'received' && l.status !== 'cancelled').reduce((a, l) => a + l.total_qty, 0)
  // Khách còn nợ: đơn chưa Hoàn tất (đơn Huỷ = 0 — Q-009); trả dư không trừ
  const dueOrders = d.orderSummary.filter((o) => o.status !== 'completed' && o.receivable_vnd > 0)
  const due = dueOrders.reduce((a, o) => a + o.receivable_vnd, 0)
  const debt = d.balance.balance_vnd

  // Cần làm
  const sum = new Map(d.orderSummary.map((o) => [o.order_id, o]))
  const custName = (id: string) => d.customers.find((c) => c.id === id)?.fb_name ?? ''
  const confirmedQty = (variantId: string, exceptOrder: string) => d.orderLines
    .filter((x) => x.variant_id === variantId && x.order_id !== exceptOrder && d.orders.find((o) => o.id === x.order_id)?.status === 'confirmed')
    .reduce((a, x) => a + x.qty, 0)
  const todo: Todo[] = []
  for (const o of d.orders.filter((x) => x.status === 'preorder')) {
    // BR-08: đủ hàng nếu mọi dòng ≤ Có sẵn − SL các đơn Đã chốt khác
    const need = new Map<string, number>()
    d.orderLines.filter((x) => x.order_id === o.id).forEach((x) => need.set(x.variant_id, (need.get(x.variant_id) ?? 0) + x.qty))
    const ok = need.size > 0 && [...need].every(([vid, q]) => (d.variants.find((v) => v.id === vid)?.on_hand_qty ?? 0) - confirmedQty(vid, o.id) >= q)
    todo.push({ to: `/don/${o.id}`, title: `${d.orderCode[o.id]} · ${custName(o.customer_id)}`, sub: `Đặt trước ${orderLinesText(d, o.id)}`, tone: ok ? 'hold' : 'way', chip: ok ? 'Đủ hàng — chốt' : 'Chờ hàng' })
  }
  for (const o of d.orders.filter((x) => x.status === 'confirmed')) {
    const r = sum.get(o.id)?.receivable_vnd ?? 0
    todo.push({ to: `/don/${o.id}`, title: `${d.orderCode[o.id]} · ${custName(o.customer_id)}`, sub: `${orderLinesText(d, o.id)}${r > 0 ? ` · còn thu ${tr(r)}` : ''}`, tone: 'hold', chip: 'Gửi hàng' })
  }
  for (const l of d.lots.filter((x) => (x.status === 'at_forwarder' || x.status === 'vn_shipping') && x.ship_fee_vnd == null)) {
    todo.push({ to: `/lo/${l.id}`, title: `${d.lotCode[l.id]} · ${lotLinesText(d, l.id, 'qtyLast')}`, sub: `${LOT_LABEL[l.status]} · nhập phí ship khi nhận`, tone: 'bad', chip: 'Thiếu phí ship' })
  }
  for (const o of d.orders.filter((x) => x.status === 'shipped')) {
    const r = sum.get(o.id)?.receivable_vnd ?? 0
    if (r > 0) todo.push({ to: `/don/${o.id}`, title: `${d.orderCode[o.id]} · ${custName(o.customer_id)}`, sub: `Đã gửi ${dmy(o.shipped_at)}${o.tracking_no ? ` · ${o.tracking_no}` : ''}`, tone: 'bad', chip: `Còn thu ${tr(r)}` })
  }
  for (const o of d.orders.filter((x) => x.status === 'cancelled')) {
    const r = sum.get(o.id)?.refund_due_vnd ?? 0
    if (r > 0) todo.push({ to: `/don/${o.id}`, title: `${d.orderCode[o.id]} · ${custName(o.customer_id)}`, sub: 'Đơn đã huỷ · ghi “Hoàn tiền” khi trả lại khách', tone: 'bad', chip: `Cần hoàn ${tr(r)}` })
  }

  const vs = sortedStock(d)
  const stockList = vs.length === 0
    ? <div className="empty">Chưa có model / màu đang bán — vào <Link to="/danhmuc">Model & màu</Link> để thêm.</div>
    : desk
      ? (
        <div className="tbl-wrap"><table className="tbl">
          <thead><tr><th>Model · màu</th><th className="r">Có sẵn</th><th className="r">Đang về</th><th className="r">Đã giữ</th><th>Tình trạng</th><th className="r">Giá vốn BQ</th></tr></thead>
          <tbody>
            {vs.map((s) => (
              <GoRow key={s.variant_id} to={`/kho/${s.variant_id}`}>
                <td><Link className="row cell-link" to={`/kho/${s.variant_id}`}><Gpic modelName={s.model_name} />{s.model_name} · {s.variant_name}</Link></td>
                <td className="r">{s.on_hand}</td><td className="r">{s.incoming}</td><td className="r">{s.reserved}</td>
                <td><StockChip v={s} waitingLot={waitingLot(d, s.variant_id)} /></td>
                <td className="r">{s.on_hand ? vnd(s.avg_cost_vnd) : '—'}</td>
              </GoRow>
            ))}
          </tbody>
        </table></div>
      )
      : (
        <div className="list">
          {vs.map((s) => (
            <Link key={s.variant_id} className="li" to={`/kho/${s.variant_id}`}>
              <Gpic modelName={s.model_name} />
              <div className="main"><b>{s.model_name} · {s.variant_name}</b><div className="s">sẵn {s.on_hand} · về {s.incoming} · giữ {s.reserved}</div></div>
              <StockChip v={s} waitingLot={waitingLot(d, s.variant_id)} />
            </Link>
          ))}
        </div>
      )

  return (
    <Shell section="home" title="Tổng quan" actions={<span className="muted small only-desk">Tháng {mNo}/{month.slice(0, 4)}</span>}>
      <div className="kpis">
        <Link className="kpi hero" to="/baocao"><span className="k">Lãi tháng {mNo}</span><span className="v">{kpiAmount(pm.p, desk)}</span><span className="s">{shippedThisMonth.length} đơn đã gửi · doanh thu {tr(pm.rev)}</span></Link>
        <Link className="kpi" to="/kho"><span className="k">Vốn trong kho</span><span className="v">{kpiAmount(stockValue, desk)}</span><span className="s">{onHand} chiếc sẵn · {incoming} đang về</span></Link>
        <Link className="kpi" to="/don"><span className="k">Khách còn nợ</span><span className="v">{kpiAmount(due, desk)}</span><span className={`s ${dueOrders.length ? 'bad' : ''}`}>{dueOrders.length ? `${dueOrders.length} đơn chưa thu đủ` : 'đã thu đủ'}</span></Link>
        <Link className="kpi" to="/congno"><span className="k">Nợ trung gian</span><span className="v">{kpiAmount(debt, desk)}</span><span className={`s ${debt > 0 ? 'bad' : ''}`}>{debt > 0 ? 'còn phải trả' : debt < 0 ? 'đã chuyển dư' : 'không còn nợ'}</span></Link>
      </div>
      <div className="cols home-cols">
        <div>
          <p className="section-title">Tồn kho <Link className="link-btn small" to="/kho">Xem kho <Icon name="chev" size={16} /></Link></p>
          {stockList}
        </div>
        <div>
          <p className="section-title">Cần làm <span className="muted">{todo.length}</span></p>
          <div className="stack">
            {todo.length
              ? todo.map((t, i) => (
                <Link key={i} className="shot" to={t.to}>
                  <span className="b">{t.title}</span>
                  <span className="r"><span className={`pill ${t.tone}`}>{t.chip}</span></span>
                  <span className="f">{t.sub}</span>
                </Link>
              ))
              : <div className="empty">Không có việc tồn</div>}
          </div>
        </div>
      </div>
    </Shell>
  )
}
