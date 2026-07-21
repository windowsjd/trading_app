# Policy Decisions

각 항목은 "결정 사항 + 한 줄 근거"만 기록한다. 조사/검토 과정, 후보 비교표, STOP/GO 이력 서술은 담지 않는다. 세부 구현(에러 코드, 필드명 등)은 코드와 `*-api-contract.md`를 기준으로 확인한다.

## Execute-Time Repricing (Durable Quote)

- Quote TTL은 15초. 만료 시 `QUOTE_EXPIRED`.
  근거: quote는 체결가가 아니라 참고 견적이며, 오래된 quote로 체결하면 시장가 괴리가 커진다.
- Execute는 quote 가격이 아니라 execute 시점 fresh provider price/rate로 재산정한다.
  근거: 체결은 자금 이동을 수반하는 지점이므로 최신 가격 반영이 필요하다.
- Quote 대비 execute 시점 가격/환율 변동 허용치(`maxChangeBps`)는 전 자산군 공통 30bps(0.30%). 초과 시 `RATE_CHANGED_REQUOTE_REQUIRED`.
  근거: 재견적을 강제해 과도한 슬리피지로 체결되는 것을 차단한다.
- Execute 경로는 기본적으로 `admin_manual` fallback을 허용하지 않는다. 비상 override는 별도 operator override gate가 필요하다.
  근거: 자금 변동 경로에서 수동/오래된 데이터로 조용히 체결되는 것을 방지한다.
- Limit 주문은 buy `executePrice <= limitPrice`, sell `executePrice >= limitPrice`일 때만 체결 가능하고, 체결가는 항상 execute 시점 provider price다. 불만족 시 `ORDER_LIMIT_NOT_MARKETABLE`.
  근거: limit은 체결 가능 여부만 판단하고, 실제 체결가는 시장가 원칙을 유지한다.

## Market-State-Aware Price Freshness

- 주식시장 개장 중에는 아래 `capturedAt` freshness와 현재 세션 안의 `effectiveAt`을 함께 요구한다. 현재 세션 가격이 없으면 stale/unavailable이며 이전 세션 가격으로 넘어가지 않는다.
  근거: 시장이 열렸는데 현재 세션 데이터가 없는 상태는 정상 휴장이 아니라 provider 지연 또는 장애다.
- 주식시장 폐장 후·주말·전일 휴장에는 자산별 KRX/US 캘린더가 가리키는 최근 완료 세션 안의 마지막 유효 `provider_api` 가격을 read/display, live valuation, current ranking, daily portfolio snapshot, market snapshot health에 사용할 수 있다. 해당 세션 가격이 없으면 더 오래된 세션으로 넘어가지 않는다.
  근거: 닫힌 시장의 무거래는 정상이지만, 평가 근거는 가장 최근 완료 세션으로 유계되어야 한다.
- 주문 quote/create/execute에는 완료 세션 carry-forward를 사용하지 않는다. 휴장 중에는 가격 선택보다 `MARKET_CLOSED`를 우선하고, 개장 후 execute는 현재 세션의 10초 freshness를 유지한다.
  근거: 표시·평가의 종가 보존과 자금 변동 경로의 체결 안전성은 분리되어야 한다.
- KRX와 미국 시장 상태는 자산별로 독립 판정하고 crypto는 24시간 freshness 정책을 유지한다. 시즌 날짜, 주문 생성 시각, 거래 내역 날짜, 사용자 활동일에는 주식시장 휴장일을 적용하지 않는다.
  근거: 혼합 포트폴리오와 일반 도메인 날짜를 한 시장의 휴장 여부로 함께 중단하면 안 된다.

개장 중 `capturedAt` 기준:

| 대상               | Quote/Read                                     | Execute |
| ------------------ | ---------------------------------------------- | ------- |
| KRX 국내주식       | 60초                                           | 10초    |
| 미국주식 (NAS/NYS) | 60초                                           | 10초    |
| BINANCE 암호화폐   | 60초                                           | 10초    |
| USD/KRW FX         | 300초 (admin_manual 폴백은 `effectiveAt` 60초) | 60초    |

근거: quote/read는 참고용이라 완화된 기준을 적용하고, execute는 자금 이동을 수반하므로 더 타이트한 기준을 강제한다. 닫힌 주식시장의 허용 여부는 절대 age가 아니라 최근 완료 세션 소속 여부로 판정한다. FX 60초 기준은 provider 도입 이전부터 쓰이던 기존 admin_manual 정책을 그대로 승계했다.

## Market-Date Calculation Inventory

