import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { useStore } from '../data/store.tsx'
import Login from '../screens/Login.tsx'
import Home from '../screens/Home.tsx'
import Kho from '../screens/Kho.tsx'
import UnitDetail from '../screens/UnitDetail.tsx'
import Lots from '../screens/Lots.tsx'
import LotDetail from '../screens/LotDetail.tsx'
import LotNew from '../screens/LotNew.tsx'
import Orders from '../screens/Orders.tsx'
import OrderDetail from '../screens/OrderDetail.tsx'
import OrderNew from '../screens/OrderNew.tsx'
import Debt from '../screens/Debt.tsx'
import Reports from '../screens/Reports.tsx'
import Sellers from '../screens/Sellers.tsx'
import SellerDetail from '../screens/SellerDetail.tsx'
import Customers from '../screens/Customers.tsx'
import Catalog from '../screens/Catalog.tsx'
import Settings from '../screens/Settings.tsx'
import MoreMenu from '../screens/MoreMenu.tsx'
import Notes from '../screens/Notes.tsx'

export default function App() {
  const { session, data, loading, error, reload } = useStore()
  if (loading && !data) return <div className="loading"><span className="spin" />Đang tải…</div>
  if (!session) return <Login />
  if (!data) return <div className="loading"><div className="err-text">{error ?? 'Không tải được dữ liệu.'}</div><button className="btn btn-ghost" onClick={reload}>Thử lại</button></div>
  return (
    <HashRouter>
      <div id="app">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/kho" element={<Kho />} />
          <Route path="/kho/:id" element={<UnitDetail />} />
          <Route path="/lo" element={<Lots />} />
          <Route path="/lo/new" element={<LotNew />} />
          <Route path="/lo/:id" element={<LotDetail />} />
          <Route path="/lo/:id/sua" element={<LotNew />} />
          <Route path="/don" element={<Orders />} />
          <Route path="/don/new" element={<OrderNew />} />
          <Route path="/don/:id" element={<OrderDetail />} />
          <Route path="/don/:id/sua" element={<OrderNew />} />
          <Route path="/congno" element={<Debt />} />
          <Route path="/baocao" element={<Reports />} />
          <Route path="/nguoiban" element={<Sellers />} />
          <Route path="/nguoiban/:id" element={<SellerDetail />} />
          <Route path="/khach" element={<Customers />} />
          <Route path="/danhmuc" element={<Catalog />} />
          <Route path="/caidat" element={<Settings />} />
          <Route path="/ghichu" element={<Notes />} />
          <Route path="/them" element={<MoreMenu />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </HashRouter>
  )
}
