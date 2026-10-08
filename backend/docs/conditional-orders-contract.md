# Conditional Orders v1

Current contract: server capability defaults OFF; production activation is a separate operation. API remains `/api/v1`.

## Intent and boundaries

One account-scoped protection group protects the entire remaining Spot position or one Futures position lifetime. It contains Stop Loss, Take Profit, or both. Each leg has a trigger and a Market or Limit exit intent. [Futures Limit Entry v1](futures-limit-entry-contract.md) supplies a parent entry without adding a second Conditional engine. There is no trailing stop, quantity ladder, or general condition framework.

Spot triggers use the existing eligible market evidence/session policy. Futures triggers and user exits use canonical Binance **Spot** last trade; Mark remains the risk/liquidation source. Registration requires fresh evidence and strictly untriggered prices (long SL below / TP above; short reversed). Unavailable evidence defers evaluation without canceling protection.

## OCO and quantity

A trigger records durable price/source/time evidence. It does not cancel its sibling. At most one pending child exists per group. An opposite trigger atomically cancels the previous unfilled child, releases its reservation, and creates the replacement; the old leg becomes armed again. Only actual full exit completes protection.

Armed legs reserve no quantity. A submitted Spot Limit child uses the existing Order quantity reservation once. Registration rejects competing normal sell reservations. Manual Market reductions cancel the pending child before execution and re-arm protection for any remainder; full close completes it. Increases conflicting with a pending child are rejected. Normal sell Limit registration conflicts with active protection. Futures children are lifetime-bound and reduce-only. ERS Market partial fills retain protection for the actual remainder.

Attached protection is an additive option on Spot BUY Limit creation. v1 requires a flat position and no competing pending BUY or protection. It is HOLDING until parent fill, then ACTIVE; parent cancellation or lifecycle cleanup cancels it. Ordinary stock Limit entry/sell requests retain their integer-quantity rule. A worker-only Position-bound Conditional sell may reserve the exact fractional remainder through the same Limit settlement core, so a manual fractional Market reduction does not leave protection stranded. This capability is never parsed from HTTP and cannot open/increase a position.

Futures Limit parents accept the same legs and expose `parentFuturesOrderId`.
Registration validates against the entry limit (Long SL < limit < TP, Short
TP < limit < SL), because a pending entry has no position or entry fill yet.
HOLDING cannot trigger; the parent fill binds its new lifetime and activates the
group atomically. Gap fills preserve the user's thresholds. A triggered but
unfilled Limit child remains pending when execution returns
`CONDITIONAL_LIMIT_NOT_REACHED`; that result does not complete OCO.

## Transactions and lifecycle

Existing user execution, fee, PnL, ledger, performance, and fill-count cores are reused. Trigger and pending intent may commit before a Market execution attempt; unavailable execution leaves the intent retryable. Fill and protection reconciliation commit together. Existing submitted Order locks precede reservation-owner Position locks. Financial actions retain Season → Account → Participant authorization fencing and current DB-clock rechecks.

Season end/exclusion cleans pending children and attachments through existing reservation cleanup before final settlement. Futures liquidation/final settlement terminates protection in its closing transaction. Idempotent user commands and child uniqueness are durable PostgreSQL state. Bounded polling uses OpsJobLock; no provider network call occurs under financial locks.

Conditional enablement is server-authoritative and separate from production activation. Futures exits run in ENABLED and REDUCE_ONLY, pause in DISABLED; liquidation remains independent. Read/cancel remain available to release existing protection. Production activation is a separate operational step after all regression gates.

## API and evidence

All paths have the existing `/api/v1` base and require the owning authenticated user:

| Method | Account-scoped path | Meaning |
| --- | --- | --- |
| GET | `/trading-accounts/:accountId/protections` | Current groups; `history=true` includes terminal groups |
| POST | `/trading-accounts/:accountId/protections` | Create protection on an open Position |
| POST | `/trading-accounts/:accountId/protections/:groupId/cancel` | Cancel protection and release its active child reservation |

Create accepts `domain: spot|futures`, `assetId`, `positionId`, `idempotencyKey`,
and `legs` (one or two). Each leg has `kind: stop_loss|take_profit`, string
`triggerPrice`, `childOrderType: market|limit`, and string `childLimitPrice` only
for Limit. Prices are positive Decimal(24,8). Cancel accepts `idempotencyKey`.
The existing Spot BUY Limit create accepts additive `attachedProtection: legs`;
the durable create hash includes attachments only when present. Quote keeps its
existing contract; create validates attachment reference/direction again under
its financial fence. Legacy creates without attachments keep their existing hash.

GET filters `domain`, `assetId`, `history`; default limit 30, max 100, offset up to
100000. Each returned group includes up to 20 latest child attempts with copied
trigger evidence and linked Order/FuturesExecution IDs. Financial amounts are
strings. Active remaining quantity comes from the live position; terminal groups
do not borrow quantities from a later Spot holding. Reads never repair state.

