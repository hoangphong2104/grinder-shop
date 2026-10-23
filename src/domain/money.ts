/**
 * VND rounding (Q-006) and display formatting. Pure functions, no I/O.
 * Every money formula in the domain rounds ONCE, at the end, with `roundVnd`.
 */
import type { Vnd } from './types.ts';

/* ---------- Rounding & formatting ---------- */

/**
 * Round to whole đồng, half away from zero. A 6-decimal pre-rounding absorbs binary
 * floating-point noise (e.g. 0.1 × 3 = 0.30000000000000004) so x.5 values round as written.
 */
export function roundVnd(n: number): Vnd {
  if (!Number.isFinite(n)) throw new RangeError(`roundVnd: not a finite number (${n})`);
  const a = Math.round(Number(Math.abs(n).toFixed(6)));
  return a === 0 ? 0 : n < 0 ? -a : a;
}

const MINUS = '−';

function groupThousands(intAbs: number): string {
  return String(intAbs).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** `3936000` → `"3.936.000 ₫"`; negative → `"−2.872.000 ₫"`; null/undefined → `"-"`. */
export function formatVnd(n: Vnd | null | undefined): string {
  if (n == null) return '-';
  const r = roundVnd(n);
  return (r < 0 ? MINUS : '') + groupThousands(Math.abs(r)) + ' ₫';
}

/**
 * Compact form used on dashboards: `5400000` → `"5,4tr"`, `3000000` → `"3tr"`,
 * `120000` → `"120k"`, `150000000` → `"150tr"`, `500` → `"500"`.
 * Under 100tr one decimal is shown (dropped when it is 0); from 100tr whole millions.
 */
export function formatTr(n: Vnd | null | undefined): string {
  // Gọn nhưng đủ chính xác (Chủ dự án 2026-10-23: "ít nhất phải hiện là 4.038k"): làm tròn tới nghìn đồng, nhóm nghìn kiểu vi-VN.
  if (n == null) return '-';
  const r = roundVnd(n);
  const sign = r < 0 ? MINUS : '';
  const a = Math.abs(r);
  if (a < 1e3) return sign + String(a);
  return sign + groupThousands(Math.round(a / 1e3)) + 'k';
}

/** `1010` → `"¥1.010"`; decimals use a comma (`99.5` → `"¥99,5"`). */
export function formatCny(n: number | null | undefined): string {
  if (n == null) return '-';
  const [i, d] = String(Math.abs(n)).split('.');
  return (n < 0 ? MINUS : '') + '¥' + groupThousands(Number(i)) + (d ? `,${d}` : '');
}
