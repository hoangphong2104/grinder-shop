import { useCallback, useState } from 'react'
import { useData, useStore } from '../data/store.tsx'
import type { ModelRow, VariantRow } from '../data/types.ts'
import { supabase } from '../lib/supabase.ts'
import { Shell } from '../ui/Shell.tsx'
import { Sheet, useToast } from '../ui/feedback.tsx'
import { GrinderArt, shapeOf } from '../ui/icons.tsx'
import { parseNum, vnd } from '../ui/format.ts'
import { updateVersioned, useDesk, writeError } from './overview/common.tsx'

type Edit =
  | { t: 'model'; m?: ModelRow }
  | { t: 'variant'; modelId: string; v?: VariantRow }

// SC_14 Model & biến thể: tên AI nhận, giá bán, ngưỡng sắp hết; thêm / sửa / ẩn; xoá chỉ khi chưa dùng (BR-14).
export default function Catalog() {
  const d = useData()
  const desk = useDesk()
  const [edit, setEdit] = useState<Edit | null>(null)
  const close = useCallback(() => setEdit(null), [])
  const sellable = new Map(d.stock.map((s) => [s.variant_id, s.sellable]))

  return (
    <Shell section="danhmuc" title="Model & biến thể" back={desk ? undefined : '/them'}>
      {d.models.length === 0 && <div className="empty">Chưa có model nào — bấm “+ Thêm model”.</div>}
      {d.models.map((m) => (
        <div key={m.id} className="stack">
          <div className={`row mhead ${m.is_active ? '' : 'dim'}`} style={{ gap: 12 }}>
            <span className="gpic"><GrinderArt shape={shapeOf(m.name)} /></span>
            <div className="grow">
              <div style={{ fontSize: 18 }}>{m.name} {!m.is_active && <span className="pill">Đã ẩn</span>}</div>
              <div className="small muted">{m.brand} · AI nhận tên: {m.aliases.length ? m.aliases.join(', ') : '(chưa có)'}</div>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => setEdit({ t: 'model', m })}>Sửa</button>
          </div>
          <div className="list">
            {d.variants.filter((v) => v.model_id === m.id).map((v) => (
              <button key={v.id} className={`li ${v.is_active ? '' : 'dim'}`} onClick={() => setEdit({ t: 'variant', modelId: m.id, v })}>
                <div className="main">
                  <b>{v.name}</b> {!v.is_active && <span className="pill">Đã ẩn</span>}
                  <div className="s">Giá bán {vnd(v.list_price_vnd)} · cảnh báo khi còn ≤ {v.low_stock_threshold}</div>
                </div>
                <span className="v">{sellable.get(v.id) ?? 0} có thể bán</span>
              </button>
            ))}
            <button className="li" onClick={() => setEdit({ t: 'variant', modelId: m.id })}>
              <div className="main"><b>+ Thêm biến thể</b><div className="s">Màu / phiên bản</div></div>
            </button>
          </div>
        </div>
      ))}
      <button className="btn btn-ghost btn-block" onClick={() => setEdit({ t: 'model' })}>+ Thêm model</button>
      <p className="hint" style={{ textAlign: 'center' }}>Model / biến thể đã có lô hoặc đơn chỉ ẩn được, không xoá (BR-14). Ẩn = không hiện ở Kho và ô chọn hàng; số liệu cũ giữ nguyên.</p>
      {edit?.t === 'model' && <ModelSheet m={edit.m} onClose={close} />}
      {edit?.t === 'variant' && <VariantSheet modelId={edit.modelId} v={edit.v} onClose={close} />}
    </Shell>
  )
}

