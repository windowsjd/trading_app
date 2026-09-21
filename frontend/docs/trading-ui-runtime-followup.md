# 거래 UI 및 Binance 운영 검증 결과

작업 기준: `main` / `5862e1a849f769d45f033f1656183df55163bd0f` (remote main 일치 확인).
검증일: 2026-09-19. 변경은 frontend에만 있으며 아직 commit/push/프런트엔드 배포하지 않았다.

## 8개 UI 요구사항

| 요구사항 | 결과 |
| --- | --- |
| 실시간 기술 경고 | 상세·차트·마켓의 transport/reconnect/freshness 경고를 admin만 표시. user/operator/role 미확인 및 조회 실패에서는 숨김 |
| 전일대비 | 기존 서버 등락률에 `전일대비` 접두어 적용. 양수 `+`, 음수 `-`, null `전일대비 -`. KRX 전일 세션/Binance 전일 UTC 계산은 유지 |
| 시장가·지정가 및 비율 | 프런트엔드 기본 OFF gate 제거. 양쪽 주문 타입 전환 시 quote/action 초기화, 시장가 payload에서 limitPrice 제거. 정상 비율 입력, 불가 시 클릭으로 사유 안내 |
| 매수·매도 색상 | 탭과 최종 CTA에 매수 `#16a34a`(기존 chart UP_COLOR), 매도 `#315f9b` 적용 |
| CTA 단순화 | `매수` / `매도`만 표시. 별도 `견적 확인` 제거. 내부 quote → 검증 → create 유지 |
| 보유 부족 메시지 | 매도 진입 후 수량 공란에서는 0 보유 오류를 숨김. 수량 입력 후 0 보유·초과 오류 표시. 비율 클릭은 계산 불가 사유 표시. 실제 제출 차단은 항상 유지 |
| 차트 | Web Pointer Events 수명주기 복구 + 오른쪽 가격축 Y 조절. Native 두 손가락 평행 수직 이동 Y 조절과 기존 X pan/pinch/long press 분리 |
| Holdings 필터 | 제목과 작은 pill 필터를 wrap 가능한 header에 배치. 계좌 설명은 아래. 전체/현재 종목 의미와 계좌 전환 reset 유지 |

미국의 `KIS 지연 체결 피드` 안내는 연결 실패 진단이 아닌 데이터 자체의 성격이므로 일반 사용자에게 유지했다. 주문 실패·거래 불가·잔액 부족·보유 조회 실패·견적 만료 등 행동에 필요한 오류도 유지했다.

## 실제 원인과 주문 안전성

지정가 selector는 `EXPO_PUBLIC_LIMIT_ORDER_ENABLED`의 기본 OFF 때문에 production build에서 숨겨질 수 있었다. 사용처 전체를 확인해 프런트엔드 선언/읽기/export/렌더 gate와 `.env.example` 설명을 제거했다. Backend의 별도 `LIMIT_ORDER_ENABLED` 계약은 유지하고, 추가 승인으로 운영 env만 true로 설정했다.

비율 버튼은 `ratioDisabledReason`이 있을 때 `disabled`여서 같은 사유를 안내하는 handler가 실행되지 않았다. 이제 실제 제출 pending만 잠근다. 잔액에서 예약금을 뺀 available amount, 기존 0.002 fee buffer, 기존 소수점 6자리 내림을 그대로 사용한다. USD/KRW 매수와 실제 계좌 Position 기준 매도의 25/50/75/100을 검사했다. HTTP 오류뿐 아니라 Position 응답 `state=unavailable`도 수량 생성·매도를 차단한다.

매수와 매도는 한 `orderMutation`과 기존 `runQuotedAction`을 공유한다.

