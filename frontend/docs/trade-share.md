# 수익 공유 (거래 수익 공유 카드) — setup and device QA

Contract: [backend/docs/completed-trades-share-contract.md](../../backend/docs/completed-trades-share-contract.md).
Design source: `트레이딩 클래스 수익 카드(1).png` (product owner, 2026-11-06); art provenance in
`src/assets/share-card/README.md`.

Status 2026-11-06: **not run on any device or simulator.** Verified on Node tests and
RN-Web (Chromium) only — see "Verified so far". Every native share/save path below is
unverified until a new EAS build is installed.

**2026-11-10: two actions only — 공유하기 and 이미지 저장.** The per-app row (인스타그램
스토리 · 카카오톡 · 텔레그램 · 더보기) was removed: Instagram Stories needs a Meta App ID the
app does not have (the button never worked), and 카카오톡 could only open the system share
sheet anyway, so the buttons promised direct shares they could not make. 공유하기 opens the
system share sheet with the card image (the same `openShareSheet` the old 더보기 used);
the user picks KakaoTalk, Instagram, Telegram or any other app there. 이미지 저장 is
unchanged. Kept: the card, its quality (1080 × 1920 capture), the 수익금액/수익률 choice,
one action at a time, a fresh capture per shown card, drop-on-close/sign-out, and no error
for a dismissed share sheet. Removed with the row: `planShareTarget`, the installed-app
checks, the Instagram/Telegram senders, the brand icons and `shareConfig.ts`
(`EXPO_PUBLIC_META_APP_ID` is no longer read). The native settings the removed paths used —
Android `<queries>` (3 packages) and iOS `LSApplicationQueriesSchemes` — were left in place
(harmless; remove them with a later native build if wanted). `react-native-share`,
`react-native-view-shot` and `expo-media-library` stay (share sheet, capture, save).

## Where it is

거래 내역 (Wallet › 거래 내역, or a season record › 거래 내역 보기) › `현물 | 선물 | 거래 완료`.
거래 완료 lists the pinned account's completed trades (the same 거래 완료 종목 policy a
friend's season shows): a Spot holding sold to zero, or a closed futures lifetime. Each row
has 공유, which opens the 수익 공유 sheet: card preview, 수익금액 | 수익률, 공유하기 and
이미지 저장 (2026-11-10; the per-app row is gone).

| Piece | File |
| --- | --- |
| list | `src/screens/history/CompletedTrades.tsx` |
| sheet + action flow | `src/screens/history/TradeShareSheet.tsx` |
| card (1080 × 1920 design grid) | `src/components/share/TradeShareCard.tsx` |
| action icons (공유하기 · 이미지 저장) | `src/components/share/ShareActionIcon.tsx` |
| display rules | `src/features/share/tradeShareDisplay.ts` |
| outcome messages | `src/features/share/shareTargets.ts` |
| device layer (capture/share sheet/save) | `src/features/share/shareImage.native.ts` (web/test stub: `shareImage.ts`) |
| API | `getCompletedTrades` in `src/features/tradingAccount/api.ts` |

## From an order's success screen (2026-11-06)

The 주문이 완료되었습니다 sheet of an **executed SELL** (market fill or an idempotent
replay of one) shows 공유하기 above 주문으로 돌아가기 | 홈으로 가기. A BUY, an open
limit or LOC registration, or a result without an account never shows it.

| Piece | File |
| --- | --- |
| who may offer it, the check, the notes | `src/features/share/orderShare.ts` |
| sheet + check + share hand-off | `src/screens/order/OrderSuccessBottomSheet.tsx` |

- When the result shows, the app reads the account's completed trades and the asset's
  position once (`QUERY_KEYS.tradingAccount.orderShare(account, order)`). 공유하기 is
  enabled only when the completed trade of that asset on that account names **this order**
  as its `lastSellOrderId` (the SELL that closed the holding; backend contract above). It
  then opens this same 수익 공유 sheet with that trade — the 거래 완료 card, nothing new.
- Otherwise the button is disabled with the reason: holding left (`보유 수량을 모두
  매도해 …`), or no completed trade provably closed by this SELL (an earlier/later round,
  two SELLs at one instant, an older server: `… 거래 완료에서 확인해 주세요`). A failed
  read keeps it enabled; pressing asks again.
- The success sheet (an RN `Modal`) steps aside while the share sheet is open and comes
  back when it closes. Sharing never re-sends, repeats or changes the order; 주문으로
  돌아가기 only closes the sheet (the order screen stays).
- The card shows the completed trade's own figures: the holding's realized PnL since the
  account's epoch (re-entries included, the 거래 완료 policy), not only this order's part.

## Figures (never computed on the device)

- 수익금액 = the server's realized PnL in the trade's currency (`USD` to the cent, `원` to the
  won); 수익률 = the server's return rate (2 dp). Exactly one is on the card. A trade without a
  rate (basis not above zero) cannot select 수익률 and says so.
