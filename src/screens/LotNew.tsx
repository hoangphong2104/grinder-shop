// SC_06 Nhập lô Goofish (/lo/new) + sửa lô chưa nhận (/lo/:id/sua). v0.2 (CR-001 A2): lô = các NHÓM CHIẾC
// (model, số lượng N, giá ¥ / chiếc, giá bán dự kiến / chiếc) → DB tạo N chiếc, mỗi chiếc 1 mã (D1). Sửa lô chưa
// nhận: sửa / bỏ từng chiếc cũ (không bỏ được chiếc đang giữ cho đơn — UNIT_RESERVED) và thêm nhóm mới.
// Khối AI quét ở đầu form (BR-13: chỉ điền sẵn, không tự lưu). Xem trước bằng src/domain; số chính thức do DB tính.
// v0.3 (CR-003): ô "Phí mua hộ %" cạnh tỷ giá — lô mới điền sẵn mặc định trong Cài đặt; tính vào giá nhập ₫ / chiếc
// và phải trả trung gian. Lô đã nhận thì phí khoá như tỷ giá (form sửa không mở cho lô đã nhận).
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useData, useStore } from '../data/store.tsx'
import type { DbData, LotRow, ModelRow, SellerRow } from '../data/types.ts'
import { supabase } from '../lib/supabase.ts'
import { Shell } from '../ui/Shell.tsx'
import { useToast } from '../ui/feedback.tsx'
import { Icon } from '../ui/icons.tsx'
import { UnitChip } from '../ui/status.tsx'
import { parseNum, pct, todayVn, tr, vnd } from '../ui/format.ts'
import { autoUnitCost, formatUnitCode, isBuyingFeePct, lotBuyingFeeVnd, lotGoodsVnd, lotPayable, unitCostBeforeShip, type Unit } from '../domain/index.ts'
import { codesText, lotFeePct, rangeText, unitsOfLot } from './lots/common.tsx'
import { MAX_GROUP_ITEMS } from './lots/LotFlow.tsx'
import { errText, RpcError, useRpcDetail } from './lots/rpc.ts'
import { invokeScan, matchModelByAlias, MAX_TEXT, uploadScreenshot, type ScanResponse } from './lots/scan.ts'
import '../styles/lots.css'

/** Nhóm chiếc mới: listAuto = giá bán đang là giá mặc định của model (đổi model ⇒ đổi theo). */
interface GroupDraft { key: number; modelId: string; qty: string; cny: string; list: string; listAuto: boolean }
/** Chiếc đã có của lô đang sửa. */
interface UnitDraft {
  unitId: string; code: string; modelId: string; modelName: string; cny: string; list: string; removed: boolean
  holder: string | null; status: Parameters<typeof UnitChip>[0]['s']; costOverride: number | null
}
interface Draft {
  url: string; title: string; sellerNick: string; region: string; groups: GroupDraft[]; units: UnitDraft[]
  rate: string; feePct: string; shipFee: string; orderedAt: string; note: string
}
type MarkKey = 'title' | 'seller' | 'region' | 'model' | 'qty' | 'cny'
type Marks = Partial<Record<MarkKey, 'ai' | 'low'>>
interface AiInfo { notes: string | null; condition: string | null; usage: ScanResponse['usage'] | null; modelHint: ModelRow | null }
interface SaveResult { lot_id: string; version: number; created_units?: { unit_id: string; code: string }[]; removed_units?: { code: string }[] }

