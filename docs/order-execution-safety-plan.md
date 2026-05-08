# Order Execution Safety Plan

## 1. Goal And Non-Goal

Goal:

- Define the safety design for future `POST /api/v1/orders/:orderId/execute`.
- Limit the first implementation to full-fill execution of existing owned `submitted` orders.
- Prevent duplicate execution, cancel/execute races, concurrent buy overspend, concurrent sell oversell, and partial financial writes.
- Implementation note: the full-fill MVP route/write path has now been implemented according to this plan. Future expansions still require a separate plan.

Non-goal:

- Do not implement additional schema, migration, seed, provider ingestion, scheduler, settlement, or feature expansion from this document.
- Do not implement partial fills, a matching engine, durable quotes, provider price ingestion, automatic daily ranking, or settlement.

## 2. Current Implementation State

- `GET /api/v1/orders` reads real `orders` rows.
- `POST /api/v1/orders/quote` is read-only and performs current resource checks.
- `POST /api/v1/orders` creates one submitted order row and stores create idempotency fields.
- `POST /api/v1/orders/:orderId/cancel` can change an owned submitted order to canceled with a guarded update.
- Order execution full-fill MVP is implemented.
- Order wallet debit/credit, one order wallet transaction, position mutation, and guarded order finalization are implemented for the MVP.
- Order equity snapshots, settlement, provider ingestion, scheduler/batch, matching engine, and partial fills are not implemented.
- `/fx execute` has the most relevant local pattern: one transaction, guarded wallet updates, durable idempotency, stored response replay, rollback tests, and no equity snapshot in the near-term execute path.

## 3. Execution State Transition Policy

- Only `status = submitted` is executable.
- `status = canceled` returns `ORDER_NOT_EXECUTABLE`.
- `status = rejected` returns `ORDER_NOT_EXECUTABLE`.
- `status = executed` is treated as an idempotent duplicate of the same order command:
  - MVP recommendation: return the current executed order response without new mutation.
  - Exact original response replay is not available without a new execute response payload field or command table.
- Order finalization must be a guarded update:
  - `id = orderId`
  - `seasonParticipantId = authenticated participant id`
  - `status = submitted`
- If finalization affects zero rows after wallet or position work inside the transaction, throw `ORDER_EXECUTION_CONFLICT` and roll back the entire transaction.
- Cancel and execute race:
  - cancel uses `status = submitted -> canceled`.
  - execute uses `status = submitted -> executed`.
  - exactly one terminal transition may commit.

## 4. Buy Execution Write Path

Run all write steps in one Prisma transaction.

1. Validate `request.user.userId`.
2. Parse and trim `orderId`.
3. Load the owned order with season, participant, asset, and order fields.
4. Require active season and joined participant.
5. If status is executed, return duplicate/current-state response with no writes.
6. Require `status = submitted`.
7. Re-resolve execution price at `executedAt`.
8. Calculate `grossAmount`, `feeAmount`, and `netAmount`.
9. Load the cash wallet for `order.currencyCode`.
10. Guarded conditional cash wallet debit:
    - wallet id matches participant and currency.
    - `balanceAmount >= netAmount`.
    - decrement by `netAmount`.
11. Read post-debit wallet balance.
12. Upsert or update position:
    - if missing, create position.
    - if present, increase quantity and recalculate weighted average cost.
13. Create one `wallet_transactions` row:
    - `direction = debit`
    - `txType = order_buy`
    - `referenceType = order`
    - `referenceId = orderId`
    - `amount = netAmount`
    - `balanceAfter = actual post-debit wallet balance`
14. Guarded order finalization to `executed`.
15. Return response built from committed order and ledger data.

## 5. Sell Execution Write Path

Run all write steps in one Prisma transaction.

1. Validate `request.user.userId`.
2. Parse and trim `orderId`.
3. Load the owned order with season, participant, asset, and order fields.
4. Require active season and joined participant.
5. If status is executed, return duplicate/current-state response with no writes.
6. Require `status = submitted`.
7. Re-resolve execution price at `executedAt`.
8. Calculate `grossAmount`, `feeAmount`, and `netAmount`.
9. Load the position for participant and asset.
10. Guarded conditional position decrement:
    - position id matches participant and asset.
    - `quantity >= order.quantity`.
    - decrement by order quantity.
11. Update realized PnL and preserve the position row even when quantity becomes zero.
12. Guarded cash wallet credit for `order.currencyCode`.
13. Read post-credit wallet balance.
14. Create one `wallet_transactions` row:
    - `direction = credit`
    - `txType = order_sell`
    - `referenceType = order`
    - `referenceId = orderId`
    - `amount = netAmount`
    - `balanceAfter = actual post-credit wallet balance`
15. Guarded order finalization to `executed`.
16. Return response built from committed order and ledger data.

## 6. Price Selection Policy

