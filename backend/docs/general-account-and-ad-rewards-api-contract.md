# General Account + Ad Reward API Contract

작업 6. Covers general-mode account creation and its one-time funding, plus
the provider-neutral rewarded-ad funding layer.

## Status

Implemented:

- `POST /api/v1/trading-accounts/general`
- `GET /api/v1/trading-accounts/:accountId/ad-rewards/eligibility`
- `POST /api/v1/trading-accounts/:accountId/ad-rewards/claim`
- `GET /api/v1/trading-accounts/:accountId/ad-rewards/claims`

The existing account-scoped finance reads
(`GET /api/v1/trading-accounts/:accountId/wallets`, `wallet-transactions`)
now also serve general accounts unchanged — see
`docs/trading-account-finance-api-contract.md`.

General-mode performance landed later, in 작업 7 and 작업 6·7 보완 — see the
second half of this document. EquitySnapshot, DailyPortfolioSnapshot,
portfolio valuation, time-weighted return, investment PnL display, and the
general-account daily snapshot job ARE implemented now; the list below is the
current one.

General-mode market/limit orders and positions are now implemented through the
existing account-scoped order API; see
`docs/trading-account-orders-api-contract.md`.

General-mode KRW↔USD quote, execute, and transaction history are also
implemented through the existing account-scoped FX API; see
`docs/trading-account-finance-api-contract.md`. FX never creates wallets,
auto-converts for an order, or uses a current season.

NOT implemented (deliberately still blocked):

- a real ad-network adapter, an ad SDK, and an ad-watching screen.

**No real ad provider has been chosen.** No provider protocol, SDK, callback
shape, or signature scheme is implemented or assumed anywhere. Ad rewards are
DISABLED by default and, with no adapter registered, cannot pay out even when
enabled.

## Common Rules

- Authentication required on every route (401 `UNAUTHORIZED`).
- The accountId is explicit in the path; the server stores no "current
  account" anywhere and re-verifies ownership per request via
  `TradingAccountAccessService`.
- A nonexistent accountId and another user's accountId are the SAME
  404 `TRADING_ACCOUNT_NOT_FOUND`.
- Amounts are strings (scale 8); timestamps are UTC ISO strings; the
  `success/data` / `success/error` envelope is unchanged.
- A GET never creates an account, a wallet, a grant, or a claim.

---

## POST /api/v1/trading-accounts/general

The ONLY way a general account is created. Migrations never create one, and no
existing user is retro-provisioned.

