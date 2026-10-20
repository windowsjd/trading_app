# Push Notifications Contract

Status (2026-10-17): implemented, **default OFF** (`PUSH_NOTIFICATIONS_ENABLED=false`).
Follow-up the same day: a failure tap opens the failed row itself (§2.3a), a
foreground liquidation shows the in-app banner (§7), and a failed permission
request no longer blocks the next first-launch prompt (§7).
Device, preference and notice APIs work with the worker off. Real delivery has
not been verified on a device: Android needs Firebase (FCM) credentials and iOS
needs APNs credentials in EAS first (§8).

Push is an auxiliary channel. Orders, executions, liquidations, ledgers and
Season results remain the only source of truth; a push never decides, delays
or repeats any of them. Expo, FCM and APNs do not guarantee delivery or
exactly-once delivery, and neither does this system.

## 1. Shape

```
committed rows ──scan (worker, every 10 s)──▶ push_notifications (outbox)
                                              │ claim (lease, SKIP LOCKED)
                                              ▼
           preference / source re-check ──▶ Expo /push/send ──▶ push_deliveries (tickets)
                                                               └─ /push/getReceipts (≥15 min)
```

- **No financial code path changed.** The worker reads already-committed,
  terminal rows by a time window on the column the writing transaction stamps
  with its own clock. It never writes or locks a financial row, and no push I/O
  happens inside any transaction.
- One instance works at a time (Ops lease `push_notifications:current`,
  `OpsJobName.push_notifications`). Duplicates are prevented by the database,
  not the lease: `push_notifications (user_id, type, source_key)` is unique and
  every insert is `ON CONFLICT DO NOTHING`.
- Tables (migration `20261017120000_add_push_notifications`): `push_devices`,
  `notification_preferences`, `push_notifications`, `push_deliveries`,
  `push_scan_cursors`, `important_notices`. The scan indexes on the existing
  `orders.executed_at` and `futures_executions.executed_at` are a separate
  migration (`20261017120100_add_push_scan_indexes`) built `CONCURRENTLY`, so
  the deploy never blocks order or execution writes. If such a build is
  interrupted: `DROP INDEX CONCURRENTLY` the invalid index, `prisma migrate
  resolve --rolled-back 20261017120100_add_push_scan_indexes`, deploy again.

## 2. Event sources (exact conditions)

Each windowed source has a cursor in `push_scan_cursors`. The first scan of a
source only records its start (`started_at`): **events committed before the
feature was enabled are never sent.** Later scans read
`[max(scanned_to − 2 min, now − catch-up, started_at), now]` in
`(time, id)` order with keyset paging (500 rows a page, 10 pages per source
per tick); the 2-minute lookback catches transactions that committed after a
later one was scanned (the outbox key absorbs the overlap). A tick that uses
its page budget stores a resume point (`scanned_to`, `resume_id`) at the
newest row stamped at least 30 s before the scan (the longest financial
transaction is 15 s), and the next tick continues exactly after it, so a
burst larger than a page can never stall a source and a younger row that
commits late is read again. Only if every row read is younger than 30 s (more
than 5,000 events of one source within 30 s) does the resume point fall back
to the last row read. Catch-up after a stop: fills 30 min, liquidations/failures 2 h,
friend requests 6 h, final results 24 h. Older events are not announced. Each
failure table is its own source (`failures_loc`, `failures_conditional_buy`,
…).

Every account-scoped notification is addressed to `trading_accounts.user_id`
of the event's own account, read in the same query as the event.

### 2.1 Trade fill (`trade_fill`)

- Spot: `orders.status = 'executed'` by `executed_at`. Covers market, limit
  paths A/B, LOC, conditional BUY/SELL, stop-loss/take-profit (independent and
  legacy OCO) — they all end in the same two `executed` writers. Key
  `order:<id>`.
- Futures: every `futures_executions` row by `executed_at` (manual market,
  limit entry, conditional entry, stop-loss/take-profit). Key
  `futures_execution:<id>`. Liquidations and Season final exits never write
  this table.
- Never announced: `submitted` orders, triggers, watches, `ordered`
  conditional rows whose order has not filled, cancellations. A user's own
  market close or reduce of a Futures position is an execution and is
  announced as a fill (never as a liquidation).
