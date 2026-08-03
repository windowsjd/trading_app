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

NOT implemented in this work unit (deliberately still blocked):

- general-mode orders (`GENERAL_ACCOUNT_TRADING_NOT_IMPLEMENTED`) and FX
  (`GENERAL_ACCOUNT_FX_NOT_IMPLEMENTED`),
- general-mode positions, EquitySnapshot, DailyPortfolioSnapshot,
  portfolio valuation, time-weighted return, investment PnL display,
- a real ad-network adapter, an ad SDK, an ad-watching screen, the
  post-login mode-selection screen, and any frontend change.

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

| Variable | Meaning | Required when enabled |
| --- | --- | --- |
| `AD_REWARD_ENABLED` | Feature switch. Absent/empty → **false** | — |
| `AD_REWARD_PROVIDER` | Registered provider key | yes |
| `AD_REWARD_AMOUNT_KRW` | Reward per completed ad, > 0 | yes |
| `AD_REWARD_DAILY_MAX_COUNT` | Max granted claims per day, positive integer | yes |
| `AD_REWARD_DAILY_MAX_AMOUNT_KRW` | Max granted KRW per day, ≥ reward amount | yes |
| `AD_REWARD_COOLDOWN_SECONDS` | Minimum seconds between grants, ≥ 0 | yes |
| `AD_REWARD_DAY_TIME_ZONE` | IANA zone defining the daily boundary | yes |

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

Request body: `{ "provider": "<key>", "proof": "<opaque>" }`
(`verificationToken` is accepted as an alias for `proof`). There is
deliberately no reward-amount or event-id field.

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

| Status | Code | Meaning |
| --- | --- | --- |
| 401 | `UNAUTHORIZED` | missing/invalid token |
| 404 | `TRADING_ACCOUNT_NOT_FOUND` | unknown **or** foreign accountId |
| 409 | `AD_REWARD_GENERAL_ACCOUNT_ONLY` | season account on an ad route |
| 409 | `TRADING_ACCOUNT_NOT_ACTIVE` | suspended/closed general account claim |
| 409 | `AD_REWARD_EVENT_ALREADY_USED` | event consumed elsewhere / unusable claim |
| 400 | `AD_REWARD_INVALID_REQUEST` | missing/oversized proof, bad pagination |
| 422 | `AD_REWARD_VERIFICATION_FAILED` | verifier rejected the proof |
| 429 | `AD_REWARD_DAILY_COUNT_LIMIT` | daily count cap |
| 429 | `AD_REWARD_DAILY_AMOUNT_LIMIT` | daily amount cap |
| 429 | `AD_REWARD_COOLDOWN_ACTIVE` | cooldown not elapsed |
| 503 | `AD_REWARD_DISABLED` | `AD_REWARD_ENABLED=false` (the default) |
| 503 | `AD_REWARD_PROVIDER_UNAVAILABLE` | no registered verifier adapter |
| 500 | `GENERAL_ACCOUNT_INTEGRITY` | damaged general-account structure |

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
duplicate provider events. Exit code 1 when anything is found.

There is deliberately **no `--apply`**: automatic financial correction of
damaged data is more dangerous than the damage. Damaged general accounts are
reported, never re-funded.
