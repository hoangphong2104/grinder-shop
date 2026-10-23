// Sinh icon PNG (nền trắng, hình cối tay đen - kiểu Coffee Shot Tracker) — không cần thư viện ngoài. Chạy: node scripts/gen-icons.mjs
// Mọi hình nằm trong vùng an toàn maskable (bán kính ≤ 0.4 × 512 quanh tâm) → dùng chung cho any + maskable.
import fs from 'node:fs'
import zlib from 'node:zlib'

const BG = [0xff, 0xff, 0xff]
const FG = [0x1a, 0x1a, 0x1a]
// Hình nét (viewBox 512): thân + đế là khung viền, trục + tay quay là nét đơn, núm là vòng tròn. SW = độ dày nét.
const SW = 16
const inRR = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r)
  return Math.hypot(x - cx, y - cy) <= r
}
const frame = (x, y, x0, y0, x1, y1, r) => inRR(x, y, x0, y0, x1, y1, r) && !inRR(x, y, x0 + SW, y0 + SW, x1 - SW, y1 - SW, Math.max(r - SW, 0))
const hit = (x, y) =>
  frame(x, y, 200, 196, 306, 404, 22) ||                 // thân cối
  inRR(x, y, 200, 300, 306, 300 + SW, 0) ||              // vạch vòng chỉnh cỡ xay
  frame(x, y, 214, 396, 292, 432, 8) ||                  // đế
  inRR(x, y, 253 - SW / 2, 140, 253 + SW / 2, 200, 0) || // trục
  inRR(x, y, 253 - SW / 2, 134, 340, 134 + SW, SW / 2) || // tay quay
  (Math.hypot(x - 356, y - 122) <= 26 && Math.hypot(x - 356, y - 122) >= 26 - SW) // núm

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
fs.writeFileSync(new URL('../public/icon.svg', import.meta.url), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#FFFFFF"/><g fill="none" stroke="#1A1A1A" stroke-width="16" stroke-linecap="round"><rect x="208" y="204" width="90" height="192" rx="14"/><path d="M200 308h106"/><rect x="222" y="404" width="62" height="20" rx="4"/><path d="M253 140v56M253 142h80"/><circle cx="356" cy="122" r="18"/></g></svg>`)
console.log('icons ok')
