import { Link } from 'react-router-dom'
import { useData, useStore } from '../data/store.tsx'
import { Icon } from '../ui/icons.tsx'
import { NAV, Shell } from '../ui/Shell.tsx'
import { todayVn, tr } from '../ui/format.ts'
import { profitMonth } from './overview/common.tsx'

// Menu (điện thoại): các mục ngoài 4 tab. CR-004: mỗi mục ≥ 52px, 2 dòng (tên · mô tả ngắn cắt …), số bên phải (research §10).
export default function MoreMenu() {
  const d = useData()
  const { signOut } = useStore()
  const month = todayVn().slice(0, 7)
  const profit = d.orderSummary.filter((o) => profitMonth(o) === month).reduce((a, o) => a + (o.profit_vnd ?? 0), 0)
  const bal = d.balance.balance_vnd
  const info: Record<string, [string, string | null]> = {
    '/congno': [bal > 0 ? 'Còn phải trả trung gian' : bal < 0 ? 'Đã chuyển dư' : 'Không còn nợ', tr(bal)],
    '/baocao': [`Lãi tháng ${Number(month.slice(5))}, tuổi tồn, theo model`, tr(profit)],
    '/nguoiban': ['Uy tín, đánh dấu tránh', `${d.sellers.filter((s) => !s.is_hidden).length}`],
    '/khach': ['Khách Facebook, công nợ', `${d.customers.filter((c) => !c.is_hidden).length}`],
    '/danhmuc': ['Tiền tố mã, giá mặc định, ngưỡng sắp hết', `${d.models.filter((m) => m.is_active).length}`],
    '/caidat': ['Giao diện, AI, ngưỡng ngày, STK, xuất Excel', null],
  }
  return (
    <Shell section="" title="Menu">
      <div className="list">
        {NAV.slice(5).map(([h, t, , ic]) => (
          <Link key={h} className="li" to={h}><span className="gpic"><Icon name={ic} /></span>
            <div className="main"><b>{t}</b>{info[h] && <div className="s">{info[h][0]}</div>}</div>
            {info[h]?.[1] != null && <span className="v">{info[h][1]}</span>}<Icon name="chev" size={16} /></Link>
        ))}
        <button className="li" onClick={signOut}><span className="gpic"><Icon name="back" /></span><div className="main"><b>Đăng xuất</b></div></button>
      </div>
    </Shell>
  )
}
