/**
 * Test fixture: the prototype's mock history (1.0-requirements/draft/prototypes/prototype-mock-data.js),
 * transcribed field-for-field for the domain types. Simulated "today" = 2026-10-22. Not real numbers.
 */
import type { Lot, Order, Transfer } from './types.ts';

export const TODAY = '2026-10-22';

export const lots: Lot[] = [
  { id: 'l1', code: 'L-001', orderedAt: '2026-08-28', rate: 3560, shipFee: 750000, status: 'daNhan', receivedAt: '2026-09-10', lines: [{ variantId: 'v1', qty: 3, cny: 760 }] },
  { id: 'l2', code: 'L-002', orderedAt: '2026-09-05', rate: 3580, shipFee: 560000, status: 'daNhan', receivedAt: '2026-09-18', lines: [{ variantId: 'v2', qty: 2, cny: 1080 }] },
  { id: 'l3', code: 'L-003', orderedAt: '2026-09-20', rate: 3600, shipFee: 600000, status: 'daNhan', receivedAt: '2026-10-03', lines: [{ variantId: 'v4', qty: 2, cny: 1150 }] },
  { id: 'l4', code: 'L-004', orderedAt: '2026-10-08', rate: 3610, shipFee: null, status: 'veVN', receivedAt: null, lines: [{ variantId: 'v2', qty: 2, cny: 1050 }] },
  { id: 'l5', code: 'L-005', orderedAt: '2026-10-18', rate: 3620, shipFee: null, status: 'shipTQ', receivedAt: null, lines: [{ variantId: 'v1', qty: 2, cny: 740 }] },
  { id: 'l6', code: 'L-006', orderedAt: '2026-10-21', rate: 3620, shipFee: null, status: 'dat', receivedAt: null, lines: [{ variantId: 'v5', qty: 1, cny: 1180 }] },
];

export const transfers: Transfer[] = [
  { id: 't1', date: '2026-08-29', kind: 'chuyen', amount: 9000000, note: 'CK Vietcombank' },
  { id: 't2', date: '2026-09-06', kind: 'chuyen', amount: 8000000 },
  { id: 't3', date: '2026-09-21', kind: 'chuyen', amount: 9000000 },
  { id: 't4', date: '2026-10-09', kind: 'chuyen', amount: 7600000 },
  { id: 't5', date: '2026-10-19', kind: 'chuyen', amount: 5000000, note: 'Ứng trước lô ZP6' },
];

export const orders: Order[] = [
  { id: 'o1', code: 'D-001', customerId: 'c1', date: '2026-09-12', status: 'hoanTat', sentAt: '2026-09-13', shipFee: 35000, shipPayer: 'shop', lines: [{ variantId: 'v1', qty: 1, price: 4600000 }], payments: [{ date: '2026-09-12', amount: 1000000, kind: 'coc' }, { date: '2026-09-15', amount: 3600000, kind: 'tt' }] },
  { id: 'o2', code: 'D-002', customerId: 'c2', date: '2026-09-20', status: 'hoanTat', sentAt: '2026-09-21', shipFee: 40000, shipPayer: 'khach', lines: [{ variantId: 'v2', qty: 1, price: 6800000 }], payments: [{ date: '2026-09-23', amount: 6840000, kind: 'tt' }] },
  { id: 'o3', code: 'D-003', customerId: 'c3', date: '2026-10-05', status: 'daGui', sentAt: '2026-10-06', shipFee: 45000, shipPayer: 'shop', lines: [{ variantId: 'v4', qty: 1, price: 7300000 }], payments: [{ date: '2026-10-05', amount: 2000000, kind: 'coc' }] },
  { id: 'o4', code: 'D-004', customerId: 'c4', date: '2026-10-12', status: 'daGui', sentAt: '2026-10-12', shipFee: 0, shipPayer: 'shop', lines: [{ variantId: 'v2', qty: 1, price: 6700000 }], payments: [{ date: '2026-10-12', amount: 6700000, kind: 'tt' }] },
  { id: 'o5', code: 'D-005', customerId: 'c5', date: '2026-10-15', status: 'datTruoc', sentAt: null, shipFee: 40000, shipPayer: 'khach', lines: [{ variantId: 'v2', qty: 1, price: 6900000 }], payments: [{ date: '2026-10-15', amount: 1000000, kind: 'coc' }] },
  { id: 'o6', code: 'D-006', customerId: 'c6', date: '2026-10-20', status: 'daChot', sentAt: null, shipFee: 50000, shipPayer: 'khach', lines: [{ variantId: 'v1', qty: 1, price: 4500000 }], payments: [{ date: '2026-10-20', amount: 500000, kind: 'coc' }] },
];