- Spot vs Futures keep their own basis (Spot: net buy amount; Futures: entry margin, fees in
  the result) — see the contract. Prices are averages of stored executions; a price without
  evidence is not drawn.
- Colors on the card: profit `#14FA2A` (one solid green), loss `#FF3B4A`, zero `#E8EDF7`;
  Long green, Short red. (The app's own red/blue list colors are unchanged.)

## Image

The card is laid out at `1080 / PixelRatio` dp, so its own snapshot is 1080 × 1920 px; the
sheet shows the same view scaled down. Capture: `react-native-view-shot` 4.0.3
(`captureRef`, PNG tmpfile; Android sized in px, iOS in points × screen scale). A capture
that is not 9:16 is refused. The capture waits until the whale/wave art and the profile photo
(or, after 6 s, the default avatar) are drawn. Texts never follow the system font size
(`allowFontScaling={false}`); long names and figures shrink, a very long nickname takes two
lines and then an ellipsis. Key content stays inside y 250–1670 (Instagram's controls cover
the rest).

## Actions (what each button really does, 2026-11-10)

| Button | Android | iOS |
| --- | --- | --- |
| 공유하기 | `react-native-share` `Share.open` with the PNG (`failOnCancel: false`); the system chooser titled "수익 공유" | the system share sheet (activity view) with the PNG |
| 이미지 저장 | `expo-media-library` `saveToLibraryAsync`; Android 13+ no permission, 12 and below storage write | add-only photo permission (사진 추가) |

Posting is always the user's action in the app they pick. A dismissed share sheet is not
an error (no message); a thrown share call is "공유를 열지 못했어요".
Direct per-app sharing (Instagram Stories with a Meta App ID, KakaoTalk with Kakao's SDK
and app key) would be a separate, explicit product decision.

## Required outside this repository

1. ~~Meta App ID (Instagram Stories)~~ — no longer needed (2026-11-10: no Stories button).
2. **A new native build.** New native modules: `react-native-share` 12.3.1,
   `react-native-view-shot` 4.0.3, `expo-media-library` ~55.0.21. JS-only updates cannot add
   them; an older build running this JS fails the share actions only (modules are imported on
   use), never the screen.
   - Android (committed `android/`, EAS skips prebuild): autolinking picks the modules up;
     `AndroidManifest.xml` gained `<queries>` packages (Instagram, KakaoTalk, Telegram) and
     removes `READ_MEDIA_VISUAL_USER_SELECTED` (declared by expo-media-library, not needed).
     No other permission was added (storage write ≤ API 32 was already declared).
   - iOS (prebuild on EAS): `app.json` adds `LSApplicationQueriesSchemes`
     (`instagram-stories`, `kakaotalk`, `tg`) and the `expo-media-library` plugin
     (`NSPhotoLibraryAddUsageDescription`; the existing photo-library text is unchanged).

## Device QA checklist (all NOT RUN)

| # | Steps | Expected |
| --- | --- | --- |
| Q1 | 거래 내역 › 거래 완료 on a season, general and beginner account | Only that account's trades; same figures as a friend sees for the season account |
| Q2 | Open 공유, switch 수익금액/수익률 | Preview changes at once; one figure only; rate disabled for a trade without one |
| Q3 | 공유하기 → pick KakaoTalk / Instagram / Telegram / Messages in the system sheet | The PNG (1080 × 1920) arrives in that app; cancel (closing the sheet) shows no error |
| Q4–Q6 | (removed 2026-11-10 with the per-app buttons) | — |
| Q7 | 이미지 저장: first time, denied, allowed | iOS asks 사진 추가 once; denied → explanation; saved → in Photos/Gallery |
| Q8 | Double-tap 공유하기 or 이미지 저장 | One share UI / one save only |
| Q9 | Close the sheet or sign out right after tapping | Nothing opens afterwards |
| Q10 | Profile photo set / none / very slow network | Photo / default avatar / default avatar after 6 s |
| Q11 | System font 200%, 320 dp phone | Sheet scrolls; the two buttons wrap their labels; the saved image unchanged |
| Q12 | Saved image in the Instagram story editor | Nothing important under Instagram's top/bottom controls |

## Verified so far

- Backend: unit 14 (`src/completed-trades`), PostgreSQL + HTTP integration 12 checks
  (`scripts/completed-trades-integration.ts`, CI flag `COMPLETED_TRADES_DB_INTEGRATION`).
- Frontend: `npm run check` 3,685/3,685 — new: display/target policy 19, sheet/list/card 21, 거래 내역 2.
- RN-Web (`test/browser/tradeShareBrowser.cjs`): 9 card scenarios at 1080 × 1920 and the
  sheet at 320–430 dp × font 1/1.5/2 × light/dark — no clipping, overlap, sideways scroll;
  key content inside the story safe area. `recordBrowser.cjs` (history, 48 layouts without its long-amount case,
  which fails on order rows before this change too): the 3-way 현물 | 선물 | 거래 완료 switch never clips.
