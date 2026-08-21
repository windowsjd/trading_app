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

## Limit Orders (Reservation + Scheduler Auto-Execution)

지정가 매수·매도는 등록(quote/create)·예약·취소·시즌 정리 + 스케줄러 기반 자동 체결
(경로 A/B)까지 구현되어 있다. 등록은 PostgreSQL만으로 완결되고, 자동 체결은
별도 플래그 `SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED`로 켜지는 OpsJobLock 기반
스케줄러 job이 수행한다. 자동 체결은 아래 "Limit Order Scheduler Matching" 참조.

- 지원: 지정가 매수·매도 등록/취소/전량 체결, GTC 성격(주문 자체 만료 없음). 부분 체결·IOC/FOK/DAY·Stop·실거래소 주문은 미지원.
- 등록은 항상 `status=submitted`로 commit되며 reservation-only다. Create 자체는 Provider 현재가를 읽거나 즉시 체결하지 않는다. 등록은 PostgreSQL만으로 완결된다 — 검증 대상은 mode별 계정 integrity·자산·시장세션·Quote·지갑/포지션뿐이고, Redis나 Provider WebSocket 상태는 등록을 가로막지 않는다(Redis 미기동 통합 테스트로 보증).
- 현금 의미: `balanceAmount`=총 보유 현금(총자산 평가 입력, 예약으로 감소하지 않음), `reservedAmount`=submitted 지정가 매수 예약금, `availableAmount`=balance-reserved(파생값, DB 미저장). 홈/포트폴리오/랭킹/equity·daily snapshot/정산/거래기록 평가에서 reservedAmount를 차감하지 않는다.
- 보유수량 의미: `Position.quantity`=총 보유수량, `reservedQuantity`=submitted 지정가 매도 예약수량, 매도 가능수량=`quantity-reservedQuantity`. 예약은 총자산 평가수량을 줄이지 않으며 취소 시 전량 반환, 체결 시 예약수량과 총수량을 함께 줄인다.
- 예약금: `gross=round8(limitPrice×qty)`, `fee=round8(gross×feeRate)`, `reserved=round8(gross+fee)` — 시장가 매수 netAmount와 동일한 반올림 체인. 등록 시점 feeRate는 `orders.reservation_fee_rate`에 영구 저장된다(미래의 체결 구현이 동일 rate를 사용하기 위한 보존).
- 수수료율 고정(Quote 시점): 예약 계산 근거를 durable Quote에 저장한다(`quotes.quoted_fee_rate/quoted_gross_amount/quoted_fee_amount/quoted_reserved_amount`, 시장가·FX Quote는 모두 null). Create는 이 저장값을 그대로 예약하고 현재 `Season.tradeFeeRate`를 다시 읽지 않는다. Quote 이후 운영자가 시즌 수수료율을 바꿔도 Quote 응답 예약금 = 실제 wallet reservedAmount 증가액 = `Order.reservedAmount`가 모두 동일하며, `Order.reservationFeeRate`도 Quote 시점 rate다. Create는 저장값을 재검증한다(전부 non-null, 음수 아님, rate가 [0,1], gross/fee/reserved가 Quote의 limitPrice×quantity에서 canonical 반올림 체인으로 재도출 가능). 실패 시 `QUOTE_RESERVATION_BASIS_INVALID`(409)로 거절하며 현재 시즌 수수료율로 대체 계산하는 fallback은 두지 않는다 — 조용한 재가격 산정이야말로 이 고정이 막으려는 실패다.
- 미체결 주문 금액 필드 의미: `grossAmount`/`feeAmount`/`netAmount`/`executedPrice`/`executedAt`는 **실제 체결 결과**만 의미한다. 자동 체결이 없는 1차 단계에서 `submitted`·`canceled` 지정가 주문은 이 다섯 필드가 모두 null이다. 미체결 주문의 금액은 `reservedAmount`(체결금액이 아니라 미체결 예약금)와 `reservationFeeRate`, 그리고 등록 전 단계에서는 Quote의 `quoted*` 예상값으로 제공한다. 시장가 executed 주문의 세 금액 의미는 그대로 유지한다. 근거: 예약 추정치를 체결 결과 컬럼에 쓰면 미체결 주문이 체결된 것처럼 읽히고, 미래의 체결 구현이 진짜 체결값을 쓸 자리가 사라진다.
- Create 동시성: transaction 밖 season/participant 검사는 빠른 오류 반환용 보조 검증일 뿐이다(그 사이에 운영자가 참가자를 제외하거나 시즌을 종료할 수 있다). 금융 정확성은 transaction 안에서 잠근 행의 재검증이 보장한다. Lock 순서는 `Quote(FOR UPDATE) → SeasonParticipant(FOR SHARE) → Season(FOR SHARE) → CashWallet(가드 UPDATE) → Order(insert)`. seasonId는 잠근 participant 행에서 읽어 participant↔season 연결까지 committed 상태로 검증한다.
  - 모든 위 lock 뒤 `clock_timestamp()`를 조회한다. transaction 시작 시각에 고정되는 `now()`/`CURRENT_TIMESTAMP`는 사용하지 않는다. Quote TTL, Season.start/end, 주식시장 세션을 이 시각으로 재검증하고 Order submitted/created/updated 시각도 동일 값을 쓴다.
  - `FOR SHARE`를 쓰는 이유: 동시 Create끼리는 직렬화되지 않으면서, 참가자 제외·시즌 종료의 일반 UPDATE(`FOR NO KEY UPDATE`)와는 충돌해 대기하게 만든다. 결과적으로 경합 시 가능한 결말은 둘뿐이며 둘 다 안전하다 — Create가 먼저 commit되고 cleanup이 그 주문을 취소·예약 해제하거나, 제외/종료가 먼저 commit되고 Create가 실패한다. excluded participant나 ended season에 신규 예약금이 남는 상태는 성립할 수 없다.
  - participant를 season보다 먼저 잠그는 이유: settlement가 `SeasonParticipant` 갱신 후 마지막에 `Season`을 갱신하므로, season을 먼저 잠그면 순서가 역전돼 deadlock이 가능하다. 시즌 종료 transaction은 `Season`만 건드리고, 취소·cleanup 경로는 `Order → CashWallet`만 잠그므로 이 순서와 순환이 없다.
  - 부수 효과: 시즌이 ended가 된 뒤에는 신규 예약이 생길 수 없으므로, settlement의 open-reservation 사전점검(트랜잭션 밖 2개 count)이 사이에 끼어든 Create 때문에 뚫리는 창도 함께 닫힌다.
