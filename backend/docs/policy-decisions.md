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

## Freshness Thresholds (`capturedAt` 기준)

| 대상 | Quote/Read | Execute |
| --- | --- | --- |
| KRX 국내주식 | 60초 | 10초 |
| 미국주식 (NAS/NYS) | 60초 | 10초 |
| BINANCE 암호화폐 | 60초 | 10초 |
| USD/KRW FX | 300초 (admin_manual 폴백은 `effectiveAt` 60초) | 60초 |

근거: quote/read는 참고용이라 완화된 기준을 적용하고, execute는 자금 이동을 수반하므로 더 타이트한 기준을 강제한다. FX 60초 기준은 provider 도입 이전부터 쓰이던 기존 admin_manual 정책을 그대로 승계했다.

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
