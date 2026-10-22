import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// System Design Lite v1 §3: SPA tĩnh trên GitHub Pages (/grinder-shop/), hash router → base tương đối.
// CSP: chỉ tài nguyên của app + Supabase (REST, Realtime wss, Storage ảnh).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const sb = env.VITE_SUPABASE_URL ?? ''
  const csp =
    `default-src 'self'; img-src 'self' data: blob: ${sb}; style-src 'self' 'unsafe-inline'; script-src 'self'; ` +
    `connect-src 'self' ${sb} ${sb.replace('https://', 'wss://')}; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'`
  const cspMeta = (): Plugin => ({
    name: 'csp-meta',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: csp }, injectTo: 'head-prepend' }],
  })
  return {
    base: './',
    plugins: [
      react(),
      cspMeta(),
      VitePWA({
        registerType: 'prompt',
        includeManifestIcons: false,
        manifest: {
          name: 'Grinder Shop',
          short_name: 'Grinder Shop',
          description: 'Quản lý kho & bán cối xay cà phê',
          lang: 'vi',
          start_url: './',
          scope: './',
          display: 'standalone',
          background_color: '#F6F7F9',
          theme_color: '#0E6E66',
          id: './',
          icons: [
            { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
            { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          ],
        },
        workbox: { globPatterns: ['**/*.{js,css,html,svg,png,woff2}'], navigateFallbackDenylist: [/^\/rest\//, /^\/auth\//] },
      }),
    ],
  }
})
