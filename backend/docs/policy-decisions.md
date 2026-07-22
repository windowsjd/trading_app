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

## Limit Buy Phase 1 (Cash Reservation, No Matching)

지정가 매수 1차 예약 기반과 2차 경로 A 정책. 상세 운영 계약은
`docs/limit-order-live-matching-operations.md`를 따른다. 3차 경로 B(확정
5분봉 안전망)는 `docs/limit-order-candle-reconciliation.md`를 따른다.

- 지원: 지정가 매수 등록/취소만. 전량 주문, GTC 성격(주문 자체 만료 없음). 지정가 매도·부분 체결·IOC/FOK/DAY·Stop·실거래소 주문은 미지원.
- 등록은 항상 `status=submitted`로 commit된다. 자동 체결 플래그가 꺼져 있으면 reservation-only이고, 켜져 있으면 이후 normalized live trade event가 Redis Stream/Poller 경로로 처리될 때만 전량 체결된다. Create 자체는 Provider 현재가를 읽거나 즉시 체결하지 않는다.
- 현금 의미: `balanceAmount`=총 보유 현금(총자산 평가 입력, 예약으로 감소하지 않음), `reservedAmount`=submitted 지정가 매수 예약금, `availableAmount`=balance-reserved(파생값, DB 미저장). 홈/포트폴리오/랭킹/equity·daily snapshot/정산/거래기록 평가에서 reservedAmount를 차감하지 않는다.
- 예약금: `gross=round8(limitPrice×qty)`, `fee=round8(gross×feeRate)`, `reserved=round8(gross+fee)` — 시장가 매수 netAmount와 동일한 반올림 체인. 등록 시점 feeRate는 `orders.reservation_fee_rate`에 영구 저장(2차 체결 단계에서 동일 rate 사용).
- 수수료율 고정(Quote 시점): 예약 계산 근거를 durable Quote에 저장한다(`quotes.quoted_fee_rate/quoted_gross_amount/quoted_fee_amount/quoted_reserved_amount`, 시장가·FX Quote는 모두 null). Create는 이 저장값을 그대로 예약하고 현재 `Season.tradeFeeRate`를 다시 읽지 않는다. Quote 이후 운영자가 시즌 수수료율을 바꿔도 Quote 응답 예약금 = 실제 wallet reservedAmount 증가액 = `Order.reservedAmount`가 모두 동일하며, `Order.reservationFeeRate`도 Quote 시점 rate다. Create는 저장값을 재검증한다(전부 non-null, 음수 아님, rate가 [0,1], gross/fee/reserved가 Quote의 limitPrice×quantity에서 canonical 반올림 체인으로 재도출 가능). 실패 시 `QUOTE_RESERVATION_BASIS_INVALID`(409)로 거절하며 현재 시즌 수수료율로 대체 계산하는 fallback은 두지 않는다 — 조용한 재가격 산정이야말로 이 고정이 막으려는 실패다.
- 미체결 주문 금액 필드 의미: `grossAmount`/`feeAmount`/`netAmount`/`executedPrice`/`executedAt`는 **실제 체결 결과**만 의미한다. 자동 체결이 없는 1차 단계에서 `submitted`·`canceled` 지정가 주문은 이 다섯 필드가 모두 null이다. 미체결 주문의 금액은 `reservedAmount`(체결금액이 아니라 미체결 예약금)와 `reservationFeeRate`, 그리고 등록 전 단계에서는 Quote의 `quoted*` 예상값으로 제공한다. 시장가 executed 주문의 세 금액 의미는 그대로 유지한다. 근거: 예약 추정치를 체결 결과 컬럼에 쓰면 미체결 주문이 체결된 것처럼 읽히고, 2차 체결 단계에서 진짜 체결값을 쓸 자리가 사라진다.
- Create 동시성: transaction 밖 season/participant 검사는 빠른 오류 반환용 보조 검증일 뿐이다(그 사이에 운영자가 참가자를 제외하거나 시즌을 종료할 수 있다). 금융 정확성은 transaction 안에서 잠근 행의 재검증이 보장한다. Lock 순서는 `Quote(FOR UPDATE) → SeasonParticipant(FOR SHARE) → Season(FOR SHARE) → CashWallet(가드 UPDATE) → Order(insert)`. seasonId는 잠근 participant 행에서 읽어 participant↔season 연결까지 committed 상태로 검증한다.
  - 모든 위 lock 뒤 `clock_timestamp()`를 조회한다. transaction 시작 시각에 고정되는 `now()`/`CURRENT_TIMESTAMP`는 사용하지 않는다. Quote TTL, Season.start/end, 주식시장 세션을 이 시각으로 재검증하고 Order submitted/created/updated 시각도 동일 값을 쓴다.
  - `FOR SHARE`를 쓰는 이유: 동시 Create끼리는 직렬화되지 않으면서, 참가자 제외·시즌 종료의 일반 UPDATE(`FOR NO KEY UPDATE`)와는 충돌해 대기하게 만든다. 결과적으로 경합 시 가능한 결말은 둘뿐이며 둘 다 안전하다 — Create가 먼저 commit되고 cleanup이 그 주문을 취소·예약 해제하거나, 제외/종료가 먼저 commit되고 Create가 실패한다. excluded participant나 ended season에 신규 예약금이 남는 상태는 성립할 수 없다.
  - participant를 season보다 먼저 잠그는 이유: settlement가 `SeasonParticipant` 갱신 후 마지막에 `Season`을 갱신하므로, season을 먼저 잠그면 순서가 역전돼 deadlock이 가능하다. 시즌 종료 transaction은 `Season`만 건드리고, 취소·cleanup 경로는 `Order → CashWallet`만 잠그므로 이 순서와 순환이 없다.
  - 부수 효과: 시즌이 ended가 된 뒤에는 신규 예약이 생길 수 없으므로, settlement의 open-reservation 사전점검(트랜잭션 밖 2개 count)이 사이에 끼어든 Create 때문에 뚫리는 창도 함께 닫힌다.
