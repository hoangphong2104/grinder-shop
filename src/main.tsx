import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import './styles/tokens.css'
import './styles/app.css'
import App from './app/App.tsx'
import { DataProvider } from './data/store.tsx'
import { ToastProvider } from './ui/feedback.tsx'
import { applyStoredTheme } from './screens/Settings.tsx'

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