- Submitted order gross/fee/net values are estimates only.
- Execution recalculates actual values at execution time.
- Market orders:
  - select latest eligible `admin_manual` `asset_price_snapshots` row.
  - conditions: same asset, same currency, positive price, `effectiveAt <= executedAt`.
  - order by `effectiveAt desc`, `capturedAt desc`, `createdAt desc`.
- Limit orders:
  - still select latest eligible `admin_manual` asset price snapshot at execution time.
  - buy is executable only when selected price `<= limitPrice`.
  - sell is executable only when selected price `>= limitPrice`.
  - actual `executedPrice` is the selected snapshot price, not the submitted estimate.
- No asset price stale threshold exists yet. If a stale threshold is introduced, it must be documented before implementation.
- USD orders:
  - use USD wallet for cash debit/credit.
  - select approved fresh `admin_manual` USD/KRW snapshot for audit consistency and `fxRateSnapshotId`.
  - USD/KRW freshness follows the existing 60 second rule.
  - FX does not change wallet debit/credit amount for USD orders.

## 7. Fee, Rounding, And Scale Policy

- Reuse `Prisma.Decimal`; do not use JS number for money, quantity, fee, wallet, position, ranking, or settlement calculations.
- Reuse existing decimal helpers where practical:
  - monetary scale: 8.
  - fee rate scale: 6.
  - half-up rounding.
- Buy:
  - `grossAmount = quantity * executedPrice`.
  - `feeAmount = grossAmount * tradeFeeRate`.
  - `netAmount = grossAmount + feeAmount`.
  - cash wallet debit amount is `netAmount`.
- Sell:
  - `grossAmount = quantity * executedPrice`.
  - `feeAmount = grossAmount * tradeFeeRate`.
  - `netAmount = grossAmount - feeAmount`.
  - cash wallet credit amount is `netAmount`.
- If fee policy changes to separate fee ledger rows, this plan must be reopened.

## 8. Wallet Debit/Credit Policy

- Domestic/KRW assets use KRW wallet.
- US stock/USD assets use USD wallet.
- Missing cash wallet is a data integrity conflict:
  - buy: `ORDER_CASH_WALLET_NOT_FOUND`.
  - sell credit: `ORDER_CASH_WALLET_NOT_FOUND`.
- Buy debit must use conditional `updateMany` with `balanceAmount >= netAmount`.
- Sell credit may use guarded `updateMany` by wallet id, participant id, and currency.
- `wallet_transactions.balanceAfter` must come from the actual post-update wallet row.

## 9. Position Mutation Policy

- Buy create:
  - create position with quantity equal order quantity.
  - average cost policy: use buy `netAmount / quantity` so buy fees are included in cost basis.
  - realizedPnl starts at zero.
- Buy update:
  - new quantity = old quantity + buy quantity.
  - new average cost = `(old averageCost * oldQuantity + buy netAmount) / newQuantity`.
  - realizedPnl unchanged.
- Sell:
  - require existing position.
  - require quantity sufficient using guarded conditional decrement.
  - realizedPnl delta = `sell netAmount - old averageCost * sellQuantity`.
  - new realizedPnl = old realizedPnl + delta.
  - if remaining quantity is zero, keep the row and preserve averageCost/realizedPnl.
- Position currency must match asset/order currency.

## 10. Wallet Transactions Ledger Policy

- MVP creates exactly one order ledger row per successful order execution.
- Buy ledger:
  - debit, `order_buy`, `referenceType = order`, `referenceId = orderId`, amount `netAmount`.
- Sell ledger:
  - credit, `order_sell`, `referenceType = order`, `referenceId = orderId`, amount `netAmount`.
- No separate fee wallet transaction row in MVP.
- Rationale: `/fx execute` MVP also does not create a separate fee wallet transaction row; fee is represented in stored transaction/order values.
- If future accounting requires separate fee rows, add an explicit policy and tests before implementation.

## 11. Idempotency And Duplicate Execute Policy

- Create idempotency and execute idempotency are separate.
- `orders.idempotencyKey`, `requestHash`, and `responsePayloadJson` belong to create replay and must not be reused for execute response replay.
- MVP recommendation:
  - no extra execute `idempotencyKey`.
  - `orderId` is the command identity.
  - `submitted -> executed` guarded finalization prevents duplicate execution.
  - already executed owned order returns current executed order response without mutation.
- Limitation:
  - exact original execute response replay is not possible in current schema.
  - if exact replay is required, add an `order_execute_requests` table or execute-specific response payload field in a separate schema task.

## 12. Transaction And Rollback Policy

- All financial writes must be in one transaction:
  - cash wallet mutation.
  - position mutation.
  - wallet transaction creation.
  - order finalization.
