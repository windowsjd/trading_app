# Season Join Ledger Plan

## Status
- This document fixes the near-term initial grant wallet ledger rule for agreement.
- This is documentation only.
- Do not implement `joinSeason` ledger writes or seed ledger writes from this document in this step.
- Do not add Prisma schema changes, migrations, seed changes, fake data, backfill data, or API contract changes from this document.

## Source Rules
- Season join creates the participant's starting cash wallets.
- Financial values are exposed through APIs as strings.
- `wallet_transactions` is the wallet balance ledger source for future audit and reconciliation.
- Prisma 7 adapter style and `PrismaService` reuse must be preserved in future implementation.

## Current Behavior
- On successful season join, `joinSeason` creates:
  - KRW wallet with `balanceAmount = season.initialCapitalKrw`
  - USD wallet with `balanceAmount = 0`
- Current `joinSeason` code does not create `wallet_transactions` rows.
- Current seed data creates a dev participant and KRW/USD wallets, but does not create `wallet_transactions` rows.

## Why Initial Grant Ledger Is Needed
- `cash_wallets.balanceAmount` stores the current wallet balance only.
- If `wallet_transactions` is used as a trustworthy ledger, the KRW starting balance must be represented by a durable ledger row.
- Without the initial grant row, future ledger reconciliation would see a KRW wallet balance that did not originate from the wallet ledger.

## Initial Grant Row Candidate
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
- Dev seed currently creates a participant and wallets without ledger rows.
- If seed participants are expected to be ledger-consistent, seed should also create the matching KRW `initial_grant` row.
- Whether seed should create ledger rows is a separate implementation decision.
- This task does not change seed data.

## Implementation Boundary
- Do not update `joinSeason` in this step.
- Do not update `prisma/seed.ts` in this step.
- Actual initial grant ledger implementation should be a separate follow-up task.
- Future implementation should keep participant creation, KRW/USD wallet creation, and the KRW initial grant ledger row inside one DB transaction.
