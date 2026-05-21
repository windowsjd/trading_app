# GET /api/v1/home API Contract

## Status

- `GET /api/v1/home` read-only MVP is implemented.
- The active joined dashboard now implements `summary`, `ranking`, `walletSummary`, `allocation`, `topPositions`, and `equityChart` when the required DB/admin_manual data exists.
- Settled joined Home now implements an authoritative final-result read model from existing `rankType=final` `season_rankings`, with `daily_portfolio_snapshots` used only as supporting chart data.
- The implemented MVP uses only existing DB rows, approved `admin_manual` market data, live valuation foundation, and existing `daily_portfolio_snapshots` when possible.
- Provider ingestion, cron scheduler, automatic snapshot/ranking generation, settlement write-policy extensions, final tier assignment, and reward grants remain STOP.
- Do not add fake data, temporary runtime contracts, Prisma schema changes, migrations, or seed changes from this draft.

## Source Rules

- Amount values are strings.
- Timestamps are UTC ISO strings.
- Responses keep the existing `success/data` or `success/error` structure.
- Home is a single aggregate API.
- Season non-participation is not an empty portfolio. It is a blocked/guide state.
- Season ended and settled states block trading and exchange.
- Final evaluation is based on total assets in KRW.
- MVP crypto is Binance-based USD-settled crypto and uses the USD Wallet.
- Crypto KRW valuation is crypto USD price x quantity x USD/KRW rate.
- `cryptoValueKrw` means KRW-converted value of crypto positions; `totalAssetKrw` and `returnRate` remain KRW-based.

## Common Success Shape

All successful `/home` responses use a top-level `mode` so the frontend can choose the correct screen state.
`partial error` is not a `mode`; it is a section-level state inside an otherwise successful response.
`full error` does not use this shape and follows the common error envelope.

```json
{
  "success": true,
  "data": {
    "mode": "active_joined | active_not_joined | upcoming | ended | settled_joined | settled_not_joined | no_current_season",
    "season": {
      "id": "<string>",
      "name": "<string>",
      "status": "active | upcoming | ended | settled",
      "startAt": "<UTC ISO string>",
      "endAt": "<UTC ISO string>"
    }
  }
}
```

## Section State Pattern

Sections that cannot truthfully return data must expose their state instead of fake values.

```json
{
  "state": "available | blocked | unavailable | error",
  "reason": "<string>",
  "message": "<string>"
}
```

## active + joined

### Purpose

Show the full home dashboard for a user who joined the active season.

### Usage Condition

- Current season status is `active`.
- `season_participants` exists for `request.user.userId` and the current season.

### Success Response JSON Shape

This is the target full response candidate. It is implemented only where the required DB/admin_manual data exists; otherwise section-level unavailable responses are returned without fake fallback values.

```json
{
  "success": true,
  "data": {
    "mode": "active_joined",
    "season": {
      "id": "<string>",
      "name": "<string>",
      "status": "active",
      "startAt": "<UTC ISO string>",
      "endAt": "<UTC ISO string>"
    },
    "summary": {
      "state": "available",
      "totalAssetKrw": "<amount string>",
      "cashKrw": "<amount string>",
      "cashUsd": "<amount string>",
      "assetValueKrw": "<amount string>",
      "totalReturnRate": "<decimal string>",
      "maxDrawdown": "<decimal string>"
    },
    "ranking": {
      "state": "available",
      "currentRank": "<number>",
      "totalParticipants": "<number>",
      "tier": "<string | null>"
    },
    "allocation": {
      "state": "available",
      "items": [
        {
          "label": "<string>",
          "amountKrw": "<amount string>",
          "rate": "<decimal string>",
          "percentage": "<decimal string>"
        }
      ]
    },
    "topPositions": {
      "state": "available",
      "items": [
        {
          "assetId": "<string>",
          "symbol": "<string>",
          "name": "<string>",
          "market": "<string>",
          "assetType": "domestic_stock | us_stock | crypto",
          "currencyCode": "KRW | USD",
          "quantity": "<decimal string>",
          "positionValueKrw": "<amount string>",
          "returnRate": "<decimal string>"
        }
      ]
    },
    "equityChart": {
      "state": "available",
      "items": [
        {
          "date": "<YYYY-MM-DD>",
          "snapshotDate": "<YYYY-MM-DD>",
          "totalAssetKrw": "<amount string>",
          "returnRate": "<decimal string>",
          "capturedAt": "<UTC ISO string>"
        }
      ]
    },
    "sectionErrors": []
  }
}
```