- 원자성: 모든 일반 현금 차감(시장가 매수, FX source debit)과 예약 생성은 단일 SQL UPDATE 안에서 `balance_amount - reserved_amount >= :amount` 가드로 판정한다(read-then-write 금지, parameterized raw SQL: `src/wallets/cash-wallet-atomic.ts`). DB CHECK(`reserved>=0`, `balance>=reserved`)가 최후 방어선.
- 취소: Order row lock(FOR UPDATE) → 매수는 CashWallet, 매도는 Position 순서. 예약 해제와 `submitted→canceled` 전이가 한 transaction이라 해제는 주문당 정확히 1회. 중복 취소는 멱등 replay. 취소는 `LIMIT_ORDER_ENABLED`와 계정 status에 무관하게 소유자에게 항상 가능하다.
- 정산 전제조건: 해당 시즌에 submitted 지정가 주문, reservedAmount>0 지갑 또는 reservedQuantity>0 포지션이 남아 있으면 `OPEN_LIMIT_ORDER_RESERVATIONS`로 settlement를 차단한다. 시즌 lifecycle job이 tick마다 ended/settled 시즌의 잔여 예약을 자가치유 정리하므로 차단은 일시적이다.
- 기능 플래그: `LIMIT_ORDER_ENABLED`(기본 false)는 신규 Quote/Create만 연다. 자동 체결은 별도 `SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED`(기본 false)로 켠다. 둘 다 strict boolean parser. matching만 켜고 registration을 끄면 신규 등록은 막히되 기존 submitted 주문은 계속 체결되는 "drain" 상태이며, startup에서 WARNING을 남긴다.
- 프런트엔드 공개 플래그: `EXPO_PUBLIC_LIMIT_ORDER_ENABLED`는 반드시 정적 dot notation(`process.env.EXPO_PUBLIC_LIMIT_ORDER_ENABLED`)으로 읽는다. `babel-preset-expo`의 inline-env-vars 패스는 property가 `EXPO_PUBLIC_` 리터럴인 member expression만 치환하므로, `process.env[key]` 같은 동적 접근은 번들에 값이 아예 들어가지 않아 플래그가 항상 꺼진 것처럼 동작한다. 클라이언트는 부팅 실패시킬 지점이 없으므로 백엔드와 달리 미인식 값도 fail-closed(false)로 두고, 엄격 검증은 실제 인가 주체인 서버가 담당한다.
- 근거: 예약 없는 지정가 등록은 체결 시점 잔액 부족을 만들고, 예약을 balanceAmount 차감으로 구현하면 총자산이 왜곡된다. 예약을 별도 fence 컬럼으로 두면 두 문제를 모두 피하면서 기존 시장가/FX/평가 경로의 의미를 보존한다.

## Limit Order Scheduler Matching (경로 A/B, OpsJobLock, 주문별 tx)

이벤트 기반 매칭 계층(Redis Stream matcher, 활성화 토큰, shared readiness)은
제거되었고, 자동 체결은 **스케줄러 폴링**으로 재구현했다. Redis Stream/consumer
group/claim/lease를 쓰지 않으며, 단일 실행 보장은 기존 PostgreSQL
OpsJobLockService + ops_job_locks다(Redis lock 아님). 실제 거래소 주문도 아니다.

- 트리거: `OpsSchedulerService`의 **전용 interval**(`LIMIT_ORDER_MATCHING_INTERVAL_MS`,
  기본/최대 5000ms) — 공유 60s tick을 낮추지 않아 다른 job cadence 무변경. idle 시
  (체결 대상 submitted 주문 0건) dispatch를 건너뛰어 ops_job_runs 스팸을 막는다.
  runner는 `OpsJobName.limit_order_matching` lock으로 한 인스턴스만 실행.
- interval ≤ execute freshness(10s)/2: matcher가 수용한 snapshot이 체결 commit 전에
  stale해지지 않도록 config parser가 강제(startup 실패).
- 경로 A(fresh snapshot): 자산의 최신 유효 `provider_api` AssetPriceSnapshot이
  매수는 limitPrice 이하, 매도는 limitPrice 이상이면 **snapshot 가격**으로 체결(가격 개선 허용). 기존 시장가 execute의
  source eligibility·freshness·시장세션 판정을 그대로 재사용(admin_manual/official_batch
  거절, 주식은 개장 세션 필요, crypto 24h).
- 경로 B(closed 5분봉 터치): 경로 A 미체결분에 대해, 마감된 5분봉의 매수 low가
  limitPrice 이하 또는 매도 high가 limitPrice 이상이면 **order.limitPrice**로 체결
  (candle low/high는 터치 evidence일 뿐). 주문 제출 시각을
  다음 5분 경계로 올린 `firstEligibleCandleOpen` 이후 캔들만, `LIMIT_ORDER_CANDLE_LOOKBACK_MS`
  (기본 15분) 이내, 시즌 주문은 closeTime ≤ season.endAt인 캔들만 사용한다. 일반 주문은
  season 종료 horizon을 두지 않는다. 주문 제출 중이던 첫 부분 캔들은
  절대 사용하지 않는다. 주식은 캔들 window가 유효 세션 안에 있어야 함(휴장/미커버리지 제외).
- 체결 tx(주문별 독립): Order(FOR UPDATE) → CashWallet/Position 예약 settle → Position →
  WalletTransaction 순서(취소·cleanup과 동일). status=submitted·mode별 account gate·
  자산 active·매수 execPrice≤limitPrice/매도 execPrice≥limitPrice를 재검증한다. 매수는
  `actualNet=round(execPrice*qty*(1+reservationFeeRate)) ≤ reservedAmount`를 강제하고
  예약금 전체를 해제하면서 실제 net만 balance에서 차감한다. 매도는 reservedQuantity를
  전량 settle하고 수수료 차감 net을 wallet에 입금한다.
  USD 자산은 fill 시점 fresh USD/KRW snapshot을 fxRateSnapshotId evidence로 부착하며, 없으면
  해당 주문은 이번 cycle 체결을 미룬다(user requote 없는 자동 체결이라 stale FX로 진행 불가).
- 취소·체결 경합: 둘 다 Order row lock + status=submitted 조건 → 정확히 한쪽 승리. 체결
  선commit이면 취소는 ORDER_NOT_CANCELABLE, 취소 선commit이면 matcher가 skip. 이중 차감·이중
  해제 없음. 시즌 종료 경합도 같은 Order row에서 중재.
- evidence 격리: `limit_order_candle_evidences`는 (asset, interval, window, provider)당 1행을
  주문들이 공유하고 market_candles FK가 없어(retention 이후에도 생존) 합성 AssetPriceSnapshot을
  만들지 않는다 → 현재가·평가·랭킹을 오염시키지 않는다.
- 배치: `LIMIT_ORDER_MATCH_BATCH_SIZE`(기본 200) 체결/사이클, 초과분은 다음 cycle로 이월
  (submittedAt ASC, id ASC FIFO). 주문별 오류는 격리(다음 cycle 재시도).
- 잔존 enum: `OpsJobName.limit_order_matcher`/`limit_order_candle_reconciliation`,
  `OpsJobTrigger.worker`는 제거된 이벤트 계층 값으로 PostgreSQL 제약상 남지만 스케줄되지 않는다.

## Investment Modes (Season / General) + TradingAccount Foundation

- 시즌모드와 일반모드는 하나의 사용자 계정을 공유하되 거래계정·지갑·주문·포지션·손익·스냅샷을 완전히 분리하고, 계정 간 자금·자산 이전은 지원하지 않는다.
  근거: 대회형 시즌 성과와 무기한 개인 투자 기록이 섞이면 랭킹·수익률 양쪽의 의미가 깨진다.
- 공통 계정 계층은 `trading_accounts`(mode=season|general)이며 주문·포지션의 실질 격리 키는 `tradingAccountId`다. 시즌 행은 legacy participant를 함께 기록하고 일반 행은 participant가 null이다.
  근거: 기존 시즌 관계를 보존하면서 일반계정 데이터를 participant 없이 완전히 분리해야 한다.
