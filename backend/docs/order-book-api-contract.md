# Display-only realtime order books

This implements the requested Binance Spot partial depth integration. It does
not change order execution, ticker prices, candles, currencies or persistence.

## Transport and ownership

The existing standalone Binance connection subscribes to ticker + `depth10`;
the existing live-candle owner subscribes to kline_5m + ticker + `depth10`.
Their existing feature gates and the live-candle Redis owner lease remain in
force. Both use the same depth processor. Combined stream envelopes identify
the symbol (partial depth has no symbol or exchange timestamp in its body).
Depth uses the default 1000ms stream, never diff depth or REST reconstruction.

Only unambiguously mapped active BINANCE crypto assets in the existing fixed
universe are supported. Both pair symbols and existing legacy base symbols are
resolved; ambiguous mappings fail closed. Provider subscriptions are independent
of app viewers. Binance's 1024-stream limit and the existing symbol shard cap
apply, counting all streams on the connection.

## Snapshot

`assetId`, `priceUnit`, `quantityUnit`, optional `marketLabel`, `asks`, `bids`,
`capturedAt`, `effectiveAt` match the frontend's shared AssetOrderBook contract.
Each level has decimal-string `price > 0` and `quantity >= 0`. Asks ascend;
bids descend. Each side may be empty or partial, up to ten levels. Binance
frames with invalid levels, duplicate prices or more than ten levels are
rejected in their entirety. Zero quantity is retained as a zero in this complete
snapshot; it is not a diff deletion instruction. No levels or exchange totals
are synthesized. Strings retain provider precision, including trailing zeros.

`capturedAt` is server receipt time; `effectiveAt` is null. `lastUpdateId` is
validated as a nonnegative safe JSON integer (or exact digit string), converted
to an internal decimal-string sequence, and compared without precision loss.
Duplicates and regressions are ignored. Sequence is retained across reconnects
within a process and never included in the app-facing snapshot.

## Redis and app WebSocket

Redis channel `market:order-book:v1` carries
`{ type: 'asset_order_book', sequence: string, book: AssetOrderBook }`.
It is transient Pub/Sub: no database write, latest cache or history. Each app
instance subscribes independently. Invalid events are rejected. Publication is
coalesced to one in-flight and one latest pending snapshot per supported asset.

Authenticated `/api/v1/ws` request:

```json
{ "type": "subscribe", "channel": "asset_order_book", "assetId": "<id>" }
```

Acknowledgement: `{ type: 'subscribed', channel: 'asset_order_book', assetId }`.
Data: `{ type: 'asset_order_book', ...AssetOrderBook }`.
Unsubscribe uses the same channel/assetId and gets an `unsubscribed` response.
Failures use `{ type: 'subscription_error', channel: 'asset_order_book',
assetId, code }`. Only active, supported Binance crypto mappings are accepted.
Validation requests count toward the per-client limit of 20; cancellation and
disconnect also cancel pending validation. Each subscribed asset holds only
the latest pending snapshot, removed on unsubscribe/disconnect. Existing socket
backpressure threshold and 100ms flush loop are reused. A new subscription waits
for the next provider frame instead of receiving a cached or synthetic book.

## Frontend

The existing shared socket owns transport/reconnect/restoration. A display-only
hook validates snapshots, isolates asset changes and rechecks freshness with the
existing foreground timer. Over five seconds since the last valid snapshot is
stale (also considering server capturedAt so queued old data is not fresh).
Loading, reconnect, auth/subscription errors and delay are visible without
affecting orders. Crypto detail always uses this live path; fixtures remain
available only to development UI harnesses. Domestic stock preview is unchanged.

Official specification: https://github.com/binance/binance-spot-api-docs/blob/master/web-socket-streams.md#partial-book-depth-streams

## 조사 결과와 기존 가설의 차이

- 고정 universe는 현재 코드의 BTC/ETH/BNB/XRP/SOL/TRX/DOGE/ZEC/XLM/LINK USDT 10개다.
  재정의하거나 별도 리스트를 추가하지 않고 기존 baseAsset 정보를 재사용했다.
- standalone은 `@ticker`, live-candle owner는 `@kline_5m` + `@ticker`였다.
  `CANDLE_LIVE_STREAMING_ENABLED && CANDLE_LIVE_BINANCE_ENABLED`이면 standalone이
  시작하지 않는다는 가설은 맞았다. 다만 Redis owner lease는 live-candle 경로에만
  존재한다. standalone의 기존 운영 소유 방식에 새 lease 정책을 추가하지 않았다.
- 두 기존 ticker/kline parser는 이미 combined envelope를 지원했다. Partial Depth에는
  symbol/event time이 없으므로 별도 socket 대신 기존 연결의 endpoint를 `/stream`으로
  바꿨다. 설정된 host/query는 보존한다. ticker bid/ask, 등락률, DB throttle은 그대로다.
- 최대 provider 구독 설정은 stream 수가 아니라 symbol 수였다. Live owner는 이를
  유지하면서 3 streams/symbol 기준 1024 한도를 추가로 지킨다(현재 10종목은 30 streams).
