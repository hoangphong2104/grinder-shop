// Icon nét (prototype v2.2). <Icon name="plus" />
const P: Record<string, string> = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  cam: '<rect x="3" y="7" width="18" height="13" rx="2"/><circle cx="12" cy="13.5" r="3.5"/><path d="M8.5 7l1.5-3h4l1.5 3"/>',
  spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6"/>',
  warn: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17v.5"/>',
  ext: '<path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/>',
  home: '<path d="M4 11l8-7 8 7v9H4z"/><path d="M10 20v-5h4v5"/>',
  box: '<path d="M3 8l9-5 9 5v8l-9 5-9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  truck: '<path d="M3 6h11v10H3zM14 9h4l3 3v4h-7"/><circle cx="7" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M16 12.5h2"/><path d="M3 9h18"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
  store: '<path d="M4 9l1.5-5h13L20 9M4 9h16v11H4zM9 20v-6h6v6"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8" r="1.3"/>',
  note: '<path d="M5 3h10l4 4v14H5z"/><path d="M15 3v4h4M8 11h8M8 15h8M8 19h5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
}
export type IconName = keyof typeof P
export function Icon({ name, size, strokeWidth = 1.6 }: { name: string; size?: number; strokeWidth?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: P[name] ?? '' }} />
  )
}
/** Hình nét vẽ cối tay theo dáng model (không logo). shape: 'zp6' | 'k' | 'j' (đoán theo tên model). */
export function shapeOf(modelName: string): 'zp6' | 'k' | 'j' {
  const n = modelName.toLowerCase()
  return n.includes('zp6') ? 'zp6' : n.startsWith('j') ? 'j' : 'k'
}
export function GrinderArt({ shape }: { shape: 'zp6' | 'k' | 'j' }) {
  const w = shape === 'zp6' ? 16 : shape === 'k' ? 20 : 19, x = 30 - w / 2
  return (
    <svg viewBox="0 0 60 80" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" aria-hidden="true">
      <rect x={x} y={22} width={w} height={50} rx={3} />
      {shape === 'k' && <><path d={`M${x} 44h${w}`} /><path d={`M${x} 47h${w}`} /></>}
      {shape === 'j' && <path d={`M${x} 46h${w}`} />}
      <path d={`M${x + 2} 72v3h${w - 4}v-3`} /><path d="M30 22v-6" /><path d="M30 16h18" /><circle cx={50} cy={12} r={4} /><path d="M50 8V4" />
    </svg>
  )
}
export const Gpic = ({ modelName }: { modelName: string }) => <span className="gpic"><GrinderArt shape={shapeOf(modelName)} /></span>
export const Brandmark = () => <span className="brandmark"><GrinderArt shape="k" /></span>
