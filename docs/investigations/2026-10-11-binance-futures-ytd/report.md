# Binance 2026 누적 선물 거래대금 조사

**완료:** Binance 공식 공개 API의 현재 USDT 무기한 계약 525개를 전수 집계했고, 525개 모두 정상 집계됐다. 암호화폐 COIN 계약은 523개다. 순수 상위 25개와 상품 정책을 만족하는 등록 후보 25개를 각각 선정했다. 기존 앱 기초자산만 사용하는 후보는 23개이며, 거래대금 순으로 선정한 등록 후보 25개 중 5개는 새 기초자산 등록이 선행되어야 한다.

상품·기초자산 등록, DB 접근, Migration, 운영 환경변수, Render 배포, 거래 활성화, 주문 API 호출은 실행하지 않았다. 운영 DB의 현재 등록 상태는 검증하지 않았으므로 “기존”은 저장소 고정 Universe 기준이다.

## 집계 범위와 방식

- 고정 기간: **2026-01-01 00:00:00 UTC 포함부터 2026-10-10 00:00:00 UTC 제외**, 282일. 마지막 포함 일봉은 10월 9일이다.
- `/fapi/v1/exchangeInfo`의 `PERPETUAL / TRADING / quoteAsset=USDT / marginAsset=USDT` 조건을 적용했다. 기존 앱 25종목으로 시장 조사 대상을 제한하지 않았다.
- 네 조건에 맞는 525개 중 `underlyingType=COIN`은 523개다. INDEX 계약 `ALLUSDT`, `BTCDOMUSDT` 2개도 참고용으로 집계했다. **525개 전체, 523개 COIN, 현행 Futures 계약 파서가 허용하는 518개 중 어느 모집단을 사용해도 상위 25개 순서와 금액이 동일하다.**
- 공식 [Futures 시장 데이터 명세](https://developers.binance.info/en/docs/catalog/core-trading-derivatives-trading-usd-s-m-futures/api/rest-api/market-data)의 `GET /fapi/v1/klines`를 사용했다. `interval=1d&startTime=1767225600000&endTime=1791590399999&limit=499`로 각 계약을 조회했다.
- `SUM(kline[7])`의 Quote Asset Volume을 USDT로 합산했다. Prisma Decimal precision 80을 사용했으며, 525개 합계를 BigInt 고정소수점과 Python Decimal precision 80으로 각각 독립 검산했다. 가격×수량, 24시간 Ticker, 연환산, USD/KRW 환산은 사용하지 않았다.
- UTC 정각 openTime과 `closeTime=openTime+86400000-1`을 검증했다. 상장 UTC 일자 이후 모든 일봉을 검사했고, 상장 전 부재는 누락으로 보지 않았다. 연중 상장 53개는 상장 이후만 합산했다. onboardDate 이전 이력에 대한 불일치는 0개였다.
- 동일 openTime은 한 번만 합산하고, 충돌하는 중복은 실패로 처리한다. 중복·누락은 모두 0개였다. 데이터 실패나 누락이 있으면 확정 순위를 비우고 PARTIAL로 종료하는 구현이다.
- 동률은 심볼 코드 순으로 정렬한다. 상장일은 Futures exchangeInfo의 `onboardDate` UTC 날짜이며 Spot 상장일이나 프로젝트 창설일을 의미하지 않는다.

## 조사 요약

| 항목                                       | 결과                            |
| ------------------------------------------ | ------------------------------- |
| 전체 exchangeInfo 계약 수                  | 924                             |
| 네 가지 기본 조건 대상                     | 525                             |
| COIN 암호화폐 계약                         | 523                             |
| 현행 Futures 계약 검증을 통과한 계약       | 518                             |
| 정상 집계 완료                             | 525                             |
| 조회 실패 또는 데이터 누락                 | 0                               |
| 중복 일봉                                  | 0                               |
| 실제 포함 일봉                             | 2026-01-01부터 2026-10-09까지   |
| 전체 API 요청                              | **537**                         |
| 전체 525개 누적 거래대금                   | 10,377,184,340,917.0817053 USDT |
| COIN 523개 누적 거래대금                   | 10,375,820,226,036.5739053 USDT |
| 상위 25개 비중 COIN 모집단                 | **79.746110719345%**            |
| 상위 25개 비중 현행 계약 검증 518개 모집단 | 80.031491489175%                |
| 상위 25개 비중 INDEX 포함 전체 모집단      | 79.735627831818%                |

요청은 초기 exchangeInfo 연결 검증 1회, 본 수집 529회(525개 일봉과 Futures time·exchangeInfo·Spot exchangeInfo·최종 Futures exchangeInfo), 공식 자산 분류 1회, 상위 3종목 분할 재조회 6회다. 전부 HTTP 200이었으며 429/418·재시도·최종 실패는 없었다. 본 수집 첫 요청은 2026-10-10T17:56:01.964Z, 마지막 검증 요청은 2026-10-10T18:05:19.523Z이다. 초기 Probe는 2026-10-10T17:53:00.234Z에 시작했다. 결과의 replay 시간은 추가 API 조회를 의미하지 않는다.

[공식 IP 제한 정책](https://developers.binance.com/en/docs/products/derivatives-trading-usds-futures/general-info)에 따라 기존 ProviderHttpClient와 BinanceRestCoordinator를 사용했다. Futures 일봉의 공식 Weight는 LIMIT 1..99=1, 100..499=2, 500..1000=5, 1001..1500=10이다. 기존 기본 Weight 80에 해당하던 경로만 이 규칙으로 분류했다. 잘못되거나 중복된 limit은 80을 유지한다. 600 Weight/minute, Cooldown, Redis fail-closed, 단일 복구 Probe, 기존 동시성 상한은 유지했다.

조사 자체는 동시성 1, 요청 간 최소 1초, 최대 3회 시도로 제한했다. 429/418이면 자동 재시도하지 않고 기존 Cooldown을 기록한 뒤 중단한다. 로컬 전용 Redis `127.0.0.1:56611`과 캐시를 사용했고 기존 Redis·수집 서비스를 변경하지 않았다. 응답의 IP 사용 Weight 최대값은 120/minute였다. exchangeInfo의 공식 REQUEST_WEIGHT 상한은 2400/minute였으며, 조사 도중 적격 계약 목록과 identity는 바뀌지 않았다. 동일 egress IP에서 다른 앱 수집을 함께 실행할 경우 기존 문서대로 공유 Redis를 사용해야 하며, 이 조사 전용 Redis를 병행 수집의 제한 우회에 사용하면 안 된다.

## 결과 A Binance 순수 상위 25개

아래는 COIN 계약의 순위다. INDEX를 포함한 525개 전수 순위와 상위 25개가 동일하다.

| 순위 | 심볼         |      누적 거래대금 USDT | 일봉 수 | 계약 상장일 UTC | 현재 상태 |
| ---: | ------------ | ----------------------: | ------: | --------------- | --------- |
|    1 | BTCUSDT      | 3,289,770,164,044.48460 |     282 | 2019-09-08      | TRADING   |
|    2 | ETHUSDT      | 2,644,388,339,994.75137 |     282 | 2019-11-27      | TRADING   |
|    3 | SOLUSDT      |  563,724,406,118.390720 |     282 | 2020-09-14      | TRADING   |
|    4 | ZECUSDT      |   270,341,863,471.61891 |     282 | 2020-02-05      | TRADING   |
|    5 | XRPUSDT      |   247,045,342,507.15344 |     282 | 2020-01-06      | TRADING   |
|    6 | HYPEUSDT     | 181,895,217,124.1222300 |     282 | 2025-05-30      | TRADING   |
|    7 | DOGEUSDT     |  146,323,505,606.342620 |     282 | 2020-07-10      | TRADING   |
|    8 | BNBUSDT      |   107,827,347,487.66470 |     282 | 2020-02-10      | TRADING   |
|    9 | 1000PEPEUSDT |  85,495,302,129.6863943 |     282 | 2023-05-05      | TRADING   |
|   10 | SUIUSDT      |  66,531,488,571.8794400 |     282 | 2023-05-03      | TRADING   |
|   11 | RIVERUSDT    |  63,106,013,929.2141000 |     282 | 2025-10-17      | TRADING   |
|   12 | NEARUSDT     |     61,800,673,143.5330 |     282 | 2020-10-15      | TRADING   |
|   13 | ADAUSDT      |    55,696,882,659.77270 |     282 | 2020-01-31      | TRADING   |
|   14 | LABUSDT      |  52,522,335,298.1113200 |     282 | 2025-10-17      | TRADING   |
|   15 | WLDUSDT      |  50,546,938,684.2797000 |     282 | 2023-07-24      | TRADING   |
|   16 | TAOUSDT      |    47,641,432,449.99389 |     282 | 2024-04-11      | TRADING   |
|   17 | ENAUSDT      |  44,322,351,273.5965700 |     282 | 2024-04-02      | TRADING   |
|   18 | PAXGUSDT     |  41,442,298,973.6495400 |     282 | 2025-03-27      | TRADING   |
|   19 | LINKUSDT     |    39,188,558,815.40105 |     282 | 2020-01-17      | TRADING   |
|   20 | AVAXUSDT     |     37,686,268,630.9780 |     282 | 2020-09-23      | TRADING   |
|   21 | RAVEUSDT     |  37,401,778,941.7532200 |     282 | 2025-12-14      | TRADING   |
|   22 | UNIUSDT      |     35,781,559,671.8850 |     282 | 2020-09-18      | TRADING   |
|   23 | PUMPUSDT     |  35,633,061,870.0850110 |     282 | 2025-07-10      | TRADING   |
|   24 | BCHUSDT      |    34,851,390,925.46273 |     282 | 2019-12-19      | TRADING   |
|   25 | TRUMPUSDT    | 33,348,563,171.51570000 |     282 | 2025-01-18      | TRADING   |

## 결과 B 기존 기초자산으로 준비할 수 있는 후보

**23개로, 기존 기초자산만으로는 25개를 채울 수 없다.** 현행 `parseFuturesContracts`와 Spot 계약 검증을 그대로 적용했다. 현재 운영 DB의 Asset.isActive·FuturesInstrument 존재·검증 시각·거래 모드는 공개 시장 데이터만으로 확인할 수 없다.

| 등록 후보 순위 | Binance 원순위 | 심볼      |      누적 거래대금 USDT | 일봉 수 | 계약 상장일 UTC | 현재 상태 | 기초자산      |
| -------------: | -------------: | --------- | ----------------------: | ------: | --------------- | --------- | ------------- |
|              1 |              1 | BTCUSDT   | 3,289,770,164,044.48460 |     282 | 2019-09-08      | TRADING   | 기존 Universe |
|              2 |              2 | ETHUSDT   | 2,644,388,339,994.75137 |     282 | 2019-11-27      | TRADING   | 기존 Universe |
|              3 |              3 | SOLUSDT   |  563,724,406,118.390720 |     282 | 2020-09-14      | TRADING   | 기존 Universe |
|              4 |              4 | ZECUSDT   |   270,341,863,471.61891 |     282 | 2020-02-05      | TRADING   | 기존 Universe |
|              5 |              5 | XRPUSDT   |   247,045,342,507.15344 |     282 | 2020-01-06      | TRADING   | 기존 Universe |
|              6 |              7 | DOGEUSDT  |  146,323,505,606.342620 |     282 | 2020-07-10      | TRADING   | 기존 Universe |
|              7 |              8 | BNBUSDT   |   107,827,347,487.66470 |     282 | 2020-02-10      | TRADING   | 기존 Universe |
|              8 |             10 | SUIUSDT   |  66,531,488,571.8794400 |     282 | 2023-05-03      | TRADING   | 기존 Universe |
|              9 |             12 | NEARUSDT  |     61,800,673,143.5330 |     282 | 2020-10-15      | TRADING   | 기존 Universe |
|             10 |             13 | ADAUSDT   |    55,696,882,659.77270 |     282 | 2020-01-31      | TRADING   | 기존 Universe |
|             11 |             15 | WLDUSDT   |  50,546,938,684.2797000 |     282 | 2023-07-24      | TRADING   | 기존 Universe |
|             12 |             16 | TAOUSDT   |    47,641,432,449.99389 |     282 | 2024-04-11      | TRADING   | 기존 Universe |
|             13 |             17 | ENAUSDT   |  44,322,351,273.5965700 |     282 | 2024-04-02      | TRADING   | 기존 Universe |
|             14 |             19 | LINKUSDT  |    39,188,558,815.40105 |     282 | 2020-01-17      | TRADING   | 기존 Universe |
|             15 |             20 | AVAXUSDT  |     37,686,268,630.9780 |     282 | 2020-09-23      | TRADING   | 기존 Universe |
|             16 |             22 | UNIUSDT   |     35,781,559,671.8850 |     282 | 2020-09-18      | TRADING   | 기존 Universe |
|             17 |             25 | TRUMPUSDT | 33,348,563,171.51570000 |     282 | 2025-01-18      | TRADING   | 기존 Universe |
|             18 |             30 | LTCUSDT   |    25,047,226,247.82623 |     282 | 2020-01-09      | TRADING   | 기존 Universe |
|             19 |             31 | ASTERUSDT |  23,750,541,740.4644000 |     282 | 2025-09-19      | TRADING   | 기존 Universe |
|             20 |             32 | XLMUSDT   |    23,313,186,574.97214 |     282 | 2020-01-20      | TRADING   | 기존 Universe |
|             21 |             50 | TRXUSDT   |    14,037,890,948.31121 |     282 | 2020-01-15      | TRADING   | 기존 Universe |
|             22 |             66 | CHIPUSDT  |  11,347,234,619.8738200 |     177 | 2026-04-16      | TRADING   | 기존 Universe |
|             23 |            178 | NIGHTUSDT |   4,241,240,975.6480000 |     282 | 2025-12-10      | TRADING   | 기존 Universe |

기존 25종목 중 `PEPEUSDT`에는 정확히 일치하는 적격 Futures 계약이 없고 `1000PEPEUSDT`만 있다. 자동 매핑이나 단위 변환을 하지 않는다. `币安人生USDT`는 현물과 선물이 존재하지만, 현행 Futures 계약 파서의 `^[A-Z0-9]+USDT$` identity 조건을 충족하지 못한다. Unicode 지원 정책을 임의로 확대하지 않았다.

## 결과 B 새 기초자산 등록을 포함한 상위 25개 후보

아래 25개는 **상품 구조와 공개 계약 정책을 충족하는 조건부 등록 후보**다. 신규 기초자산 5개 **HYPE, PUMP, BCH, FIL, AAVE**를 같은 심볼의 Binance Spot crypto 자산으로 먼저 등록해야 전체 25개를 준비할 수 있다. 모두 exact Spot/Futures 심볼 및 baseAsset이 일치하며 별도의 가격·수량 변환이나 Alias가 필요 없다. 20개는 현재 저장소 Universe에 있다. 실제 등록은 사용자 결정과 별도 실행 단계다.

| 등록 후보 순위 | Binance 원순위 | 심볼      |      누적 거래대금 USDT | 일봉 수 | 계약 상장일 UTC | 현재 상태 | 기초자산       |
| -------------: | -------------: | --------- | ----------------------: | ------: | --------------- | --------- | -------------- |
|              1 |              1 | BTCUSDT   | 3,289,770,164,044.48460 |     282 | 2019-09-08      | TRADING   | 기존 Universe  |
|              2 |              2 | ETHUSDT   | 2,644,388,339,994.75137 |     282 | 2019-11-27      | TRADING   | 기존 Universe  |
|              3 |              3 | SOLUSDT   |  563,724,406,118.390720 |     282 | 2020-09-14      | TRADING   | 기존 Universe  |
|              4 |              4 | ZECUSDT   |   270,341,863,471.61891 |     282 | 2020-02-05      | TRADING   | 기존 Universe  |
|              5 |              5 | XRPUSDT   |   247,045,342,507.15344 |     282 | 2020-01-06      | TRADING   | 기존 Universe  |
|              6 |              6 | HYPEUSDT  | 181,895,217,124.1222300 |     282 | 2025-05-30      | TRADING   | 신규 등록 필요 |
|              7 |              7 | DOGEUSDT  |  146,323,505,606.342620 |     282 | 2020-07-10      | TRADING   | 기존 Universe  |
|              8 |              8 | BNBUSDT   |   107,827,347,487.66470 |     282 | 2020-02-10      | TRADING   | 기존 Universe  |
|              9 |             10 | SUIUSDT   |  66,531,488,571.8794400 |     282 | 2023-05-03      | TRADING   | 기존 Universe  |
|             10 |             12 | NEARUSDT  |     61,800,673,143.5330 |     282 | 2020-10-15      | TRADING   | 기존 Universe  |
|             11 |             13 | ADAUSDT   |    55,696,882,659.77270 |     282 | 2020-01-31      | TRADING   | 기존 Universe  |
|             12 |             15 | WLDUSDT   |  50,546,938,684.2797000 |     282 | 2023-07-24      | TRADING   | 기존 Universe  |
|             13 |             16 | TAOUSDT   |    47,641,432,449.99389 |     282 | 2024-04-11      | TRADING   | 기존 Universe  |
|             14 |             17 | ENAUSDT   |  44,322,351,273.5965700 |     282 | 2024-04-02      | TRADING   | 기존 Universe  |
|             15 |             19 | LINKUSDT  |    39,188,558,815.40105 |     282 | 2020-01-17      | TRADING   | 기존 Universe  |
|             16 |             20 | AVAXUSDT  |     37,686,268,630.9780 |     282 | 2020-09-23      | TRADING   | 기존 Universe  |
|             17 |             22 | UNIUSDT   |     35,781,559,671.8850 |     282 | 2020-09-18      | TRADING   | 기존 Universe  |
|             18 |             23 | PUMPUSDT  |  35,633,061,870.0850110 |     282 | 2025-07-10      | TRADING   | 신규 등록 필요 |
|             19 |             24 | BCHUSDT   |    34,851,390,925.46273 |     282 | 2019-12-19      | TRADING   | 신규 등록 필요 |
|             20 |             25 | TRUMPUSDT | 33,348,563,171.51570000 |     282 | 2025-01-18      | TRADING   | 기존 Universe  |
|             21 |             27 | FILUSDT   |  30,458,048,304.0945712 |     282 | 2020-10-16      | TRADING   | 신규 등록 필요 |
|             22 |             29 | AAVEUSDT  |     27,245,036,210.3550 |     282 | 2020-10-16      | TRADING   | 신규 등록 필요 |
|             23 |             30 | LTCUSDT   |    25,047,226,247.82623 |     282 | 2020-01-09      | TRADING   | 기존 Universe  |
|             24 |             31 | ASTERUSDT |  23,750,541,740.4644000 |     282 | 2025-09-19      | TRADING   | 기존 Universe  |
|             25 |             32 | XLMUSDT   |    23,313,186,574.97214 |     282 | 2020-01-20      | TRADING   | 기존 Universe  |

적용한 기존 정책은 [Futures 계약](../../../backend/docs/futures-api-contract.md), [Futures 계약 검증 코드](../../../backend/src/futures/futures-instrument-coverage.ts), [상품 등록 스크립트](../../../backend/scripts/provision-futures-instruments.ts), [현물 Universe 정책](../../../backend/docs/binance-universe-2026-ytd.md)다. COIN·USDT Perpetual·TRADING·ASCII exact identity, 같은 심볼과 baseAsset의 현재 거래 가능한 Spot 계약, 기존 SPOT permission Helper, USD 내부 가격·결제의 crypto Asset 전제를 유지한다.

새 기초자산에도 기존 현물 선정 정책의 stablecoin, fiat, wrapped/staked, commodity-pegged, stock/ETF·leveraged representation 제외 조건을 적용했다. 분류는 [Binance 공식 공개 자산 metadata](https://www.binance.com/bapi/asset/v2/public/asset/asset/get-all-asset)로 확인했고, 분류가 없는 자산을 임의로 승인하지 않았다.

| 원순위에서 제외된 주요 심볼                                                       | 제외 사유                                                      |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 1000PEPEUSDT                                                                      | 같은 심볼의 적격 Spot 기초자산 없음. PEPEUSDT로 자동 변환 금지 |
| RIVERUSDT                                                                         | 현재 같은 심볼의 TRADING Spot 기초자산 없음                    |
| LABUSDT                                                                           | 현재 같은 심볼의 TRADING Spot 기초자산 없음                    |
| PAXGUSDT                                                                          | 기존 상품 정책상 금 등 commodity-pegged representation 제외    |
| RAVEUSDT                                                                          | 현재 같은 심볼의 TRADING Spot 기초자산 없음                    |
| 币安人生USDT, 龙虾USDT, 牛来USDT, 我踏马来了USDT, BTCDOMUSDT, 哈基米USDT, ALLUSDT | INDEX 또는 현행 Futures identity 조건 불충족                   |
| PAXGUSDT, XAUTUSDT, USDCUSDT, USTCUSDT                                            | 기존 현물 기초자산의 representation 제외 정책                  |

각 계약의 구체적인 class와 제외 사유는 전체 CSV/JSON에 있다. 이전 상장 여부나 앞으로 상장될 가능성으로 현재 Spot identity 부재를 대체하지 않았다.

운영 등록 전에는 대상 DB의 실제 Asset 계약과 기존 instrument를 확인하고 중복을 피해야 한다. 승인된 등록 단계에서 active Binance crypto·USD 가격/결제·synthetic_perpetual 매핑과 24시간 이내 계약 검증을 다시 확인해야 한다. 신규 기초자산의 Provider target, Spot 시세·호가·캔들 수집과 Futures Last/Mark 수집 대상 반영도 확인해야 한다. DB 등록만으로 모든 스트림과 캐시가 준비됐다고 가정하지 않는다. Futures Last는 체결·조건부 주문·시즌 종료 증거, Mark는 평가·리스크·강제청산 증거라는 기존 정책을 유지해야 하며 ingestion·리스크 엔진·가격 신선도 및 DISABLED/REDUCE_ONLY/ENABLED 요건도 별도로 검증해야 한다. 이번 선정은 거래 활성화 승인을 의미하지 않는다.

## 검증과 원본 증거

- 최초 live 수집: exit 0, 525/525 정상, 실패 0.
- metadata와 분할 재조회: exit 0. BTC·ETH·SOL의 1월 1일~6월 30일, 7월 1일~10월 9일을 각각 새 요청으로 조회해 합산했으며, 전체 원본 배열의 SHA-256·282개 일봉·거래대금 모두 일치했다.
- 전체 캐시 replay: exit 0, HTTP 요청 수 증가 0, 최종 순위 일치.
- 독립 Python 검산: exit 0, **525/525** 합계·원본 해시·전체 순위·기간·비중 일치.
- 연구 회귀 테스트: exit 0, **10 passed / 0 failed / 0 skipped**.
- 기존 HTTP·Weight·Spot 계약·Futures coverage 테스트: exit 0, **4 Suites / 59 Tests passed, 실패 0**.
- 최종 Typecheck·Lint·Prettier·git diff 검증은 [검증 결과](evidence/validation.json)에 실행 명령과 종료 코드를 기록했다. 초기 Typecheck/Lint의 새 스크립트 타입·형식 문제를 수정했다. 임시 Probe 삭제와 겹친 Typecheck 1회는 TS6053으로 종료됐고, 파일 정리 후 최종 검사로 검증했다. 캐시 없는 최종 Typecheck에서 1GB Node 힙 한도를 초과해 exit 134로 종료된 실행도 기록했다. 프로세스 종료 확인 후 기존 1.5GB 힙과 프로세스 그룹 RSS 2300MiB·180초 제한으로 검증했다. 금융 단언문을 삭제·Skip·완화하지 않았다.

[독립 검산과 상위 5종목 첫날·마지막 날 원본 일봉](evidence/independent-verification.json), [분할 재조회 결과](evidence/result.json), [실제 HTTP 요청 기록](evidence/requests.jsonl), [정규화 원본 일봉](evidence/klines.ndjson.gz), [전체 캐시](evidence/cache.tar.gz)를 보존했다. 응답 JSON의 공백만 정규화했으며 거래대금 문자열은 변경하지 않았다. 저장된 SHA-256은 정규화 JSON의 해시다.

실행 코드는 [수집 스크립트](../../../backend/scripts/research-binance-futures-2026.ts), [연구 테스트](../../../backend/scripts/research-binance-futures-2026.test.ts), [독립 검산](../../../backend/scripts/verify-binance-futures-2026.py)에 있다.

## 재현 명령

아래 offline 경로는 DB·Redis·HTTP 없이 재현한다. 기존 backend 의존성 설치본을 사용한다.

```sh
mkdir -p /tmp/binance-futures-replay-cache
tar -xzf docs/investigations/2026-10-11-binance-futures-ytd/evidence/cache.tar.gz -C /tmp/binance-futures-replay-cache
cd backend
node --import tsx scripts/research-binance-futures-2026.ts --verify --replay \
  --cache-dir /tmp/binance-futures-replay-cache/cache \
  --output-dir /tmp/binance-futures-replay-result
python3 scripts/verify-binance-futures-2026.py /tmp/binance-futures-replay-result
node --import tsx --test scripts/research-binance-futures-2026.test.ts
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath \
  src/providers/binance/binance-rest-coordinator.spec.ts \
  src/providers/provider-http.client.spec.ts \
  src/providers/binance/binance-exchange-info.validation.spec.ts \
  src/futures/futures-instrument-coverage.spec.ts
```

신규 live 조사에서는 조사 전용 Redis를 실행하고 아래 명령을 사용한다. 다른 수집과 egress IP가 공유되는 환경에서는 공유 Coordinator 정책을 먼저 충족해야 한다. 새로운 빈 캐시를 지정하면 현재 적격 계약을 다시 전수 조사하므로, 향후 상장·상폐나 과거 일봉 정정으로 이번 결과와 달라질 수 있다.

```sh
cd backend
REDIS_URL=redis://127.0.0.1:56611 NODE_OPTIONS=--max-old-space-size=768 \
  timeout 1200s node --import tsx scripts/research-binance-futures-2026.ts --verify \
  --cache-dir /tmp/binance-futures-new-cache --output-dir /tmp/binance-futures-new-result
```

실제 Redis 시작 명령은 환경의 기존 추출 binary와 해당 라이브러리만 사용했다.

```sh
LD_LIBRARY_PATH=/tmp/binance-rest-fixture/root/usr/lib/x86_64-linux-gnu \
  /tmp/binance-rest-fixture/root/usr/bin/redis-server --bind 127.0.0.1 --port 56611 \
  --dir /tmp/binance-futures-2026-research/redis --appendonly yes --daemonize yes \
  --pidfile /tmp/binance-futures-2026-research/redis.pid \
  --logfile /tmp/binance-futures-2026-research/redis.log
```

조사 전용 Redis는 종료했고 append-only 제한 상태는 /tmp에 보존했다. 초기 라이브러리 경로 누락으로 Redis 실행 및 admission 검증이 실패했을 때 실제 Binance HTTP 호출은 0회였다. 경로를 지정해 실행한 뒤 정상 수집했다. 기존 서비스를 중단하거나 제한 상태를 지우지 않았다.

## 산출물과 Git 상태

- 조사 시작·최종 로컬 HEAD: `129289d86a32ea83ab2521f9d3d2469cf6d88ba7`, 브랜치 `main`. 시작 작업 트리는 clean이었다.
- 새 Worktree는 만들지 않았다. 연구 코드·문서·증거는 기존 작업 트리에 미커밋으로 남긴다. Commit·Push·Merge는 실행하지 않았다.
- Draft PR #3은 `e1f46852e649eb5ffc920d2687a4b24f751b6498`, Draft·미병합 상태 그대로이며 변경하지 않았다.
- 수정한 기존 파일은 Coordinator 공식 Weight 분류와 그 테스트, `backend/docs/binance-rest-limits.md` 3개다. 새 파일은 연구 스크립트·테스트·독립 검산 스크립트와 이 조사 폴더의 증거다. 금융 서비스, 상품 Universe, schema/migration, package/lockfile, UI는 변경하지 않았다.

| 산출물                                                                                | 내용                                                                 |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [result.json](evidence/result.json)                                                   | 전체 순위, 두 모집단의 합계·비중, 계약 및 등록 class, 모든 정책 후보 |
| [all-contracts.csv](evidence/all-contracts.csv)                                       | 전체 525개 및 제외 사유                                              |
| [top25-crypto.csv](evidence/top25-crypto.csv)                                         | 암호화폐 순수 상위 25개                                              |
| [top25-binance.csv](evidence/top25-binance.csv)                                       | INDEX 포함 모집단의 동일 상위 25개                                   |
| [top25-existing-underlying.csv](evidence/top25-existing-underlying.csv)               | 기존 기초자산 기준 23개 후보                                         |
| [top25-conditional-new-underlying.csv](evidence/top25-conditional-new-underlying.csv) | 신규 기초자산 5개 등록을 전제로 한 선정 25개                         |
| [validation.json](evidence/validation.json)                                           | 실제 검사 명령·종료 코드·통과 수                                     |
| [manifest.json](evidence/manifest.json)                                               | 산출물 SHA-256                                                       |