- No partial write may commit.
- Any failure after wallet debit/credit or position mutation must roll back all earlier writes.
- Do not create `equity_snapshots` in the execution MVP.
- Do not update daily portfolio snapshots or season rankings in the execution MVP.
- The future implementation must include DB integration rollback tests before being considered complete.

## 13. Concurrency And Race Policy

- Buy overspend:
  - prevented by guarded wallet debit with `balanceAmount >= netAmount`.
  - on zero affected rows, reread wallet to distinguish insufficient cash from concurrent wallet update.
- Sell oversell:
  - prevented by guarded position decrement with `quantity >= sellQuantity`.
  - on zero affected rows, reread position to distinguish insufficient position from concurrent position update.
- Same order double execute:
  - prevented by guarded order finalization `status = submitted`.
  - losing transaction must roll back all wallet/position/ledger changes.
- Cancel vs execute:
  - both transitions guard on `status = submitted`.
  - only one terminal state commits.
- Cross-feature wallet concurrency:
  - FX execute and order buy both mutate cash wallets.
  - order buy must use the same guarded conditional wallet safety pattern as FX execute.

## 14. Response Shape Draft

Draft success response:

```json
{
  "success": true,
  "data": {
    "order": "<GET /api/v1/orders order item with status=executed>",
    "execution": {
      "state": "executed",
      "executedAt": "<UTC ISO string>",
      "priceSource": "admin_manual",
      "assetPriceSnapshotId": "<string | null>",
      "fxRateSnapshotId": "<string | null>",
      "walletTransactionId": "<string>",
      "walletBalanceAfter": "<amount string>",
      "positionId": "<string | null>",
      "duplicate": false
    }
  }
}
```

Draft duplicate executed response:

```json
{
  "success": true,
  "data": {
    "order": "<current executed order item>",
    "execution": {
      "state": "already_executed",
      "duplicate": true
    }
  }
}
```

## 15. Error Code Draft

- `UNAUTHORIZED`
- `INVALID_ORDER_ID`
- `ORDER_NOT_FOUND`
- `ORDER_NOT_EXECUTABLE`
- `ORDER_ALREADY_CANCELED`
- `ORDER_EXECUTION_CONFLICT`
- `ORDER_PRICE_UNAVAILABLE`
- `ORDER_LIMIT_NOT_MARKETABLE`
- `FX_RATE_UNAVAILABLE`
- `FX_RATE_STALE`
- `ORDER_CASH_WALLET_NOT_FOUND`
- `ORDER_POSITION_NOT_FOUND`
- `INSUFFICIENT_CASH_BALANCE`
- `INSUFFICIENT_POSITION_QUANTITY`
- `CONCURRENT_WALLET_UPDATE`
- `CONCURRENT_POSITION_UPDATE`
- `ORDER_EXECUTION_TRANSACTION_FAILED`

Error names should be finalized in the implementation prompt before code changes.

## 16. Test Matrix

Unit test candidates:

- buy success.
- sell success.
- missing auth.
- invalid orderId.
- order not found or not owned.
- non-submitted order reject.
- canceled order reject.
- rejected order reject.
- executed duplicate current-state response.
- market price missing.
- limit buy not marketable.
- limit sell not marketable.
- FX missing/stale for USD orders.
- insufficient cash.
- insufficient position.
- buy position create.
- buy position weighted average update.
- sell position decrement.
- sell realizedPnl calculation.
- wallet transaction balanceAfter correctness.
- order finalization correctness.
- no equity snapshot in MVP.
- cancel/execute race guarded update conflict.
- order double execution race.

DB integration candidates:

- buy execution one transaction success.
- sell execution one transaction success.
- concurrent buy overspend prevention.
- concurrent sell oversell prevention.
- same order concurrent execute one success only.
- cancel vs execute race one terminal state only.
- failure after wallet debit rolls back.
- failure after position mutation rolls back.
- failure after walletTransaction create rolls back.
- failure during finalization rolls back.
- executed order visible in GET orders and records.
- wallet transaction visible in records.
- wallet balance visible in wallets.
- home live valuation reflects changed wallet and position if eligible price/FX data exists.

## 17. STOP Conditions

The full-fill MVP implementation accepted these conditions for the current scope:

- Final price selection policy for market and limit orders.
- Final position cost basis and realizedPnl policy.
- Final execute duplicate response policy.
- Decision that current schema replay limitation is acceptable for MVP, or approval for a new execute command table/field.
- Error code names and HTTP statuses.
- Rollback and concurrency DB integration test scope.
- Confirmation that execution MVP does not create `equity_snapshots`, daily snapshots, rankings, settlement rows, provider ingestion, or scheduler jobs.

Still STOP for future scope:

- Partial fills.
- Matching engine.
- Exact execute response replay.
- Separate fee wallet transaction rows.
- Settlement.
- Provider/scheduler execution.
- Automatic daily portfolio snapshots or rankings from execution.
