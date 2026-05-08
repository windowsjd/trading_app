# Order Execution Preimplementation Readiness Audit

## 1. Implementation Readiness

Verdict:

- Current schema can support a market/limit full-fill MVP.
- Current schema can support wallet debit/credit, position mutation, one order ledger row, and order finalization in one transaction.
- Current schema cannot support exact execute response replay without overloading create `responsePayloadJson`.
- Order execution must remain unimplemented until the safety plan STOP conditions are accepted.

## 2. Schema Readiness

Ready fields and tables:

- `Order.status`: supports `submitted`, `executed`, `canceled`, `rejected`.
- `Order.executedPrice`, `grossAmount`, `feeAmount`, `netAmount`, `assetPriceSnapshotId`, `fxRateSnapshotId`, `executedAt`: enough to store full-fill execution values.
- `CashWallet.balanceAmount`: enough for order cash debit/credit.
- `WalletTransactionType.order_buy` and `WalletTransactionType.order_sell`: already present.
- `WalletTransactionReferenceType.order`: already present.
- `Position.quantity`, `averageCost`, `realizedPnl`, `currencyCode`: enough for buy/sell full-fill MVP.
- `SnapshotReason.order_executed`: exists if future equity snapshots are approved.

Not ready or intentionally limited:

- No order fill table.
- No partial fill status or remaining quantity field.
- No execute-specific idempotency command table.
- No execute-specific response payload field.
- No wallet ledger unique constraint on order reference.
- No explicit cancel reason; already accepted for cancel MVP.

Conclusion:

- Current schema is usable for full-fill MVP if duplicate executed orders return current-state response.
- Schema change is required only if exact execute replay, partial fills, separate fee ledger rows, or command lifecycle states are required.

## 3. Missing Schema Or Field Analysis

Not required for MVP:

- `order_execute_requests`.
- `order_fills`.
- `orders.executeResponsePayloadJson`.
- `orders.remainingQuantity`.
- fee ledger reference fields.

Potential future additions:

- `order_execute_requests` with `orderId`, `requestHash`, status, `responsePayloadJson`, and timestamps.
- `order_fills` if partial fills, multiple fills, or exchange-like audit rows are needed.
- unique wallet ledger constraint for `(referenceType, referenceId, txType)` if ledger duplicate prevention must be enforced at DB level.

MVP caution:

- Do not reuse `orders.responsePayloadJson` for execute replay because it currently means create response replay.

## 4. Current Code Reuse Possibility

Reusable from `OrdersService`:

- auth pattern based on `request.user.userId`.
- `parseCancelOrderId` style for path order id parsing.
- active season and participant helpers.
- asset usability checks.
- latest eligible `admin_manual` asset price snapshot selection.
- approved fresh `admin_manual` USD/KRW selection.
- Decimal parsing, formatting, and half-up rounding helpers.
- `formatOrder` response formatter.
- cancel guarded update pattern.

Reusable from `FxService`:

- Prisma transaction wrapper.
- guarded conditional wallet update.
- post-update wallet reread for `balanceAfter`.
- P2002/race classification pattern.
- no equity snapshot in near-term execute path.
- rollback-oriented integration test style.

Reusable from records/wallets/home/ranking:

- records orders section already reads executed fields.
- records wallet section already reads wallet transaction rows.
- wallets section reads updated cash wallet balances.
- portfolio valuation reads cash wallets and positions.
- ranking remains snapshot-driven and does not automatically update on execution.

## 5. FX Execute Pattern Reuse

Patterns to copy:

- Do pre-mutation validation before transaction writes.
- Put all financial writes in one transaction.
- Use guarded conditional source debit for cash safety.
- Read actual post-update wallet balance for ledger `balanceAfter`.
- Store durable transaction/order values instead of recomputing records from external state.
- Assert no `equity_snapshots` row is created in near-term execute.
- Include DB integration failure injection for rollback proof.

Patterns not directly reusable:

- FX execute has a dedicated `fx_execute_requests` command table.
- Order execute does not yet have an execute command table.
- FX creates two wallet transaction rows; order MVP should create one order ledger row.
- FX has currency conversion source/target wallets; order uses one cash wallet plus a position mutation.

## 6. Blockers Before Implementation

Blocker decisions:

- Exact limit execution policy:
  - whether limit execution must use latest market snapshot and crossing check.
  - whether executedPrice is selected snapshot price or limitPrice.
- Cost basis policy:
  - whether buy averageCost includes buy fee.
  - whether sell realizedPnl subtracts sell fee through netAmount.
- Duplicate executed response:
  - current-state response is acceptable for MVP, or execute response storage is required.
- Error taxonomy:
  - final code names and HTTP statuses.
- Transaction test matrix:
  - which DB failure points are mandatory in the implementation task.

Operational blockers:

- Successful local smoke requires real active season, joined participant, eligible asset price, eligible wallets/positions, and fresh approved USD/KRW snapshot for USD orders.
- Do not create fake/static/sample business data to unblock smoke.

## 7. Minimum MVP Scope That May Be Implemented Later

Allowed later, after explicit implementation approval:

- Add `POST /api/v1/orders/:orderId/execute` route.
- Execute only owned active-season `submitted` orders.
- Full-fill only.
- Market and limit orders using accepted price policy.
- Buy:
  - guarded cash wallet debit.
  - position create/update.
  - one order_buy wallet transaction.
  - guarded order finalization.
- Sell:
  - guarded position decrement.
  - realizedPnl update.
  - cash wallet credit.
  - one order_sell wallet transaction.
  - guarded order finalization.
- Already executed owned order returns current executed response without mutation.
- No equity snapshot, settlement, ranking, provider ingestion, scheduler, or partial fill.

## 8. Scope That Must Not Be Implemented In The MVP

- Partial fills.
- Matching engine.
- Provider ingestion.
- Durable quote reservation.
- Settlement.
- Scheduler/batch.
- Automatic daily portfolio snapshot generation.
- Automatic ranking generation.
- Equity snapshot creation from order execution.
- Separate fee wallet transaction row.
- New schema unless the implementation prompt explicitly approves it.
- Fake/static/sample business data.
- `x-user-id` fallback.

## 9. Next Implementation Prompt Recommendation

Recommended next prompt scope:

- Implement `POST /api/v1/orders/:orderId/execute` MVP only after accepting `docs/order-execution-safety-plan.md`.
- No schema change unless exact execute response replay is required.
- Include unit tests and DB integration tests in the same implementation task.
- Require DB integration proof for:
  - buy success.
  - sell success.
  - concurrent buy overspend.
  - concurrent sell oversell.
  - same order double execute.
  - cancel vs execute race.
  - rollback after wallet mutation.
  - rollback after position mutation.
  - rollback after wallet transaction creation.
  - rollback during finalization.
- Keep provider, settlement, scheduler, ranking automation, and equity snapshot creation out of scope.

## 10. Audit Summary

- Execution is feasible as a constrained full-fill MVP.
- Current schema is ready for execution state and core financial writes.
- Current schema is intentionally limited for exact replay and partial fill audit.
- FX execute provides the strongest transaction and rollback pattern.
- The next step should be an implementation gate review, not immediate code.
