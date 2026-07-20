# GET /api/v1/ranking API Contract

## Status

- `GET /api/v1/ranking` read-only MVP is implemented.
- The API reads existing `season_rankings` rows only.
- The API does not calculate rankings, generate rankings, read daily snapshots for ad hoc ranking, or run scheduler/batch behavior.
- Do not add fake ranking data or seed changes from this read API contract; persisted schema changes must go through explicit migrations.
- Ranking rows now persist and expose tie-breaker evidence: `maxDrawdown`, `totalFillCount`, and `reachedReturnAt`.
- Migration/backfill operations for existing tie-breaker rows are documented in `docs/ranking-backfill-runbook.md`.
- The separate current-ranking refresh job uses the shared portfolio valuation policy per asset: open stocks and crypto require current fresh evidence, while a closed KRX/US market may use only its latest completed session price. One market's holiday does not stop another market or crypto. Historical/final ranking rows and this read API response are unchanged.

## Source Rules

- Ranking source of truth is `season_rankings`.
- Amount values are strings.
- Timestamps are UTC ISO strings.
- Dates use `YYYY-MM-DD`.
- Responses keep the existing `success/data` or `success/error` structure.
- `season_participants.currentRank` is not used as source of truth.
- Ranking values remain KRW-based.
- `returnRate` and `maxDrawdown` are percent values formatted to scale 8. Example: 4.5% is `"4.50000000"`.
- MVP crypto is Binance-based USD-settled crypto; crypto positions must be converted from USD value to KRW using USD/KRW before contributing to `totalAssetKrw` and `returnRate`.
- Upbit/Bithumb and KRW crypto trading are not MVP ranking inputs.
- Existing rows created before the tie-breaker migration may have `reachedReturnAt = null`; clients must treat it as nullable.

## Stored Ranking Policy

Operator-run daily ranking and final settlement ranking use the same persisted policy:

1. `returnRate` descending.
2. `maxDrawdown` ascending.
3. `totalFillCount` ascending.
4. `reachedReturnAt` ascending.
5. `userId` ascending.
6. `seasonParticipantId` ascending deterministic fallback.

`maxDrawdown` is calculated from the participant's `daily_portfolio_snapshots` time series through the ranking snapshot date:

`(runningPeakTotalAssetKrw - currentTotalAssetKrw) / runningPeakTotalAssetKrw * 100`

`totalFillCount` counts only `orders.status = executed` through the ranking snapshot `capturedAt`; submitted, canceled, rejected orders and FX exchanges are excluded.

`reachedReturnAt` is the first daily snapshot `capturedAt` where the participant's snapshot `returnRate` is greater than or equal to the ranking row's `returnRate`; if no snapshot matches, the ranking snapshot `capturedAt` is used when generating new rows.

## Route

`GET /api/v1/ranking`

## Query Parameters

- `seasonId` optional.
  - If omitted, current season selection uses the same priority as `/home`: active, upcoming, ended, settled.
- `rankingDate` optional, `YYYY-MM-DD`.
  - If omitted, the latest `season_rankings.rankingDate` for the selected season and rankType is used.
- `rankType` optional.
  - Default: `daily`.
  - Allowed: `daily`, `final`.
- `capturedAt` optional, UTC ISO 8601 timestamp.
  - First-page requests may omit it; the backend selects the latest snapshot for the selected season, rankType, and rankingDate.
  - Follow-up offset pages should send the `rankingDate`, `rankType`, and `capturedAt` returned by the first page.
  - If the latest available snapshot for the same season, rankType, and rankingDate has a different `capturedAt`, the API returns `RANKING_SNAPSHOT_CHANGED` and clients should reload from the first page.
- `limit` optional.
  - Default: `50`.
  - Must be a positive integer.
  - Values greater than `100` are clamped to `100`.
- `offset` optional.
  - Default: `0`.
  - Must be a non-negative integer.

## Available Response

```json
{
  "success": true,
  "data": {
    "state": "available",
    "season": {
      "id": "<string>",
      "name": "<string>",
      "status": "active | upcoming | ended | settled",
      "startAt": "<UTC ISO string>",
      "endAt": "<UTC ISO string>"
    },
    "rankType": "daily | final",
    "rankingDate": "<YYYY-MM-DD>",
    "capturedAt": "<UTC ISO string>",
    "pagination": {
      "limit": 50,
      "offset": 0,
      "total": 100,
      "returned": 50,
      "nextOffset": 50
    },
    "rankings": [
      {
        "rank": 1,
        "seasonParticipantId": "<string>",
        "userId": "<string>",
        "nickname": "<string>",
        "profileImageUrl": "<string | null>",
        "totalAssetKrw": "<amount string>",
        "returnRate": "<decimal string>",
        "maxDrawdown": "<decimal string>",
        "totalFillCount": 0,
        "reachedReturnAt": "<UTC ISO string | null>",
        "capturedAt": "<UTC ISO string>"
      }
    ],
    "myRanking": {
      "state": "available",
      "rank": 1,
      "seasonParticipantId": "<string>",
      "totalAssetKrw": "<amount string>",
      "returnRate": "<decimal string>",
      "maxDrawdown": "<decimal string>",
      "totalFillCount": 0,
      "reachedReturnAt": "<UTC ISO string | null>",
      "rankingDate": "<YYYY-MM-DD>",
      "capturedAt": "<UTC ISO string>"
    }
  }
}
```

## Snapshot Changed Error

```json
{
  "success": false,
  "error": {
    "code": "RANKING_SNAPSHOT_CHANGED",
    "message": "Ranking snapshot changed. Please reload from the first page."
  }
}
```

Recommended HTTP status: `409 CONFLICT`.

## Unavailable Response

When no current season exists, the selected season does not exist, or no ranking rows exist:

```json
{
  "success": true,
  "data": {
    "state": "unavailable",
    "season": "<season object | null>",
    "rankType": "daily | final",
    "rankingDate": "<YYYY-MM-DD | null>",
    "capturedAt": null,
    "pagination": {
      "limit": 50,
      "offset": 0,
      "total": 0,
      "returned": 0,
      "nextOffset": null
    },
    "rankings": [],
    "myRanking": {
      "state": "unavailable",
      "reason": "<string>",
      "message": "<string>"
    },
    "reason": "<string>",
    "message": "<string>"
  }
}
```

## My Ranking States

If the logged-in user has not joined the selected season:

```json
{
  "state": "not_joined",
  "reason": "SEASON_NOT_JOINED",
  "message": "My ranking is available after joining the season."
}
```

If the user joined but has no ranking row for the selected date/type:

```json
{
  "state": "unavailable",
  "reason": "MY_RANKING_UNAVAILABLE",
  "message": "My ranking is unavailable until season rankings are generated."
}
```

## Error Response

Invalid query or missing authentication uses the existing error envelope:

```json
{
  "success": false,
  "error": {
    "code": "<string>",
    "message": "<string>"
  }
}
```

Implemented error codes:

- `UNAUTHORIZED`
- `INVALID_RANK_TYPE`
- `INVALID_RANKING_DATE`
- `INVALID_LIMIT`
- `INVALID_OFFSET`

## Not Implemented

- Ranking calculation in the API request path.
- Ranking generation in the API request path.
- Scheduler/batch execution inside this read API request path; automatic generation is handled by the ops scheduler.
- Advanced ranking filters, periods, season history views, reward/settlement integration.
