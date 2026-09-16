# Daily change rate and FX display updates

This additive presentation change keeps price/provider/calendar/candle storage and FX financial policies unchanged. `/api/v1/ws` remains the single app socket.

- Domestic stocks: select the session owning the displayed price using the existing market calendar. During trading this is the open session; after close, before open, on holidays and weekends it is the latest completed session. Compare its displayed price with the preceding actual KRX session's confirmed daily close. Do not reset the day's return to zero at market close.
- Crypto: compare the displayed price with the preceding UTC calendar day's confirmed daily close. Binance rolling 24h `P` and KIS raw change fields are not canonical daily returns.
- Source of truth: existing `market_candles` closed `1d` rows from `kis` / `binance`, at the exact expected daily window (KRX local midnight, crypto UTC midnight). Intraday carried price snapshots do not prove an official daily close. Missing, wrong-window, unclosed or invalid evidence returns null; no search for older prices or provider fetch is added.
- REST and realtime use one Decimal calculation. A bounded process-local cache coalesces baseline reads per asset/window, expires after 30 seconds (5 seconds for unavailable results), and never serves expired data on errors. Price changes cause no DB writes.
- FX ingestion publishes a value-free `fx_rate_updated` invalidation on the existing provider-price Redis PubSub channel after successful snapshot creation. The existing gateway forwards it only to USD/KRW `fx_rate` subscribers. Clients resync `GET /api/v1/fx/rates/current?refresh=false`; raw snapshot rates are never sent or selected by the client.
- Socket subscription acknowledgement and restored Redis subscriptions trigger REST resync. React Query still performs initial REST loading. A five-minute REST fallback recovers missed notifications, failed publication and unavailable PubSub even if the app socket remains connected; server `validUntil` expiry and foreground entry also resync. All reads use refresh=false, so display notifications do not increase external provider calls.
- FX input/account scope and Quote → Execute remain unchanged. Existing effectiveAt/capturedAt/freshness, priority, fallback, quote TTL, repricing, fees, reserved cash and idempotency rules remain authoritative on the server.

Protocol: subscribe/unsubscribe `{ type, channel: "fx_rate", pair: "USD/KRW" }`; acknowledgements echo channel/pair. Invalidation `{ type: "fx_rate_updated", channel: "fx_rate", pair: "USD/KRW" }` carries no rate, wallet or account data. Redis recovery uses the same invalidation.

## 조사 결과와 선택 이유

- 기존 REST `calculateChangeRate()`는 항상 null을 반환했다. KIS normalized ticker에는 canonical 일간 변화율이 없었고, Binance ticker의 `P` 값은 rolling 24h였다.
- 기존 completed-session price snapshot은 마지막 장중 tick도 포함할 수 있으므로 확정 종가의 근거로 사용하지 않았다. 기존 closed 1d candle의 정확한 날짜, provider, 종결 여부, OHLC, 수집 시각을 검증한다.
- 가설에 없던 추가 원인은 frontend merge가 incoming null 대신 옛 REST 등락률을 유지하고, 동일 snapshot ID의 기준가격 복구를 버리는 것이었다. 두 경로도 수정했다.
- KRX 장 종료 후·휴장일에는 화면에 표시되는 완료 세션의 직전 세션 종가를 유지하여 당일 변화율이 0으로 리셋되지 않게 했다. 장중에는 현재 세션의 직전 실제 완료 세션을 사용한다.
- 기준가격 캐시는 프로세스별 최대 1,024종목이며 같은 종목/기간의 동시 조회를 합친다. 정상 결과 30초, unavailable 5초 후 재검증한다. 외부 provider 조회와 DB write를 추가하지 않는다.
- FX 신호는 DB commit 후에만 발생한다. 낮은 우선순위 raw row가 생겨도 REST가 EXIM을 유지하면 화면도 EXIM을 유지한다. Publish 실패가 성공한 ingestion을 실패로 바꾸지 않는다.
- 기존 60초 조회는 5분 복구용 조회로 변경했다. Redis 장애 중 알림 누락, publish 실패, socket 설정 부재를 복구한다. 최초 진입, 구독 ACK, 재연결 ACK, Redis 재구독, foreground, validUntil 경계에서도 resync한다. 만료 경계 재조회는 서버의 초 단위 반올림 구간을 지난 후 실행한다.

