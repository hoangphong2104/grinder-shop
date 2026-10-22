# Kho Cối — domain core

Pure TypeScript (money + stock rules), no runtime dependencies, no I/O. Source of truth:
`1.0-requirements/approved/data-and-rules-v1.md` (BR-01, 02, 04, 05, 06, 07, 09, 10, 11, 12).

Runs directly on Node ≥ 23.6 (built-in type stripping; erasable TS only, `.ts` import specifiers).

| File | Contents |
|---|---|
| `types.ts` | Lot, LotLine, Order, OrderLine, Payment, Transfer, Variant, statuses, `Result` / `RuleError` |
| `money.ts` | `unitCost` (BR-01), `lotPayable` (BR-12), `orderTotal` / `orderDue` / `completeOrder` (BR-10), `orderProfit` / `profitForMonth` (BR-11), `roundVnd`, `formatVnd`, `formatTr`, `formatCny` |
| `stock.ts` | `receiveLot` (BR-02, BR-04), `setLotShipFee`, `shipOrder` (BR-05, BR-09, Q-007), `averageAfterShipment` (Q-008), `decideNewOrderStatus` (BR-07), `replayHistory`, `computeInventory`, `sellableQty` (BR-06), `stockValue`, `incomingSummary` |
| `debt.ts` | `intermediaryDebt`, `intermediaryLedger` (BR-12) |
| `validate.ts` | Input checks (qty positive integer, whole-đồng amounts, rate > 0 …) |
| `index.ts` | Public re-exports |

Rule violations come back as `{ ok: false, error: { code, rule, message, … } }` — nothing throws for user
mistakes. Inputs are never mutated; guards return new objects.

## Test

```sh
cd 3.0-code/source-code
node --test 'src/domain/**/*.test.ts'   # or: cd src/domain && node --test
```

`*.test.ts` use `node:test` + `node:assert/strict`. `scenario.test.ts` replays the prototype mock history
(`prototype-history.fixture.ts`) and checks the hand-verified dashboard figures.

## Clarifications applied (spec §6, Q-006..Q-011)

- **Q-006** Rounding: half away from zero, once per formula (unit cost; Σ(qty × ¥) × rate). Σ unit costs may differ
  from the lot payable by a few đồng. The weighted average is kept unrounded; snapshots/display round to đồng.
- **Q-007** `shipOrder` accepts only `daChot`; a `datTruoc` order returns `INVALID_TRANSITION` (confirm it first).
- **Q-008** Cost snapshots are frozen. A shipped line keeps `line.cost`; `replayHistory` uses the stored cost when
  present (legacy lines without one get round(average) at that point). Editing a received lot's ship fee
  (`setLotShipFee`, then replay) changes only the average of the units still in stock:

  ```
  a = average before the shipment (unrounded, from current lot data), Q = on hand, q = shipped qty, c = frozen cost
  average after = a + q × (round(a) − c) ÷ (Q − q)        if Q − q > 0, else a
  ⇔ remaining value = (Q − q) × a + q × (round(a) − c)
  ```

  Why: the units left absorb the gap between what the shipped units would cost under the corrected lot data
  and the cost they were frozen at, so remaining value = value received at corrected costs − frozen costs
  shipped (up to < 1 đồng of rounding per unit). The gap is measured against round(a) — the snapshot a live
  shipment would take — so with unedited history the gap is 0 and the average is exactly unchanged (BR-05),
  and a replay reproduces the live state. Example: receive 2 @ 3.000.000, ship 1 (frozen 3.000.000), ship fee
  edited so unit cost = 3.200.000 → shipped line stays 3.000.000; remaining unit = 3.200.000 + 200.000 = 3.400.000
  (= 6.400.000 − 3.000.000). Limits: if nothing is left in stock the gap is not carried anywhere (profit of
  shipped orders stays frozen); a large fee decrease after most units are sold can make the remaining average
  low or even negative — it is not clamped, so the anomaly stays visible.
- **Q-009** Cancelled order: total = 0, due = −(net paid) ("Cần hoàn X") until a refund is recorded;
  `customersTotalDue` adds positive dues only.
- **Q-010** `completeOrder` needs confirmation when due ≠ 0 (underpaid or overpaid).
- **Q-011** `receiveLot` works from any open status; ship fee still required (BR-02).
- `dieuChinh` amount is signed: + increases the debt, − decreases it (as in the prototype).
