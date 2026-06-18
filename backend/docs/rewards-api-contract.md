# Rewards / Badges API Contract

## Status

- `GET /api/v1/rewards/me` read-only MVP is implemented.
- `GET /api/v1/badges/me` read-only MVP is implemented.
- The operator-run `reward-grant` job is disabled until a Reward Policy / Catalog gate opens. It fails closed with `REWARD_POLICY_GATE_CLOSED` and does not create reward rows, badge rows, user badge rows, or participant reward markers.
- Internal reward fulfillment operator/admin APIs are implemented. Fulfillment requests are queued separately from `SeasonReward` and create a `SeasonReward` only when fulfilled.
- This contract covers in-app reward/badge/trophy history only.
- Actual payment, points, coupon, gifticon, delivery, cash-out, and external fulfillment APIs are not implemented.
- Reward type policy and reward catalog are future gates. `rewardCode`, `rewardName`, and `rewardValueJson` are the current extension bridge.

## Source Rules

- Timestamps are UTC ISO strings.
- Responses use the existing `success/data` envelope.
- User identity is `request.user.userId`; there is no `x-user-id` fallback.
- Reads must not create, update, or delete DB rows.
- `Season.rewardPolicyJson` reward amount/payment/point/badge/trophy fulfillment settings are not interpreted by these APIs.
- User reward reads expose only rows already present in `season_rewards`. Pending, processing, failed, and canceled fulfillment requests are operator/admin state and are not user-visible rewards.

## Internal Reward Fulfillment

### Schema

- `SeasonRewardType`: `internal`, `badge`, `trophy`
- `RewardFulfillmentStatus`: `pending`, `processing`, `fulfilled`, `failed`, `canceled`
- `RewardFulfillmentRequest` / `reward_fulfillment_requests`

Important constraints:

- `@@unique([requestedByUserId, idempotencyKey])`
- `@@unique([seasonParticipantId, rewardCode])`
- Existing `SeasonReward @@unique([seasonParticipantId, rewardCode])` remains.
- `SeasonReward.fulfillmentRequestId` is optional. Existing rows without it are treated as legacy/manual fulfilled rewards.

### Access

- `operator` and `admin` can list/get/create/fulfill/cancel internal fulfillment requests.
- `user` receives `403 OPERATOR_REQUIRED`.
- Missing, invalid, expired, or malformed bearer token returns `401 UNAUTHORIZED`.
- Suspended or deleted actors are blocked by the access-token guard with `403 USER_NOT_ACTIVE`.

### GET /api/v1/operator/reward-fulfillments

Query:

- `status` optional: `pending`, `processing`, `fulfilled`, `failed`, `canceled`
- `seasonId` optional
- `userId` optional
- `seasonParticipantId` optional
- `rewardCode` optional
- `limit` optional: default `20`, max `100`
- `offset` optional: default `0`

Response:

```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "fulfillment-id",
        "seasonId": "season-id",
        "seasonParticipantId": "participant-id",
        "userId": "user-id",
        "rewardType": "internal",
        "rewardCode": "manual_reward_2026_001",
        "rewardName": "시즌 보상",
        "rewardValueJson": {
          "kind": "internal",
          "note": "reward policy TBD"
        },
        "status": "pending",
        "seasonRewardId": null,
        "requestedAt": "2026-06-09T00:00:00.000Z",
        "processingStartedAt": null,
        "fulfilledAt": null,
        "failedAt": null,
        "canceledAt": null,
        "errorCode": null,
        "errorMessage": null,
        "createdAt": "2026-06-09T00:00:00.000Z",
        "updatedAt": "2026-06-09T00:00:00.000Z"
      }
    ],
    "pagination": {
      "limit": 20,
      "offset": 0,
      "total": 1,
      "returned": 1,
      "nextOffset": null
    }
  }
}
```

### GET /api/v1/operator/reward-fulfillments/:fulfillmentId

Returns one fulfillment request. Missing request returns `REWARD_FULFILLMENT_NOT_FOUND`.

### POST /api/v1/operator/reward-fulfillments

Body:

```json
{
  "seasonId": "season-id",
  "seasonParticipantId": "participant-id",
  "rewardType": "internal",
  "rewardCode": "manual_reward_2026_001",
  "rewardName": "시즌 보상",
  "rewardValueJson": {
    "kind": "internal",
    "note": "reward policy TBD"
  },
  "idempotencyKey": "client-generated-key",
  "reason": "optional string"
}
```

Behavior:

