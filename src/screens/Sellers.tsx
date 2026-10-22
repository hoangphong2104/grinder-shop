import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useData } from '../data/store.tsx'
import { Shell } from '../ui/Shell.tsx'
import { cny } from '../ui/format.ts'
import { useDesk } from './overview/common.tsx'

// SC_12 Người bán Goofish — danh sách (người bán đã ẩn để riêng, bật xem khi cần).
export default function Sellers() {
  const d = useData()
  const desk = useDesk()
  const [showHidden, setShowHidden] = useState(false)
  const hiddenCount = d.sellers.filter((s) => s.is_hidden).length
  const list = d.sellers.filter((s) => showHidden || !s.is_hidden)
  const sumById = new Map(d.lotSummary.map((x) => [x.lot_id, x]))

  return (
    <Shell section="nguoiban" title="Người bán Goofish" back={desk ? undefined : '/them'}>
      {hiddenCount > 0 && (
        <div className="chips">
          <button className="chip" aria-pressed={!showHidden} onClick={() => setShowHidden(false)}>Đang dùng</button>
          <button className="chip" aria-pressed={showHidden} onClick={() => setShowHidden(true)}>Cả đã ẩn <span className="c">{hiddenCount}</span></button>
        </div>
      )}
      <div className="stack">
        {list.length === 0 && <div className="empty">Chưa có người bán — người bán tự thêm khi lưu lô Goofish.</div>}
        {list.map((s) => {
          // Không tính lô đã huỷ vào số đã mua
          const ls = d.lots.filter((l) => l.seller_id === s.id && l.status !== 'cancelled')
          const units = ls.reduce((a, l) => a + (sumById.get(l.id)?.total_qty ?? 0), 0)
          const yuan = ls.reduce((a, l) => a + Number(sumById.get(l.id)?.total_cny ?? 0), 0)
          return (
            <Link key={s.id} className="shot item" to={`/nguoiban/${s.id}`}>
              <span className="t">{s.region || 'Chưa rõ khu vực'}</span>
              <span className="b">{s.nickname} {s.is_avoided && <span className="pill err">tránh</span>} {s.is_hidden && <span className="pill">đã ẩn</span>}</span>
              <span className="r num">{ls.length} lô</span>
              <span className="f">{units} chiếc · {cny(Math.round(yuan * 100) / 100)}{s.reputation_note ? ` · ${s.reputation_note}` : ''}</span>
            </Link>
          )
        })}
      </div>
      <p className="hint" style={{ textAlign: 'center' }}>Người bán tự thêm khi lưu lô (từ nickname AI đọc được).</p>
    </Shell>
  )
}