- 원자성: 모든 일반 현금 차감(시장가 매수, FX source debit)과 예약 생성은 단일 SQL UPDATE 안에서 `balance_amount - reserved_amount >= :amount` 가드로 판정한다(read-then-write 금지, parameterized raw SQL: `src/wallets/cash-wallet-atomic.ts`). DB CHECK(`reserved>=0`, `balance>=reserved`)가 최후 방어선.
- 취소: Order row lock(FOR UPDATE) → CashWallet 순서. 예약 해제와 `submitted→canceled` 전이가 한 transaction이라 해제는 주문당 정확히 1회. 중복 취소는 멱등 replay. 취소는 `LIMIT_ORDER_ENABLED`와 무관하게 항상 가능.
- 정산 전제조건: 해당 시즌에 submitted 지정가 매수 또는 reservedAmount>0 지갑이 남아 있으면 `OPEN_LIMIT_ORDER_RESERVATIONS`로 settlement를 차단한다. 시즌 lifecycle job이 tick마다 ended/settled 시즌의 잔여 예약을 자가치유 정리하므로 차단은 일시적이다.
- 기능 플래그: `LIMIT_ORDER_ENABLED`와 `LIMIT_ORDER_AUTO_EXECUTION_ENABLED`는 모두 기본 false이며 동일 strict boolean parser를 쓴다. auto=true이면 normalized trade XADD/Poller가 동작하고 신규 지정가 Quote/Create는 fresh DB Ops heartbeat, active Publisher, 자산별 KIS/Binance 연결 및 Redis activation cursor를 요구한다. 장애 시 지정가 신규 등록만 fail-closed하며 Cancel/cleanup/시장가/FX는 계속 동작한다. 기존 submitted 주문은 activation cursor가 있는 경우 `LIMIT_ORDER_ENABLED=false`여도 auto=true에서 계속 체결될 수 있다.
- 경로 A 회계: event.price<=limitPrice만 실제 event.price로 전량 체결한다. fee는 `Order.reservationFeeRate`를 사용한다. balance는 actual gross+fee만 차감하고 reserved는 원 주문 예약금 전체를 해제한다. ledger/Position/evidence/Equity/Order는 한 transaction, ranking은 commit 후 refresh다. 중복 eventId는 `limit_order_processed_events`로 막고, 제출 이전 이벤트는 Redis activation cursor로 막는다.
- 프런트엔드 공개 플래그: `EXPO_PUBLIC_LIMIT_ORDER_ENABLED`는 반드시 정적 dot notation(`process.env.EXPO_PUBLIC_LIMIT_ORDER_ENABLED`)으로 읽는다. `babel-preset-expo`의 inline-env-vars 패스는 property가 `EXPO_PUBLIC_` 리터럴인 member expression만 치환하므로, `process.env[key]` 같은 동적 접근은 번들에 값이 아예 들어가지 않아 플래그가 항상 꺼진 것처럼 동작한다. 클라이언트는 부팅 실패시킬 지점이 없으므로 백엔드와 달리 미인식 값도 fail-closed(false)로 두고, 엄격 검증은 실제 인가 주체인 서버가 담당한다.
- 근거: 예약 없는 지정가 등록은 체결 시점 잔액 부족을 만들고, 예약을 balanceAmount 차감으로 구현하면 총자산이 왜곡된다. 예약을 별도 fence 컬럼으로 두면 두 문제를 모두 피하면서 기존 시장가/FX/평가 경로의 의미를 보존한다.

