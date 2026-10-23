import { useCallback, useState } from 'react'
import { useData, useStore } from '../data/store.tsx'
import type { ModelRow } from '../data/types.ts'
import { supabase } from '../lib/supabase.ts'
import { Shell } from '../ui/Shell.tsx'
import { Sheet, useToast } from '../ui/feedback.tsx'
import { GrinderArt, shapeOf } from '../ui/icons.tsx'
import { parseNum, tr } from '../ui/format.ts'
import { HowTo, Row2, Tx, updateVersioned, useDesk, writeError } from './overview/common.tsx'

/** Mã chiếc kế tiếp dự kiến (DB bỏ qua mã đã có / đã bỏ nên có thể nhảy số). */
const nextCode = (m: Pick<ModelRow, 'code_prefix' | 'next_seq'>) => `${m.code_prefix}-${m.next_seq < 1000 ? String(m.next_seq).padStart(3, '0') : m.next_seq}`
const normPrefix = (s: string) => s.toUpperCase().replace(/\s+/g, '')
const PREFIX_RE = /^[A-Z0-9]{1,10}$/

// SC_14 Model (CR-001 A1: không còn biến thể màu): tên, hãng, tiền tố mã, giá bán mặc định, ngưỡng sắp hết, tên gọi khác cho AI;
// thêm / sửa / ẩn; xoá chỉ khi chưa có chiếc cối nào (BR-14). CR-004: dòng 2 dòng (research §10).
export default function Catalog() {
  const d = useData()
  const desk = useDesk()
  const [edit, setEdit] = useState<{ m?: ModelRow } | null>(null)
  const close = useCallback(() => setEdit(null), [])
  const stock = new Map(d.modelStock.map((s) => [s.model_id, s]))
  const unitCount = (id: string) => d.units.filter((u) => u.model_id === id).length

  return (
    <Shell section="danhmuc" title="Model" back={desk ? undefined : '/them'}
      actions={<button className="btn btn-ghost btn-sm only-desk" onClick={() => setEdit({})}>+ Thêm model</button>}>
      {d.models.length === 0 && <div className="empty">Chưa có model nào — bấm “+ Thêm model”.</div>}
      {d.models.length > 0 && (
        <div className="ov-list">
          {d.models.map((m) => {
            const s = stock.get(m.id)
            return (
              <Row2 key={m.id} onClick={() => setEdit({ m })} className={m.is_active ? '' : 'dim'} label={`Sửa model ${m.name}`}
                a={<><span className="gpic" style={{ width: 24, height: 24 }}><GrinderArt shape={shapeOf(m.name)} /></span><Tx><b>{m.name}</b></Tx></>}
                b={m.default_list_price_vnd != null ? tr(m.default_list_price_vnd) : '—'}
                c={<>{!m.is_active && <span className="pill">Đã ẩn</span>}<Tx><span className="num">{m.code_prefix}</span> · ngưỡng {m.low_stock_threshold} · tiếp {nextCode(m)}</Tx></>}
                d={`${s?.sellable_count ?? 0} bán được · ${unitCount(m.id)} đã nhập`} />
            )
          })}
        </div>
      )}
      <button className="btn btn-ghost btn-block" onClick={() => setEdit({})}>+ Thêm model</button>
      <HowTo title="Mã chiếc & ẩn model">Mỗi chiếc cối nhập về được cấp mã = tiền tố + số thứ tự (VD: KU-007). Model đã có chiếc chỉ ẩn được, không xoá (BR-14). Ẩn = không hiện ở ô chọn model khi nhập lô; chiếc cũ giữ nguyên. Tên gọi khác giúp AI nhận model khi đọc tin Goofish.</HowTo>
      {edit && <ModelSheet m={edit.m} onClose={close} />}
    </Shell>
  )
}

