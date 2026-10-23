// CR-005 ý 12 - VietQR chuyển khoản: danh sách ngân hàng (BIN NAPAS), vẽ mã QR tại máy (thư viện `qrcode`, không gọi ảnh ngoài),
// ảnh PNG để bấm giữ lưu / tải về, dòng hướng dẫn cho tin xác nhận đơn. Dùng ở Chi tiết đơn + Cài đặt.
import { useMemo } from 'react'
import { create as qrCreate } from 'qrcode'
import type { SettingsRow } from '../../data/types.ts'
import { buildVietQrPayload, checkVietQr, vietQrText } from '../../domain/vietqr.ts'
import { vnd } from '../../ui/format.ts'

/** Ngân hàng hay dùng + mã BIN NAPAS (6 số). Ngân hàng khác: chọn "Khác" và nhập BIN. */
export const BANKS: { bin: string; name: string }[] = [
  { bin: '970436', name: 'Vietcombank' },
  { bin: '970415', name: 'VietinBank' },
  { bin: '970418', name: 'BIDV' },
  { bin: '970405', name: 'Agribank' },
  { bin: '970407', name: 'Techcombank' },
  { bin: '970422', name: 'MB (MBBank)' },
  { bin: '970416', name: 'ACB' },
  { bin: '970432', name: 'VPBank' },
  { bin: '970423', name: 'TPBank' },
  { bin: '970403', name: 'Sacombank' },
  { bin: '970441', name: 'VIB' },
  { bin: '970443', name: 'SHB' },
  { bin: '970437', name: 'HDBank' },
  { bin: '970448', name: 'OCB' },
  { bin: '970426', name: 'MSB' },
  { bin: '970440', name: 'SeABank' },
  { bin: '970431', name: 'Eximbank' },
  { bin: '970449', name: 'LPBank (LienVietPostBank)' },
  { bin: '970428', name: 'Nam A Bank' },
  { bin: '970409', name: 'Bac A Bank' },
  { bin: '970412', name: 'PVcomBank' },
  { bin: '970454', name: 'BVBank (Bản Việt) / Timo' },
]
export const bankName = (bin: string | null | undefined) => (bin ? BANKS.find((b) => b.bin === bin)?.name ?? `BIN ${bin}` : '')

/** Tên chủ TK kiểu ngân hàng: bỏ dấu, chữ HOA, chỉ chữ / số / khoảng trắng. */
export const accountNameNorm = (v: string) =>
  v.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' ')

export interface BankCfg { bin: string; accountNo: string; accountName: string }
/** Cấu hình VietQR từ settings; null = chưa nhập đủ (BIN + số TK hợp lệ). */
export function bankCfg(st: SettingsRow | null | undefined): BankCfg | null {
  if (!st?.bank_bin || !st.bank_account_no) return null
  if (checkVietQr({ bin: st.bank_bin, accountNo: st.bank_account_no })) return null
  return { bin: st.bank_bin, accountNo: st.bank_account_no, accountName: st.bank_account_name ?? '' }
}

/** Nội dung chuyển khoản = mã đơn (bỏ dấu, ≤ 25 ký tự). */
export const qrContent = (code: string) => vietQrText(code, 25)

/** Dòng cho tin xác nhận đơn: ngân hàng · STK · tên · số tiền · nội dung + nhắc quét QR. */
export function qrMessageLines(cfg: BankCfg, amount: number, code: string): string[] {
  return [
    `Chuyển khoản: ${bankName(cfg.bin)} · STK ${cfg.accountNo}${cfg.accountName ? ` · ${cfg.accountName}` : ''}`,
    `Số tiền ${vnd(amount)} · nội dung: ${qrContent(code)}`,
    'Shop gửi kèm mã QR - anh/chị quét bằng app ngân hàng là điền sẵn số tiền và nội dung.',
  ]
}

interface QrImage { dataUrl: string; size: number }
/**
 * Vẽ QR (+ chữ dưới mã) ra PNG data URL - đồng bộ, để <img> bấm giữ "Lưu ảnh" trên điện thoại và tải về ngay trong lúc bấm.
 * caption: các dòng chữ in dưới mã (ảnh gửi khách vẫn đọc được số tiền / nội dung).
 */
function renderQrPng(payload: string, caption: string[]): QrImage | null {
  try {
    const qr = qrCreate(payload, { errorCorrectionLevel: 'M' })
    const n = qr.modules.size
    const scale = 10, quiet = 4 * scale
    const qrPx = n * scale + quiet * 2
    const lineH = 30
    const w = Math.max(qrPx, 520)
    const h = qrPx + (caption.length ? caption.length * lineH + 16 : 0)
    const cv = document.createElement('canvas')
    cv.width = w; cv.height = h
    const ctx = cv.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h)
    ctx.fillStyle = '#000000'
    const x0 = Math.round((w - qrPx) / 2) + quiet
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.modules.data[r * n + c]) ctx.fillRect(x0 + c * scale, quiet + r * scale, scale, scale)
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    caption.forEach((t, i) => {
      ctx.font = i === 0 ? 'bold 24px sans-serif' : '20px sans-serif'
      ctx.fillText(t, w / 2, qrPx + i * lineH + lineH / 2, w - 24)
    })
    return { dataUrl: cv.toDataURL('image/png'), size: w }
  } catch { return null }
}

/** data URL → Blob (đồng bộ, để tải trong cùng lượt bấm). */
function dataUrlToBlob(url: string): Blob {
  const [head, b64] = url.split(',')
  const bin = atob(b64)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return new Blob([arr], { type: head.match(/:(.*?);/)?.[1] ?? 'image/png' })
}

/** Tải ảnh PNG (object URL tạo trong lúc bấm). false ⇒ không tải được (gợi ý bấm giữ ảnh). */
export function downloadPng(dataUrl: string, filename: string): boolean {
  try {
    const href = URL.createObjectURL(dataUrlToBlob(dataUrl))
    const a = document.createElement('a')
    a.href = href; a.download = filename; a.rel = 'noopener'
    document.body.appendChild(a); a.click(); a.remove()
    setTimeout(() => URL.revokeObjectURL(href), 10000)
    return true
  } catch { return false }
}

/** Ảnh QR VietQR + chữ dưới; trả cả dataUrl để nút "Lưu ảnh QR" dùng lại. */
export function useVietQr(cfg: BankCfg | null, amount: number | null, content: string, caption: string[]) {
  const capKey = caption.join('\n')
  return useMemo(() => {
    if (!cfg) return { img: null, error: 'Chưa cài tài khoản ngân hàng.' }
    const input = { bin: cfg.bin, accountNo: cfg.accountNo, accountName: cfg.accountName, amount: amount && amount > 0 ? Math.round(amount) : null, content }
    const err = checkVietQr(input)
    if (err) return { img: null, error: err }
    const img = renderQrPng(buildVietQrPayload(input), capKey ? capKey.split('\n') : [])
    return { img, error: img ? null : 'Không vẽ được mã QR trên máy này.' }
  }, [cfg?.bin, cfg?.accountNo, cfg?.accountName, amount, content, capKey])
}

export function QrImg({ src, label }: { src: string; label: string }) {
  return <img className="o-qr-img" src={src} alt={label} />
}
