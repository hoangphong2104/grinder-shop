// SC_06 Nhập cối (/lo/new) - CR-006: 1 lô = 1 cối (không còn nhập nhiều chiếc / nhiều nhóm trong 1 lô; lô cũ nhiều chiếc vẫn sửa được)
// Trước đây: Nhập lô Goofish (/lo/new) + sửa lô chưa nhận (/lo/:id/sua). v0.2 (CR-001 A2): lô = các NHÓM CHIẾC
// (model, số lượng N, giá ¥ / chiếc, giá bán dự kiến / chiếc) → DB tạo N chiếc, mỗi chiếc 1 mã (D1). Sửa lô chưa
// nhận: sửa / bỏ từng chiếc cũ (không bỏ được chiếc đang giữ cho đơn - UNIT_RESERVED) và thêm nhóm mới.
// Khối AI quét ở đầu form (BR-13: chỉ điền sẵn, không tự lưu). Xem trước bằng src/domain; số chính thức do DB tính.
// v0.3 (CR-003): ô "Phí mua hộ %" cạnh tỷ giá - lô mới điền sẵn mặc định trong Cài đặt; tính vào giá nhập ₫ / chiếc
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
import { parseNum, pct, todayVn, vnd } from '../ui/format.ts'
import { autoUnitCost, formatUnitCode, isBuyingFeePct, lotBuyingFeeVnd, lotGoodsVnd, lotPayable, type Unit } from '../domain/index.ts'
import { codesText, lotFeePct, rangeText, unitsOfLot } from './lots/common.tsx'
import { MAX_GROUP_ITEMS } from './lots/LotFlow.tsx'
import { errText, RpcError, useRpcDetail } from './lots/rpc.ts'
import { invokeScan, matchModelByAlias, MAX_TEXT, uploadScreenshot, type ScanResponse } from './lots/scan.ts'
import '../styles/lots.css'
import { MoneyInput } from '../ui/MoneyInput.tsx'
import { lotHref, lotName } from './overview/common.tsx'

