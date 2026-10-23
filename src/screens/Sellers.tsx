import { useState } from 'react'
import { useData } from '../data/store.tsx'
import { Shell } from '../ui/Shell.tsx'
import { cny } from '../ui/format.ts'
import { Row2, Tx, useDesk } from './overview/common.tsx'

// SC_12 Người bán Goofish — danh sách (người bán đã ẩn để riêng, bật xem khi cần). CR-004: dòng 2 dòng (research §10).
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
      {list.length === 0 && <div className="empty">Chưa có người bán — người bán tự thêm khi lưu lô Goofish.</div>}
      {list.length > 0 && (
        <div className="ov-list">
          {list.map((s) => {
            // Không tính lô đã huỷ vào số đã mua
            const ls = d.lots.filter((l) => l.seller_id === s.id && l.status !== 'cancelled')
            const units = ls.reduce((a, l) => a + (sumById.get(l.id)?.total_qty ?? 0), 0)
            const yuan = ls.reduce((a, l) => a + Number(sumById.get(l.id)?.total_cny ?? 0), 0)
            return (
              <Row2 key={s.id} to={`/nguoiban/${s.id}`} className={s.is_hidden ? 'dim' : ''}
                a={<Tx><b>{s.nickname}</b></Tx>}
                b={`${ls.length} lô`}
                c={<>{s.is_avoided && <span className="pill bad">tránh</span>}{s.is_hidden && <span className="pill">đã ẩn</span>}<Tx>{s.region || 'Chưa rõ khu vực'}{s.reputation_note ? ` · ${s.reputation_note}` : ''}</Tx></>}
                d={`${units} chiếc · ${cny(Math.round(yuan * 100) / 100)}`} />
            )
          })}
        </div>
      )}
      <p className="hint" style={{ textAlign: 'center' }}>Người bán tự thêm khi lưu lô (từ nickname AI đọc được).</p>
    </Shell>
  )
}
