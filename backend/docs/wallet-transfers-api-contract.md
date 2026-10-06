# Same-currency wallet transfers and order cash provenance

Current policy (2026-10-07): new `AssetType.crypto` orders are Spot and use
`crypto_spot/USD`. Stocks use Securities KRW/USD. FX remains Securities
KRW ↔ USD. Crypto Futures supports cash storage and USD internal transfers
only; Futures trading and combined FX + transfer are unsupported.

## Durable order identity

Quote and Order pin `cashWalletScope`. Together with their required
`tradingAccountId` and settlement `currencyCode`, this names exactly one
CashWallet through the existing composite unique key. No currency-only lookup
or asset-type inference is permitted during order execution/cancellation.
Order inherits the quote's identity. A missing/unsupported identity fails closed.
Existing orders and order quotes are backfilled to Securities, including active
quotes and submitted BUY/SELL orders. This preserves pre-deployment quotes and
reservations through terminal state; balances, reservations and Positions do
not move. Request hashes remain compatible: they identify client intent and
the immutable quote ID; cash policy is server-pinned evidence, not a client input.

Deploy with financial writers stopped: apply migration, deploy the new server,
then resume writers. Old writers cannot run after the provenance migration.

## POST /api/v1/trading-accounts/:accountId/wallet-transfers

Authenticated owner only. Body:

```json
{
  "sourceWalletId": "uuid",
  "destinationWalletId": "uuid",
  "amount": "500.00000000",
  "idempotencyKey": "client-command-key"
}
```

Both rows must be distinct canonical USD wallets in this account (Securities,
Crypto Spot, Crypto Futures). Other accounts/users, General ↔ Season and KRW
are rejected. Amount is a positive decimal string with at most eight fractional
digits, within Decimal(24,8). No fees, rates, conversions or automatic fallback.

Response `success/data`: `tradingAccountId`, `transferId`, `currencyCode=USD`,
`amount`, `executedAt`, `source` and `destination` (walletId, walletScope,
balanceAfter, availableAfter). Replay returns the exact committed first response,
including its original balances. Same account/key with different canonical
request returns 409 `WALLET_TRANSFER_IDEMPOTENCY_CONFLICT`.

New writes use the existing locked finance eligibility policy: active General
account with foundation/TWR integrity, or active Season account/participant
inside the active season window. Committed replay precedes mutable status gates.
After waiting for wallet locks, committed replay is checked again before the
post-lock season deadline guard; an identical successful command remains
replayable even if the season ends during the wait. New commands remain blocked.
Ownership is checked on every request, including replay.

One PostgreSQL transaction records the transfer, conditionally debits
`balance - reserved >= amount`, credits the destination and writes both ledger
legs. Lifecycle locks precede wallet locks, and wallets are locked in ID order.
General transfers take the existing account finance fence. Each mutation and
failure diagnosis verifies the exact expected account, wallet scope and currency.
Failure rolls back every leg and command; failed requests may be retried.

Ledger: `txType=wallet_transfer`, `referenceType=wallet_transfer`,
`referenceId=WalletTransfer.id`, one debit and one credit with the same amount
and timestamp. WalletTransfer stores both wallet IDs, so the event identifies
source and destination. The account ledger includes all canonical wallet scopes
and adds `walletId`, `walletScope` and `transfer` source/destination metadata;
references and leg identities are validated before returning. It is internal cash relocation, never external funding.
No portfolio formula, TWR boundary, position, snapshot or ranking is changed.
Equal total cash and Positions therefore retain total assets, PnL and returns.

Errors: 400 `INVALID_WALLET_TRANSFER` (shape, amount, same wallet), 404
`WALLET_TRANSFER_WALLET_NOT_FOUND` (missing/foreign wallet), 400
`WALLET_TRANSFER_USD_ONLY`, 409 `INSUFFICIENT_AVAILABLE_BALANCE`, plus existing
account/season/participant/integrity errors. All financial values are strings.