- 주문 코어는 검증된 `TradingContext`의 `feeRate`를 사용한다. 시즌은 `Season.tradeFeeRate`, 일반은 한 곳의 `GENERAL_TRADE_FEE_RATE`(미설정 기본 `0.001000`)를 사용하며 현재 시즌에서 일반 수수료를 가져오지 않는다.
  근거: 일반계정은 시즌 존재/상태와 독립적으로 거래해야 하고, 수수료 숫자가 주문 경로에 분산되면 quote/create/fill 사이에 불일치가 생긴다. 저장소에 별도 general canonical 값은 없었으므로, 기존 season/dev fixture가 일관되게 쓰는 가상거래 0.1%를 독립 기본값으로 채택했고 운영 override도 이 한 config만 사용한다.
- general 시장가 durable quote는 quote 시점의 `GENERAL_TRADE_FEE_RATE`를 기존 `Quote.quotedFeeRate`에 고정하고 create/execute가 그 값을 사용한다. provider 가격은 기존처럼 execute-time repricing한다. 구버전의 null fee general market quote는 현재 config를 조용히 적용하지 않고 409 `QUOTE_MISMATCH`로 재견적한다. 시즌 시장가는 계속 `Season.tradeFeeRate`를 사용한다.
  근거: rolling deployment/config 변경 사이에도 사용자에게 제시한 fee와 실제 주문·원장 fee가 같아야 하지만, fresh provider price와 max-change 보호는 유지해야 한다.
- 사용자당 general 계정은 최대 1개이며 DB partial unique index(`trading_accounts_general_owner_unique`, `WHERE mode='general'`)로 강제한다. `@@unique([userId, mode])`는 사용하지 않는다.
  근거: 시즌 계정은 시즌마다 여러 개가 정상이므로 composite unique로는 표현할 수 없다.
- 일반모드 최초 가상자금은 계정 최초 생성 시 10,000,000 KRW 1회 지급뿐이다. 월별/가입일 기준/스케줄러 정기 지급과 grantAnchorDay·nextGrantAt류 필드는 폐기·금지한다. 소진 시 자동 재지급·계정 초기화도 없다.
  근거: 반복 무상 지급은 수익률 비교 의미를 없애고, 지급일 스케줄링 상태는 유지비만 만든다.
- 일반모드 추가 가상자금은 보상형 광고 완료 보상으로만 획득한다(광고 보상은 general 계정 한정, 서버 검증·이벤트 고유 ID·중복 지급 차단·지급+원장 단일 트랜잭션 필수). 1회 지급액·일일 한도·제공자는 운영 설정값으로 미정.
  근거: 클라이언트 신고만으로 잔액이 늘 수 있으면 가상자금이라도 원장 무결성이 무너진다.
- 광고 보상금은 투자수익이 아니라 외부 가상자금 유입이다. 누적 투자손익 = 현재 총자산 − 누적 외부 가상자금(최초 지급 + 광고 보상 + 운영자 외부 조정)으로 계산하고, 대표 수익률은 단순 (총자산−외부자금)/외부자금 대신 외부자금 유입 시점을 구간 경계로 하는 시간가중수익률을 사용한다. 주문 체결은 ordinary advance이고 외부자금 before/after boundary를 만들지 않는다. `TradingAccount.initialCapitalKrw`와 누적 보상 컬럼에 가산하지 않고 원장 집계로만 계산한다.
  근거: 보상 유입 자체로 수익률이 변하면 실제 투자 성과 지표가 왜곡된다.
- 시즌 거래 가능 판정은 기존 Season.status·기간·ParticipantStatus 검증을 유지하고 TradingAccount.status(active/suspended/closed)는 공통 계정 상태로만 쓴다. backfill 매핑: registered/active→active, excluded→suspended, finished/rewarded→closed, closedAt은 확실한 종료 시각이 없으면 NULL.
  근거: 검증 체계를 한 번에 갈아끼우면 시즌 회귀 위험이 크고, 종료 시각 날조는 금융 기록 원칙에 반한다.

세부 계약·ERD·QA 체크리스트는 `docs/trading-modes-and-accounts.md`.

## TradingAccount Link Repair + Account Read API

- `season_participants.trading_account_id`는 배포 경계(구버전 writer가 null 참가자를 생성) 동안 nullable을 유지하고, NOT NULL 강화는 "모든 writer 기록 + 복구 apply 완료 + null 0건 + 구버전 종료 + 배포 순서 확정"을 모두 확인한 별도 작업으로만 수행한다.
  근거: 순단 없는 롤링 배포에서 스키마 강화를 먼저 하면 구버전 write가 통째로 실패한다.
- null link 복구 계정의 ID는 migration backfill과 동일한 결정적 유도(`md5('trading-account:season-participant:'||id)::uuid`)를 애플리케이션에서도 재현해 사용하며, 랜덤 UUID 복구는 금지한다. 복구는 계정·링크만 만들고 지갑·원장·주문·포지션·스냅샷은 절대 수정하지 않으며, userId/mode/초기자금/openedAt 불일치는 덮어쓰지 않고 `TRADING_ACCOUNT_LINK_INTEGRITY`로 fail-closed 한다.
  근거: 결정적 ID여야 동시 복구가 orphan 계정을 만들 수 없고, 불일치 자동 수정은 금융 데이터 손상을 은폐한다.
- joinSeason은 기존 참가자의 null link를 같은 트랜잭션에서 복구한 뒤에도 기존 계약대로 409 `SEASON_ALREADY_JOINED`를 반환한다(복구는 commit, 409는 commit 후). 운영 일괄 복구는 `pnpm trading-accounts:repair-links`(기본 dry-run, `--apply` 명시 필수)로 수행한다.
  근거: 복구를 위해 참가 API 응답 계약을 바꾸면 프런트 호환이 깨진다.
- 운영자 참가자 제외는 같은 트랜잭션에서 연결 season 계정을 suspended로 동기화한다(null link면 먼저 복구, 이미 suspended면 idempotent, closed는 되돌리지 않음). finished/rewarded/settled 전환 시의 closed 동기화·suspended 재활성화는 시즌 lifecycle 격리 작업으로 미룬다.
  근거: 제외와 계정 정지가 다른 트랜잭션이면 부분 실패 시 상태가 갈라진다.
- 거래계정 조회는 `GET /api/v1/trading-accounts`(목록)·`/:accountId`(상세)이며, 존재하지 않는 계정과 타인 소유 계정은 동일한 404 `TRADING_ACCOUNT_NOT_FOUND`로 응답한다(403 금지 — 존재 여부 노출 방지). status는 읽기 gate가 아니므로 소유자는 suspended/closed 계정도 조회할 수 있다.
  근거: 오류 코드가 존재 여부 oracle이 되면 계정 열거 공격이 가능해진다.
- 서버는 현재 선택 계정/모드를 어디에도 저장하지 않는다(JWT claim·세션·User 컬럼·전역 singleton 금지). 향후 거래 API는 경로/필드로 accountId를 명시하고 요청마다 `TradingAccountAccessService`로 소유권을 재검증한다.
  근거: 서버 저장 선택 상태는 다중 기기·동시 요청에서 잘못된 계정으로의 자산 변경을 만든다.

## Financial TradingAccount Scope (Wallet/Ledger/FX 전환)

- 금융 4개 테이블(cash_wallets, wallet_transactions, exchange_transactions, fx_execute_requests)은 전환 기간 동안 nullable `seasonParticipantId`와 nullable `tradingAccountId`를 보유한다. 신규 season writer는 participant+account를 dual-write하고, general writer는 non-null account+null participant를 기록한다. season 참가자 링크가 null이면 새 금융 쓰기를 `TRADING_ACCOUNT_LINK_INTEGRITY`로 중단하며, general 행의 participant pollution은 `GENERAL_ACCOUNT_INTEGRITY`로 fail-closed한다.
  근거: 기존 season 관계를 보존하면서 participant가 없는 general 자산을 같은 원장·환전 코어로 격리해야 한다. 손상 scope를 자동 추론하거나 복구하지 않는다.
