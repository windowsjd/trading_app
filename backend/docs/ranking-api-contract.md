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

## Account scope integrity (작업 8)

Every SeasonRanking row carries BOTH `seasonParticipantId` (required) and
`tradingAccountId` (nullable until the repair converges). Every reader in this
API selects the scope columns and verifies them before returning anything.

`tradingAccountId` is INTERNAL. It is never present in a ranking, myRanking, or
near_me response — a public leaderboard does not expose another user's account
id.

Absence vs damage are different answers:

| situation | response |
| --- | --- |
| no ranking row exists for the season/date | existing `state: "unavailable"` + `RANKING_UNAVAILABLE` |
| rows exist but one has `tradingAccountId = null` | 500 `SEASON_RANKING_SCOPE_REPAIR_REQUIRED` |
| a row's account disagrees with its participant's link | 500 `SEASON_RANKING_SCOPE_MISMATCH` |
| a row is filed under a different season than its participant | 500 `SEASON_RANKING_SCOPE_MISMATCH` |
| a row is scoped to a GENERAL-mode account | 500 `SEASON_RANKING_SCOPE_MISMATCH` |
| a row's account owner differs from its participant's user | 500 `SEASON_RANKING_SCOPE_MISMATCH` |
| two rows in one set share one account | 500 `SEASON_RANKING_SCOPE_MISMATCH` |
| a row's participant has no account link at all | 500 `TRADING_ACCOUNT_LINK_INTEGRITY` |

A damaged row is NOT dropped from the page and the survivors are NOT renumbered.
Omitting one competitor shifts every rank below them and produces a leaderboard
that is wrong in a way nobody can see, so the whole set fails closed instead.

Recovery is operator-driven: `pnpm trading-accounts:repair-links --apply` then
`pnpm trading-accounts:repair-ranking-scope --apply`. Nothing here is
auto-corrected.

Additional error codes:

- `SEASON_RANKING_SCOPE_REPAIR_REQUIRED` (500)
- `SEASON_RANKING_SCOPE_MISMATCH` (500)
- `TRADING_ACCOUNT_LINK_INTEGRITY` (500)

Ranking ORDER is unchanged by this work: returnRate desc → maxDrawdown asc →
totalFillCount asc → target-return reach time → userId → seasonParticipantId,
with sequential ranks (1, 2, 3, 4) and no competition ties. Season returnRate is
still the initial-capital ratio, never TWR. Tier ratios are unchanged.

### Whole-set preflight (작업 8 보완 §A-4)

Verifying "the rows this response loaded" is the wrong granularity for a
PAGINATED leaderboard. Before 작업 8 보완, a 100-row season with a null scope on
rank 87 returned a clean 200 for page 1, and `scope=top10` verified ten rows
while reporting a `percentile` computed from a `total` counted over the damaged
set.

`assertSeasonRankingSetScope()` (`src/ranking/season-ranking-set-scope.ts`) now
runs BEFORE the page query, over the whole ranking set identified by
`(seasonId, rankType, rankingDate, capturedAt)`:

- it loads only the SCOPE columns, never the public payload — one narrow indexed
  read bounded by the season's participant count;
- it does NOT apply the public participant filter. A hidden or excluded
  participant's damaged row is still damage, and the ranks around it are still
  the ranks this response publishes;
- one damaged row anywhere in the set fails the WHOLE set, including page 1 and
  `scope=top10`;
- `pagination.total` is not recounted over the healthy remainder and ranks are
  not reassigned;
- a set with no rows at all still verifies successfully and keeps the existing
  `unavailable` contract.

The same preflight guards every reader that publishes a whole-set-derived number
(`totalParticipants`, percentile, tier): `GET /api/v1/ranking`, the HomeService
ranking and final-result sections, and the RecordsService public season summary.
Operator paths that read ONE participant's row keep their per-row verification
and do not load the leaderboard.

### Ranking writers (작업 8 보완 §A-3)

`RankingRefreshService` replaces the current-ranking set with
delete-then-recreate. Because the recreate always produces correctly scoped
rows, that combination used to LAUNDER damage: a null or mismatched row vanished
on the next five-minute tick and came back looking healthy, leaving the repair
script with nothing to report.

The refresh now reads and verifies the existing set under the season row lock,
BEFORE any delete and before any `participant.currentRank` update. A damaged set
aborts the refresh with the codes above, and the damaged rows survive for the
operator to repair. Only a clean set is replaced.

## Not Implemented

- Ranking calculation in the API request path.
- Ranking generation in the API request path.
- Scheduler/batch execution inside this read API request path; automatic generation is handled by the ops scheduler.
- Advanced ranking filters, periods, season history views, reward/settlement integration.
- General-mode ranking, and any combined season + general ranking.


## Verification status (작업 10)

No contract change. Re-verified against PostgreSQL as part of the release
hardening pass:

- `src/ranking/season-ranking-scope.integration.spec.ts` passes — ranking scope
  dual-write/verification, the full-set preflight, `repair-ranking-scope`
  injected-damage detection, and the ranking-refresh ↔ settlement season-row
  serialisation.
- `SeasonRanking.tradingAccountId` stays **nullable** by design; no migration
  was added and no NOT NULL tightening was attempted.
- Client-side: `accountId` is not exposed in any public ranking payload, and the
  frontend never derives an account from a ranking row.