## 변경 파일과 역할

모든 경로는 저장소 루트 기준이다.

| 파일 | 변경 역할 |
| --- | --- |
| `backend/src/assets/daily-change-rate.service.ts` | 정확한 일간 기준 종가 조회·검증, Decimal 파생 계산, 제한된 메모리 캐시 및 동시 조회 공유 |
| `backend/src/assets/assets.module.ts` | 기존 Assets module에 계산 service 등록 |
| `backend/src/assets/assets.service.ts` | REST list/detail/price 및 ticker가 같은 계산 경로 사용 |
| `backend/src/providers/fx-rate-update-event.ts` | 기존 Redis channel의 값 없는 FX 변경 신호와 best-effort 발행 |
| `backend/src/providers/exchange-rate/exchange-rate.ingestion.service.ts` | snapshot 저장 완료 후 알림 |
| `backend/src/providers/korea-exim/korea-exim-exchange.ingestion.service.ts` | 정기·on-demand 저장 완료 후 알림 |
| `backend/src/realtime/provider-price-pubsub.service.ts` | 기존 subscriber에서 FX 신호 전달, Redis 복구 알림 |
| `backend/src/realtime/asset-ticker.gateway.ts` | canonical 등락률, 동일 snapshot 기준 복구, 기존 socket의 FX 구독·backpressure 병합 |
| `frontend/src/features/asset/assetTickerPolicy.ts` | 같은 가격 snapshot의 일간 등락률 변경 수용, 시간 역전 차단 유지 |
| `frontend/src/features/market/mergeMarketAssetTicker.ts` | 새 ticker의 null을 보존하여 옛 등락률 혼합 방지 |
| `frontend/src/services/ws/realtimeSocketManager.ts` | 기존 연결에 USD/KRW FX 채널 구독·라우팅·재연결 복원 |
| `frontend/src/features/wallet/fxRateUpdates.ts` | 구독 ACK/이벤트 resync, 진행 중 요청 뒤 추가 신호 병합 |
| `frontend/src/features/wallet/useFxRateUpdates.ts` | React Query 취소·재조회, foreground/validUntil 복구 및 해제 |
| `frontend/src/screens/wallet/WalletFxScreen.tsx` | refresh=false 조회·Push 연결·5분 fallback; 입력과 Quote/Execute 로직 유지 |
| `backend/src/assets/daily-change-rate.service.spec.ts` | KRX 개장/장중/장후/주말/휴장/연도 경계, crypto UTC 경계, 누락·비정상 근거, 캐시 동시성 |
| `backend/src/assets/assets.service.spec.ts` | 실제 REST와 gateway를 연결해 양 자산군의 초기·실시간·복구 의미 일치 및 무쓰기 검증 |
| `backend/src/realtime/asset-ticker.gateway.spec.ts` | Binance rolling 값 무시, FX 구독 격리·해제·backpressure |
| `backend/src/realtime/provider-price-pubsub.service.spec.ts` | FX payload 필터링, live candle 비활성 상태 및 Redis 복구 |
| `backend/src/providers/exchange-rate/exchange-rate.ingestion.service.spec.ts` | commit 전 미발행, dry-run/실패, Redis 장애 |
| `backend/src/providers/korea-exim/korea-exim-exchange.ingestion.service.spec.ts` | 정기·on-demand의 commit 후 발행 |
| `backend/src/fx/fx.service.spec.ts` | 더 최신인 fallback row가 canonical EXIM 선택을 덮지 않는 회귀 검증 |
| `frontend/src/features/asset/assetTickerPolicy.test.ts` | 동일 snapshot 기준 복구·null 전환과 오래된 tick 거부 |
| `frontend/src/features/market/mergeMarketAssetTicker.test.ts` | 새 가격에 옛 등락률을 붙이지 않음 |
| `frontend/src/services/ws/realtimeSocketManager.test.ts` | 가격/FX 단일 연결, pair 격리, 구독 참조 수, reconnect |
| `frontend/src/features/wallet/fxRateUpdates.test.ts` | 양방향 preview·입력 유지·계좌 전환, 초기 query 경합·foreground·만료·재연결 |
| `frontend/src/features/wallet/fxUiDisplay.test.ts` | UI 회귀 테스트의 fallback interval 기대값 갱신 |
| `frontend/test/tradingUiHarness.cjs` | 기존 화면 테스트의 실시간 hook 경계 격리 |
| `frontend/test/homeTestHarness.cjs` | 기존 홈/환전 테스트의 실시간 hook 경계 격리 |
| `backend/docs/daily-change-rate-and-fx-push.md` | 설계, protocol, 변경 목록, 검증 및 한계 기록 |