/** Nút ẩn/hiện + xoá (có bước xác nhận) dùng chung cho 2 sheet. */
function useRemoval(table: 'models' | 'variants', row: ModelRow | VariantRow | undefined, what: string, onClose: () => void) {
  const { reload } = useStore()
  const toast = useToast()
  const [confirmDel, setConfirmDel] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  async function toggleActive() {
    if (!row) return
    setBusy(true); setErr('')
    try {
      await updateVersioned(table, row.id, row.version, { is_active: !row.is_active }, what)
      await reload(); toast(row.is_active ? `Đã ẩn ${row.name}` : `Đã hiện lại ${row.name}`); onClose()
    } catch (e) { setErr((e as Error).message); await reload() } finally { setBusy(false) }
  }
  async function remove() {
    if (!row) return
    setBusy(true); setErr('')
    const { data, error } = await supabase.from(table).delete().eq('id', row.id).select('id')
    if (error || !data?.length) {
      setBusy(false); setConfirmDel(false)
      setErr(error ? writeError(error, what) : 'Không xoá được — dữ liệu đã đổi, thử lại.')
      await reload(); return
    }
    await reload(); setBusy(false); toast(`Đã xoá ${row.name}`); onClose()
  }
  const ui = row && (
    <>
      {confirmDel && <p className="warn-box">Xoá vĩnh viễn “{row.name}”? Chỉ xoá được khi chưa có lô / đơn{table === 'models' ? ' và không còn màu nào' : ''}. Không hoàn tác được.</p>}
      <div className="btn-row">
        <button className="btn btn-ghost" disabled={busy} onClick={toggleActive}>{row.is_active ? 'Ẩn' : 'Hiện lại'}</button>
        {confirmDel
          ? <button className="btn btn-danger" disabled={busy} onClick={remove}>{busy ? 'Đang xoá…' : 'Xoá vĩnh viễn'}</button>
          : <button className="btn btn-danger" disabled={busy} onClick={() => setConfirmDel(true)}>Xoá</button>}
      </div>
    </>
  )
  return { ui, err, setErr, busy, setBusy }
}

function ModelSheet({ m, onClose }: { m?: ModelRow; onClose: () => void }) {
  const d = useData()
  const { reload } = useStore()
  const toast = useToast()
  const [name, setName] = useState(m?.name ?? '')
  const [brand, setBrand] = useState(m?.brand ?? '1Zpresso')
  const [alias, setAlias] = useState(m?.aliases.join(', ') ?? '')
  const [nameErr, setNameErr] = useState('')
  const rm = useRemoval('models', m, 'Model', onClose)

  async function save() {
    const n = name.trim()
    if (!n) { setNameErr('Nhập tên model (VD: X Ultra).'); return }
    if (n.length > 80) { setNameErr('Tên tối đa 80 ký tự.'); return }
    if (d.models.some((x) => x.id !== m?.id && x.name.toLowerCase() === n.toLowerCase())) { setNameErr('Đã có model tên này.'); return }
    setNameErr(''); rm.setErr(''); rm.setBusy(true)
    const aliases = [...new Set(alias.split(',').map((s) => s.trim()).filter(Boolean))]
    const row = { name: n, brand: brand.trim() || '1Zpresso', aliases }
    try {
      if (m) await updateVersioned('models', m.id, m.version, row, 'Model')
      else {
        const sort = Math.max(0, ...d.models.map((x) => x.sort_order)) + 1
        const { error } = await supabase.from('models').insert({ ...row, sort_order: sort })
        if (error) throw new Error(writeError(error, 'Model'))
      }
      await reload(); toast(m ? 'Đã lưu model' : `Đã thêm model ${n}`); onClose()
    } catch (e) { rm.setErr((e as Error).message); await reload() } finally { rm.setBusy(false) }
  }

  return (
    <Sheet title={m ? `Sửa model · ${m.name}` : 'Thêm model'} onClose={onClose}
      footer={<button className="btn btn-primary btn-block" onClick={save} disabled={rm.busy}>{rm.busy ? 'Đang lưu…' : 'Lưu'}</button>}>
      <label className="f">Tên model
        <input className={`input ${nameErr ? 'invalid' : ''}`} id="nm-name" maxLength={80} placeholder="VD: X Ultra" value={name} onChange={(e) => setName(e.target.value)} />
        {nameErr && <span className="field-err">{nameErr}</span>}
      </label>
      <label className="f">Hãng
        <input className="input" id="nm-brand" maxLength={60} value={brand} onChange={(e) => setBrand(e.target.value)} />
      </label>
      <label className="f">Tên gọi khác (cho AI nhận, cách nhau dấu phẩy)
        <input className="input" id="nm-alias" placeholder="VD: XU, X-Ultra" value={alias} onChange={(e) => setAlias(e.target.value)} />
      </label>
      {rm.ui}
      {rm.err && <p className="err-text">{rm.err}</p>}
    </Sheet>
  )
}

