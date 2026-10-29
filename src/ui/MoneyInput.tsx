// Ô nhập tiền ₫: hiện dấu chấm hàng nghìn trong lúc gõ ("3600000" → "3.600.000"), giữ đúng vị trí con trỏ.
// Giá trị trả ra đã có dấu chấm - parseNum đọc được ("3.600.000" → 3600000).
import { useLayoutEffect, useRef, type InputHTMLAttributes } from 'react'

const group = (digits: string) => digits.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, '.')

/**
 * Nhóm 3 số bằng dấu chấm: "1234567" → "1.234.567"; "" → "".
 * decimals > 0 (tỷ giá, giá ¥): giữ phần lẻ sau dấu phẩy, tối đa `decimals` số ("3612,5" → "3.612,5");
 * số kiểu máy "1060.5" (1 dấu chấm + 1..decimals số cuối) cũng hiểu là phần lẻ.
 */
export function groupThousands(v: string | number | null | undefined, decimals = 0): string {
  let s = String(v ?? '')
  if (decimals > 0 && !s.includes(',') && new RegExp(`^\\d+\\.\\d{1,${decimals}}$`).test(s)) s = s.replace('.', ',')
  if (decimals <= 0 || !s.includes(',')) return group(s.replace(/\D/g, ''))
  const [int, ...rest] = s.split(',')
  return `${group(int.replace(/\D/g, '')) || '0'},${rest.join('').replace(/\D/g, '').slice(0, decimals)}`
}

type Props = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'inputMode'> & {
  value: string | number | null | undefined
  onValue: (v: string) => void
  /** Số chữ số lẻ sau dấu phẩy được phép (0 = chỉ số nguyên đồng). */
  decimals?: number
}

export function MoneyInput({ value, onValue, className, decimals = 0, ...rest }: Props) {
  const ref = useRef<HTMLInputElement>(null)
  // Số chữ số đứng trước con trỏ lúc gõ ⇒ đặt lại con trỏ sau khi thêm / bớt dấu chấm
  const caret = useRef<number | null>(null)
  const shown = groupThousands(value, decimals)
  useLayoutEffect(() => {
    const el = ref.current, n = caret.current
    if (!el || n == null || document.activeElement !== el) return
    caret.current = null
    let pos = 0, seen = 0
    while (pos < shown.length && seen < n) { if (/[\d,]/.test(shown[pos])) seen++; pos++ }
    el.setSelectionRange(pos, pos)
  }, [shown])
  return (
    <input {...rest} ref={ref} className={className ?? 'input money'} inputMode={decimals ? 'decimal' : 'numeric'} autoComplete="off" value={shown}
      onChange={(e) => {
        // Bàn phím chỉ có dấu chấm: gõ "." cuối ở ô có số lẻ ⇒ hiểu là dấu phẩy thập phân
        const raw = decimals && !e.target.value.includes(',') && e.target.value.endsWith('.') ? `${e.target.value.slice(0, -1)},` : e.target.value
        caret.current = raw.slice(0, e.target.selectionStart ?? raw.length).replace(decimals ? /[^\d,]/g : /\D/g, '').length
        onValue(groupThousands(raw, decimals))
      }} />
  )
}
