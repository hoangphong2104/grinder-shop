// CR-005 ý 1, 5: nút "Đã thanh toán" một chạm cho lô - RPC pay_lot ghi 1 khoản Đã chuyển = phần còn nợ của lô
// (trigger DB ghi tiền ra sổ quỹ). Sai thì sửa / xoá khoản đó ở Sổ quỹ → Công nợ trung gian.
import { useState } from 'react'
import { useData, useStore } from '../../data/store.tsx'
import { useToast } from '../../ui/feedback.tsx'
import { todayVn, tr } from '../../ui/format.ts'

export function PayLotButton({ lotId, className, id, label }: { lotId: string; className?: string; id?: string; label?: string }) {
  const d = useData()
  const { rpc } = useStore()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const s = d.lotSummary.find((x) => x.lot_id === lotId)
  const due = s?.outstanding_vnd ?? 0
  if (!s || s.status === 'cancelled' || due <= 0) return null
  // Đã trả tiền hàng, còn nợ = đúng phí ship ⇒ "Đã thanh toán ship"
  const shipOnly = s.paid_vnd > 0 && s.ship_fee_vnd != null && due === s.ship_fee_vnd
  async function pay() {
    setBusy(true)
    try {
      await rpc('pay_lot', { p_lot_id: lotId, p_paid_at: todayVn(), p_note: shipOnly ? 'Trả phí ship' : null })
      toast(`Đã ghi trả ${d.lotCode[lotId] ?? 'lô'}: ${tr(due)}`)
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <button type="button" className={className ?? 'btn btn-ghost btn-sm'} id={id} disabled={busy} onClick={(e) => { e.stopPropagation(); e.preventDefault(); void pay() }}>
      {busy ? <><span className="spin" /> Đang ghi…</> : label ?? (shipOnly ? 'Đã thanh toán ship' : 'Đã thanh toán')}
    </button>
  )
}
