# Grinder Shop — domain core (CR-001: quản lý từng chiếc)

Pure TypeScript, no runtime dependencies, no I/O. The DB is the source of truth; these functions power form
previews and checks and must give the same numbers as the DB views (`v_units`, `v_model_stock`,
`v_lot_summary`, `v_order_summary`, `v_intermediary_balance`) built from the same CR.

Sources: `1.5-change-control/draft/CR_001_quan-ly-tung-chiec.md` (D1–D4, A1–A11, §3, §4) +
`1.0-requirements/approved/data-and-rules-v1.md` (rules still in force: BR-02, BR-03, BR-10..BR-14, §6).

Runs directly on Node ≥ 23.6 (built-in type stripping; erasable TS only, `.ts` import specifiers).
Status / kind codes are the **DB codes** (`ordered…cancelled`, `preorder…cancelled`, `deposit|payment|refund`,
`transfer|adjustment`, `customer|shop`); Vietnamese labels are in `*_LABEL` maps.

| File | Contents |
|---|---|
| `types.ts` | `Model`, `Lot`, `Unit`, `Order` / `OrderLine` (1 line = 1 unit), `Payment`, `Transfer`, status types, `UnitStatus`, labels, `Result` / `RuleError`; CR-004: `UnitCondition`, `PaymentMethod`, `AgingLevel` / `AgingThresholds`, `DEFAULT_AGING` (30/60), `DEFAULT_LOT_LATE_DAYS` (21), order status `returned` ("Hoàn hàng") |
| `money.ts` | `roundVnd` (Q-006), `formatVnd`, `formatTr`, `formatCny` |
| `cost.ts` | `autoUnitCost` (D2 + CR-003), `effectiveCost`, `isCostProvisional`, `unitCosts` / `effectiveCosts` (by unit id), `unitCostBeforeShip`, `lotUnitCount`, `unitsOfLot`, `lotGoodsCny` / `lotGoodsVnd`, `lotBuyingFeeVnd` / `buyingFeePctOf` (CR-003), `lotPayable` (A4 + CR-003) |
| `units.ts` | `formatUnitCode` (D1), `expandLotGroups` (A2), `unitStatus` / `holdingOrder` / `holderIndex` / `isReleasedOrder` / `unitStatusLabel` (A5, D4), `agingLevel` / `unitAgingLevel` / `lotDaysOpen` / `isLotLate` (CR-004), `daysBetween` / `unitDaysInStock`, `buildUnitViews` (≈ `v_units`), `modelStocks` / `modelStock` / `stockValue` (A9), `checkReceiveLot` (BR-02, Q-011), `checkCancelLot`, `checkLotEdit` (A10, Q-014) |
| `orders.ts` | `checkUnitAvailable`, `checkOrderUnits`, `orderStatusFor` (A6), `canShip` (A8, Q-007), `preordersToAutoConfirm` (A7), `checkCancelOrder`, `completeOrder` (BR-10, Q-010), `orderTotal` / `orderPaid` / `orderReceivable` / `orderRefundDue` / `customersTotalDue` / `totalRefundDue` (BR-10, Q-009, Q-015), `orderMargin` / `orderProfit` / `profitForMonth` / `profitByMonth` (BR-11 + A8); CR-004: `checkReturnOrder` / `returnOrder`, `orderDeposits`, `orderKept`, `returnedOrderProfit`, `orderProfitDate`, `orderCodReceived` / `orderCodPending` / `totalCodPending` |
| `debt.ts` | `intermediaryBalance` (≈ `v_intermediary_balance`), `intermediaryDebt`, `totalPayable`, `transferEffect` (BR-12) |
| `validate.ts` | Field checks: `validateModel`, `validateLot`, `validateLotGroup`, `validateUnit`, `validateOrder`, `validatePayment`, `validateTransfer` |
| `index.ts` | Public re-exports |

Rule violations come back as `{ ok: false, error: { code, rule, message, … } }`; nothing throws for user
mistakes. Programming / data errors throw: a unit whose lot is missing, an order line without a cost,
a code sequence < 1. Inputs are never mutated.

## Formulas