## Limit Buy Phase 3 (Event Boundary, Canonical Source, Path B)

- event boundary mutex: Create·경로 A Poller·경로 B worker가 하나의 PostgreSQL advisory lock(namespace 1244660901, key 2)을 공유한다. Create는 transaction의 **첫 문장**에서 `pg_advisory_xact_lock`을 잡아 commit과 동시에 해제하고, 두 worker는 **전용 PostgreSQL 세션**에서 `pg_advisory_lock`을 잡는다(프로세스가 죽으면 세션 종료로 서버가 자동 해제 — lease/TTL 없음, Redis lock 금지). 근거: cursor 조회 후 commit 전에 XADD된 이벤트가 Poller에서 먼저 processed·ACK되면 그 이벤트는 영구 누락된다. mutex가 있으면 가능한 interleaving은 두 가지뿐이고 둘 다 정확하다.
- lock 순서 고정: 모든 참가자가 **row lock보다 먼저** boundary를 잡는다(`boundary → Quote → SeasonParticipant → Season → Wallet`). row lock 뒤에 boundary를 잡으면 worker가 boundary를 다른 세션에서 들고 있으므로 PostgreSQL deadlock detector가 볼 수 없는 순환이 생긴다.
- ACK 순서: Redis ACK는 durable processed-event row 저장 **이후**, boundary 해제 **이후**에만 실행한다. ACK가 먼저면 crash 시 이벤트가 완전히 유실된다.
- ordering 기준: 주문 활성화 전후 판정은 Redis Stream ID만 사용한다(`event.streamId > order.matchingActivationStreamId`). `order.submittedAt <= event.receivedAt` 비교는 제거했다 — submittedAt은 PostgreSQL `clock_timestamp()`, receivedAt은 Node 프로세스 시계라 두 호스트의 clock skew만으로 정상 이벤트가 제외됐다. timestamp는 감사·표시·이상치 감지 용도로만 남기고, 명백히 깨진 값(60초 이상 미래, `publishedAt < receivedAt`)만 거절한다. 임의의 큰 skew tolerance로 덮지 않는다.
- canonical provider source: Provider별로 exact-trade publisher는 정확히 하나다(`ProviderTradeRouteRegistry`). LiveCandleStreamSupervisor가 해당 Provider를 소유하면 그 연결이 canonical source가 되어, KIS는 **동일한 parse 결과**를 candle pipeline·가격 표시·matcher에 함께 전달하고, Binance는 **같은 소켓**에 `@kline_5m`과 `@trade`를 함께 구독한다. Supervisor가 비활성인 Provider만 legacy streaming service가 claim한다. 소유하지 않은 쪽은 연결도 publish도 하지 않으므로 소켓 중복·이벤트 중복이 성립할 수 없다.
- 자산별 readiness: Provider 전체 connected가 아니라 **요청 자산**이 현재 connection generation의 구독 집합에 있고 ACK까지 완료됐을 때만 지정가 Quote/Create를 허용한다. reconnect는 새 generation을 만들어 이전 readiness를 전부 무효화한다. 오류는 `LIMIT_ORDER_PROVIDER_NOT_SUBSCRIBED` / `_SUBSCRIPTION_FAILED` / `_UNAVAILABLE`로 구분한다. 근거: 미구독 자산 주문을 받으면 체결될 수 없는 주문에 사용자 현금을 예약하게 된다.
- per-event DB 조회 제거: 구독 구성 시 한 번 읽은 asset metadata를 registry에 보존하고 normalized tick에 실어 보내, Publisher는 trade마다 asset 조회를 하지 않는다(측정: 1000 event, asset query 0). Poller는 짧은 TTL의 bounded cache를 쓴다. 둘 다 routing 최적화일 뿐이며, candidate query와 execution transaction의 asset 재검증은 그대로 유지된다 — stale cache만으로 체결되지 않는다.
- matcher health gate: heartbeat 존재 여부만 보지 않고 lag/pending/oldest-pending age/last ACK age/retention headroom/degraded reason을 함께 판정한다. 단, **조용한 시장은 실패가 아니다** — ACK staleness는 backlog(pending>0 또는 lag>0)가 있을 때만 판정하고, 새 leader의 첫 ACK 이전에는 leader 시작 시각을 기준으로 삼는다. fail-closed는 신규 지정가 Quote/Create에만 적용하고 Cancel·cleanup·시장가·FX는 영향받지 않는다.
- processed-event 보존: retention 삭제를 구현하지 **않는다**. eventId를 지우면 동일 id 재수신이 신규 이벤트로 처리돼 나중에 생성된 주문을 잘못 체결할 수 있는데, 이를 배제하려면 Provider별 trade id 재사용 범위·Stream retention·주문 최대 생존 기간(GTC라 시즌 종료에만 의존)을 모두 증명해야 하고 현재는 불가능하다. 대신 row count/최고·최신 processedAt/1시간·24시간 증가량/table·index size를 heartbeat에 기록하고 BRIN index로 집계 비용을 낮췄다. 향후 partition이 정식 경로이며 임시 TTL 삭제는 두지 않는다.
- 경로 B 체결가격: `executedPrice = order.limitPrice`. candle.low는 **도달 사실의 증거**일 뿐 체결가격이 아니다. 5분봉 저가만으로는 가격 이동 순서·체결 가능 수량·호가를 알 수 없으므로 저가 체결은 사용자에게 과도하게 유리하다. fee는 `Order.reservationFeeRate`를 쓰고, 재계산한 actualDebit이 `Order.reservedAmount`와 다르면 추가 차감·임의 보정·체결 없이 `LIMIT_ORDER_CANDLE_RESERVATION_MISMATCH`로 운영자 개입을 요구한다.
- 경로 B 첫 허용 candle: `candleMatchingEligibleFrom`은 제출 시각을 5분 경계로 **올림**한 값이다. 주문 제출 당시 진행 중이던 봉의 저가는 주문 이전에 찍혔을 수 있고 5분봉은 시점 정보를 담지 않으므로 그 봉은 사용하지 않는다. 값이 null인 기존 주문(경로 B 이전 생성, 또는 자동 체결 off 상태 생성)은 과거 candle로 **소급 활성화하지 않는다** — backfill 없음.
- 경로 B 시즌 경계: `candle.closeTime <= Season.endAt`이며 시즌 종료 후 소급 체결은 없다. 결과적으로 시즌 종료 직전 진행 중이던 마지막 봉의 missed touch는 복원할 수 없다. 경로 B를 위해 시즌 종료 순서를 늦추지 않았고, final drain은 별도 작업으로 남긴다.
- 경로 A/B 배타성: 두 경로는 동일한 lock 순서와 `updateMany(status='submitted')` 가드를 공유하므로 한 주문에 정확히 한 경로만 성공한다. evidence도 배타적이다(DB CHECK): 경로 A는 `triggerEventId + assetPriceSnapshotId`, 경로 B는 `limitOrderCandleEvidenceId`, 동시 연결 불가. 경로 B는 synthetic AssetPriceSnapshot을 만들지 않는다.
- 기능 플래그 조합: auto=false/candle=false는 reservation-only, auto=true/candle=false는 경로 A만, auto=true/candle=true는 A+B, auto=false/candle=true는 **startup error**다. 경로 B 단독 활성화는 exact trade evidence가 있는데도 모든 체결을 수 분 늦게 지정가로 처리하는 downgrade이므로 조용히 허용하지 않는다.