- WalletTransaction은 wallet 관계 유도 대신 자체 tradingAccountId 컬럼을 보유한다. TradingAccount에는 잔액·누적액·수익률류 캐시 컬럼을 두지 않는다(금융 값의 원천은 지갑·원장·거래 테이블).
  근거: 계정별 원장 감사·집계는 조인 없이 조회 가능해야 하고, 캐시 컬럼은 원장과의 불일치 가능성만 만든다.
- migration backfill은 참가자 링크 복사만 수행한다(IS NULL 가드, 멱등). 링크 없는 참가자의 금융 행은 null로 남기고 migration에서 계정을 만들거나 애플리케이션 복구를 재구현하지 않는다. 이후 정리는 `trading-accounts:repair-links --apply` → `trading-accounts:repair-financial-scope --apply` 순서로만 수행한다.
  근거: SQL과 애플리케이션에 복구 규칙이 두 벌 있으면 반드시 어긋난다.
- 복구 CLI(--apply)는 잔여 null·잔여 mismatch·행별 실패·검증 실패 중 하나라도 남으면 exit 1이다. 저장 scope가 참가자 링크와 다르면 `FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH`로 보고만 하고 절대 덮어쓰지 않는다. NOT NULL 강화는 두 CLI가 exit 0 + 잔여 0으로 끝난 후에만 검토한다.
  근거: "오류 없이 끝남"과 "정합성 수렴"은 다르며, 자동 교정은 금융 데이터 손상을 은폐한다.
- FX idempotency는 계정 기준 `(tradingAccountId, idempotencyKey)` unique가 기준이다. (2026-08-03 작업 5에서 개정) 전역 `(userId, idempotencyKey)` unique는 legacy null-scope 행만 보호하는 partial unique(`WHERE trading_account_id IS NULL`)로 교체되어, 같은 사용자가 서로 다른 계정에서 같은 키를 재사용할 수 있다. 신규 요청의 멱등성 기준은 legacy endpoint 포함 전부 계정이고, legacy null 행 replay는 같은 user+participant로 고정된 fallback으로만 허용한다.
  근거: 계정이 자산 격리 경계인 이상 멱등성 경계도 계정이어야 하며, 교체는 partial 생성 → 전역 DROP 순서라 어느 시점에도 무보호 행이 없다.
- account-scoped 환전 변경은 소유권(동일 404) + `TradingAccount.status=active` + mode별 context를 요구한다. season은 기존 Season.status·기간·participant status/excluded·`Season.tradeFeeRate`를 모두 유지하고, general은 season을 조회하지 않고 account foundation·KRW/USD wallet·general TWR 연속성을 검증한다. 조회는 mode/status와 무관하게 소유자에게 허용한다.
  근거: 계정 상태는 자산 변경 게이트일 뿐 시즌 거래 판정을 대체하지 않으며, general은 현재 시즌의 존재·상태와 독립적이어야 한다.
- general FX 수수료는 `GENERAL_FX_FEE_RATE`에서만 결정하며 미설정 기본값은 `0.001000`이다(0~1, 소수 6자리 이하 startup validation). season의 `Season.fxFeeRate`나 general 주문의 `GENERAL_TRADE_FEE_RATE`와 섞지 않는다. general FX durable quote는 quote 시점 fee를 기존 `Quote.quotedFeeRate`에 pin하고 execute가 그 값만 쓴다. provider 환율은 체결 시 fresh snapshot으로 재가격하며 기존 30bps 한계를 유지한다. null/부적합 pinned fee는 현재 config로 fallback하지 않고 409 `QUOTE_MISMATCH`로 재견적한다.
  근거: rolling deploy·config 변경 중에도 표시된 수수료와 체결 원장이 같아야 하지만, 실행 시점 환율 freshness와 급변 보호는 약화하면 안 된다.
- season FX quote/execute request hash v1은 byte-for-byte 유지한다. general FX는 participant 대신 user+`tradingAccountId`를 포함한 v2 hash를 사용하고, committed replay는 변경 가능한 status/integrity 게이트보다 먼저 재생한다. legacy null-scope fallback은 season user+participant에만 유지하고 general에서는 사용하지 않는다.
  근거: 기존 season 멱등성 계약을 깨지 않으면서 같은 사용자의 여러 계정이 같은 key를 독립적으로 쓸 수 있어야 한다.
- general FX 체결은 account row `FOR UPDATE` 후 DB `clock_timestamp()`를 쓰고, 두 wallet·exchange·execute request·source/target ledger·`exchange_executed` ordinary TWR snapshot을 한 transaction에 기록한다. 환전은 external funding이 아니며 participant/ranking/season settlement를 변경하지 않는다.
  근거: 환전은 가치의 통화 구성만 바꾸므로 TWR 자금 유입 경계를 만들면 수익률이 왜곡된다. account lock은 주문·광고보상과의 snapshot 순서를 같은 fence로 직렬화한다.
- legacy wallet/fx endpoint는 계약 그대로 유지하고 account-scoped endpoint와 같은 서비스 코드를 공유한다(수수료·환율·잔액 변경·원장·멱등·오류 코드·원자성 동일). 배포 순서는 migration → 신버전 → 구버전 종료 → repair-links → repair-financial-scope → 검증 0건 → (후속) NOT NULL.
  근거: 환전 규칙이 두 벌 존재하는 순간부터 두 경로의 결과가 갈라진다.

## Trading TradingAccount Scope (Order/Position/Quote 전환)

- Order·Position은 전환 기간 동안 nullable `seasonParticipantId`를 유지하고 `tradingAccountId`를 dual-write한다. 시즌 행은 두 scope를 모두 기록하며 일반 행은 participant가 null이다. Order는 `(tradingAccountId, idempotencyKey)` unique(+submittedAt/status 인덱스), Position은 `(tradingAccountId, assetId)` unique를 사용하고 기존 참가자 unique를 유지한다. Quote에는 신규 unique를 두지 않는다(status/consume가 단일 사용을 보장).
  근거: 계정이 거래 데이터의 자산 격리 기준이 되려면 멱등성·집계 unique도 계정 축으로 존재해야 하고, 참가자 축 제거는 별도 작업이다.
- 지갑을 변경하거나 지갑 잔액을 근거로 quote를 만드는 모든 경로는 wallet의 participant+account scope를 선검증하고, 원자적 잔액 UPDATE의 WHERE에도 `trading_account_id`를 포함한다. null scope는 500 `FINANCIAL_SCOPE_REPAIR_REQUIRED`(거래 중 자동 backfill 금지), 불일치는 500 `FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH`(덮어쓰기 금지)로 fail-closed 한다. 400류로 다루지 않는다.
  근거: 이는 클라이언트 입력 문제가 아니라 서버 정합성 손상이며, 어떤 계정의 지갑인지 거래가 결정하게 두면 손상이 확산된다.
- account-scoped 조회(금융 4모델·주문·포지션)는 시즌 참가자의 null/불일치 scope 또는 일반 행의 participant 오염이 존재하면 빈·부분 결과 대신 구조화 500으로 실패한다. 정상 general 행은 participant 없이 account scope만 가진다.
  근거: 복구 미완료 상태를 "정상적으로 빈 계정"으로 보여 주는 것이 가장 위험한 침묵 실패다.
