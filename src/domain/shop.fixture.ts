/**
 * Test fixture (CR-001 model): 3 models, 7 lots (one mixed-model, one cancelled), 15 units, 8 orders,
 * 7 intermediary transactions. Simulated "today" = 2026-10-22. Realistic, but not real numbers.
 *
 * Hand-computed unit costs (auto = round(¥ × rate + ship ÷ units in lot)):
 *   L1 3 × ZP6 ¥760, rate 3.560, ship 750.000 → 2.705.600 + 250.000 = 2.955.600
 *   L2 2 × KU  ¥1.080, rate 3.580, ship 560.000 → 3.866.400 + 280.000 = 4.146.400
 *   L3 2 × KU  ¥1.010, rate 3.600, ship 600.000 → 3.636.000 + 300.000 = 3.936.000 (KU-004 override 4.000.000)
 *   L4 2 × JU ¥1.150 + 1 × ZP6 ¥740, rate 3.600, ship 900.000 (÷ 3 = 300.000)
 *        JU → 4.140.000 + 300.000 = 4.440.000 · ZP6 → 2.664.000 + 300.000 = 2.964.000
 *   L5 2 × KU ¥1.050, rate 3.610, ship blank (vn_shipping) → provisional 3.790.500
 *   L6 2 × ZP6 ¥745,5, rate 3.620, ship blank (cn_shipping) → provisional 2.698.710
 *   L7 1 × JU ¥1.180, rate 3.615 — cancelled
 */
import type { Lot, Model, Order, Transfer, Unit } from './types.ts';

export const TODAY = '2026-10-22';

export const models: Model[] = [
  { id: 'm-zp6', name: 'ZP6 Special', codePrefix: 'ZP6', defaultListPrice: 4600000, lowStockThreshold: 1, nextSeq: 7 },
  { id: 'm-ku', name: 'K Ultra', codePrefix: 'KU', defaultListPrice: 6800000, lowStockThreshold: 1, nextSeq: 7 },
  { id: 'm-ju', name: 'J Ultra', codePrefix: 'JU', defaultListPrice: 7200000, lowStockThreshold: 1, nextSeq: 4 },
];

export const lots: Lot[] = [
  { id: 'l1', code: 'L-001', orderedAt: '2026-08-28', rate: 3560, shipFee: 750000, status: 'received', receivedAt: '2026-09-10' },
  { id: 'l2', code: 'L-002', orderedAt: '2026-09-05', rate: 3580, shipFee: 560000, status: 'received', receivedAt: '2026-09-18' },
  { id: 'l3', code: 'L-003', orderedAt: '2026-09-20', rate: 3600, shipFee: 600000, status: 'received', receivedAt: '2026-10-03' },
  { id: 'l4', code: 'L-004', orderedAt: '2026-09-25', rate: 3600, shipFee: 900000, status: 'received', receivedAt: '2026-10-06' },
  { id: 'l5', code: 'L-005', orderedAt: '2026-10-10', rate: 3610, shipFee: null, status: 'vn_shipping', receivedAt: null },
  { id: 'l6', code: 'L-006', orderedAt: '2026-10-18', rate: 3620, shipFee: null, status: 'cn_shipping', receivedAt: null },
  { id: 'l7', code: 'L-007', orderedAt: '2026-10-12', rate: 3615, shipFee: null, status: 'cancelled', receivedAt: null },
];

const u = (id: string, code: string, modelId: string, lotId: string, priceCny: number, listPrice: number, over: Partial<Unit> = {}): Unit => ({
  id, code, modelId, lotId, priceCny, costOverride: null, listPrice, serialNo: null, note: null, ...over,
});

export const units: Unit[] = [
  u('u-zp6-1', 'ZP6-001', 'm-zp6', 'l1', 760, 4600000),
  u('u-zp6-2', 'ZP6-002', 'm-zp6', 'l1', 760, 4600000),
  u('u-zp6-3', 'ZP6-003', 'm-zp6', 'l1', 760, 4600000, { serialNo: 'ZP6S-2409-118' }),
  u('u-ku-1', 'KU-001', 'm-ku', 'l2', 1080, 6800000),
  u('u-ku-2', 'KU-002', 'm-ku', 'l2', 1080, 6800000, { note: 'Hộp móp nhẹ' }),
  u('u-ku-3', 'KU-003', 'm-ku', 'l3', 1010, 6700000),
  u('u-ku-4', 'KU-004', 'm-ku', 'l3', 1010, 6800000, { costOverride: 4000000, note: 'Thêm phí sửa núm' }),
  u('u-ju-1', 'JU-001', 'm-ju', 'l4', 1150, 7300000),
  u('u-ju-2', 'JU-002', 'm-ju', 'l4', 1150, 7200000),
  u('u-zp6-4', 'ZP6-004', 'm-zp6', 'l4', 740, 4500000),
  u('u-ku-5', 'KU-005', 'm-ku', 'l5', 1050, 6900000),
  u('u-ku-6', 'KU-006', 'm-ku', 'l5', 1050, 6900000),
  u('u-zp6-5', 'ZP6-005', 'm-zp6', 'l6', 745.5, 4500000),
  u('u-zp6-6', 'ZP6-006', 'm-zp6', 'l6', 745.5, 4500000),
  u('u-ju-3', 'JU-003', 'm-ju', 'l7', 1180, 7300000),
];