| 분류                       | 위치/계산                                                                                                                                                                                                                    | 결정                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 시장 캘린더 적용           | `orders/market-hours.policy.ts`, `assets/asset-candles.service.ts`, stock candle aggregation/build/normalization, candle provider cursor·range·empty coverage, stock reconciliation scheduler, KIS one-shot target selection | `resolveMarketSession`, 이전/최근 완료 세션, 주의 마지막 세션을 공용 정책에서 사용한다. 고정 요일·시각과 주말 전용 계산은 사용하지 않는다. |
| 시장 캘린더 적용           | Assets/ticker, Positions, Portfolio, Home, current Records, current ranking/daily snapshot, market snapshot health, Orders의 주식 가격 선택                                                                                  | 자산별 open/closed 세션 상태와 `effectiveAt` 세션 소속을 공용 source policy에서 판정한다.                                                  |
| 이미 공용 캘린더 사용      | live candle event normalizer, KIS US 5-minute normalizer, readiness calendar coverage                                                                                                                                        | 기존 동작을 유지하고 동일 registry/data를 계속 사용한다.                                                                                   |
| 일반 캘린더 날짜—변경 없음 | 시즌 시작·종료·정산 기준시각, 주문 생성/체결 기록시각, 거래 내역 날짜, 사용자 활동일, daily snapshot의 날짜 key, equity rolling 기간, FX lookback                                                                            | 거래 세션을 뜻하지 않으므로 주식 휴장일을 적용하지 않는다.                                                                                 |
| 정책상 독립                | crypto 24시간 bucket/freshness, FX 수집·freshness, long-lived WebSocket transport 연결 상태                                                                                                                                  | 주식 휴장으로 중단하지 않는다. 단, 주식 trade-data freshness/health는 해당 시장 세션 상태를 사용한다.                                      |

모든 주식시장 날짜 계산의 source of truth는 `src/orders/market-calendar/`와 그 2025~2027 KRX·US 데이터다. 데이터가 없는 연도는 평일도 개장으로 추측하지 않고 fail-closed/degraded 처리하며, 런타임 외부 캘린더 API fallback은 사용하지 않는다. 1d·1w 동기화의 365일 lookback과 연초 `prev_open` 계열이 직전 연도 데이터를 요구하므로 readiness 기본 요구 범위는 직전 연도~다음 연도다.

## Market Session Override (Operator DB Layer)

- 외부 시장 캘린더 API(KIS 휴장일, Alpaca Calendar, EODHD 등)는 도입하지 않는다. 관련 env도 추가하지 않는다. 연도별 정적 데이터셋(`src/orders/market-calendar/data`)이 기본 데이터이고, 운영자 DB override(`market_session_overrides`)는 그 위의 예외 계층이다.
- 최종 우선순위: (1) 활성 DB override → (2) 연도별 정적 캘린더 → (3) 해당 연도 데이터셋 없음이면 `calendar_unavailable`로 fail-closed. override 한 건이 있어도 그 연도의 coverage는 충족되지 않는다(예: 2028·2030처럼 미등록 연도는 자동 추정 없이 fail-closed 유지).
- coverage 연도 계산은 기존 결정대로 Asia/Seoul 기준 연도이며 readiness 요구 범위(직전 연도~다음 연도)도 그대로다. 연도별 정적 캘린더 갱신 절차: 거래소 공식 공지 검증 → `data/{krx,us}-YYYY.ts` 추가(검증 전이면 version에 `-provisional`) → registry의 DATASETS에 등록 → 공식 공지 확인 후 provisional 제거.
- override 의미: `regular`는 정적 휴장·시간변경을 취소하고 정규 세션 강제("override 없음"과 내부적으로 구분됨), `closed`는 종일 휴장(provider 호출·캔들·gap·일봉 생성 없음), `custom`은 사용자 지정 개장·종료(지연 개장, 조기/연장 종료). KRX와 US는 독립 판정이고 crypto는 24시간 정책으로 영향받지 않는다.
- 지연 개장일도 하나의 거래 세션이다. `prev_open`/`prev2_open` 등 세션 개수 의미는 바뀌지 않으며, 지연 개장 때문에 캔들 과거 조회 범위를 추가 세션으로 연장하지 않는다. 세션 내부 계산(버킷 정렬, expected count, 일봉/주봉 종료, scheduler close+grace)은 실제 override 시각을 쓴다.
- multi-instance 반영: mutation 인스턴스는 커밋 직후 즉시 반영, 다른 인스턴스는 60초 bounded polling으로 반영(최대 지연 ≈ 60초 + 질의 왕복). Redis pub/sub 대신 polling을 택했다(변경 빈도가 낮고 실패 모드가 단순).
- 장애 정책: cold start 초기 로드 실패 시 조용히 넘어가지 않고 구조화된 error 로그 후 첫 성공까지 주식 캘린더 fail-closed(5초 재시도). 이후 refresh 실패는 last-known-good 유지 + 구조화된 warning. snapshot 변경 시 해당 시장 자산의 캔들 캐시 generation을 bump한다.
- 긴급 휴장·지연 개장 운영 절차: operator API로 override 등록(사유 필수) → 응답의 `runtimeApplied`와 polling 지연(≤60초) 확인 → 상황 종료 시 삭제가 아니라 비활성화로 기록 보존. 사용자 공지사항은 이 계층과 무관한 별도 운영 절차다.
- 프론트 표시: stock이 `marketStatus === 'closed'`이고 가격을 표시할 수 없으면 "휴장시간", `unknown`(캘린더 coverage 없음 포함)·provider 미준비·crypto는 "시세 준비 중"을 유지한다. 캘린더 미확인 상태를 휴장으로 표시하지 않기 위해 `calendar_unavailable`은 `marketStatus`에서 `closed`가 아니라 `unknown`으로 매핑한다.