- No request body. Extra body fields are ignored.
- **Always HTTP 200** (pinned with `@HttpCode`, not Nest's POST default 201);
  `data.created` is the single discriminator between a first open and a
  replay.

### Response

```json
{
  "success": true,
  "data": {
    "created": true,
    "account": {
      "id": "<string>",
      "mode": "general",
      "status": "active",
      "initialCapitalKrw": "10000000.00000000",
      "openedAt": "<UTC ISO string>",
      "closedAt": null,
      "createdAt": "<UTC ISO string>",
      "updatedAt": "<UTC ISO string>",
      "season": null
    },
    "wallets": [
      {
        "currencyCode": "KRW",
        "balanceAmount": "10000000.00000000",
        "reservedAmount": "0.00000000",
        "availableAmount": "10000000.00000000",
        "updatedAt": "<UTC ISO string>"
      },
      { "currencyCode": "USD", "balanceAmount": "0.00000000", "...": "..." }
    ]
  }
}
```

`season` is always `null`: a general account is never linked to a season and
NO `SeasonParticipant` is created for it.

### First-open transaction (all-or-nothing)

One DB transaction creates, in order:

1. `TradingAccount` — `mode=general`, `status=active`,
   `initialCapitalKrw=10,000,000`, `openedAt=now`, `closedAt=null`
2. KRW `CashWallet` — `seasonParticipantId=null`,
   `tradingAccountId=<account>`, balance 10,000,000, reserved 0
3. USD `CashWallet` — same scope, balance 0, reserved 0
4. `WalletTransaction` — `seasonParticipantId=null`,
   `tradingAccountId=<account>`, `walletId=<KRW wallet>`, `direction=credit`,
   `txType=initial_grant`, `referenceType=general_account_open`,
   `referenceId=<account id>`, `amount=balanceAfter=10,000,000`,
   `occurredAt=openedAt`

If ANY step fails, all four roll back together. No EquitySnapshot or
DailyPortfolioSnapshot is written (작업 7 scope).

### Idempotency and concurrency

Enforced by the existing partial unique index
`trading_accounts_general_owner_unique`
(`UNIQUE (user_id) WHERE mode = 'general'`).

- Re-calling POST returns the existing account with `created=false` and
  creates no account, wallet, or grant.
- Concurrent POSTs converge on ONE account, ONE KRW wallet, ONE USD wallet,
  and ONE `general_account_open` grant; exactly one call reports
  `created=true`. A unique violation is never surfaced as a 500 — the loser
  re-reads the winner's account and replays it.
- The single-grant guarantee is additionally backed by the partial unique
  index `wallet_transactions_general_account_open_reference_unique`.

### Funding policy

- 10,000,000 KRW is granted EXACTLY ONCE, at first open.
- There is NO monthly/periodic/anniversary/catch-up grant, no month-end
  adjustment, no grant scheduler, and no bankruptcy auto-reset. Fields such
  as `grantAnchorDay` / `nextGrantAt` / `lastMonthlyGrantAt` /
  `monthlyGrantCount` / `catchUpGrant` / `recurringGrant` are forbidden.
- Further funding comes only from verified rewarded-ad claims.
- No transfer of funds between accounts, in either direction.

### Damaged accounts fail closed

Before replaying an existing account the server checks its structure:
`mode=general`, no participant, `initialCapitalKrw=10,000,000`, exactly one
KRW and one USD wallet both scoped to the account with
`seasonParticipantId=null`, and exactly one 10,000,000 KRW
`initial_grant`/`general_account_open` ledger row on the KRW wallet.

Any violation → **500 `GENERAL_ACCOUNT_INTEGRITY`**. The account is NOT
repaired, NOT re-granted, and NOT topped up; re-calling POST is not a recovery
mechanism. Investigate with `pnpm trading-accounts:audit-general`.

The CURRENT balance is deliberately NOT part of the check: a used account
legitimately holds less than 10,000,000 KRW, and an account that earned ad
rewards holds more.

### Suspended / closed general accounts

Returned as-is with `created=false`. They are never re-activated, never
re-created, and never re-granted. One general account per user, for life.

---

## Account-scoped finance reads for a general account

`GET /api/v1/trading-accounts/:accountId/wallets` and
`.../wallet-transactions` return the general account's KRW 10,000,000 / USD 0
wallets and its single `initial_grant` ledger row.

General accounts have no participant, so the season scope probes do not apply.
Instead the read asserts the inverse: no wallet and no ledger row of this
account may carry a `seasonParticipantId`, and no ledger row may point at
another account's wallet. A violation is 500 `GENERAL_ACCOUNT_INTEGRITY`
(never a silently partial result). Season-account read behavior is unchanged.

---

## Ad reward configuration

None of these values has a product default; nothing is hardcoded.

| Variable                         | Meaning                                      | Required when enabled |
| -------------------------------- | -------------------------------------------- | --------------------- |
| `AD_REWARD_ENABLED`              | Feature switch. Absent/empty → **false**     | —                     |
| `AD_REWARD_PROVIDER`             | Registered provider key                      | yes                   |
| `AD_REWARD_AMOUNT_KRW`           | Reward per completed ad, > 0                 | yes                   |
| `AD_REWARD_DAILY_MAX_COUNT`      | Max granted claims per day, positive integer | yes                   |
| `AD_REWARD_DAILY_MAX_AMOUNT_KRW` | Max granted KRW per day, ≥ reward amount     | yes                   |
| `AD_REWARD_COOLDOWN_SECONDS`     | Minimum seconds between grants, ≥ 0          | yes                   |
| `AD_REWARD_DAY_TIME_ZONE`        | IANA zone defining the daily boundary        | yes                   |

Validated at boot by `src/common/env-validation.ts` through the single parser
`readAdRewardConfig`. With `AD_REWARD_ENABLED=true` a missing or invalid value
refuses to boot rather than paying out an unagreed number. The daily boundary
is computed from the configured zone, never the server's local midnight.

Tests inject explicit configuration; test amounts are never production
defaults.

## Ad reward verification

`src/ad-rewards/ad-reward-verifier.ts` defines a provider-NEUTRAL contract
only — `AdRewardVerifier`, `AdRewardVerificationRegistry`, and a SHA-256
proof-fingerprint helper. It contains no provider protocol or SDK.

A verifier must prove that the event was issued by that provider, is in a
completed state, is bound to the expected user AND the expected general
account, and carries a stable unique event id.

A client can never decide `rewardAmountKrw`, `providerEventId`, `userId`,
`tradingAccountId`, `grantedAt`, `balanceAfter`, the daily counters, or the
cooldown. The request body carries only `provider` and an opaque
`proof` (alias `verificationToken`).

**The production registry is empty.** `AdRewardsModule` registers NO verifier
— least of all a fake one. Deterministic fakes exist only inside tests, by
constructing `new AdRewardVerificationRegistry([fake])`. Consequently every
production claim currently answers 503 `AD_REWARD_PROVIDER_UNAVAILABLE`, and
an ad completion is never accepted on trust.

Persisted per claim: the provider key, the verifier's event id, a SHA-256
`verificationFingerprint` of the proof, and the adapter's explicitly allowed
non-sensitive metadata. The proof itself, provider tokens, signing secrets,
and raw callback bodies are never stored.

---

## Ad reward endpoints

All three require the account to be `mode=general` with no participant; a
season accountId is 409 `AD_REWARD_GENERAL_ACCOUNT_ONLY` on every route,
including the claim LIST (a season account has no ad-reward history by
construction). Suspended/closed general accounts may READ eligibility and
claims but may not be granted (409 `TRADING_ACCOUNT_NOT_ACTIVE`).

Neither endpoint ever auto-creates a general account or a wallet: the user
must call `POST /api/v1/trading-accounts/general` first.

### GET .../ad-rewards/eligibility

Advisory only; performs no grant and writes nothing.

Evaluation order (작업 6 보완 4) — structure before configuration:

1. authentication
2. account ownership + `mode=general` (unknown and foreign ids are the same
   404; a season account is `AD_REWARD_GENERAL_ACCOUNT_ONLY`)
3. **full general-account financial integrity**
   (`assertGeneralAccountFinancialIntegrity`: exactly one KRW and one USD
   wallet, both account-scoped with no participant link, exactly one
   `initial_grant`/`general_account_open` ledger row for 10,000,000 KRW on the
   KRW wallet with the account as its `referenceId`, and no wallet or ledger
   row of this account carrying a `seasonParticipantId` or pointing at another
   account's wallet)
4. `AD_REWARD_ENABLED`
5. provider adapter registered
6. account status
7. daily count / daily amount / cooldown

Step 3 used to run last — effectively never, because steps 4–6 short-circuit
in the current release. An account with a vanished USD wallet or a missing
initial grant therefore answered a perfectly normal
`{ "eligible": false, "reason": "AD_REWARD_DISABLED" }`. It now answers 500
`GENERAL_ACCOUNT_INTEGRITY` instead: whether ads are switched on has nothing
to do with whether the account's money is intact. Damage is detected while
the feature is disabled, while no provider is registered, and for suspended
and closed accounts. The check is READ-ONLY — no wallet, grant, or ledger row
is ever created to "fix" what is missing.

```json
{
  "success": true,
  "data": {
    "tradingAccountId": "<string>",
    "enabled": true,
    "provider": "<provider key or null>",
    "eligible": true,
    "rewardAmountKrw": "<amount string or null>",
    "grantedCountToday": 0,
    "grantedAmountTodayKrw": "0.00000000",
    "remainingCountToday": 5,
    "remainingAmountTodayKrw": "250000.00000000",
    "nextEligibleAt": "<UTC ISO string> | null",
    "reason": "<code> | null"
  }
}
```

`reason` carries the blocking code when `eligible=false`
(`AD_REWARD_DISABLED`, `AD_REWARD_PROVIDER_UNAVAILABLE`,
`TRADING_ACCOUNT_NOT_ACTIVE`, `AD_REWARD_DAILY_COUNT_LIMIT`,
`AD_REWARD_DAILY_AMOUNT_LIMIT`, `AD_REWARD_COOLDOWN_ACTIVE`). Provider
secrets and verification settings are never returned; only the provider KEY.

The result is guidance, not a reservation — the claim transaction re-checks
every limit against locked rows.

### POST .../ad-rewards/claim

Request body:
`{ "provider": "<key>", "proof": "<opaque>", "idempotencyKey": "<key>" }`
(`verificationToken` is accepted as an alias for `proof`). All three are
REQUIRED. There is deliberately no reward-amount, event-id, user-id,
account-id, granted-timestamp, request-hash, or response-payload field.

Order of work:

1. authentication + account ownership
2. general mode + account active
3. feature enabled
4. provider registered
5. **external verifier call — outside any DB transaction**
6. providerEventId taken from the verification result
7. ONE DB transaction: `SELECT … FOR UPDATE` on the account row, re-check
   mode/status, general-account structural integrity, duplicate event, daily
   count, daily amount, cooldown
8. claim row created
9. KRW wallet credited
10. `WalletTransaction` created
11. claim flipped to `granted` with `walletTransactionId` and `grantedAt`
12. commit, then respond

Success response (HTTP 201, Nest's default for a POST that creates a claim
resource — the same convention as order create; `data.granted` /
`data.duplicate`, not the status code, distinguish a fresh grant from a
replay):

```json
{
  "success": true,
  "data": {
    "granted": true,
    "duplicate": false,
    "claimId": "<string>",
    "grantedAt": "<UTC ISO string>",
    "walletBalanceAfter": "<amount string>"
  }
}
```

#### Payout invariants

- Target wallet must satisfy `tradingAccountId = <account>`,
  `seasonParticipantId IS NULL`, `currencyCode = KRW` — all four conditions
  are in the UPDATE's WHERE, so a season-linked or foreign wallet matches 0
  rows and the claim fails closed with 500 `GENERAL_ACCOUNT_INTEGRITY`.
- `balanceAmount` is incremented by the configured reward;
  `reservedAmount` is untouched; USD is never credited.
- The ledger row is `direction=credit`, `txType=ad_reward`,
  `referenceType=ad_reward_claim`, `referenceId=<claim id>`,
  `seasonParticipantId=null`, `balanceAfter` = the post-update balance,
  `occurredAt = grantedAt`.
- Claim ↔ ledger is 1:1 (`AdRewardClaim.walletTransactionId` is UNIQUE, plus
  the partial unique `wallet_transactions_ad_reward_claim_reference_unique`).
- `TradingAccount.initialCapitalKrw` is NEVER changed by a reward.
- Wallet credit, ledger row, and claim state are one transaction; any failure
  rolls all three back.

#### Concurrency

Ad grants for ONE account are serialized by a `FOR UPDATE` lock on that
account's `trading_accounts` row. There is no global or distributed ad lock.
Counts, sums, cooldown, and the wallet update all happen after the lock, so
concurrent claims cannot exceed a daily cap.

#### Duplicate events

`UNIQUE (provider, providerEventId)` is the duplicate-payout guard.

- Same event, same user + account, already granted → replay the same result
  (`granted=false`, `duplicate=true`), no second credit, no second ledger row.
- Same event on a different user or account → 409
  `AD_REWARD_EVENT_ALREADY_USED`, with no detail about the other claim and no
  wallet change.
- Concurrent identical events → exactly one claim, one ledger row, one credit;
  the losers replay instead of erroring.

#### Limits and cooldown

Only `granted` claims count. Within the configured-timezone day the server
checks the granted count, the granted amount sum, and the last `grantedAt`
inside the transaction.

A verified event that hits a limit is recorded as a **rejected** claim
(`failureCode` = the limit code, no `walletTransactionId`) and the transaction
COMMITS so the rejection is durable; the 429 is raised outside it. That event
is never payable later — re-submitting it replays the original refusal even
after the limit window moves on. Wallet and ledger are unchanged.

- 429 `AD_REWARD_DAILY_COUNT_LIMIT`
- 429 `AD_REWARD_DAILY_AMOUNT_LIMIT`
- 429 `AD_REWARD_COOLDOWN_ACTIVE`

A verification FAILURE has no trustworthy event id, so no claim row is
created at all (422 `AD_REWARD_VERIFICATION_FAILED`, nothing written).

### GET .../ad-rewards/claims

Owner-only history for that general account, with the repo's standard
`limit`/`offset` pagination (default 50, max 100) and a deterministic
`createdAt desc, id asc` ordering.

Fields: `id`, `provider`, `status`, `rewardAmountKrw`, `requestedAt`,
`verifiedAt`, `grantedAt`, `rejectedAt`, `failureCode`, `failureReason`.

`providerEventId`, `verificationFingerprint`, and
`verificationMetadataJson` are EXCLUDED from the response. Suspended and
closed accounts remain readable by their owner.

---

## Errors

| Status | Code                             | Meaning                                   |
| ------ | -------------------------------- | ----------------------------------------- |
| 401    | `UNAUTHORIZED`                   | missing/invalid token                     |
| 404    | `TRADING_ACCOUNT_NOT_FOUND`      | unknown **or** foreign accountId          |
| 409    | `AD_REWARD_GENERAL_ACCOUNT_ONLY` | season account on an ad route             |
| 409    | `TRADING_ACCOUNT_NOT_ACTIVE`     | suspended/closed general account claim    |
| 409    | `AD_REWARD_EVENT_ALREADY_USED`   | event consumed elsewhere / unusable claim |
| 400    | `AD_REWARD_INVALID_REQUEST`      | missing/oversized proof, bad pagination   |
| 422    | `AD_REWARD_VERIFICATION_FAILED`  | verifier rejected the proof               |
| 429    | `AD_REWARD_DAILY_COUNT_LIMIT`    | daily count cap                           |
| 429    | `AD_REWARD_DAILY_AMOUNT_LIMIT`   | daily amount cap                          |
| 429    | `AD_REWARD_COOLDOWN_ACTIVE`      | cooldown not elapsed                      |
| 503    | `AD_REWARD_DISABLED`             | `AD_REWARD_ENABLED=false` (the default)   |
| 503    | `AD_REWARD_PROVIDER_UNAVAILABLE` | no registered verifier adapter            |
| 500    | `GENERAL_ACCOUNT_INTEGRITY`      | damaged general-account structure         |

---

## Return-rate boundary

Time-weighted return and general-mode investment PnL are NOT implemented here.
What this work unit guarantees so a later work unit can compute them:

- initial funding is `WalletTransactionType.initial_grant`,
- ad funding is `WalletTransactionType.ad_reward` — EXTERNAL virtual funding,
  not an investment return,
- claim ↔ ledger is 1:1 and their amounts always agree,
- `TradingAccount.initialCapitalKrw` stays fixed at 10,000,000,
- cumulative ad funding is DERIVED (sum of granted claims / `ad_reward`
  ledger rows). No `cumulativeAdReward`, `cumulativeExternalFunding`,
  `totalDeposits`, `currentProfit`, `currentReturnRate`, or `twr` column is
  stored anywhere.

## Operations

`pnpm trading-accounts:audit-general` — READ-ONLY audit. It reports general
account counts, attached participants, missing/duplicate wallets, general
wallets or ledger rows carrying a participant link, missing/duplicate/
wrong-amount initial grants, wrong `initialCapitalKrw`, granted claims with no
ledger row, claim↔ledger mismatches, `ad_reward` rows with no claim, and
duplicate provider events. It also reports general Order/Position/Quote
participant pollution, missing/mismatched durable quote scope, invalid
limit-sell reservation evidence, invalid Position reservation bounds, duplicate
account+asset positions, and Position reservation totals that disagree with
live submitted limit-sell orders. Exit code 1 when anything is found.

There is deliberately **no `--apply`**: automatic financial correction of
damaged data is more dangerous than the damage. Damaged general accounts are
reported, never re-funded.

---

# 작업 7: General-mode performance (TWR) + account-scoped portfolio

## Status

Implemented:

- `GET /api/v1/trading-accounts/:accountId/portfolio`
- `GET /api/v1/trading-accounts/:accountId/portfolio/equity`
- EquitySnapshot / DailyPortfolioSnapshot moved to the transitional
  TradingAccount scope (season rows backfilled, every new season writer
  dual-writes, general rows carry no participant at all)
- the general-account performance origin, written in the SAME transaction as
  the account
- external-funding before/after boundary snapshots, written in the SAME
  transaction as an ad payout
- `pnpm trading-accounts:repair-snapshot-scope`
- `pnpm trading-accounts:backfill-general-performance`
- ad-reward COMMAND idempotency (`idempotencyKey` + `requestHash` +
  `responsePayloadJson`)

The legacy `GET /api/v1/portfolio` and `GET /api/v1/portfolio/equity` are
UNCHANGED (current-season selection, response shape, range meaning), and no
season calculation, ranking, or settlement behavior was altered.

The later shared TradingAccount order work implements general market/limit
orders and account-scoped positions; the general daily snapshot job,
SeasonRanking account transition, and account-aware frontend are also now
implemented. The later shared FX work also implements explicit general
KRW↔USD exchange. Still not implemented here: general ranking/rewards or a
real ad-provider adapter.

## Ad reward command idempotency (작업 6 보완 1)

`providerEventId` uniqueness stops one AD EVENT from paying twice. It does
NOT let a client safely retry: before this change, a payout that committed and
then lost its response could come back as 409, 503, or a verifier failure once
the account was suspended, the feature was switched off, or the adapter was
removed.

`POST .../ad-rewards/claim` now REQUIRES three fields:

| Field                            | Meaning                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `provider`                       | Required. Never defaulted from config, so a replay does not depend on what `AD_REWARD_PROVIDER` says at retry time. |
| `proof` (or `verificationToken`) | Opaque provider proof.                                                                                              |
| `idempotencyKey`                 | Client command key. Non-empty, ≤255 chars, no control characters. Never server-generated.                           |

`requestHash = sha256({version: "ad-reward-claim:v1", provider, proofFingerprint})`.
The RAW proof is never an input to anything stored, logged, or compared.

Order of work:

1. authentication
2. account ownership (unknown/foreign → the same 404; status NOT checked yet)
3. parse provider / proof / idempotencyKey
4. proof fingerprint + requestHash
5. lookup by `(tradingAccountId, idempotencyKey)`
6. if found → verify ownership, compare requestHash, check claim integrity,
   then replay the first result. Account status, `AD_REWARD_ENABLED`, the
   configured provider, the registry, and the verifier are NOT re-checked.
7. only if absent → general mode, account active, feature enabled, configured
   provider, registry, external verifier
8. grant transaction (account row `FOR UPDATE`, keyed claim re-read for the
   concurrent case, integrity, duplicate event, limits, before snapshot,
   credit, ledger, claim granted + `responsePayloadJson`, after snapshot)

Same key + different request → **409 `AD_REWARD_IDEMPOTENCY_CONFLICT`**.

Two DB uniques, deliberately NOT merged:

- `(tradingAccountId, idempotencyKey)` — client command retry
- `(provider, providerEventId)` — duplicate ad event

A P2002 is resolved by re-reading BOTH axes, not by one generic replay. The
same event under a DIFFERENT key still replays for the same user+account and
is still 409 `AD_REWARD_EVENT_ALREADY_USED` for anyone else; a claim's stored
`idempotencyKey` is never overwritten and there is no alias table.

## One replay validator for every path (작업 6 보완 3 + 4)

A granted claim used to replay as `{ duplicate: true, walletBalanceAfter: null }`
when its ledger link was missing — a success response for a payout the server
could not evidence. Before any replay the claim is now validated:

- **granted**: `grantedAt` and `walletTransactionId` set; the linked ledger row
  exists and is on THIS account's general KRW wallet, `credit`, `ad_reward`,
  `ad_reward_claim`, references this claim, has the claim's exact amount, and
  its wallet has no participant link. Keyed claims must also carry
  `requestHash` and `responsePayloadJson`, plus a complete before/after
  boundary pair.
- **rejected**: `rejectedAt` set, no ledger link, a recognised limit
  `failureCode`. The original 429 is replayed, never re-evaluated.
- **pending / verified / failed**: not a committed end state in the
  synchronous flow — never replayed as success.

Violations are **500 `AD_REWARD_CLAIM_INTEGRITY`**, never repaired.

### The paths were unified (작업 6 보완 4)

There used to be three replay resolvers and they disagreed. The
pre-transaction command-key path ran the full ledger check; the
in-transaction raced-key path only asked "is `walletTransaction` non-null?";
the provider-event path asked nothing and could answer
`{ "duplicate": true, "walletBalanceAfter": null }`. Which validation a caller
got depended on how its request happened to race — the one dimension that must
NOT change what "your reward was already paid" means.

All five entry points now funnel through ONE async resolver:

1. `(tradingAccountId, idempotencyKey)` found before the transaction
2. the same key found again after winning the account row lock
3. `(provider, providerEventId)` found inside the transaction
4. a P2002 on the command-key unique, re-read outside the transaction
5. a P2002 on the provider-event unique, re-read outside the transaction

It always checks, in this order: claim `userId` + `tradingAccountId` against
the owned account → terminal status (`granted` / `rejected` only) → keyed
command state → for a refusal: no ledger link, a recognised limit code, and a
stored refusal payload naming that same code → for a payout: the account's
full financial structure, the whole ledger row, the keyed external-funding
boundary pair, and the stored response payload against the live ledger.

`matchedBy` keeps the two idempotency axes apart. A `command_key` match must
have the same `requestHash`; a `provider_event` match is a DIFFERENT command
by definition, so its hash is not compared — comparing it would turn a
legitimate duplicate-event answer into a bogus conflict.

Guarantees on every path: the verifier is never re-called, the wallet is never
re-credited, no ledger row or snapshot is created, a damaged claim is never
auto-repaired and never hidden behind `duplicate: true`, no success response
carries `walletBalanceAfter: null`, and another user's event is never
disclosed.

**Contract change to note:** a `rejected` claim whose `failureCode` is not one
of the three limit codes previously replayed as 409
`AD_REWARD_EVENT_ALREADY_USED` on the provider-event path. It is now 500
`AD_REWARD_CLAIM_INTEGRITY`, matching the command-key path. That state is
corruption, and 409 concealed it. Every other status and code is unchanged.

### `responsePayloadJson` is used, not just stored

The payload written inside the payout transaction is canonical data. Every
replay compares its `claimId`, `walletBalanceAfter`, and `grantedAt` against
the live ledger and claim, and a refusal payload's `code` against
`failureCode`. Drift between the two means one of them was rewritten after the
fact, which is exactly what a `duplicate: true` success must not paper over.
The response body itself still follows the documented replay shape
(`granted: false, duplicate: true`).

### Committed commands survive state and config changes

A COMMITTED command owes its caller the first result. Suspending or closing
the account, switching `AD_REWARD_ENABLED` off, or removing the provider
adapter does NOT break a retry of an already-paid command — the command-key
lookup runs before those gates on purpose, and no verifier call or money
movement is involved. A NEW command in those states is still refused as
before. The one thing that does refuse a retry is damaged stored data.

## Full general-account integrity (작업 6 보완 2)

`assertGeneralAccountFinancialIntegrity` = foundation check (mode, no
participant, `initialCapitalKrw`, exactly one KRW + one USD wallet, the single
initial grant incl. its `direction`, `balanceAfter`, and account scope) + row
check (no wallet or ledger row carries a `seasonParticipantId`, no ledger row
points at another account's wallet).

It now runs on the account-open replay, `GET .../wallets`,
`GET .../wallet-transactions`, `GET .../ad-rewards/eligibility`, every new
claim, and every performance path. Previously the reads ran only the row half,
so a missing USD wallet or a missing initial grant answered 200 with a
normal-looking payload.

Current balance and `reservedAmount` are deliberately NOT constrained — a used
account holds a different balance, and reservations will exist once general
limit orders are enabled.

## Performance model

| Value              | Definition                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| 현재 총자산        | KRW cash + USD cash in KRW + domestic + US (KRW) + crypto (KRW)                                        |
| 누적 광고 보상금   | sum of valid `ad_reward` credits                                                                       |
| 누적 외부 가상자금 | `initial_grant`/`general_account_open` + `ad_reward`/`ad_reward_claim` — an ALLOW-LIST, never inferred |
| 누적 투자손익      | 현재 총자산 − 누적 외부 가상자금                                                                       |
| 대표 수익률        | **TWR**                                                                                                |

`exchange_target`, `order_sell`, `settlement`, `adjustment`, and
`manual_adjustment` are explicitly NOT external funding. `initialCapitalKrw`
stays 10,000,000 and no cumulative value is cached on TradingAccount.

`(현재 총자산 − 외부자금) / 외부자금` is NOT the headline return: it moves the
moment an ad reward lands.

### TWR

`returnRatePercent = (timeWeightedReturnFactor - 1) × 100`; the factor is the
source of truth and a rounded percent is never fed back into the next factor.

- origin: total = funding, PnL 0, factor 1, return 0%
- ordinary segment: `factor = previousFactor × currentTotal / previousTotal`
- external funding: BEFORE absorbs market performance up to the inflow; AFTER
  adds only the money.

After an inflow, all four hold exactly:

```
after.total  - before.total  = amount
after.funding - before.funding = amount
after.investmentPnl  = before.investmentPnl
after.factor         = before.factor
```

Total loss → factor 0 / −100%, and a later ad reward keeps it at −100% (money
returns, the cumulative return does not). Value reappearing from zero with no
boundary is `GENERAL_PERFORMANCE_DISCONTINUITY`; a negative total is
`GENERAL_PERFORMANCE_INTEGRITY`. All arithmetic is `Prisma.Decimal`.

### Origin and boundaries

The account-open transaction now writes FIVE rows: account, KRW wallet, USD
wallet, initial-grant ledger, and the `general_account_open` EquitySnapshot. A
failure in any of them rolls back all five. A re-open never adds a snapshot,
and an account with no origin is **500 `GENERAL_PERFORMANCE_NOT_INITIALIZED`**
— never auto-created.

The ad payout transaction writes, atomically: before snapshot → KRW credit →
`ad_reward` ledger → claim granted (+ response payload) → after snapshot.
Rejected claims and replays write no boundary rows at all. The partial unique
`(tradingAccountId, externalFundingReferenceType, externalFundingReferenceId,
snapshotReason)` guarantees one before and one after per claim.

### Boundary ORDER does not come from a UUID (작업 7 보완 1)

The pair is written inside ONE transaction, so `before` and `after` routinely
share both `capturedAt` AND `createdAt`, and their ids are random UUIDv4 with
no creation order. Ordering by `capturedAt, createdAt, id` therefore decided
the pair by coin flip: roughly half the accounts reported the `before` row as
their latest state — a false 500 `GENERAL_PERFORMANCE_INTEGRITY` on a
perfectly committed payout — and rendered history as `after → before`.

The order is now stated instead of inferred. Each snapshot has a **phase
rank** within one `capturedAt`:

| reason                                                      | rank |
| ----------------------------------------------------------- | ---- |
| `external_funding_before`                                   | 0    |
| everything else (`scheduled`, origins, `order_executed`, …) | 1    |
| `external_funding_after`                                    | 2    |

- History ascending: `capturedAt` → phase rank → `createdAt` → `id`, so a pair
  always reads **before → after**.
- Latest state: the maximum `capturedAt` is resolved first, then only the rows
  AT that instant are ranked — never the whole history, and never more than a
  bounded page (more than 32 rows sharing one instant fails closed rather than
  ranking a truncated set).
- Ordinary snapshots all share rank 1, so their existing relative ordering is
  unchanged.
- `id` is only ever the last resort between two otherwise indistinguishable
  rows; it never decides a boundary pair. No schema column was added.

The audit script ranks with the same three-value CASE expression, so it can
never disagree with the service about which row is current.

### Ledger and snapshot must not drift apart (작업 7 보완 2)

An ordinary advance is `factor × currentTotal / previousTotal`, which assumes
every KRW between the two totals was EARNED. That only holds while no external
funding arrived since the snapshot being advanced from.

So before any ordinary TWR advance:

```
latestPerformanceSnapshot.cumulativeExternalFundingKrw
  == verified external-funding ledger total
```

If they differ, nothing advances and the response is a structured 500 reusing
the existing **`GENERAL_PERFORMANCE_INTEGRITY`** code (no new error code was
added). Without this, an ad payout whose ledger and wallet credit committed
but whose `after` boundary went missing left the ledger ahead of the snapshot,
and the very next portfolio read silently reported the reward as INVESTMENT
PROFIT.

Applied on: `GET .../portfolio`, `GET .../portfolio/equity`, ordinary
snapshot generation, the `before` snapshot inside an ad payout (where the new
ledger row does not exist yet, so the stored state must match the PRE-payout
total), and the general daily snapshot job. Inside the payout transaction the
mirror check also runs after the claim is flipped to `granted`: the committed
`after` boundary must equal the committed ledger, and a mismatch rolls the
credit, ledger row, claim, and both boundary rows back together.

For a keyed granted claim the whole boundary pair is verified on replay:
exactly one `before` and one `after`, both scoped to the claim's account with
`seasonParticipantId = null` and `referenceType = ad_reward_claim`,
`externalFundingAmountKrw` equal to the claim's `rewardAmountKrw`, identical
factor / returnRate / investment PnL, and after-totals equal to before plus
the reward. Pre-작업 7 UNKEYED claims are exempt: no pair is expected, none is
fabricated, and none is guessed — those accounts are handled by the explicit
`performance_baseline` backfill.

## GET .../portfolio

Ownership → the same 404 for unknown/foreign; readable for active, suspended,
and closed alike; writes nothing.

`data.summary` carries `totalAssetKrw`, `cumulativeExternalFundingKrw`,
`initialFundingKrw`, `cumulativeAdRewardKrw`, `investmentPnlKrw`,
`returnRate`, **`returnRateMethod`**, `krwCash`, `usdCashKrw`,
`assetValueKrw`, `realizedPnlKrw`, `unrealizedPnlKrw`, `valuedAt`.

- general → `returnRateMethod: "time_weighted"`
- season → `returnRateMethod: "initial_capital"`, existing valuation
  unchanged, and the external-funding fields are `null` (not 0 — a season
  account has no external-funding concept, and 0 would read as "none
  received")

`allocation.cashKrwValue = krwCash + usdCashKrw`; `reservedAmount` is never
subtracted from valuation.

Price/FX gaps (`FX_RATE_UNAVAILABLE`, `FX_RATE_STALE`,
`ASSET_PRICE_UNAVAILABLE`) keep the existing `sectionErrors` success envelope.
`GENERAL_ACCOUNT_INTEGRITY`, `GENERAL_PERFORMANCE_*`,
`AD_REWARD_CLAIM_INTEGRITY`, and snapshot scope mismatches do NOT — they are
structured 500s, because rendering damage as "temporarily unavailable" hides
it.

General trading is not enabled, so a general account holding an Order,
Position, ExchangeTransaction, or FxExecuteRequest fails closed with
`GENERAL_ACCOUNT_INTEGRITY` rather than being valued as if it were normal.

## GET .../portfolio/equity

`range` ∈ `1d` (default) | `7d` | `30d` | `all`; for a general account `all`
means since `openedAt`. `1d` reads EquitySnapshot; the wider ranges prefer
DailyPortfolioSnapshot and fall back to EquitySnapshot when there is none.

Points carry `time`, `totalAssetKrw`, `returnRate`, `returnRateMethod`,
`cumulativeExternalFundingKrw`, `investmentPnlKrw`, `snapshotReason`,
`externalFundingAmountKrw`. Ordering is `capturedAt` → boundary phase rank →
`createdAt` → `id` ascending (see "Boundary ORDER does not come from a UUID"),
so a before/after pair sharing one `capturedAt` and one `createdAt` always
reads before → after regardless of which id happens to be larger.

For a general account this endpoint also enforces the funding-continuity
invariant: a history whose latest state already disagrees with the ledger is
reported as 500 `GENERAL_PERFORMANCE_INTEGRITY` rather than charted.

Once the general daily snapshot job has produced rows, `7d` / `30d` / `all`
use DailyPortfolioSnapshot; the EquitySnapshot fallback remains for accounts
that do not have enough daily rows yet.

A general account with no origin is `GENERAL_PERFORMANCE_NOT_INITIALIZED`,
never an empty chart.

## Operations

- `pnpm trading-accounts:repair-snapshot-scope [--apply]` — fills a season
  snapshot's null `tradingAccountId` from its participant link. Amounts,
  rates, times, dates, and reasons are never touched; mismatches and general
  rows are reported and never guessed; `--apply` exits non-zero while anything
  is unresolved.
- `pnpm trading-accounts:backfill-general-performance [--apply]` — creates a
  `performance_baseline` origin for pre-작업 7 general accounts, ONLY where it
  is provable: no trading rows, wallets intact, claims consistent, no USD
  cash, and total assets exactly equal to external funding (so PnL really is
  0 and factor really is 1). Partial state, trading rows, unknown credits, or
  any mismatch is reported and skipped. No `--force`.
- `pnpm trading-accounts:audit-general` — extended with the performance
  checks (origin presence/uniqueness, participant leakage, missing columns,
  PnL and factor/return disagreement, negative values, unpaired or
  inconsistent boundary pairs, keyed claims without a boundary pair, duplicate
  account/date daily rows, unscoped or mis-scoped season snapshots), and with
  the 작업 6·7 보완 checks (latest state stuck on a `before` row, ledger vs
  latest-snapshot funding mismatch, `before`/`after` halves reported
  separately, each boundary invariant on its own, general daily rows with a
  participant or missing performance columns, daily rows on closed accounts).
  Still read-only, still no `--apply`; financial data and TWR boundaries are
  never auto-corrected.
- `pnpm tsx scripts/admin-run-batch-job.ts --job general-account-daily-snapshot
--snapshot-date <YYYY-MM-DD> [--dry-run]` — the general-account daily
  snapshot job (작업 7 보완 5). Details in `docs/batch-job-foundation.md`.

## 작업 8 — consistent reads, per-account serialization, strict replay payload

### Consistent portfolio reads

`GET /api/v1/trading-accounts/:accountId/portfolio` and
`GET /api/v1/trading-accounts/:accountId/portfolio/equity` run their GENERAL
path inside one Prisma `RepeatableRead` transaction. Season accounts and the
legacy `/api/v1/portfolio*` endpoints are unchanged.

The externally visible contract is identical — 401 unauthenticated, the same
404 `TRADING_ACCOUNT_NOT_FOUND` for unknown and foreign accounts, and
active/suspended/closed all readable. What changed is that a payout committing
mid-request can no longer be half-visible: `totalAssetKrw`,
`cumulativeExternalFundingKrw`, `investmentPnlKrw`, and `returnRate` always
describe ONE committed instant, so an ad reward never appears as investment
profit.

These GETs still write nothing: no snapshot, wallet, ledger row, claim, or
repair, and no row lock.

### History integrity

Every returned history point is verified before any of it is serialised.
`cumulativeExternalFundingKrw` and `investmentPnlKrw` are never `null` on a
general history point — a row that cannot produce them is damage, reported as
500 `GENERAL_PERFORMANCE_INTEGRITY`, not rendered as a gap.

Verified per row: account scope, `seasonParticipantId = null`, the three
performance columns non-null and non-negative,
`investmentPnl = totalAsset - cumulativeExternalFunding`,
`returnRate = (factor - 1) × 100`, origin rows at factor 1 / return 0, ordinary
rows with no external-funding reference columns, and boundary pairs that are
complete and performance-neutral. `ad_reward_claim` boundaries are cross-checked
against their claims in ONE batched query per request.

Legacy (pre-작업 7) unkeyed claims are NOT required to have boundaries. A
boundary that does exist must still be a complete pair.

### Keyed claim replay payload

A keyed claim's stored `responsePayloadJson` must be structurally complete
before it can answer a retry:

```json
{
  "success": true,
  "data": {
    "granted": true,
    "duplicate": false,
    "claimId": "<claim id>",
    "grantedAt": "<UTC ISO>",
    "walletBalanceAfter": "<ledger balanceAfter>"
  }
}
```

`granted`/`duplicate` describe the ORIGINAL call, so the stored record is always
`true`/`false`; the outward response of a retry flips them, which is the
existing API contract. A keyed refusal payload must carry
`refused: true`, a `code` equal to `claim.failureCode`, and a non-empty
`message` that does not contradict `claim.failureReason`.

Anything missing, mistyped, or disagreeing with the ledger is 500
`AD_REWARD_CLAIM_INTEGRITY` — never a `duplicate: true` success. Legacy unkeyed
claims are exempt from the shape (their payload may be null or partial), but any
field they DO carry must still agree with the ledger.

### Daily snapshot serialization

`general-account-daily-snapshot` takes the same `trading_accounts` row lock the
payout takes, so for one account the two are strictly serialised. Only two
orderings are possible — daily-then-payout or payout-then-daily — and neither
produces a snapshot mixing a post-payout wallet with a pre-payout funding total.
An account closed after the run listed it gets no snapshot at all and is counted
in `excludedClosed` / `skippedClosedDuringRun`.

## Client status (작업 11)

- `POST /api/v1/trading-accounts/general` now has a UI (`AccountSetupPanel`),
  reached when a user owns no trading account. Creation stays an explicit press;
  no GET, mount, or navigation creates an account, a wallet, or a grant.
- Ad reward **eligibility/claim screens still do not exist**. The client
  wrappers (`getAdRewardEligibility`, `getAdRewardClaims`, `claimAdReward`) and
  their cache invalidation are in place; no screen calls them.
- No real ad provider is registered, and reward fulfilment remains disabled.
  This is unchanged by 작업 11 and is deliberate.