1. 클릭 즉시 동기 submit lock을 잡고 account/asset/side/type/quantity/limitPrice와 epoch/revision을 고정한다.
2. 기존 account-bound quote API를 호출한다. API wrapper의 account binding에 더해 quote state/id/asset/side/type/quantity/limitPrice/expiry를 검증한다.
3. 현재 mounted scope와 revision이 여전히 일치할 때만 create를 호출한다. 수량과 지정가는 서버 quote의 canonical decimal 문자열, quoteId, 동일 idempotency key를 사용한다.
4. quote 실패·만료·불일치는 create를 호출하지 않는다. requote/idempotency conflict는 오래된 action을 해제하고 사용자 재시도를 기다린다. 자동 재시도는 없다.
5. create 응답 유실처럼 결과가 불확실하면 기존 quote/key를 보관해 명시적 재시도에 재사용한다. TTL이 지난 transport 재시도도 기존 idempotent replay 계약을 따른다.
6. 계좌/종목/side 변경·unmount 이후 도착한 quote는 create를 시작하지 않는다. 이미 시작한 create 결과는 원래 계좌 query만 invalidate하고 이전 화면 성공 상태를 표시하지 않는다.

Backend API·금융 실행·reservation·fee·Wallet·Ledger·Position·Portfolio·Season 및 idempotency helper는 변경하지 않았다. API prefix는 `/api/v1`이다.

## 차트 구현과 검증 범위

기존 Web adapter는 mousedown/mousemove/window mouseup 중심이었고 pointer cancellation/capture loss/blur/visibility 및 buttons=0 복구가 없었다. 종료 이벤트를 놓치면 drag state가 남을 수 있는 구조였다. 사용자 기기의 실제 누락 이벤트까지 특정한 것은 아니다.

현재 adapter는 단일 primary pointer를 capture하고 plot에서는 X pan, 가격축에서는 Y scale만 소유한다. inside/outside release, pointercancel, lostpointercapture, pointerleave, window 밖 pointerout, blur, tab 숨김, buttons=0, unmount에서 세션을 끝낸다. timeframe/asset key 변경으로 adapter도 교체된다. drag 중 wheel은 소비하고 새 세션을 열지 않는다. hover crosshair, wheel X zoom, horizontal/shift wheel pan, 최신 reset을 유지했다.

Native는 `Simultaneous(pinch, two-finger pan, Race(long-press pan, one-finger pan))`와 하나의 session owner를 사용한다. 두 touch ID의 거리 변화가 약 6% 이상이면 X pinch, 같은 방향의 주로 수직인 평행 이동이 10px를 넘으면 Y scale로 의도를 고정한다. 새 Reanimated 의존성이나 manual activation은 없다. touch release 후 늦은 pinch update가 새로운 zoom을 시작하지 않도록 raw-touch 종료도 검사했다. END/CANCEL/FAIL, 소유하지 않은 recognizer의 늦은 finalize, 회전·timeframe·unmount를 통합 테스트했다.

Y scale은 첫 수동 gesture 시작 시의 `center=(min+max)/2`, `halfRange=(max-min)/2`를 보관한다. `factor *= exp(deltaY*0.006)`을 0.1~10으로 clamp하고 `center ± halfRange*factor`를 공통 geometry에 적용한다. 양수·유한 범위와 최소 폭을 추가 보장한다. 아래 drag는 범위를 넓히고 위 drag는 좁힌다. 수동 상태에서 새 candle은 범위를 다시 자동 계산하지 않으며 asset/timeframe/최신에서 auto로 복귀한다. Renderer는 그대로 하나이며 candle/grid/가격 label/current price/crosshair 모두 같은 Y mapping을 사용한다.

## 검사 결과

| 검사 | 결과 |
| --- | --- |
| `npm run check` | PASS: accounts lint + guides lint + typecheck + 83개 테스트 파일, 실패/skip 0 |
| 추가 변경 chart/order helper/MarketScreen ESLint | PASS, `--no-fix --max-warnings=0` |
| 실제 Chromium | PASS: 81개 시나리오, page error 0 |
| Web production export | PASS: `npm run export:web` |
| Android production export | PASS: `npx expo export --platform android --output-dir /tmp/trading-ui-followup/export-android` |
| Android emulator/실기기, iOS 실기기 | NOT_RUN: 연결된 기기/emulator 없음. RNGH JS event receiver 통합 테스트 + Android export로 대체 |
| iOS export | NOT_RUN |
| 새 변경의 GitHub 전체 CI | NOT_RUN: 변경을 아직 commit/push하지 않음. 로컬 frontend CI 항목은 통과. Backend/DB integration 전체 workflow를 이번 UI 변경으로 재실행하지 않음 |
| `git diff --check` / 전체 diff 검토 | PASS. Backend 변경 없음, 금지된 DB 작업/운영 주문 없음 |

