# Completed trades for sharing (수익 공유) — API contract

2026-11-06. Read only. Feeds the app's 수익 공유 card (거래 내역 › 거래 완료):
the owner's own confirmed trade results, with the stored evidence the card
shows. No schema change, no write, no cache, no server-side image.

## `GET /api/v1/trading-accounts/:accountId/completed-trades`

Authenticated owner only. Ownership is resolved by
`TradingAccountAccessService.getOwnedAccountOrThrow`: another user's account
and a missing account are the same `404 TRADING_ACCOUNT_NOT_FOUND`; no
session is `401 UNAUTHORIZED`. Status-blind like every owner record read: an
ended or settled season account still lists its trades. Every read is one
`RepeatableRead` snapshot of that single account — nothing from another
account (general, season or beginner) is ever mixed in.

```json
{
  "success": true,
  "data": {
    "tradingAccountId": "…",
    "hasMore": false,
    "items": [
      {
        "kind": "futures",
        "key": "futures:<positionId>",
        "assetId": "…", "symbol": "BTCUSDT", "name": "Bitcoin", "market": "BINANCE",
        "direction": "long",
        "currencyCode": "USD",
        "entryMargin": "6100.00000000",
        "realizedPnl": "2475.40000000",
        "returnRate": "40.58032787",
        "positionId": "…",
        "leverage": 10,
        "marginMode": "isolated",
        "closeKind": "closed",
        "completedAt": "2026-11-05T12:00:00.000Z",
        "averageEntryPrice": "61000.00000000",
        "averageExitPrice": "63600.00000000",
        "displayPriceDecimals": 1
      },
      {
        "kind": "spot",
        "key": "spot:<assetId>",
        "assetId": "…", "symbol": "005930", "name": "Samsung Electronics",
        "market": "KRX", "assetType": "domestic_stock",
        "currencyCode": "KRW",
        "buyAmount": "1061060.00000000",
        "realizedPnl": "62815.00000005",
        "returnRate": "5.92002337",
        "completedAt": "2026-11-05T12:44:04.000Z",
        "averageBuyPrice": "70666.66666667",
        "averageSellPrice": "75000.00000000",
        "displayPriceDecimals": null
      }
    ]
  }
}
```

Newest completion first, at most 30 (`hasMore` when older ones exist), the
same bound as the friend list.

## What a completed trade is, and its figures

The result and the return rate are the existing 거래 완료 종목 policy
(`friends-api-contract.md`, `src/friends/friend-completed-trades.ts`): the
same `summarizeSpotCompletedTrade` / `summarizeFuturesCompletedTrade`
functions run on the owner's rows. Nothing is recomputed or unified across
kinds:

- **Spot** — an asset whose aggregate position is closed now (quantity 0).
  `realizedPnl` is the position's own confirmed realized PnL (fees included);
  `buyAmount` is the net amount (fee included) of every executed BUY of that
  position; `returnRate = realizedPnl / buyAmount × 100`. Re-entries and
  partial sells of the asset add up once (one aggregate position per asset);
  a holding open again is not complete and is not listed.
- **Futures** — one closed position lifetime (two-way: one per direction).
  `realizedPnl` is the lifetime's confirmed realized PnL less every fee of
  that lifetime (executions and a liquidation or season-final close);
  `entryMargin = ceil(Σ open/increase notional / leverage, 8 dp)`;
  `returnRate = realizedPnl / entryMargin × 100`. A reopened direction is a
  new lifetime, so a new item.
- `returnRate` is null when the basis is not above zero. Amounts stay in the
  trade's own currency (`currencyCode`; Futures settle in USD). No FX.
- An item whose stored rows do not reconcile (quantities in vs out, a missing
  net amount, realized PnL vs its parts, more than one open) is left out,
  never guessed.

**General account reset.** A general reset re-bases every closed Spot
position's realized PnL to 0 (`general-account-reset.service.ts`); the orders
before it belong to the ended epoch. The owner read therefore only sums Spot
orders executed after the account's latest reset (`resetAt`). An asset not
completed again since the reset is not listed. Futures lifetimes are their own
rows and are unaffected. Season and beginner accounts have no reset.

## Share evidence (owner only)

The friend surface never returns these; the owner sees them for their own
trade:

| Field | Spot | Futures |
| --- | --- | --- |
| `key` | `spot:<assetId>` | `futures:<positionId>` |
| `completedAt` | last executed SELL of the position (in the epoch) | lifetime `closedAt` |
| prices | `averageBuyPrice` / `averageSellPrice` = Σ gross amount / Σ executed quantity of that side's executed orders | `averageEntryPrice` = Σ(price × quantity) / Σ quantity of open/increase executions; `averageExitPrice` = the same over reduce/close executions plus a liquidation or season-final close row |
| other | `assetType` | `positionId`, `leverage` (the lifetime's stored leverage, i.e. after an approved change), `marginMode`, `closeKind` (`closed` / `liquidated` / `season_closed`) |
| `displayPriceDecimals` | Binance symbol tick decimals, else null (KRW/USD defaults) | the instrument's display decimals (futures catalog) |

Prices are quantity-weighted averages of stored executions, 8 dp half up,
display only — they are not the realized PnL basis (that is the policy above,
with fees). A side with any order lacking its stored gross amount has a null
price; the app shows no figure rather than an estimate.

## Not part of this contract

No order, execution or ledger row, fee line, quantity, wallet or margin
balance is returned. Nothing is pushed, stored, rendered or shared by the
server: the card image is made on the device, and posting is always the
user's own action in the target app.
