import { Link } from 'react-router-dom'
import { useData, useStore } from '../data/store.tsx'
import { Icon } from '../ui/icons.tsx'
import { NAV, Shell } from '../ui/Shell.tsx'
import { tr } from '../ui/format.ts'

// Menu (điện thoại): các mục ngoài 4 tab (CR-005: bỏ Báo cáo + Người bán; Sổ quỹ hiện số dư quỹ). CR-004: mỗi mục ≥ 52px, 2 dòng (tên · mô tả ngắn cắt …), số bên phải (research §10).
export default function MoreMenu() {
  const d = useData()
  const { signOut } = useStore()
  const cash = d.cashBalance?.balance_vnd ?? 0
  const debt = d.balance.balance_vnd
  const info: Record<string, [string, string | null]> = {
    '/congno': [`Thu chi, quỹ${debt > 0 ? ` · nợ trung gian ${tr(debt)}` : ''}`, `${cash < 0 ? '−' : ''}${tr(Math.abs(cash))}`],
    '/khach': ['Khách Facebook, công nợ', `${d.customers.filter((c) => !c.is_hidden).length}`],
    '/danhmuc': ['Tiền tố mã, giá mặc định, ngưỡng sắp hết', `${d.models.filter((m) => m.is_active).length}`],
    '/caidat': ['Giao diện, AI, ngưỡng ngày, STK, xuất Excel', null],
  }
  return (
    <Shell section="" title="Menu">
      <div className="list">
        {NAV.slice(4).map(([h, t, , ic]) => (
          <Link key={h} className="li" to={h}><span className="gpic"><Icon name={ic} /></span>
            <div className="main"><b>{t}</b>{info[h] && <div className="s">{info[h][0]}</div>}</div>
            {info[h]?.[1] != null && <span className="v">{info[h][1]}</span>}<Icon name="chev" size={16} /></Link>
        ))}
        <button className="li" onClick={signOut}><span className="gpic"><Icon name="back" /></span><div className="main"><b>Đăng xuất</b></div></button>
      </div>
    </Shell>
  )
}