- 기존 candle backpressure는 sequence/revision, ticker는 최신값 coalescing이었다.
  order book은 기존 flush timer/byte threshold를 재사용하고 독립 pending map을 둔다.
- 기존 Frontend 계약·normalization·fixture를 다시 만들 필요가 없었다. 카드 변경은
  상태 문구 prop 추가뿐이며, 별도 실시간 parser/hook과 shared manager channel을 붙였다.

## 실행 조건과 운영 범위

`REDIS_URL`과 기존 Binance/Provider 활성화 설정을 그대로 사용한다. 별도 호가 활성화
환경변수, HTTP endpoint, 캐시나 DB model은 없다. 최초 수신은 다음 1초 snapshot을 기다린다.
자산 mapping은 연결 시 읽고 앱 구독 때 다시 검증한다. 연결 시 DB lookup이 실패하면
기존 owner reconnect loop가 재시도한다. 빈 mapping으로 연결해 호가가 rollover까지
사라지는 동작은 허용하지 않는다. 정상 연결 중 universe 변경의 즉시 반영은 기존 owner와
마찬가지로 이번 범위에 없다. 재연결 시 새 active mapping을 읽는다.

공통 processor의 `getStatus()`는 accepted/rejected/outOfOrder/published/publishFailed 및
bounded pending 수를 제공한다. publish 장애 로그는 상태 전환 시 한 번 기록한다.
호가 장애를 기존 금융 readiness나 주문 허용 조건에 연결하지 않았다.

## 검증 기록 (2026-09-19)

| 검증 | 결과 |
| --- | --- |
| 변경 전 Backend 단위 테스트 | 193 suites / 2,803 tests PASS |
| 최종 Backend `npm test -- --runInBand` | 199 suites / 2,867 tests PASS; opt-in 43 suites / 47 tests SKIP |
| Backend typecheck / Nest build | PASS |
| Backend candle lint gate / 새 호가 파일 check-only lint | PASS |
| Frontend typecheck / accounts lint / 변경 호가 소스 lint | PASS |
| Frontend 전체 `npm test` | 77 files PASS |
| Production web export (Preview와 LONG=true) | PASS; fixture 생성 함수와 정확한 fixture 시각이 bundle에 없음 |
| Android export | PASS (Hermes bundle); 실제 Android 기기 테스트는 NOT_RUN |
| 실제 Binance public depth10 smoke | PASS: 10+10, decimal 원문, 원본 정렬, 약 1초 간격, 재연결 |
| 실제 Redis + 별도 gateway + 실제 `/api/v1/ws` smoke | PASS: 구독/20 level/정밀도/해제/재접속 |
| Chromium 레이아웃 | 12 시나리오 PASS: 한국주식/crypto, 280/320/390px, 글자 3배, 긴 소수, production/flag off |
| 실제 Binance → processor → Redis → gateway → shared socket → hook → 카드 | PASS: BTC 10+10 렌더, loading, stale, 정상 복귀, 앱 WS 재연결 |

실시간 browser harness는 실제 Binance/Redis/WebSocket 및 실제 화면·hook·card를 사용했다.
인증과 asset/position/candle 조회는 테스트 데이터로 격리했으며 운영 배포/실계정 검증을
뜻하지 않는다. 테스트용 Redis는 `/tmp`에서 영속 저장 없이 별도 포트로 실행했다.
브라우저에서 현재가 블록·캔들 도형·매수/매도 진입을 함께 검증했고, 20개 호가 셀의
텍스트 잘림/겹침과 가로 스크롤 끝자리 접근을 측정했다.

재실행 가능한 외부/Redis smoke (명시적 opt-in):

```bash
# backend/
BINANCE_LIVE_ORDER_BOOK_SMOKE=1 npm test -- --runInBand --runTestsByPath src/providers/binance/binance-order-book-live.integration.spec.ts
ORDER_BOOK_REDIS_SMOKE=1 REDIS_URL=redis://127.0.0.1:16379 npm test -- --runInBand --runTestsByPath src/realtime/asset-order-book-redis.integration.spec.ts
```

### 기존 문제와 신규 실패 구분

최종 실행에 신규 실패는 없다. 추가로 게이트 밖 기존 gateway까지 lint 검사하면
`no-base-to-string`, `no-unnecessary-type-assertion` 2건이 남는다. HEAD 원문을
동일 eslint에 입력해 기존에도 같은 2건이 발생함을 확인했다. 규칙을 완화하지 않았다.

PostgreSQL이 로컬 5432에서 응답하지 않아 PostgreSQL 통합/전체 DB CI 및 candle release
fixture smoke는 **NOT_RUN**이다. 사용자가 언급한 날짜 의존 KRX 실패를 이번 환경에서
재현하거나 해결했다고 주장하지 않는다. candle release smoke의 clean-working-tree
요건 역시 그대로이며, 작업 중인 diff를 release 검증 결과로 취급하지 않았다.
기존 금융 테스트를 수정·삭제·skip·완화하지 않았다. 기본 suite의 opt-in SKIP은 기존
설정에 따른 것이며 이번 두 외부 smoke는 별도로 활성화해 실행했다.