Chromium은 실제 React Query/React Native Web 화면과 실제 API wrapper, 공통 SVG renderer, Pointer Event adapter를 production mode로 번들했다. API/auth/account/transport 응답과 navigation만 fixture이며 localhost 외 네트워크는 차단했다. `EXPO_PUBLIC_LIMIT_ORDER_ENABLED=false` 상태로도 selector·양방향 주문을 확인했다. 320/360/390/430 × font scale 1/1.5 × BTC/BNB/PEPE/SUI/币安人生의 40개 layout에서 전일대비·시장/지정·비율·CTA·필터를 검사했다. font scale은 RN Web text/dimensions의 모사로, Native 접근성 실기기 결과는 아니다.

추가로 5종목 × 매수/매도 × 시장가/지정가의 20개 quote/create 경로, 5개 chart, user/operator/admin/unknown/role-error, 하나의 `/me` query, 8개 pointer 종료 경로, Y축 확장/축소/clamp/중심값/current-price line/candle/crosshair, X wheel/pan, reset/timeframe/unmount를 검사했다. 지갑·Position·시세 불가, quote 실패/만료/재견적/conflict, 계좌·종목 전환/지연 응답/중복 클릭, 부분/전량 매도는 컴포넌트 테스트로 검사했다.

개발 중 드러난 auto-range 극단값 처리 문제와 종료 후 늦은 Native pinch update를 수정했다. 이전 문구/이벤트를 고정한 source-contract 테스트는 새 동작을 검사하도록 갱신했다. 브라우저 fixture의 Map 형태·현재가 기대값도 실제 DTO/renderer에 맞췄다. 최종 검사에 실패를 기존 부채로 분류해 제외한 항목은 없다. 실행하지 않은 원격/기기 검사는 위 표에 별도로 표시했다.

재현 방법: [browser fixture README](../test/browser/README.md).
브라우저 결과: [81개 시나리오 JSON](artifacts/trading-ui-2026-09-19/browser-results.json).
시각 증거: [390px 매수](artifacts/trading-ui-2026-09-19/buy-390.png), [320px/font 1.5 매도](artifacts/trading-ui-2026-09-19/sell-320-font-1.5.png), [Web chart](artifacts/trading-ui-2026-09-19/chart-web.png).

## Render / Binance 실제 운영 관찰

인증된 Render CLI/API로 `trading_app` / `srv-da84cg8u01pc73cjasa0`, Singapore, Production, repo `windowsjd/trading_app`, rootDir `backend`, main을 확인했다. 관찰 당시 LIVE deploy는 `dep-dan7us8jo6nc7399guj0`, commit `5862e1a849f769d45f033f1656183df55163bd0f`였다. 서비스 주소는 https://trading-app-qtsw.onrender.com 이다.

- `BINANCE_CRYPTO_SYMBOLS`: 서비스 env에 없음(404), environment group 0개. 코드 fixed 25 fallback 사용.
- `SCHEDULER_PROVIDER_TARGET_SOURCE`: 미설정, 기본 merged.
- `BINANCE_WEBSOCKET_STREAMING_ENABLED=true`.
- `CANDLE_LIVE_STREAMING_ENABLED=false`, `CANDLE_LIVE_BINANCE_ENABLED=false`: 기존 standalone owner 유지.
- Binance public market data와 provider ingestion은 true.
- 12:27:40.5278 UTC 운영 로그: `Binance WebSocket streaming connected with 50 ticker/depth streams.`
- 12:27:50 UTC 운영 provider 상태: `binanceSymbolCount:25`.

