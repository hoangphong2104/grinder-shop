// Khung trang (hướng A + C + D, prototype v2.2): máy tính = menu trái; điện thoại = header + tab đáy có nút + giữa.
import { useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useData, useStore } from '../data/store.tsx'
import { Brandmark, Icon } from './icons.tsx'
import { Sheet } from './feedback.tsx'

export type Section = 'home' | 'kho' | 'don' | 'ghichu' | 'congno' | 'khach' | 'dbkho' | 'danhmuc' | 'caidat' | ''
// CR-006: Lô nhập gộp vào Kho (/kho?tt=tq) → tab đáy điện thoại: Tổng quan, Kho, +, Đơn bán, Ghi chú, Sổ quỹ.
export const NAV: [string, string, Section, string][] = [
  ['/', 'Tổng quan', 'home', 'home'], ['/kho', 'Kho', 'kho', 'box'], ['/don', 'Đơn bán', 'don', 'receipt'], ['/ghichu', 'Ghi chú', 'ghichu', 'note'],
  ['/congno', 'Sổ quỹ', 'congno', 'wallet'],
  ['/khach', 'Khách', 'khach', 'user'], ['/danhbakho', 'Danh bạ kho', 'dbkho', 'store'],
  ['/danhmuc', 'Model', 'danhmuc', 'tag'], ['/caidat', 'Cài đặt', 'caidat', 'gear'],
]

/** CR-005 ý 3: quay lại = về đúng màn trước (lịch sử trong app); mở thẳng link (không có lịch sử) thì về màn cha. */
function goBack(nav: ReturnType<typeof useNavigate>, fallback: string) {
  const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0
  if (idx > 0) nav(-1); else nav(fallback, { replace: true })
}

export function Shell({ section, title, back, actions, savebar, children }: {
  section: Section; title: string; back?: string; actions?: ReactNode; savebar?: ReactNode; children: ReactNode
}) {
  const d = useData()
  const { session, online } = useStore()
  const nav = useNavigate()
  const [fab, setFab] = useState(false)
  const cnt: Partial<Record<Section, number>> = {
    kho: d.lots.filter((l) => l.status !== 'received' && l.status !== 'cancelled').length,
    don: d.orders.filter((o) => ['preorder', 'confirmed', 'shipped'].includes(o.status)).length,
  }
  const tab = ([h, t, k, ic]: (typeof NAV)[number]) => (
    <Link key={h} className="tab" to={h} aria-current={k === section ? 'page' : undefined}><Icon name={ic} /><span>{t}</span></Link>
  )
  return (
    <>
      <nav className="side" aria-label="Điều hướng">
        <div className="brand"><Brandmark />Grinder Shop</div>
        <div className="acts">
          <Link className="btn btn-primary" to="/lo/new"><Icon name="plus" /> Nhập cối</Link>
          <Link className="btn btn-ghost" to="/don/new"><Icon name="plus" /> Đơn bán</Link>
        </div>
        {NAV.map((n, i) => (
          <span key={n[0]} style={{ display: 'contents' }}>
            {i === 4 && <div className="grp-t">Tiền</div>}
            {i === 5 && <div className="grp-t">Danh mục</div>}
            <Link to={n[0]} aria-current={n[2] === section ? 'page' : undefined}><Icon name={n[3]} />{n[1]}{cnt[n[2]] ? <span className="n">{cnt[n[2]]}</span> : null}</Link>
          </span>
        ))}
        <div className="foot">{session?.user.email}</div>
      </nav>
      <div className="content">
        {!online && <div className="banner-offline">Đang mất mạng - chỉ xem dữ liệu đã tải, chưa lưu được.</div>}
        <header className="hdr">
          {back
            ? <button className="icon-btn" onClick={() => goBack(nav, back)} aria-label="Quay lại"><Icon name="back" /></button>
            : <Link className="icon-btn menu-btn" to="/them" aria-label="Menu"><Icon name="menu" /></Link>}
          <h1>{title}</h1>
          <div className="act">{actions}</div>
        </header>
        <main className={`view ${savebar ? 'has-savebar' : ''}`}>
          {children}
          {savebar && <div className="savebar">{savebar}</div>}
        </main>
      </div>
      {!savebar && (
        <nav className="tabs" aria-label="Tab">
          {NAV.slice(0, 2).map(tab)}
          <button className="tab-fab" onClick={() => setFab(true)} aria-label="Thêm mới"><span className="fab"><Icon name="plus" strokeWidth={2} /></span></button>
          {NAV.slice(2, 5).map(tab)}
        </nav>
      )}
      {fab && (
        <Sheet title="Thêm mới" onClose={() => setFab(false)}>
          <div className="list">
            <Link className="li" to="/lo/new"><div className="main"><b>Nhập cối</b><div className="s">Dán link + ảnh chụp, AI điền sẵn</div></div><Icon name="chev" size={16} /></Link>
            <Link className="li" to="/don/new"><div className="main"><b>Đơn bán</b><div className="s">Khách Facebook, cọc, đặt trước</div></div><Icon name="chev" size={16} /></Link>
            <Link className="li" to="/congno?chuyen=1"><div className="main"><b>Ghi chuyển tiền trung gian</b><div className="s">Giảm công nợ</div></div><Icon name="chev" size={16} /></Link>
          </div>
        </Sheet>
      )}
    </>
  )
}
