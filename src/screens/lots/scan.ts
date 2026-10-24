// AI quét tin Goofish (F2, BR-13): thu nhỏ ảnh → upload bucket private → gọi Edge Function scan-goofish
// theo hợp đồng System Design §5.2. Mọi lỗi ⇒ ném Error có câu tiếng Việt; form vẫn nhập tay được.
// v0.2 (CR-001): Edge Function chỉ đoán model (fields.model_id) - bỏ fields.variant_id (bản cũ còn gửi thì bỏ qua);
// thêm qty_guess ở gốc (số chiếc trong tin, 2..50; null khi 1 chiếc / không chắc - không bao giờ bị flag).
import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError } from '@supabase/supabase-js'
import { supabase } from '../../lib/supabase.ts'
import { errorMessage } from '../../data/errors.ts'
import type { ModelRow } from '../../data/types.ts'

export const BUCKET = 'private-images'
const MAX_BYTES = 5 * 1024 * 1024
const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp']
export const MAX_TEXT = 20000

export interface ScanField<T> { value: T | null; confidence: number; matched_text?: string | null }
export interface ScanResponse {
  ok: true
  scan_id: string
  model: string
  fields: {
    listing_title?: ScanField<string>; price_cny?: ScanField<number>; seller_nickname?: ScanField<string>
    seller_region?: ScanField<string>; model_id?: ScanField<string>
    /** Bản Edge Function cũ (v0.1) - không dùng nữa, có thể vắng. */
    variant_id?: ScanField<string>
  }
  /** Số chiếc AI đoán trong tin (2..50); null khi 1 chiếc / không chắc / dưới ngưỡng. */
  qty_guess?: { value: number; confidence: number } | null
  flags?: string[]
  condition_text?: string | null
  notes?: string | null
  seller_match?: { seller_id: string; nickname: string; is_avoided: boolean } | null
  duplicate_lot_ids?: string[]
  usage?: { scans_this_month: number; cap: number }
}
export type ScanInput = { kind: 'image'; image_path: string } | { kind: 'text'; text: string }

/** Thu nhỏ ảnh: cạnh dài ≤ 1.600 px, JPEG 0,8 (ADR-08). Không giải mã được ⇒ dùng ảnh gốc nếu hợp lệ.
 *  CR-008: ảnh chụp màn hình dọc (cao > 1,6 × rộng) chỉ giữ 60% phía trên - phần có người bán, giá, tiêu đề, tình trạng;
 *  phía dưới là ảnh sản phẩm ⇒ bớt dữ liệu gửi AI, quét nhanh hơn. */
async function shrink(file: File): Promise<{ blob: Blob; ext: string; type: string }> {
  try {
    const bmp = await createImageBitmap(file)
    const srcH = bmp.height > bmp.width * 1.6 ? Math.round(bmp.height * 0.6) : bmp.height
    const k = Math.min(1, 1600 / Math.max(bmp.width, srcH))
    const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(srcH * k))
    const c = document.createElement('canvas')
    c.width = w; c.height = h
    const ctx = c.getContext('2d')
    if (!ctx) throw new Error('canvas')
    ctx.drawImage(bmp, 0, 0, bmp.width, srcH, 0, 0, w, h)
    bmp.close()
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', 0.8))
    if (!blob) throw new Error('toBlob')
    return { blob, ext: 'jpg', type: 'image/jpeg' }
  } catch {
    if (OK_TYPES.includes(file.type) && file.size <= MAX_BYTES) {
      return { blob: file, ext: file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg', type: file.type }
    }
    throw new Error('Không đọc được ảnh này - chọn ảnh JPEG / PNG / WebP (ảnh chụp màn hình).')
  }
}

/** Upload ảnh chụp tin vào {uid}/goofish/{uuid}.jpg - trả đường dẫn để lưu vào lots.screenshot_path. */
export async function uploadScreenshot(uid: string, file: File): Promise<string> {
  const { blob, ext, type } = await shrink(file)
  if (blob.size > MAX_BYTES) throw new Error('Ảnh quá lớn (> 5 MB) - chụp lại hoặc chọn ảnh nhỏ hơn.')
  const path = `${uid}/goofish/${crypto.randomUUID()}.${ext}`
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: type, upsert: false })
  if (error) {
    if (/Failed to fetch|NetworkError|network/i.test(error.message)) throw new Error('Mất kết nối mạng - chưa tải ảnh lên được. Thử lại khi có mạng.')
    throw new Error('Không tải được ảnh lên - thử lại. (' + error.message + ')')
  }
  return path
}

