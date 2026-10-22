// Sinh icon PNG (nền xanh rêu, hình cối tay trắng) — không cần thư viện ngoài. Chạy: node scripts/gen-icons.mjs
// Mọi hình nằm trong vùng an toàn maskable (bán kính ≤ 0.4 × 512 quanh tâm) → dùng chung cho any + maskable.
import fs from 'node:fs'
import zlib from 'node:zlib'

const BG = [0x0e, 0x6e, 0x66]
const FG = [0xff, 0xff, 0xff]
// Hình theo viewBox 512: [loại, ...tham số]
const SHAPES = [
  ['rect', 206, 196, 300, 404, 18], // thân cối (bo góc)
  ['rect', 220, 404, 286, 426, 6],  // đế
  ['rect', 247, 140, 259, 200, 0],  // trục
  ['rect', 247, 136, 352, 148, 6],  // tay quay
  ['circle', 356, 122, 22],         // núm
]
const inRect = (x, y, [, x0, y0, x1, y1, r]) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r)
  return Math.hypot(x - cx, y - cy) <= r
}
const hit = (x, y) => SHAPES.some((s) => (s[0] === 'rect' ? inRect(x, y, s) : Math.hypot(x - s[1], y - s[2]) <= s[3]))

function render(size) {
  const ss = 4, k = size / 512, px = Buffer.alloc(size * size * 3)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let h = 0
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) if (hit((x + (sx + 0.5) / ss) / k, (y + (sy + 0.5) / ss) / k)) h++
      const a = h / (ss * ss)
      for (let c = 0; c < 3; c++) px[(y * size + x) * 3 + c] = Math.round(BG[c] * (1 - a) + FG[c] * a)
    }
  return png(size, px)
}
function png(size, rgb) {
  const raw = Buffer.alloc(size * (size * 3 + 1))
  for (let y = 0; y < size; y++) { raw[y * (size * 3 + 1)] = 0; rgb.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3) }
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0 })
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
for (const [f, s] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) fs.writeFileSync(new URL(`../public/${f}`, import.meta.url), render(s))
fs.writeFileSync(new URL('../public/icon.svg', import.meta.url), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#0E6E66"/><g fill="#fff"><rect x="206" y="196" width="94" height="208" rx="18"/><rect x="220" y="404" width="66" height="22" rx="6"/><rect x="247" y="140" width="12" height="60"/><rect x="247" y="136" width="105" height="12" rx="6"/><circle cx="356" cy="122" r="22"/></g></svg>`)
console.log('icons ok')