Binance 설정이 이미 목표 상태여서 이 키는 수정하지 않았다. 이후 별도로 승인된 지정가 설정 재배포는 아래에 기록했다. 사용자 확인 DB `trading_app_fbbk`를 읽기만 했고, 기존 Redis orderbook channel을 수동 구독해 수신만 관찰했다. 신규 provider/WebSocket 연결·DB seed/migration·candle 재수집·운영 금융 주문은 수행하지 않았다.

2026-09-19 12:53:08.905~12:54:00.659 UTC(21:53~21:54 KST)에 신규 **15/15**의 최신 DB snapshot source가 `binance_spot_ws_ticker`이고 captured/effective 시각이 모두 전진했다. 동일 관찰 동안 **25/25** 종목 depth 이벤트를 반복 수신했고 각 snapshot의 asks/bids는 10/10이었다. PEPE/TRUMP처럼 가격이 같아도 수신 시각은 전진했다.

| 종목 | capturedAt UTC | effectiveAt UTC | depth 이벤트 수 |
| --- | --- | --- | --- |
| SUIUSDT | 12:53:06.271 → 12:53:55.271 | 12:53:06.236 → 12:53:55.236 | 47 |
| NIGHTUSDT | 12:53:01.601 → 12:53:33.601 | 12:53:01.566 → 12:53:33.566 | 9 |
| NEARUSDT | 12:53:05.152 → 12:53:53.153 | 12:53:05.117 → 12:53:53.117 | 47 |
| PEPEUSDT | 12:53:04.279 → 12:53:54.279 | 12:53:04.244 → 12:53:54.244 | 46 |
| ADAUSDT | 12:53:05.343 → 12:53:53.343 | 12:53:05.307 → 12:53:53.307 | 45 |
| TAOUSDT | 12:53:04.657 → 12:53:52.656 | 12:53:04.621 → 12:53:52.621 | 47 |
| WLDUSDT | 12:53:05.324 → 12:53:53.324 | 12:53:05.289 → 12:53:53.289 | 46 |
| ENAUSDT | 12:53:06.626 → 12:53:53.625 | 12:53:06.590 → 12:53:53.590 | 46 |
| AVAXUSDT | 12:53:05.107 → 12:53:58.107 | 12:53:05.071 → 12:53:58.071 | 47 |
| UNIUSDT | 12:53:06.097 → 12:53:54.096 | 12:53:06.061 → 12:53:54.061 | 47 |
| CHIPUSDT | 12:53:01.635 → 12:53:58.834 | 12:53:01.600 → 12:53:58.600 | 37 |
| LTCUSDT | 12:53:05.234 → 12:53:55.234 | 12:53:05.199 → 12:53:55.199 | 46 |
| ASTERUSDT | 12:53:07.399 → 12:53:51.397 | 12:53:07.362 → 12:53:51.362 | 25 |
| 币安人生USDT | 12:53:01.529 → 12:53:57.530 | 12:53:01.495 → 12:53:57.495 | 18 |
| TRUMPUSDT | 12:53:00.978 → 12:53:53.978 | 12:53:00.943 → 12:53:53.943 | 38 |

원시 관찰: [Binance runtime JSON](artifacts/trading-ui-2026-09-19/binance-runtime.json), [비밀 없는 env 확인 JSON](artifacts/trading-ui-2026-09-19/render-env.json).

`币安人生USDT`는 운영 ticker/depth 지속 수신과 fixture의 마켓 목록/encoded search → 상세 pair header/가격/호가 → candle/chart → 양쪽 market/limit quote/create 경로를 통과했다. 이번 diff에 ASCII-only symbol 정규식은 추가하지 않았다. 실제 주문의 종목 binding은 기존 account-scoped API의 assetId를 사용한다.

실제 운영 로그인 세션을 확보하지 않았으므로 **로그인한 Production 앱에서 detail/changeRate/chart/사용자 WebSocket을 직접 확인하는 검사는 NOT_RUN**이다. 브라우저 fixture 결과를 운영 사용자 E2E라고 간주하지 않았다. 직전 작업의 25/25 active·45/45 candle feeds·전일 UTC baseline 결과는 [기존 universe 보고서](../../backend/docs/binance-universe-2026-ytd.md)에 있으며 이번에는 그 DB 작업을 반복하지 않았다.