// Mã lỗi của Edge Function (supabase/functions/scan-goofish/README.md). Câu tiếng Việt lấy từ data/errors.ts;
// chỉ INTERNAL / INVALID_INPUT có câu riêng ở đây cho ngữ cảnh quét.
const LOCAL: Record<string, string> = {
  INTERNAL: 'AI quét gặp lỗi - nhập tay.',
  INVALID_INPUT: 'Dữ liệu quét chưa hợp lệ (chữ rỗng hoặc quá 20.000 ký tự) - kiểm tra lại.',
}
const SHARED = ['SCAN_CAP_REACHED', 'SCAN_DISABLED', 'AI_QUOTA_EXHAUSTED', 'AI_UPSTREAM_ERROR', 'AI_UNREADABLE',
  'IMAGE_NOT_FOUND', 'PAYLOAD_TOO_LARGE', 'FORBIDDEN', 'NOT_AUTHENTICATED']

interface ScanErr { code?: string; message?: string; used?: number; cap?: number }
function scanMessage(e: ScanErr | undefined, status: number | undefined): string {
  const code = e?.code
  if (code === 'SCAN_CAP_REACHED' && e?.used != null && e?.cap != null) return `Đã dùng hết ${e.used}/${e.cap} lượt quét AI tháng này - nhập tay.`
  if (code && LOCAL[code]) return LOCAL[code]
  // CR-008: lỗi phía AI dùng câu chi tiết của function (có mã HTTP của Google) + mã lỗi để báo lại khi cần sửa
  if (code === 'AI_UPSTREAM_ERROR' && e?.message) return `${e.message} (mã lỗi ${code})`
  if (code && SHARED.includes(code)) return `${errorMessage({ message: code })} (mã lỗi ${code})`
  if (status === 401) return errorMessage({ message: 'NOT_AUTHENTICATED' }) // 401 của gateway không có thân JSON
  if (status === 429) return errorMessage({ message: 'AI_QUOTA_EXHAUSTED' })
  if (status === 404) return 'Chức năng AI quét chưa được triển khai - nhập tay.'
  return e?.message ? `${e.message} - nhập tay.` : 'AI quét gặp lỗi - nhập tay.'
}

/** Gọi scan-goofish. Thành công ⇒ trả kết quả; lỗi ⇒ ném Error tiếng Việt (SCAN_CAP_REACHED, SCAN_DISABLED, AI_QUOTA_EXHAUSTED…). */
export async function invokeScan(input: ScanInput, goofishUrl: string | null): Promise<ScanResponse> {
  const { data, error } = await supabase.functions.invoke('scan-goofish', { body: { input, goofish_url: goofishUrl } })
  if (error) {
    if (error instanceof FunctionsHttpError) {
      const res = error.context as Response
      let body: ScanErr | undefined
      try { body = (await res.json())?.error } catch { /* thân không phải JSON (vd. 401 của gateway) */ }
      throw new Error(scanMessage(body, res.status))
    }
    if (error instanceof FunctionsFetchError) throw new Error('Mất kết nối mạng - chưa quét được. Vẫn nhập tay được.')
    if (error instanceof FunctionsRelayError) throw new Error('Không gọi được AI quét lúc này - thử lại hoặc nhập tay.')
    throw new Error(scanMessage({ message: error.message }, undefined))
  }
  const r = (typeof data === 'string' ? JSON.parse(data) : data) as ScanResponse | { ok: false; error?: ScanErr }
  if (!r || r.ok !== true) throw new Error(scanMessage((r as { error?: ScanErr } | null)?.error, undefined))
  return r
}

const norm = (s: string) => s.toLowerCase().replace(/[\s\-_.·]/g, '')

/** Khớp model theo tên + tên gọi khác (models.aliases) - lấy tên khớp dài nhất. */
export function matchModelByAlias(models: ModelRow[], texts: (string | null | undefined)[]): ModelRow | null {
  let best: ModelRow | null = null, bestLen = 0
  for (const raw of texts) {
    if (!raw) continue
    const t = norm(raw)
    for (const m of models) {
      if (!m.is_active) continue
      for (const a of [m.name, ...(m.aliases ?? [])]) {
        const n = norm(a)
        if (n.length >= 2 && t.includes(n) && n.length > bestLen) { best = m; bestLen = n.length }
      }
    }
    if (best) return best
  }
  return best
}
