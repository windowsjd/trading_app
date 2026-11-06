# 수익 공유 (거래 수익 공유 카드) — setup and device QA

Contract: [backend/docs/completed-trades-share-contract.md](../../backend/docs/completed-trades-share-contract.md).
Design source: `트레이딩 클래스 수익 카드(1).png` (product owner, 2026-11-06); art provenance in
`src/assets/share-card/README.md`.

Status 2026-11-06: **not run on any device or simulator.** Verified on Node tests and
RN-Web (Chromium) only — see "Verified so far". Every native share/save path below is
unverified until a new EAS build is installed.

## Where it is

거래 내역 (Wallet › 거래 내역, or a season record › 거래 내역 보기) › `현물 | 선물 | 거래 완료`.
거래 완료 lists the pinned account's completed trades (the same 거래 완료 종목 policy a
friend's season shows): a Spot holding sold to zero, or a closed futures lifetime. Each row
has 공유, which opens the 수익 공유 sheet: card preview, 수익금액 | 수익률, the app row
(인스타그램 스토리 · 카카오톡 · 텔레그램 · 더보기) and 이미지 저장.

| Piece | File |
| --- | --- |
| list | `src/screens/history/CompletedTrades.tsx` |
| sheet + action flow | `src/screens/history/TradeShareSheet.tsx` |
| card (1080 × 1920 design grid) | `src/components/share/TradeShareCard.tsx` |
| app icons | `src/components/share/ShareTargetIcon.tsx` (Simple Icons 16.36.0 glyphs, CC0) |
| display rules | `src/features/share/tradeShareDisplay.ts` |
| per-platform target plan | `src/features/share/shareTargets.ts` |
| device layer (capture/share/save) | `src/features/share/shareImage.native.ts` (web/test stub: `shareImage.ts`) |
| Meta App ID | `src/features/share/shareConfig.ts` (`EXPO_PUBLIC_META_APP_ID`) |
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

## Share targets (what each button really does)

| Button | Android | iOS |
| --- | --- | --- |
| 인스타그램 스토리 | `react-native-share` `INSTAGRAM_STORIES` → `com.instagram.share.ADD_TO_STORY` with `source_application` = Meta App ID (after a package check) | `instagram-stories://share?source_application=…` + pasteboard background image (after `canOpenURL`) |
| 카카오톡 | system share sheet, chooser titled "공유 목록에서 카카오톡을 선택해 주세요." (only when KakaoTalk is installed) | system share sheet + the same hint in the sheet |
| 텔레그램 | direct intent to `org.telegram.messenger` | system share sheet + hint (no public way to target one app with an image) |
| 더보기 | system share sheet | system share sheet |
| 이미지 저장 | `expo-media-library` `saveToLibraryAsync`; Android 13+ no permission, 12 and below storage write | add-only photo permission (사진 추가) |

"Opened" is reported only when the app actually left the foreground within 3 s; posting is
always the user's action in the target app. A dismissed share sheet is not an error.
KakaoTalk direct sharing would need Kakao's SDK and a registered Kakao native app key
(Kakao Developers: app, Android key hash, iOS bundle id) — not in this build.

## Required outside this repository

1. **Meta App ID (Instagram Stories).** Since January 2023 Instagram refuses Stories shares
   without the sharing app's Facebook App ID ("The app you shared from doesn't currently
   support sharing to Stories"). Register the app on developers.facebook.com, then set
   `EXPO_PUBLIC_META_APP_ID=<numeric App ID>` in the EAS environment(s) of the builds that
   should share to Stories. Unset (today) → the button explains that direct Stories sharing
   is not ready and points to 더보기. No placeholder ID is shipped.
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
| Q3 | 더보기 → pick KakaoTalk/Telegram/Messages | The PNG (1080 × 1920) arrives; cancel shows no error |
| Q4 | 인스타그램 스토리 with `EXPO_PUBLIC_META_APP_ID` set, Instagram installed | Instagram opens the story editor with the card as background; nothing posts by itself |
| Q5 | Same without Instagram installed / without the App ID | "설치되어 있지 않아요" / "준비 중" message; Instagram never opens |
| Q6 | 텔레그램 on Android | Telegram's chat picker with the image |
| Q7 | 이미지 저장: first time, denied, allowed | iOS asks 사진 추가 once; denied → explanation; saved → in Photos/Gallery |
| Q8 | Double-tap any target | One share UI only |
| Q9 | Close the sheet or sign out right after tapping | Nothing opens afterwards |
| Q10 | Profile photo set / none / very slow network | Photo / default avatar / default avatar after 6 s |
| Q11 | System font 200%, 320 dp phone | Sheet scrolls; icons 2 × 2; the saved image unchanged |
| Q12 | Saved image in the Instagram story editor | Nothing important under Instagram's top/bottom controls |

## Verified so far

- Backend: unit 14 (`src/completed-trades`), PostgreSQL + HTTP integration 12 checks
  (`scripts/completed-trades-integration.ts`, CI flag `COMPLETED_TRADES_DB_INTEGRATION`).
- Frontend: `npm run check` 3,685/3,685 — new: display/target policy 19, sheet/list/card 21, 거래 내역 2.
- RN-Web (`test/browser/tradeShareBrowser.cjs`): 9 card scenarios at 1080 × 1920 and the
  sheet at 320–430 dp × font 1/1.5/2 × light/dark — no clipping, overlap, sideways scroll;
  key content inside the story safe area. `recordBrowser.cjs` (history, 48 layouts without its long-amount case,
  which fails on order rows before this change too): the 3-way 현물 | 선물 | 거래 완료 switch never clips.