const MAX_LOT_UNITS = 1000
/** Item id Goofish từ link (?id=… hoặc &id=…). DB chỉ nhận 6–24 chữ số. */
const itemIdOf = (u: string) => { const m = u.match(/[?&]id=(\d{6,})/); return m && m[1].length <= 24 ? m[1] : null }
/** Số → chuỗi ô nhập kiểu VN (dấu phẩy thập phân). */
const numStr = (n: number | null | undefined) => (n == null ? '' : String(n).replace('.', ','))
const findSeller = (sellers: SellerRow[], nick: string) => {
  const k = nick.trim().toLowerCase()
  return k ? sellers.find((s) => s.nickname.trim().toLowerCase() === k) : undefined
}
const lineId = (base: string, i: number) => (i === 0 ? base : `${base}-${i + 1}`)
const round2 = (n: number) => Math.round(n * 100) / 100
/** Giá ¥ hợp lệ: > 0, ≤ 100.000, tối đa 2 chữ số thập phân — trả thông báo lỗi hoặc null. */
function cnyError(v: string): string | null {
  const c = parseNum(v)
  if (c == null || c <= 0 || c > 100000) return 'Nhập giá ¥ / chiếc (lớn hơn 0).'
  if (Math.abs(c * 100 - Math.round(c * 100)) > 1e-6) return 'Giá ¥ tối đa 2 chữ số thập phân.'
  return null
}
/** Giá bán dự kiến: trống hoặc số đồng nguyên ≥ 0. */
function listError(v: string): string | null {
  if (!v.trim()) return null
  const n = parseNum(v)
  return n == null || !Number.isInteger(n) || n < 0 ? 'Giá bán là số đồng nguyên ≥ 0, hoặc để trống.' : null
}
const listVal = (v: string) => (v.trim() ? parseNum(v) : null)

let groupKey = 0
const newGroup = (): GroupDraft => ({ key: ++groupKey, modelId: '', qty: '1', cny: '', list: '', listAuto: true })
const defaultList = (d: DbData, modelId: string) => numStr(d.models.find((m) => m.id === modelId)?.default_list_price_vnd ?? null)

/** modelId (tuỳ chọn, từ /lo/new?model=…): chỉ nhận model đang bán — điền sẵn model + giá bán mặc định nhóm đầu. */
function initDraft(lot: LotRow | undefined, d: DbData, modelId?: string | null): Draft {
  if (!lot) {
    const g = newGroup()
    if (modelId && d.models.some((m) => m.id === modelId && m.is_active)) { g.modelId = modelId; g.list = defaultList(d, modelId) }
    return {
      url: '', title: '', sellerNick: '', region: '', groups: [g], units: [],
      rate: numStr(d.suggestions.last_exchange_rate), feePct: numStr(Number(d.settings?.default_buying_fee_pct ?? 0)),
      shipFee: '', orderedAt: todayVn(), note: '',
    }
  }
  const s = lot.seller_id ? d.sellers.find((x) => x.id === lot.seller_id) : undefined
  const units = unitsOfLot(d, lot.id).map((u): UnitDraft => ({
    unitId: u.unit_id, code: u.code, modelId: u.model_id, modelName: u.model_name, cny: numStr(Number(u.price_cny)),
    list: numStr(u.list_price_vnd), removed: false,
    holder: u.holding_order_id ? d.orderCode[u.holding_order_id] ?? 'đơn khác' : null, status: u.status, costOverride: u.cost_vnd_override,
  }))
  return {
    url: lot.goofish_url ?? (lot.goofish_item_id ? `https://www.goofish.com/item?id=${lot.goofish_item_id}` : ''),
    title: lot.listing_title ?? '', sellerNick: s?.nickname ?? '', region: s?.region ?? '',
    groups: units.length ? [] : [newGroup()], units,
    rate: numStr(Number(lot.exchange_rate)), feePct: numStr(lotFeePct(lot)), shipFee: lot.ship_fee_vnd == null ? '' : String(lot.ship_fee_vnd),
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
          <span>{lot.status === 'received'
            ? 'Lô đã nhận: không thêm / bớt chiếc, không đổi giá ¥ / tỷ giá (A10, Q-014). Sửa phí ship và ghi chú ở trang lô; giá nhập ₫, giá bán dự kiến, số seri ở trang từng chiếc.'
            : 'Lô đã huỷ — không sửa được.'}</span>
        </div>
        <Link className="btn btn-ghost btn-block" to={`/lo/${lot.id}`}>Về chi tiết lô</Link>
      </Shell>
    )
  }
  return <LotForm key={lot?.id ?? 'new'} lot={lot} />
}