- Quote는 자산을 직접 바꾸지 않지만 실행 권한을 제공하므로 계정 격리 대상이다: 신규 quote는 검증된 accountId를 기록하고, 실행 시 non-null quote 계정이 다르면 `QUOTE_MISMATCH`, 소비는 `id+status+participant+(계정 일치 OR null)` 조건의 updateMany로만 한다. requestHash 계산식은 교체하지 않는다.
  근거: 저장된 scope 검증만으로 계정 격리가 완성되며, hash 전면 교체는 미소비 legacy quote와 replay 계약을 깨뜨린다.
- 지정가 자동 체결은 체결 트랜잭션 안에서 order/participant/quote/wallet/position의 계정 일치를 재검증한다. 계정 suspended/closed는 skip(주문 submitted 유지, 자동 취소 없음), scope 손상은 구조화된 500(다음 사이클 재시도가 운영 신호). 취소는 보호 동작이라 계정/참가자 status로 gate하지 않되 scope 손상 시 repair-required로 중단하고 상태·예약금이 함께 rollback 된다.
  근거: 체결은 로그인 요청이 없어 relation이 유일한 권위이고, 취소 차단은 사용자를 처벌할 뿐 위험을 줄이지 않지만 잘못된 계정의 예약금 반환은 자산 이동이다.
- 운영 복구는 3단 구성이다: repair-links(참가자↔계정) → repair-financial-scope(금융 4모델) → repair-trading-scope(Order·Position·Quote). 셋 다 기본 dry-run, `--apply` 명시, IS NULL 가드 backfill만, mismatch는 보고만, apply 후 잔여가 있으면 exit 1. participant 없는 quote는 계정을 추측하지 않고 `QUOTE_PARTICIPANT_SCOPE_MISSING`으로 보고한다.
  근거: 복구 단계가 의존 순서를 갖고(계정 링크 없이는 어떤 backfill도 불가), 추측 backfill은 잘못된 계정 귀속이라는 최악의 손상을 만든다.
- EquitySnapshot·DailyPortfolioSnapshot·SeasonRanking의 accountId 전환과 tradingAccountId NOT NULL 강화·seasonParticipantId 제거는 후속 작업으로 보류한다.
  근거: 스냅샷은 랭킹·정산과 얽혀 있어 별도 검증 단위가 필요하고, NOT NULL은 구버전 writer 완전 종료 + 복구 수렴 증빙 없이는 롤링 배포를 깨뜨린다.

## 작업 5 보완 (취소 scope 분류 / 시장가 replay / 지갑 실패 진단)

- account-scoped 주문 취소의 잠금 SQL에는 `trading_account_id` 조건을 넣지 않는다. 주문은 orderId + 사용자 소유권으로만 잠그고, 계정 소속은 조회된 행으로 분류한다: 참가자 링크가 요청 계정이면 order scope null → 500 `TRADING_SCOPE_REPAIR_REQUIRED`, 불일치 → 500 `TRADING_ACCOUNT_SCOPE_MISMATCH`; 참가자 링크가 다른 계정이라도 order scope가 요청 계정을 가리키면 500 mismatch; 둘 다 다르면 404 `ORDER_NOT_FOUND`. 분류는 시장가 410 판정보다 먼저 수행하고 어떤 오류 경로에서도 주문 상태·예약금을 바꾸지 않는다.
  근거: 타인의 주문(숨겨야 함)과 자기 주문의 scope 손상(드러내야 함)은 정반대 성격인데, 잠금 조건에 계정을 넣으면 둘이 같은 404로 붕괴하고 사용자는 자기 주문이 사라진 이유를 알 수 없다.
- 이미 커밋된 주문 생성의 재시도는 현재 상태 gate보다 먼저 저장된 최초 응답을 재생한다. 시장가·지정가 모두 적용되며, 신규 주문 gate(account active, mode별 integrity, 시즌 status·기간·participant status, 시장 개장, quote, wallet/position scope, 잔액/수량, 가격 freshness)는 기존 주문이 하나도 없을 때만 실행한다. 계정 소유권 확인만은 replay보다 먼저 수행한다.
  근거: 이미 돈이 움직인 요청에 상태 오류를 돌려주는 것은 사실과 다르고, 재시도 폭주는 바로 그 gate가 실패하기 시작할 때 일어난다. 소유권을 먼저 보지 않으면 남의 accountId로 주문 정보를 열람할 수 있다.
- 시장가 주문의 `responsePayloadJson`은 생성·체결 트랜잭션 안에서 저장한다. 저장 실패 시 주문·체결·지갑·원장·포지션이 함께 rollback 된다. 재시도는 현재 데이터로 응답을 재구성하지 않고 저장된 payload를 반환한다(payload 없는 legacy 행만 기존 fallback 유지).
  근거: 응답 없이 커밋된 주문은 어떤 재시도로도 정확히 재현할 수 없다.
- legacy 시장가 replay 조회는 실제 DB unique와 범위가 같은 축만 사용한다(고유 `Order.quoteId` + 사용자 소유권). `userId + idempotencyKey` 같은 넓은 조회는 금지한다.
  근거: idempotencyKey는 시즌 참가 단위로만 unique이므로, 더 넓은 조회는 다른 시즌의 주문을 replay하거나 정상 요청을 충돌로 만든다.
- 원자 지갑 UPDATE가 0행이면 wallet id 단독으로 재조회해 원인을 분류한다: 행 없음 → 기존 not-found/잔액 오류, participant 불일치·account null·account 불일치·통화 불일치 → 각각의 구조화된 500, 금액 조건 미달 → 기존 잔액/예약금 오류, 전부 정상 → 실제 동시성 CONFLICT. scope는 항상 금액보다 먼저 검사하며, 진단은 읽기 전용이다. 시장가 debit/credit, 지정가 reserve/settle/release(취소·만료·운영자 제외 cleanup 공용), FX source debit/target credit 전 경로에 동일하게 적용한다.
  근거: 재조회 WHERE에 scope 컬럼을 다시 넣으면 손상된 지갑이 "없는 지갑"으로 보여 손상이 스스로를 은폐한다. 일부 helper만 고치면 같은 결함이 나머지 경로에 남는다.

## 일반모드 계정·자금·광고 보상 (작업 6)

- general TradingAccount는 사용자당 하나이며 `POST /api/v1/trading-accounts/general`에서만 생성된다. migration·GET·거래 경로·광고 claim은 계정·지갑·자금을 만들지 않는다. 응답 status는 200으로 고정하고 `created` boolean으로 최초 생성과 replay를 구분한다.
  근거: 자금이 생기는 사건은 사용자의 명시적 행위 하나로 좁혀야 추적·감사·중복 방지가 가능하고, status code로 생성 여부를 구분하면 재시도 시 클라이언트 분기가 흔들린다.
- 계정·KRW 지갑·USD 지갑·최초 지급 원장은 하나의 트랜잭션이며, 멱등성 근거는 기존 partial unique `trading_accounts_general_owner_unique`다. unique 충돌은 500이 아니라 승리한 트랜잭션의 계정 재조회 후 replay로 처리한다.
  근거: 부분 생성된 계정(지갑 없는 계정, 지급 없는 지갑)은 이후 모든 판정을 오염시키고, 동시 요청에서 500을 돌려주면 클라이언트가 재시도해 상태를 더 악화시킨다.
