import { Link } from 'react-router-dom'
import { useData } from '../data/store.tsx'
import { Shell } from '../ui/Shell.tsx'
import { Gpic, Icon } from '../ui/icons.tsx'
import { LOT_LABEL, ModelStockChip } from '../ui/status.tsx'
import { dmy, todayVn, tr, vnd } from '../ui/format.ts'
import { GoRow, kpiAmount, lotModelsText, sortedModelStock, useDesk } from './overview/common.tsx'

type Todo = { to: string; title: string; sub: string; tone: 'hold' | 'way' | 'bad'; chip: string }

// SC_01 Tổng quan (hướng A, CR-001): 4 ô số, Tồn kho theo model, Cần làm. Điện thoại: "Cần làm" lên trên (home-cols).
export default function Home() {
  const d = useData()
  const desk = useDesk()
  const month = todayVn().slice(0, 7)
  const mNo = Number(month.slice(5))

  // Lãi tháng: Σ lãi đơn đã gửi trong tháng (theo ngày gửi) — số chính thức từ v_order_summary (A8, BR-11)
  const shippedThisMonth = d.orderSummary.filter((o) => o.profit_vnd != null && o.shipped_at?.startsWith(month))
  const pm = shippedThisMonth.reduce((a, o) => ({ p: a.p + (o.profit_vnd ?? 0), rev: a.rev + o.goods_vnd }), { p: 0, rev: 0 })
  // Vốn trong kho = Σ giá nhập ₫ chiếc đã về kho chưa bán (v_model_stock)
  const stockValue = d.modelStock.reduce((a, s) => a + s.stock_value_vnd, 0)
  const onHand = d.modelStock.reduce((a, s) => a + s.on_hand_count, 0)
  const incoming = d.modelStock.reduce((a, s) => a + s.incoming_count, 0)
  // Khách còn nợ: đơn chưa Hoàn tất (đơn Huỷ = 0 — Q-009); trả dư không trừ
  const dueOrders = d.orderSummary.filter((o) => o.status !== 'completed' && o.receivable_vnd > 0)
  const due = dueOrders.reduce((a, o) => a + o.receivable_vnd, 0)
  const debt = d.balance.balance_vnd

  // Cần làm
  const byOrder = [...d.orderSummary].sort((a, b) => a.order_date.localeCompare(b.order_date))
  const title = (o: (typeof byOrder)[number]) => `${d.orderCode[o.order_id]} · ${o.customer_name}`
  const codes = (o: (typeof byOrder)[number]) => (o.unit_codes.length ? o.unit_codes.join(', ') : '(chưa có chiếc)')
  const todo: Todo[] = []
  for (const o of byOrder.filter((x) => x.status === 'preorder')) {
    // A4/A7: đơn giữ chiếc cụ thể; chờ các lô chứa chiếc chưa về
    const waitLots = [...new Set(d.unitView.filter((u) => u.holding_order_id === o.order_id && !u.is_received).map((u) => d.lotCode[u.lot_id]))]
    todo.push({
      to: `/don/${o.order_id}`, title: title(o), sub: `Đặt trước · giữ ${codes(o)}`,
      tone: o.all_units_received ? 'hold' : 'way', chip: o.all_units_received ? 'Đủ hàng — chốt' : `Chờ ${waitLots.join(', ') || 'hàng về'}`,
    })
  }
  for (const o of byOrder.filter((x) => x.status === 'confirmed')) {
    todo.push({ to: `/don/${o.order_id}`, title: title(o), sub: `${codes(o)}${o.receivable_vnd > 0 ? ` · còn thu ${tr(o.receivable_vnd)}` : ''}`, tone: 'hold', chip: 'Gửi hàng' })
  }
  for (const l of d.lots.filter((x) => (x.status === 'at_forwarder' || x.status === 'vn_shipping') && x.ship_fee_vnd == null)) {
    todo.push({ to: `/lo/${l.id}`, title: `${d.lotCode[l.id]} · ${lotModelsText(d, l.id, 'qtyLast')}`, sub: `${LOT_LABEL[l.status]} · nhập phí ship khi nhận (giá nhập đang tạm tính)`, tone: 'bad', chip: 'Thiếu phí ship' })
  }
  for (const o of byOrder.filter((x) => x.status === 'shipped' && x.receivable_vnd > 0)) {
    todo.push({ to: `/don/${o.order_id}`, title: title(o), sub: `Đã gửi ${dmy(o.shipped_at)}${o.tracking_no ? ` · ${o.tracking_no}` : ''} · ${codes(o)}`, tone: 'bad', chip: `Còn thu ${tr(o.receivable_vnd)}` })
  }
  for (const o of byOrder.filter((x) => x.status === 'cancelled' && x.refund_due_vnd > 0)) {
    todo.push({ to: `/don/${o.order_id}`, title: title(o), sub: 'Đơn đã huỷ · ghi “Hoàn tiền” khi trả lại khách', tone: 'bad', chip: `Cần hoàn ${tr(o.refund_due_vnd)}` })
  }

  const ms = sortedModelStock(d)
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
        <div className="list">
          {ms.map((s) => (
            <Link key={s.model_id} className="li" to={kho(s.model_id)}>
              <Gpic modelName={s.model_name} />
              <div className="main"><b>{s.model_name}</b><div className="s">bán được {s.sellable_count} · kho {s.in_stock_count} · về {s.incoming_count} · giữ {s.reserved_count}</div></div>
              <ModelStockChip m={s} />
            </Link>
          ))}
        </div>
      )

  return (
    <Shell section="home" title="Tổng quan" actions={<span className="muted small only-desk">Tháng {mNo}/{month.slice(0, 4)}</span>}>
      <div className="kpis">
        <Link className="kpi hero" to="/baocao"><span className="k">Lãi tháng {mNo}</span><span className="v">{kpiAmount(pm.p, desk)}</span><span className="s">{shippedThisMonth.length} đơn đã gửi · doanh thu {tr(pm.rev)}</span></Link>
        <Link className="kpi" to="/kho"><span className="k">Vốn trong kho</span><span className="v">{kpiAmount(stockValue, desk)}</span><span className="s">{onHand} chiếc đã về kho · {incoming} đang về</span></Link>
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
