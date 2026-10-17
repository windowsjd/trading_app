# Push notifications — device QA checklist

Contract: [backend/docs/push-notifications-contract.md](../../backend/docs/push-notifications-contract.md).
Code: `src/features/notifications` (host beside the root navigator, settings
section, pure policy modules with `node --test` coverage).

Status 2026-10-17: **not run on any device.** Needs an EAS development/preview
build that includes `expo-notifications`, Firebase (FCM v1) credentials for
the Android package actually built (`com.leagueoftrading`), and APNs
credentials plus an iOS bundle identifier. Use a staging backend with
`PUSH_NOTIFICATIONS_ENABLED=true` (first with `PUSH_NOTIFICATIONS_DRY_RUN=true`).

Record for each row: device/OS version, build, result, and the matching
`push_notifications` row (`status`, `skip_reason`, `last_error_code`).

## A. First launch and permission

| # | Steps | Expected |
|---|---|---|
| A1 | Fresh install, Android 13+, open the app | System notification prompt appears on the first screen, **before** login; `알림` channel exists in app settings |
| A2 | Fresh install, iOS | System prompt before login |
| A3 | Android 12 or lower | No prompt (granted at install); registration works after login |
| A4 | Deny, then log in / sign up | Login, signup and every screen work; no registration row for the device |
| A5 | Relaunch after allow or deny | No prompt again |
| A6 | Reinstall | OS decides whether the prompt can show again; app asks only if undetermined |
| A7 | Web build | No prompt, no errors; Settings explains web has no push |

## B. Registration lifecycle

| # | Steps | Expected |
|---|---|---|
| B1 | Allow, stay logged out | No `push_devices` row for any user |
| B2 | Log in | One row for this token owned by the user |
| B3 | Log out | Row deleted |
| B4 | User A logs out, user B logs in on the same device | Row owned by B only; A's events never reach this device |
| B5 | Log out while offline, relaunch online | Row deleted on relaunch |
| B6 | Turn notifications off in OS settings, return to the app | Row deleted; Settings shows 기기 설정 열기 |
| B7 | Turn them back on, return | Row registered again |

## C. Delivery per type (background and killed app)

For each: app in background, then repeat with the app swiped away.

| # | Trigger | Expected push / tap target |
|---|---|---|
| C1 | Spot market buy fills | "… 매수 체결 완료"; tap → 거래 내역 (현물) of that account |
| C2 | Spot limit / LOC / conditional / 손절·익절 fill | Same, with origin label (LOC/조건주문/손절/익절) |
| C3 | Futures fill (limit, conditional entry, TP/SL) | "… 체결"; tap → 거래 내역 > 선물 > 체결 기록 |
| C4 | Futures liquidation (Cross with 2+ positions) | One push; tap → 선물 > 강제청산 기록 |
| C5 | LOC unfilled / expired; conditional/TP-SL final failure | "… 미체결 / 만료 / 실행 실패"; tap → 거래 내역 |
| C6 | Friend request received | "○○님이 친구 요청을 보냈어요."; tap → 친구 > 받은 요청 |
| C7 | Operator publishes an important notice | "[공지] …"; tap → 공지사항 with it opened |
| C8 | Season settled with rank and tier | "시즌 최종 결과 확정"; tap → 시즌 전적 상세 |
| C9 | Participating Season 24 h before end | "시즌 종료 예정 … HH:MM에 종료돼요"; tap → 시즌 전적 상세 |

Negative cases (no push; row absent or `skipped`):

- Submitted limit order, conditional trigger still retrying, user cancel.
- User close of a futures position; Season final exit.
- Re-opening the friends tab; accepting/rejecting a request.
- Ended-but-not-settled Season; not-qualified participant.
- A Season the user did not join.
- A static notice change / app update; an unpublished draft.
- The type switched off in Settings (`preference_disabled`).

## D. Foreground and taps

| # | Steps | Expected |
|---|---|---|
| D1 | App open on another tab when a Spot fill arrives | No OS banner; in-app fill banner shows (existing) |
| D2 | App open when a friend request arrives | No OS banner, no popup; 받은 요청 list refreshes |
| D3 | Tap a push while logged out | Login first; after login and mode selection the target opens |
| D4 | Tap a push for user A while B is logged in | Nothing opens (B stays where they are) |
| D5 | Beginner account mid-quest taps a push | Quest guide holds the move and explains why |

## E. Settings

| # | Steps | Expected |
|---|---|---|
| E1 | Open 설정 > 알림 설정 | Seven switches, all on for a new user |
| E2 | Toggle one off | "저장 중…", then off; persists after app restart and on another device |
| E3 | Toggle with the network off | Switch returns to the saved value with an error |
| E4 | Log out, log in as another user | The other user's switches, never the previous ones |