- 최초 1,000만 원은 계정 생성 시 1회만 지급한다. 월별·정기·가입일 기준·말일 보정·누락 소급 지급과 그 스케줄러, 자금 고갈 시 자동 초기화, 계정 간 자금 이동은 전부 없다. `grantAnchorDay`·`nextGrantAt`·`lastMonthlyGrantAt`·`monthlyGrantCount`·`catchUpGrant`·`recurringGrant`류 필드는 금지한다.
  근거: 정기 지급은 랭킹·수익률 의미를 무너뜨리고, 필드가 생기는 순간 스케줄러가 따라온다.
- 손상된 general 계정은 자동 복구하지 않는다. 구조 검사(mode·participant 없음·initialCapitalKrw 1,000만·KRW/USD 지갑 각 1개·participant null·initial grant 1건 1,000만) 실패는 500 `GENERAL_ACCOUNT_INTEGRITY`이고 POST 재호출은 복구 수단이 아니다. 무결성 판정에 **현재 잔액을 사용하지 않는다.**
  근거: 손상 데이터의 자동 금융 보정은 손상 자체보다 위험하며, 사용된 계정의 잔액은 1,000만이 아닌 것이 정상이다(광고 보상 후에는 더 클 수도 있다).
- `wallet_transactions` 전체에 `unique(referenceType, referenceId)`를 두지 않는다. 1행짜리 reference(`general_account_open`, `ad_reward_claim`)만 PostgreSQL partial unique로 강제하고, Prisma DSL로 표현할 수 없으므로 migration SQL + schema 주석 + schema contract 테스트로 관리한다.
  근거: 하나의 order·exchange reference에는 정상적으로 여러 원장 행이 존재하므로 전역 unique는 기존 거래를 깨뜨린다.
- 광고 보상은 검증된 이벤트에 대해서만, 일반모드 KRW 지갑에만 지급한다. 시즌계정은 세 endpoint 모두 409 `AD_REWARD_GENERAL_ACCOUNT_ONLY`이고 USD는 지급하지 않으며 `reservedAmount`와 `TradingAccount.initialCapitalKrw`는 변하지 않는다. 광고 보상은 투자수익이 아니라 외부 가상자금 유입이며 `txType=ad_reward`로 식별한다.
  근거: 광고 자금이 투자 성과에 섞이면 수익률과 랭킹이 실력과 무관해진다.
- 클라이언트는 `provider`와 opaque proof만 보낸다. rewardAmountKrw·providerEventId·userId·tradingAccountId·grantedAt·balanceAfter·일일 카운트·cooldown은 전부 서버가 결정하며, providerEventId는 등록된 서버 verifier가 반환한 값만 저장한다. proof 원문·광고 토큰·서명 비밀·raw callback은 저장하지 않고 SHA-256 fingerprint만 남긴다.
  근거: 클라이언트가 정할 수 있는 값은 전부 조작 가능하고, 저장된 proof는 그 자체로 재사용 가능한 자격증명이 된다.
- 광고 정책값(제공자, 1회 지급액, 일일 횟수·금액, cooldown, 일일 경계 timezone)은 운영 설정이며 코드에 제품 기본값을 넣지 않는다. `AD_REWARD_ENABLED` 기본값은 false이고, enabled=true인데 필수값이 없으면 부팅을 거부한다. 일일 경계는 서버 로컬 timezone이 아니라 설정된 IANA zone으로 계산한다.
  근거: 정해지지 않은 정책을 코드가 대신 정하면 그 값이 사실상의 결정이 되고, 서버 위치가 사용자의 "오늘"을 바꿔서는 안 된다.
- 운영 환경에는 fake verifier를 등록하지 않는다. provider adapter가 없으면 503 `AD_REWARD_PROVIDER_UNAVAILABLE`이고 광고 완료를 가짜로 인정하지 않는다. deterministic fake는 테스트에서 DI로만 주입한다.
  근거: 검증 없는 지급 경로가 운영에 한 번이라도 존재하면 그것이 취약점 자체다.
- 광고 지급은 계정 행 `SELECT … FOR UPDATE`로 계정 단위 직렬화한 뒤 한도·cooldown·중복 이벤트를 트랜잭션 안에서 재검증하고, 지갑 증액·원장·claim granted를 한 트랜잭션으로 처리한다. 전역·분산 락은 만들지 않는다. eligibility 응답은 안내용이며 예약이 아니다.
  근거: 사전 count 조회만으로는 동시 요청이 한도를 넘고, 한 계정의 지급끼리만 직렬화하면 충분하다.
- 한도·cooldown에 걸린 **검증 완료** 이벤트는 rejected claim으로 기록하고 트랜잭션을 commit한 뒤 429를 던진다. 같은 providerEventId는 이후에도 지급하지 않는다(재요청 시 최초 거절을 replay). rejected claim에는 walletTransactionId가 없고 지갑·원장은 변하지 않는다. 검증 자체가 실패한 요청은 신뢰 가능한 event ID가 없으므로 claim 행을 만들지 않는다.
  근거: "나중에 한도가 풀리면 지급"은 이벤트 저장 후 재사용 공격을 허용하고, 거절 기록이 rollback 되면 같은 이벤트가 다음 날 다시 지급된다.
- 누적 광고 보상금은 granted claim 또는 `ad_reward` 원장의 집계로 계산한다. `cumulativeAdReward`·`cumulativeExternalFunding`·`totalDeposits`·`currentProfit`·`currentReturnRate`·`twr` 컬럼은 만들지 않는다.
  근거: 캐시된 금융 집계는 원장과 어긋나는 순간 어느 쪽이 진실인지 판정할 수 없다.
- 일반계정 운영 점검 `pnpm trading-accounts:audit-general`은 read-only 전용이며 `--apply` 복구를 만들지 않는다. foundation/wallet/ledger/TWR뿐 아니라 general Order/Position/Quote scope와 full-fill-only limit-sell 예약 증거, Position 예약합계도 탐지·보고만 한다.
  근거: 손상된 계정을 자동으로 다시 충전하는 스크립트는 실수 한 번으로 전 사용자에게 자금을 재지급한다.

## 작업 6 보완 (광고 명령 멱등성 / 전체 integrity / claim replay 정합성)

- 광고 claim은 `provider`·`proof`·`idempotencyKey`를 모두 필수로 받고, `(tradingAccountId, idempotencyKey)` unique로 명령 재시도를 보호한다. 이 unique는 `(provider, providerEventId)`와 **합치지 않는다**: 전자는 클라이언트 명령 재시도, 후자는 실제 광고 이벤트 중복 지급을 막는 서로 다른 축이다. P2002는 두 축을 각각 재조회해 원인을 판정한다.
  근거: 하나로 합치면 같은 광고 이벤트가 서로 다른 키로 두 번 지급되거나, 정상 재시도가 이벤트 중복으로 오분류된다.
- claim 처리 순서는 소유권 확인 → 파싱 → keyed claim 조회 → replay이며, 계정 status·`AD_REWARD_ENABLED`·configured provider·registry·verifier 검사는 keyed claim이 없을 때만 실행한다. `provider`는 요청에서 필수로 받고 config 기본값으로 대체하지 않는다.
  근거: 이미 커밋된 지급에 상태·설정 오류를 돌려주는 것은 사실과 다르고, provider를 config에서 채우면 replay 결과가 재시도 시점의 운영 설정에 의존하게 된다.
