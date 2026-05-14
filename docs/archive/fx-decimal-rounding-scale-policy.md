> Historical document.
> This file is not the current source of truth.
> See `docs/current-status.md`, `docs/backend-gate-roadmap.md`, and the relevant API contract or provider policy document.

# FX Decimal Rounding And Scale Policy

## Status
- Documentation only.
- `/fx execute` remains STOP.
- Decimal rounding mode and scale/formatting policy are accepted for future implementation prompts.
- This document is not permission to implement `/fx execute`.
- No code/schema/migration/package changes.

## Purpose
- Prevent calculation drift between quote and execute.
- Prevent mismatch between wallet balances and `wallet_transactions.balanceAfter`.
- Prevent mismatch between `exchange_transactions` stored values and response/records values.
- Preserve original transaction values so ranking and settlement can be recalculated from durable records later.
- Prevent precision errors caused by JS number arithmetic.

## Current schema scale baseline
- `Season.initialCapitalKrw`: `Decimal(24, 8)`
- `Season.tradeFeeRate`: `Decimal(10, 6)`
- `Season.fxFeeRate`: `Decimal(10, 6)`
- `SeasonParticipant.initialCapitalKrw`: `Decimal(24, 8)`
- `SeasonParticipant.totalAssetKrw`: `Decimal(24, 8)`
- `SeasonParticipant.totalReturnRate`: `Decimal(12, 8)`
- `SeasonParticipant.maxDrawdown`: `Decimal(12, 8)`
- `CashWallet.balanceAmount`: `Decimal(24, 8)`
- `WalletTransaction.amount`: `Decimal(24, 8)`
- `WalletTransaction.balanceAfter`: `Decimal(24, 8)`
- `ExchangeTransaction.sourceAmount`: `Decimal(24, 8)`
- `ExchangeTransaction.grossTargetAmount`: `Decimal(24, 8)`
- `ExchangeTransaction.feeRate`: `Decimal(10, 6)`
- `ExchangeTransaction.feeAmount`: `Decimal(24, 8)`
- `ExchangeTransaction.appliedRate`: `Decimal(18, 8)`
- `ExchangeTransaction.netTargetAmount`: `Decimal(24, 8)`
- `FxRateSnapshot.rate`: `Decimal(18, 8)`
- `FxExecuteRequest.sourceAmount`: `Decimal(24, 8)`
- `EquitySnapshot.totalAssetKrw`: `Decimal(24, 8)`
- `EquitySnapshot.krwCash`: `Decimal(24, 8)`
- `EquitySnapshot.usdCashKrw`: `Decimal(24, 8)`
- `EquitySnapshot.domesticStockValueKrw`: `Decimal(24, 8)`
- `EquitySnapshot.usStockValueKrw`: `Decimal(24, 8)`
- `EquitySnapshot.cryptoValueKrw`: `Decimal(24, 8)`
- `EquitySnapshot.returnRate`: `Decimal(12, 8)`

## Accepted calculation policy
- API request financial amount values are accepted only as strings.
- Do not use JS number for money, FX rate, fee rate, wallet balance, ledger, ranking, or settlement calculations.
- Use `Prisma.Decimal` or a Decimal-compatible calculation path only.
- `appliedRate` means KRW per 1 USD.
- KRW -> USD: `grossTargetAmount = sourceAmount / appliedRate`.
- USD -> KRW: `grossTargetAmount = sourceAmount * appliedRate`.
- `feeAmount = grossTargetAmount * feeRate`.
- `netTargetAmount = grossTargetAmount - feeAmount`.
- `feeCurrency` is the target currency.
- Target wallet credit is `netTargetAmount`.
- MVP creates no separate fee wallet transaction row.

## Accepted storage scale policy
- Wallet/cash/exchange monetary amounts: store at scale 8.
- FX rate: store at scale 8.
- `feeRate`: store at scale 6.
- API financial amount response values use scale 8 strings.
- API rate response values use scale 8 strings.
- API `feeRate` response values use scale 6 strings.
- `returnRate` and `maxDrawdown` response values use scale 8 strings.

## Accepted rounding mode
- Rounding mode: half-up.
- For positive monetary values, if the first discarded digit is 5 or greater, round up.
- Internal calculations must use sufficient Decimal precision.
- Explicitly half-up round to the target column scale immediately before DB storage.
- API responses return strings with the same scale as DB stored values or values that will be stored.
- Wallet update amount and `wallet_transactions.amount` use the same rounded value.
- `wallet_transactions.balanceAfter` uses the actual post-update wallet balance.
- `exchange_transactions.grossTargetAmount`, `feeAmount`, and `netTargetAmount` must match the execute response.
- Quote, execute, records, ranking, and settlement must apply the same half-up policy.

## Rejected alternatives
- half-even:
  - Benefit: can reduce cumulative rounding bias.
  - Rejected for MVP default because user/game display intuition is lower than half-up.
- truncate/down:
  - Benefit: mechanically simple.
  - Rejected for MVP default because it can appear unfavorable to users and increases fairness explanation burden.

## Defect scenarios
- Quote and execute use different rounding and differ by `0.00000001`.
- Wallet balance stores a pre-rounded value while ledger stores a rounded value.
- `feeAmount` rounding makes `netTargetAmount` disagree with target wallet credit.
- Records display rebuilt from `exchange_transactions` disagrees with the original execute response.
- Ranking or settlement recalculation disagrees with original transaction values.
- JS number arithmetic loses precision for large or highly fractional values.
- Half-up boundary values are not tested, so values ending in discarded digit 5 drift from expected behavior.

## Required tests before implementation
Do not add these tests in this documentation task.

- KRW -> USD exact division case.
- KRW -> USD repeating decimal case.
- USD -> KRW multiplication case.
- `feeAmount` rounding boundary.
- Half-up boundary where first discarded digit is 5.
- Half-up boundary where first discarded digit is below 5.
- `netTargetAmount = grossTargetAmount - feeAmount`.
- Target wallet credit equals `netTargetAmount`.
- Source wallet debit equals `sourceAmount`.
- `wallet_transactions.balanceAfter` equals actual wallet balance.
- Response scale formatting.
- DB stored values equal response values.
- No JS number precision drift.

## Explicit non-goals
- No implementation.
- No schema/migration changes.
- No package changes.
- No seed changes.
- No fake rates.
