import { Link } from 'react-router-dom'
import { useData, useStore } from '../data/store.tsx'
import { Icon } from '../ui/icons.tsx'
import { NAV, Shell } from '../ui/Shell.tsx'
import { tr } from '../ui/format.ts'

// Menu (điện thoại): các mục ngoài 4 tab.
export default function MoreMenu() {
  const d = useData()
  const { signOut } = useStore()
  return (
    <Shell section="" title="Menu">
      <div className="list">
        {NAV.slice(5).map(([h, t, , ic]) => (
          <Link key={h} className="li" to={h}><span className="gpic"><Icon name={ic} /></span><div className="main"><b>{t}</b></div>
            {h === '/congno' && <span className="v">{tr(d.balance.balance_vnd)}</span>}<Icon name="chev" size={16} /></Link>
        ))}
        <button className="li" onClick={signOut}><span className="gpic"><Icon name="back" /></span><div className="main"><b>Đăng xuất</b></div></button>
      </div>
    </Shell>
  )
}
