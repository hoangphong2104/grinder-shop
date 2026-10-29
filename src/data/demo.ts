// CHỈ DÙNG KHI DEV - dữ liệu mẫu để xem giao diện mà không cần đăng nhập Supabase.
// Bật bằng `?demo` trên URL khi chạy `npm run dev` (vd. http://localhost:5173/?demo#/kho).
// store.tsx chỉ gọi file này sau điều kiện `import.meta.env.DEV` ⇒ bản build production loại bỏ hoàn toàn.
//
// Mọi dòng view (v_units, v_model_stock, v_lot_summary, v_order_summary, v_intermediary_balance, v_suggestions)
// được TÍNH bằng hàm domain (cost / units / orders / debt) cho số liệu khớp nhau, theo đúng định nghĩa view SQL
// (supabase/v2/001_schema_v2.sql + 002_buying_fee.sql + 003_cod_return_condition.sql). Ngày tháng tính lùi từ hôm nay
// (giờ VN) để luôn "mới". CR-004: có tình trạng chiếc, khoản thu tiền mặt / COD, 1 đơn COD chờ về, 1 đơn Hoàn hàng.
// CR-005 (005_cash_status_qr.sql): lô Kho TQ / Kho VN / Kho Lumi; khoản Đã chuyển gắn lô (lô trả đủ, lô còn nợ ship, lô chưa trả);
// sổ quỹ = bút toán tự sinh (giống trigger DB, kiểm chéo bằng domain autoCashEntries / cashBalance) + ghi tay; cài đặt VietQR mẫu.
import type { Session } from '@supabase/supabase-js'
import {
  buildUnitViews, lotBuyingFeeVnd, lotGoodsCny, lotGoodsVnd, lotPayable, modelStocks, orderGoodsTotal, orderPaid,
  orderProfit, orderReceivable, orderRefundDue, orderShipCharged, effectiveCosts, roundVnd, intermediaryBalance,
  isLotLate, orderCodPending, orderCodReceived, orderDeposits, orderKept, orderProfitDate, DEFAULT_AGING, DEFAULT_LOT_LATE_DAYS,
  autoCashEntries, cashBalance, cashByMonth, lotOutstanding, lotPaid,
  type CashEntry, type Lot, type Model, type Order, type PaymentKind, type Transfer, type Unit,
} from '../domain/index.ts'
import type {
  BalanceRow, CashBalanceRow, CashEntryRow, CashKindDb, CashMonthlyRow, CustomerRow, DbData, LotRow, LotStatusDb, LotSummaryRow, ModelRow, ModelStockRow, NoteRow, OrderLineRow,
  OrderRow, OrderStatusDb, OrderSummaryRow, PaymentMethodDb, PaymentRow, SellerRow, SettingsRow, ShipPayerDb, SuggestionsRow, TxnRow,
  UnitConditionDb, UnitRow, UnitViewRow, WarehouseRow,
} from './types.ts'

const UID = 'demo-user'
const EMAIL = 'demo@local'

/* ---------- Ngày giờ ---------- */