### Frontend Meaning

Render the normal joined-season home dashboard. Trading and exchange entry points may be shown because the season is active.

### Currently Implementable Fields

- `season.id`
- `season.name`
- `season.status`
- `season.startAt`
- `season.endAt`
- `participant.id`
- `participant.status`
- `participant.joinedAt`
- `participant.initialCapitalKrw`
- `summary` from latest `daily_portfolio_snapshots` when present.
- `summary` from `PortfolioValuationService.calculateSeasonParticipantValuation()` when snapshot is absent and required price/FX data exists.
- `ranking` from latest `season_rankings` when present.
- `walletSummary.cashWallets`
- `walletSummary.positionsCount`
- `walletSummary.openPositionsCount`
- `allocation` from live valuation based on existing wallets, positions, latest eligible `admin_manual` asset price snapshots, and fresh approved `admin_manual` USD/KRW when needed.
- `topPositions` from existing open positions, latest eligible `admin_manual` asset price snapshots, and fresh approved `admin_manual` USD/KRW when needed.
- `equityChart` from existing `daily_portfolio_snapshots`.

### Currently Not Implementable Fields

- automatic data freshness from scheduler/batch

### Required Preceding Tables

- `wallet_transactions`
- `exchange_transactions`
- `equity_snapshots`
- `assets`
- `asset_price_snapshots`
- `fx_rate_snapshots`
- `positions`
- `daily_portfolio_snapshots`
- `season_rankings`

### Read-Only MVP Shape

The implemented MVP may return available summary/ranking sections or explicit unavailable sections.

```json
{
  "success": true,
  "data": {
    "mode": "active_joined",
    "season": {
      "id": "<string>",
      "name": "<string>",
      "status": "active",
      "startAt": "<UTC ISO string>",
      "endAt": "<UTC ISO string>"
    },
    "participant": {
      "id": "<string>",
      "status": "<string>",
      "joinedAt": "<UTC ISO string>",
      "initialCapitalKrw": "<amount string>"
    },
    "summary": {
      "state": "available",
      "valuationSource": "daily_snapshot | live_valuation",
      "totalAssetKrw": "<amount string>",
      "returnRate": "<decimal string>",
      "krwCash": "<amount string>",
      "usdCashKrw": "<amount string>",
      "assetValueKrw": "<amount string>",
      "realizedPnlKrw": "<amount string>",
      "unrealizedPnlKrw": "<amount string>",
      "valuationCapturedAt": "<UTC ISO string | only daily_snapshot>",
      "valuationAt": "<UTC ISO string | only live_valuation>",
      "dataFreshness": {
        "status": "available",
        "asOf": "<UTC ISO string>"
      }
    },
    "ranking": {
      "state": "available",
      "rankingSource": "season_rankings",
      "currentRank": "<number>",
      "totalParticipants": "<number>",
      "rankedParticipants": "<number>",
      "rankType": "daily | final",
      "rankingDate": "<YYYY-MM-DD>",
      "totalAssetKrw": "<amount string>",
      "returnRate": "<decimal string>",
      "capturedAt": "<UTC ISO string>"
    },
    "walletSummary": {
      "state": "available",
      "cashWallets": [
        {
          "currencyCode": "KRW | USD",
          "balanceAmount": "<amount string>"
        }
      ],
      "positionsCount": "<number>",
      "openPositionsCount": "<number>"
    },
    "allocation": {
      "state": "available",
      "allocationSource": "live_valuation",
      "totalAssetKrw": "<amount string>",
      "valuationAt": "<UTC ISO string>",
      "items": [
        {
          "category": "krw_cash | usd_cash | domestic_stock | us_stock | crypto",
          "label": "<string>",
          "amountKrw": "<amount string>",
          "rate": "<decimal string>",
          "percentage": "<decimal string>"
        }
      ]
    },
    "topPositions": {
      "state": "available",
      "positionsSource": "positions",
      "valuationAt": "<UTC ISO string>",
      "limit": 5,
      "items": [
        {
          "positionId": "<string>",
          "assetId": "<string>",
          "symbol": "<string>",
          "name": "<string>",
          "market": "<string>",
          "assetType": "domestic_stock | us_stock | crypto",
          "currencyCode": "KRW | USD",
          "quantity": "<decimal string>",
          "averageCost": "<amount string>",
          "currentPrice": "<amount string>",
          "priceCurrency": "KRW | USD",
          "positionValueKrw": "<amount string>",
          "unrealizedPnlKrw": "<amount string>",
          "returnRate": "<decimal string>",
          "assetPriceSnapshotId": "<string>",
          "priceEffectiveAt": "<UTC ISO string>",
          "priceCapturedAt": "<UTC ISO string>"
        }
      ]
    },
    "equityChart": {
      "state": "available",
      "chartSource": "daily_portfolio_snapshots",
      "limit": 30,
      "items": [
        {
          "snapshotDate": "<YYYY-MM-DD>",
          "date": "<YYYY-MM-DD>",
          "totalAssetKrw": "<amount string>",
          "returnRate": "<decimal string>",
          "capturedAt": "<UTC ISO string>"
        }
      ]
    },
    "sectionErrors": []
  }
}
```

