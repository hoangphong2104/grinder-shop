import { Link } from 'react-router-dom'
import { useData } from '../data/store.tsx'
import { Shell } from '../ui/Shell.tsx'
import { todayVn, tr } from '../ui/format.ts'
import { modelOrder, useDesk } from './overview/common.tsx'

// SC_11 Báo cáo (CR-001): lãi theo tháng (theo ngày gửi hàng), bảng theo model (từ chiếc đã bán), chiếc tồn lâu nhất.
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

  // Theo model: chiếc Đã bán (v_units) — doanh thu = Σ giá chốt, lãi = Σ (giá chốt − giá nhập ₫), ngày tồn TB = TB days_in_stock
  const sold = d.unitView.filter((u) => u.status === 'sold')
  const mi = modelOrder(d)
  const rows = d.models.map((m) => {
    const us = sold.filter((u) => u.model_id === m.id)
    const withDays = us.filter((u) => u.days_in_stock != null)
    return {
      m, n: us.length,
      rev: us.reduce((a, u) => a + (u.sold_price_vnd ?? 0), 0),
      p: us.reduce((a, u) => a + (u.actual_profit_vnd ?? 0), 0),
      avgDays: withDays.length ? Math.round(withDays.reduce((a, u) => a + (u.days_in_stock ?? 0), 0) / withDays.length) : null,
    }
  }).filter((r) => r.m.is_active || r.n > 0).sort((a, b) => (mi.get(a.m.id) ?? 0) - (mi.get(b.m.id) ?? 0))
  const tot = rows.reduce((a, r) => ({ n: a.n + r.n, rev: a.rev + r.rev, p: a.p + r.p }), { n: 0, rev: 0, p: 0 })
  const allDays = sold.filter((u) => u.days_in_stock != null)
  const totDays = allDays.length ? Math.round(allDays.reduce((a, u) => a + (u.days_in_stock ?? 0), 0) / allDays.length) : null

  // Chiếc tồn lâu nhất: top 5 chiếc Trong kho theo số ngày tồn
  const oldest = d.unitView.filter((u) => u.status === 'in_stock' && u.days_in_stock != null)
    .sort((a, b) => (b.days_in_stock ?? 0) - (a.days_in_stock ?? 0) || a.code.localeCompare(b.code)).slice(0, 5)

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
          <p className="hint">Lãi tính theo ngày gửi hàng; lãi đơn = Σ (giá chốt − giá nhập ₫ hiện tại của từng chiếc) − ship shop chịu (A8, BR-11). Sửa giá nhập / phí ship lô sau khi bán sẽ đổi lãi tháng đó.</p>

          <p className="section-title">Chiếc tồn lâu nhất</p>
          {oldest.length === 0
            ? <p className="muted small">Không có chiếc nào trong kho.</p>
            : (
              <div className="list">
                {oldest.map((u) => (
                  <Link key={u.unit_id} className="li" to={`/kho/${u.unit_id}`}>
                    <div className="main"><b className="num">{u.code}</b> <span className="muted small">· {u.model_name}</span><div className="s">nhập {tr(u.cost_vnd)} · bán dự kiến {tr(u.list_price_vnd)}</div></div>
                    <span className="v">{u.days_in_stock} ngày</span>
                  </Link>
                ))}
              </div>
            )}
        </div>
        <div>
          <p className="section-title">Theo model</p>
          <div className="tbl-wrap"><table className="tbl">
            <thead><tr><th>Model</th><th className="r">Số chiếc bán</th><th className="r">Doanh thu</th><th className="r">Lãi</th><th className="r">Ngày tồn TB</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.m.id}><td>{r.m.name}</td><td className="r">{r.n}</td><td className="r">{tr(r.rev)}</td><td className={`r ${r.p < 0 ? 'req' : ''}`}>{tr(r.p)}</td><td className="r">{r.avgDays ?? '—'}</td></tr>
              ))}
              {rows.length > 1 && <tr className="tot"><td>Tổng</td><td className="r">{tot.n}</td><td className="r">{tr(tot.rev)}</td><td className="r">{tr(tot.p)}</td><td className="r">{totDays ?? '—'}</td></tr>}
            </tbody>
          </table></div>
          <p className="hint">Tính trên chiếc Đã bán (đơn Đã gửi / Hoàn tất). Lãi = Σ (giá chốt − giá nhập ₫) từng chiếc, chưa trừ ship shop chịu. Ngày tồn TB = trung bình số ngày từ ngày nhận lô tới ngày gửi hàng.</p>
        </div>
      </div>
    </Shell>
  )
}