The durable tables are `protection_groups`, `protection_legs`,
`protection_children`, and `protection_commands`. Partial unique indexes enforce
one live group per account/product/asset and one pending child per group. A
composite leg/group FK prevents cross-group child linkage. Each trigger keeps a
Spot snapshot FK and price/source/currency/effectiveAt/capturedAt/asset/symbol/
position/kind/threshold copy; Mark snapshots are not linked or consulted here.
The existing actual Order/FuturesExecution and ledger remain settlement evidence.

Typed conflicts include `PROTECTION_CONFLICT`, `PROTECTION_CHILD_PENDING`,
`PROTECTION_RESERVATION_CONFLICT`, `ATTACHED_ENTRY_CONFLICT`,
`PROTECTION_ALREADY_TRIGGERED`, `PROTECTION_CHILD_CHANGED`, and
`CONDITIONAL_IDEMPOTENCY_CONFLICT`. Missing eligible registration price returns
`CONDITIONAL_PRICE_UNAVAILABLE`; polling defers with `price_unavailable`.
Errors use the existing safe HTTP/admin diagnostic projection.

## Polling, lifecycle and enablement

`CONDITIONAL_ORDERS_ENABLED=false` is the default. Strict startup validation
rejects malformed values. Server capabilities determine create/Spot Limit/cancel
availability. The independent worker polls every second, reads at most 101 indexed
active/holding IDs and evaluates at most 100 per cycle, with a cursor and existing
30-second PostgreSQL OpsJobLock lease renewed between groups. Lease loss stops
new work. Restart/overlap may revisit a candidate; the financial fence, committed
commands, unique child, and linked execution make effects single-winner.

The worker remains available for lifecycle cleanup when the feature is disabled;
it does not trigger/fill a disabled user's condition. Ops summaries contain bounded
state/error-code counts, never provider payloads. A transient lease-release failure
does not leave the local worker stuck. Futures DISABLED pauses conditional user
exits, while independent automatic liquidation continues according to F2.

General financial mutations use the Account writer fence. Season mutations use
Season → Account → Participant, followed by the existing Order-before-reservation
owner ordering. Pending Spot child Order is locked before group/Position waits.
Futures keeps Account → Futures Wallet → deterministic Position locks.
Full manual exit, liquidation and final Season exit terminate protection atomically.
Partial Market exit re-arms for actual remaining quantity; pending child is canceled
before a manual reduction and its reservation is released in the same transaction.

Season lifecycle cleanup releases all submitted child/parent reservations and
terminalizes groups before final settlement. Final settlement refuses unresolved
active protection/reservations. The post-lock DB time/lifecycle check prevents new
conditional fills at or after endAt. There is no second season cleanup engine.
Cleanup evidence distinguishes account_not_tradable (General account closure),
participant_excluded and season_ended; a General exit is not labeled as Season expiry.

Frontend uses account-scoped query keys, pinned route identity and session/unmount
suppression. Ambiguous create/cancel retries retain the original command. Asset
Detail provides Spot protection, Futures cards provide lifetime-bound protection,
and Spot BUY Limit offers optional attached conditions. Trigger/Market/Limit,
OCO pending sibling, HOLDING and paused operating states are distinct. Attached
editing uses the full mobile width; existing focus-scroll is reused.
Completed protection history stays readable after the position is flat or the
feature is paused. The UI labels its bounded recent view (30 groups, up to 20
attempts each); the API additionally supports paginated groups. Long input prices
also have an exact wrapping preview so large text does not hide their digits.

Disabled capability never hides a successfully loaded empty TP/SL panel. It
shows why new protection cannot be registered; the server's domain create/cancel
capabilities gate buttons and mutation handlers, including retained callbacks.
Loading, failed reads and missing data keep their existing state contracts.
Spot holding cards open the same account/asset/Position-bound panel; an existing
live group opens management rather than a duplicate create editor. Pending
lists separate ordinary Spot/Futures Limit entries from active/HOLDING protection.
Pending Futures groups also show paused monitoring when Futures mode alone is
DISABLED; the per-domain server capability controls the label. Permitted cancel
remains available, including when creation/monitoring is paused.
Conditional Limit children appear only through their group; completed/canceled
history remains in the protection history view instead of the pending list.

## Release / rollback

Run existing financial/core PG gates plus Conditional/F3.1 integrations, E2E,
frontend check and responsive/export gates before a separate enable decision.
Apply only additive migrations through the operator's approved deployment flow;
this code task performs no persistent DB write or enable/provisioning.
Before enable, verify intended provider coverage/freshness, stock calendar,
Limit matching availability for Spot Limit children, and existing Futures
Mark/risk health. Inspect Ops backlog and generation duration under expected load.
A false Conditional flag pauses user triggers/fills but preserves read/cancel and
lifecycle cleanup; operators should communicate that existing SL/TP no longer
executes while paused. Keep Futures risk/Mark operational. Never downgrade to
pre-Conditional code while executable conditional children exist; use compatible
code/forward fixes and preserve durable financial evidence.

No trailing stop, ladders, arbitrary protected quantity,
hedge mode, funding, partial liquidation, ADL, insurance, real exchange orders,
queue/event bus, or generic conditional expression engine is introduced.