## 운영 지정가 활성화 — 사용자 승인 반영

추가 승인에 따라 `LIMIT_ORDER_ENABLED=true` 한 키를 설정하고 기존 backend artifact를 `deploy_only`로 재배포했다. 새 LIVE deploy는 `dep-dan8h8v40ujc73b24ar0`, 동일 commit `5862e1a849f769d45f033f1656183df55163bd0f`, 완료 시각은 **2026-09-19 13:06:42.022 UTC**이다. 별도 source build나 migration/seed는 실행하지 않았다.

`BINANCE_CRYPTO_SYMBOLS`는 계속 미설정이고 `SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED`도 미설정/default false이다. 즉 **운영 지정가 접수 플래그는 활성화했고 자동 체결은 계속 OFF**이다. 실제 quote/create 금융 주문을 운영에서 발생시켜 검증하지는 않았다.

재배포 후 `/health`, `/health/db`는 HTTP 200 / ok. `/readiness`도 HTTP 200이며 app/database/redis는 ok, Binance는 connected, subscribedSymbolCount=25, ticker 25 + depth10 25 = 50 streams, latestPriceCount=25, failed=0이었다. readiness의 전체 status는 **degraded**로, 원인은 기존 KRX 2027년 `MARKET_CALENDAR_PROVISIONAL`이다. 이를 Binance나 이번 변경의 실패로 오인하거나 달력 정책을 변경하지 않았다.

새 instance의 13:06:41 UTC 로그에서 50-stream 재연결, 13:06:51 UTC에서 binanceSymbolCount=25를 확인했다. 이어 운영 DB/Redis를 다시 읽기만 하여 **신규 15/15 ticker captured/effective 시각 전진과 25/25 depth, 각 asks/bids 10/10**을 재확인했다.

증거: [승인된 env 변경·LIVE 배포](artifacts/trading-ui-2026-09-19/render-limit-deploy.json), [최종 env](artifacts/trading-ui-2026-09-19/render-env-after.json), [health/readiness](artifacts/trading-ui-2026-09-19/production-health.json), [새 instance 연결 로그](artifacts/trading-ui-2026-09-19/render-after-logs.json), [재배포 후 지속 수신](artifacts/trading-ui-2026-09-19/binance-after-deploy.json).

Render의 단순 restart는 이전 env를 재사용하므로 변경 env 반영에는 redeploy를 사용했다. [Render deploy 문서](https://render.com/docs/deploys#restarting-a-service), [Trigger deploy API](https://api-docs.render.com/reference/create-deploy).

## 변경 파일

- 화면/환경: `src/screens/asset/{AssetDetailScreen,AssetChartScreen,AccountHoldings}.tsx`, `src/screens/market/MarketScreen.tsx`, `src/screens/order/OrderPanel.tsx`, `src/constants/env.ts`, `.env.example`.
- 공통 보호: `src/features/auth/useAdminDiagnostics.ts`, `src/features/order/validateOrderQuote.ts`.
- 차트: `CandlestickChart.tsx`, `CandlestickGestures{,.web,.native}.tsx`, `candlestickGesturePolicy.ts`, 새 `candlestickPriceScale.ts`. Renderer/viewport/금융 API/helper 원본은 유지.
- 새 회귀: `screens/asset/tradingControls.test.ts`, `components/charts/candlestickPriceScale.test.ts`, `test/browser/*`.
- 수정 회귀: chart controls/native/web integration 및 harness, env, order/trading display contracts, inlineTrading/accountHoldings/MarketScreen, displayPolicyContract, 두 trading UI harness.
- 이 보고서와 비밀 없는 runtime/browser artifacts.

전체 diff에서 매도 visible quote 경로 제거 후 공통 quote → create만 남아 있는지, account/asset scope와 canonical payload 및 idempotency 재사용, 비율 계산식 불변, admin guard, Y/X 독립 상태, reset/cleanup, Holdings account isolation을 검토했다. 미완료 항목은 프런트엔드 배포/배포 후 사용자 E2E, 기기 검증, 새 commit의 원격 전체 CI이다.
