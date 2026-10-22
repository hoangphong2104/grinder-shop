// Xuất Excel (Q-018: tiện ích tuỳ chọn; NFR-07): lô, dòng lô, đơn, dòng đơn, thu tiền, tồn kho, sổ công nợ trung gian.
import type { DbData } from '../../data/types.ts'
import { LOT_LABEL, ORDER_LABEL } from '../../ui/status.tsx'
import { todayVn } from '../../ui/format.ts'
import { downloadXlsx, type SheetData } from './xlsx.ts'

const PAY_LABEL = { deposit: 'Cọc', payment: 'Thanh toán', refund: 'Hoàn tiền' } as const
const TXN_LABEL = { payable: 'Phải trả (lô)', transfer: 'Đã chuyển', adjustment: 'Điều chỉnh' } as const
const PAYER_LABEL = { customer: 'Khách trả', shop: 'Shop chịu' } as const

export function exportExcel(d: DbData): void {
  const model = new Map(d.models.map((m) => [m.id, m.name]))
  const variant = new Map(d.variants.map((v) => [v.id, v]))
  const mName = (vid: string) => model.get(variant.get(vid)?.model_id ?? '') ?? ''
  const vName = (vid: string) => variant.get(vid)?.name ?? ''
  const seller = new Map(d.sellers.map((s) => [s.id, s.nickname]))
  const lotSum = new Map(d.lotSummary.map((s) => [s.lot_id, s]))
  const ordSum = new Map(d.orderSummary.map((s) => [s.order_id, s]))
  const cust = new Map(d.customers.map((c) => [c.id, c]))
  const day = (s: string | null | undefined) => (s ? s.slice(0, 10) : '')

  const sheets: SheetData[] = [
    {
      name: 'Lô nhập',
      rows: [['Mã lô', 'Ngày đặt', 'Người bán', 'Trạng thái', 'Tỷ giá', 'Tổng SL', 'Tổng ¥', 'Tiền hàng ₫', 'Phí ship ₫', 'Phải trả ₫', 'Ngày nhận', 'Mã tin Goofish', 'Link', 'Tiêu đề tin', 'Ghi chú'],
        ...d.lots.map((l) => {
          const s = lotSum.get(l.id)
          return [d.lotCode[l.id], l.ordered_at, seller.get(l.seller_id ?? '') ?? '', LOT_LABEL[l.status], Number(l.exchange_rate), s?.total_qty, Number(s?.total_cny ?? 0),
            s?.goods_vnd, l.ship_fee_vnd, s?.payable_vnd, day(l.received_at), l.goofish_item_id, l.goofish_url, l.listing_title, l.note]
        })],
    },
    {
      name: 'Dòng lô',
      rows: [['Mã lô', 'Model', 'Màu', 'SL', 'Giá ¥ / chiếc', 'Giá vốn ₫ / chiếc', 'Giá vốn tạm (chưa có ship)'],
        ...d.lotLines.map((x) => [d.lotCode[x.lot_id], mName(x.variant_id), vName(x.variant_id), x.qty, Number(x.price_cny), x.unit_cost_vnd,
          lotSum.get(x.lot_id)?.cost_is_provisional ?? false])],
    },
    {
      name: 'Đơn bán',
      rows: [['Mã đơn', 'Ngày', 'Khách', 'SĐT', 'Trạng thái', 'Tiền hàng ₫', 'Phí ship ₫', 'Ship do', 'Đã thu ₫', 'Còn thu ₫', 'Cần hoàn ₫', 'Lãi ₫', 'Ngày gửi', 'Mã vận đơn', 'Ghi chú'],
        ...d.orders.map((o) => {
          const s = ordSum.get(o.id), c = cust.get(o.customer_id)
          return [d.orderCode[o.id], o.order_date, c?.fb_name, c?.phone, ORDER_LABEL[o.status], s?.goods_vnd, o.ship_fee_vnd, PAYER_LABEL[o.ship_fee_payer],
            s?.paid_vnd, s?.receivable_vnd, s?.refund_due_vnd, s?.profit_vnd, day(o.shipped_at), o.tracking_no, o.note]
        })],
    },
    {
      name: 'Dòng đơn',
      rows: [['Mã đơn', 'Model', 'Màu', 'SL', 'Giá bán ₫ / chiếc', 'Giá vốn lúc gửi ₫ / chiếc'],
        ...d.orderLines.map((x) => [d.orderCode[x.order_id], mName(x.variant_id), vName(x.variant_id), x.qty, x.unit_price_vnd, x.unit_cost_vnd])],
    },
    {
      name: 'Thu tiền',
      rows: [['Mã đơn', 'Ngày', 'Loại', 'Số tiền ₫', 'Ghi chú'],
        ...d.payments.map((p) => [d.orderCode[p.order_id], p.paid_at, PAY_LABEL[p.kind], p.amount_vnd, p.note])],
    },
    {
      name: 'Tồn kho',
      rows: [['Model', 'Màu', 'Có sẵn', 'Đang về', 'Đã giữ', 'Có thể bán', 'Giá vốn BQ ₫', 'Giá trị tồn ₫', 'Giá bán ₫', 'Ngưỡng sắp hết', 'Đang bán'],
        ...d.stock.map((s) => [s.model_name, s.variant_name, s.on_hand, s.incoming, s.reserved, s.sellable, s.avg_cost_vnd, s.stock_value_vnd, s.list_price_vnd, s.low_stock_threshold, s.is_active])],
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
  ]
  downloadXlsx(`grinder-shop-${todayVn()}.xlsx`, sheets)
}
