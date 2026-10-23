import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useData } from '../data/store.tsx'
import type { UnitViewRow } from '../data/types.ts'
import { Shell } from '../ui/Shell.tsx'
import { todayVn, tr, vnd } from '../ui/format.ts'
import { HowTo, Ident, Money, OrderRow, Row2, Tx, UnitRow, modelOrder, profitMonth, useDesk } from './overview/common.tsx'

type Period = 'thang' | 'truoc' | '3thang' | 'nam' | 'all'
const PERIODS: [Period, string][] = [['thang', 'Tháng này'], ['truoc', 'Tháng trước'], ['3thang', '3 tháng'], ['nam', 'Năm nay'], ['all', 'Tất cả']]
const addMonths = (ym: string, k: number) => {
  const [y, m] = ym.split('-').map(Number)
  const t = y * 12 + (m - 1) + k
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`
}
const BUCKETS: [string, number, number][] = [['0–30 ngày', 0, 30], ['31–60 ngày', 31, 60], ['61–90 ngày', 61, 90], ['> 90 ngày', 91, Infinity]]

// SC_11 Báo cáo (CR-001 + CR-004):
//  - Lãi theo tháng gom theo profit_date (ngày gửi; đơn Hoàn hàng = ngày hoàn, lãi thường âm) — 6 tháng gần nhất.
//  - Bấm 1 tháng → lãi TỪNG CHIẾC đã bán trong tháng + ship shop chịu + đơn hoàn hàng = lãi tháng (BC-M2).
//  - Tuổi tồn 0–30 / 31–60 / 61–90 / > 90 ngày: số chiếc + vốn (BC-S1).
//  - Theo model (chọn kỳ BC-S3): số chiếc bán, doanh thu, lãi, % lãi, tỷ lệ bán, ngày tồn TB (BC-M1, BC-S2).
export default function Reports() {
  const d = useData()
  const desk = useDesk()
  const [params, setParams] = useSearchParams()
  const cur = todayVn().slice(0, 7)
  const pRaw = params.get('ky')
  const period: Period = PERIODS.some(([k]) => k === pRaw) ? (pRaw as Period) : 'thang'
  const [sel, setSel] = useState(cur)

  const counted = d.orderSummary.filter((o) => profitMonth(o) != null)
  const byMonth = new Map<string, number>()
  counted.forEach((o) => { const m = profitMonth(o)!; byMonth.set(m, (byMonth.get(m) ?? 0) + (o.profit_vnd ?? 0)) })
  const months = [...new Set([...byMonth.keys(), cur])].filter((m) => m <= cur).sort().slice(-6)
  const ps = months.map((m) => byMonth.get(m) ?? 0)
  const max = Math.max(1, ...ps.map((p) => Math.abs(p)))
  const label = (m: string) => `T${Number(m.slice(5))}${m.slice(0, 4) !== cur.slice(0, 4) ? `/${m.slice(2, 4)}` : ''}`

  // Tháng đang chọn: chiếc đã bán (sold_at = ngày gửi đơn = profit_date) + ship shop chịu + đơn hoàn hàng
  const selOrders = counted.filter((o) => profitMonth(o) === sel)
  const selUnits = d.unitView.filter((u) => u.status === 'sold' && u.sold_at?.slice(0, 7) === sel)
    .sort((a, b) => (b.sold_at ?? '').localeCompare(a.sold_at ?? '') || a.code.localeCompare(b.code))
  const shopShip = selOrders.filter((o) => o.status !== 'returned' && o.ship_fee_payer === 'shop').reduce((a, o) => a + o.ship_fee_vnd, 0)
  const selReturned = selOrders.filter((o) => o.status === 'returned')
  const selTotal = byMonth.get(sel) ?? 0
  const unitSum = selUnits.reduce((a, u) => a + (u.actual_profit_vnd ?? 0), 0)

  // Tuổi tồn: chiếc đã về kho, chưa bán (Trong kho + Đã giữ đã về) — như vốn trong kho
  const onHand = d.unitView.filter((u) => u.is_received && (u.status === 'in_stock' || u.status === 'reserved') && u.days_in_stock != null)
  const buckets = BUCKETS.map(([t, lo, hi]) => {
    const us = onHand.filter((u) => u.days_in_stock! >= lo && u.days_in_stock! <= hi)
    return { t, n: us.length, v: us.reduce((a, u) => a + u.cost_vnd, 0), lo }
  })

  // Theo model trong kỳ
  const inPeriod = (u: UnitViewRow) => {
    const m = u.sold_at?.slice(0, 7)
    if (!m) return false
    if (period === 'thang') return m === cur
    if (period === 'truoc') return m === addMonths(cur, -1)
    if (period === '3thang') return m >= addMonths(cur, -2)
    if (period === 'nam') return m.slice(0, 4) === cur.slice(0, 4)
    return true
  }
  const sold = d.unitView.filter((u) => u.status === 'sold' && inPeriod(u))
  const mi = modelOrder(d)
  const avg = (us: UnitViewRow[]) => { const w = us.filter((u) => u.days_in_stock != null); return w.length ? Math.round(w.reduce((a, u) => a + (u.days_in_stock ?? 0), 0) / w.length) : null }
  const pctOf = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—')
  const rows = d.models.map((m) => {
    const us = sold.filter((u) => u.model_id === m.id)
    const stockN = onHand.filter((u) => u.model_id === m.id).length
    return {
      m, n: us.length, stockN,
      rev: us.reduce((a, u) => a + (u.sold_price_vnd ?? 0), 0),
      p: us.reduce((a, u) => a + (u.actual_profit_vnd ?? 0), 0),
      avgDays: avg(us),
    }
  }).filter((r) => r.n > 0 || (r.m.is_active && period === 'all')).sort((a, b) => (mi.get(a.m.id) ?? 0) - (mi.get(b.m.id) ?? 0))
  const tot = rows.reduce((a, r) => ({ n: a.n + r.n, rev: a.rev + r.rev, p: a.p + r.p, stockN: a.stockN + r.stockN }), { n: 0, rev: 0, p: 0, stockN: 0 })
  const totDays = avg(sold)

  // Hoàn hàng (mọi tháng): tiền mất / giữ lại
  const returned = d.orderSummary.filter((o) => o.status === 'returned').sort((a, b) => (b.returned_at ?? '').localeCompare(a.returned_at ?? ''))
  const returnedLoss = returned.reduce((a, o) => a + (o.profit_vnd ?? 0), 0)

  const setPeriod = (k: Period) => { const p = new URLSearchParams(params); if (k === 'thang') p.delete('ky'); else p.set('ky', k); setParams(p, { replace: true }) }

  return (
    <Shell section="baocao" title="Báo cáo" back={desk ? undefined : '/them'}>
      <div className="cols">
        <div>
          <p className="section-title">Lãi theo tháng <span className="muted">bấm cột để xem từng chiếc</span></p>
          {counted.length === 0
            ? <div className="empty">Chưa có đơn đã gửi — lãi được tính khi bấm “Gửi hàng” trên đơn.</div>
            : (
              <div>
                <div className="bars" role="group" aria-label="Lãi theo tháng">
                  {ps.map((p, i) => (
                    <button key={months[i]} type="button" id={`bc-m-${months[i]}`} className={`b ${months[i] === cur ? 'cur' : ''} ${months[i] === sel ? 'sel' : ''}`}
                      aria-pressed={months[i] === sel} aria-label={`Tháng ${label(months[i])}: lãi ${tr(p)}`} onClick={() => setSel(months[i])}>
                      <span>{tr(p)}</span><i className={p < 0 ? 'neg' : ''} style={{ height: Math.max(2, Math.round((Math.abs(p) / max) * 100)) }} />
                    </button>
                  ))}
                </div>
                <div className="bars-x">{months.map((m) => <span key={m} className={m === sel ? 'sel' : ''}>{label(m)}</span>)}</div>
              </div>
            )}

          <p className="section-title">Tháng {Number(sel.slice(5))}/{sel.slice(0, 4)} <span className="muted">lãi <Money n={selTotal} /></span></p>
          {selUnits.length === 0 && selReturned.length === 0
            ? <p className="muted small" style={{ margin: 0 }}>Không có chiếc nào gửi đi trong tháng này.</p>
            : (
              <div className="ov-list">
                {selUnits.map((u) => <UnitRow key={u.unit_id} d={d} u={u} sub={<>gửi {u.sold_at ? `${u.sold_at.slice(8, 10)}/${u.sold_at.slice(5, 7)}` : '—'} · nhập {tr(u.cost_vnd)}</>} />)}
                {shopShip > 0 && <Row2 a={<Tx>Ship shop chịu</Tx>} b={<Money n={-shopShip} />} />}
                {selReturned.map((o) => <OrderRow key={o.order_id} d={d} o={o} sub={<>hoàn {o.returned_at ? `${o.returned_at.slice(8, 10)}/${o.returned_at.slice(5, 7)}` : '—'} · ship về {tr(o.return_ship_fee_vnd)}</>} right2={<Money n={o.profit_vnd} prefix="lãi " />} />)}
                <Row2 className="static" a={<Tx><b>Tổng lãi tháng</b></Tx>} b={<b><Money n={selTotal} /></b>}
                  c={<Tx>{selUnits.length} chiếc · lãi chiếc {tr(unitSum)}</Tx>} />
              </div>
            )}

          <p className="section-title">Tuổi tồn <Link className="link-btn small" to="/kho?sx=ton">Xem kho</Link></p>
          <div className="ov-buckets">
            {buckets.map((b, i) => (
              <Link key={b.t} className={`kpi ${i >= 2 ? 'alert' : i === 1 ? 'warn' : ''}`} id={`bc-age-${b.lo}`} to="/kho?sx=ton">
                <span className="k">{b.t}</span><span className="v">{b.n} chiếc</span><span className="s">vốn {tr(b.v)}</span>
              </Link>
            ))}
          </div>

          {returned.length > 0 && (
            <>
              <p className="section-title">Hoàn hàng <span className="muted">{returned.length} đơn · <Money n={returnedLoss} /></span></p>
              <div className="ov-list">
                {returned.slice(0, 10).map((o) => <OrderRow key={o.order_id} d={d} o={o} sub={<>hoàn {o.returned_at ? `${o.returned_at.slice(8, 10)}/${o.returned_at.slice(5, 7)}` : '—'} · {o.keep_deposit ? 'giữ cọc' : 'hoàn cọc'} · ship về {tr(o.return_ship_fee_vnd)}</>} right2={<Money n={o.profit_vnd} prefix="lãi " />} />)}
              </div>
            </>
          )}
          <HowTo>
            Lãi tháng gom theo ngày gửi hàng (đơn Hoàn hàng: theo ngày hoàn). Lãi đơn = Σ (giá chốt − giá nhập ₫ hiện tại của từng chiếc) − ship shop chịu (A8, BR-11).
            Đơn Hoàn hàng: lãi = tiền shop giữ lại (cọc nếu giữ) − ship đi shop chịu − ship chiều về; chiếc đã về kho bán lại được.
            Sửa giá nhập / phí ship lô sau khi bán sẽ đổi lãi tháng đó. Tuổi tồn tính trên chiếc đã về kho chưa bán (gồm chiếc đang giữ cho đơn), vốn = giá nhập ₫.
          </HowTo>
        </div>
        <div>
          <p className="section-title">Theo model</p>
          <div className="chips" role="group" aria-label="Kỳ báo cáo">
            {PERIODS.map(([k, t]) => <button key={k} className="chip" id={`bc-ky-${k}`} aria-pressed={period === k} onClick={() => setPeriod(k)}>{t}</button>)}
          </div>
          {rows.length === 0
            ? <p className="muted small" style={{ margin: 0 }}>Không có chiếc nào bán trong kỳ này.</p>
            : desk ? (
              <div className="tbl-wrap"><table className="tbl">
                <thead><tr><th>Model</th><th className="r">Đã bán</th><th className="r">Doanh thu</th><th className="r">Lãi</th><th className="r">% lãi</th><th className="r">Tỷ lệ bán</th><th className="r">Ngày tồn TB</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.m.id}><td>{r.m.name}</td><td className="r">{r.n}</td><td className="r">{tr(r.rev)}</td><td className={`r ${r.p < 0 ? 'req' : ''}`}>{tr(r.p)}</td>
                      <td className="r">{pctOf(r.p, r.rev)}</td><td className="r">{pctOf(r.n, r.n + r.stockN)}</td><td className="r">{r.avgDays ?? '—'}</td></tr>
                  ))}
                  {rows.length > 1 && <tr className="tot"><td>Tổng</td><td className="r">{tot.n}</td><td className="r">{tr(tot.rev)}</td><td className="r">{tr(tot.p)}</td>
                    <td className="r">{pctOf(tot.p, tot.rev)}</td><td className="r">{pctOf(tot.n, tot.n + tot.stockN)}</td><td className="r">{totDays ?? '—'}</td></tr>}
                </tbody>
              </table></div>
            ) : (
              <div className="ov-list">
                {rows.map((r) => (
                  <Row2 key={r.m.id} to={`/kho?model=${r.m.id}&tt=sold`}
                    a={<Ident id={r.m.code_prefix} text={r.m.name} />}
                    b={<Money n={r.p} prefix="lãi " />}
                    c={<Tx>{r.n} chiếc · DT {tr(r.rev)} · {pctOf(r.p, r.rev)}</Tx>}
                    d={r.avgDays != null ? `TB ${r.avgDays} ngày` : ''} />
                ))}
                {rows.length > 1 && <Row2 a={<Tx><b>Tổng</b></Tx>} b={<Money n={tot.p} prefix="lãi " />} c={<Tx>{tot.n} chiếc · DT {tr(tot.rev)} · {pctOf(tot.p, tot.rev)}</Tx>} d={totDays != null ? `TB ${totDays} ngày` : ''} />}
              </div>
            )}
          <HowTo>
            Tính trên chiếc Đã bán (đơn Đã gửi / Hoàn tất) gửi trong kỳ. Lãi = Σ (giá chốt − giá nhập ₫) từng chiếc, chưa trừ ship shop chịu.
            % lãi = lãi ÷ doanh thu. Tỷ lệ bán = đã bán ÷ (đã bán + còn trong kho). Ngày tồn TB = trung bình số ngày từ ngày nhận lô tới ngày gửi hàng. Tổng vốn tồn: {vnd(onHand.reduce((a, u) => a + u.cost_vnd, 0))}.
          </HowTo>
        </div>
      </div>
    </Shell>
  )
}