```
giá nhập ₫ tự tính  = round(giá ¥ × tỷ giá × (1 + phí mua hộ %/100) + (phí ship lô ?? 0) ÷ số chiếc của lô)   D2, CR-003
giá nhập ₫ hiệu lực = giá sửa tay ?? giá tự tính                                          D2, CR §3
phải trả lô          = round(Σ giá ¥ × tỷ giá × (1 + phí mua hộ %/100) + phí ship lô); lô huỷ = 0   A4 (BR-12), CR-003
tiền hàng lô         = round(Σ giá ¥ × tỷ giá) — chưa gồm phí; phí mua hộ lô = round(Σ giá ¥ × tỷ giá × %/100)   CR-003
trạng thái chiếc     = lô huỷ → cancelled · đơn Đã gửi/Hoàn tất → sold · đơn Đặt trước/Đã chốt → reserved
                       · lô đã nhận → in_stock · còn lại → incoming                       A5
có thể bán (model)   = in_stock + incoming (both already exclude reserved); sắp hết ⇔ ≤ ngưỡng   A9
giá trị tồn          = Σ giá nhập ₫ hiệu lực of received, not-sold units (reserved included)
còn phải thu         = Σ giá chốt + ship khách trả − Σ đã thu; đơn huỷ → 0                BR-10, Q-009
cần hoàn (đơn huỷ)   = max(0, đã thu ròng)                                                 Q-009
lãi đơn              = Σ(giá chốt − giá nhập ₫ hiệu lực HIỆN TẠI) − ship shop chịu; chỉ Đã gửi/Hoàn tất   BR-11, A8, Q-015
còn nợ trung gian    = Σ phải trả − Σ đã chuyển + Σ điều chỉnh (có dấu)                   BR-12
--- CR-004 ---
đơn Hoàn hàng        = chỉ từ Đã gửi; nhả chiếc (về Trong kho, bán lại được); còn phải thu 0
cần hoàn (hoàn hàng) = max(0, đã thu ròng − (giữ cọc ? Σ cọc : 0)); tiền giữ = đã thu ròng − cần hoàn
lãi đơn hoàn hàng    = tiền giữ − ship đi (shop chịu) − ship chiều về; tính vào tháng ngày hoàn
COD chờ về           = max(min(COD − Σ thu method 'cod', còn phải thu), 0); chỉ Đã gửi / Hoàn tất / Hoàn hàng
tuổi tồn             = chiếc đã về kho chưa bán: > 60 alert, > 30 warn, còn lại ok (ngưỡng trong Cài đặt)
lô về trễ            = lô chưa nhận / chưa huỷ, hôm nay − ngày đặt > 21 (Cài đặt)
```

The ship fee is divided by **all** units of the lot (every model, sold or not). Costs are never frozen:
correcting a lot's ship fee / rate / ¥ moves the cost — and the profit of already-sold orders — of every
unit without a hand-entered cost (A3). CR worked example: 2 × ¥1.010, rate 3.600, ship 600.000 → each
3.936.000, payable 7.872.000; override one to 4.000.000 → payable unchanged; ship → 800.000 → the other unit
4.036.000, the overridden one stays 4.000.000. CR-003 example (phí mua hộ 3%): each round(1010 × 3600 × 1,03 +
300.000) = 4.045.080, payable round(2020 × 3600 × 1,03 + 600.000) = 8.090.160. `Lot.buyingFeePct` missing = 0 ⇒
the pre-CR-003 numbers exactly; the fee is locked once the lot is received (`checkLotEdit`, like the rate).

## Rules replaced by CR-001 (no longer implemented)

| Old | Now |
|---|---|
| BR-01 cost per lot line | D2 per-unit auto cost (+ override) — `autoUnitCost`, `effectiveCost` |
| BR-04 weighted average, BR-05 cost snapshot on shipment, Q-008 / Q-008b | **Removed** — per-unit cost, profit uses current cost (A3, A8) |
| BR-06 stock per variant, DO_012 | A5 unit status + A9 counts per model — `unitStatus`, `modelStocks` |
| BR-07 new-order status from quantities | A6 — `checkOrderUnits`, `orderStatusFor` |
| BR-08 notify pre-orders + Q-013 manual pick | A7 auto-confirm — `preordersToAutoConfirm` |
| BR-09 on hand ≥ qty to ship | A8 — `canShip` |
| Q-003 colour variants, Q-016 | A1 (no variants), A9 |

Kept: BR-02, BR-03, BR-10, BR-11 (with A8 cost), BR-12 (A4), Q-006, Q-007, Q-009, Q-010, Q-011, Q-014 (A10), Q-015.

## Rounding (Q-006)

Half away from zero, once per formula (`roundVnd` pre-rounds to 6 decimals to absorb binary float noise).
Σ of unit costs may differ from the lot payable by a few đồng. Parity with Postgres `round(numeric)` holds for
the DB scales (¥ and rate with ≤ 2 decimals, a few hundred units per lot at most).

## Test

```sh
cd 3.0-code/source-code
node --test 'src/domain/**/*.test.ts'   # or: cd src/domain && node --test
```

`*.test.ts` use `node:test` + `node:assert/strict`. `scenario.test.ts` runs over `shop.fixture.ts` (3 models,
7 lots incl. a mixed-model and a cancelled lot, 15 units, 8 orders incl. pre-orders and a cancelled order with a
partial refund) with hand-computed totals (arithmetic in the comments).