- `requestHash`는 `sha256({version, provider, proof fingerprint})`이며 proof 원문은 hash 입력·로그·DB 어디에도 남기지 않는다. 같은 키·다른 요청은 409 `AD_REWARD_IDEMPOTENCY_CONFLICT`다.
  근거: 저장된 proof는 그 자체로 재사용 가능한 자격증명이고, 키 재사용을 조용히 재검증하면 멱등성이 의미를 잃는다.
- granted claim은 replay 전에 원장·지갑과의 1:1 정합성을 검증한다(계정·participant null·KRW 지갑·credit·`ad_reward`·`ad_reward_claim`·referenceId·금액·지갑 scope, keyed면 hash·payload·경계 snapshot 쌍까지). rejected는 ledger 없음·한도 failureCode를, pending/verified/failed는 성공 replay 금지를 요구한다. 위반은 500 `AD_REWARD_CLAIM_INTEGRITY`.
  근거: `duplicate=true, walletBalanceAfter=null`은 서버가 증명할 수 없는 지급을 성공으로 보고하는 응답이다.
- 일반계정 금융 검사는 foundation(계정·지갑 2개·최초 지급 원장 전체 필드) + row scope 두 단계를 **항상 함께** 수행하고, 계정 재호출·지갑 조회·원장 조회·eligibility·claim·성과 경로 전부에 적용한다. 현재 잔액과 `reservedAmount`는 검사 대상이 아니다.
  근거: row scope만 검사하면 USD 지갑이나 최초 지급 원장이 통째로 사라진 계정이 정상 200으로 응답한다. 반대로 잔액을 고정값으로 강제하면 정상적으로 사용된 계정이 손상으로 오판된다.

## 작업 7 (일반모드 성과·TWR·snapshot 전환)

- EquitySnapshot·DailyPortfolioSnapshot의 `seasonParticipantId`를 nullable로 완화하고 nullable `tradingAccountId`를 추가한다. 기존 시즌 행은 참가자 링크에서 IS NULL 가드 backfill만 하고 금액·수익률·시각·reason·ID는 건드리지 않는다. SeasonRanking과 Order·Position·Exchange·FxExecuteRequest는 이번 작업에서 변경하지 않는다.
  근거: 일반계정은 SeasonParticipant가 없어 snapshot을 소유할 수 없었고, 랭킹·정산 전환은 검증 단위가 다르다.
- 시즌 snapshot writer는 전부 participant + 검증된 accountId를 dual-write하고, 링크가 null이면 조용히 unscoped snapshot을 만들지 않고 `TRADING_ACCOUNT_LINK_INTEGRITY`로 중단한다. 계정 ID는 이미 검증된 값을 인자로 넘기고 재조회하지 않는다.
  근거: unscoped snapshot은 이후 account-scoped 조회에서 통째로 보이지 않고, 그 계정 전체의 read-integrity를 fail-closed로 만든다.
- 누적 외부 가상자금은 `initial_grant`+`general_account_open`과 `ad_reward`+`ad_reward_claim` **두 종류만** 합산하는 allow-list다. `exchange_target`·`order_sell`·`settlement`·`adjustment`·`manual_adjustment`는 외부자금이 아니며, 원장과 claim 정합성이 깨지면 일부만 합산하지 않고 fail-closed 한다.
  근거: 외부자금을 추측하면 투자손익이 조용히 왜곡되고, 그 왜곡은 수익률로 그대로 전파된다.
- 일반모드 대표 수익률은 TWR이고 `timeWeightedReturnFactor`가 source of truth다. `returnRate`는 표시용 반올림이며 다음 factor 계산에 재사용하지 않는다. 외부자금 유입은 before/after 경계로 처리해 총자산과 누적 외부자금만 증가시키고 투자손익·factor·returnRate는 그대로 둔다. 모든 계산은 Prisma Decimal이다.
  근거: 단순 외부자금 대비 손익률은 광고를 볼 때마다 수익률이 변해 실력과 무관해지고, 반올림된 퍼센트를 되먹이면 구간이 쌓일수록 드리프트한다.
- 완전 손실(총자산 0) 이후 factor는 0으로 고정되고 이후 외부자금이 들어와도 -100%를 유지한다. 총자산 0에서 경계 없이 양수로 변하면 `GENERAL_PERFORMANCE_DISCONTINUITY`, 음수 총자산은 `GENERAL_PERFORMANCE_INTEGRITY`다.
  근거: 자동 재기준선은 사용자의 누적 손실을 지워 없던 일로 만든다.
- 일반계정 최초 성과 기준점은 계정 생성 트랜잭션 안에서 함께 만든다(계정·지갑 2개·최초 지급 원장·origin snapshot 5행 원자). 기존 계정에 origin이 없으면 자동 생성하지 않고 500 `GENERAL_PERFORMANCE_NOT_INITIALIZED`이며, 복구는 명시적 backfill script로만 한다.
  근거: 기준점을 자동으로 만들면 그 시점 이전의 성과가 조용히 사라진다.
- backfill script는 일반거래가 비활성이라 총자산 = 누적 외부자금이 **증명되는** 계정에만 0% baseline을 만든다. 거래 행·부분 snapshot·claim 불일치·USD 현금·알 수 없는 credit·총자산 불일치는 보고만 하고 건너뛰며 `--force`는 없다.
  근거: 0% 기준선은 "아무 것도 벌거나 잃지 않았다"는 주장이고, 그 주장이 검증되지 않는 계정에서는 거짓이 된다.
- account-scoped 포트폴리오·수익률 응답은 항상 `returnRateMethod`(`time_weighted` / `initial_capital`)를 함께 반환하고, 시즌 계정의 외부자금 필드는 0이 아니라 null이다. 가격·환율 부재는 기존 sectionErrors로, 정합성 손상은 구조화된 500으로 구분한다.
  근거: 의미가 다른 두 수익률을 같은 필드명으로 내보내면 프런트가 구분할 방법이 없고, 손상을 "일시적 불가"로 표시하면 아무도 고치지 않는다.
- equity 이력 정렬과 최신 snapshot 조회는 `capturedAt` → `createdAt` → `id`로 결정적이어야 한다. before/after 쌍은 같은 `capturedAt`을 가지므로 tie-breaker 없이는 다음 구간 계산이 유입을 이중 계산할 수 있고, 커밋된 상태의 최신 snapshot이 unpaired before면 정합성 오류다.
  근거: 정렬이 흔들리면 같은 데이터에서 다른 수익률이 나온다.

## 작업 8 (일반계정 동시성 · SeasonRanking TradingAccount scope)

- 일반계정 portfolio·equity GET은 Prisma `RepeatableRead` 트랜잭션 하나에서 성과 snapshot·외부자금 원장·지갑·Position·가격·환율을 모두 읽고, 그 안에서 account를 다시 확인한다. GET은 lock을 잡지 않고 아무것도 쓰지 않으며 외부 호출도 하지 않는다. 시즌 경로와 legacy `/api/v1/portfolio*`는 변경하지 않는다.
  근거: 6개 read가 각각 별도 트랜잭션이면 "지갑은 지급 후, 외부자금 합계는 지급 전"인 조합이 가능하고, TWR은 그 차액 전부를 투자수익으로 계산한다 — 광고 시청이 수익률로 표시된다.