export const orders: Order[] = [
  { id: 'o1', code: 'D-001', orderDate: '2026-09-12', status: 'completed', shippedAt: '2026-09-13', shipFee: 35000, shipPayer: 'shop',
    lines: [{ unitId: 'u-zp6-1', price: 4600000 }],
    payments: [{ kind: 'deposit', amount: 1000000, date: '2026-09-12' }, { kind: 'payment', amount: 3600000, date: '2026-09-15' }] },
  { id: 'o2', code: 'D-002', orderDate: '2026-09-20', status: 'completed', shippedAt: '2026-09-21', shipFee: 40000, shipPayer: 'customer',
    lines: [{ unitId: 'u-ku-1', price: 6800000 }],
    payments: [{ kind: 'payment', amount: 6840000, date: '2026-09-23' }] },
  { id: 'o3', code: 'D-003', orderDate: '2026-10-06', status: 'shipped', shippedAt: '2026-10-07', shipFee: 45000, shipPayer: 'shop',
    lines: [{ unitId: 'u-ju-1', price: 7300000 }],
    payments: [{ kind: 'deposit', amount: 2000000, date: '2026-10-06' }] },
  { id: 'o4', code: 'D-004', orderDate: '2026-10-12', status: 'shipped', shippedAt: '2026-10-12', shipFee: 0, shipPayer: 'shop',
    lines: [{ unitId: 'u-ku-3', price: 6700000 }],
    payments: [{ kind: 'payment', amount: 6700000, date: '2026-10-12' }] },
  { id: 'o5', code: 'D-005', orderDate: '2026-10-14', status: 'preorder', shippedAt: null, shipFee: 30000, shipPayer: 'customer',
    lines: [{ unitId: 'u-ku-5', price: 6900000 }],
    payments: [{ kind: 'deposit', amount: 1500000, date: '2026-10-14' }] },
  { id: 'o6', code: 'D-006', orderDate: '2026-10-19', status: 'confirmed', shippedAt: null, shipFee: 30000, shipPayer: 'customer',
    lines: [{ unitId: 'u-zp6-2', price: 4650000 }],
    payments: [{ kind: 'deposit', amount: 500000, date: '2026-10-19' }] },
  { id: 'o7', code: 'D-007', orderDate: '2026-10-15', status: 'cancelled', shippedAt: null, shipFee: 0, shipPayer: 'shop',
    lines: [{ unitId: 'u-ku-2', price: 6800000 }],
    payments: [{ kind: 'deposit', amount: 1000000, date: '2026-10-15' }, { kind: 'refund', amount: 400000, date: '2026-10-17' }] },
  { id: 'o8', code: 'D-008', orderDate: '2026-10-20', status: 'preorder', shippedAt: null, shipFee: 0, shipPayer: 'shop',
    lines: [{ unitId: 'u-zp6-3', price: 4600000 }, { unitId: 'u-zp6-5', price: 4500000 }],
    payments: [] },
];

export const transfers: Transfer[] = [
  { id: 't1', date: '2026-08-29', kind: 'transfer', amount: 9000000, note: 'CK Vietcombank' },
  { id: 't2', date: '2026-09-06', kind: 'transfer', amount: 8000000 },
  { id: 't3', date: '2026-09-21', kind: 'transfer', amount: 7900000 },
  { id: 't4', date: '2026-09-26', kind: 'transfer', amount: 11000000 },
  { id: 't5', date: '2026-10-11', kind: 'transfer', amount: 7000000 },
  { id: 't6', date: '2026-10-15', kind: 'adjustment', amount: 50000, note: 'Phí chuyển khoản quốc tế' },
  { id: 't7', date: '2026-10-19', kind: 'transfer', amount: 5000000, note: 'Ứng trước lô ZP6' },
];