/** Nhóm chiếc mới: listAuto = giá bán đang là giá mặc định của model (đổi model ⇒ đổi theo). */
interface GroupDraft { key: number; modelId: string; qty: string; cny: string; list: string; listAuto: boolean }
/** Chiếc đã có của lô đang sửa. */
interface UnitDraft {
  unitId: string; code: string; modelId: string; modelName: string; cny: string; list: string; removed: boolean
  holder: string | null; status: Parameters<typeof UnitChip>[0]['s']; costOverride: number | null
}
interface Draft {
  url: string; title: string; sellerNick: string; region: string; groups: GroupDraft[]; units: UnitDraft[]
  rate: string; feePct: string; /** CR-009 ship Kho VN → Lumi (shop trả ngay) */ localShip: string; orderedAt: string; note: string
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
/** Giá ¥ hợp lệ: > 0, ≤ 100.000, tối đa 2 chữ số thập phân - trả thông báo lỗi hoặc null. */
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

/** modelId (tuỳ chọn, từ /lo/new?model=…): chỉ nhận model đang bán - điền sẵn model + giá bán mặc định nhóm đầu. */
function initDraft(lot: LotRow | undefined, d: DbData, modelId?: string | null): Draft {
  if (!lot) {
    const g = newGroup()
    if (modelId && d.models.some((m) => m.id === modelId && m.is_active)) { g.modelId = modelId; g.list = defaultList(d, modelId) }
    return {
      url: '', title: '', sellerNick: '', region: '', groups: [g], units: [],
      rate: numStr(d.suggestions.last_exchange_rate), feePct: numStr(Number(d.settings?.default_buying_fee_pct ?? 0)),
      localShip: '', orderedAt: todayVn(), note: '',
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
    rate: numStr(Number(lot.exchange_rate)), feePct: numStr(lotFeePct(lot)), localShip: numStr(lot.local_ship_vnd),
    orderedAt: lot.ordered_at, note: lot.note ?? '',
  }
}

export default function LotNew() {
  const { id } = useParams()
  const d = useData()
  const lot = id ? d.lots.find((x) => x.id === id) : undefined
  if (id && !lot) {
    return (
      <Shell section="kho" title="Sửa thông tin mua" back="/kho?tt=tq">
        <div className="empty">Không tìm thấy cối. <Link className="link-btn" to="/kho">Về Kho</Link></div>
      </Shell>
    )
  }
  if (lot && (lot.status === 'received' || lot.status === 'cancelled')) {
    return (
      <Shell section="kho" title={`Sửa ${lotName(d, lot.id)}`} back={lotHref(d, lot.id)}>
        <div className="note-box">
          <span>{lot.status === 'received'
            ? 'Cối đã về Kho Lumi: không thêm / bớt chiếc, không đổi giá ¥ / tỷ giá (A10, Q-014). Sửa ship VN → Lumi ở trang cối; giá nhập ₫, giá bán dự kiến, số seri ở trang từng chiếc.'
            : 'Lô đã huỷ - không sửa được.'}</span>
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
  const [version] = useState(lot?.version ?? null) // version lúc mở form - bắt sửa đồng thời
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
  // CR-005 ý 1: tạo lô ⇒ mặc định đã trả trung gian ngay (save_lot p_lot.paid_now)
  const [paidNow, setPaidNow] = useState(true)
  const draftRef = useRef(draft)
  draftRef.current = draft
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview) }, [preview])

  const editing = !!lot
  const code = lot ? lotName(d, lot.id) : 'cối mới'
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
    clearErr(`f-${k === 'orderedAt' ? 'date' : k === 'localShip' ? 'ship' : k === 'sellerNick' ? 'seller' : k === 'feePct' ? 'fee' : k}`)
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

  // ---- AI quét (chỉ đoán model - không còn màu / biến thể) ----
  const applyScan = (r: ScanResponse) => {
    const th = Number(d.settings?.ai_confidence_threshold ?? 0.7)
    const flags = new Set(r.flags ?? [])
    const f = r.fields ?? {}
    // CR-008: AI chưa chắc (dưới ngưỡng / bị flag) vẫn điền sẵn, đánh dấu "AI không chắc - kiểm tra" thay vì để trống.
    const has = <T,>(x: { value: T | null; confidence: number } | undefined): x is { value: T; confidence: number } =>
      !!x && x.value != null && x.value !== ''
    const sure = (k: string, x: { confidence: number } | undefined) => !!x && Number(x.confidence) >= th && !flags.has(k)

    // Model: model AI chọn (đang bán); không có thì đoán theo tên gọi khác trong tiêu đề (đánh dấu chưa chắc).
    const fm = f.model_id
    const aiPick = has(fm) ? activeModels.find((x) => x.id === fm.value) ?? null : null
    const hint = aiPick ? null : matchModelByAlias(d.models, [f.model_id?.matched_text, f.listing_title?.value])
    const hintActive = hint ? activeModels.find((x) => x.id === hint.id) ?? null : null
    const aiModel = aiPick ?? hintActive
    const modelSure = !!aiPick && sure('model_id', fm)

    const cur = draftRef.current
    const next: Draft = { ...cur, groups: cur.groups.map((g) => ({ ...g })) }
    const g0 = next.groups[0]
    const m: Marks = {}
    const fill = (key: MarkKey, empty: boolean, present: boolean, ok: boolean, apply: () => void) => {
      if (!empty) return // chỉ điền ô người dùng chưa gõ
      if (present) apply()
      m[key] = present && ok ? 'ai' : 'low'
    }
    const sellerNick = r.seller_match?.nickname ?? (has(f.seller_nickname) ? f.seller_nickname.value : null)
    fill('title', !cur.title.trim(), has(f.listing_title), sure('listing_title', f.listing_title), () => { next.title = String(f.listing_title!.value).slice(0, 300) })
    fill('seller', !cur.sellerNick.trim(), !!sellerNick, !!r.seller_match || sure('seller_nickname', f.seller_nickname), () => { next.sellerNick = String(sellerNick).slice(0, 100) })
    fill('region', !cur.region.trim(), has(f.seller_region), sure('seller_region', f.seller_region), () => { next.region = String(f.seller_region!.value).slice(0, 100) })
    if (g0) {
      fill('cny', !g0.cny.trim(), has(f.price_cny) && Number(f.price_cny.value) > 0, sure('price_cny', f.price_cny), () => { g0.cny = numStr(Number(f.price_cny!.value)) })
      // CR-006: 1 lô = 1 cối ⇒ không dùng số lượng AI đoán (qty_guess)
      fill('model', !g0.modelId, aiModel != null, modelSure, () => {
        g0.modelId = aiModel!.id
        if (g0.listAuto || !g0.list.trim()) { g0.list = defaultList(d, aiModel!.id); g0.listAuto = true }
      })
    }

    setDraft(next)
    setMarks((p) => ({ ...p, ...m }))
    setAi({ notes: r.notes ?? null, condition: r.condition_text ?? null, usage: r.usage ?? null, modelHint: m.model === 'low' && !aiModel ? hint : null })
  }

  const scan = async () => {
    if (mode === 'img' && !file && !keptShot) return toast('Chọn ảnh chụp tin trước')
    if (mode === 'text' && !text.trim()) return toast('Dán chữ từ trang tin trước')
    if (mode === 'text' && text.length > MAX_TEXT) return toast('Chữ dán tối đa 20.000 ký tự - bớt phần thừa')
    setScanning(true)
    const t0 = performance.now()
    try {
      const input = mode === 'img'
        ? { kind: 'image' as const, image_path: (await ensureUploaded())! }
        : { kind: 'text' as const, text: text.trim() }
      const r = await invokeScan(input, draftRef.current.url.trim() || null)
      applyScan(r)
      toast(`AI đã điền sau ${Math.max(1, Math.round((performance.now() - t0) / 1000))} giây - kiểm tra ô đánh dấu`)
    } catch (e) {
      toast(errText(e))
    } finally { setScanning(false) }
  }

  // ---- Xem trước (domain): mã sẽ tạo, giá nhập ₫ tự tính / chiếc, tiền hàng, phí mua hộ, phải trả ----
  const rate = parseNum(draft.rate), ship = parseNum(draft.localShip)
  // Phí mua hộ % (CR-003): trống = 0; "2,5" / "2.5" = 2,5%; ngoài 0..100 hoặc > 2 chữ số thập phân ⇒ lỗi (null)
  const feeIn = draft.feePct.trim() ? parseNum(draft.feePct) : 0
  const feeVal = feeIn != null && isBuyingFeePct(feeIn) ? feeIn : null
  const calcOk = rate != null && rate > 0 && feeVal != null   // tỷ giá + phí mua hộ hợp lệ ⇒ xem trước được
  const shipVal = draft.localShip.trim() && ship != null && Number.isInteger(ship) && ship >= 0 ? ship : null
  // Ship TQ → VN: tất toán gộp sau (Sổ quỹ) - lô đang sửa giữ phần đã chia; cối mới chưa có ⇒ giá nhập tạm tính
  const cnShip = lot?.ship_fee_vnd ?? null
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
  const pLot = { id: lotId, rate: rate ?? 0, shipFee: cnShip, localShip: shipVal, status: 'cn_warehouse' as const, buyingFeePct: feeVal ?? 0 }
  const autoCost = (priceCny: number) => (calcOk && N > 0
    ? autoUnitCost({ priceCny }, pLot, N)
    : null)
  const costText = (priceCny: number | null) => {
    const c = priceCny != null ? autoCost(priceCny) : null
    return c == null ? '-' : cnShip != null ? vnd(c) : <>{vnd(c)} <span className="muted small">+ ship TQ→VN</span></>
  }

  // ---- Gợi ý / cảnh báo ----
  const iid = itemIdOf(draft.url)
  const dup = iid ? d.lots.find((l) => l.goofish_item_id === iid && l.status !== 'cancelled' && l.id !== lot?.id) : undefined
  const sMatch = findSeller(d.sellers, draft.sellerNick)

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
    if (items === 0) e['f-groups'] = 'Lô cần ít nhất 1 chiếc - bấm "Thêm nhóm chiếc".'
    else if (items > MAX_GROUP_ITEMS) e['f-groups'] = `Tối đa ${MAX_GROUP_ITEMS} dòng mỗi lần lưu (mỗi chiếc cũ + mỗi nhóm mới là 1 dòng) - bớt nhóm hoặc gộp nhóm cùng model, cùng giá.`
    else if (kept.length + draft.groups.reduce((a, g) => a + (parseNum(g.qty) ?? 0), 0) > MAX_LOT_UNITS) e['f-groups'] = 'Tối đa 1.000 chiếc mỗi lần nhập.'
    if (rate == null || rate <= 0 || rate >= 1e8) e['f-rate'] = 'Nhập tỷ giá ₫/¥ (lớn hơn 0).'
    if (feeVal == null) e['f-fee'] = 'Phí mua hộ là số % từ 0 đến 100 (vd. 3 hoặc 2,5), tối đa 2 chữ số thập phân.'
    if (draft.localShip.trim() && shipVal == null) e['f-ship'] = 'Phí ship là số đồng nguyên ≥ 0, hoặc để trống.'
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
        local_ship_vnd: shipVal,   // CR-009; ship TQ→VN không gửi ⇒ DB giữ nguyên
        ...(lot ? {} : { status: 'cn_warehouse', paid_now: paidNow }),
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
      toast(`Đã lưu ${code}${made.length ? `, tạo ${codesText(made, 3)}` : ''}${gone.length ? `, bỏ ${codesText(gone, 3)}` : ''}`)
      // CR-006: mở luôn trang cối (lô 1 chiếc ⇒ /lo/:id cũng tự chuyển sang trang cối)
      const one = r.created_units?.length === 1 && !kept.length ? r.created_units[0].unit_id : null
      nav(one ? `/kho/${one}` : `/lo/${r.lot_id}`, { replace: true })
    } catch (err) {
      if (err instanceof RpcError && err.code === 'UNIT_RESERVED' && err.detail && typeof err.detail === 'object') {
        const det = err.detail as { code?: string; order_id?: string }
        toast(`${det.code ?? 'Chiếc này'} đang giữ cho ${det.order_id ? d.orderCode[det.order_id] ?? 'một đơn' : 'một đơn'} - không bỏ được. Sửa / huỷ đơn đó trước.`)
      } else toast(errText(err))
      setSaving(false)
    }
  }

  // ---- Giao diện ----
  const flag = (k: MarkKey) => marks[k]
    ? <span className={`ai-flag ${marks[k] === 'low' ? 'low' : ''}`}><Icon name="spark" size={12} />{marks[k] === 'low' ? 'AI không chắc - kiểm tra' : 'AI điền'}</span>
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
            <span>{file ? 'Đã chọn 1 ảnh, chạm để đổi' : keptShot ? 'Lô đã có ảnh chụp, chạm để đổi' : 'Chụp / chọn ảnh tin trong app 闲鱼 (thấy giá + tên người bán)'}</span>
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
          ? 'Goofish chặn đọc thẳng từ link - AI đọc ảnh hoặc chữ bạn đưa. Không quét vẫn nhập tay được.'
          : <>AI quét đang tắt trong <Link className="link-btn small" to="/caidat">Cài đặt</Link> - nhập tay bên dưới.</>}
      </p>
      {ai && (ai.notes || ai.condition || ai.usage) && (
        <div className="note-box way" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
          {ai.notes && <span>AI ghi chú: {ai.notes}</span>}
          {marks.qty === 'ai' && <span className="small">AI đoán tin có nhiều chiếc - kiểm tra giá ¥ là giá MỖI chiếc (không phải tổng).</span>}
          {ai.condition && <span>Tình trạng trong tin: {ai.condition}</span>}
          {ai.usage && <span className="small">Đã dùng {ai.usage.scans_this_month}/{ai.usage.cap} lượt quét tháng này.</span>}
        </div>
      )}
    </div>
  )

  const unitsBlock = draft.units.length > 0 && (
    <div className="full stack">
      <p className="section-title">Chiếc đã có ({kept.length}/{draft.units.length})</p>
      <div className="card card-pad stack">
        {draft.units.map((u) => (
          <div className={`lot-unit ${u.removed ? 'removed' : ''}`} key={u.unitId}>
            <div className="uhead">
              <span><b className="lot-codes">{u.code}</b> <span className="muted small">{u.modelName}</span> {u.holder && <UnitChip s={u.status} holder={u.holder} />}</span>
              {u.removed
                ? <button type="button" className="link-btn" onClick={() => setUnit(u.unitId, { removed: false })}>Giữ lại</button>
                : u.holder
                  ? <span className="hint">Đang giữ cho {u.holder} - không bỏ được</span>
                  : <button type="button" className="link-btn" onClick={() => setUnit(u.unitId, { removed: true })}>Bỏ chiếc</button>}
            </div>
            {!u.removed && (
              <>
                <label className="f"><span className="flab">Giá ¥</span>
                  <MoneyInput className="input money" id={`f-u-cny-${u.code}`} decimals={2} value={u.cny} onValue={(v) => setUnit(u.unitId, { cny: v })} />
                  <span className="hint">{u.costOverride != null ? <>Giá nhập ₫ sửa tay {vnd(u.costOverride)}</> : <>Giá nhập ₫ ≈ {costText(parseNum(u.cny))}</>}</span>
                  {err(`f-u-cny-${u.code}`)}
                </label>
                <label className="f"><span className="flab">Bán dự kiến ₫</span>
                  <MoneyInput className="input money" id={`f-u-list-${u.code}`} value={u.list} placeholder="để trống" onValue={(v) => setUnit(u.unitId, { list: v })} />
                  {err(`f-u-list-${u.code}`)}
                </label>
              </>
            )}
            {u.removed && <span className="hint" style={{ gridColumn: '1 / -1' }}>Sẽ bỏ khi lưu - mã {u.code} không cấp lại.</span>}
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
                <span className="hint">Tin có nhắc {ai.modelHint.name} - <button type="button" className="link-btn small" onClick={() => pickModel(0, ai.modelHint!.id)}>Chọn {ai.modelHint.name}</button></span>
              )}
              {!activeModels.length && <span className="hint">Chưa có model đang bán - thêm ở <Link className="link-btn small" to="/danhmuc">Model</Link>.</span>}
              {err(lineId('f-model', i))}
            </label>
            <div className="two">
              <label className="f"><span className="lrow">Giá web ¥ <span className="req">*</span> {i === 0 && flag('cny')}</span>
                <MoneyInput className={i === 0 ? cls('cny', 'money') : 'input money'} id={lineId('f-cny', i)} decimals={2} value={g.cny}
                  onValue={(v) => setGroup(i, { cny: v })} />
                {err(lineId('f-cny', i))}
              </label>
              <label className="f"><span className="flab">Giá bán dự kiến (₫)</span>
                <MoneyInput className="input money" id={lineId('f-list', i)} value={g.list} placeholder="để trống"
                  onValue={(v) => setGroup(i, { list: v, listAuto: false })} />
                <span className="hint">{g.modelId && g.listAuto && g.list ? 'Giá mặc định của model' : 'Sửa được sau'}</span>
                {err(lineId('f-list', i))}
              </label>
            </div>
            {codes.length > 0 && (
              <p className="hint">Sẽ tạo <span className="lot-codes">{rangeText(codes)}</span>{codes.length > 3 ? ` (${codes.length} chiếc)` : ''}
                {c != null && c > 0 && calcOk ? <>, giá nhập ₫ ≈ {costText(c)} / chiếc</> : null}</p>
            )}
          </div>
        )
      })}
      {err('f-groups')}
      {items === 0 && (
        <button type="button" className="link-btn" id="f-add-group" style={{ alignSelf: 'flex-start' }} onClick={addGroup}>
          <Icon name="plus" size={14} /> Thêm cối
        </button>
      )}
    </div>
  )

  return (
    <Shell section="kho" title={editing ? `Sửa ${code}` : 'Nhập cối'} back={editing ? lotHref(d, lot!.id) : '/kho'}
      savebar={<button className="btn btn-primary btn-block" disabled={saving || scanning} onClick={save}>{saving ? <><span className="spin" /> Đang lưu…</> : editing ? 'Lưu thay đổi' : 'Lưu cối'}</button>}>
      <div className="form-grid">
        <label className="f full"><span className="flab">Link tin Goofish</span>
          <input className="input" id="f-url" value={draft.url} placeholder="https://www.goofish.com/item?id=…" inputMode="url" maxLength={500}
            onChange={(e) => set('url', e.target.value)} />
          {err('f-url')}
        </label>
        {dup && (
          <div className="warn-box full">
            <Icon name="warn" size={18} />
            <span>Tin này đã nhập ở <Link className="link-btn small" to={lotHref(d, dup.id)}>{lotName(d, dup.id)}</Link>. Lưu tiếp sẽ tạo thêm một cối.</span>
          </div>
        )}
        {scanBlock}

        <p className="section-title full">Thông tin mua</p>
        <label className="f full"><span className="lrow">Tiêu đề tin {flag('title')}</span>
          <input className={cls('title')} id="f-title" value={draft.title} maxLength={300} onChange={(e) => set('title', e.target.value, 'title')} />
          {err('f-title')}
        </label>
        <label className="f"><span className="lrow">Người bán (nickname) {flag('seller')}</span>
          <input className={cls('seller')} id="f-seller" value={draft.sellerNick} list="lot-sellers" maxLength={100} autoComplete="off"
            onChange={(e) => set('sellerNick', e.target.value, 'seller')} />
          <datalist id="lot-sellers">{sellers.map((s) => <option key={s.id} value={s.nickname} />)}</datalist>
          {sMatch
            ? <span className="hint">Người bán cũ, đã mua {d.lots.filter((l) => l.seller_id === sMatch.id).length} cối{sMatch.is_avoided && <>, <span className="req">đang đánh dấu TRÁNH</span></>}</span>
            : draft.sellerNick.trim() ? <span className="hint">Người bán mới - sẽ thêm vào danh bạ</span> : null}
          {err('f-seller')}
        </label>
        <label className="f"><span className="lrow">Khu vực {flag('region')}</span>
          <input className={cls('region')} id="f-region" value={draft.region} maxLength={100} placeholder={sMatch?.region ?? ''}
            onChange={(e) => set('region', e.target.value, 'region')} />
          {err('f-region')}
        </label>

        {unitsBlock}
        {groupsBlock}

        <div className="stack">
          <div className="two">
            <label className="f"><span className="flab">Tỷ giá ₫/¥ <span className="req">*</span></span>
              <MoneyInput className="input money" id="f-rate" decimals={2} value={draft.rate} onValue={(v) => set('rate', v)} />
              {err('f-rate')}
            </label>
            <label className="f"><span className="flab">Phí mua hộ %</span>
              <input className="input money" id="f-fee" inputMode="decimal" value={draft.feePct} placeholder="0" onChange={(e) => set('feePct', e.target.value)} />
              {err('f-fee')}
            </label>
          </div>
          {/* Gợi ý dưới cả hàng để 2 ô thẳng hàng (audit U6) */}
          <p className="hint two-hint">
            {d.suggestions.last_exchange_rate != null ? 'Tỷ giá gợi ý theo cối nhập gần nhất' : 'Chưa có cối trước để gợi ý tỷ giá'}, phí mua hộ tính trên tiền hàng
            {editing ? ' (khoá khi cối đã về Kho Lumi)' : ` (mặc định ${pct(Number(d.settings?.default_buying_fee_pct ?? 0))} trong Cài đặt)`}
          </p>
        </div>
        <label className="f"><span className="flab">Ship kho VN → Lumi (₫)</span>
          <MoneyInput className="input money" id="f-ship" value={draft.localShip} placeholder="để trống" onValue={(v) => set('localShip', v)} />
          <span className="hint">Bạn trả ngay - cộng vào giá nhập và ghi chi ở Sổ quỹ. Ship TQ → VN tất toán gộp sau ở Sổ quỹ.</span>
          {err('f-ship')}
        </label>
        <label className="f"><span className="flab">Ngày đặt</span>
          <input className="input" id="f-date" type="date" value={draft.orderedAt} onChange={(e) => set('orderedAt', e.target.value)} />
          {err('f-date')}
        </label>
        <label className="f"><span className="flab">Ghi chú</span>
          <input className="input" id="f-note" value={draft.note} maxLength={2000} onChange={(e) => set('note', e.target.value)} />
          {err('f-note')}
        </label>

        <div className="calc full">
          <div className="ln"><span>Tiền hàng</span><span>{previewOk && N ? vnd(lotGoodsVnd(pLot, pUnits)) : '-'}</span></div>
          <div className="ln"><span>Phí mua hộ ({feeVal != null ? pct(feeVal) : '-'})</span><span>{previewOk && N ? vnd(lotBuyingFeeVnd(pLot, pUnits)) : '-'}</span></div>
          <div className="ln"><span>Ship kho VN → Lumi</span><span>{shipVal != null ? vnd(shipVal) : 'chưa nhập'}</span></div>
          {editing && <div className="ln"><span>Ship TQ → VN (đã tất toán)</span><span>{cnShip != null ? vnd(cnShip) : 'chưa tất toán'}</span></div>}
          {draft.groups.map((g, i) => (
            <div className="ln" key={g.key}>
              <span>Giá nhập ₫{draft.groups.length + kept.length > 1 ? `, ${groupCodes[i].length ? rangeText(groupCodes[i], 2) : `nhóm ${i + 1}`}` : ''}</span>
              <span>{previewOk ? costText(parseNum(g.cny)) : '-'}</span>
            </div>
          ))}
          <div className="ln total"><span>Phải trả trung gian</span><span>{previewOk && N ? vnd(lotPayable(pLot, pUnits)) : '-'}</span></div>
          {!editing && (
            <label className="ln paid-now" htmlFor="f-paid">
              <span>Đã thanh toán cho trung gian<span className="hint" style={{ display: 'block' }}>{paidNow ? 'Ghi khoản trả = tiền hàng + phí mua hộ (tiền ra sổ quỹ). Ship TQ → VN tất toán sau.' : 'Chưa trả - cối hiện "còn nợ" ở Sổ quỹ, bấm "Đã thanh toán" khi trả.'}</span></span>
              <input type="checkbox" className="switch" id="f-paid" checked={paidNow} onChange={(e) => setPaidNow(e.target.checked)} />
            </label>
          )}
          <div className="formula">Giá nhập ₫ = giá ¥ × tỷ giá × (1 + phí {feeVal != null ? pct(feeVal) : '%'}) + ship TQ → VN (tất toán sau) + ship kho VN → Lumi, mã cối do app cấp khi lưu</div>
        </div>
      </div>
    </Shell>
  )
}
