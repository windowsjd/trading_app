# Execution Realism System (B1 / B2-1)

ERS is a liquidity assessment layer intended to reduce the gap between a
simulated fill and observed market liquidity.
`assessExecutionRealism` is a deterministic, Provider-independent pure policy:
normalized market evidence + a hypothetical quantity or BUY amount intent → an assessment.
B1 remains pure assessment. B2-1 adds one-shot market settlement through an
optional, internally injected execution-evidence adapter. No adapter is registered
in OrdersModule: production ERS activation awaits B2-2 provider work.

## Contracts and policy ownership

The input contract in `src/orders/execution-realism.types.ts` is separate from
the display-only `AssetOrderBook`. ERS does not import that model, its parser,
`MarketPriceEvent`, or a Provider payload. Future adapters may normalize the
same underlying feed into separate display and execution contracts, but a UI
snapshot or its freshness timer is never execution authorization.

- `source-eligibility.policy.ts` owns Provider eligibility, source priority and
  workflow freshness; market-calendar/market-hours own sessions.
- `realtime-execution-policy.ts` and durable quotes own quote TTL and
  quote-to-execute price-change protection. The existing 30bps guard is not an
  ERS slippage threshold.
- The caller supplies `validation.state` for the **exact execution evidence**,
  checked at `validation.checkedAt`: `usable`, `stale`, `ineligible`, or
  `unchecked`. `usable` means the applicable existing source/session/freshness
  gates passed at that instant. A valid last-price snapshot does not authorize
  an unrelated depth snapshot. ERS propagates this verdict, never calculates a
  second freshness threshold or selects a Provider. B1 adds no adapter that
  can issue this verdict. An assessment must not be reused as authorization
  at a later execution time; B2 must revalidate under the execution locks.
- Existing order transactions remain the source of truth for wallet, position,
  ledger, P&L, ranking and settlement.

## Evidence and order meaning

Order and evidence both carry `assetId`, `priceCurrency`, and `quantityUnit`.
They must match exactly; adapters must normalize units and any currency mapping
explicitly. There is no implicit USD/USDT conversion, contract multiplier, or
lot-to-share conversion in ERS. Prices mean priceCurrency per quantityUnit.
The quantity branch is already-resolved hypothetical quantity. B2-1 adds a
mutually exclusive BUY amount branch (maximum principal excluding fees),
using the same validated levels and walker. An optional `limitPrice`
caps the hypothetical buy prices or floors the sell prices, without changing
the production matcher or its marketability policy.

Evidence kinds:

| Kind | Price reference | Observable quantity |
| --- | --- | --- |
| `l2` | Best ask for buy, best bid for sell | Consume only supplied levels, in price priority, within the optional limit |
| `top_of_book` | Ask for buy, bid for sell | At most the selected side's supplied size; absent size means unknown |
| `price_only` | Supplied reference price, explicitly not bid/ask | Unknown; an optional interval volume is historical traded quantity, never executable depth |
| Missing evidence | None | Unknown |

L2 arrays describe one complete **observed** snapshot, possibly truncated. Empty
arrays mean zero liquidity observed on that side, not proof that the whole
market has no liquidity. An absent top-of-book side means missing data.
Adapters must not label missing/unsynchronized book data as an empty valid
snapshot. Zero-size display levels must not be forwarded as execution levels;
ERS requires positive quantities and rejects the whole corrupt snapshot.
Prices must be unique within each side; a crossed book is invalid. Input level
order is irrelevant: ERS sorts a copy, asks ascending and bids descending.

`capturedAt` is receipt time, `effectiveAt` is market event time or null when
unavailable, and `checkedAt` is the externally supplied validation instant.
All are valid Dates with effectiveAt ≤ capturedAt ≤ checkedAt when present.
Volume carries its own `[from, to)` interval ending at/before capturedAt.
Malformed times, decimals, identity/units, levels or crossed books are invalid;
ERS never repairs them to zero or falls back to another evidence kind.

## Assessment meaning and arithmetic

The result identifies the hypothetical order, evidence kind and UTC ISO
timestamps, reference price/basis, observed fillable quantity, rounded `observedGrossAmount`, amount-only
`unspentAmount`, weighted `simulatedFillPrice`, `adversePriceImpactBps`, and consumed level count.

| State | Meaning |
| --- | --- |
| `full_observed_fill` | Supplied evidence covers the requested quantity within the limit |
| `partial_observed_fill` | Only a positive subset is observable; the reason distinguishes depth/size exhaustion from a limit boundary |
| `no_observed_fill` | Valid evidence yields zero observable quantity (empty side or price outside limit) |
| `unassessable` | Missing data/size/side/model, stale/ineligible/unchecked evidence, or invalid input |

`observedFillableQuantity = null` means unknown, distinct from observed zero.
A price-only reference or a quote without size can be known while fill quantity,
simulated price and impact remain null. Non-usable evidence exposes no usable
price or fill proposal. `reason` and `invalidField` describe limitations; none
is an order reject instruction or a partial-fill persistence decision.

Financial inputs are decimal strings fitting the canonical Decimal(24,8)
range/scale, consistent with stored price and quantity evidence. ERS uses a
local Prisma Decimal clone with precision 50 (the existing order-input pattern),
so two 24-digit factors and accumulated consumed notional retain precision
without changing global Decimal settings. Only final outputs use the existing
scale-8 ROUND_HALF_UP formatter. No JS number price/quantity arithmetic occurs.

Weighted price = Σ(consumed price × consumed quantity) / observed fillable
quantity. Partial assessments divide by the **observed** quantity, never the
requested quantity. Impact is computed from the unrounded weighted price:
buy `(weighted − reference) / reference × 10000`, sell
`(reference − weighted) / reference × 10000`. Positive values mean adverse
movement. There is no acceptance threshold; this is different from an absolute
quote-to-execute change. No fill means no weighted price or impact.

