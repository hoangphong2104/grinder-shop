import { useData } from '../data/store.tsx'
import { Shell } from '../ui/Shell.tsx'
import { todayVn, tr } from '../ui/format.ts'
import { daysBetween, useDesk } from './overview/common.tsx'

// SC_11 Báo cáo: lãi theo tháng (theo ngày gửi hàng) + bảng theo model.
export default function Reports() {
  const d = useData()
  const desk = useDesk()
  const cur = todayVn().slice(0, 7)
  const shipped = d.orderSummary.filter((o) => o.profit_vnd != null && o.shipped_at)

  // Lãi theo tháng: 6 tháng gần nhất có dữ liệu (luôn có tháng hiện tại)
  const byMonth = new Map<string, number>()
  shipped.forEach((o) => { const m = o.shipped_at!.slice(0, 7); byMonth.set(m, (byMonth.get(m) ?? 0) + (o.profit_vnd ?? 0)) })
  const months = [...new Set([...byMonth.keys(), cur])].filter((m) => m <= cur).sort().slice(-6)
  const ps = months.map((m) => byMonth.get(m) ?? 0)
  const max = Math.max(1, ...ps.map((p) => Math.abs(p)))
  const label = (m: string) => `T${Number(m.slice(5))}${m.slice(0, 4) !== cur.slice(0, 4) ? `/${m.slice(2, 4)}` : ''}`

  // Theo model: dòng đơn đã gửi / hoàn tất (giá vốn đã chụp lúc gửi — BR-05)
  const orderById = new Map(d.orders.map((o) => [o.id, o]))
  const variantModel = new Map(d.variants.map((v) => [v.id, v.model_id]))
  // Ngày nhận các lô đã nhận theo biến thể (để tính ngày tồn)
  const recvByVariant = new Map<string, string[]>()
  d.lots.filter((l) => l.status === 'received' && l.received_at).forEach((l) => {
    d.lotLines.filter((x) => x.lot_id === l.id).forEach((x) => {
      const arr = recvByVariant.get(x.variant_id) ?? []
      arr.push(l.received_at!)
      recvByVariant.set(x.variant_id, arr)
    })
  })
  const rows = d.models.map((m) => {
    let n = 0, rev = 0, p = 0, dayQty = 0, dayN = 0
    d.orderLines.forEach((x) => {
      const o = orderById.get(x.order_id)
      if (!o || !o.shipped_at || (o.status !== 'shipped' && o.status !== 'completed') || variantModel.get(x.variant_id) !== m.id) return
      n += x.qty
      rev += x.qty * x.unit_price_vnd
      p += x.qty * (x.unit_price_vnd - (x.unit_cost_vnd ?? 0))
      const recv = (recvByVariant.get(x.variant_id) ?? []).filter((r) => r <= o.shipped_at!).sort().pop()
      if (recv) { dayQty += x.qty * daysBetween(recv, o.shipped_at); dayN += x.qty }
    })
    return { m, n, rev, p, avgDays: dayN ? Math.round(dayQty / dayN) : null }
  }).filter((r) => r.m.is_active || r.n > 0)
  const tot = rows.reduce((a, r) => ({ n: a.n + r.n, rev: a.rev + r.rev, p: a.p + r.p }), { n: 0, rev: 0, p: 0 })

  return (
    <Shell section="baocao" title="Báo cáo" back={desk ? undefined : '/them'}>
      <div className="cols">
        <div>
          <p className="section-title">Lãi theo tháng</p>
          {shipped.length === 0
            ? <div className="empty">Chưa có đơn đã gửi — lãi được tính khi bấm “Gửi hàng” trên đơn.</div>
            : (
              <div>
                <div className="bars">
                  {ps.map((p, i) => (
                    <div key={months[i]} className={`b ${months[i] === cur ? 'cur' : ''}`} title={`${months[i]}: ${tr(p)}`}>
                      <span>{tr(p)}</span><i className={p < 0 ? 'neg' : ''} style={{ height: Math.round((Math.abs(p) / max) * 100) }} />
                    </div>
                  ))}
                </div>
                <div className="bars-x">{months.map((m) => <span key={m}>{label(m)}</span>)}</div>
              </div>
            )}
          <p className="hint">Lãi tính theo ngày gửi hàng; = giá chốt − giá vốn lúc gửi − ship shop chịu (BR-11).</p>
        </div>
        <div>
          <p className="section-title">Theo model</p>
          <div className="tbl-wrap"><table className="tbl">
            <thead><tr><th>Model</th><th className="r">Đã bán</th><th className="r">Doanh thu</th><th className="r">Lãi gộp</th><th className="r">Ngày tồn TB</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.m.id}><td>{r.m.name}</td><td className="r">{r.n}</td><td className="r">{tr(r.rev)}</td><td className="r">{tr(r.p)}</td><td className="r">{r.avgDays ?? '—'}</td></tr>
              ))}
              {rows.length > 1 && <tr className="tot"><td>Tổng</td><td className="r">{tot.n}</td><td className="r">{tr(tot.rev)}</td><td className="r">{tr(tot.p)}</td><td className="r" /></tr>}
            </tbody>
          </table></div>
          <p className="hint">Lãi gộp = (giá chốt − giá vốn lúc gửi) × số chiếc, chưa trừ ship shop chịu. Ngày tồn TB = số ngày từ ngày nhận lô gần nhất có màu đó (nhận trước hoặc đúng ngày gửi) tới ngày gửi hàng, bình quân theo số chiếc đã bán.</p>
        </div>
      </div>
    </Shell>
  )
}
