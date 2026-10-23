import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/be-vietnam-pro/200.css'
import '@fontsource/be-vietnam-pro/300.css'
import '@fontsource/be-vietnam-pro/400.css'
import '@fontsource/be-vietnam-pro/500.css'
import './styles/tokens.css'
import './styles/app.css'
import './styles/skin-tracker.css'
import App from './app/App.tsx'
import { DataProvider } from './data/store.tsx'
import { ToastProvider } from './ui/feedback.tsx'
import { applyStoredTheme } from './screens/Settings.tsx'
import { registerSW } from 'virtual:pwa-register'

// Tự cập nhật app: có bản mới → kích hoạt + tải lại trang. Kiểm tra bản mới khi mở lại app và mỗi 30 phút.
const updateSW = registerSW({
  immediate: true,
  onRegisteredSW(_url, reg) {
    if (!reg) return
    const check = () => { if (navigator.onLine) reg.update().catch(() => {}) }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check() })
    setInterval(check, 30 * 60 * 1000)
  },
})
void updateSW

// Giao diện kiểu Coffee Shot Tracker là MẶC ĐỊNH (Chủ dự án 2026-10-23). ?skin=classic để dùng lại giao diện xanh rêu cũ, ?skin=tracker để quay về.
try {
  const p = new URLSearchParams(location.search).get('skin')
  if (p) localStorage.setItem('skin', p)
  if (localStorage.getItem('skin') !== 'classic') document.documentElement.dataset.skin = 'tracker'
} catch { document.documentElement.dataset.skin = 'tracker' }

applyStoredTheme() // giao diện Sáng / Tối / Theo máy đã chọn (CSP chặn script inline nên đặt ở đây)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DataProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </DataProvider>
  </StrictMode>,
)