If daily snapshot and live valuation are both unavailable, `summary` is returned as:

```json
{
  "state": "unavailable",
  "reason": "<valuation error code>",
  "message": "Portfolio valuation is unavailable because required market data is missing.",
  "valuationSource": "unavailable",
  "dataFreshness": {
    "status": "unavailable",
    "reason": "<valuation error code>"
  }
}
```

### Implementation Decision

Read-only MVP is implemented for active joined `summary`, `ranking`, `walletSummary`, `allocation`, `topPositions`, and `equityChart`.

- `allocation` uses live valuation and returns unavailable when required `admin_manual` asset price is missing/not eligible, or fresh approved `admin_manual` USD/KRW data is missing or stale. `percentage` is a 0-100 decimal string, and `rate` is the 0-1 decimal fraction.
- `topPositions` excludes zero-quantity positions, uses latest eligible `admin_manual` asset prices, converts USD assets with fresh approved `admin_manual` USD/KRW, sorts by `positionValueKrw` descending, and limits to 5.
- `equityChart` reads the latest 30 existing `daily_portfolio_snapshots` and returns them in chronological order. It does not synthesize live valuation chart points and does not create snapshots.
- Provider ingestion, scheduler/batch, settlement, reward, fake/static/sample business data, Prisma schema changes, migrations, and seed changes remain out of scope.

## active + not joined

### Purpose

Guide the user to join the active season without showing fake portfolio data.

### Usage Condition

- Current season status is `active`.
- No `season_participants` row exists for `request.user.userId` and the current season.

### Success Response JSON Shape

```json
{
  "success": true,
  "data": {
    "mode": "active_not_joined",
    "season": {
      "id": "<string>",
      "name": "<string>",
      "status": "active",
      "startAt": "<UTC ISO string>",
      "endAt": "<UTC ISO string>"
    },
    "guide": {
      "state": "blocked",
      "reason": "SEASON_NOT_JOINED",
      "message": "Join the active season to start trading.",
      "action": "JOIN_SEASON"
    },
    "summary": {
      "state": "blocked",
      "reason": "SEASON_NOT_JOINED",
      "message": "Portfolio summary is available after joining."
    },
    "ranking": {
      "state": "blocked",
      "reason": "SEASON_NOT_JOINED",
      "message": "Ranking is available after joining."
    },
    "allocation": {
      "state": "blocked",
      "reason": "SEASON_NOT_JOINED",
      "message": "Allocation is available after joining."
    },
    "topPositions": {
      "state": "blocked",
      "reason": "SEASON_NOT_JOINED",
      "message": "Positions are available after joining."
    },
    "equityChart": {
      "state": "blocked",
      "reason": "SEASON_NOT_JOINED",
      "message": "Equity chart is available after joining."
    },
    "sectionErrors": []
  }
}
```

### Frontend Meaning

Render a blocked/guide state with a join action. Do not render empty portfolio, summary, ranking, allocation, positions, or chart data.

### Currently Implementable Fields