- Creates a `pending` fulfillment request.
- `idempotencyKey` is required.
- Same actor + same `idempotencyKey` + same request hash replays the existing response.
- Same actor + same `idempotencyKey` + different request hash returns `REWARD_FULFILLMENT_IDEMPOTENCY_CONFLICT`.
- Same `seasonParticipantId + rewardCode` request or existing `SeasonReward` returns `REWARD_FULFILLMENT_DUPLICATE`.
- `seasonParticipantId` must belong to `seasonId`.
- Target season must be `settled`.
- Target user must be `active`.
- `rewardType` may be `internal`, `badge`, or `trophy`.
- Reward catalog/policy validation is not performed in this gate.
- Secret-like keys inside `rewardValueJson` are redacted before storage/audit.

### POST /api/v1/operator/reward-fulfillments/:fulfillmentId/fulfill

Body:

```json
{
  "reason": "optional string"
}
```

Behavior:

- `pending` and `failed` requests can be fulfilled.
- Fulfill transitions through `processing`, creates a `SeasonReward`, then stores `status=fulfilled`, `seasonRewardId`, `fulfilledAt`, and `processedByUserId`.
- If `SeasonParticipant.rewardGrantedAt` is null, it is set to the fulfillment time.
- An already `fulfilled` request returns success replay for the same request.
- `canceled`, `processing`, or otherwise invalid statuses return `REWARD_FULFILLMENT_INVALID_STATUS`.
- Existing duplicate `SeasonReward` blocks fulfillment with `REWARD_ALREADY_FULFILLED`.
- If target user is not active or season is not settled at fulfill time, the request is marked `failed` with `errorCode`/`errorMessage`.
- No external API is called.

### POST /api/v1/operator/reward-fulfillments/:fulfillmentId/cancel

Body:

```json
{
  "reason": "optional string"
}
```

Behavior:

- `pending` and `failed` requests can be canceled.
- `processing`, `fulfilled`, and `canceled` requests cannot be canceled.
- Cancel stores `status=canceled`, `canceledAt`, and `canceledByUserId`.
- Fulfilled rewards are not reversed.

### Audit

Actions:

- `operator.reward_fulfillment.create`
- `operator.reward_fulfillment.create.failed`
- `operator.reward_fulfillment.fulfill`
- `operator.reward_fulfillment.fulfill.failed`
- `operator.reward_fulfillment.cancel`
- `operator.reward_fulfillment.cancel.failed`
- `operator.reward_fulfillment.get`
- `operator.reward_fulfillment.list`

Create/fulfill/cancel success audit rows are written in the same transaction as the DB mutation. Failure audit rows are best-effort. Audit metadata uses safe fields only and must not store raw request bodies, password hashes, tokens, env values, raw provider payloads, or secrets.

### Error Codes

- `OPERATOR_REQUIRED`
- `TARGET_USER_NOT_FOUND`
- `TARGET_USER_NOT_ACTIVE`
- `SEASON_NOT_FOUND`
- `SEASON_NOT_SETTLED`
- `SEASON_PARTICIPANT_NOT_FOUND`
- `SEASON_PARTICIPANT_MISMATCH`
- `INVALID_REWARD_TYPE`
- `INVALID_REWARD_CODE`
- `INVALID_REWARD_NAME`
- `INVALID_IDEMPOTENCY_KEY`
- `REWARD_FULFILLMENT_IDEMPOTENCY_CONFLICT`
- `REWARD_FULFILLMENT_NOT_FOUND`
- `REWARD_FULFILLMENT_DUPLICATE`
- `REWARD_FULFILLMENT_INVALID_STATUS`
- `REWARD_ALREADY_FULFILLED`
- `REWARD_FULFILLMENT_FAILED`
- `REWARD_FULFILLMENT_CANCEL_FAILED`

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
      "total": 1,
      "returned": 1,
      "nextOffset": null
    }
  }
}
```

`rewardType` can be `internal`, `badge`, or `trophy`. A reward appears here only after a `SeasonReward` row exists.

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
      "total": 0,
      "returned": 0,
      "nextOffset": null
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
      "total": 1,
      "returned": 1,
      "nextOffset": null
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
      "total": 0,
      "returned": 0,
      "nextOffset": null
    }
  }
}
```

## Error Codes

- `UNAUTHORIZED`
- `INVALID_LIMIT`
- `INVALID_OFFSET`

## Reward Policy Status

- No automatic reward-grant catalog is active.
- `reward-grant` fails closed with `REWARD_POLICY_GATE_CLOSED` until Reward Policy / Catalog is defined.
- Hardcoded tier reward, badge, and trophy writes are not part of the current backend.
- Operator/admin internal fulfillment can still create explicit `SeasonReward` rows when a fulfillment request is fulfilled.