## 최종 diff 검토와 남겨 둔 범위

- KIS Provider, 주문/체결/matching, Position/Wallet/Portfolio/FX/시즌 코드는 변경 없음.
- Prisma/schema/migration, CurrencyCode, 10호가 DB 저장, Redis history/cache 추가 없음.
- 기존 ticker/candle ingest 및 선택·평가 정책 변경 없음. 두 owner의 stream 목록과
  공통 depth 라우팅만 확장했으며 기존 reconnect/heartbeat/rollover/lease는 재사용한다.
- Backend/Frontend 모두 새 사용자별/provider WebSocket을 추가하지 않았다.
- 한국주식 Preview 유지, crypto fixture fallback 없음, Query cache 오염 없음.
- 동일 종목 대기는 최신 1개이며 구독 검증 포함 20개/client로 bounded, 해제/종료 시 정리한다.
- 금융 테스트 변경 없음. 기존 candle harness 변경은 새 constructor 의존성 및 client
  state 초기화뿐이다. assertion이나 금융 정책을 느슨하게 만들지 않았다.

장기 부하/24시간 rollover soak, Render 운영 배포, PostgreSQL 전체 CI와 실제 모바일 기기는
후속 검증 대상이다. 최신 snapshot 캐시, 별도 order book health endpoint, 동적 universe
재구독은 추가하지 않았다. 코스콤 연결·Diff Depth·matching/slippage·호가 저장은 명시적으로
이번 범위에서 제외한다.

## 실제 변경 파일

Backend/Frontend의 호가 연결, 해당 테스트·harness, 실행 문서만 변경했다.

| 파일 (저장소 root 기준) | 구분 |
| --- | --- |
| `backend/docs/order-book-api-contract.md` | 문서/설정 예시 |
| `backend/scripts/candle-live-smoke.ts` | 테스트/harness |
| `backend/scripts/candle-release-fixture-smoke.ts` | 테스트/harness |
| `backend/src/providers/binance/binance-order-book-live.integration.spec.ts` | 테스트/harness |
| `backend/src/providers/binance/binance-order-book.parser.spec.ts` | 테스트/harness |
| `backend/src/providers/binance/binance-order-book.parser.ts` | 구현 |
| `backend/src/providers/binance/binance-order-book.service.spec.ts` | 테스트/harness |
| `backend/src/providers/binance/binance-order-book.service.ts` | 구현 |
| `backend/src/providers/binance/binance-websocket-streaming.service.spec.ts` | 테스트/harness |
| `backend/src/providers/binance/binance-websocket-streaming.service.ts` | 구현 |
| `backend/src/providers/order-book-pubsub.service.spec.ts` | 테스트/harness |
| `backend/src/providers/order-book-pubsub.service.ts` | 구현 |
| `backend/src/providers/order-book.types.ts` | 구현 |
| `backend/src/providers/providers.module.ts` | 구현 |
| `backend/src/realtime/asset-candle-fanout.performance.spec.ts` | 테스트/harness |
| `backend/src/realtime/asset-candle.gateway.spec.ts` | 테스트/harness |
| `backend/src/realtime/asset-order-book-redis.integration.spec.ts` | 테스트/harness |
| `backend/src/realtime/asset-order-book.gateway.spec.ts` | 테스트/harness |
| `backend/src/realtime/asset-ticker.gateway.spec.ts` | 테스트/harness |
| `backend/src/realtime/asset-ticker.gateway.ts` | 구현 |
| `backend/src/realtime/live-candle-stream-supervisor.service.spec.ts` | 테스트/harness |
| `backend/src/realtime/live-candle-stream-supervisor.service.ts` | 구현 |
| `frontend/.env.example` | 문서/설정 예시 |
| `frontend/README.md` | 문서/설정 예시 |
| `frontend/docs/domestic-order-book.md` | 문서/설정 예시 |
| `frontend/src/features/asset/AssetOrderBookCard.test.ts` | 테스트/harness |
| `frontend/src/features/asset/AssetOrderBookCard.tsx` | 구현 |
| `frontend/src/features/asset/assetOrderBookPolicy.test.ts` | 테스트/harness |
| `frontend/src/features/asset/assetOrderBookPolicy.ts` | 구현 |
| `frontend/src/features/asset/orderBook.test.ts` | 테스트/harness |
| `frontend/src/features/asset/useAssetOrderBook.test.ts` | 테스트/harness |
| `frontend/src/features/asset/useAssetOrderBook.ts` | 구현 |
| `frontend/src/screens/asset/AssetDetailScreen.tsx` | 구현 |
| `frontend/src/services/ws/realtimeSocketManager.test.ts` | 테스트/harness |
| `frontend/src/services/ws/realtimeSocketManager.ts` | 구현 |
| `frontend/test/tradingUiHarness.cjs` | 테스트/harness |
