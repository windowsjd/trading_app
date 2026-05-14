> Historical document.
> This file is not the current source of truth.
> See `docs/current-status.md`, `docs/backend-gate-roadmap.md`, and the relevant API contract or provider policy document.

# Season Join Ledger Plan

## Status
- KRW `initial_grant` wallet ledger is implemented for `joinSeason`.
- Dev seed ledger consistency is implemented with deterministic wallet transaction id `wtx_initial_grant_dev_001`.
- USD 0 amount wallet ledger row remains deferred.
- Do not add Prisma schema changes, migrations, fake data, backfill data, or API contract changes from this document.

## Source Rules
- Season join creates the participant's starting cash wallets.
- Financial values are exposed through APIs as strings.
- `wallet_transactions` is the wallet balance ledger source for future audit and reconciliation.
- Prisma 7 adapter style and `PrismaService` reuse must be preserved in future implementation.

## Current Behavior
- On successful season join, `joinSeason` creates:
  - KRW wallet with `balanceAmount = season.initialCapitalKrw`
  - USD wallet with `balanceAmount = 0`
- Current `joinSeason` code creates one KRW `initial_grant` `wallet_transactions` row.
- Current seed data creates a dev participant, KRW/USD wallets, and one deterministic KRW `initial_grant` `wallet_transactions` row.

## Why Initial Grant Ledger Is Needed
- `cash_wallets.balanceAmount` stores the current wallet balance only.
- If `wallet_transactions` is used as a trustworthy ledger, the KRW starting balance must be represented by a durable ledger row.
- Without the initial grant row, future ledger reconciliation would see a KRW wallet balance that did not originate from the wallet ledger.

## Initial Grant Row
When season join succeeds, create one KRW wallet ledger row in the same DB transaction as the participant and wallet creation.

- `seasonParticipantId`: created `seasonParticipant.id`
- `walletId`: KRW wallet id
- `currencyCode`: `KRW`
- `direction`: `credit`
- `txType`: `initial_grant`
- `referenceType`: `season_join`
- `referenceId`: `seasonParticipant.id`
- `amount`: `initialCapitalKrw`
- `balanceAfter`: `initialCapitalKrw`
- `occurredAt`: `joinedAt`

## USD Wallet Ledger Decision
- Prefer not creating a USD ledger row for MVP because the USD wallet starts at 0.
- A zero-amount row may be useful if the product needs an explicit wallet-created audit trail.
- Whether to create a 0 amount USD row is a deferred question.
- If a 0 amount row is later required, agree first on whether `amount = 0` is valid for `wallet_transactions` and how reconciliation treats zero rows.

## Seed Data Decision
- Dev seed creates the matching KRW `initial_grant` row.
- Dev seed uses deterministic wallet transaction id `wtx_initial_grant_dev_001` so repeated seed runs do not create duplicate ledger rows.
- Dev seed uses a stable `joinedAt` so `occurredAt` remains stable.

## Implementation Boundary
- `joinSeason` keeps participant creation, KRW/USD wallet creation, and the KRW initial grant ledger row inside one DB transaction.
- USD 0 amount ledger row is not implemented.
- No API response shape changes are made by this ledger implementation.