function LotForm({ lot }: { lot: LotRow | undefined }) {
  const d = useData()
  const { session } = useStore()
  const call = useRpcDetail()
  const toast = useToast()
  const nav = useNavigate()
  const [params] = useSearchParams()
  const [draft, setDraft] = useState<Draft>(() => initDraft(lot, d, params.get('model')))
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
  const activeModels = d.models.filter((m) => m.is_active)
  const sellers = d.sellers.filter((s) => !s.is_hidden)
  const kept = draft.units.filter((u) => !u.removed)
  const items = kept.length + draft.groups.length

  // ---- Sửa ô ----
  const clearErr = (...ids: string[]) => setErrs((e) => { const n = { ...e }; for (const k of ids) delete n[k]; delete n['f-groups']; return n })
  const clearMark = (k: MarkKey) => setMarks((m) => { const n = { ...m }; delete n[k]; return n })
  const set = <K extends keyof Draft>(k: K, v: Draft[K], mark?: MarkKey) => {
    setDraft((p) => ({ ...p, [k]: v }))
    if (mark) clearMark(mark)
    clearErr(`f-${k === 'orderedAt' ? 'date' : k === 'shipFee' ? 'ship' : k === 'sellerNick' ? 'seller' : k === 'feePct' ? 'fee' : k}`)
  }
  const setGroup = (i: number, patch: Partial<GroupDraft>) => {
    setDraft((p) => ({ ...p, groups: p.groups.map((g, j) => (j === i ? { ...g, ...patch } : g)) }))
    if (i === 0 && 'modelId' in patch) clearMark('model')
    if (i === 0 && 'cny' in patch) clearMark('cny')
    if (i === 0 && 'qty' in patch) clearMark('qty')
    clearErr(...Object.keys(patch).map((k) => lineId(`f-${k === 'modelId' ? 'model' : k}`, i)))
  }
  /** Đổi model ⇒ điền sẵn giá bán dự kiến = giá mặc định của model (nếu người dùng chưa tự gõ). */
  const pickModel = (i: number, modelId: string) => {
    const g = draftRef.current.groups[i]
    setGroup(i, g.listAuto || !g.list.trim() ? { modelId, list: defaultList(d, modelId), listAuto: true } : { modelId })
  }
  const addGroup = () => setDraft((p) => (p.units.filter((u) => !u.removed).length + p.groups.length >= MAX_GROUP_ITEMS ? p : { ...p, groups: [...p.groups, newGroup()] }))
  const removeGroup = (i: number) => setDraft((p) => ({ ...p, groups: p.groups.filter((_, j) => j !== i) }))
  const setUnit = (unitId: string, patch: Partial<UnitDraft>) => {
    setDraft((p) => ({ ...p, units: p.units.map((u) => (u.unitId === unitId ? { ...u, ...patch } : u)) }))
    const u = draftRef.current.units.find((x) => x.unitId === unitId)
    if (u) clearErr(`f-u-cny-${u.code}`, `f-u-list-${u.code}`)
  }

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

  // ---- AI quét (chỉ đoán model — không còn màu / biến thể) ----
  const applyScan = (r: ScanResponse) => {
    const th = Number(d.settings?.ai_confidence_threshold ?? 0.7)
    const flags = new Set(r.flags ?? [])
    const f = r.fields ?? {}
    const good = <T,>(k: string, x: { value: T | null; confidence: number } | undefined): x is { value: T; confidence: number } =>
      !!x && x.value != null && x.value !== '' && Number(x.confidence) >= th && !flags.has(k)

    // Model: chỉ chọn khi AI đủ chắc (≥ ngưỡng, không bị flag) và là model đang bán; không thì để trống + gợi ý theo tên gọi khác.
    const fm = f.model_id
    const aiModelId = good('model_id', fm) ? fm.value : null
    const aiModel = aiModelId ? activeModels.find((m) => m.id === aiModelId) ?? null : null
    const hint = aiModel ? null : matchModelByAlias(d.models, [f.model_id?.matched_text, f.listing_title?.value])

    const cur = draftRef.current
    const next: Draft = { ...cur, groups: cur.groups.map((g) => ({ ...g })) }
    const g0 = next.groups[0]
    const m: Marks = {}
    const fill = (key: MarkKey, empty: boolean, ok: boolean, apply: () => void) => {
      if (!empty) return // chỉ điền ô người dùng chưa gõ
      if (ok) { apply(); m[key] = 'ai' } else m[key] = 'low'
    }
    const sellerNick = r.seller_match?.nickname ?? (good('seller_nickname', f.seller_nickname) ? f.seller_nickname.value : null)
    fill('title', !cur.title.trim(), good('listing_title', f.listing_title), () => { next.title = String(f.listing_title!.value).slice(0, 300) })
    fill('seller', !cur.sellerNick.trim(), good('seller_nickname', f.seller_nickname) && !!sellerNick, () => { next.sellerNick = String(sellerNick).slice(0, 100) })
    fill('region', !cur.region.trim(), good('seller_region', f.seller_region), () => { next.region = String(f.seller_region!.value).slice(0, 100) })
    if (g0) {
      fill('cny', !g0.cny.trim(), good('price_cny', f.price_cny) && Number(f.price_cny!.value) > 0, () => { g0.cny = numStr(Number(f.price_cny!.value)) })
      // Số lượng: chỉ điền khi người dùng chưa gõ (ô còn mặc định 1 / trống); qty_guess null ⇒ không đánh dấu.
      const qg = r.qty_guess
      const qOk = !!qg && Number.isInteger(Number(qg.value)) && Number(qg.value) >= 2 && Number(qg.value) <= 50 && Number(qg.confidence) >= th
      if (qOk && (!g0.qty.trim() || g0.qty.trim() === '1')) { g0.qty = String(Number(qg!.value)); m.qty = 'ai' }
      fill('model', !g0.modelId, aiModel != null, () => {
        g0.modelId = aiModel!.id
        if (g0.listAuto || !g0.list.trim()) { g0.list = defaultList(d, aiModel!.id); g0.listAuto = true }
      })
    }

    setDraft(next)
    setMarks((p) => ({ ...p, ...m }))
    setAi({ notes: r.notes ?? null, condition: r.condition_text ?? null, usage: r.usage ?? null, modelHint: m.model === 'low' ? hint : null })
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
      toast(errText(e))
    } finally { setScanning(false) }
  }

  // ---- Xem trước (domain): mã sẽ tạo, giá nhập ₫ tự tính / chiếc, tiền hàng, phí mua hộ, phải trả ----
  const rate = parseNum(draft.rate), ship = parseNum(draft.shipFee)
  // Phí mua hộ % (CR-003): trống = 0; "2,5" / "2.5" = 2,5%; ngoài 0..100 hoặc > 2 chữ số thập phân ⇒ lỗi (null)
  const feeIn = draft.feePct.trim() ? parseNum(draft.feePct) : 0
  const feeVal = feeIn != null && isBuyingFeePct(feeIn) ? feeIn : null
  const calcOk = rate != null && rate > 0 && feeVal != null   // tỷ giá + phí mua hộ hợp lệ ⇒ xem trước được
  const shipVal = draft.shipFee.trim() && ship != null && Number.isInteger(ship) && ship >= 0 ? ship : null
  const seq = new Map<string, number>()
  const groupCodes: string[][] = draft.groups.map((g) => {
    const model = d.models.find((m) => m.id === g.modelId)
    const q = parseNum(g.qty)
    if (!model || q == null || !Number.isInteger(q) || q < 1 || q > MAX_LOT_UNITS) return []
    let n = seq.get(model.id) ?? Math.max(1, model.next_seq)
    const out: string[] = []
    for (let k = 0; k < q; k++) out.push(formatUnitCode(model.code_prefix.toUpperCase(), n++))
    seq.set(model.id, n)
    return out
  })
  const lotId = lot?.id ?? 'draft'
  const pUnits: Unit[] = []
  let previewOk = calcOk
  for (const u of kept) {
    const c = parseNum(u.cny)
    if (cnyError(u.cny)) { previewOk = false; continue }
    pUnits.push({ id: u.unitId, code: u.code, modelId: u.modelId, lotId, priceCny: c!, costOverride: u.costOverride, listPrice: listVal(u.list) })
  }
  draft.groups.forEach((g, i) => {
    const c = parseNum(g.cny)
    if (cnyError(g.cny) || !groupCodes[i].length) { previewOk = false; return }
    for (const cd of groupCodes[i]) pUnits.push({ id: cd, code: cd, modelId: g.modelId, lotId, priceCny: c!, costOverride: null, listPrice: listVal(g.list) })
  })
  const N = pUnits.length
  const pLot = { id: lotId, rate: rate ?? 0, shipFee: shipVal, status: 'ordered' as const, buyingFeePct: feeVal ?? 0 }
  const autoCost = (priceCny: number) => (calcOk && N > 0
    ? (shipVal != null ? autoUnitCost({ priceCny }, pLot, N) : unitCostBeforeShip({ priceCny }, pLot))
    : null)
  const costText = (priceCny: number | null) => {
    const c = priceCny != null ? autoCost(priceCny) : null
    return c == null ? '—' : shipVal != null ? vnd(c) : <>{vnd(c)} <span className="muted small">+ ship</span></>
  }

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
    for (const u of kept) {
      const ce = cnyError(u.cny), le = listError(u.list)
      if (ce) e[`f-u-cny-${u.code}`] = ce
      if (le) e[`f-u-list-${u.code}`] = le
    }
    draft.groups.forEach((g, i) => {
      const q = parseNum(g.qty), ce = cnyError(g.cny), le = listError(g.list)
      if (!g.modelId) e[lineId('f-model', i)] = 'Chọn model.'
      if (q == null || !Number.isInteger(q) || q < 1 || q > MAX_LOT_UNITS) e[lineId('f-qty', i)] = 'Số lượng là số nguyên từ 1 đến 1.000.'
      if (ce) e[lineId('f-cny', i)] = ce
      if (le) e[lineId('f-list', i)] = le
    })
    if (items === 0) e['f-groups'] = 'Lô cần ít nhất 1 chiếc — bấm "Thêm nhóm chiếc".'
    else if (items > MAX_GROUP_ITEMS) e['f-groups'] = `Tối đa ${MAX_GROUP_ITEMS} dòng mỗi lần lưu (mỗi chiếc cũ + mỗi nhóm mới là 1 dòng) — bớt nhóm hoặc gộp nhóm cùng model, cùng giá.`
    else if (kept.length + draft.groups.reduce((a, g) => a + (parseNum(g.qty) ?? 0), 0) > MAX_LOT_UNITS) e['f-groups'] = 'Một lô tối đa 1.000 chiếc.'
    if (rate == null || rate <= 0 || rate >= 1e8) e['f-rate'] = 'Nhập tỷ giá ₫/¥ (lớn hơn 0).'
    if (feeVal == null) e['f-fee'] = 'Phí mua hộ là số % từ 0 đến 100 (vd. 3 hoặc 2,5), tối đa 2 chữ số thập phân.'
    if (draft.shipFee.trim() && shipVal == null) e['f-ship'] = 'Phí ship là số đồng nguyên ≥ 0, hoặc để trống.'
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
      document.getElementById(first === 'f-groups' ? 'f-add-group' : first)?.focus()
      return
    }
    setSaving(true)
    try {
      let shot: string | null
      try { shot = await ensureUploaded() } catch (err) {
        toast(errText(err) + ' Hoặc bấm "Bỏ ảnh" để lưu không kèm ảnh.')
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
        exchange_rate: round2(rate!),
        buying_fee_pct: round2(feeVal ?? 0),
        ship_fee_vnd: shipVal,
        status: lot?.status ?? 'ordered',
        note: draft.note.trim() || null,
      }
      if (!existing && nick) p_lot.new_seller = { nickname: nick, region: region || null, profile_url: null }
      // Chiếc cũ giữ lại {unit_id, price_cny, list_price_vnd}; nhóm mới {model_id, qty, price_cny, list_price_vnd} (null = không có giá bán)
      const p_groups = [
        ...kept.map((u) => ({ unit_id: u.unitId, price_cny: round2(parseNum(u.cny)!), list_price_vnd: listVal(u.list) })),
        ...draft.groups.map((g) => ({ model_id: g.modelId, qty: parseNum(g.qty), price_cny: round2(parseNum(g.cny)!), list_price_vnd: listVal(g.list) })),
      ]
      const r = await call<SaveResult>('save_lot', { p_lot_id: lot?.id ?? null, p_lot, p_groups, p_expected_version: lot ? version : null })
      // Người bán cũ chưa có khu vực ⇒ ghi bổ sung (bảng sellers được ghi trực tiếp).
      if (existing && !existing.region && region) await supabase.from('sellers').update({ region }).eq('id', existing.id)
      const made = (r.created_units ?? []).map((u) => u.code)
      const gone = (r.removed_units ?? []).map((u) => u.code)
      toast(`Đã lưu ${code}${made.length ? ` · tạo ${codesText(made, 3)}` : ''}${gone.length ? ` · bỏ ${codesText(gone, 3)}` : ''}`)
      nav(`/lo/${r.lot_id}`, { replace: true })
    } catch (err) {
      if (err instanceof RpcError && err.code === 'UNIT_RESERVED' && err.detail && typeof err.detail === 'object') {
        const det = err.detail as { code?: string; order_id?: string }
        toast(`${det.code ?? 'Chiếc này'} đang giữ cho ${det.order_id ? d.orderCode[det.order_id] ?? 'một đơn' : 'một đơn'} — không bỏ khỏi lô được. Sửa / huỷ đơn đó trước.`)
      } else toast(errText(err))
      setSaving(false)
    }
  }

  // ---- Giao diện ----
  const flag = (k: MarkKey) => marks[k]
    ? <span className={`ai-flag ${marks[k] === 'low' ? 'low' : ''}`}><Icon name="spark" size={12} />{marks[k] === 'low' ? 'AI không chắc — kiểm tra' : 'AI điền'}</span>
    : null
  const cls = (k: MarkKey, extra = '') => `input ${extra} ${marks[k] ? 'ai' : ''}`.trim()
  const err = (fid: string): ReactNode => (errs[fid] ? <span className="err-text" role="alert">{errs[fid]}</span> : null)
  const modelOptions = (cur: string) => {
    const list = activeModels.some((m) => m.id === cur) || !cur ? activeModels : [...activeModels, ...d.models.filter((m) => m.id === cur)]
    return list.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.code_prefix}){m.is_active ? '' : ' (đã ẩn)'}</option>)
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
          {marks.qty === 'ai' && <span className="small">AI đoán tin có nhiều chiếc — kiểm tra giá ¥ là giá MỖI chiếc (không phải tổng).</span>}
          {ai.condition && <span>Tình trạng trong tin: {ai.condition}</span>}
          {ai.usage && <span className="small">Đã dùng {ai.usage.scans_this_month}/{ai.usage.cap} lượt quét tháng này.</span>}
        </div>
      )}
    </div>
  )

  const unitsBlock = draft.units.length > 0 && (
    <div className="full stack">
      <p className="section-title">Chiếc đã có trong lô ({kept.length}/{draft.units.length})</p>
      <div className="card card-pad stack">
        {draft.units.map((u) => (
          <div className={`lot-unit ${u.removed ? 'removed' : ''}`} key={u.unitId}>
            <div className="uhead">
              <span><b className="lot-codes">{u.code}</b> <span className="muted small">{u.modelName}</span> {u.holder && <UnitChip s={u.status} holder={u.holder} />}</span>
              {u.removed
                ? <button type="button" className="link-btn" onClick={() => setUnit(u.unitId, { removed: false })}>Giữ lại</button>
                : u.holder
                  ? <span className="hint">Đang giữ cho {u.holder} — không bỏ được</span>
                  : <button type="button" className="link-btn" onClick={() => setUnit(u.unitId, { removed: true })}>Bỏ chiếc</button>}
            </div>
            {!u.removed && (
              <>
                <label className="f">Giá ¥
                  <input className="input money" id={`f-u-cny-${u.code}`} inputMode="decimal" value={u.cny} onChange={(e) => setUnit(u.unitId, { cny: e.target.value })} />
                  <span className="hint">{u.costOverride != null ? <>Giá nhập ₫ sửa tay {vnd(u.costOverride)}</> : <>Giá nhập ₫ ≈ {costText(parseNum(u.cny))}</>}</span>
                  {err(`f-u-cny-${u.code}`)}
                </label>
                <label className="f">Giá bán dự kiến (₫)
                  <input className="input money" id={`f-u-list-${u.code}`} inputMode="numeric" value={u.list} placeholder="để trống" onChange={(e) => setUnit(u.unitId, { list: e.target.value })} />
                  {err(`f-u-list-${u.code}`)}
                </label>
              </>
            )}
            {u.removed && <span className="hint" style={{ gridColumn: '1 / -1' }}>Sẽ bỏ khỏi lô khi lưu — mã {u.code} không cấp lại.</span>}
          </div>
        ))}
      </div>
    </div>
  )

  const groupsBlock = (
    <div className="full stack">
      {editing && <p className="section-title">Thêm chiếc mới</p>}
      {draft.groups.map((g, i) => {
        const codes = groupCodes[i]
        const c = parseNum(g.cny)
        return (
          <div className="lot-line" key={g.key}>
            <label className="f">
              <span className="lrow">
                <span>Model <span className="req">*</span>{draft.groups.length > 1 ? ` (nhóm ${i + 1})` : ''} {i === 0 && flag('model')}</span>
                {(i > 0 || editing) && <button type="button" className="link-btn" onClick={() => removeGroup(i)}>Bỏ nhóm</button>}
              </span>
              <select className={i === 0 ? cls('model') : 'input'} id={lineId('f-model', i)} value={g.modelId} onChange={(e) => pickModel(i, e.target.value)}>
                <option value="">Chọn…</option>
                {modelOptions(g.modelId)}
              </select>
              {i === 0 && ai?.modelHint && !g.modelId && (
                <span className="hint">Tin có nhắc {ai.modelHint.name} — <button type="button" className="link-btn small" onClick={() => pickModel(0, ai.modelHint!.id)}>Chọn {ai.modelHint.name}</button></span>
              )}
              {!activeModels.length && <span className="hint">Chưa có model đang bán — thêm ở <Link className="link-btn small" to="/danhmuc">Model</Link>.</span>}
              {err(lineId('f-model', i))}
            </label>
            <div className="two">
              <label className="f"><span className="lrow">Số lượng <span className="req">*</span> {i === 0 && flag('qty')}</span>
                <input className={i === 0 ? cls('qty', 'money') : 'input money'} id={lineId('f-qty', i)} inputMode="numeric" value={g.qty} onChange={(e) => setGroup(i, { qty: e.target.value })} />
                {err(lineId('f-qty', i))}
              </label>
              <label className="f"><span className="lrow">Giá ¥ / chiếc <span className="req">*</span> {i === 0 && flag('cny')}</span>
                <input className={i === 0 ? cls('cny', 'money') : 'input money'} id={lineId('f-cny', i)} inputMode="decimal" value={g.cny}
                  onChange={(e) => setGroup(i, { cny: e.target.value })} />
                {err(lineId('f-cny', i))}
              </label>
            </div>
            <label className="f">Giá bán dự kiến / chiếc (₫)
              <input className="input money" id={lineId('f-list', i)} inputMode="numeric" value={g.list} placeholder="để trống"
                onChange={(e) => setGroup(i, { list: e.target.value, listAuto: false })} />
              <span className="hint">{g.modelId && g.listAuto && g.list ? 'Giá mặc định của model — sửa được' : 'Sửa riêng từng chiếc được sau khi lưu'}</span>
              {err(lineId('f-list', i))}
            </label>
            {codes.length > 0 && (
              <p className="hint">Sẽ tạo <span className="lot-codes">{rangeText(codes)}</span>{codes.length > 3 ? ` (${codes.length} chiếc)` : ''}
                {c != null && c > 0 && calcOk ? <> · giá nhập ₫ ≈ {costText(c)} / chiếc</> : null}</p>
            )}
          </div>
        )
      })}
      {err('f-groups')}
      {items < MAX_GROUP_ITEMS && (
        <button type="button" className="link-btn" id="f-add-group" style={{ alignSelf: 'flex-start' }} onClick={addGroup}>
          <Icon name="plus" size={14} /> Thêm nhóm chiếc (model / giá khác)
        </button>
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

        {unitsBlock}
        {groupsBlock}

        <div className="two">
          <label className="f">Tỷ giá ₫/¥ <span className="req">*</span>
            <input className="input money" id="f-rate" inputMode="decimal" value={draft.rate} onChange={(e) => set('rate', e.target.value)} />
            <span className="hint">{d.suggestions.last_exchange_rate != null ? 'Gợi ý: tỷ giá lô gần nhất' : 'Chưa có lô trước để gợi ý'}</span>
            {err('f-rate')}
          </label>
          <label className="f">Phí mua hộ %
            <input className="input money" id="f-fee" inputMode="decimal" value={draft.feePct} placeholder="0" onChange={(e) => set('feePct', e.target.value)} />
            <span className="hint">{editing ? 'Khoá khi lô đã nhận' : `Mặc định trong Cài đặt: ${pct(Number(d.settings?.default_buying_fee_pct ?? 0))}`} · tính trên tiền hàng</span>
            {err('f-fee')}
          </label>
        </div>
        <label className="f">Phí ship về VN (cả lô)
          <input className="input money" id="f-ship" inputMode="numeric" value={draft.shipFee} placeholder="để trống" onChange={(e) => set('shipFee', e.target.value)} />
          <span className="hint">Thường biết khi hàng về{shipPer != null ? ` · lô trước ~${tr(shipPer)}/chiếc` : ''}</span>
          {err('f-ship')}
        </label>
        <label className="f">Ngày đặt
          <input className="input" id="f-date" type="date" value={draft.orderedAt} onChange={(e) => set('orderedAt', e.target.value)} />
          {err('f-date')}
        </label>
        <label className="f">Ghi chú
          <input className="input" id="f-note" value={draft.note} maxLength={2000} onChange={(e) => set('note', e.target.value)} />
          {err('f-note')}
        </label>

        <div className="calc full">
          <div className="ln"><span>Số chiếc</span><span>{N || '—'}</span></div>
          <div className="ln"><span>Tiền hàng</span><span>{previewOk && N ? vnd(lotGoodsVnd(pLot, pUnits)) : '—'}</span></div>
          <div className="ln"><span>Phí mua hộ ({feeVal != null ? pct(feeVal) : '—'})</span><span>{previewOk && N ? vnd(lotBuyingFeeVnd(pLot, pUnits)) : '—'}</span></div>
          <div className="ln"><span>Phí ship về VN</span><span>{shipVal != null ? vnd(shipVal) : 'chưa nhập'}</span></div>
          <div className="ln"><span>Ship / chiếc</span><span>{shipVal != null && N ? vnd(Math.round(shipVal / N)) : '—'}</span></div>
          {draft.groups.map((g, i) => (
            <div className="ln" key={g.key}>
              <span>Giá nhập ₫ / chiếc · {groupCodes[i].length ? rangeText(groupCodes[i], 2) : `nhóm ${i + 1}`}</span>
              <span>{previewOk ? costText(parseNum(g.cny)) : '—'}</span>
            </div>
          ))}
          <div className="ln total"><span>Phải trả trung gian</span><span>{previewOk && N ? vnd(lotPayable(pLot, pUnits)) : '—'}</span></div>
          <div className="formula">Giá nhập ₫ = giá ¥ × tỷ giá × (1 + phí {feeVal != null ? pct(feeVal) : '%'}) + ship ÷ {N || 'số'} chiếc · mã chiếc do app cấp khi lưu</div>
        </div>
      </div>
    </Shell>
  )
}