function VariantSheet({ modelId, v, onClose }: { modelId: string; v?: VariantRow; onClose: () => void }) {
  const d = useData()
  const { reload } = useStore()
  const toast = useToast()
  const model = d.models.find((x) => x.id === modelId)
  const [name, setName] = useState(v?.name ?? '')
  const [price, setPrice] = useState(v?.list_price_vnd != null ? String(v.list_price_vnd) : '')
  const [low, setLow] = useState(String(v?.low_stock_threshold ?? 1))
  const [errs, setErrs] = useState<{ name?: string; price?: string; low?: string }>({})
  const rm = useRemoval('variants', v, 'Biến thể', onClose)

  async function save() {
    const n = name.trim(), p = price.trim() ? parseNum(price) : null, l = parseNum(low)
    const e: typeof errs = {}
    if (!n) e.name = 'Nhập tên màu / phiên bản (VD: Đen).'
    else if (d.variants.some((x) => x.model_id === modelId && x.id !== v?.id && x.name.toLowerCase() === n.toLowerCase())) e.name = 'Model này đã có màu tên này.'
    if (price.trim() && (p == null || p < 0 || !Number.isInteger(p))) e.price = 'Nhập giá bán bằng đồng (VD: 5.400.000) hoặc để trống.'
    if (l == null || l < 0 || !Number.isInteger(l)) e.low = 'Nhập số nguyên ≥ 0.'
    setErrs(e)
    if (e.name || e.price || e.low) return
    rm.setErr(''); rm.setBusy(true)
    const row = { name: n, list_price_vnd: p, low_stock_threshold: l }
    try {
      if (v) await updateVersioned('variants', v.id, v.version, row, 'Biến thể')
      else {
        const { error } = await supabase.from('variants').insert({ ...row, model_id: modelId })
        if (error) throw new Error(writeError(error, 'Biến thể'))
      }
      await reload(); toast(v ? 'Đã lưu' : `Đã thêm ${model?.name ?? ''} · ${n}`); onClose()
    } catch (err) { rm.setErr((err as Error).message); await reload() } finally { rm.setBusy(false) }
  }

  return (
    <Sheet title={v ? `Sửa · ${model?.name ?? ''} ${v.name}` : `Thêm biến thể · ${model?.name ?? ''}`} onClose={onClose}
      footer={<button className="btn btn-primary btn-block" onClick={save} disabled={rm.busy}>{rm.busy ? 'Đang lưu…' : 'Lưu'}</button>}>
      <label className="f">Tên (màu / phiên bản)
        <input className={`input ${errs.name ? 'invalid' : ''}`} id="nv-name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        {errs.name && <span className="field-err">{errs.name}</span>}
      </label>
      <label className="f">Giá bán niêm yết (₫)
        <input className={`input money ${errs.price ? 'invalid' : ''}`} id="nv-price" inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} />
        {errs.price && <span className="field-err">{errs.price}</span>}
      </label>
      <label className="f">Cảnh báo “Sắp hết” khi có thể bán còn ≤
        <input className={`input money ${errs.low ? 'invalid' : ''}`} id="nv-low" inputMode="numeric" value={low} onChange={(e) => setLow(e.target.value)} />
        {errs.low && <span className="field-err">{errs.low}</span>}
      </label>
      {rm.ui}
      {rm.err && <p className="err-text">{rm.err}</p>}
    </Sheet>
  )
}
