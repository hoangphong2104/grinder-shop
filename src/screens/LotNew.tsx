// SC_06 Nhập lô Goofish (/lo/new) + sửa lô chưa nhận (/lo/:id/sua). Khối AI quét ở đầu form (BR-13: chỉ điền sẵn,
// không tự lưu). Xem trước tiền bằng src/domain; số chính thức do DB tính sau khi save_lot.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useData, useStore } from '../data/store.tsx'
import type { LotRow, SellerRow } from '../data/types.ts'
import { supabase } from '../lib/supabase.ts'
import { Shell } from '../ui/Shell.tsx'
import { useToast } from '../ui/feedback.tsx'
import { Icon } from '../ui/icons.tsx'
import { parseNum, todayVn, tr, vnd } from '../ui/format.ts'
import { lotGoodsVnd, lotPayable, unitCost, unitCostBeforeShip, type Lot } from '../domain/index.ts'
import { linesOf, variantName } from './lots/common.tsx'
import { invokeScan, matchModelByAlias, MAX_TEXT, uploadScreenshot, type ScanResponse } from './lots/scan.ts'
import '../styles/lots.css'

interface LineDraft { variantId: string; qty: string; cny: string }
interface Draft {
  url: string; title: string; sellerNick: string; region: string; lines: LineDraft[]
  rate: string; shipFee: string; orderedAt: string; note: string
}
type MarkKey = 'title' | 'seller' | 'region' | 'variant' | 'cny'
type Marks = Partial<Record<MarkKey, 'ai' | 'low'>>
interface AiInfo { notes: string | null; condition: string | null; usage: ScanResponse['usage'] | null; modelHint: string | null }

/** Item id Goofish từ link (?id=… hoặc &id=…). DB chỉ nhận 6–24 chữ số. */
const itemIdOf = (u: string) => { const m = u.match(/[?&]id=(\d{6,})/); return m && m[1].length <= 24 ? m[1] : null }
/** Số → chuỗi ô nhập kiểu VN (dấu phẩy thập phân). */
const numStr = (n: number | null | undefined) => (n == null ? '' : String(n).replace('.', ','))
const findSeller = (sellers: SellerRow[], nick: string) => {
  const k = nick.trim().toLowerCase()
  return k ? sellers.find((s) => s.nickname.trim().toLowerCase() === k) : undefined
}
const lineId = (base: string, i: number) => (i === 0 ? base : `${base}-${i + 1}`)

function initDraft(lot: LotRow | undefined, d: ReturnType<typeof useData>): Draft {
  if (!lot) {
    return {
      url: '', title: '', sellerNick: '', region: '', lines: [{ variantId: '', qty: '1', cny: '' }],
      rate: numStr(d.suggestions.last_exchange_rate), shipFee: '', orderedAt: todayVn(), note: '',
    }
  }
  const s = lot.seller_id ? d.sellers.find((x) => x.id === lot.seller_id) : undefined
  const lines = linesOf(d, lot.id)
  return {
    url: lot.goofish_url ?? (lot.goofish_item_id ? `https://www.goofish.com/item?id=${lot.goofish_item_id}` : ''),
    title: lot.listing_title ?? '', sellerNick: s?.nickname ?? '', region: s?.region ?? '',
    lines: lines.length ? lines.map((x) => ({ variantId: x.variant_id, qty: String(x.qty), cny: numStr(Number(x.price_cny)) })) : [{ variantId: '', qty: '1', cny: '' }],
    rate: numStr(Number(lot.exchange_rate)), shipFee: lot.ship_fee_vnd == null ? '' : String(lot.ship_fee_vnd),
    orderedAt: lot.ordered_at, note: lot.note ?? '',
  }
}