## Source Type 우선순위

- `provider_api`를 quote/execute/valuation에서 `admin_manual`보다 우선한다. `admin_manual`은 부트스트랩/수동 정정/비상 폴백 용도로만 허용하고 장기 운영 primary source로 쓰지 않는다.
  근거: 신선한 실거래 데이터가 있는데도 조용히 stale/manual 데이터로 대체되는 것을 막기 위함이다.
- `official_batch`는 market-open quote/execute/실시간 valuation에 사용하지 않는다. 일별 스냅샷/정산 근거 후보로만 사용한다.
  근거: 공식 배치 데이터는 재현성/최종성에 강점이 있으나 실시간성이 없다.
- 시즌 정산(Settlement)은 `Season.endAt` 시점 기준 최신 유효 저장 데이터를 사용하며 quote/execute freshness window를 적용하지 않는다.
  근거: 시즌 종료 시각(일요일 23:59 KST 부근)에는 시장이 닫혀 있을 수 있어 freshness window를 강제하면 정산 자체가 불가능해진다. 정산은 실시간성보다 재현 가능성이 우선이다.

## Crypto USD Settlement

- MVP 암호화폐는 Binance 기반, USD 결제로 고정한다. 국내/해외 크립토를 분리하지 않고, KRW 크립토 거래는 MVP 범위에서 제외한다.
  근거: 기존 USD 지갑/포지션/주문 통화 로직을 그대로 재사용해 스키마·엔진 변경 없이 구현할 수 있다.
- Upbit/Bithumb은 MVP provider stack에서 제외한다.
  근거: KRW 표시 국내 거래소는 USD 결제 정책과 맞지 않는다.
- `CurrencyCode.USDT`는 추가하지 않는다. Binance USDT quote pair(`BTCUSDT`, `ETHUSDT`)는 내부적으로 USD-equivalent로 정규화한다.
  근거: 내부 통화 모델을 KRW/USD 2종으로 단순하게 유지한다. USDT 디페그 리스크는 이 MVP 범위에서 모델링하지 않는다.
- `cryptoValueKrw`/`totalAssetKrw`는 crypto USD 평가액 × USD/KRW 환율로 계산한다.
  근거: 최종 평가/랭킹은 보유 자산 통화와 무관하게 KRW 기준으로 통일해야 한다.

## Provider Final Selection

- FX(USD/KRW): 1순위 `korea_exim_exchange_rate`(한국수출입은행 고시환율), 폴백 `exchange_rate_api`.
  근거: 정부 공식 무료 API를 우선 사용해 비용/계약 리스크를 낮추고 상용 API는 이중화 폴백으로만 둔다. OANDA/Twelve Data는 유료 계약·응답 필드 검증이 끝나지 않아 최종 채택되지 않았다.
- 암호화폐: Binance(공개 REST, API 키 불필요).
  근거: 위 Crypto USD Settlement 정책과 동일한 이유로, 계약/키 없이 공개 데이터만으로 USD 결제 모델에 맞는 시세 수집이 가능하다.
- 국내/미국 주식: KIS(한국투자증권) — 국내 KRX 실시간 체결가(`H0STCNT0`), 미국 0분 지연 체결가(`HDFSCNT0`).
  근거: Twelve Data 공식 문서상 한국거래소는 EOD 지연으로만 제공되어 실시간 quote/execute 요건을 충족하지 못한다. KIS는 실계좌 연동 없이 시세 조회 전용으로 국내 실시간·미국 지연 데이터를 모두 제공한다.
- KIS 주문/계좌/잔고/체결/입출금 API는 사용하지 않는다(시세 조회 전용).
  근거: 이 프로젝트는 가상매매 앱이며 실거래 연동은 범위 밖이다.

## Fixed KIS Watchlist (40 symbols)

국내 15 + 미국 25 종목 심볼 리스트는 문서가 아니라 코드로 관리한다.

- 기본값(코드): `src/providers/kis/kis-fixed-asset-universe.ts`의 `KIS_FIXED_DOMESTIC_SYMBOLS`/`KIS_FIXED_US_SYMBOLS`. `KIS_DOMESTIC_SYMBOLS`/`KIS_US_SYMBOLS` 환경변수가 비어 있으면 이 기본값을 사용한다.
- 자산 DB 시딩: `pnpm tsx scripts/seed-kis-fixed-asset-universe.ts [--dry-run]`로 40개 자산을 upsert한다.
- 근거: 이 리스트는 프로젝트 결정으로 고정된 고유동성 후보군이며(공식 YTD 순위 검증을 주장하지 않음), 매 환경마다 운영자가 수동 입력하지 않도록 코드에 기본값으로 고정한다.