- `season`
- join status
- `guide.state`
- `guide.reason`
- `guide.action`

### Currently Not Implementable Fields

- Portfolio `summary`
- `ranking`
- `allocation`
- `topPositions`
- `equityChart`

### Required Preceding Tables

- No extra table is needed for the guide state itself.
- Full portfolio sections still require the active joined blockers.

### Implementation Decision

Guide-only shape is implemented in the read-only MVP.

## upcoming

### Purpose

Show the next season and make clear that trading is not available yet.

### Usage Condition

- Current selected season status is `upcoming`.

### Success Response JSON Shape

```json
{
  "success": true,
  "data": {
    "mode": "upcoming",
    "season": {
      "id": "<string>",
      "name": "<string>",
      "status": "upcoming",
      "startAt": "<UTC ISO string>",
      "endAt": "<UTC ISO string>"
    },
    "guide": {
      "state": "blocked",
      "reason": "SEASON_UPCOMING",
      "message": "Trading is not available before the season starts.",
      "action": null
    },
    "trading": {
      "state": "blocked",
      "reason": "SEASON_UPCOMING"
    },
    "exchange": {
      "state": "blocked",
      "reason": "SEASON_UPCOMING"
    },
    "sectionErrors": []
  }
}
```

### Frontend Meaning

Render upcoming-season information and a not-yet-open state. Trading and exchange entry points must be blocked.

### Currently Implementable Fields

- `season`
- `guide`
- `trading.state`
- `exchange.state`

### Currently Not Implementable Fields

- Portfolio `summary`
- `ranking`
- `allocation`
- `topPositions`
- `equityChart`

### Required Preceding Tables

- No extra table is needed for upcoming guide state.
- Full portfolio sections require the active joined blockers when the season becomes active.

### Implementation Decision

Guide-only shape is implemented in the read-only MVP.

## ended

### Purpose

Show that the season has ended and settlement is in progress.

### Usage Condition

- Current selected season status is `ended`.

### Success Response JSON Shape

```json
{
  "success": true,
  "data": {
    "mode": "ended",
    "season": {
      "id": "<string>",
      "name": "<string>",
      "status": "ended",
      "startAt": "<UTC ISO string>",
      "endAt": "<UTC ISO string>"
    },
    "guide": {
      "state": "blocked",
      "reason": "SEASON_ENDED_SETTLEMENT_PENDING",
      "message": "Settlement is in progress.",
      "action": null
    },
    "trading": {
      "state": "blocked",
      "reason": "SEASON_ENDED"
    },
    "exchange": {
      "state": "blocked",
      "reason": "SEASON_ENDED"
    },
    "summary": {
      "state": "unavailable",
      "reason": "SETTLEMENT_PENDING"
    },
    "ranking": {
      "state": "unavailable",
      "reason": "SETTLEMENT_PENDING"
    },
    "sectionErrors": []
  }
}
```

### Frontend Meaning

Render settlement-in-progress state. Trading and exchange must be blocked. Final result should not be shown as settled.

### Currently Implementable Fields

- `season`
- `guide`
- blocked `trading`
- blocked `exchange`

### Currently Not Implementable Fields

- Final `summary`
- Final `ranking`
- Final tier/result
- Historical `equityChart`

### Required Preceding Tables

- `daily_portfolio_snapshots`
- `equity_snapshots`
- `season_rankings`
- `fx_rate_snapshots`
- `positions`
- `asset_price_snapshots`

### Implementation Decision

Settlement-facing guide shape is implemented in the read-only MVP. Final settlement summary remains unavailable.

## settled

### Purpose

Show final season results after settlement.

### Usage Condition

- Current selected season status is `settled`.

### Success Response JSON Shape

