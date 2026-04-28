# GET /api/v1/home API Contract Draft

## Status
- This document is a draft for agreement only.
- `GET /api/v1/home` full implementation is currently blocked.
- Do not implement `/home` controller/service from this draft until the contract is accepted.
- Do not add fake data, temporary runtime contracts, Prisma schema changes, migrations, or seed changes from this draft.

## Source Rules
- Amount values are strings.
- Timestamps are UTC ISO strings.
- Responses keep the existing `success/data` or `success/error` structure.
- Home is a single aggregate API.
- Season non-participation is not an empty portfolio. It is a blocked/guide state.
- Season ended and settled states block trading and exchange.
- Final evaluation is based on total assets in KRW.

## Common Success Shape

All successful `/home` responses use a top-level `mode` so the frontend can choose the correct screen state.
`partial error` is not a `mode`; it is a section-level state inside an otherwise successful response.
`full error` does not use this shape and follows the common error envelope.

```json
{
  "success": true,
  "data": {
    "mode": "active_joined | active_not_joined | upcoming | ended | settled",
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

This is the target full response candidate. It is not currently implementable.

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
          "rate": "<decimal string>"
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
- `summary.cashKrw`
- `summary.cashUsd`
- raw participant fields from `season_participants`, but not as full trusted home summary

### Currently Not Implementable Fields
- `summary.assetValueKrw`
- fully trusted `summary.totalAssetKrw`
- fully trusted `summary.totalReturnRate`
- fully trusted `summary.maxDrawdown`
- `ranking`
- `allocation`
- `topPositions`
- `equityChart`

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

### Implementation Decision
Not implementable now. The full response shape is only a contract draft.

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
Guide-only shape is conceptually implementable after contract agreement, but this task does not implement it.

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
Guide-only shape is conceptually implementable after contract agreement, but this task does not implement it.

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
Not fully implementable now. Settlement-facing guide shape is only a contract draft.

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
    "mode": "settled",
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
      "totalAssetKrw": "<amount string>",
      "finalRank": "<number | null>",
      "finalTier": "<string | null>",
      "totalReturnRate": "<decimal string>"
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
- raw `finalRank`, `finalTier`, and participant aggregate fields when present, but not as trusted final settlement result

### Currently Not Implementable Fields
- trusted `finalResult.totalAssetKrw`
- trusted `finalResult.totalReturnRate`
- authoritative final ranking
- historical `equityChart`

### Required Preceding Tables
- `season_rankings`
- `daily_portfolio_snapshots`
- `equity_snapshots`
- `fx_rate_snapshots`
- `positions`
- `asset_price_snapshots`

### Implementation Decision
Not fully implementable now. Final result shape is only a contract draft.

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
- Contract only. No code implementation in this task.

### Currently Not Implementable Fields
- Any runtime section fallback behavior.

### Required Preceding Tables
- Same tables as the section that failed.

### Implementation Decision
Not implemented now. This is a contract draft for future section-level resilience.

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
- `assets`
- `asset_price_snapshots`
- `fx_rate_snapshots`
- `positions`
- `daily_portfolio_snapshots`
- `season_rankings`

## Near-Term Required Tables
- `wallet_transactions`
- `exchange_transactions`
- `equity_snapshots`