export default function LotNew() {
  const { id } = useParams()
  const d = useData()
  const lot = id ? d.lots.find((x) => x.id === id) : undefined
  if (id && !lot) {
    return (
      <Shell section="lo" title="Sửa lô" back="/lo">
        <div className="empty">Không tìm thấy lô. <Link className="link-btn" to="/lo">Về danh sách lô</Link></div>
      </Shell>
    )
  }
  if (lot && (lot.status === 'received' || lot.status === 'cancelled')) {
    return (
      <Shell section="lo" title={`Sửa ${d.lotCode[lot.id]}`} back={`/lo/${lot.id}`}>
        <div className="note-box">
          <span>{lot.status === 'received' ? 'Lô đã nhận chỉ sửa được phí ship và ghi chú (Q-014) — làm ở trang chi tiết lô.' : 'Lô đã huỷ — không sửa được.'}</span>
        </div>
        <Link className="btn btn-ghost btn-block" to={`/lo/${lot.id}`}>Về chi tiết lô</Link>
      </Shell>
    )
  }
  return <LotForm key={lot?.id ?? 'new'} lot={lot} />
}

function LotForm({ lot }: { lot: LotRow | undefined }) {
  const d = useData()
  const { rpc, session } = useStore()
  const toast = useToast()
  const nav = useNavigate()
  const [draft, setDraft] = useState<Draft>(() => initDraft(lot, d))
  const [version] = useState(lot?.version ?? null) // version lúc mở form — bắt sửa đồng thời
  const [marks, setMarks] = useState<Marks>({})
  const [errs, setErrs] = useState<Record<string, string>>({})
  const [mode, setMode] = useState<'img' | 'text'>('img')
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [uploaded, setUploaded] = useState<{ file: File; path: string } | null>(null)
  const [keptShot, setKeptShot] = useState<string | null>(lot?.screenshot_path ?? null)
  const [scanning, setScanning] = useState(false)
  const [saving, setSaving] = useState(false)
  const [ai, setAi] = useState<AiInfo | null>(null)
  const draftRef = useRef(draft)
  draftRef.current = draft
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])

  const editing = !!lot
  const code = lot ? d.lotCode[lot.id] : `L-${String(d.lots.length + 1).padStart(3, '0')}`
  const scanOn = d.settings?.ai_scan_enabled ?? true
  const modelActive = (mid: string) => d.models.find((m) => m.id === mid)?.is_active ?? false
  const activeVariants = d.variants.filter((v) => v.is_active && modelActive(v.model_id))
  const sellers = d.sellers.filter((s) => !s.is_hidden)

  // ---- Sửa ô ----
  const set = <K extends keyof Draft>(k: K, v: Draft[K], mark?: MarkKey) => {
    setDraft((p) => ({ ...p, [k]: v }))
    if (mark) setMarks((m) => { const n = { ...m }; delete n[mark]; return n })
    setErrs((e) => { const n = { ...e }; delete n[`f-${k === 'orderedAt' ? 'date' : k === 'shipFee' ? 'ship' : k === 'sellerNick' ? 'seller' : k}`]; return n })
  }
  const setLine = (i: number, k: keyof LineDraft, v: string) => {
    setDraft((p) => ({ ...p, lines: p.lines.map((x, j) => (j === i ? { ...x, [k]: v } : x)) }))
    if (i === 0 && (k === 'variantId' || k === 'cny')) setMarks((m) => { const n = { ...m }; delete n[k === 'cny' ? 'cny' : 'variant']; return n })
    const base = k === 'variantId' ? 'f-variant' : k === 'qty' ? 'f-qty' : 'f-cny'
    setErrs((e) => { const n = { ...e }; delete n[lineId(base, i)]; return n })
  }
  const addLine = () => setDraft((p) => (p.lines.length >= 20 ? p : { ...p, lines: [...p.lines, { variantId: '', qty: '1', cny: '' }] }))
  const removeLine = (i: number) => setDraft((p) => ({ ...p, lines: p.lines.filter((_, j) => j !== i) }))

  // ---- Ảnh ----
  const pickFile = (f: File | null) => {
    setFile(f)
    setPreview(f ? URL.createObjectURL(f) : null)
  }
  const dropImage = () => { pickFile(null); setUploaded(null); setKeptShot(null) }
  /** Đường dẫn ảnh sẽ lưu vào lô: ảnh mới (upload nếu chưa) hoặc ảnh cũ của lô. */
  const ensureUploaded = async (): Promise<string | null> => {
    if (!file) return keptShot
    if (uploaded?.file === file) return uploaded.path
    const uid = session?.user.id
    if (!uid) throw new Error('Phiên đăng nhập đã hết. Đăng nhập lại.')
    const path = await uploadScreenshot(uid, file)
    setUploaded({ file, path })
    return path
  }

  // ---- AI quét ----
  const applyScan = (r: ScanResponse) => {
    const th = Number(d.settings?.ai_confidence_threshold ?? 0.7)
    const flags = new Set(r.flags ?? [])
    const f = r.fields ?? {}
    const good = <T,>(k: string, x: { value: T | null; confidence: number } | undefined): x is { value: T; confidence: number } =>
      !!x && x.value != null && x.value !== '' && Number(x.confidence) >= th && !flags.has(k)

    // Model · màu: biến thể chắc ⇒ dùng; không thì khớp model (AI hoặc tên gọi khác) — model chỉ có 1 màu đang bán ⇒ chọn luôn.
    let variantId: string | null = null, modelHint: string | null = null
    const aiVar = good('variant_id', f.variant_id) ? f.variant_id.value : null
    const aiModel = good('model_id', f.model_id) ? f.model_id.value : null
    if (aiVar && activeVariants.some((v) => v.id === aiVar)) variantId = aiVar
    else {
      const byId = aiModel ? d.models.find((m) => m.id === aiModel && m.is_active) : undefined
      const model = byId ?? matchModelByAlias(d.models, [f.model_id?.matched_text, good('listing_title', f.listing_title) ? f.listing_title.value : null])
      if (model) {
        const vs = activeVariants.filter((v) => v.model_id === model.id)
        if (vs.length === 1) variantId = vs[0].id
        else modelHint = model.name
      }
    }

    const cur = draftRef.current
    const next: Draft = { ...cur, lines: cur.lines.map((x) => ({ ...x })) }
    const m: Marks = {}
    const fill = (key: MarkKey, empty: boolean, ok: boolean, apply: () => void) => {
      if (!empty) return // chỉ điền ô người dùng chưa gõ
      if (ok) { apply(); m[key] = 'ai' } else m[key] = 'low'
    }
    const sellerNick = r.seller_match?.nickname ?? (good('seller_nickname', f.seller_nickname) ? f.seller_nickname.value : null)
    fill('title', !cur.title.trim(), good('listing_title', f.listing_title), () => { next.title = String(f.listing_title!.value).slice(0, 300) })
    fill('seller', !cur.sellerNick.trim(), good('seller_nickname', f.seller_nickname) && !!sellerNick, () => { next.sellerNick = String(sellerNick).slice(0, 100) })
    fill('region', !cur.region.trim(), good('seller_region', f.seller_region), () => { next.region = String(f.seller_region!.value).slice(0, 100) })
    fill('cny', !cur.lines[0].cny.trim(), good('price_cny', f.price_cny) && Number(f.price_cny!.value) > 0, () => { next.lines[0].cny = numStr(Number(f.price_cny!.value)) })
    fill('variant', !cur.lines[0].variantId, variantId != null, () => { next.lines[0].variantId = variantId! })

    setDraft(next)
    setMarks((p) => ({ ...p, ...m }))
    setAi({ notes: r.notes ?? null, condition: r.condition_text ?? null, usage: r.usage ?? null, modelHint: m.variant === 'low' ? modelHint : null })
  }

  const scan = async () => {
    if (mode === 'img' && !file && !keptShot) return toast('Chọn ảnh chụp tin trước')
    if (mode === 'text' && !text.trim()) return toast('Dán chữ từ trang tin trước')
    if (mode === 'text' && text.length > MAX_TEXT) return toast('Chữ dán tối đa 20.000 ký tự — bớt phần thừa')
    setScanning(true)
    try {
      const input = mode === 'img'
        ? { kind: 'image' as const, image_path: (await ensureUploaded())! }
        : { kind: 'text' as const, text: text.trim() }
      const r = await invokeScan(input, draftRef.current.url.trim() || null)
      applyScan(r)
      toast('AI đã điền — kiểm tra ô đánh dấu')
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e))
    } finally { setScanning(false) }
  }

  // ---- Xem trước tiền (domain) ----
  const rate = parseNum(draft.rate), ship = parseNum(draft.shipFee)
  const pl = draft.lines.map((x) => ({ variantId: x.variantId, qty: parseNum(x.qty) ?? 0, cny: parseNum(x.cny) }))
  const calcOk = rate != null && rate > 0 && pl.every((x) => x.qty > 0 && x.cny != null && x.cny > 0) && (ship == null || ship >= 0)
  const dl: Lot | null = calcOk
    ? { id: lot?.id ?? 'draft', orderedAt: draft.orderedAt, rate: rate!, shipFee: ship, status: 'dat', receivedAt: null, lines: pl.map((x) => ({ variantId: x.variantId, qty: x.qty, cny: x.cny! })) }
    : null

  // ---- Gợi ý / cảnh báo ----
  const iid = itemIdOf(draft.url)
  const dup = iid ? d.lots.find((l) => l.goofish_item_id === iid && l.status !== 'cancelled' && l.id !== lot?.id) : undefined
  const sMatch = findSeller(d.sellers, draft.sellerNick)
  const shipPer = d.suggestions.last_ship_fee_per_unit_vnd

  // ---- Lưu ----
  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {}
    if (draft.url.length > 500) e['f-url'] = 'Link tối đa 500 ký tự.'
    if (draft.title.length > 300) e['f-title'] = 'Tiêu đề tối đa 300 ký tự.'
    if (draft.sellerNick.trim().length > 100) e['f-seller'] = 'Nickname tối đa 100 ký tự.'
    if (draft.region.length > 100) e['f-region'] = 'Khu vực tối đa 100 ký tự.'
    draft.lines.forEach((x, i) => {
      const q = parseNum(x.qty), c = parseNum(x.cny)
      if (!x.variantId) e[lineId('f-variant', i)] = 'Chọn model · màu.'
      if (q == null || !Number.isInteger(q) || q < 1 || q > 1000) e[lineId('f-qty', i)] = 'Số lượng là số nguyên từ 1 đến 1.000.'
      if (c == null || c <= 0 || c > 100000) e[lineId('f-cny', i)] = 'Nhập giá ¥ / chiếc (lớn hơn 0).'
      else if (Math.abs(c * 100 - Math.round(c * 100)) > 1e-6) e[lineId('f-cny', i)] = 'Giá ¥ tối đa 2 chữ số thập phân.'
    })
    if (rate == null || rate <= 0 || rate >= 1e8) e['f-rate'] = 'Nhập tỷ giá ₫/¥ (lớn hơn 0).'
    if (draft.shipFee.trim() && (ship == null || !Number.isInteger(ship) || ship < 0)) e['f-ship'] = 'Phí ship là số đồng nguyên ≥ 0, hoặc để trống.'
    if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.orderedAt)) e['f-date'] = 'Chọn ngày đặt.'
    if (draft.note.length > 2000) e['f-note'] = 'Ghi chú tối đa 2.000 ký tự.'
    return e
  }

  const save = async () => {
    const e = validate()
    setErrs(e)
    const first = Object.keys(e)[0]
    if (first) {
      toast('Kiểm tra các ô báo đỏ')
      document.getElementById(first)?.focus()
      return
    }
    setSaving(true)
    try {
      let shot: string | null
      try { shot = await ensureUploaded() } catch (err) {
        toast((err instanceof Error ? err.message : String(err)) + ' Hoặc bấm "Bỏ ảnh" để lưu không kèm ảnh.')
        setSaving(false)
        return
      }
      const nick = draft.sellerNick.trim()
      const existing = findSeller(d.sellers, nick)
      const region = draft.region.trim()
      const p_lot: Record<string, unknown> = {
        goofish_url: draft.url.trim() || null,
        goofish_item_id: itemIdOf(draft.url.trim()),
        seller_id: existing?.id ?? null,
        screenshot_path: shot,
        listing_title: draft.title.trim() || null,
        ordered_at: draft.orderedAt,
        exchange_rate: Math.round(rate! * 100) / 100,
        ship_fee_vnd: draft.shipFee.trim() ? ship : null,
        status: lot?.status ?? 'ordered',
        note: draft.note.trim() || null,
      }
      if (!existing && nick) p_lot.new_seller = { nickname: nick, region: region || null, profile_url: null }
      const p_lines = draft.lines.map((x) => ({ variant_id: x.variantId, qty: parseNum(x.qty), price_cny: Math.round(parseNum(x.cny)! * 100) / 100 }))
      const r = await rpc<{ lot_id: string; version: number; duplicate_lot_ids: string[] }>('save_lot', {
        p_lot_id: lot?.id ?? null, p_lot, p_lines, p_expected_version: lot ? version : null,
      })
      // Người bán cũ chưa có khu vực ⇒ ghi bổ sung (bảng sellers được ghi trực tiếp).
      if (existing && !existing.region && region) await supabase.from('sellers').update({ region }).eq('id', existing.id)
      toast(`Đã lưu ${code}${dl ? ` · phải trả trung gian ${tr(lotPayable(dl))}` : ''}`)
      nav(`/lo/${r.lot_id}`, { replace: true })
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  // ---- Giao diện ----
  const flag = (k: MarkKey) => marks[k]
    ? <span className={`ai-flag ${marks[k] === 'low' ? 'low' : ''}`}><Icon name="spark" size={12} />{marks[k] === 'low' ? 'AI không chắc — kiểm tra' : 'AI điền'}</span>
    : null
  const cls = (k: MarkKey, extra = '') => `input ${extra} ${marks[k] ? 'ai' : ''}`.trim()
  const err = (fid: string): ReactNode => (errs[fid] ? <span className="err-text" role="alert">{errs[fid]}</span> : null)
  const variantOptions = (cur: string) => {
    const list = activeVariants.some((v) => v.id === cur) || !cur ? activeVariants : [...activeVariants, ...d.variants.filter((v) => v.id === cur)]
    return list.map((v) => <option key={v.id} value={v.id}>{variantName(d, v.id)}{v.is_active && modelActive(v.model_id) ? '' : ' (đã ẩn)'}</option>)
  }

  const scanBlock = (
    <div className="full stack">
      <div className="seg">
        <button type="button" aria-pressed={mode === 'img'} onClick={() => setMode('img')}>Ảnh chụp</button>
        <button type="button" aria-pressed={mode === 'text'} onClick={() => setMode('text')}>Dán chữ</button>
      </div>
      {mode === 'img' ? (
        <>
          <label className={`drop ${file || keptShot ? 'has' : ''}`}>
            <Icon name="cam" />
            <span>{file ? 'Đã chọn 1 ảnh · chạm để đổi' : keptShot ? 'Lô đã có ảnh chụp · chạm để đổi' : 'Chụp / chọn ảnh tin trong app 闲鱼 (thấy giá + tên người bán)'}</span>
            <input type="file" id="f-img" accept="image/*" onChange={(e) => { pickFile(e.target.files?.[0] ?? null); e.target.value = '' }} />
          </label>
          {preview && <img className="scan-preview" src={preview} alt="Ảnh tin đã chọn" />}
          {(file || keptShot) && <button type="button" className="link-btn small" style={{ alignSelf: 'center' }} onClick={dropImage}>Bỏ ảnh</button>}
        </>
      ) : (
        <textarea className="input" id="f-text" value={text} maxLength={MAX_TEXT} onChange={(e) => setText(e.target.value)}
          placeholder="Trên máy tính: mở tin Goofish (đã đăng nhập) → Cmd/Ctrl + A → Cmd/Ctrl + C → dán vào đây" />
      )}
      <button type="button" className="btn btn-ghost btn-block" id="f-scan" disabled={scanning || !scanOn} onClick={scan}>
        {scanning ? <><span className="spin" /> AI đang đọc tin…</> : <><Icon name="spark" /> Quét bằng AI</>}
      </button>
      <p className="hint" style={{ textAlign: 'center' }}>
        {scanOn
          ? 'Goofish chặn đọc thẳng từ link — AI đọc ảnh hoặc chữ bạn đưa. Không quét vẫn nhập tay được.'
          : <>AI quét đang tắt trong <Link className="link-btn small" to="/caidat">Cài đặt</Link> — nhập tay bên dưới.</>}
      </p>
      {ai && (ai.notes || ai.condition || ai.usage) && (
        <div className="note-box way" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
          {ai.notes && <span>AI ghi chú: {ai.notes}</span>}
          {ai.condition && <span>Tình trạng trong tin: {ai.condition}</span>}
          {ai.usage && <span className="small">Đã dùng {ai.usage.scans_this_month}/{ai.usage.cap} lượt quét tháng này.</span>}
        </div>
      )}
    </div>
  )

  return (
    <Shell section="lo" title={editing ? `Sửa ${code}` : 'Nhập lô Goofish'} back={editing ? `/lo/${lot!.id}` : '/lo'}
      savebar={<button className="btn btn-primary btn-block" disabled={saving || scanning} onClick={save}>{saving ? <><span className="spin" /> Đang lưu…</> : editing ? 'Lưu thay đổi' : 'Lưu lô'}</button>}>
      <div className="form-grid">
        <label className="f full">Link tin Goofish
          <input className="input" id="f-url" value={draft.url} placeholder="https://www.goofish.com/item?id=…" inputMode="url" maxLength={500}
            onChange={(e) => set('url', e.target.value)} />
          {err('f-url')}
        </label>
        {dup && (
          <div className="warn-box full">
            <Icon name="warn" size={18} />
            <span>Tin này đã có trong <Link className="link-btn small" to={`/lo/${dup.id}`}>{d.lotCode[dup.id]}</Link>. Lưu tiếp sẽ tạo lô thứ hai.</span>
          </div>
        )}
        {scanBlock}

        <p className="section-title full">Thông tin lô</p>
        <label className="f full"><span className="lrow">Tiêu đề tin {flag('title')}</span>
          <input className={cls('title')} id="f-title" value={draft.title} maxLength={300} onChange={(e) => set('title', e.target.value, 'title')} />
          {err('f-title')}
        </label>
        <label className="f"><span className="lrow">Người bán (nickname) {flag('seller')}</span>
          <input className={cls('seller')} id="f-seller" value={draft.sellerNick} list="lot-sellers" maxLength={100} autoComplete="off"
            onChange={(e) => set('sellerNick', e.target.value, 'seller')} />
          <datalist id="lot-sellers">{sellers.map((s) => <option key={s.id} value={s.nickname} />)}</datalist>
          {sMatch
            ? <span className="hint">Người bán cũ · đã mua {d.lots.filter((l) => l.seller_id === sMatch.id).length} lô{sMatch.is_avoided && <> · <span className="req">đang đánh dấu TRÁNH</span></>}</span>
            : draft.sellerNick.trim() ? <span className="hint">Người bán mới — sẽ thêm vào danh bạ</span> : null}
          {err('f-seller')}
        </label>
        <label className="f"><span className="lrow">Khu vực {flag('region')}</span>
          <input className={cls('region')} id="f-region" value={draft.region} maxLength={100} placeholder={sMatch?.region ?? ''}
            onChange={(e) => set('region', e.target.value, 'region')} />
          {err('f-region')}
        </label>

        <div className="full stack">
          {draft.lines.map((x, i) => (
            <div className="lot-line" key={i}>
              <label className="f">
                <span className="lrow">
                  <span>Model · màu <span className="req">*</span>{draft.lines.length > 1 ? ` (dòng ${i + 1})` : ''} {i === 0 && flag('variant')}</span>
                  {i > 0 && <button type="button" className="link-btn" onClick={() => removeLine(i)}>Bỏ dòng</button>}
                </span>
                <select className={i === 0 ? cls('variant') : 'input'} id={lineId('f-variant', i)} value={x.variantId} onChange={(e) => setLine(i, 'variantId', e.target.value)}>
                  <option value="">Chọn…</option>
                  {variantOptions(x.variantId)}
                </select>
                {i === 0 && ai?.modelHint && !x.variantId && <span className="hint">AI nhận ra model {ai.modelHint} — chọn màu.</span>}
                {!activeVariants.length && <span className="hint">Chưa có model · màu đang bán — thêm ở <Link className="link-btn small" to="/danhmuc">Model & màu</Link>.</span>}
                {err(lineId('f-variant', i))}
              </label>
              <div className="two">
                <label className="f">Số lượng <span className="req">*</span>
                  <input className="input money" id={lineId('f-qty', i)} inputMode="numeric" value={x.qty} onChange={(e) => setLine(i, 'qty', e.target.value)} />
                  {err(lineId('f-qty', i))}
                </label>
                <label className="f"><span className="lrow">Giá ¥ / chiếc <span className="req">*</span> {i === 0 && flag('cny')}</span>
                  <input className={i === 0 ? cls('cny', 'money') : 'input money'} id={lineId('f-cny', i)} inputMode="decimal" value={x.cny}
                    onChange={(e) => setLine(i, 'cny', e.target.value)} />
                  {err(lineId('f-cny', i))}
                </label>
              </div>
            </div>
          ))}
          {draft.lines.length < 20 && <button type="button" className="link-btn" style={{ alignSelf: 'flex-start' }} onClick={addLine}><Icon name="plus" size={14} /> Thêm dòng hàng (model · màu khác)</button>}
        </div>

        <div className="two">
          <label className="f">Tỷ giá ₫/¥ <span className="req">*</span>
            <input className="input money" id="f-rate" inputMode="decimal" value={draft.rate} onChange={(e) => set('rate', e.target.value)} />
            <span className="hint">{d.suggestions.last_exchange_rate != null ? 'Gợi ý: tỷ giá lô gần nhất' : 'Chưa có lô trước để gợi ý'}</span>
            {err('f-rate')}
          </label>
          <label className="f">Phí ship về VN (cả lô)
            <input className="input money" id="f-ship" inputMode="numeric" value={draft.shipFee} placeholder="để trống" onChange={(e) => set('shipFee', e.target.value)} />
            <span className="hint">Thường biết khi hàng về{shipPer != null ? ` · lô trước ~${tr(shipPer)}/chiếc` : ''}</span>
            {err('f-ship')}
          </label>
        </div>
        <label className="f">Ngày đặt
          <input className="input" id="f-date" type="date" value={draft.orderedAt} onChange={(e) => set('orderedAt', e.target.value)} />
          {err('f-date')}
        </label>
        <label className="f">Ghi chú
          <input className="input" id="f-note" value={draft.note} maxLength={2000} onChange={(e) => set('note', e.target.value)} />
          {err('f-note')}
        </label>

        <div className="calc full">
          <div className="ln"><span>Tiền hàng</span><span>{dl ? vnd(lotGoodsVnd(dl)) : '—'}</span></div>
          <div className="ln"><span>Phí ship về VN</span><span>{ship != null ? vnd(ship) : 'chưa nhập'}</span></div>
          {(dl ? dl.lines : [null]).map((x, i) => (
            <div className={`ln ${i === 0 ? 'total' : ''}`} key={i}>
              <span>Giá vốn / chiếc{dl && dl.lines.length > 1 && x ? ` · ${x.variantId ? variantName(d, x.variantId) : `dòng ${i + 1}`}` : ''}</span>
              <span>
                {dl && x ? (dl.shipFee != null ? vnd(unitCost(dl, x)) : <>{vnd(unitCostBeforeShip(dl, x))} <span className="muted small">+ ship</span></>) : '—'}
              </span>
            </div>
          ))}
          <div className="ln"><span>Phải trả trung gian</span><span>{dl ? vnd(lotPayable(dl)) : '—'}</span></div>
          <div className="formula">= giá web ¥ × tỷ giá + ship ÷ số chiếc</div>
        </div>
      </div>
    </Shell>
  )
}
