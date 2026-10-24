// CR-004 DON-M1 + DON-M4 (§4.4): 1 dòng đơn đúng 2 dòng chữ trên điện thoại.
//   Dòng 1: mã đơn (không cắt) + tên khách (cắt …)          | tổng khách phải trả (tr)
//   Dòng 2: chip trạng thái đơn · ngày / tuổi · mã chiếc (cắt) | thanh toán dạng chữ màu
// Dùng lại được cho "Cần làm" ở Tổng quan (§6.4: truyền hideStatus khi tiêu đề nhóm đã nói việc gì).
import { Link } from 'react-router-dom'
import type { OrderSummaryRow } from '../../data/types.ts'
import { OrderChip } from '../../ui/status.tsx'
import { dmy, tr } from '../../ui/format.ts'
import { codesText, payState } from './common.ts'
import '../../styles/orders.css'

export function OrderRow2({ s, code, meta, hideStatus }: {
  s: OrderSummaryRow; code: string
  /** Chữ thay ngày đơn ở Dòng 2 (vd. "gửi 12 ngày" khi lọc Còn nợ). */
  meta?: string
  hideStatus?: boolean
}) {
  const p = payState(s)
  const total = s.goods_vnd + s.ship_charged_vnd
  const closed = s.status === 'cancelled' || s.status === 'returned'
  return (
    <Link className={`orow ${closed ? 'dim' : ''}`} to={`/don/${s.order_id}`}>
      <span className="l1"><span className="id">{code}</span><span className="nm">{s.customer_name}</span></span>
      <span className="r1">{tr(total)}</span>
      <span className="l2">
        {!hideStatus && <OrderChip s={s.status} />}
        <span className="meta">{meta ?? dmy(s.order_date)}, <span className="num">{codesText(s.unit_codes, 2)}</span></span>
      </span>
      <span className={`r2 ${p ? `tone-${p.tone}` : ''}`}>{p?.short ?? ''}</span>
    </Link>
  )
}

/** Biểu tượng "⋯" (Icon chung chưa có) cho nút menu thao tác ở header. */
export function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor">
      <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
    </svg>
  )
}
