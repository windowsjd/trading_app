# Binance fixed universe expansion — 2026 YTD

Selection window is immutable: `2026-01-01T00:00:00Z <= openTime <
2026-09-19T00:00:00Z` (261 completed UTC days). Rank the sum of Binance Spot
daily kline **quote asset volume**, in USDT, without annualizing late listings.
Retain the existing ten assets and select the next fifteen eligible assets.

Implementation scope: extend `BINANCE_FIXED_ASSET_UNIVERSE`; its derived symbols
remain the runtime source of truth. Reuse provider owners, `@depth10`, metadata,
transactional asset seed and canonical candle sync. No schema, financial logic,
currency, API contract, provider architecture or automatic rotation changes.

The research script is independent, one-off tooling using Python's standard
library decimal arithmetic; it is never imported by the application. The
backend already uses decimal arithmetic (Prisma Decimal), and no binary float
is used to sum or rank quote volumes. Official Binance asset metadata supplies
display names and classification evidence, without a runtime API dependency.

## A. 선정 조사

- 기준 main: `fa4b74eaf1342ab4f68d97b77a87f4cbf9c9230b` (remote main과 일치 확인).
- 실데이터 수집: `2026-09-19T12:03:40.434961+00:00` → `2026-09-19T12:05:49.472364+00:00`.
- 최종 exchangeInfo 재확인: `2026-09-19T12:06:49.949000+00:00`.
- 기간: `2026-01-01T00:00:00Z` 포함 → `2026-09-19T00:00:00Z` 제외. 총 261 UTC 일봉.
- Source: [공식 Spot REST](https://api.binance.com/api/v3/exchangeInfo), `/api/v3/klines?interval=1d&startTime=1767225600000&endTime=1789775999999&limit=1000`.
- 명칭·분류: [Binance 공식 공개 asset metadata](https://www.binance.com/bapi/asset/v2/public/asset/asset/get-all-asset). 앱 runtime에 이 API를 추가하지 않음.
- Eligibility: 현재 exchangeInfo의 `quoteAsset=USDT`, `status=TRADING`, 기존 `hasSpotPermission` 계약(allowed flag / permissions / permissionSets 중 Spot 허용).
- 계산: `SUM(kline[7])` USDT Quote Asset Volume. Python Decimal precision 80, decimal 문자열 검증. 상위 30개는 Prisma Decimal precision 80으로 독립 재합산하여 모두 일치.
- 동률: symbol Unicode code point 오름차순. 선택 경계 동률 없음. 순위 15개를 임의 교체하지 않음.
- 순차 요청(동시성 1), 요청 간 150ms 대기, 최대 4회 시도와 exponential backoff. HTTP 429 Retry-After 존중, 418 또는 긴 대기 필요 시 중단.
- 중간 상장: 실제 제공된 일봉만 합산. NIGHT 192일, CHIP 151일, 币安人生 255일. 연환산 없음.
- 전체 현재 후보 493개 = 기존 10 + 정책 제외 97 + 신규 적격 후보 386. 조회 실패/빈 일봉 후보 없음.
- 제외: stablecoin(USTC 등 depegged 설계 포함), wrapped/staked representation, 금 등 원자산 pegged token, tokenized stock/ETF/leveraged product, fiat. meme/DeFi/L1/L2/AI라는 이유로는 제외하지 않음.
- 기존 유지: BTC, ETH, BNB, XRP, SOL, TRX, DOGE, ZEC, XLM, LINK.

주요 판정 근거: [CHIP은 USD.AI의 governance token](https://www.binance.com/en/research/analysis/USD.AI)으로 USDai stablecoin과 구분한다. [FRAX는 FXS rebrand](https://www.binance.com/en/support/announcement/detail/f9daf68cb1214dbeb2ed97af2684b5d8)이므로 과거 동일 ticker의 stablecoin과 혼동해 제외하지 않는다. [WBETH](https://www.binance.com/en-IN/support/faq/detail/e252366155174ba6887f6b32e3798273)는 staked ETH representation이며, [PAXG](https://www.binance.com/en/academy/articles/what-is-pax-gold-paxg)는 gold-pegged token이다. Binance metadata의 `stablecoin`, `tCommodities`, `bStocks`, `isLegalMoney`, `etf` 분류 및 WBTC/WBETH/BNSOL/USTC의 명시적 정책을 기록했다.

### 적격 상위 30개

| 신규 후보 순위 | Symbol | YTD Quote Volume (USDT) | 일봉 수 |
| --- | --- | ---: | ---: |
| 1 | SUIUSDT | 11524719209.76761000 | 261 |
| 2 | NIGHTUSDT | 9905832262.18606000 | 192 |
| 3 | NEARUSDT | 9557436410.06610000 | 261 |
| 4 | PEPEUSDT | 9393896856.05057355 | 261 |
| 5 | ADAUSDT | 8801209042.52876000 | 261 |
| 6 | TAOUSDT | 8719733267.53339000 | 261 |
| 7 | WLDUSDT | 7908521895.59872000 | 261 |
| 8 | ENAUSDT | 5685639156.57166100 | 261 |
| 9 | AVAXUSDT | 5632948921.55401000 | 261 |
| 10 | UNIUSDT | 5430831844.05916000 | 261 |
| 11 | CHIPUSDT | 5248815187.94492000 | 151 |
| 12 | LTCUSDT | 5117111157.98885000 | 261 |
| 13 | ASTERUSDT | 4366964196.58235000 | 261 |
| 14 | 币安人生USDT | 4322866810.68175000 | 255 |
| 15 | TRUMPUSDT | 4305546133.53216700 | 261 |
| 16 | XPLUSDT | 4296979948.95189200 | 261 |
| 17 | PUMPUSDT | 4202478252.21368700 | 261 |
| 18 | REUSDT | 4109804967.72126000 | 93 |
| 19 | DASHUSDT | 4040952521.17637000 | 261 |
| 20 | SENTUSDT | 4036393753.89689000 | 240 |
| 21 | BCHUSDT | 3981003136.08540000 | 261 |
| 22 | AAVEUSDT | 3969287467.81536000 | 261 |
| 23 | FETUSDT | 3189886964.74142000 | 261 |
| 24 | PENGUUSDT | 3122197148.33307000 | 261 |
| 25 | ONDOUSDT | 2932895914.27619000 | 261 |
| 26 | ZAMAUSDT | 2863562889.32267000 | 229 |
| 27 | WLFIUSDT | 2819612448.16425000 | 261 |
| 28 | FILUSDT | 2812349182.05274000 | 261 |
| 29 | HBARUSDT | 2768307028.13390000 | 261 |
| 30 | FOGOUSDT | 2734142969.03838000 | 247 |

15위 TRUMP와 16위 XPL의 차이: **8566184.58027500 USDT**. 17위 PUMP는 다음 경계 후보.

### 주요 제외 종목

| Symbol | YTD Quote Volume (USDT) | 제외 이유 |
| --- | ---: | --- |
| USDCUSDT | 446794808663.54901000 | stablecoin (including depegged stablecoin designs) |
| USD1USDT | 44351057507.62996000 | stablecoin (including depegged stablecoin designs) |
| FDUSDUSDT | 11719388119.94690000 | stablecoin (including depegged stablecoin designs) |
| PAXGUSDT | 11379496194.11146300 | commodity-pegged representation |
| RLUSDUSDT | 8100822106.29960000 | stablecoin (including depegged stablecoin designs) |
| XAUTUSDT | 5772527798.78727700 | commodity-pegged representation |
| EURUSDT | 5226250821.34226000 | fiat, not a plain crypto asset |
| UUSDT | 5203453795.80390000 | stablecoin (including depegged stablecoin designs) |
| SNDKBUSDT | 2270183159.47161500 | tokenized stock/ETF representation (including leveraged ETFs) |
| SPCXBUSDT | 2033746853.12991000 | tokenized stock/ETF representation (including leveraged ETFs) |
| XUSDUSDT | 1659454081.77410000 | stablecoin (including depegged stablecoin designs) |
| WBTCUSDT | 1098929213.83991570 | wrapped/staked representation of another crypto asset |
| BFUSDUSDT | 1070099755.02860000 | stablecoin (including depegged stablecoin designs) |
| USDEUSDT | 1067525051.03320000 | stablecoin (including depegged stablecoin designs) |
| MUBUSDT | 883330546.79352000 | tokenized stock/ETF representation (including leveraged ETFs) |
| WBETHUSDT | 513032124.55905600 | wrapped/staked representation of another crypto asset |
| BNSOLUSDT | 295539111.22660000 | wrapped/staked representation of another crypto asset |
| USTCUSDT | 220508846.78405000 | stablecoin (including depegged stablecoin designs) |
| TUSDUSDT | 53890936.09220000 | stablecoin (including depegged stablecoin designs) |
| USDPUSDT | 22213253.39250000 | stablecoin (including depegged stablecoin designs) |

## B. 신규 15 계약

모두 `market=BINANCE`, `assetType=crypto`, `currencyCode=priceCurrency=settlementCurrency=USD`. Provider quote만 USDT. 거래대금은 고정 선정 기간의 USDT 합계다.

| Rank | baseAsset | Symbol | 공식 표시명 | YTD Quote Volume (USDT) | TRADING / Spot | tickSize | display decimals |
| --- | --- | --- | --- | ---: | --- | --- | ---: |
| 1 | SUI | SUIUSDT | Sui | 11524719209.76761000 | YES / YES | 0.00010000 | 4 |
| 2 | NIGHT | NIGHTUSDT | Midnight | 9905832262.18606000 | YES / YES | 0.00001000 | 5 |
| 3 | NEAR | NEARUSDT | NEAR Protocol | 9557436410.06610000 | YES / YES | 0.00100000 | 3 |
| 4 | PEPE | PEPEUSDT | Pepe | 9393896856.05057355 | YES / YES | 0.00000001 | 8 |
| 5 | ADA | ADAUSDT | Cardano | 8801209042.52876000 | YES / YES | 0.00010000 | 4 |
| 6 | TAO | TAOUSDT | Bittensor | 8719733267.53339000 | YES / YES | 0.10000000 | 1 |
| 7 | WLD | WLDUSDT | Worldcoin | 7908521895.59872000 | YES / YES | 0.00010000 | 4 |
| 8 | ENA | ENAUSDT | Ethena | 5685639156.57166100 | YES / YES | 0.00010000 | 4 |
| 9 | AVAX | AVAXUSDT | Avalanche | 5632948921.55401000 | YES / YES | 0.00100000 | 3 |
| 10 | UNI | UNIUSDT | Uniswap | 5430831844.05916000 | YES / YES | 0.00100000 | 3 |
| 11 | CHIP | CHIPUSDT | USD.AI | 5248815187.94492000 | YES / YES | 0.00001000 | 5 |
| 12 | LTC | LTCUSDT | Litecoin | 5117111157.98885000 | YES / YES | 0.01000000 | 2 |
| 13 | ASTER | ASTERUSDT | Aster | 4366964196.58235000 | YES / YES | 0.00100000 | 3 |
| 14 | 币安人生 | 币安人生USDT | 币安人生 | 4322866810.68175000 | YES / YES | 0.00010000 | 4 |
| 15 | TRUMP | TRUMPUSDT | OFFICIAL TRUMP | 4305546133.53216700 | YES / YES | 0.00100000 | 3 |

## C. 구현

- `BINANCE_FIXED_ASSET_UNIVERSE`에 선정 순서대로 15개 추가. 기존 10개 객체의 모든 필드는 그대로 유지. `BINANCE_FIXED_SYMBOLS`에서 config fallback과 env resolver가 파생됨.
- DB seed의 validation → transaction/upsert → verification 경로는 그대로 사용. 숫자 10에 의존한 설명과 테스트만 동적 count 또는 25로 갱신.
- 실제 선정된 `币安人生USDT`를 지원하도록 crypto symbol 검증에 Han script를 허용. target resolver, candle ingestion/normalization, depth parser, frontend orderbook eligibility/preview만 보정. 주식 symbol 검증, 주문/FX/financial logic는 변경하지 않음. 기존 구분자·공백·길이 제한은 유지.
- [공식 币安人生 listing](https://www.binance.com/zh-TC/support/announcement/detail/51881f9d018242ce80bed6ce015de2a7)과 exchangeInfo 확인. 임의 영문 alias를 만들지 않음.
- OrderBook은 active DB asset + fixed universe에서 25개 mapping을 확인. 기존 owner와 parser/fanout, `@depth10` 유지.
- Live candle owner: 종목당 ticker+kline_5m+depth10 = 75 streams, 기존 1024 한도 및 기본 200-symbol cap 이내. Standalone ticker owner: ticker+depth10 = 50 streams. Shard/pool/Redis 구조 변경 없음.
- Candle target은 active DB assets에서 기존 `MarketCandleSyncService`가 선택. 기존 저장 정책은 5m 35일, 1d/1w 365일.
- Frontend에는 10개 allowlist가 없고 asset API를 20개씩 페이지 조회함. 리스트/정렬/금융 표시/주문 UI 계약 유지. 한자 symbol의 호가 지원에 필요한 2개 helper와 관련 테스트만 변경.

### 환경 조사

| 설정 | 로컬 실제 값(변경 전) | 조치/필요 값 |
| --- | --- | --- |
| BINANCE_CRYPTO_SYMBOLS | 기존 10개 명시 | `.env.local`을 빈 값으로 변경. 다음 시작부터 fixed 25 사용. `.env.example`과 README 예시도 빈 값 사용 |
| SCHEDULER_PROVIDER_TARGET_SOURCE | unset → merged | merged 또는 active_assets로 active asset 포함 |
| BINANCE_WEBSOCKET_STREAMING_ENABLED | true | 유지; 재시작 시 25 ticker+depth targets 로딩 |
| CANDLE_LIVE_STREAMING_ENABLED / CANDLE_LIVE_BINANCE_ENABLED | unset → false | 로컬은 standalone ticker mode; 임의 모드 변경 없음 |
| BINANCE_PUBLIC_MARKET_DATA_ENABLED / PROVIDER_INGESTION_ENABLED | true / true | 유지 |
| SCHEDULER_MARKET_CANDLE_SYNC_ENABLED | true | 유지 |
| Render Dashboard 실제 env | 확인 권한/연결 없음 | NOT_RUN. 코드 배포 시 BINANCE_CRYPTO_SYMBOLS 삭제/빈 값 또는 fixed 25와 동일한 명시값 확인, 서비스 재시작 |

Render Dashboard 설정은 조작하지 않았다. Repository에 Render deployment manifest는 없다. 로컬 env와 배포 서비스 env는 같다고 가정하지 않는다.

### 변경 파일 전체 목록


- [backend/.env.example](../../backend/.env.example)
- [backend/README.md](../../backend/README.md)
- [backend/artifacts/binance-universe-2026/all-candidates.csv](../../backend/artifacts/binance-universe-2026/all-candidates.csv)
- [backend/artifacts/binance-universe-2026/original-universe.json](../../backend/artifacts/binance-universe-2026/original-universe.json)
- [backend/artifacts/binance-universe-2026/runtime-verification.json](../../backend/artifacts/binance-universe-2026/runtime-verification.json)
- [backend/artifacts/binance-universe-2026/selection.json](../../backend/artifacts/binance-universe-2026/selection.json)
- [backend/docs/binance-universe-2026-ytd.md](../../backend/docs/binance-universe-2026-ytd.md)
- [backend/docs/order-book-api-contract.md](../../backend/docs/order-book-api-contract.md)
- [backend/docs/provider-ingestion-foundation.md](../../backend/docs/provider-ingestion-foundation.md)
- [backend/scripts/binance-fixed-universe-smoke.ts](../../backend/scripts/binance-fixed-universe-smoke.ts)
- [backend/scripts/dev-recover-local-data.ts](../../backend/scripts/dev-recover-local-data.ts)
- [backend/scripts/lib/seed-binance-fixed-universe.spec.ts](../../backend/scripts/lib/seed-binance-fixed-universe.spec.ts)
- [backend/scripts/research-binance-universe-2026.py](../../backend/scripts/research-binance-universe-2026.py)
- [backend/scripts/seed-binance-fixed-asset-universe.ts](../../backend/scripts/seed-binance-fixed-asset-universe.ts)
- [backend/scripts/test_research_binance_universe_2026.py](../../backend/scripts/test_research_binance_universe_2026.py)
- [backend/src/assets/asset-candles.service.spec.ts](../../backend/src/assets/asset-candles.service.spec.ts)
- [backend/src/assets/asset-candles.service.ts](../../backend/src/assets/asset-candles.service.ts)
- [backend/src/assets/candle-response.builder.spec.ts](../../backend/src/assets/candle-response.builder.spec.ts)
- [backend/src/assets/candle-response.builder.ts](../../backend/src/assets/candle-response.builder.ts)
- [backend/src/assets/market-candle-sync.service.spec.ts](../../backend/src/assets/market-candle-sync.service.spec.ts)
- [backend/src/providers/binance/binance-candle.ingestion.service.spec.ts](../../backend/src/providers/binance/binance-candle.ingestion.service.spec.ts)
- [backend/src/providers/binance/binance-candle.ingestion.service.ts](../../backend/src/providers/binance/binance-candle.ingestion.service.ts)
- [backend/src/providers/binance/binance-fixed-asset-universe.spec.ts](../../backend/src/providers/binance/binance-fixed-asset-universe.spec.ts)
- [backend/src/providers/binance/binance-fixed-asset-universe.ts](../../backend/src/providers/binance/binance-fixed-asset-universe.ts)
- [backend/src/providers/binance/binance-order-book.parser.ts](../../backend/src/providers/binance/binance-order-book.parser.ts)
- [backend/src/providers/binance/binance-order-book.service.spec.ts](../../backend/src/providers/binance/binance-order-book.service.spec.ts)
- [backend/src/providers/binance/binance-symbol-metadata.service.spec.ts](../../backend/src/providers/binance/binance-symbol-metadata.service.spec.ts)
- [backend/src/providers/binance/binance-tick-size.spec.ts](../../backend/src/providers/binance/binance-tick-size.spec.ts)
- [backend/src/providers/provider-config.service.spec.ts](../../backend/src/providers/provider-config.service.spec.ts)
- [backend/src/providers/provider-config.service.ts](../../backend/src/providers/provider-config.service.ts)
- [backend/src/providers/provider-target-resolver.service.spec.ts](../../backend/src/providers/provider-target-resolver.service.spec.ts)
- [backend/src/providers/provider-target-resolver.service.ts](../../backend/src/providers/provider-target-resolver.service.ts)
- [backend/src/realtime/live-candle-stream-supervisor.service.spec.ts](../../backend/src/realtime/live-candle-stream-supervisor.service.spec.ts)
- [frontend/src/features/asset/assetOrderBookPolicy.test.ts](../../frontend/src/features/asset/assetOrderBookPolicy.test.ts)
- [frontend/src/features/asset/assetOrderBookPolicy.ts](../../frontend/src/features/asset/assetOrderBookPolicy.ts)
- [frontend/src/features/asset/orderBookPreview.ts](../../frontend/src/features/asset/orderBookPreview.ts)

비추적 local 설정: `backend/.env.local`의 BINANCE_CRYPTO_SYMBOLS만 빈 값으로 변경. Secret 값은 기록하지 않음.

### 재현 및 artifact

- [selection.json](../artifacts/binance-universe-2026/selection.json): 원본 수집 시각, 최종 검증 시각, 상위30, 선정15, 97개 제외 종목, metadata/response SHA-256.
- [all-candidates.csv](../artifacts/binance-universe-2026/all-candidates.csv): 493개 전체 symbol, volume, 일봉 coverage, 분류 근거, precision, 원본 응답 SHA-256.
- [original-universe.json](../artifacts/binance-universe-2026/original-universe.json): 기존 10개 계약 회귀 확인용 snapshot.
- [research script](../scripts/research-binance-universe-2026.py): Python stdlib만 사용. 앱이 import하지 않음. CSV/JSON은 audit artifact이며 runtime 종목 리스트가 아님.

```sh
cd backend
python3 scripts/research-binance-universe-2026.py \
  --cache-dir /tmp/binance-ytd --output-dir /tmp/binance-ytd-result
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts -p 'test_research_*.py'
```

실행 시 현재 exchangeInfo로 eligibility를 다시 조사하되 날짜 범위는 고정된다. 미래에는 상장/상폐·provider 수정으로 결과가 바뀔 수 있다. 당시 결과는 저장소의 CSV/JSON에 고정되며, raw cache를 보존했다면 `--replay`로 정확히 재합산한다. 이번 raw cache는 `/tmp/binance-universe-2026`에 보관했고 493개 raw kline 파일은 repository에 넣지 않았다.

## D. 데이터 준비

- 대상: 사용자가 명시적으로 확인한 Render Singapore `trading_app_fbbk` (`dpg-da7ac0e1egvs73e2sv20-a`). 로컬 `NODE_ENV=development`만 보고 DB 환경을 추정하지 않았다.
- Canonical seed dry-run: provider validation **25/25**, 예상 **create 15 / update 0 / unchanged 10**. 적용 전 DB에는 기존 10개만 존재했다.
- Canonical seed apply: provider validation **25/25** 후 기존 transaction/upsert 실행, **create 15 / update 0 / unchanged 10**. 최종 **25/25 active with correct contract**.
- 최종 read-only 검증 시각: **2026-09-19T12:19:56.013Z**. 기존 10개의 ID와 계약 필드 모두 보존. Asset 삭제, 금융 데이터 수정, migration 없음.
- 현재가: 기존 `BinancePriceIngestionService`로 신규 15개만 수집하여 **15 created / 0 failed**. 전부 USD, source=`binance_public_rest_24hr_ticker`; `priceLocal`, `effectiveAt`, `capturedAt`, KRW 환산값도 저장됨. 수집 snapshot은 12:11:20~12:11:25 UTC이며 배포 서비스의 지속 갱신 확인을 의미하지 않는다.
- Candle: 기존 `candle-baseline-sync.ts` → `MarketCandleSyncService` 사용. 신규 asset ID만 지정하여 1d/1w 365일, 5m 35일의 bounded sync를 각각 실행했다. **45/45 feeds complete, incomplete 0, failed 0**.
- 5m 요청 범위: `[2026-08-15T12:13:01.422Z, 2026-09-19T12:13:01.422Z)`. 기존 interval 정렬/coverage 정책 기준 15개 모두 시작 충족·내부 gap 없음·끝까지 coverage 확보. 각 10,080행, 실제 openTime은 8월 15일 12:15부터 9월 19일 12:10 UTC.
- 1d/1w 요청 범위: `[2025-09-19T12:11:52.067Z, 2026-09-19T12:11:52.067Z)`. 중간 상장 종목은 Binance가 제공하는 실제 이력만 저장했다. 아래 행 수는 진행 중인 최신 candle도 포함한 앱 저장 결과이며, **선정 거래대금에는 9월 19일 진행 일봉이 포함되지 않는다**.
- 전일 baseline: **15/15** 모두 `2026-09-18T00:00:00Z`의 1d candle이 `isClosed=true`, `closeTime=2026-09-19T00:00:00Z`, source=`binance_klines`. close를 조사 원본의 Binance 확정 일봉과 decimal 비교하여 전부 일치. rolling 24h 등락률 fallback을 추가하지 않았다.
- Orderbook: 실제 DB `assetId ↔ symbol ↔ baseAsset` mapping **25/25**, 실제 Binance `@depth10` frame **25/25**를 기존 production parser로 검증. 신규 전부 포함하며 매도 10 + 매수 10 유지.

| 신규 baseAsset | 수집 priceLocal (USD) | 전일 확정 close (USD) | 5m 행 | 1d 행 | 1w 행 |
| --- | ---: | ---: | ---: | ---: | ---: |
| SUI | 0.85920000 | 0.81440000 | 10080 | 365 | 52 |
| NIGHT | 0.02485000 | 0.02402000 | 10080 | 193 | 28 |
| NEAR | 3.66800000 | 3.76300000 | 10080 | 365 | 52 |
| PEPE | 0.00000381 | 0.00000382 | 10080 | 365 | 52 |
| ADA | 0.22680000 | 0.22440000 | 10080 | 365 | 52 |
| TAO | 268.70000000 | 250.20000000 | 10080 | 365 | 52 |
| WLD | 0.43240000 | 0.42460000 | 10080 | 365 | 52 |
| ENA | 0.19700000 | 0.16840000 | 10080 | 365 | 52 |
| AVAX | 9.22100000 | 8.20400000 | 10080 | 365 | 52 |
| UNI | 9.12200000 | 8.86500000 | 10080 | 365 | 52 |
| CHIP | 0.04505000 | 0.04489000 | 10080 | 152 | 22 |
| LTC | 58.20000000 | 58.15000000 | 10080 | 365 | 52 |
| ASTER | 0.76900000 | 0.76700000 | 10080 | 349 | 50 |
| 币安人生 | 0.51000000 | 0.51520000 | 10080 | 256 | 37 |
| TRUMP | 2.05500000 | 2.08400000 | 10080 | 365 | 52 |

상세 asset ID, source, timestamp, KRW 값, 각 interval의 min/max 및 coverage 결과는
[runtime-verification.json](../artifacts/binance-universe-2026/runtime-verification.json)에 보존했다.

실행 경로는 다음과 같다. `--asset-id`는 해당 DB에서 검증한 신규 15개 ID를 각각 반복
전달했으며, 전체 자산 복구 스크립트는 실행하지 않았다. Provider validation을 생략하지 않았다.

```sh
cd backend
node --import tsx scripts/seed-binance-fixed-asset-universe.ts
node --import tsx scripts/seed-binance-fixed-asset-universe.ts --apply
# 아래 asset ID 인자는 대상 DB에서 조회한 신규 ID 15개로 구성한다.
node --import tsx scripts/candle-baseline-sync.ts --apply --days 365 --target 1d --target 1w --asset-id <new-asset-id> ...
node --import tsx scripts/candle-baseline-sync.ts --apply --days 35 --target 5m --asset-id <new-asset-id> ...
```

## E. 검증

| 검사 | 결과 |
| --- | --- |
| Python research arithmetic/boundary/eligibility/exclusion tests | PASS 6 |
| 독립 Prisma Decimal 재합산 | PASS 상위 30/30 |
| Backend candle lint + format / account lint | PASS |
| 변경한 비-gated provider/smoke lint | PASS |
| Backend typecheck / build | PASS |
| Backend 전체 unit tests | PASS 200 suites, 2,932 tests; 기존 opt-in integration 43 suites / 47 tests는 disabled |
| Backend canonical E2E | PASS 341 tests |
| Frontend npm run check (두 lint gates + typecheck + 전체 tests) | PASS 81 test files |
| 변경 frontend helper lint | PASS |
| Frontend production web export | PASS |
| Hermes compiler의 Han symbol 정규식 컴파일 | PASS |
| Binance exchangeInfo / live precision / REST ticker | PASS 각각 25/25 |
| Binance WS ticker / 실제 depth10 10+10 | PASS 각각 25/25 |
| 실제 DB 대상 orderbook mapping / runtime live metadata | PASS 각각 25/25 |
| 전체 repository CI | 부분 실행. 위 quality/E2E 실행, DB fixture jobs는 NOT_RUN |

최초 smoke에서는 币安人生 ticker가 15초 내 도착하지 않아 24/25로 FAIL이었다.
같은 공식 stream의 실제 frame을 확인한 뒤 **타임아웃이나 assertion 변경 없이**
전체 smoke를 다시 실행하여 25/25 PASS를 얻었다. 최초 결과를 숨기지 않는다.
최초 E2E는 sandbox의 listen 제한으로 실패했고, 동일 명령을 로컬 서버가 허용되는
환경에서 재실행하여 341/341 통과했다. 확장으로 드러난 기존 stream count의
30/10 assertion은 Universe에서 파생하도록 수정했으며 기능 assertion은 유지했다.
알려진 KRX MARKET_CLOSED 실패는 이번 unit/E2E 실행에서 재현되지 않았다.
Candle release fixture의 clean-working-tree 항목은 해당 job을 실행하지 않아 NOT_RUN이다.

Diff review: 신규는 정확히 15개, 총 25개이며 선정 artifact와 symbol/name/tickSize가
일치한다. 기존 열 개 객체는 base main의 객체와 동일하다. symbol 목록은 runtime
상수 한 곳에서만 관리한다. Prisma schema/migration, 주문/Wallet/Position/FX/Portfolio
코드, depth10 깊이, WS 소유 구조, Redis 채널은 변경하지 않았다. 자동 rotation이나
ranking runtime은 추가하지 않았다.

## F. 미완료

- Render 코드 배포/env 확인/재시작: NOT_RUN (Dashboard 접근 수단 없음).
- 로그인한 실제 앱의 3~5종목 UI 점검: NOT_RUN. 배포 API는 인증 없는 조회에 정상적으로 HTTP 401 UNAUTHORIZED를 반환. 기존 토큰을 우회 생성하지 않음.
- 확인된 DB의 asset seed·가격·candle 작업은 모두 실행 및 검증 완료. 운영 DB의 주문 체결 테스트만 NOT_RUN (요청 범위에서 불필요).
- Binance 공식 exchangeInfo·precision·REST/WS ticker·depth·kline은 모두 실데이터로 검증했다. 배포 서비스가 변경 코드를 로드하여 지속 구독하는지는 배포/재시작 전이므로 NOT_RUN.
- 전체 CI의 PostgreSQL integration/fixture job: NOT_RUN (별도 격리 DB/Redis 미준비; 확인된 Render DB에서 금융 fixture 생성/수정 금지).