- Quantity: `executedQuantity ?? quantity`. A one-shot market partial result
  (`canceledQuantity > 0`) says "일부 체결" with the executed quantity and the
  automatically canceled remainder, never "체결 완료".
- Copy follows the in-app fill banner: `삼성전자 매수 체결 완료` /
  `<account> · <시장가|지정가|조건주문|손절|익절> · 체결 수량 3`. No price,
  amount, balance or PnL.

### 2.2 Futures liquidation (`futures_liquidation`)

One notification per `futures_liquidations` row (key
`futures_liquidation:<id>`, payload `liquidationId: <id>`). A Cross
liquidation that closed several positions is one row, hence one notification
listing the count. A user close or a Season final exit
(`futures_season_settlements`) is not a liquidation.

### 2.3 Order failure / expiry (`order_failure`)

Only terminal rows whose retries are over:

| Source | Condition | Key |
|---|---|---|
| LOC | `limit_on_close_orders.status IN ('unfilled','expired')` by `decided_at` | `loc:<orderId>` |
| Conditional BUY | `conditional_buy_orders.status = 'failed'` by `ended_at` | `conditional_buy:<id>` |
| Conditional SELL / stop-loss / take-profit | `conditional_sell_orders.status = 'failed'` | `conditional_sell:<id>` |
| Futures conditional entry | `futures_conditional_entries.status = 'failed'` | `futures_conditional_entry:<id>` |
| Futures stop-loss/take-profit | `futures_tp_sl_settings.status = 'failed'` | `futures_tp_sl:<id>` |
| Entry stop-loss/take-profit plan | `entry_tp_sl_plans.status = 'failed'` (could not be activated after the entry filled) | `entry_tp_sl_plan:<id>` |

- Retrying (`triggered`, attempt < 3 inside the 30 s window) is not final.
- User cancels are `canceled` and never read.
- **Season cleanup is not a failure:** an event of a Season account at or
  after its Season's `endAt` is skipped (e.g. an LOC that expired because the
  Season ended). Season-end cancellations are `canceled` and not read anyway.
- Futures limit entries have no failure or expiry state (they end `executed`
  or `canceled`), and a user market order fails synchronously in its own
  request, so neither produces a failure notification.
- The payload names the row: `failureKind` = the key prefix (`loc`,
  `conditional_buy`, `conditional_sell`, `futures_conditional_entry`,
  `futures_tp_sl`, `entry_tp_sl_plan`) and `failureId` = the id after it.

### 2.3a Reading a failure on tap (read-only)

`GET /api/v1/trading-accounts/:accountId/order-failures/:failureKind/:failureId`
(access token). Reads that one row only where `trading_account_id =
:accountId` **and** the account's `user_id` is the caller; anything else —
another user's or account's row, an unknown kind, a malformed id, a row that
is gone — is the same 404 `ORDER_FAILURE_NOT_FOUND`. It never executes,
retries, cancels or repairs anything.

Answer `{ failure: { kind, id, tradingAccountId, market, status, final,
instrument: { name, symbol }, side, direction, protection, reasonCode,
failureCode, endedAt, createdAt } }`. `status` is the stored status as is;
`final` is true only for the outcome this section announces (LOC
`unfilled`/`expired`, otherwise `failed`) — a watching, triggered (retrying),
ordered or pending row is `final: false` and the app does not call it a
failure. `reasonCode` is the LOC `decision_reason` or the row's
`terminal_reason`; `endedAt` is `decided_at` / `ended_at`. Codes are mapped
to words in the app; no raw code is shown.

### 2.4 Friend request (`friend_request`)

A `friendships` row with `status = 'pending'` by `created_at`, to the
non-requester only, both users active. Key `friend:<requesterId>:<id>`.
Accept/reject/re-read create no row. Another request from the same requester
to the same recipient within 24 h (reject → re-request) is not announced
again. Right before sending, the request must still be pending with the same
requester, otherwise it is skipped (`source_invalid`). The requester's account
deletion deletes these rows from recipients' outboxes (they carry the
requester's nickname and id), together with the deleted member's own rows.