For asks `100 × 100`, `101 × 100`, `102 × 50`, a buy of 250 returns
250 observable units, weighted price `100.80000000`, three levels consumed,
and impact `80.00000000` bps. With only `100 × 100`, `101 × 50`, it returns
150 units and a partial assessment; it invents no remaining 100 units.

## Execution integration boundary

Market quote/create and legacy execute share `OrdersService` execution planning.
`resolveProviderExecutionPrice` currently selects a fresh eligible snapshot,
and rounds its price. The shared planner applies the durable quote change
guard to the final snapshot price or ERS VWAP.
`buildOrderExecutionPlan` uses that price for quantity, gross/fee/net amounts;
`executeBuyOrderInTransaction` / `executeSellOrderInTransaction` then consume the
quote and mutate cash/positions/ledger before order finalization. Market create
executes in the same transaction rather than leaving a pending market order.

The narrow market seam for B2 is **inside `buildOrderExecutionPlan`, after
applicable source/session/quote gates and before final quantity/amount
calculation and either mutation function**. A future adapter must obtain and
validate actual execution evidence. Both quantity and principal intents use
the one-shot policy below. The existing quote-change
guard must also protect the final proposed execution price; passing it for a
snapshot reference alone does not authorize a different weighted fill price.
This does not turn that guard into an ERS impact threshold. B2-1 calls ERS
there only when an internal evidence adapter is explicitly injected.

Limit `LimitOrderMatchingService.buildFillPlan` selects Path A's snapshot price
or Path B's order limitPrice with an eligible closed 5m candle. The narrow safe
limit seam is **inside `LimitOrderExecutionService.fillLimitOrder`, after locked
order/authorization/time/evidence and limit revalidation, before step 5 amount
calculation and step 7/9 financial settlement**. A matcher cycle result alone
cannot authorize liquidity. Path B candle touch is not contemporaneous depth;
its future liquidity model and historical evidence rules need a separate
decision. B1 changes neither Path A nor Path B.

Provider integrations (including live crypto depth and stock quote feeds),
minimum data quality, stock liquidity/participation models and precise
slippage calibration remain future
work after Provider capabilities and asset universe are confirmed. No fake
spread, depth, volume, fixed slippage percentage or participation threshold is
defined. Production activation awaits B2-2 adapters; B2-1 tests the real
financial transaction using generic injected evidence.


## B2-1 one-shot market contract

Market orders may consume only independently observed depth (asks ascending for
BUY, bids descending for SELL), or the selected top-of-book size. A positive
partial fill is terminal: the remainder is canceled in the same transaction.
There is no shared virtual liquidity, next-tick fill, Fill table, queue, or
price/volume/fake-depth fallback. Limit orders remain full-fill-only.

Order.status stays `executed` (one order with an actual fill, counted once).
For ERS quantity orders, Order.quantity preserves requested quantity;
executedQuantity and canceledQuantity record the actual result. Amount BUY keeps
its existing resolved quantity meaning and additionally stores requestedAmount
and unspentAmount. Nullable new columns leave historical orders unchanged.
`cancelReason=insufficient_market_liquidity` and canceledAt identify automatic
remainder cancellation, distinct from a user cancellation. API `marketExecution`
is an additive, server-authoritative full/partial result; it is absent on old
rows and on the unchanged snapshot execution path. Monetary result columns
always contain actual gross/fee/net, and executedPrice is consumed-depth VWAP.

Crypto BUY amount is maximum principal excluding fees. The same walker solves
affordable quantity from asks, floors the aggregate quantity to the existing
6-place execution precision, then values that quantity on the consumed levels.
Gross is the rounded consumed notional, not rounded VWAP multiplied back into
quantity. Unspent principal includes precision dust; a budget-limited full fill
can have dust without being a liquidity partial fill. If round8 consumed
notional exactly uses the budget, the terminal product result is full even
when the continuous assessment reports a tiny depth shortage. Fees use actual
gross. Quantity intents retain their scale-6 input precision; only aggregate
executable quantity is floored, never each individual observed level.

The optional MarketExecutionEvidenceAdapter is a trusted server composition
boundary, never a request field or an environment activation switch. It reads
an immutable normalized local snapshot and revalidates source eligibility,
session and freshness for that exact snapshot at post-lock execution time.
It must perform no network I/O under database locks. Identity/currency/unit and
structural validation run in ERS. Caller-supplied B1 `validation=usable` is not
accepted as authorization by this seam. Provider-specific adapters, policies
and production registration require B2-2 review. Missing/invalid evidence on an
injected adapter fails closed; it never returns to the legacy price path.

The final VWAP must pass the existing durable-quote maxChangeBps guard (30bps),
independently of ERS adversePriceImpactBps. Existing FX, fee pinning, scope,
wallet reservations, position/P&L, valuation and post-commit ranking remain
shared. Response persistence, actual settlement and remainder cancellation
commit or roll back together. Committed create replay precedes evaluation.

Public-safe evidence kind/source/times and assessment provenance are persisted
without raw payloads or transport details. Zero observed liquidity returns
409 ORDER_LIQUIDITY_UNAVAILABLE; unassessable evidence returns
503 EXECUTION_EVIDENCE_UNAVAILABLE, both with no financial writes.

Result sheet: “일부 체결되었습니다”; quantity intent, actual quantity, canceled
quantity, VWAP and actual amounts are disclosed. Amount BUY instead discloses
requested principal and unused principal. History shows
“부분체결 · 잔량 자동취소”. No new notification infrastructure is introduced.
