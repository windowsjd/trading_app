# Wallet transfers and order cash provenance

Current policy (2026-10-07): new `AssetType.crypto` orders are Spot and use
`crypto_spot/USD`. Stocks use Securities KRW/USD. FX remains Securities
KRW ↔ USD. Crypto Futures supports USD storage and explicit transfers, including
the atomic FX + transfer command below. [Futures F1/F2](futures-api-contract.md) is
development-only and default OFF. Futures-source USD transfers (including the
reverse FX+Transfer leg) additionally check balance minus reservations minus the
sum of open isolated margins under the same wallet lock. With Cross positions,
post-transfer equity must cover the current Mark initial requirement and remain
strictly above maintenance plus normal close fee. Missing/stale Mark evidence
rejects both outgoing routes. Incoming transfers are allowed without Mark evidence.
See [F2 collateral and liquidation](futures-risk-contract.md). Margin never uses `reservedAmount`, and this protection applies even
with Futures trading OFF.

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

## Cross-currency quote → execute (2026-10-07)

Supported routes: Securities KRW ↔ Crypto Spot USD and Securities KRW ↔ Crypto
Futures USD. Securities KRW ↔ Securities USD uses the existing `fx/quote` and
`fx/execute` surface, never the transfer surface. Crypto wallets remain USD-only.

`POST /api/v1/trading-accounts/:accountId/wallet-transfers/quote` accepts
`sourceWalletId`, `destinationWalletId`, `amount`. Amount always names the
original source wallet's currency. The server returns the existing FX quote
fields plus `tradingAccountId`, `sourceWalletId`, `destinationWalletId`.
`sourceAmount`, `appliedRate`, `feeRate`, `feeAmount`, `feeCurrency`,
`grossTargetAmount`, `netTargetAmount`, `expiresAt`, `maxChangeBps` and public
provider evidence are canonical. Route identities are stored in a typed
`WalletTransferQuote` extension of the existing durable FX Quote. The existing
Quote pins the account, currencies/direction, amount, fee, rate, received amount,
snapshot and expiry. Standalone FX cannot consume a transfer quote.

`POST /api/v1/trading-accounts/:accountId/wallet-transfers/execute` accepts only
`quoteId`, `idempotencyKey`. Clients never submit a rate, fee or received amount.
The committed response includes `commandId`, `quoteId`, `tradingAccountId`,
`executedAt`, `sourceAmount`, `receivedAmount`, original source/destination
(`walletId`, `walletScope`, `currencyCode`, `balanceAfter`, `availableAfter`),
the full actual `fx` execution and `transferId`. Same account/key/quote replays
the exact committed response; another quote conflicts. Ownership is always
checked; replay precedes mutable lifecycle and provider gates.

Provider refresh/network work finishes before the transaction. Execution locks
Quote → lifecycle (General account FOR UPDATE, or Season → account → participant
FOR NO KEY UPDATE) → all three wallets in ID order. One post-lock DB wall clock
governs eligibility, expiry, DB-only fresh provider reselection and repricing.
All FX calculation/fee pinning/round8/maxChangeBps policies are the existing FX
policies. A changed rate beyond the quote's bound requires a new quote.

KRW → Crypto: Securities FX first, then transfer exactly FX `netTargetAmount`
USD to Crypto. Crypto → KRW: transfer exactly source USD into Securities USD,
then FX exactly that amount. Available balance checks protect the original
source and each debit; newly routed cash is usable without touching reservations.

One PostgreSQL transaction commits or rolls back the quote consume, both cash
legs of FX, both cash legs of Transfer, FxExecuteRequest, ExchangeTransaction,
WalletTransfer, four distinct ledger legs, FX valuation snapshot and composite
WalletTransferExecuteRequest. The parent links the quote, ExchangeTransaction
(and its FxExecuteRequest) and WalletTransfer through typed foreign keys.
Internal leg keys are server-generated from the parent UUID; client retry uses
only the parent's account/key. Each ledger balanceAfter follows mutation order.

Transfer is performance-neutral; the FX fee/repricing has the same economic
effect as standalone FX followed/preceded by an internal USD transfer. The
ordinary `exchange_executed` snapshot uses existing valuation/TWR; no external
funding boundary or performance formula is added. Client success invalidates
the acting account's wallets/ledger and portfolio/equity/performance plus Season
ranking when applicable. FX records remain visible in the existing server FX
history API and wallet ledger; the current UI has no separately cached FX history
query. Same-currency and standalone FX APIs remain intact.
No automatic FX, order auto-funding or central wallet exists. Futures trading has
its own default-OFF Futures command; it is not part of these transfer APIs.

Schema additions use a new migration only. Applied migration
`20261006160000_pin_order_wallet_and_add_transfers` must never be rewritten.
Apply `20261007120000_add_cross_currency_wallet_transfers` and deploy new
financial writers before enabling the new transfer routes. An old FX writer
does not reject linked transfer quotes and must not run alongside this feature.