```json
{
  "success": true,
  "data": {
    "mode": "settled_joined",
    "season": {
      "id": "<string>",
      "name": "<string>",
      "status": "settled",
      "startAt": "<UTC ISO string>",
      "endAt": "<UTC ISO string>"
    },
    "guide": {
      "state": "available",
      "reason": "SEASON_SETTLED",
      "message": "Final results are available.",
      "action": null
    },
    "trading": {
      "state": "blocked",
      "reason": "SEASON_SETTLED"
    },
    "exchange": {
      "state": "blocked",
      "reason": "SEASON_SETTLED"
    },
    "finalResult": {
      "state": "available",
      "resultSource": "season_rankings",
      "rankType": "final",
      "rank": "<number>",
      "totalParticipants": "<number>",
      "totalAssetKrw": "<amount string>",
      "returnRate": "<decimal string>",
      "rankingDate": "<YYYY-MM-DD>",
      "capturedAt": "<UTC ISO string>",
      "tier": {
        "state": "available | unavailable",
        "finalTier": "<string | only when available>",
        "code": "FINAL_TIER_UNAVAILABLE | only when unavailable",
        "message": "<string | only when unavailable>"
      },
      "reward": {
        "state": "granted | pending",
        "grantedAt": "<UTC ISO string | null>",
        "code": "REWARD_NOT_GRANTED | only when pending",
        "message": "<string | only when pending>"
      }
    },
    "equityChart": {
      "state": "available",
      "chartSource": "daily_portfolio_snapshots",
      "limit": 30,
      "items": [
        {
          "snapshotDate": "<YYYY-MM-DD>",
          "date": "<YYYY-MM-DD>",
          "totalAssetKrw": "<amount string>",
          "returnRate": "<decimal string>",
          "capturedAt": "<UTC ISO string>"
        }
      ]
    },
    "sectionErrors": []
  }
}
```

### Frontend Meaning

Render final result view. Trading and exchange must be blocked.

### Currently Implementable Fields

- `season`
- blocked `trading`
- blocked `exchange`
- `participant`
- `finalResult` from existing `season_rankings` rows where `rankType=final`
- `finalResult.totalParticipants` counted for the selected final `rankingDate`
- `finalResult.tier` as a read-only reflection of `season_participants.finalTier`
- `finalResult.reward` as a read-only reflection of `season_participants.rewardGrantedAt`
- `equityChart` from existing `daily_portfolio_snapshots`

### Currently Not Implementable Fields

- final tier assignment/calculation
- reward/payment/badge/trophy grant
- provider-backed final valuation recalculation
- automatic recovery or synthesis for missing final ranking/chart data

### Required Preceding Tables

- `season_rankings`
- `daily_portfolio_snapshots`
- `season_participants`

### Implementation Decision

Settled joined read model is implemented in the read-only MVP.

- Joined users receive `mode = settled_joined`.
- Non-participants receive `mode = settled_not_joined` with `SEASON_NOT_JOINED` guide/fallback; no final ranking lookup is performed for them.
- `finalResult` uses existing `season_rankings` as the source of truth with `seasonId`, the user's `seasonParticipantId`, and `rankType=final`.
- If multiple final ranking dates exist, Home selects the latest row by `rankingDate desc`, then `capturedAt desc`.
- `totalParticipants` is counted from final ranking rows with the same `seasonId`, `rankType=final`, and selected `rankingDate`.
- Missing final ranking returns `finalResult.state = unavailable` with `FINAL_RANKING_UNAVAILABLE`; Home does not use live valuation or participant aggregate fields as a fallback.
- Missing `finalTier` returns `finalResult.tier.state = unavailable` with `FINAL_TIER_UNAVAILABLE`; existing `finalTier` is read only.
- Missing `rewardGrantedAt` returns `finalResult.reward.state = pending` with `REWARD_NOT_GRANTED`; existing `rewardGrantedAt` is read only.
- Missing `daily_portfolio_snapshots` returns `equityChart.state = unavailable` with `FINAL_SNAPSHOT_UNAVAILABLE` but does not make `finalResult` unavailable when final ranking exists.
- Home settled read creates no wallet/order/position/snapshot/ranking/ledger/season/reward mutations.

## no current season

### Purpose

Make the home response explicit when no current season row exists.

### Success Response JSON Shape

```json
{
  "success": true,
  "data": {
    "mode": "no_current_season",
    "season": null,
    "guide": {
      "state": "unavailable",
      "reason": "CURRENT_SEASON_NOT_FOUND",
      "message": "Current season is not configured."
    },
    "sectionErrors": []
  }
}
```

### Implementation Decision

Implemented in the read-only MVP.

## partial error

### Purpose

Represent a partial section failure while keeping the home response usable.

### Usage Condition

