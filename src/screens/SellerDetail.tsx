import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useData, useStore } from '../data/store.tsx'
import { Shell } from '../ui/Shell.tsx'
import { useToast } from '../ui/feedback.tsx'
import { Icon } from '../ui/icons.tsx'
import { HowTo, LotRow, updateVersioned } from './overview/common.tsx'

// SC_12b Chi tiết người bán: ghi chú uy tín, đánh dấu tránh, ẩn (BR-14), các lô đã mua.
export default function SellerDetail() {
  const { id = '' } = useParams()
  const d = useData()
  const { reload } = useStore()
  const toast = useToast()
  const s = d.sellers.find((x) => x.id === id)
  const [note, setNote] = useState(s?.reputation_note ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  // Ghi chú đã lưu đổi (máy khác sửa / vừa lưu) → nạp lại vào ô
  const saved = s?.reputation_note ?? ''
  useEffect(() => { setNote(saved) }, [saved])

  if (!s) return <Shell section="nguoiban" title="Không tìm thấy" back="/nguoiban"><div className="empty"><b>Không tìm thấy người bán</b></div></Shell>
  const seller = s
  const lots = d.lots.filter((l) => l.seller_id === id).reverse()

  async function patch(p: Record<string, unknown>, okMsg: string) {
    setBusy(true); setErr('')
    try {
      await updateVersioned('sellers', seller.id, seller.version, p, 'Người bán')
      await reload()
      toast(okMsg)
    } catch (e) {
      setErr((e as Error).message)
      await reload()
    } finally { setBusy(false) }
  }

  return (
    <Shell section="nguoiban" title={s.nickname} back="/nguoiban">
      <div className="cols">
        <div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 20 }}>{s.nickname} {s.is_hidden && <span className="pill">đã ẩn</span>}</div>
            <div className="muted small">{s.region || 'Chưa rõ khu vực'}</div>
            {s.profile_url && /^https?:\/\//i.test(s.profile_url) && <a className="link-btn small" href={s.profile_url} target="_blank" rel="noopener noreferrer">Mở trang người bán <Icon name="ext" size={14} /></a>}
          </div>
          <label className="f">Ghi chú uy tín
            <textarea className="input" id="s-note" maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="VD: đóng gói kỹ, giao nhanh / hàng lỗi, không nhận đổi" />
          </label>
          <div className="li" style={{ cursor: 'default' }}>
            <div className="main"><b>Đánh dấu tránh</b><div className="s">Cảnh báo khi nhập lô từ người này</div></div>
            <input type="checkbox" className="switch" id="s-avoid" checked={s.is_avoided} disabled={busy} aria-label="Đánh dấu tránh"
              onChange={(e) => patch({ is_avoided: e.target.checked }, e.target.checked ? 'Đã đánh dấu tránh' : 'Bỏ đánh dấu tránh')} />
          </div>
          <button className="btn btn-ghost btn-block" id="s-save" disabled={busy || note === saved}
            onClick={() => patch({ reputation_note: note.trim() || null }, 'Đã lưu ghi chú')}>Lưu ghi chú</button>
          <button className="btn btn-ghost btn-block" id="s-hide" disabled={busy}
            onClick={() => patch({ is_hidden: !s.is_hidden }, s.is_hidden ? 'Đã hiện lại người bán' : 'Đã ẩn người bán')}>
            {s.is_hidden ? 'Hiện lại người bán' : 'Ẩn người bán'}
          </button>
          {err && <p className="err-text">{err}</p>}
          <HowTo title="Vì sao không xoá được">Người bán đã có lô không xoá được, chỉ ẩn khỏi danh sách (BR-14). Lô cũ vẫn giữ tên người bán.</HowTo>
        </div>
        <div>
          <p className="section-title">Lô đã mua <span className="muted">{lots.length}</span></p>
          {lots.length ? <div className="ov-list">{lots.map((l) => <LotRow key={l.id} d={d} l={l} />)}</div> : <p className="muted small">Chưa có lô nào từ người bán này</p>}
        </div>
      </div>
    </Shell>
  )
}
