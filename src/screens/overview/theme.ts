// Giao diện Sáng / Tối / Theo máy: lưu localStorage 'theme', áp vào <html data-theme> (tokens.css đọc thuộc tính này).
export type ThemeChoice = 'auto' | 'light' | 'dark'

export function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem('theme')
    return v === 'light' || v === 'dark' ? v : 'auto'
  } catch { return 'auto' }
}
function applyTheme(t: ThemeChoice): void {
  if (t === 'auto') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = t
}
export function setTheme(t: ThemeChoice): void {
  try { if (t === 'auto') localStorage.removeItem('theme'); else localStorage.setItem('theme', t) } catch { /* trình duyệt chặn lưu - vẫn áp cho phiên này */ }
  applyTheme(t)
}
/** Gọi 1 lần khi app khởi động (main.tsx) để áp giao diện đã chọn trước khi vẽ. */
export function applyStoredTheme(): void { applyTheme(readTheme()) }
