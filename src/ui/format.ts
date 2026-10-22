// Định dạng hiển thị (vi-VN). Tiền / làm tròn dùng chung với domain (Q-006).
export { formatVnd as vnd, formatTr as tr, formatCny as cny } from '../domain/index.ts'
/** 2026-10-22 → 22/10 */
export const dmy = (iso: string | null | undefined) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '—')
/** Hôm nay theo giờ VN (YYYY-MM-DD). */
export const todayVn = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date())
/** Đọc số từ ô nhập ("3.600", "1 060", "1060,5") — trả null nếu trống / sai. */
export function parseNum(v: string): number | null {
  const s = v.trim().replace(/[\s₫¥]/g, '')
  if (!s) return null
  let norm: string
  if (s.includes(',')) norm = s.replace(/\./g, '').replace(',', '.') // "1.060,5" → 1060.5
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) norm = s.replace(/\./g, '') // "3.600.000" → 3600000
  else norm = s // "1060.5"
  const n = Number(norm)
  return Number.isFinite(n) ? n : null
}