### 2.5 Important notice (`important_notice`)

Only an `important_notices` row an operator **published** (§4). The fan-out
reads active users that have a registered device and the type on, in
ascending user-id pages (500 per page, 4 pages per tick), key
`notice:<noticeId>`. A notice not fanned out within 24 h of publication is
closed without further sends. Static notices shipped in the app bundle, app
updates and drafts never send anything. A withdrawn notice stops unsent pushes.

### 2.6 Season final rank and tier (`season_final_result`)

`seasons.status = 'settled'` (written in the same transaction as every final
rank, tier and eligibility verdict) by `updated_at`, and per participant
`final_rank IS NOT NULL AND final_tier IS NOT NULL`, not `excluded`, not
hidden from the ranking. Not-qualified participants (`final_qualified =
false`) cannot hold a rank or tier (SQL CHECK) and are not told anything. An
`ended` Season (not settled) or provisional values are never announced. Key
`season_final:<seasonId>` — once per user and Season. Only Seasons that ended
within the last 14 days (`FINAL_RESULT_MAX_AGE_MS`) are read, and the outbox row
is created after the Season end, so it follows the normal 30-day retention
(§5, since 2026-10-21): by the time it is pruned the Season is never read
again, and a re-run settlement (which touches `updated_at`) never announces a
result twice — within the 14 days the unique key absorbs it, afterwards the
age filter does. Retention must stay longer than that window (a config test
pins it). Right before sending the participant must still hold both values. A
later operator correction is not re-announced.

### 2.7 Season ending soon (`season_ending_soon`)

Seasons with `status = 'active'`, `start_at ≤ now` and
`now + 10 min < end_at ≤ now + 24 h`; participants with
`participant_status = 'active'` and an active account. One notification per
participant and confirmed end instant (key
`season_ending:<seasonId>:<endAtMs>`); the participant list is re-swept every
10 minutes so a late joiner is reached. It expires at `end_at`, and right
before sending the Season must still be active with the same `end_at` and the
participant still active. The copy states the end time in KST, so a delayed
send stays accurate. Seasons have no cancel state; `end_at` cannot be changed
through the app — a changed `end_at` would be a new key.

## 3. Devices

| Method | Path | Auth | Body | Answer |
|---|---|---|---|---|
| PUT | `/api/v1/notifications/devices` | access token | `{ token, platform: 'ios'\|'android' }` | `{ registered: true }` |
| POST | `/api/v1/notifications/devices/release` | **public** (token = proof) | `{ token }` | `{ released: true }` |

- `token` must be an Expo push token (`ExponentPushToken[…]` / `ExpoPushToken[…]`);
  a SQL CHECK enforces the same shape.
- Register moves a token to the caller (account switch on one device), keeps
  at most 10 devices per user (oldest released) and refreshes `registered_at`.
- Release deletes by token and answers the same whether it existed, so it is
  not an oracle. It lets a signed-out app (logout while offline, reinstall,
  OS permission off) drop the registration without a session — the token is a
  device secret, like the refresh token `/auth/logout` takes.
- An Expo `DeviceNotRegistered` ticket or receipt deletes the device, unless it
  registered again after that send.
- Ownership is re-read right before each Expo request: a device released or
  registered by another user since the claim does not receive the push. A
  message already handed to Expo/FCM/APNs cannot be recalled, so a release
  in the same instant as a send can still be followed by that one push.
- Tokens are never logged, echoed or copied into deliveries.

## 4. Important notices

App (authenticated): `GET /api/v1/notices` → `{ notices: [{ id, title, summary,
sections: [{ heading, paragraphs[] }], publishedAt }] }`, published only,
newest first, at most 50. The app lists them with its own notices (marked
중요) and a push tap opens the notice.

Operator (`OperatorGuard`: operator or admin; each step audited in the same
transaction as `operator.notice.<verb>`, failures as `.failed`):

