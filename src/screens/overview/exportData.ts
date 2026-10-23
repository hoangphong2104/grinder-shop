// Xuất Excel (Q-018: tiện ích tuỳ chọn; NFR-07) — CR-001: lô, từng chiếc cối, đơn, dòng đơn (mã chiếc), thu tiền,
// tồn theo model, sổ công nợ trung gian, ghi chú. CR-003: cột phí mua hộ % / ₫ (lô) và % (chiếc).
// DB chưa chạy 002_buying_fee.sql ⇒ cột phí chưa có ⇒ xuất 0.
import type { DbData } from '../../data/types.ts'
import { LOT_LABEL, ORDER_LABEL, UNIT_LABEL } from '../../ui/status.tsx'
import { todayVn } from '../../ui/format.ts'
import { downloadXlsx, type SheetData } from './xlsx.ts'

const PAY_LABEL = { deposit: 'Cọc', payment: 'Thanh toán', refund: 'Hoàn tiền' } as const
const TXN_LABEL = { payable: 'Phải trả (lô)', transfer: 'Đã chuyển', adjustment: 'Điều chỉnh' } as const
const PAYER_LABEL = { customer: 'Khách trả', shop: 'Shop chịu' } as const

export function exportExcel(d: DbData): void {
  const seller = new Map(d.sellers.map((s) => [s.id, s.nickname]))
  const lotSum = new Map(d.lotSummary.map((s) => [s.lot_id, s]))
  const ordSum = new Map(d.orderSummary.map((s) => [s.order_id, s]))
  const ordById = new Map(d.orders.map((o) => [o.id, o]))
  const cust = new Map(d.customers.map((c) => [c.id, c]))
  const unit = new Map(d.unitView.map((u) => [u.unit_id, u]))
  const lotById = new Map(d.lots.map((l) => [l.id, l]))
  const feePct = (lotId: string) => Number(lotById.get(lotId)?.buying_fee_pct ?? 0)
  const day = (s: string | null | undefined) => (s ? s.slice(0, 10) : '')
  const holder = (id: string | null) => (id ? d.orderCode[id] ?? '' : '')

  const sheets: SheetData[] = [
    {
      name: 'Lô nhập',
      rows: [['Mã lô', 'Ngày đặt', 'Người bán', 'Trạng thái', 'Model', 'Số chiếc', 'Tỷ giá', 'Tổng ¥', 'Tiền hàng ₫', 'Phí mua hộ %', 'Phí mua hộ ₫', 'Phí ship ₫', 'Ship / chiếc ₫', 'Phải trả ₫', 'Tổng giá nhập ₫', 'Giá nhập tạm tính', 'Ngày nhận', 'Mã tin Goofish', 'Link', 'Tiêu đề tin', 'Ghi chú'],
        ...d.lots.map((l) => {
          const s = lotSum.get(l.id)
          return [d.lotCode[l.id], l.ordered_at, seller.get(l.seller_id ?? '') ?? '', LOT_LABEL[l.status],
            (s?.models ?? []).map((m) => `${m.qty} × ${m.model_name}`).join(', '), s?.total_qty, Number(l.exchange_rate), Number(s?.total_cny ?? 0),
            s?.goods_vnd, feePct(l.id), s?.buying_fee_vnd ?? 0, l.ship_fee_vnd, s?.ship_per_unit_vnd, s?.payable_vnd, s?.total_cost_vnd, s?.cost_is_provisional ?? false,
            day(l.received_at), l.goofish_item_id, l.goofish_url, l.listing_title, l.note]
        })],
    },
    {
      name: 'Chiếc cối',
      rows: [['Mã chiếc', 'Model', 'Số seri', 'Lô', 'Trạng thái', 'Đơn', 'Khách', 'Giá ¥', 'Tỷ giá', 'Phí mua hộ %', 'Giá nhập tự tính ₫', 'Giá nhập sửa tay ₫', 'Giá nhập ₫', 'Tạm tính (chưa có ship)', 'Giá bán dự kiến ₫', 'Giá chốt ₫', 'Ngày gửi', 'Lãi dự kiến ₫', 'Lãi thực tế ₫', 'Ngày đặt', 'Ngày nhận', 'Số ngày tồn', 'Ghi chú'],
        ...d.unitView.map((u) => [u.code, u.model_name, u.serial_no, d.lotCode[u.lot_id], UNIT_LABEL[u.status], holder(u.holding_order_id), u.holding_customer_name,
          Number(u.price_cny), Number(u.exchange_rate), feePct(u.lot_id), u.cost_vnd_auto, u.cost_vnd_override, u.cost_vnd, u.cost_is_provisional, u.list_price_vnd,
          u.order_unit_price_vnd, day(u.sold_at), u.status === 'sold' ? null : u.expected_profit_vnd, u.actual_profit_vnd,
          u.ordered_at, day(u.received_at), u.days_in_stock, u.note])],
    },
    {
      name: 'Đơn bán',
      rows: [['Mã đơn', 'Ngày', 'Khách', 'SĐT', 'Trạng thái', 'Số chiếc', 'Mã chiếc', 'Tiền hàng ₫', 'Phí ship ₫', 'Ship do', 'Đã thu ₫', 'Còn thu ₫', 'Cần hoàn ₫', 'Lãi ₫', 'Ngày gửi', 'Mã vận đơn', 'Ghi chú'],
        ...d.orders.map((o) => {
          const s = ordSum.get(o.id), c = cust.get(o.customer_id)
          return [d.orderCode[o.id], o.order_date, c?.fb_name, c?.phone, ORDER_LABEL[o.status], s?.unit_count, (s?.unit_codes ?? []).join(', '),
            s?.goods_vnd, o.ship_fee_vnd, PAYER_LABEL[o.ship_fee_payer], s?.paid_vnd, s?.receivable_vnd, s?.refund_due_vnd, s?.profit_vnd,
            day(o.shipped_at), o.tracking_no, o.note]
        })],
    },
    {
      name: 'Dòng đơn',
      rows: [['Mã đơn', 'STT', 'Mã chiếc', 'Model', 'Giá chốt ₫', 'Giá nhập ₫ (hiện tại)', 'Lãi ₫', 'Trạng thái đơn', 'Dòng đã bỏ (đơn huỷ)'],
        ...d.orderLines.map((x) => {
          const u = unit.get(x.unit_id), o = ordById.get(x.order_id)
          const sent = o?.status === 'shipped' || o?.status === 'completed'
          return [d.orderCode[x.order_id], x.line_no, u?.code ?? '', u?.model_name ?? '', x.unit_price_vnd, u?.cost_vnd,
            sent && u ? x.unit_price_vnd - u.cost_vnd : null, o ? ORDER_LABEL[o.status] : '', x.cancelled]
        })],
    },
    {
      name: 'Thu tiền',
      rows: [['Mã đơn', 'Ngày', 'Loại', 'Số tiền ₫', 'Ghi chú'],
        ...d.payments.map((p) => [d.orderCode[p.order_id], p.paid_at, PAY_LABEL[p.kind], p.amount_vnd, p.note])],
    },
    {
      name: 'Tồn theo model',
      rows: [['Model', 'Hãng', 'Tiền tố', 'Trong kho', 'Đang về', 'Đã giữ', 'Đã giữ (đã về kho)', 'Có thể bán', 'Đã bán', 'Giá trị tồn ₫', 'Giá bán mặc định ₫', 'Ngưỡng sắp hết', 'Sắp hết', 'Đang bán'],
        ...d.modelStock.map((s) => [s.model_name, s.brand, s.code_prefix, s.in_stock_count, s.incoming_count, s.reserved_count, s.reserved_received_count,
          s.sellable_count, s.sold_count, s.stock_value_vnd, s.default_list_price_vnd, s.low_stock_threshold, s.is_low_stock, s.is_active])],
    },
    {
      name: 'Công nợ trung gian',
      rows: (() => {
        let bal = 0
        const asc = [...d.txns].sort((a, b) => a.txn_date.localeCompare(b.txn_date) || a.created_at.localeCompare(b.created_at))
        return [['Ngày', 'Loại', 'Lô', 'Số tiền ₫', 'Ảnh hưởng dư nợ ₫', 'Dư nợ sau ₫', 'Ghi chú'],
          ...asc.map((t) => {
            const eff = t.kind === 'transfer' ? -t.amount_vnd : t.amount_vnd
            bal += eff
            return [t.txn_date, TXN_LABEL[t.kind], t.lot_id ? d.lotCode[t.lot_id] : '', t.amount_vnd, eff, bal, t.note]
          })]
      })(),
    },
    {
      name: 'Ghi chú',
      rows: [['Ghim', 'Ngày tạo', 'Sửa lần cuối', 'Nội dung'],
        ...[...d.notes].sort((a, b) => Number(b.is_pinned) - Number(a.is_pinned) || b.updated_at.localeCompare(a.updated_at))
          .map((n) => [n.is_pinned, day(n.created_at), day(n.updated_at), n.body])],
    },
  ]
  downloadXlsx(`grinder-shop-${todayVn()}.xlsx`, sheets)
}