/** Hôm nay theo giờ VN (YYYY-MM-DD) - giống ui/format.todayVn, viết lại để tầng data không phụ thuộc ui. */
const todayVn = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date())
/** Cộng / trừ ngày trên chuỗi ISO (theo lịch, không lệch múi giờ). */
function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
/** Mốc thời gian (timestamptz) dạng ISO UTC của ngày `date`, giờ VN `hh`. */
const stamp = (date: string, hh = 9, mm = 0) =>
  new Date(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+07:00`).toISOString()

/* ---------- Phiên giả (Shell hiện email demo@local) ---------- */

export function demoSession(): Session {
  const now = new Date().toISOString()
  return {
    access_token: 'demo', refresh_token: 'demo', expires_in: 3600, token_type: 'bearer',
    user: { id: UID, email: EMAIL, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: now },
  }
}

/* ---------- Mô tả dữ liệu mẫu (gọn, rồi dựng thành dòng DB) ---------- */

interface UnitSpec { model: string; cny: number; serial?: string; note?: string; override?: number; list?: number; cond?: UnitConditionDb }
interface LotSpec {
  id: string; ago: number; receivedAgo?: number; status: LotStatusDb; rate: number; ship: number | null; fee: number
  seller: string | null; title: string | null; itemId: string | null; note?: string; units: UnitSpec[]
}
interface OrderSpec {
  id: string; customer: string; ago: number; status: OrderStatusDb; shippedAgo?: number; completedAgo?: number; forced?: boolean
  cancelledAgo?: number; ship: number; payer: ShipPayerDb; tracking?: string; note?: string
  /** CR-004: COD hãng thu hộ; Hoàn hàng (returnedAgo + phí ship về + giữ cọc) */
  cod?: number; returnedAgo?: number; returnShip?: number; keepDeposit?: boolean; returnNote?: string
  lines: [code: string, price: number][]; pays: [kind: PaymentKind, amount: number, ago: number, note?: string, method?: PaymentMethodDb][]
}

const MODELS: { id: string; name: string; brand: string; prefix: string; price: number | null; low: number; aliases: string[] }[] = [
  { id: 'demo-m-zp6', name: 'ZP6 Special', brand: '1Zpresso', prefix: 'ZP6', price: 4600000, low: 3, aliases: ['ZP6', 'ZP6S', 'ZP-6'] },
  { id: 'demo-m-ku', name: 'K Ultra', brand: '1Zpresso', prefix: 'KU', price: 6800000, low: 1, aliases: ['KU', 'K-Ultra', 'Kultra'] },
  { id: 'demo-m-ju', name: 'J Ultra', brand: '1Zpresso', prefix: 'JU', price: 7200000, low: 1, aliases: ['JU', 'J-Ultra', 'Jultra'] },
  // Model tên rất dài, chưa có giá mặc định - thử độ co giãn của bố cục
  { id: 'demo-m-c3', name: 'Timemore Chestnut C3S Pro Max Phiên Bản Giới Hạn Màu Xám Đá Granite', brand: 'Timemore', prefix: 'C3PM', price: null, low: 2, aliases: ['C3S Pro', 'C3 Max'] },
]

const SELLERS: { id: string; nickname: string; region: string | null; url: string | null; rep: string | null; avoided?: boolean; hidden?: boolean }[] = [
  { id: 'demo-s-1', nickname: '咖啡小王子', region: '浙江 杭州', url: 'https://www.goofish.com/personal?userId=2201001', rep: 'Đóng gói kỹ, trả lời nhanh' },
  { id: 'demo-s-2', nickname: '1Zpresso官方授权二手店铺_限时清仓_不议价请勿打扰_谢谢合作', region: '广东 深圳', url: 'https://www.goofish.com/personal?userId=2201002', rep: 'Shop lớn, hàng gần như mới, hay có KU' },
  { id: 'demo-s-3', nickname: '老李的磨豆机', region: '上海', url: null, rep: 'Giao chậm 2 lần, hộp móp - TRÁNH', avoided: true },
  { id: 'demo-s-4', nickname: '手冲爱好者阿杰', region: '北京 朝阳', url: 'https://www.goofish.com/personal?userId=2201004', rep: null },
  { id: 'demo-s-5', nickname: '旧物回收站', region: null, url: null, rep: 'Không còn bán đồ pha cà phê', hidden: true },
]

const CUSTOMERS: { id: string; name: string; url: string | null; phone: string | null; address: string | null; note?: string; hidden?: boolean }[] = [
  { id: 'demo-c-1', name: 'Trần Minh Khoa', url: 'https://facebook.com/khoa.tran.coffee', phone: '0903 456 789', address: '12 Nguyễn Thị Minh Khai, P. Đa Kao, Q.1, TP.HCM', note: 'Khách quen, mua lần 2' },
  { id: 'demo-c-2', name: 'Nguyễn Hoàng Bảo Ngọc (Ngọc Cà Phê Rang Xay Thủ Công Đà Lạt) 🌿', url: 'https://facebook.com/ngoc.caphe.dalat.rangxay', phone: '0918 222 333',
    address: 'Hẻm 45/12/7 đường Phan Đình Phùng, Phường 2, TP. Đà Lạt, Lâm Đồng - gọi trước khi giao, nhà trong hẻm nhỏ xe tải không vào được' },
  { id: 'demo-c-3', name: 'Lê Quang Huy', url: null, phone: '0987 111 222', address: '88 Trần Phú, Hải Châu, Đà Nẵng' },
  { id: 'demo-c-4', name: 'Phạm Thu Hà', url: 'https://facebook.com/thuha.pham', phone: null, address: 'Số 5 ngõ 102 Trường Chinh, Đống Đa, Hà Nội' },
  { id: 'demo-c-5', name: 'Võ Đức Thắng', url: null, phone: '0935 678 910', address: null },
  { id: 'demo-c-6', name: 'Đặng Gia Bảo', url: 'https://facebook.com/giabao.dang', phone: '0909 000 111', address: '210 Lý Thường Kiệt, Q.10, TP.HCM', note: 'Đã huỷ 1 đơn, còn chờ hoàn cọc' },
  { id: 'demo-c-7', name: 'Hoàng Thị Phương Thảo – Tiệm Bánh & Cà Phê Nhà Thảo – Chi Nhánh Biên Hòa Đồng Nai', url: 'https://facebook.com/nhathao.bakery.coffee.bienhoa', phone: '0977 888 999',
    address: 'Lô B12, Khu dân cư Bửu Long mở rộng, đường Huỳnh Văn Nghệ, Phường Bửu Long, TP. Biên Hòa, tỉnh Đồng Nai (giao giờ hành chính)' },
  { id: 'demo-c-8', name: 'Khách lẻ (ẩn)', url: null, phone: null, address: null, hidden: true },
]

const LOTS: LotSpec[] = [
  { id: 'demo-l-1', ago: 60, receivedAgo: 48, status: 'received', rate: 3560, ship: 1000000, fee: 0, seller: 'demo-s-1',
    title: '1Zpresso ZP6 Special 手摇磨豆机 9成新 4台', itemId: '780011223301',
    units: [{ model: 'demo-m-zp6', cny: 760, cond: 'like_new' }, { model: 'demo-m-zp6', cny: 760, cond: 'like_new' }, { model: 'demo-m-zp6', cny: 760, serial: 'ZP6S-2409-118', cond: 'used' },
      { model: 'demo-m-zp6', cny: 760, cond: 'defect', serial: 'ZP6S-2409-121-SN-BATCH-A-0000000045-RECHECK', note: 'Tay quay hơi lỏng, đã siết lại; kèm cọ vệ sinh và túi vải gốc. Khách hỏi nhiều nhưng chưa chốt, ưu tiên bán cho khách quen.' }] },
  { id: 'demo-l-2', ago: 45, receivedAgo: 33, status: 'received', rate: 3580, ship: 840000, fee: 3, seller: 'demo-s-2',
    title: '【正品保障】1Zpresso K-Ultra 手摇磨豆机 意式手冲两用 外圆内锥 全新未拆封 原装配件齐全 支持验货 包邮 三台一起出 可单独拍 不议价', itemId: '780011223302',
    note: 'Người bán giao nhanh, có hoá đơn gốc.',
    units: [{ model: 'demo-m-ku', cny: 1080 }, { model: 'demo-m-ku', cny: 1080, note: 'Hộp móp nhẹ', cond: 'like_new' },
      { model: 'demo-m-ku', cny: 1080, override: 4200000, note: 'Thêm phí sửa núm chỉnh + thay ron' }] },
  { id: 'demo-l-3', ago: 30, receivedAgo: 18, status: 'received', rate: 3600, ship: 1250000, fee: 2.5, seller: 'demo-s-4',
    title: '磨豆机 打包出 J-Ultra ×2 ZP6 ×2 泰摩 C3S Pro Max ×1', itemId: '780011223303',
    units: [{ model: 'demo-m-ju', cny: 1150, list: 7300000 }, { model: 'demo-m-ju', cny: 1150 }, { model: 'demo-m-zp6', cny: 740, list: 4500000 },
      { model: 'demo-m-zp6', cny: 740, list: 4550000 }, { model: 'demo-m-c3', cny: 420, list: 2200000, serial: 'TM-C3SPM-GR-20240917-000123456' }] },
  { id: 'demo-l-4', ago: 20, receivedAgo: 8, status: 'received', rate: 3610, ship: 720000, fee: 0, seller: 'demo-s-1',
    title: 'K Ultra 磨豆机 3台', itemId: '780011223304',
    units: [{ model: 'demo-m-ku', cny: 1010, list: 6700000 }, { model: 'demo-m-ku', cny: 1010, override: 3900000, note: 'Giá nhập sửa tay - được người bán giảm thêm ¥30 sau khi trả' },
      { model: 'demo-m-ku', cny: 1010 }] },
  { id: 'demo-l-5', ago: 15, status: 'cancelled', rate: 3612, ship: null, fee: 0, seller: 'demo-s-3',
    title: 'K-Ultra 二手 成色好', itemId: '780011223305', note: 'Người bán không giao, đã hoàn tiền qua trung gian.',
    units: [{ model: 'demo-m-ku', cny: 990 }] },
  { id: 'demo-l-6', ago: 12, status: 'vn_warehouse', rate: 3615, ship: null, fee: 3, seller: 'demo-s-2',
    title: '1Zpresso K-Ultra 全新 3台 现货', itemId: '780011223306',
    units: [{ model: 'demo-m-ku', cny: 1050, list: 7000000 }, { model: 'demo-m-ku', cny: 1050, list: 6900000 }, { model: 'demo-m-ku', cny: 1050, list: 6900000 }] },
  { id: 'demo-l-7', ago: 8, status: 'cn_warehouse', rate: 3620, ship: 500000, fee: 0, seller: 'demo-s-4',
    title: 'J-Ultra 2台', itemId: '780011223307',
    units: [{ model: 'demo-m-ju', cny: 1180, list: 7400000 }, { model: 'demo-m-ju', cny: 1180 }] },
  { id: 'demo-l-8', ago: 5, status: 'cn_warehouse', rate: 3625, ship: null, fee: 0, seller: 'demo-s-1',
    title: 'ZP6 Special ×2 + 泰摩 C3S Pro Max', itemId: '780011223308',
    units: [{ model: 'demo-m-zp6', cny: 745.5 }, { model: 'demo-m-zp6', cny: 745.5 }, { model: 'demo-m-c3', cny: 435, list: 2250000 }] },
  { id: 'demo-l-9', ago: 2, status: 'cn_warehouse', rate: 3630, ship: null, fee: 0, seller: null,
    title: null, itemId: null, note: 'Đặt qua Zalo người quen, chưa có link Goofish.',
    units: [{ model: 'demo-m-ju', cny: 1200 }] },
]

// Đơn xếp theo ngày tạo (mã D-001… theo thứ tự này)
const ORDERS: OrderSpec[] = [
  { id: 'demo-o-1', customer: 'demo-c-1', ago: 50, status: 'completed', shippedAgo: 47, completedAgo: 43, ship: 35000, payer: 'shop', tracking: 'GHN 8823 4471 09',
    cod: 3600000, lines: [['ZP6-001', 4600000]], pays: [['deposit', 1000000, 50, undefined, 'cash'], ['payment', 3600000, 44, 'GHN chuyển COD', 'cod']] },
  { id: 'demo-o-2', customer: 'demo-c-2', ago: 42, status: 'completed', shippedAgo: 41, completedAgo: 37, ship: 40000, payer: 'customer', tracking: 'GHTK S19.A2.774512',
    note: 'Khách chuyển dư 10.000 ₫ - hẹn trừ vào đơn sau', lines: [['ZP6-002', 4650000]], pays: [['payment', 4700000, 41, 'CK Techcombank']] },
  { id: 'demo-o-3', customer: 'demo-c-3', ago: 26, status: 'shipped', shippedAgo: 25, ship: 45000, payer: 'shop', tracking: 'VNPost EB123456789VN',
    cod: 4900000, lines: [['KU-001', 6900000]], pays: [['deposit', 2000000, 26]] },
  { id: 'demo-o-4', customer: 'demo-c-6', ago: 22, status: 'cancelled', cancelledAgo: 19, ship: 0, payer: 'shop',
    note: 'Khách đổi ý, đồng ý mất 500k cọc', lines: [['KU-003', 6800000]], pays: [['deposit', 1500000, 22], ['refund', 500000, 18, 'Hoàn 1 phần']] },
  { id: 'demo-o-5', customer: 'demo-c-4', ago: 15, status: 'shipped', shippedAgo: 14, ship: 60000, payer: 'customer', tracking: 'GHN 8823 5520 11',
    lines: [['JU-001', 7300000], ['ZP6-005', 4500000]], pays: [['payment', 11860000, 14]] },
  { id: 'demo-o-6', customer: 'demo-c-3', ago: 10, status: 'preorder', ship: 0, payer: 'shop',
    note: 'Giữ chiếc KU đang về, khách lấy ngay khi hàng tới', lines: [['KU-008', 7000000]], pays: [['deposit', 2000000, 10]] },
  // CR-004: khách bom - hãng chuyển hoàn, shop giữ cọc 1tr, khoản trả thêm 300k phải hoàn
  { id: 'demo-o-11', customer: 'demo-c-5', ago: 9, status: 'returned', shippedAgo: 8, returnedAgo: 4, ship: 35000, payer: 'shop', tracking: 'GHTK S19.A2.889911',
    cod: 5500000, returnShip: 35000, keepDeposit: true, returnNote: 'Khách không nghe máy 3 lần, GHTK chuyển hoàn',
    lines: [['KU-002', 6800000]], pays: [['deposit', 1000000, 9], ['payment', 300000, 9]] },
  { id: 'demo-o-7', customer: 'demo-c-1', ago: 7, status: 'completed', shippedAgo: 6, completedAgo: 3, forced: true, ship: 0, payer: 'shop',
    note: 'Khách xin bớt 200k, đã đồng ý - hoàn tất dù còn thiếu', lines: [['KU-004', 6700000]], pays: [['payment', 6500000, 6]] },
  { id: 'demo-o-8', customer: 'demo-c-7', ago: 6, status: 'preorder', ship: 50000, payer: 'customer',
    lines: [['JU-003', 7400000]], pays: [['deposit', 3000000, 6]] },
  { id: 'demo-o-9', customer: 'demo-c-5', ago: 4, status: 'confirmed', ship: 30000, payer: 'customer',
    lines: [['ZP6-003', 4600000]], pays: [['deposit', 500000, 4]] },
  { id: 'demo-o-10', customer: 'demo-c-2', ago: 2, status: 'confirmed', ship: 30000, payer: 'customer',
    lines: [['ZP6-006', 4550000]], pays: [] },
]

// CR-005: amount 'payable' = trả đủ phải trả của lô; 'goods' = phải trả − phí ship (còn nợ ship); lot = khoản gắn lô.
// Lô L-007 còn nợ ship 500.000, L-009 chưa trả (nút "Đã thanh toán"); khoản ago 3 không gắn lô.
const TRANSFERS: { ago: number; kind: 'transfer' | 'adjustment'; amount: number | 'payable' | 'goods'; lot?: string; note: string | null }[] = [
  { ago: 59, kind: 'transfer', amount: 'payable', lot: 'demo-l-1', note: 'CK Vietcombank' },
  { ago: 44, kind: 'transfer', amount: 'payable', lot: 'demo-l-2', note: null },
  { ago: 29, kind: 'transfer', amount: 'payable', lot: 'demo-l-3', note: 'CK Techcombank - lô trộn JU/ZP6/C3' },
  { ago: 19, kind: 'transfer', amount: 'payable', lot: 'demo-l-4', note: null },
  { ago: 16, kind: 'adjustment', amount: 50000, note: 'Phí chuyển khoản quốc tế' },
  { ago: 12, kind: 'transfer', amount: 'payable', lot: 'demo-l-6', note: 'Trả khi tạo lô' },
  { ago: 8, kind: 'transfer', amount: 'goods', lot: 'demo-l-7', note: 'Trả tiền hàng, ship trả sau' },
  { ago: 7, kind: 'adjustment', amount: -120000, note: 'Trung gian giảm phí do giao trễ' },
  { ago: 5, kind: 'transfer', amount: 'payable', lot: 'demo-l-8', note: 'Trả khi tạo lô' },
  { ago: 3, kind: 'transfer', amount: 2000000, note: 'Ứng trước cho trung gian' },
]

// CR-005 sổ quỹ ghi tay (bút toán tự sinh dựng từ khoản thu / khoản trả / đơn bên dưới)
const CASH_MANUAL: { ago: number; kind: CashKindDb; dir: 'in' | 'out'; amount: number; cat?: string; note?: string }[] = [
  { ago: 75, kind: 'capital_in', dir: 'in', amount: 100000000, note: 'Vốn ban đầu' },
  { ago: 40, kind: 'expense', dir: 'out', amount: 180000, cat: 'Đóng gói', note: 'Hộp carton + xốp' },
  { ago: 20, kind: 'expense', dir: 'out', amount: 300000, cat: 'Quảng cáo', note: 'Boost bài Facebook' },
  { ago: 4, kind: 'capital_out', dir: 'out', amount: 5000000, note: 'Rút chi tiêu cá nhân' },
  { ago: 2, kind: 'adjustment', dir: 'in', amount: 20000, note: 'Lệch quỹ tiền mặt' },
]

const NOTES: { ago: number; pinned: boolean; body: string }[] = [
  { ago: 1, pinned: true, body: [
    'QUY TRÌNH NHẬN HÀNG (đọc kỹ trước khi mở thùng):',
    '1. Quay video lúc mở thùng, đủ 4 mặt hộp, có tem trung gian.',
    '2. Kiểm tra số serial dưới đáy cối, ghi vào ô Serial của từng chiếc - nếu serial không khớp hộp thì ghi chú lại và báo trung gian trong 24 giờ.',
    '3. Quay thử khô 20 vòng ở mỗi nấc: 1, 3, 5, 8 - nghe tiếng lạo xạo hoặc kẹt là để riêng, KHÔNG bán.',
    '4. Lau sạch burr bằng cọ, không dùng nước; phủ túi chống ẩm trước khi cất.',
    '5. Chụp 3 ảnh: toàn thân, burr, phụ kiện - đăng lên nhóm Facebook trong ngày.',
    '6. Nhập phí ship thật của lô ngay khi trung gian báo để giá nhập không còn tạm tính.',
    'Lưu ý: hàng của người bán 老李的磨豆机 đã 2 lần móp hộp, nếu thấy link của người này thì bỏ qua. Lô nào mua hộ có phí thì nhớ nhập phí % để công nợ khớp với trung gian. Cuối tháng đối chiếu số dư công nợ với tin nhắn Zalo của trung gian, chênh lệch thì ghi Điều chỉnh kèm lý do rõ ràng.',
  ].join('\n') },
  { ago: 3, pinned: true, body: 'Tỷ giá trung gian tuần này: 3.625 ₫/¥ (chưa gồm phí 3%).' },
  { ago: 5, pinned: false, body: 'Chị Thảo (Biên Hòa) muốn thêm 1 chiếc C3S Pro Max nếu về trước Tết.' },
  { ago: 9, pinned: false, body: 'Hỏi lại GHN về đơn bị trễ 2 ngày ở kho Đà Nẵng.' },
  { ago: 14, pinned: false, body: 'Mua thêm hộp carton 30×20×20 và xốp chống sốc.' },
  { ago: 27, pinned: false, body: 'Ý tưởng: làm combo cối + cân điện tử giảm 5%.' },
]

/* ---------- Dựng dữ liệu ---------- */

export function buildDemoData(): DbData {
  const today = todayVn()
  const ago = (n: number) => addDays(today, -n)
  const base = (id: string, date: string, hh = 9, mm = 0) => {
    const t = stamp(date, hh, mm)
    return { id, user_id: UID, created_at: t, updated_at: t, version: 1 }
  }

  // Người bán / khách
  const sellers: SellerRow[] = SELLERS.map((s, i) => ({
    ...base(s.id, ago(70 - i)), nickname: s.nickname, region: s.region, profile_url: s.url, reputation_note: s.rep,
    is_avoided: s.avoided ?? false, is_hidden: s.hidden ?? false,
  }))
  const customers: CustomerRow[] = CUSTOMERS.map((c, i) => ({
    ...base(c.id, ago(65 - i)), fb_name: c.name, fb_url: c.url, phone: c.phone, address: c.address, note: c.note ?? null, is_hidden: c.hidden ?? false,
  }))

  // Lô + chiếc (mã chiếc cấp theo model, theo thứ tự lô)
  const seq = new Map<string, number>(MODELS.map((m) => [m.id, 0]))
  const lots: LotRow[] = []
  const units: UnitRow[] = []
  const unitByCode = new Map<string, UnitRow>()
  for (const s of LOTS) {
    const ordered = ago(s.ago)
    lots.push({
      ...base(s.id, ordered, 10), goofish_url: s.itemId ? `https://www.goofish.com/item?id=${s.itemId}` : null, goofish_item_id: s.itemId,
      seller_id: s.seller, screenshot_path: null, listing_title: s.title, ordered_at: ordered, exchange_rate: s.rate, ship_fee_vnd: s.ship,
      status: s.status, received_at: s.receivedAgo != null ? ago(s.receivedAgo) : null,
      cancelled_at: s.status === 'cancelled' ? stamp(ago(s.ago - 3), 15) : null, note: s.note ?? null, buying_fee_pct: s.fee,
    })
    s.units.forEach((us, i) => {
      const m = MODELS.find((x) => x.id === us.model)!
      const n = seq.get(m.id)! + 1
      seq.set(m.id, n)
      const code = `${m.prefix}-${String(n).padStart(3, '0')}`
      const row: UnitRow = {
        ...base(`demo-u-${code.toLowerCase()}`, ordered, 10, i + 1), code, model_id: m.id, lot_id: s.id, price_cny: us.cny,
        cost_vnd_auto: 0, // tính bên dưới bằng domain
        cost_vnd_override: us.override ?? null, list_price_vnd: us.list ?? m.price, serial_no: us.serial ?? null, note: us.note ?? null,
        condition: us.cond ?? 'new',
      }
      units.push(row)
      unitByCode.set(code, row)
    })
  }

  const models: ModelRow[] = MODELS.map((m, i) => ({
    ...base(m.id, ago(90)), name: m.name, brand: m.brand, image_path: null, aliases: m.aliases, code_prefix: m.prefix,
    default_list_price_vnd: m.price, low_stock_threshold: m.low, next_seq: seq.get(m.id)! + 1, is_active: true, sort_order: i + 1,
  }))

  // Đơn + dòng đơn + thu tiền
  const orders: OrderRow[] = []
  const orderLines: OrderLineRow[] = []
  const payments: PaymentRow[] = []
  for (const o of ORDERS) {
    const date = ago(o.ago)
    orders.push({
      ...base(o.id, date, 14), customer_id: o.customer, order_date: date, status: o.status, tracking_no: o.tracking ?? null,
      ship_fee_vnd: o.ship, ship_fee_payer: o.payer, shipped_at: o.shippedAgo != null ? ago(o.shippedAgo) : null,
      completed_at: o.completedAgo != null ? stamp(ago(o.completedAgo), 18) : null, completion_forced: o.forced ?? false,
      cancelled_at: o.cancelledAgo != null ? stamp(ago(o.cancelledAgo), 16) : null, note: o.note ?? null,
      cod_amount_vnd: o.cod ?? 0, returned_at: o.returnedAgo != null ? ago(o.returnedAgo) : null, return_ship_fee_vnd: o.returnShip ?? 0,
      keep_deposit: o.keepDeposit ?? false, return_note: o.returnNote ?? null,
    })
    o.lines.forEach(([code, price], i) => {
      const u = unitByCode.get(code)
      if (!u) throw new Error(`demo: không có chiếc ${code}`)
      orderLines.push({ ...base(`${o.id}-l${i + 1}`, date, 14, i + 1), order_id: o.id, line_no: i + 1, unit_id: u.id, unit_price_vnd: price, cancelled: o.status === 'cancelled' || o.status === 'returned' })
    })
    o.pays.forEach(([kind, amount, pAgo, note, method], i) => {
      payments.push({ ...base(`${o.id}-p${i + 1}`, ago(pAgo), 15, i + 1), order_id: o.id, paid_at: ago(pAgo), kind, amount_vnd: amount, note: note ?? null, method: method ?? 'transfer' })
    })
  }

  // Ánh xạ sang kiểu domain để tính
  const dModels: Model[] = models.map((m) => ({ id: m.id, name: m.name, codePrefix: m.code_prefix, defaultListPrice: m.default_list_price_vnd, lowStockThreshold: m.low_stock_threshold, nextSeq: m.next_seq }))
  const dLots: Lot[] = lots.map((l) => ({ id: l.id, orderedAt: l.ordered_at, rate: l.exchange_rate, shipFee: l.ship_fee_vnd, buyingFeePct: l.buying_fee_pct, status: l.status, receivedAt: l.received_at }))
  const dUnits: Unit[] = units.map((u) => ({ id: u.id, code: u.code, modelId: u.model_id, lotId: u.lot_id, priceCny: u.price_cny, costOverride: u.cost_vnd_override, listPrice: u.list_price_vnd, serialNo: u.serial_no, note: u.note, condition: u.condition }))
  const orderCode = Object.fromEntries(orders.map((o, i) => [o.id, `D-${String(i + 1).padStart(3, '0')}`]))
  const lotCode = Object.fromEntries(lots.map((l, i) => [l.id, `L-${String(i + 1).padStart(3, '0')}`]))
  const dOrders: Order[] = orders.map((o) => ({
    id: o.id, code: orderCode[o.id], orderDate: o.order_date, status: o.status, shippedAt: o.shipped_at, shipFee: o.ship_fee_vnd, shipPayer: o.ship_fee_payer,
    lines: orderLines.filter((l) => l.order_id === o.id).map((l) => ({ unitId: l.unit_id, price: l.unit_price_vnd })),
    payments: payments.filter((p) => p.order_id === o.id).map((p) => ({ kind: p.kind, amount: p.amount_vnd, date: p.paid_at, method: p.method })),
    codAmount: o.cod_amount_vnd, returnedAt: o.returned_at, returnShipFee: o.return_ship_fee_vnd, keepDeposit: o.keep_deposit,
  }))

  // v_units
  const views = buildUnitViews(dUnits, dLots, dOrders, today, DEFAULT_AGING)
  for (const v of views) units.find((u) => u.id === v.unit.id)!.cost_vnd_auto = v.cost.auto
  const modelById = new Map(models.map((m) => [m.id, m]))
  const lotById = new Map(lots.map((l) => [l.id, l]))
  const orderById = new Map(orders.map((o) => [o.id, o]))
  const customerById = new Map(customers.map((c) => [c.id, c]))
  const unitView: UnitViewRow[] = views.map((v) => {
    const u = units.find((x) => x.id === v.unit.id)!
    const m = modelById.get(u.model_id)!
    const l = lotById.get(u.lot_id)!
    const h = v.holder ? orderById.get(v.holder.id)! : null
    const line = h ? orderLines.find((x) => x.order_id === h.id && x.unit_id === u.id && !x.cancelled) ?? null : null
    const sold = v.status === 'sold'
    return {
      unit_id: u.id, code: u.code, serial_no: u.serial_no, note: u.note, model_id: m.id, model_name: m.name, code_prefix: m.code_prefix,
      lot_id: l.id, lot_status: l.status, ordered_at: l.ordered_at, received_at: l.received_at, exchange_rate: l.exchange_rate,
      lot_ship_fee_vnd: l.ship_fee_vnd, goofish_item_id: l.goofish_item_id, seller_id: l.seller_id, price_cny: u.price_cny,
      cost_vnd_auto: v.cost.auto, cost_vnd_override: u.cost_vnd_override, cost_vnd: v.cost.effective, cost_is_overridden: v.cost.overridden,
      cost_is_provisional: v.cost.provisional, list_price_vnd: u.list_price_vnd, is_received: l.status === 'received', status: v.status,
      holding_order_line_id: line?.id ?? null, holding_order_id: h?.id ?? null, holding_order_status: h?.status ?? null,
      holding_customer_id: h?.customer_id ?? null, holding_customer_name: h ? customerById.get(h.customer_id)!.fb_name : null,
      order_unit_price_vnd: v.salePrice, sold_price_vnd: sold ? v.salePrice : null, sold_at: h?.shipped_at ?? null,
      // Như view SQL: lãi dự kiến = giá bán dự kiến − giá nhập hiệu lực
      expected_profit_vnd: u.list_price_vnd == null ? null : u.list_price_vnd - v.cost.effective,
      actual_profit_vnd: v.profit, days_in_stock: v.daysInStock, created_at: u.created_at, updated_at: u.updated_at, version: u.version,
      condition: u.condition, aging_level: v.agingLevel,
    }
  })

  // v_model_stock
  const modelStock: ModelStockRow[] = modelStocks(dModels, dUnits, dLots, dOrders).map((s) => {
    const m = modelById.get(s.modelId)!
    return {
      model_id: m.id, model_name: m.name, brand: m.brand, code_prefix: m.code_prefix, is_active: m.is_active, sort_order: m.sort_order,
      default_list_price_vnd: m.default_list_price_vnd, low_stock_threshold: m.low_stock_threshold,
      in_stock_count: s.inStock, incoming_count: s.incoming, reserved_count: s.reserved,
      reserved_received_count: unitView.filter((x) => x.model_id === m.id && x.status === 'reserved' && x.is_received).length,
      on_hand_count: s.onHand, sold_count: s.sold, sellable_count: s.sellable, stock_value_vnd: s.stockValue, is_low_stock: s.lowStock,
      incoming_value_vnd: s.incomingValue, total_capital_vnd: s.totalCapital,
    }
  })

  // Giao dịch trung gian: "phải trả" tự sinh từ mỗi lô (lô huỷ = 0) + chuyển tiền (CR-005: có thể gắn lô) / điều chỉnh nhập tay
  const payable = new Map(dLots.map((l) => [l.id, lotPayable(l, dUnits)]))
  const transferAmount = (t: (typeof TRANSFERS)[number]) =>
    t.amount === 'payable' ? payable.get(t.lot!)! : t.amount === 'goods' ? payable.get(t.lot!)! - (lotById.get(t.lot!)!.ship_fee_vnd ?? 0) : t.amount
  const txns: TxnRow[] = [
    ...lots.map((l): TxnRow => ({ ...base(`demo-t-pay-${l.id}`, l.ordered_at, 10, 30), txn_date: l.ordered_at, kind: 'payable', amount_vnd: payable.get(l.id)!, lot_id: l.id, note: 'Tự sinh từ lô' })),
    ...TRANSFERS.map((t, i): TxnRow => ({ ...base(`demo-t-${i + 1}`, ago(t.ago), 11), txn_date: ago(t.ago), kind: t.kind, amount_vnd: transferAmount(t), lot_id: t.lot ?? null, note: t.note })),
  ].sort((a, b) => a.txn_date.localeCompare(b.txn_date) || a.created_at.localeCompare(b.created_at))
  const dTransfers: Transfer[] = txns.filter((t) => t.kind !== 'payable')
    .map((t) => ({ id: t.id, date: t.txn_date, kind: t.kind as Transfer['kind'], amount: t.amount_vnd, lotId: t.lot_id, note: t.note ?? undefined }))

  // v_lot_summary
  const sellerById = new Map(sellers.map((s) => [s.id, s]))
  const lotSummary: LotSummaryRow[] = lots.map((l) => {
    const dl = dLots.find((x) => x.id === l.id)!
    const uv = unitView.filter((x) => x.lot_id === l.id)
    const qty = uv.length
    const byModel = new Map<string, { model_id: string; model_name: string; qty: number }>()
    for (const x of uv) {
      const g = byModel.get(x.model_id) ?? { model_id: x.model_id, model_name: x.model_name, qty: 0 }
      g.qty++
      byModel.set(x.model_id, g)
    }
    const count = (st: UnitViewRow['status']) => uv.filter((x) => x.status === st).length
    return {
      lot_id: l.id, status: l.status, ordered_at: l.ordered_at, received_at: l.received_at, exchange_rate: l.exchange_rate, ship_fee_vnd: l.ship_fee_vnd,
      seller_id: l.seller_id, seller_nickname: l.seller_id ? sellerById.get(l.seller_id)!.nickname : null, goofish_url: l.goofish_url,
      goofish_item_id: l.goofish_item_id, listing_title: l.listing_title, screenshot_path: l.screenshot_path, note: l.note, version: l.version,
      total_qty: qty, total_cny: lotGoodsCny(dl, dUnits), goods_vnd: lotGoodsVnd(dl, dUnits),
      ship_per_unit_vnd: qty > 0 && l.ship_fee_vnd != null ? roundVnd(l.ship_fee_vnd / qty) : null,
      payable_vnd: payable.get(l.id)!, cost_is_provisional: l.ship_fee_vnd == null, total_cost_vnd: uv.reduce((a, x) => a + x.cost_vnd, 0),
      incoming_count: count('incoming'), in_stock_count: count('in_stock'), reserved_count: count('reserved'), sold_count: count('sold'),
      models: [...byModel.values()].sort((a, b) => a.model_name.localeCompare(b.model_name)),
      buying_fee_pct: l.buying_fee_pct, buying_fee_vnd: lotBuyingFeeVnd(dl, dUnits),
      is_lot_late: isLotLate(dl, today, DEFAULT_LOT_LATE_DAYS),
      paid_vnd: lotPaid(l.id, dTransfers), outstanding_vnd: lotOutstanding(dl, dUnits, dTransfers),
    }
  })

  // v_order_summary
  const costs = effectiveCosts(dUnits, dLots)
  const unitById = new Map(units.map((u) => [u.id, u]))
  const orderSummary: OrderSummaryRow[] = orders.map((o) => {
    const d = dOrders.find((x) => x.id === o.id)!
    const lines = orderLines.filter((x) => x.order_id === o.id).sort((a, b) => a.line_no - b.line_no)
    const lineUnits = lines.map((x) => unitById.get(x.unit_id)!)
    return {
      order_id: o.id, customer_id: o.customer_id, customer_name: customerById.get(o.customer_id)!.fb_name, status: o.status,
      order_date: o.order_date, shipped_at: o.shipped_at, completed_at: o.completed_at, completion_forced: o.completion_forced,
      cancelled_at: o.cancelled_at, tracking_no: o.tracking_no, ship_fee_vnd: o.ship_fee_vnd, ship_fee_payer: o.ship_fee_payer, note: o.note,
      version: o.version, unit_count: lines.length, unit_codes: lineUnits.map((u) => u.code),
      all_units_received: lineUnits.length > 0 && lineUnits.every((u) => lotById.get(u.lot_id)!.status === 'received'),
      goods_vnd: orderGoodsTotal(d), cost_vnd: lineUnits.reduce((a, u) => a + costs.get(u.id)!, 0), ship_charged_vnd: orderShipCharged(d),
      paid_vnd: orderPaid(d), receivable_vnd: orderReceivable(d), refund_due_vnd: orderRefundDue(d), profit_vnd: orderProfit(d, costs),
      cod_amount_vnd: o.cod_amount_vnd, cod_received_vnd: orderCodReceived(d), cod_pending_vnd: orderCodPending(d), deposit_vnd: orderDeposits(d),
      returned_at: o.returned_at, return_ship_fee_vnd: o.return_ship_fee_vnd, keep_deposit: o.keep_deposit, return_note: o.return_note,
      kept_vnd: orderKept(d), profit_date: orderProfitDate(d),
    }
  })

  // v_intermediary_balance - kiểm chéo với domain (Σ phải trả từ lô) để chắc số liệu khớp
  const sum = (k: TxnRow['kind']) => txns.reduce((a, t) => a + (t.kind === k ? t.amount_vnd : 0), 0)
  const balance: BalanceRow = {
    total_payable_vnd: sum('payable'), total_transferred_vnd: sum('transfer'), total_adjustment_vnd: sum('adjustment'),
    balance_vnd: sum('payable') - sum('transfer') + sum('adjustment'),
  }
  const check = intermediaryBalance(dLots, dUnits, dTransfers)
  if (check.balance !== balance.balance_vnd) throw new Error('demo: công nợ không khớp domain')

  // CR-005 sổ quỹ: bút toán tự sinh (như trigger DB: khoản thu, khoản Đã chuyển > 0, ship shop chịu khi đã gửi, ship chiều về)
  const cashEntries: CashEntryRow[] = []
  const cash = (id: string, date: string, e: Omit<CashEntryRow, keyof ReturnType<typeof base> | 'entry_date' | 'expense_category' | 'note' | 'payment_id' | 'txn_id' | 'order_id' | 'lot_id'> & Partial<CashEntryRow>) =>
    cashEntries.push({ expense_category: null, note: null, payment_id: null, txn_id: null, order_id: null, lot_id: null, ...base(id, date, 12), entry_date: date, ...e })
  for (const p of payments) {
    const refund = p.kind === 'refund'
    cash(`demo-ce-${p.id}`, p.paid_at, { direction: refund ? 'out' : 'in', kind: refund ? 'customer_refund' : 'customer_payment', amount_vnd: p.amount_vnd, note: p.note, payment_id: p.id, order_id: p.order_id, is_auto: true })
  }
  for (const t of txns) {
    if (t.kind === 'transfer' && t.amount_vnd > 0) cash(`demo-ce-${t.id}`, t.txn_date, { direction: 'out', kind: 'intermediary', amount_vnd: t.amount_vnd, note: t.note, txn_id: t.id, lot_id: t.lot_id, is_auto: true })
  }
  for (const o of orders) {
    if (['shipped', 'completed', 'returned'].includes(o.status) && o.ship_fee_payer === 'shop' && o.ship_fee_vnd > 0)
      cash(`demo-ce-ship-${o.id}`, o.shipped_at!, { direction: 'out', kind: 'ship_shop', amount_vnd: o.ship_fee_vnd, order_id: o.id, is_auto: true })
    if (o.status === 'returned' && o.return_ship_fee_vnd > 0)
      cash(`demo-ce-ret-${o.id}`, o.returned_at!, { direction: 'out', kind: 'return_ship', amount_vnd: o.return_ship_fee_vnd, order_id: o.id, is_auto: true })
  }
  CASH_MANUAL.forEach((m, i) => cash(`demo-ce-m${i + 1}`, ago(m.ago), { direction: m.dir, kind: m.kind, amount_vnd: m.amount, expense_category: m.cat ?? null, note: m.note ?? null, is_auto: false }))
  cashEntries.sort((a, b) => a.entry_date.localeCompare(b.entry_date) || a.created_at.localeCompare(b.created_at))
  const dCash: CashEntry[] = cashEntries.map((e) => ({ date: e.entry_date, direction: e.direction, kind: e.kind, amount: e.amount_vnd }))
  const cb = cashBalance(dCash)
  const cashBal: CashBalanceRow = { total_in_vnd: cb.totalIn, total_out_vnd: cb.totalOut, balance_vnd: cb.balance, entry_count: cashEntries.length }
  // kiểm chéo: bút toán tự sinh dựng ở trên = luật domain (autoCashEntries) ⇒ số dư khớp
  const manualCash = dCash.filter((e) => e.kind === 'expense' || e.kind === 'capital_in' || e.kind === 'capital_out' || e.kind === 'adjustment')
  if (cashBalance([...autoCashEntries(dOrders, dTransfers), ...manualCash]).balance !== cb.balance) throw new Error('demo: sổ quỹ không khớp domain')
  const sumKind = (rows: CashEntryRow[], ...kinds: CashKindDb[]) => rows.reduce((a, e) => a + (kinds.includes(e.kind) ? e.amount_vnd : 0), 0)
  const cashMonthly: CashMonthlyRow[] = cashByMonth(dCash).map((m) => {
    const rows = cashEntries.filter((e) => e.entry_date.slice(0, 7) === m.month.slice(0, 7))
    return {
      month: m.month, in_vnd: m.in, out_vnd: m.out, net_vnd: m.net,
      customer_in_vnd: sumKind(rows, 'customer_payment'), refund_out_vnd: sumKind(rows, 'customer_refund'), intermediary_out_vnd: sumKind(rows, 'intermediary'),
      ship_out_vnd: sumKind(rows, 'ship_shop', 'return_ship'), expense_out_vnd: sumKind(rows, 'expense'), capital_in_vnd: sumKind(rows, 'capital_in'),
      capital_out_vnd: sumKind(rows, 'capital_out'),
      adjustment_net_vnd: rows.reduce((a, e) => a + (e.kind === 'adjustment' ? (e.direction === 'in' ? e.amount_vnd : -e.amount_vnd) : 0), 0),
    }
  })

  // v_suggestions
  const active = lots.filter((l) => l.status !== 'cancelled')
  const latest = [...active].sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null
  const withShip = active.filter((l) => l.ship_fee_vnd != null)
    .sort((a, b) => (b.received_at ?? b.ordered_at).localeCompare(a.received_at ?? a.ordered_at) || b.created_at.localeCompare(a.created_at))[0] ?? null
  const shipCount = withShip ? units.filter((u) => u.lot_id === withShip.id).length : 0
  const suggestions: SuggestionsRow = {
    last_exchange_rate: latest?.exchange_rate ?? null,
    last_ship_fee_per_unit_vnd: withShip && shipCount > 0 ? roundVnd(withShip.ship_fee_vnd! / shipCount) : null,
    last_buying_fee_pct: latest?.buying_fee_pct ?? null,
  }

  const settings: SettingsRow = {
    user_id: UID, ai_scan_enabled: true, ai_scan_monthly_cap: 100, ai_confidence_threshold: 0.7, default_ship_fee_payer: 'customer',
    default_buying_fee_pct: 3, aging_warn_days: DEFAULT_AGING.warnDays, aging_alert_days: DEFAULT_AGING.alertDays,
    lot_late_days: DEFAULT_LOT_LATE_DAYS, bank_info: 'Vietcombank 0123456789, NGUYEN VAN A (mẫu)', updated_at: stamp(ago(30)), version: 1,
    bank_bin: '970436', bank_account_no: '0123456789', bank_account_name: 'NGUYEN VAN A', // CR-005 VietQR mẫu (Vietcombank)
  }

  const notes: NoteRow[] = NOTES.map((n, i) => {
    const t = stamp(ago(n.ago), 8 + i, 15)
    return { id: `demo-n-${i + 1}`, user_id: UID, body: n.body, is_pinned: n.pinned, color: (['yellow', 'default', 'green', 'blue', 'pink', 'purple'] as const)[i % 6], created_at: t, updated_at: t, version: 1 }
  })

  // CR-008 danh bạ kho mẫu
  const warehouses: WarehouseRow[] = [
    { name: 'Kho TQ Quảng Châu', phone: '+86 138 0000 0000', address: 'Bạch Vân, Quảng Châu, Quảng Đông', note: 'Ghi mã khách trên kiện' },
    { name: 'Kho VN Hà Nội', phone: '0901 234 567', address: '12 Ngõ Huế, Hai Bà Trưng, Hà Nội', note: 'Nhận hàng 8h-17h' },
    { name: 'Kho Lumi', phone: '0987 654 321', address: '45 Lê Lợi, Q.1, TP.HCM', note: null },
  ].map((w, i) => ({ ...base(`demo-w-${i + 1}`, ago(40 - i)), ...w }))

  units.sort((a, b) => a.code.localeCompare(b.code))
  unitView.sort((a, b) => a.code.localeCompare(b.code))
  payments.sort((a, b) => a.paid_at.localeCompare(b.paid_at) || a.created_at.localeCompare(b.created_at))

  return {
    models, units, sellers, lots, txns, customers, orders, orderLines, payments, settings, notes,
    unitView, modelStock, lotSummary, orderSummary, balance, suggestions, lotCode, orderCode,
    cashEntries, cashBalance: cashBal, cashMonthly, warehouses,
  }
}