## 검증 결과

- frontend `npm run check`: gated lint + typecheck + 전체 68개 테스트 파일 통과.
- frontend `npx eslint --no-fix --max-warnings=0 src/features/asset/assetTickerPolicy.ts src/features/market/mergeMarketAssetTicker.ts src/services/ws/realtimeSocketManager.ts`: 통과.
- frontend `CI=1 npm run export:web`: 통과.
- backend `pnpm typecheck`, `pnpm lint:accounts:check`, `pnpm lint:candles:check`: 통과.
- backend 변경 production 파일에 대한 check-only ESLint: 신규 service/helper, Assets module/service, ExchangeRate ingestion, PubSub 모두 통과. 기존 Korea EXIM parser와 gateway의 원래 있던 오류 5건은 남아 있다. `git show HEAD:<file> | pnpm exec eslint --no-fix --max-warnings=0 --stdin --stdin-filename <file>`로 동일 원문 오류를 재현했고 해당 비변경 로직을 임의 수정하지 않았다. 종류는 `no-base-to-string` 4건, `no-unnecessary-type-assertion` 1건이다.
- backend `pnpm test --runInBand --testPathPatterns='assets/|realtime/|fx/|source-eligibility|exchange-rate.ingestion|korea-exim-exchange.ingestion|binance-websocket|kis-websocket|market-calendar|fx-rate-snapshot-query|realtime-execution-policy'`: 68 suite, 1,098 test 통과. opt-in integration 11개는 이 명령에서 기본 skip되며 FX DB 두 종류는 별도로 실행했다.
- backend `pnpm test:e2e --runInBand`: 341 test 통과. 샌드박스의 HTTP listen 제한 때문에 허용된 로컬 실행 사용.
- backend 격리 PostgreSQL 16에서 `DATABASE_URL=<temporary DB> PGOPTIONS='-c timezone=UTC' FX_EXECUTE_DB_INTEGRATION=1 GENERAL_FX_DB_INTEGRATION=1 pnpm test --runInBand --testPathPatterns='fx.execute.integration|general-account-fx.integration'`: 두 suite 통과. 기존 migration만 임시 DB에 적용했다. 최초 로컬 Asia/Seoul 세션의 raw clock/Quote expiry 실패는 UTC 세션으로 환경을 맞춰 해결했으며 금융 코드는 수정하지 않았다.
- 금융 회귀는 Quote/Execute, expiry, rate-change requote, provider stale rejection, 양방향 FX, replay/conflict, rollback/overspend 및 reserved cash 보호를 기존 unit/DB suites에서 검증했다.
- 전체 tracked diff와 신규 파일을 검토하고 `git diff --check` 통과. DB schema/migration, 금융 계산/지갑/원장/Quote/Execute 구현, 캘린더/provider 선택/freshness 정책, snapshot throttle, 수집 주기 변경 없음. protocol은 기존 `/api/v1/ws`에 추가한 FX 채널뿐이며 REST 응답 필드 제거 없음.

## 남은 확인 사항

- 유효한 closed 1d candle이 없는 환경에서는 의도적으로 null이다. 기존 candle 수집 경로에서 기준 일봉이 반영되면 다음 캐시 재검증/ticker 갱신 때 복구한다.
- provider 연결·실기기·배포 환경의 실제 Redis를 사용하는 수동 왕복 확인은 수행하지 않았다. 장중 KIS, UTC 경계 Binance, 앱 백그라운드 복귀와 실제 환율 ingestion → 열린 환전 화면 반영을 배포 환경에서 확인할 수 있다.
- UI 레이아웃과 금액 formatter는 수정하지 않았다. 기존 작업 1 정보 구조/거래 제한 회귀 테스트는 유지하고 전체 frontend suite에서 통과했다.
- Backend 전체 변경 파일 lint는 위에 기록한 기존 오류 5건 때문에 완전 통과 상태가 아니다. 이번 추가 코드의 check-only 검사와 공식 gated lint는 통과했다.
