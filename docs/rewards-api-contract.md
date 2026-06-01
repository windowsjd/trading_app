# Rewards / Badges API Contract

## Status

- `GET /api/v1/rewards/me` read-only MVP is implemented.
- `GET /api/v1/badges/me` read-only MVP is implemented.
- Reward rows are created by the operator-run `reward-grant` internal foundation job for settled seasons with `finalRank` and `finalTier`.
- This contract covers in-app reward/badge/trophy history only.
- Actual payment, points, delivery, and external fulfillment are not implemented.
- No reward fulfillment trigger API exists. Admin/operator authorization foundation does not change reward read APIs or reward-grant job scope.

## Source Rules

- Timestamps are UTC ISO strings.
- Responses use the existing `success/data` envelope.
- User identity is `request.user.userId`; there is no `x-user-id` fallback.
- Reads must not create, update, or delete DB rows.
- `Season.rewardPolicyJson` reward amount/payment/point/badge/trophy fulfillment settings are not interpreted by these APIs.

## GET /api/v1/rewards/me

### Auth

- Protected route.
- Missing, invalid, expired, malformed bearer token, or `x-user-id` without bearer token returns `401 UNAUTHORIZED`.

### Query Parameters

- `limit` optional.
  - Default: `50`.
  - Must be a positive integer.
  - Values greater than `100` are clamped to `100`.
- `offset` optional.
  - Default: `0`.
  - Must be a non-negative integer.

### Sorting

- `grantedAt desc`
- `createdAt desc`
- `seasonId asc`
- `rewardCode asc`

### Available Response

```json
{
  "success": true,
  "data": {
    "state": "available",
    "items": [
      {
        "seasonId": "season-1",
        "seasonName": "Season 1",
        "rewardType": "badge",
        "rewardCode": "TIER_GOLD",
        "rewardName": "골드 뱃지",
        "grantedAt": "2026-05-23T00:00:00.000Z",
        "finalRank": 12,
        "finalTier": "gold"
      }
    ],
    "pagination": {
      "limit": 50,
      "offset": 0,
      "returned": 1
    }
  }
}
```

### Empty Response

```json
{
  "success": true,
  "data": {
    "state": "empty",
    "items": [],
    "pagination": {
      "limit": 50,
      "offset": 0,
      "returned": 0
    }
  }
}
```

## GET /api/v1/badges/me

### Auth

- Protected route.
- Missing, invalid, expired, malformed bearer token, or `x-user-id` without bearer token returns `401 UNAUTHORIZED`.

### Query Parameters

- `limit` optional.
  - Default: `50`.
  - Must be a positive integer.
  - Values greater than `100` are clamped to `100`.
- `offset` optional.
  - Default: `0`.
  - Must be a non-negative integer.

### Sorting

- `awardedAt desc`
- `createdAt desc`
- `seasonId asc`
- `code asc`

### Available Response

```json
{
  "success": true,
  "data": {
    "state": "available",
    "items": [
      {
        "badgeId": "badge-1",
        "badgeType": "tier_badge",
        "code": "TIER_GOLD",
        "name": "골드 뱃지",
        "description": null,
        "iconUrl": null,
        "seasonId": "season-1",
        "seasonName": "Season 1",
        "awardedAt": "2026-05-23T00:00:00.000Z"
      }
    ],
    "pagination": {
      "limit": 50,
      "offset": 0,
      "returned": 1
    }
  }
}
```

### Empty Response

```json
{
  "success": true,
  "data": {
    "state": "empty",
    "items": [],
    "pagination": {
      "limit": 50,
      "offset": 0,
      "returned": 0
    }
  }
}
```

## Error Codes

- `UNAUTHORIZED`
- `INVALID_LIMIT`
- `INVALID_OFFSET`

## Current Internal Reward Policy

- Tier badge, one per final-assigned participant:
  - `master` -> `TIER_MASTER` / `마스터 뱃지`
  - `diamond` -> `TIER_DIAMOND` / `다이아 뱃지`
  - `platinum` -> `TIER_PLATINUM` / `플래티넘 뱃지`
  - `gold` -> `TIER_GOLD` / `골드 뱃지`
  - `silver` -> `TIER_SILVER` / `실버 뱃지`
  - `bronze` -> `TIER_BRONZE` / `브론즈 뱃지`
- TOP10 trophy:
  - `finalRank <= 10` -> `TROPHY_TOP10` / `TOP 10 트로피`
- TOP1/TOP3 trophy variants are not implemented.