Every step and every failed attempt (`.failed`, error code only) is in
`operator_audit_logs`.

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/v1/operator/notices` | `{ title ≤100, summary ≤200, sections (1–20 × 1–30 paragraphs ≤2000), idempotencyKey }` | Creates a **draft**; same key + same content replays, different content → 409 `NOTICE_IDEMPOTENCY_CONFLICT`. |
| GET | `/api/v1/operator/notices` | — | Newest 100 with status and delivery counts by status. |
| POST | `/api/v1/operator/notices/:id/publish` | `{ "confirm": true }` | Draft → published once (`NOTICE_PUBLISH_CONFIRMATION_REQUIRED`, `NOTICE_ALREADY_PUBLISHED`, `NOTICE_WITHDRAWN`, `NOTICE_NOT_FOUND`). Starts the fan-out (§2.5). |
| POST | `/api/v1/operator/notices/:id/withdraw` | — | Published → withdrawn: hidden in the app, unsent pushes skipped (`source_withdrawn`). Sent pushes cannot be recalled; their tap shows "해당 공지를 찾을 수 없습니다". |

There is no edit endpoint: correct a draft by creating a new one.

## 5. Worker, delivery and retention

Every `PUSH_NOTIFICATIONS_INTERVAL_MS` (default 10 s, 2–300 s) under the lease:

1. **Scan** (§2) → outbox rows (`pending`), copy and payload fixed.
2. **Dispatch**: claim ≤1,000 due rows (`pending` with `next_attempt_at ≤
   now`, or `sending` whose 2-minute lease expired) with `FOR UPDATE SKIP
   LOCKED` — every other type first, important-notice fan-out rows only with
   the remaining room, so a large notice never delays a fill — then per row,
   in this order:
   `expired` (now ≥ `expires_at`), `source_invalid` (§2.4/2.5/2.6/2.7
   re-checks), `user_inactive`, `preference_disabled`, `no_device`, `dry_run`
   → `skipped` with that reason. Otherwise one message per device, ≤100 per
   Expo request, a notification's devices always in the same request.
   Device ownership is re-read before each request. If Expo rejects a whole
   request (e.g. one token of another Expo project), each message is sent
   alone so only the bad one fails. Sending stops after half the claim lease
   (60 s); notifications not reached go straight back to `pending`
   (`PUSH_SEND_DEFERRED`), so no other worker can reclaim a row that is still
   being sent. The outcome is written before the delivery rows, so a device
   released mid-send (its delivery keeps the ticket without the device link)
   can never leave a sent row to be resent.
3. **Outcome**: any accepted ticket → `sent`. A retryable failure (network,
   HTTP 429/5xx, `MessageRateExceeded`) → back to `pending` after 30 s / 2 min /
   10 min (4 attempts, never past `expires_at`). Anything else
   (`DeviceNotRegistered`, `MessageTooBig`, `InvalidCredentials`, HTTP 4xx, an
   unmatched response) → `failed` with `last_error_code`. A crash mid-send can
   resend after the lease (at-least-once).
4. **Receipts** (every 60 s): tickets older than 15 min are resolved in
   batches of 1000 (`receipt_ok` / `receipt_error` + code); a ticket without a
   receipt after 24 h is `receipt_missing`.
5. **Retention** (hourly): outbox rows older than 30 days are deleted in
   batches of 1000, final-result rows included (§2.6); deliveries cascade.

Expiry after the event: fills 2 h, liquidations/failures 6 h, friend requests
3 days, notices 24 h, final results 3 days, ending-soon at `end_at`.

Message: `{ to, title, body, data, sound: 'default', channelId: 'default',
priority: high (trading outcomes) | default, ttl: seconds to expiry }`.
`data` = `{ v: 1, type, uid, accountId?, market?, futuresView?, seasonId?,
noticeId?, failureKind?, failureId?, liquidationId? }` — ids only. `uid` is
the recipient; the app ignores a tap for another signed-in user. The payload
is fixed when the outbox row is created, so rows created before 2026-10-17's
follow-up lack `failureKind`/`failureId`; the app opens nothing for such a
failure tap (none were ever delivered: the worker has never been enabled).

Observability: one Ops run (`job_name = push_notifications`) per minute with
counts (`created` per source, `sent`, `retried`, `failed`, `skipped` per reason,
tickets, receipts, devices removed, pruned, failing steps); a step that failed
during that minute makes the run `failed` with
`PUSH_NOTIFICATIONS_STEP_FAILED` (and is logged at once). Per-notification state
is in `push_notifications.status/skip_reason/last_error_code` and
`push_deliveries`. No token, copy or payload is logged.

## 6. Preferences

`GET /api/v1/notifications/preferences` and `PATCH` with any subset of
`allEnabled, tradeFill, futuresLiquidation, orderFailure, friendRequest,
importantNotice, seasonFinalResult, seasonEndingSoon` (booleans only; unknown
keys or an empty body → 400 `INVALID_NOTIFICATION_PREFERENCES`). Both answer
`{ allEnabled, preferences }` with the stored values (`preferences` = the
seven, unchanged in shape for apps from before 2026-10-20). No row = all on.
The OS permission is separate device state.

**전체 알림 (`allEnabled`, 2026-10-20, column `notification_preferences.all_enabled`,
default `true`):** off holds every type — the dispatcher checks it with the
type's own switch at send time (`preference_disabled`), and an important notice
is not fanned out to that user at all — while the seven columns are never
rewritten, so turning it back on restores exactly what the user chose. One
value per user (every device). An app from before 2026-10-20 ignores the field
and cannot turn it back on; only a newer app can turn it off. The app shows no
전체 알림 switch when a server answers without the field.

## 7. App behaviour (frontend `src/features/notifications`)

- **First launch, before sign-in:** `PushNotificationsHost` (beside the root
  navigator) creates the Android channel `default`, then asks the OS once if
  it is undetermined and this install has not asked
  (`trading-app:push-permission-requested`). Android ≤12 is granted at
  install. Allowed/denied is never asked again; a denial blocks nothing. Web
  does nothing. The marker is written before the prompt (a crash mid-prompt
  counts as asked) but **removed again when the request throws or answers
  "not determined"**, so a native failure never blocks the prompt on later
  launches; each launch re-reads the OS state before asking. Errors never
  reach sign-in, signup or app start.
- **Registration** follows the session: register after sign-in/restore,
  release on logout/expiry, on OS permission off, on a token change (old
  token), and once per launch while signed out (reinstall case). Serialized,
  so a logout's release reaches the server before the next user's register.
- **Foreground:** no OS banner/list/sound; the push refreshes only the reads
  it changed (the in-app fill banner keeps announcing Spot fills). A
  `futures_liquidation` push for one of the signed-in user's own accounts is
  also handed to that same banner queue (`선물 강제청산` + the push body,
  내역 보기 → 선물 > 강제청산 기록): one banner at a time, never stacked on a fill
  banner, and one liquidation event (`liquidationId`) is shown once even if
  delivered again. It depends on the push actually arriving (worker on,
  permission granted, type on); without it the futures screen's own position
  list is the only foreground signal — there is no app-side liquidation
  polling.
- **Tap:** applied after sign-in and the investment-mode choice (main tabs),
  only for `uid` = the signed-in user, and an account target only if the
  account is in the user's own list; otherwise dropped (no screen opens).
  Targets: fills → 거래 내역 (`TradeHistory {accountId, market}`),
  failures/expiries → 주문 실패·만료 (`OrderFailure {accountId, kind,
  failureId}`, §2.3a: the stored result and reason, plus where the row is also
  listed; a LOC links to 거래 내역 > 현물), liquidation → 거래 내역 > 선물 >
  강제청산 기록, friend request → 친구 > 받은 요청, notice → 공지사항
  (opened), final result / ending soon → 시즌 전적 상세
  (`RecordSeasonDetail`). A beginner's active quest holds the move like any
  other navigation.
- **Settings:** 전체 알림 and the seven server switches under 알림 종류별 설정
  (folded by default; folding is screen state, never stored). While 전체 알림 is
  off the seven show their kept values and wait. Saving state is shown, a failed
  save reverts with an error and 다시 시도 (the same change again), and the OS
  permission state stays separate with 알림 허용하기 / 기기 설정 열기.

## 8. Configuration and external setup

| Env | Default | Meaning |
|---|---|---|
| `PUSH_NOTIFICATIONS_ENABLED` | `false` | Runs the worker (strict true/false). |
| `PUSH_NOTIFICATIONS_DRY_RUN` | `false` | Derive but mark `skipped (dry_run)`; no Expo call. |
| `PUSH_NOTIFICATIONS_INTERVAL_MS` | `10000` | Tick, 2000–300000. |
| `EXPO_ACCESS_TOKEN` | unset | Only with Expo enhanced push security; secret. |

Required outside the code before any real delivery (none done yet; checked
2026-10-17 against `2e0a60ae`):

- **Android package:** `com.leagueoftrading` everywhere — `android/app/build.gradle`
  `namespace`/`applicationId` and `app.json` `android.package` (aligned in
  `2e0a60ae`). EAS **skips prebuild** because `frontend/android/` is committed,
  so `app.json` `android.*` and `plugins` (incl. the `expo-notifications`
  options) are not applied to Android builds: native changes go into
  `android/` by hand. (`app.json.bak` is stale and unused.)
- **Android (FCM v1)** — not in the repo yet:
  1. Firebase project → Android app `com.leagueoftrading` → download
     `google-services.json` into `frontend/android/app/` (client config; decide
     whether to commit it — EAS uploads git-tracked files — or inject it as an
     EAS file secret).
  2. In the same change (a build without the file would fail):
     `classpath('com.google.gms:google-services:<4.4.x>')` in
     `android/build.gradle` and `apply plugin: "com.google.gms.google-services"`
     in `android/app/build.gradle`. Not done here because it cannot be built or
     verified without the file.
  3. `eas credentials` → Android → FCM V1 → upload the **service-account key**
     (a secret: never commit it; `frontend/.gitignore` now ignores common key
     file names).
  Without these the app cannot obtain an Expo push token on Android
  (registration fails silently; the permission prompt and channel still work —
  `POST_NOTIFICATIONS` comes from the expo-notifications manifest merge).
- **Android notification icon:** none configured; the launcher icon is used,
  which renders as a white square on many devices. Add a white-on-transparent
  `res/drawable-*/notification_icon.png` and, in the manifest `<application>`,
  `meta-data` `expo.modules.notifications.default_notification_icon` (and
  optionally `..._color`) — the plugin's `icon` option does not reach the
  committed `android/`. Needs a designed asset.
- **iOS (APNs):** no `ios` block in `app.json` and no `frontend/ios/`. Needs an
  Apple Developer account, a registered bundle id set as `ios.bundleIdentifier`,
  and an APNs key (.p8) through `eas credentials`; an iOS EAS build runs
  prebuild, where the plugin adds `aps-environment`. Not invented here.
- A new native build (EAS) is required for any of the above; the JS bundle
  alone cannot add them. Expo Go cannot receive remote pushes on Android.

## 9. Rollout and rollback

1. Deploy (migration applies; worker off). APIs are inert until the app ships.
2. Ship an app build with FCM/APNs credentials; verify registration rows
   appear (`SELECT platform, count(*) FROM push_devices GROUP BY 1`).
3. `PUSH_NOTIFICATIONS_ENABLED=true` + `PUSH_NOTIFICATIONS_DRY_RUN=true`:
   check `push_notifications` rows per type/skip reason against real events.
4. Internal-device test with `PUSH_NOTIFICATIONS_DRY_RUN=false` (QA checklist
   in `frontend/docs/push-notifications-qa.md`), then production.
5. Rollback: `PUSH_NOTIFICATIONS_ENABLED=false` stops all sends immediately;
   the tables can stay. Nothing financial depends on them.
6. 전체 알림 (`20261020090000_add_notification_all_enabled`): additive column
   with a default, so the server deploys first and older apps keep working;
   then the app. Rolling the server back leaves the column unused (a user
   who had turned 전체 알림 off would receive pushes again until it is
   redeployed); dropping it is never required.

## 10. Invariants

- No push is derived from a submission, trigger, watch, retry or
  provisional ranking; a user close is a fill and a Season final exit is
  neither a fill nor a liquidation.
- A notification goes only to the owner of the event's account / the
  recipient, through devices that user owns when the request is made (§3).
- A push failure never fails, delays or repeats a financial transaction.
- Payloads carry ids only; copy carries no price, amount, balance or PnL.
- Only an operator can publish; publication is explicit, once, audited.