function ModelSheet({ m, onClose }: { m?: ModelRow; onClose: () => void }) {
  const d = useData()
  const { reload } = useStore()
  const toast = useToast()
  const [name, setName] = useState(m?.name ?? '')
  const [brand, setBrand] = useState(m?.brand ?? '1Zpresso')
  const [prefix, setPrefix] = useState(m?.code_prefix ?? '')
  const [price, setPrice] = useState(m?.default_list_price_vnd != null ? String(m.default_list_price_vnd) : '')
  const [low, setLow] = useState(String(m?.low_stock_threshold ?? 1))
  const [alias, setAlias] = useState(m?.aliases.join(', ') ?? '')
  const [errs, setErrs] = useState<{ name?: string; prefix?: string; price?: string; low?: string; form?: string }>({})
  const [busy, setBusy] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const used = m ? d.units.filter((u) => u.model_id === m.id).length : 0
  const pfx = normPrefix(prefix)
  const prefixChanged = !!m && pfx !== m.code_prefix

  async function save() {
    const n = name.trim(), p = price.trim() ? parseNum(price) : null, l = parseNum(low)
    const e: typeof errs = {}
    if (!n) e.name = 'Nhập tên model (VD: K Ultra).'
    else if (n.length > 80) e.name = 'Tên tối đa 80 ký tự.'
    else if (d.models.some((x) => x.id !== m?.id && x.name.toLowerCase() === n.toLowerCase())) e.name = 'Đã có model tên này.'
    if (!PREFIX_RE.test(pfx)) e.prefix = 'Tiền tố 1–10 ký tự, chỉ chữ không dấu và số (VD: KU, ZP6).'
    else if (d.models.some((x) => x.id !== m?.id && x.code_prefix === pfx)) e.prefix = 'Tiền tố này đã dùng cho model khác.'
    if (price.trim() && (p == null || p < 0 || !Number.isInteger(p))) e.price = 'Nhập giá bằng đồng (VD: 5.400.000) hoặc để trống.'
    if (l == null || l < 0 || !Number.isInteger(l)) e.low = 'Nhập số nguyên ≥ 0.'
    setErrs(e)
    if (e.name || e.prefix || e.price || e.low) return
    setBusy(true)
    const aliases = [...new Set(alias.split(',').map((s) => s.trim()).filter(Boolean))]
    const row = { name: n, brand: brand.trim() || '1Zpresso', code_prefix: pfx, default_list_price_vnd: p, low_stock_threshold: l, aliases }
    try {
      if (m) await updateVersioned('models', m.id, m.version, row, 'Model')
      else {
        const sort = Math.max(0, ...d.models.map((x) => x.sort_order)) + 1
        const { error } = await supabase.from('models').insert({ ...row, sort_order: sort })
        if (error) throw new Error(writeError(error, 'Model'))
      }
      await reload(); toast(m ? `Đã lưu model ${n}` : `Đã thêm model ${n}`); onClose()
    } catch (err) { setErrs({ form: (err as Error).message }); await reload() } finally { setBusy(false) }
  }

  async function toggleActive() {
    if (!m) return
    setBusy(true); setErrs({})
    try {
      await updateVersioned('models', m.id, m.version, { is_active: !m.is_active }, 'Model')
      await reload(); toast(m.is_active ? `Đã ẩn ${m.name}` : `Đã hiện lại ${m.name}`); onClose()
    } catch (e) { setErrs({ form: (e as Error).message }); await reload() } finally { setBusy(false) }
  }

  async function remove() {
    if (!m) return
    setBusy(true); setErrs({})
    const { data, error } = await supabase.from('models').delete().eq('id', m.id).select('id')
    if (error || !data?.length) {
      setBusy(false); setConfirmDel(false)
      setErrs({ form: error ? writeError(error, `Model ${m.name}`) : 'Không xoá được — dữ liệu đã đổi, thử lại.' })
      await reload(); return
    }
    await reload(); setBusy(false); toast(`Đã xoá ${m.name}`); onClose()
  }

  return (
    <Sheet title={m ? `Sửa model · ${m.name}` : 'Thêm model'} onClose={onClose}
      footer={<button className="btn btn-primary btn-block" id="nm-save" onClick={save} disabled={busy}>{busy ? 'Đang lưu…' : 'Lưu'}</button>}>
      <label className="f">Tên model
        <input className={`input ${errs.name ? 'invalid' : ''}`} id="nm-name" maxLength={80} placeholder="VD: K Ultra" value={name} onChange={(e) => setName(e.target.value)} />
        {errs.name && <span className="field-err">{errs.name}</span>}
      </label>
      <div className="two">
        <label className="f">Hãng
          <input className="input" id="nm-brand" maxLength={60} value={brand} onChange={(e) => setBrand(e.target.value)} />
        </label>
        <label className="f">Tiền tố mã chiếc
          <input className={`input ${errs.prefix ? 'invalid' : ''}`} id="nm-prefix" maxLength={10} placeholder="VD: KU" autoCapitalize="characters"
            value={prefix} onChange={(e) => setPrefix(normPrefix(e.target.value))} />
          {errs.prefix && <span className="field-err">{errs.prefix}</span>}
        </label>
      </div>
      {PREFIX_RE.test(pfx) && <p className="hint" style={{ margin: 0 }}>Chiếc tiếp theo: <b className="num">{nextCode({ code_prefix: pfx, next_seq: m?.next_seq ?? 1 })}</b></p>}
      {prefixChanged && used > 0 && <p className="warn-box">Đổi tiền tố chỉ áp cho chiếc nhập sau. {used} chiếc đã có giữ mã cũ ({m?.code_prefix}-…); số thứ tự tiếp tục, không đánh lại.</p>}
      <div className="two">
        <label className="f">Giá bán mặc định (₫)
          <input className={`input money ${errs.price ? 'invalid' : ''}`} id="nm-price" inputMode="numeric" placeholder="điền sẵn cho chiếc mới" value={price} onChange={(e) => setPrice(e.target.value)} />
          {errs.price && <span className="field-err">{errs.price}</span>}
        </label>
        <label className="f">“Sắp hết” khi bán được còn ≤
          <input className={`input money ${errs.low ? 'invalid' : ''}`} id="nm-low" inputMode="numeric" value={low} onChange={(e) => setLow(e.target.value)} />
          {errs.low && <span className="field-err">{errs.low}</span>}
        </label>
      </div>
      <label className="f">Tên gọi khác (cho AI nhận, cách nhau dấu phẩy)
        <input className="input" id="nm-alias" placeholder="VD: KU, K-Ultra" value={alias} onChange={(e) => setAlias(e.target.value)} />
      </label>
      {m && (
        <>
          {confirmDel && <p className="warn-box">Xoá vĩnh viễn model “{m.name}”? Chỉ xoá được khi chưa có chiếc cối nào. Không hoàn tác được.</p>}
          {!confirmDel && used > 0 && <p className="hint" style={{ margin: 0 }}>Model đã có {used} chiếc — không xoá được, chỉ ẩn (BR-14).</p>}
          <div className="btn-row">
            <button className="btn btn-ghost" id="nm-toggle" disabled={busy} onClick={toggleActive}>{m.is_active ? 'Ẩn' : 'Hiện lại'}</button>
            {confirmDel
              ? <button className="btn btn-danger" id="nm-del-confirm" disabled={busy} onClick={remove}>{busy ? 'Đang xoá…' : 'Xoá vĩnh viễn'}</button>
              : <button className="btn btn-danger" id="nm-del" disabled={busy} onClick={() => setConfirmDel(true)}>Xoá</button>}
          </div>
        </>
      )}
      {errs.form && <p className="err-text">{errs.form}</p>}
    </Sheet>
  )
}
