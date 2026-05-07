# GET /api/v1/ranking API Contract

## Status
- `GET /api/v1/ranking` read-only MVP is implemented.
- The API reads existing `season_rankings` rows only.
- The API does not calculate rankings, generate rankings, read daily snapshots for ad hoc ranking, or run scheduler/batch behavior.
- Do not add fake ranking data, Prisma schema changes, migrations, or seed changes from this contract.

## Source Rules
- Ranking source of truth is `season_rankings`.
- Amount values are strings.
- Timestamps are UTC ISO strings.
- Dates use `YYYY-MM-DD`.
- Responses keep the existing `success/data` or `success/error` structure.
- `season_participants.currentRank` is not used as source of truth.

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
      "returned": 50
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
        "capturedAt": "<UTC ISO string>"
      }
    ],
    "myRanking": {
      "state": "available",
      "rank": 1,
      "seasonParticipantId": "<string>",
      "totalAssetKrw": "<amount string>",
      "returnRate": "<decimal string>",
      "rankingDate": "<YYYY-MM-DD>",
      "capturedAt": "<UTC ISO string>"
    }
  }
}
```

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
      "returned": 0
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
- Scheduler/batch automatic ranking generation.
- Advanced ranking filters, periods, season history views, reward/settlement integration.
