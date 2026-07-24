# Limit-Order Event Authority (NORMATIVE)

Status: **Normative contract.** Where this document and any other limit-order
document disagree about *when a provider trade event may fill an order*, **this
document wins** and the other document is the one that must be corrected. The
peer documents
[`limit-order-live-matching-operations.md`](./limit-order-live-matching-operations.md),
[`limit-order-candle-reconciliation.md`](./limit-order-candle-reconciliation.md),
[`orders-api-contract.md`](./orders-api-contract.md) and
[`policy-decisions.md`](./policy-decisions.md) defer to the definitions here.

Scope: the automatic execution of **limit *buy*** orders only. Nothing here
adds an order type, a public "execute limit now" API, a `/api/v2` surface, or a
real exchange order. Every feature flag named here defaults to **`false`**; this
document describes the contract the code must satisfy *when* a flag is enabled,
not a claim that the path is enabled in production.

This is a **phased** contract. Section [16](#16-implementation-status) is the
single honest map of which clauses are enforced by code today at this repo HEAD
and which are specified here as the target for later phases. Do not read an
unqualified "must" as "already shipped" — read Section 16.

---

## 1. Why this document exists

Automatic limit matching has two execution paths:

- **Path A — live trade event.** A normalized provider trade tick fills the
  order at the **real event price**. `matchingSource = live_trade_event`.
- **Path B — closed 5-minute candle safety net.** After a 5m window closes, a
  stored canonical candle whose low touched the limit fills the order at the
  order's **`limitPrice`** (never the candle low). `matchingSource =
  closed_5m_candle`.

The system was built so that **Redis Stream arrival order** decides which
orders an event may fill (see the comment block at the top of
[`limit-order-event-validator.ts`](../src/orders/limit-matching/limit-order-event-validator.ts):
"ordering is decided purely by Redis Stream IDs"). That is the flaw this
contract closes. A Redis Stream ID proves **only the order in which this server
appended events** — it says nothing about the order in which trades *occurred
at the exchange*, and nothing about events that occurred before but were
delivered after an order was created. Building finality and cross-path
priority on arrival order lets a delayed trade fill an order it predates, and
lets Path B pre-empt a live event that has not finished processing.

---

## 2. The three clocks — never conflate them

Every trade event has up to three distinct timestamps. **They are not
interchangeable and are never compared across the boundary between them.**

| # | Clock | Field(s) | What it proves | What it does NOT prove |
|---|-------|----------|----------------|------------------------|
| 1 | **Occurrence time** | `providerEventAt` (provider's stamp) | Roughly *when the trade happened at the venue*, at the provider's precision and clock | Nothing authoritative about ordering unless the provider documents precision, tie-breaking, timezone, and monotonicity |
| 2 | **Receive time** | `receivedAt` (our socket read), `publishedAt` (our append) | *When our process saw / appended it*, on our clock | Anything about venue occurrence order |
| 3 | **Stream time** | Redis Stream ID `<ms>-<seq>` | The **total order in which this server appended events** | Venue occurrence order; whether earlier-occurring events are still to arrive |

**Rules that follow and may not be violated:**

- Redis Stream ID orders **arrival**, not **occurrence**. It is used for
  de-duplication cursors and safe-trim watermarks, **never** as proof that one
  trade happened before another at the venue.
- A provider timestamp existing is **not** evidence it is a trustworthy
  ordering authority. A route earns occurrence-ordering authority only through
  the capability matrix (Section 4), never by having a `providerEventAt`
  string.
- We never compare our Node clock directly against a provider clock to decide
  eligibility. Cross-clock subtraction is only ever used for coarse liveness
  and sanity bounds (e.g. "a stamp hours in the future is corrupt"), which
  **never widen or narrow which orders an event may fill**.

---

## 3. Event identity — authoritative vs. synthetic

An event's **identity** answers "is this the same trade I already saw?" Its
**ordering key** answers "did this trade occur before or after that one?"
These are different questions and a value that answers one does not
automatically answer the other.

Identity is constructed in this priority order:

1. A provider's **official unique trade ID** (globally unique within
   `(provider, asset)`).
2. A provider's **official monotonic per-trade sequence**.
3. A combination of fields the provider **documents** as unique.
4. Otherwise a **synthetic** hash of `(timestamp, price, quantity, volume, …)`
   — a de-dup *convenience* with real collision risk, and **NEVER** an
   ordering authority.

Non-negotiable:

- The same `(timestamp, price, quantity)` triple is **not** assumed globally
  unique. Two genuinely different fills can share it.
- A synthetic identity is used only to avoid double-processing the *same*
  delivered payload. A synthetic identity is **never** promoted to an
  occurrence-ordering key, and a route whose only identity is synthetic is
  **not** Path-A authoritative (Section 4).
- A unique constraint is only placed on an identity the provider guarantees is
  unique. We never force a `UNIQUE` on a collision-prone synthetic key, because
  that would silently drop a second genuinely-distinct trade.

---

## 4. Provider capability matrix

A route's Path-A eligibility is a **declared capability**, grounded in provider
documentation and in what our parser actually captures — never assumed, never
asserted by a code comment alone. The type
(`src/providers/provider-trade-capability.ts`):

```ts
type ProviderTradeCapability = {
  provider: 'binance' | 'kis';
  route: string;               // stable route key, e.g. 'binance:spot-trade'
  sourceName: string;
  supportsAuthoritativeEventId: boolean;
  supportsMonotonicSequence: boolean;
  supportsAuthoritativeEventTime: boolean;
  supportsDocumentedFinality: boolean;
  supportsReplay: boolean;
  supportsBoundedDeliveryLag: boolean;
  maxDocumentedDeliveryLagMs: number | null;
  pathAExecutionAllowed: boolean;
  pathBRequired: boolean;
  activationMode:
    | 'provider_sequence'
    | 'provider_time_watermark'
    | 'path_b_only'
    | 'unsupported';
};
```

**Fail-closed default.** A route not present in the matrix, or present with
`activationMode: 'unsupported'`, blocks **new** limit quote/create for that
route. It never silently falls back to arrival-order Path A.

### 4.1 Classified routes (grounded in code + provider docs)

| Route | Identity our parser captures | Path A? | activationMode | Rationale |
|-------|------------------------------|---------|----------------|-----------|
| **`binance:spot-trade`** | `@trade.t` (per-symbol monotonic unique trade ID) → `providerEventId` **and** `providerSequence` ([parser](../src/providers/binance/binance-websocket.parser.ts)) | **Allowed** | `provider_sequence` | Binance documents `t` as a per-symbol strictly-increasing trade ID; it is an authoritative unique identity *and* a monotonic ordering key within `(binance, asset)`. Path B remains the safety net. |
| **`kis:domestic-trade`** | Synthetic composite `eventId` (trId+symbol+time+price+qty+cumVolume) and `sequence = ACML_VOL` (cumulative volume) ([parser](../src/providers/kis/kis-websocket.trade-parser.ts)) | **Not allowed** | `path_b_only` | The identity is synthetic (Section 3) and cumulative volume is **not** a documented per-trade monotonic authority (it ties, resets per session, and is not a trade ordinal). No provable occurrence order ⇒ Path B only. |
| **`kis:overseas-delayed-trade`** | Delayed US quote fields; synthetic identity | **Not allowed** | `path_b_only` | KIS US is an explicitly **delayed** feed. It is never presented as "real-time" and is never an authoritative Path-A source. |

`pathBRequired: true` for every classified route: Path B is the safety net even
where Path A is authoritative.

> If a route later gains a genuinely authoritative feed (e.g. a KIS TR that
> documents a monotonic execution sequence, or a Binance source verified to
> carry `@trade.t`), update the matrix **and** add the parser evidence — not a
> comment.

### 4.2 Runtime evidence still required

A route being Path-A-capable is necessary, not sufficient. Each individual
event must still carry the authoritative evidence the mode needs
(`provider_sequence` ⇒ a non-null `providerSequence` under a known
generation/epoch). An event on a Path-A route that lacks its evidence is
treated as **not** authoritative and cannot fill on Path-A grounds — it does
not silently degrade to arrival order.

---

## 5. Path A authority & finality

For a `provider_sequence` route, a live event may fill an order **iff** all
hold:

1. The order carries a valid **activation token** for the same
   `(provider, route, generation, epoch)` (Section 7).
2. The event's `providerSequence` is **strictly greater** than the order's
   `matchingActivationProviderSequence` (Section 7.2 fixes the comparison).
3. The event is valid (Section 12) and its route is Path-A-allowed (Section 4).
4. All single-terminal-winner invariants hold (cancel/execution,
   cleanup/execution, participant-exclusion/execution): exactly one terminal
   transition wins.

Path-A **finality** for a window (needed by Path B, Section 6) means: for the
`(provider, route, asset)`, occurrence coverage is established **through the
window's close** — every accepted event up to that point is published,
processed and acknowledged, and the route documents (or the coverage checkpoint
proves) that no earlier-occurring event is still outstanding. A route that
cannot prove delivery finality never *manufactures* it (Section 11).

---

## 6. Path B eligibility & the coverage gate

Path B fills at `limitPrice` from a canonical closed 5m candle. Unchanged
invariants: the partially-elapsed candle the order was submitted into is
excluded (`candleMatchingEligibleFrom` is rounded **up** to the next 5m
boundary,
[`limit-order-candle-eligibility.ts`](../src/orders/limit-matching/limit-order-candle-eligibility.ts)),
no price improvement to the candle low, no retroactive fills after season end,
no final drain.

**New gate — Path B may not run for a window until Path A is proven complete
for it.** Concretely, Path B fills a candle only if **one** of:

- the route is policy **Path-B-only** (Section 4); or
- for a Path-A route: the window's Path-A coverage is **final** (Section 5) —
  all durable-ingress events for the window are published, all matcher events
  processed and acknowledged, no pending ingress / pending Redis / pending
  matcher event, no provider gap, no ingress gap, no invalid-event degradation.

If any of those cannot be **proven**, Path B does **not** fill, does **not**
mark the candle processed/skipped, and holds the window in `coverage_wait` /
deferred with an asset-scoped fail-closed health signal (existing orders remain
cancelable). "The candle is closed" and "a grace period elapsed" are **not**
sufficient on their own.

This is the invariant behind goal #1: **if a usable Path-A event exists or is
still in flight, Path B must not fill first.** It holds at every in-flight
stage — event durably accepted but not yet in Redis, in Redis unread, in Redis
pending, in a matcher candidate batch, before the execution transaction, after
DB commit but before ACK, and across a crash/restart.

Worked example: `limitPrice = 100`, live Path-A event price `= 95`, candle low
`= 95`. Outcome is **`executedPrice = 95`, `matchingSource =
live_trade_event`** — Path B must not pre-empt with a `limitPrice = 100` fill.

---

## 7. Order activation token

The pre-existing mechanism stored **only the Redis Stream tail**
(`matchingActivationStreamId`) at create time. Arrival order cannot exclude a
delayed event, so activation is extended to carry the durable evidence a route
actually needs.

### 7.1 Fields (nullable except where a mode requires them)

Recorded on the order at create time, inside the create transaction, under the
match-boundary lock:

- `matchingProvider`, `matchingProviderRoute`
- `matchingProviderGeneration`, `matchingProviderEpoch`
- `matchingActivationMode` (mirrors the route's `activationMode`)
- `matchingActivationProviderSequence` (required when mode =
  `provider_sequence`)
- `matchingActivationProviderEventAt` (required when mode =
  `provider_time_watermark`)
- `matchingActivationIngressSeq`, `matchingActivationCoverageVersion`
- `matchingActivationStreamId` (retained; a *convenience* cursor, no longer the
  sole authority)

### 7.2 Comparison rules (frozen by unit tests)

For a `provider_sequence` route, an event with sequence `s` and the order's
activation sequence `a`:

- `s < a` → **must not fill** (event predates activation).
- `s = a` → **must not fill** (the boundary event is the last pre-activation
  event; activation is exclusive).
- `s > a` → **eligible** (subject to Sections 4–5, 12).
- **generation mismatch** (event generation ≠ order's activation generation) →
  **must not fill**. A superseded connection's events cannot fill a new order.
- **epoch mismatch** (fencing epoch differs) → **must not fill**. An old owner's
  events cannot fill a new owner's orders.
- **missing/malformed token** (Path-A-required fields absent or unparseable) →
  **fail-closed**: no Path-A fill.
- **synthetic-only route** → never fills on Path A regardless of the numbers.

For a `provider_time_watermark` route (only if a provider ever documents the
required properties — none does today, Section 4), an event may fill only when
its `providerEventAt` is strictly after the activation watermark **and** the
provider documents timestamp precision, same-timestamp tie-break, timezone,
clock authority, delayed-delivery policy, correction/replay behavior, and
timestamp-regression handling. Absent any of those proofs, the route is
**Path-B-only**, not "time-watermark".

---

## 8. Delayed-event defense (goal #2)

Scenario:

```
10:00:00  trade occurs at the venue (provider occurrence time)
10:00:05  user's limit order commits
10:00:10  the 10:00:00 trade is delivered to our process
```

The 10:00:00 trade **must not** fill the new order. Each of these, **alone**,
is insufficient and is therefore **not** the mechanism:

- Redis `streamId` comparison (arrival order — the delayed event arrives later
  and would wrongly qualify).
- `receivedAt` comparison (our clock, arrival order).
- an arbitrary grace period.
- Node-clock vs provider-clock subtraction.
- a bare `providerEventAt > submittedAt` comparison.
- string-sorting a synthetic event ID.

The mechanism is: on a `provider_sequence` route, the event's authoritative
**provider sequence** must be strictly greater than the order's activation
sequence (Section 7.2). A trade that *occurred* before the order carries a
sequence `≤` the activation sequence and is rejected regardless of when it
arrived. On a route with no such authority, Path A is **not used at all** and
the order is Path-B-only — never arrival-order Path A.

---

## 9. Durable ingress (target design)

Contract: **an event counts as `accepted` only once it is written to storage
that survives a process crash.** This removes the fire-and-forget bus listener
and the single unbounded publisher `Promise` tail.

Recommended model `LimitOrderTradeIngressEvent` — secret-free normalized fields
only (Section 9.1), Decimal price, a status lifecycle
(`accepted → publishing → published → processing → processed → acknowledged`,
plus `invalid` / `dlq` / `gap`), `redisStreamId`, publish-attempt bookkeeping,
and `firstAcceptedAt / publishedAt / processedAt / acknowledgedAt`. A bounded,
idempotent, crash-safe worker moves `accepted → published` via `XADD`; matcher
dedupe tolerates the duplicate publishes a crash-between-XADD-and-DB-update
produces.

### 9.1 Ingress/DLQ data policy

Store **only** normalized, secret-free fields: provider, route, sourceName,
assetId, nullable providerEventId/providerSequence, generation, epoch,
providerEventAt, receivedAt, ingressSeq, currencyCode, **Decimal** price,
status, error code/sanitized reason. **Never** store: a raw provider frame,
access token, API key, approval key, `Authorization` header, or any user /
order / account / wallet data. Prices are Prisma `Decimal` / decimal strings —
never a JS `number`.

### 9.2 Crash points (recovery frozen by tests)

Insert-before-XADD, XADD-before-streamId-write, streamId-write, matcher-start,
execution-commit, commit-before-ACK, ACK-before-`acknowledgedAt` — each has a
defined recovery outcome: **no event loss, no duplicate fill, no stale-duplicate
fill of a later order, reservation invariants intact, health fail-closed during
the fault, finite-time convergence after restart, cancel/cleanup unaffected.**
A crash between `XADD` and the DB `streamId` write may republish the same
ingress event to a second stream ID; that is an accepted recovery behavior and
matcher dedupe absorbs it.

---

## 10. Bounded queue & backpressure (target)

No in-memory queue is unbounded. Per-provider and global entry caps, an oldest-
accepted-age cap, publish-attempt/backoff caps, worker batch size, shutdown
drain timeout, and warning/emergency thresholds (all env-configurable,
conservative defaults). On overflow: **never silently drop** — revoke provider
readiness, record an ingress gap, block *new* limit quote/create for the
affected provider/asset, log and surface health; existing-order cancel/cleanup
still allowed. Blast radius is per route/provider: one provider's stalled queue
does not, by itself, block another provider.

---

## 11. Path A coverage checkpoint (target)

Durable per-`(provider, route, asset)` coverage distinguishing **accepted /
published / processed / acknowledged** watermarks from **occurrence finality**
and **delivery finality**. "Acknowledged" is **not** equated with "the provider
delivered everything up to this time." A route that does not provide delivery
finality never gets a synthesized Path-A `final`; it is Path-B-only or
unsupported.

---

## 12. Validity, invalid events & DLQ (target for health, partial today)

Invalid classes: payload parse failure, eventId mismatch, unknown
provider/route, asset/source/currency mismatch, generation/epoch mismatch,
unsupported capability, invalid price/timestamp/sequence, occurrence-ordering
regression. An invalid event is moved to an **idempotent** DLQ record and the
source is acknowledged, **but** it also increments per provider/route/asset
invalid counters and a consecutive-invalid counter. Above threshold: block new
limit quote/create for the affected scope, degrade provider readiness, and
(where coverage is consequently unprovable) block Path B too — while a single
malformed asset event must not permanently halt *all* providers, and a wholly
broken parser must not hide behind a still-"running" heartbeat. Existing-order
cancel/cleanup remain allowed.

---

## 13. Redis retention: no producer MAXLEN; ACK-aware safe trim (target)

The financial event stream is **never** trimmed by producer-side `XADD … MAXLEN
~ N`, nor by stream length, nor under memory pressure, nor for any entry a
consumer has not read, is pending on, or has not had its processed DB row
acknowledged. `XADD` only appends. A separate safe-trim worker computes a
watermark that is the **contiguous** minimum of *(all relevant consumer groups'
safe points)* and the durable `acknowledged` set, applies a margin, and trims
with `XTRIM MINID`; if the watermark cannot be computed it does not trim.
The former `LIMIT_ORDER_EVENT_MAXLEN` becomes a safe-trim target / capacity
warning / emergency fail-closed threshold — not a producer trim. Emergency
memory pressure blocks new quote/create and alerts; it never silently deletes.

---

## 14. Matcher heartbeat schema (target)

Heartbeat carries `schemaVersion` plus leader identity, read/ACK watermarks,
pending/oldest-pending, consumer lag, stream first/last/length, retention
headroom, ingress backlogs & oldest age, recent/consecutive invalid counts, and
`degradedReason`. Consumers **fail-closed** on: schemaVersion mismatch, a
missing required field, a NaN/negative/infinite number, an unparseable
timestamp, a future timestamp beyond skew, or a missing stream/ingress metric. A
**quiet market** (valid metrics, no recent events) is healthy; a **missing
metric** is not — the two are never conflated.

---

## 15. New-order gate & provider readiness

`Quote`/`Create` for a **new** limit order checks: limit feature enabled, route
capability (Section 4), provider readiness, durable-ingress health, matcher
health, Path-B health, and the asset's invalid/gap state. Provider readiness
requires more than a connected socket: a live owner lease, a valid fencing
epoch and current generation, an acknowledged asset subscription, a known
capability, a healthy/bounded ingress, healthy Redis publish, an
under-threshold invalid rate, and a healthy coverage checkpoint. **Socket up
but ingress blocked ⇒ readiness false.** The existing shared-readiness owner
lease / epoch invariants are preserved.

Already-committed **idempotent replay** returns *before* these new health
gates, exactly as today. **Cancel**, **season cleanup**, and
**participant-exclusion cleanup** are **never** blocked by a health failure.

---

## 16. Implementation status

Honest map at this repo HEAD. "Enforced" = code enforces it now; "Contract" =
specified here for a later phase and **not** yet enforced.

| Clause | Status |
|--------|--------|
| §1–§3 semantics; three clocks; identity vs ordering | **Enforced (doc-level) + partially in code.** Stream-ID-as-authority is documented here as deprecated; code still uses it on the live path until activation tokens land. |
| §4 capability matrix (type + KIS/Binance classification + resolver + unit tests) | **Enforced (new module).** `provider-trade-capability.ts` + tests. Wiring into the live create/quote gate is **Contract** (next phase). |
| §7 activation token — comparison/eligibility **pure logic** + unit tests | **Enforced (new module).** `limit-order-activation-token.ts` + tests. Persisting the new columns and consulting them on the live path is **Contract**. |
| §8 delayed-event defense (as a decided function) | **Enforced (pure logic + tests).** Live-path wiring is **Contract**. |
| §9 durable ingress model/worker; §10 bounded queue; §11 coverage checkpoint; §13 safe trim / MAXLEN removal; §14 heartbeat schemaVersion; §12 invalid-event health & DLQ table | **Contract (planned).** Not yet built. The current fire-and-forget bus, unbounded publisher tail, producer `MAXLEN`, and stream-ID authority are still in place. |
| §15 new-order gate additions | **Partly enforced.** Existing readiness/backlog/coverage gates remain; capability + ingress-health additions are **Contract**. |
| §17 legacy submitted-order policy | **Enforced by policy + migration plan below.** |
| Frontend error codes for the new failure modes | **Enforced (additive).** Codes + user-safe messages added; emitted by the backend as the corresponding gates land. |

Nothing in the "Contract (planned)" row is claimed as shipped anywhere in the
repo. When a clause is implemented, move its row to "Enforced" **and** cite the
test that freezes it.

---

## 17. Legacy submitted-order & data-migration policy

All schema changes are **additive**: no existing migration is edited, no row is
deleted, no DB reset. Feature flags stay `false` across the migration.

Existing `submitted` limit orders have **no** activation token. Conservative,
frozen policy:

- They are **never** filled on Path A. Absent activation evidence, no live
  event is trusted to fill them (no back-filled/synthesized token — we never
  manufacture past ordering authority).
- They may still be filled on **Path B** where Path-B health and the existing
  candle-eligibility invariants are safe, **or** an operator may cancel/recreate
  them. The choice is recorded in [`policy-decisions.md`](./policy-decisions.md).
- Existing executed orders, wallet balances, reservations, and candle evidence
  are **never** modified. A prior `receivedAt` is never reinterpreted as an
  occurrence time; a prior `matchingActivationStreamId` is never converted into
  a provider sequence.

---

## 18. Rollout / rollback

Flags (all default **`false`**): existing `LIMIT_ORDER_ENABLED`,
`LIMIT_ORDER_AUTO_EXECUTION_ENABLED`,
`LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED`,
`LIMIT_ORDER_SHARED_READINESS_ENABLED`; planned
`LIMIT_ORDER_DURABLE_INGRESS_ENABLED`,
`LIMIT_ORDER_SAFE_STREAM_TRIM_ENABLED`,
`LIMIT_ORDER_EVENT_COVERAGE_GATE_ENABLED`,
`LIMIT_ORDER_INVALID_EVENT_HEALTH_ENABLED`.

Order: migration → durable-ingress **shadow write** → ingress-worker publish
verified against the existing publisher → invalid-event health observed →
safe-trim **dry-run** → Path-A coverage **shadow** → coverage gate on → safe
trim on → Path A enabled for a limited asset set → Path B integration on → new
limit feature on. Shadow mode never double-executes a fill. Rollback is
flag-off; because ingress is additive and the legacy path is untouched until a
flag flips, turning a flag off restores prior behavior with no data change.