- The base home state can be resolved.
- One or more non-critical sections fail to load.
- This is not used when the whole request cannot be authorized or the current season cannot be resolved.

### Success Response JSON Shape

This is a section-level error shape. It is not a separate home `mode`.

```json
{
  "success": true,
  "data": {
    "mode": "active_joined",
    "season": {
      "id": "<string>",
      "name": "<string>",
      "status": "active",
      "startAt": "<UTC ISO string>",
      "endAt": "<UTC ISO string>"
    },
    "summary": {
      "state": "available",
      "totalAssetKrw": "<amount string>",
      "cashKrw": "<amount string>",
      "cashUsd": "<amount string>",
      "assetValueKrw": "<amount string>",
      "totalReturnRate": "<decimal string>",
      "maxDrawdown": "<decimal string>"
    },
    "ranking": {
      "state": "error",
      "reason": "RANKING_UNAVAILABLE",
      "message": "Ranking is temporarily unavailable."
    },
    "allocation": {
      "state": "error",
      "reason": "ALLOCATION_UNAVAILABLE",
      "message": "Allocation is temporarily unavailable."
    },
    "topPositions": {
      "state": "available",
      "items": [
        {
          "assetId": "<string>",
          "symbol": "<string>",
          "name": "<string>",
          "market": "<string>",
          "quantity": "<decimal string>",
          "evaluationAmountKrw": "<amount string>",
          "returnRate": "<decimal string>"
        }
      ]
    },
    "equityChart": {
      "state": "available",
      "items": [
        {
          "date": "<YYYY-MM-DD>",
          "totalAssetKrw": "<amount string>",
          "returnRate": "<decimal string>"
        }
      ]
    },
    "sectionErrors": [
      {
        "section": "ranking",
        "code": "RANKING_UNAVAILABLE",
        "message": "Ranking is temporarily unavailable."
      },
      {
        "section": "allocation",
        "code": "ALLOCATION_UNAVAILABLE",
        "message": "Allocation is temporarily unavailable."
      }
    ]
  }
}
```

### Frontend Meaning

Render available sections and show section-level fallback states only for failed sections. Do not treat this as a full page error.

### Currently Implementable Fields

- Implemented section-level unavailable fallback for active joined `summary`, `allocation`, `topPositions`, `ranking`, and `equityChart`.
- `summary`, `allocation`, and `topPositions` add section errors when required DB/admin_manual market data is missing or stale.
- Missing `season_rankings` or `daily_portfolio_snapshots` return section-level unavailable states without creating rows.

### Currently Not Implementable Fields

- Automatic recovery, retry, or generation for missing provider/scheduler/settlement data.

### Required Preceding Tables

- Same tables as the section that failed.

### Implementation Decision

Implemented for the read-only MVP. Section fallback keeps the Home response usable without promoting missing data to fake portfolio values or full-page success data.

## full error

### Purpose

Represent a full request failure using the existing common error direction.

### Usage Condition

- Authentication fails.
- Current season cannot be resolved.
- Request cannot produce any valid home state.
- Unexpected server error prevents the entire response.

### Error Response JSON Shape

```json
{
  "success": false,
  "error": {
    "code": "<string>",
    "message": "<string>"
  }
}
```

### Frontend Meaning

Render the global error state for the page.

### Currently Implementable Fields

- Existing common error envelope direction only.

### Currently Not Implementable Fields

- `/home`-specific error code mapping is not fixed in this draft.

### Required Preceding Tables

- Not applicable for the envelope itself.

### Implementation Decision

Only the common error shape direction is documented. No `/home` error implementation in this task.

## Current Full Implementation Blockers

- provider price ingestion and provider-backed source evidence
- scheduler/batch automatic daily portfolio snapshot generation
- scheduler/batch automatic season ranking generation
- final tier assignment and reward grant integration
- richer `/ranking`, `/orders`, `/records`, `/settlement` APIs

`allocation`, `topPositions`, and `equityChart` are no longer placeholder blockers for active joined Home. They remain dependent on existing wallets, positions, latest eligible `admin_manual` asset prices, fresh approved `admin_manual` USD/KRW where needed, and existing `daily_portfolio_snapshots`.

## Near-Term Required Tables

- `wallet_transactions`
- `exchange_transactions`
- `equity_snapshots`