- 일반 daily snapshot job은 계정별 트랜잭션 시작 직후 광고 지급과 **동일한** `trading_accounts` row를 `FOR UPDATE`로 잠그고, 잠금 후 DB에서 다시 읽은 값으로 mode·status·participant·금융 integrity·외부자금 연속성을 재검사한다. 전역 락도, 전체 계정 단일 트랜잭션도 아니다.
  근거: 잘못된 조합으로 만들어진 snapshot은 요청 하나가 아니라 영구 기록으로 남는다. 목록 조회 시점의 status를 믿으면 그 사이 closed된 계정에 snapshot을 쓴다.
- 계정별 `capturedAt`은 lock 획득 이후 결정하며, 같은 트랜잭션의 scheduled EquitySnapshot과 DailyPortfolioSnapshot이 같은 값을 공유한다. batch `startedAt`을 모든 계정에 강제하지 않는다.
  근거: 앞 계정 처리와 광고 지급 대기로 시간이 흐르면, 실제 지갑을 읽은 시각과 기록된 시각이 어긋난다.
- 일반 history는 반환할 **모든** 행을 검증한다(scope·성과 3컬럼 non-null·PnL 항등식·returnRate↔factor·origin factor 1·ordinary reference null·boundary pair 완전성). claim 대조는 요청당 1회 batch 조회다. legacy unkeyed claim에 없는 경계를 요구하거나 만들지 않되, 경계가 실제로 있으면 불완전한 pair를 정상으로 반환하지 않는다.
  근거: 최신 상태만 검사하면 손상된 과거 행이 `"investmentPnlKrw": null`로 200에 실리고, 짝 잃은 `after`는 차트에서 거래 수익과 구분되지 않는 수직 상승이 된다.
- keyed claim의 `responsePayloadJson`은 shape를 엄격히 검증한다(`success=true`, `data.granted`/`duplicate` boolean, claimId·grantedAt·walletBalanceAfter 존재 및 원장 일치). 저장 payload는 최초 사실이므로 항상 `granted=true, duplicate=false`다. legacy unkeyed claim에는 강제하지 않는다.
  근거: "null이 아니기만 하면 된다"는 검사는 `{}`나 `{data:{}}`가 모든 필드 비교를 공허하게 통과시켜, 증거 없는 지급을 성공으로 replay한다.
- SeasonRanking은 시즌 전용 모델로 유지하고(`seasonParticipantId` NOT NULL 그대로), `tradingAccountId`를 nullable 두 번째 식별자로 additive 추가한다. 일반계정 account가 연결되면 무결성 오류다. NOT NULL 강화는 repair 수렴 이후의 별도 작업이다.
  근거: 랭킹 행이 어느 격리 계정에서 나왔는지 명시되지 않으면 일반계정 오염과 계정 불일치를 탐지할 방법 자체가 없다.
- 모든 ranking writer는 participant + 검증된 accountId를 dual-write하고, participant link가 null이면 **한 행도** 만들지 않는다. 기존 행의 null scope나 non-null mismatch는 일상 write로 덮어쓰지 않고 repair 필요 오류를 낸다.
  근거: 한 명이 빠진 랭킹은 더 작은 정상 랭킹이 아니라 그 아래 전원의 순위가 밀린 틀린 랭킹이다. mismatch는 둘 중 무엇이 맞는지 writer가 알 수 없다.
- 랭킹 계산 입력(DailyPortfolioSnapshot·EquitySnapshot·executed Order)의 scope 손상은 해당 행 제외가 아니라 job 전체 fail-closed다.
  근거: 제외는 중립적이지 않다. equity 저점이 빠지면 MDD(tie-break #2)가, executed order가 빠지면 fill count(tie-break #3)가 낮아져 손상된 계정이 위로 올라간다.
- 모든 ranking reader는 scope 컬럼을 select하고 검증한다. 손상이 하나라도 있으면 전체 set을 구조화된 500으로 낸다 — 빈 결과로 숨기거나, 해당 행만 빼거나, rank를 다시 매기지 않는다. row 자체가 없는 것(부재)만 기존 unavailable 응답이다. `tradingAccountId`는 공개 응답에 노출하지 않는다.
  근거: 손상을 "일시적 불가"로 표시하면 아무도 고치지 않고, 한 명을 조용히 빼면 아무도 볼 수 없는 방식으로 틀린 리더보드가 된다.
- ranking refresh·daily ranking job·settlement는 모두 같은 `seasons` row를 `FOR UPDATE`로 잠가 직렬화한다. `RankingRefreshService`의 in-memory Set은 같은 프로세스 보조 장치로만 남는다. Redis 분산락·큐는 도입하지 않는다.
  근거: 실제 문제가 되는 경쟁은 live refresh vs settlement이고, 두 instance나 API 옆의 batch는 메모리를 공유하지 않는다. settled season의 확정 결과를 refresh가 지우고 다시 쓸 수 있었다.
- season settlement는 final ranking·participant 결과·participant 상태 전환·**모든** 연결 season account 종료·`Season.status=settled`를 한 트랜잭션에서 원자 처리하고, open limit reservation을 트랜잭션 **안에서** 재검사한다. 일부 account만 closed된 상태로 settled가 되지 않는다.
  근거: 사전 검사 이후 지정가 주문이 들어와 현금이 다시 예약되면 미완결 주문서 위에서 정산하게 된다. 시즌이 끝났는데 그 시즌 계정 하나가 거래 가능해 보이면 안 된다.
- account 종료 시각은 `COALESCE(기존 closedAt, Season.endAt)`이며 `mode='season'`을 모든 WHERE에 고정한다. status는 오직 `closed`로만 쓴다.
  근거: 실제 거래 가능 기간은 `endAt`에 끝났다. 정산 job이 늦게 돌았다고 계정이 그때까지 살아 있던 것으로 만들면 안 되고, 이미 더 이른 종료 시각이 있으면 그쪽이 사실이다.
- 정산 시점에 `registered`로 남은 participant는 상태를 유지하고 final rank·tier를 받지 않으며 로그로 보고된다. 계정은 시즌의 나머지와 함께 closed된다.
  근거: 가입 흐름은 진입 시 활성화하므로 registered 잔존은 이상 상태이고, 조용히 finished로 바꾸는 것은 "경쟁했다"는 주장을 서버가 대신 하는 것이다.
- FinalTierAssignmentJob은 finalRank/finalTier가 절반만 설정됐거나 ranking.rank·정책 계산과 다른 상태를 `FINAL_TIER_ASSIGNMENT_CONFLICT`로 중단한다. 완전히 동일한 값이면 기존대로 idempotent existing이다.
  근거: 절반짜리 결과를 existing으로 건너뛰면 사용자는 리더보드가 부정하는 결과를 영구히 갖고, job은 성공을 보고한다.
- `repair-ranking-scope`는 기본 dry-run이며 `ranking.tradingAccountId`만 채운다. non-null mismatch·participant link null·general account·user/season 불일치는 보고만 하고 절대 고치지 않는다. 함께 출력되는 audit는 read-only이며 rank 재계산이나 재번호 매기기를 하지 않는다.
  근거: 추측으로 채운 scope는 잘못된 계정에 성적을 귀속시킨다. rank gap이나 tier 불일치는 스크립트가 아니라 해당 job 재실행으로 고쳐야 한다.
- 랭킹 계산 정책·순위 방식(sequential 1,2,3,4)·티어 비율·시즌 초기자본 기준 수익률은 이번 작업에서 변경하지 않는다. reward 지급 gate는 계속 닫혀 있고, 실제 광고 provider는 계속 미연동이다.
