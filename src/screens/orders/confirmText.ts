// CR-004 DON-S2 — "Sao chép tin xác nhận đơn": chữ thuần để dán Messenger / Zalo (mã chiếc + model + giá chốt, ship,
// đã cọc, còn lại, COD, mã vận đơn, địa chỉ giao). Số lấy từ v_order_summary (số chính thức), không tính lại.
import type { CustomerRow, OrderRow, OrderSummaryRow } from '../../data/types.ts'
import { vnd } from '../../ui/format.ts'

/**
 * Dòng số tài khoản = settings.bank_info (Cài đặt) nếu có; chưa nhập ⇒ chữ đánh dấu [ … ] để Chủ dự án sửa tay
 * trước khi gửi. Có cột settings.bank_info (Cài đặt) thì OrderDetail truyền bankLine; trống ⇒ dùng hằng này.
 */
export const BANK_LINE_PLACEHOLDER = 'STK: [điền số tài khoản của shop]'

export interface ConfirmLine { code: string; model: string; price: number }

export function buildConfirmText(p: {
  code: string; o: OrderRow; s: OrderSummaryRow; c: CustomerRow | undefined; lines: ConfirmLine[]; bankLine?: string | null
}): string {
  const { code, o, s, c, lines } = p
  const out: string[] = []
  out.push(`XÁC NHẬN ĐƠN ${code}`)
  out.push(`Khách: ${c?.fb_name ?? s.customer_name}`)
  out.push('')
  for (const l of lines) out.push(`- ${l.code} · ${l.model}: ${vnd(l.price)}`)
  if (o.ship_fee_vnd > 0) out.push(`Phí ship: ${vnd(o.ship_fee_vnd)}${o.ship_fee_payer === 'shop' ? ' (shop chịu)' : ''}`)
  else out.push('Phí ship: miễn phí')
  const total = s.goods_vnd + s.ship_charged_vnd
  out.push(`Tổng: ${vnd(total)}`)
  if (s.deposit_vnd > 0) out.push(`Đã cọc: ${vnd(s.deposit_vnd)}`)
  const more = s.paid_vnd - s.deposit_vnd
  if (more > 0) out.push(`Đã thanh toán thêm: ${vnd(more)}`)
  if (s.status === 'cancelled' || s.status === 'returned') {
    out.push(s.status === 'cancelled' ? 'Đơn đã huỷ.' : 'Đơn đã hoàn hàng.')
    if (s.refund_due_vnd > 0) out.push(`Shop hoàn lại: ${vnd(s.refund_due_vnd)}`)
  } else if (s.receivable_vnd > 0) {
    out.push(`Còn lại: ${vnd(s.receivable_vnd)}`)
    if (o.cod_amount_vnd > 0) out.push(`Thu hộ COD khi giao: ${vnd(o.cod_amount_vnd)}`)
    // Còn phần phải chuyển khoản ngoài COD ⇒ cần STK
    if (s.receivable_vnd > o.cod_amount_vnd) out.push(p.bankLine?.trim() || BANK_LINE_PLACEHOLDER)
  } else if (s.receivable_vnd < 0) {
    out.push(`Anh/chị đã chuyển dư: ${vnd(-s.receivable_vnd)}`)
  } else {
    out.push('Đã thanh toán đủ.')
  }
  if (s.status === 'preorder') out.push('Hàng đặt trước — shop báo ngay khi hàng về kho.')
  if (o.tracking_no) out.push(`Mã vận đơn: ${o.tracking_no}`)
  const ship = [c?.phone, c?.address].filter(Boolean).join(' · ')
  if (ship && s.status !== 'cancelled' && s.status !== 'returned') out.push(`Giao tới: ${ship}`)
  out.push('')
  out.push('Anh/chị kiểm tra giúp shop thông tin trên nhé. Cảm ơn anh/chị!')
  return out.join('\n')
}
