# codex-rulepack.md

## Domain
시즌·일반 모드 가상 트레이딩 앱. 금융 소유권은 required `TradingAccount` scope다.

현행 규칙은 [문서 안내](README.md)의 API/finance/order/ops 계약과 구현·tests·migrations, 명시적 current 제품 정책을 함께 대조한다. Historical 전환 기록은 현재 규칙이 아니다.

## Core Flow
login → 계정/모드 선택 → 시즌 참가 또는 일반계정 개설/재진입 → home → 주문/FX

## Fixed Rules

### Wallet
- Canonical set: Securities KRW/USD + Crypto Spot USD + Crypto Futures USD
- 초기 지급은 기존 Securities KRW 10,000,000 / USD 0, Crypto 두 지갑은 balance/reserved 0
- 신규 Crypto Spot 주문은 `crypto_spot/USD`, 주식은 Securities, FX는 Securities KRW↔USD다.
- Quote/Order의 `cashWalletScope` + account/currency를 lifecycle 동안 유지한다. 기존 주문/Quote는 migration에서 Securities로 pin하며 현금·예약금·Position을 이동하지 않는다.
- 각 cash mutation/진단은 exact expected scope를 명시한다. 자산 타입으로 기존 주문 scope를 재추론하거나 다른 wallet으로 fallback하지 않는다.
- 동일 계정의 USD 지갑 간 Transfer는 PostgreSQL 원자적 내부이동이며 총자산/TWR/랭킹에 중립이다.
- Wallet UI는 네 지갑을 scope+currency로 구분한다. Futures는 보관·이체만 가능하며 FX 포함 이체와 Futures trading은 미지원이다.
- 기존 계정은 배포 migration에서 zero Crypto 지갑만 추가하며 GET 자동 복구를 금지한다.

### 평가
총자산 = 모든 KRW cash + (모든 USD cash × 동일 canonical FX) + 기존 Spot 자산 평가금액
예약은 balance에서 차감하지 않는다. USD cash/position이 모두 0이면 FX가 필요하지 않다.

### API 규칙
- 모든 금액 문자열
- UTC ISO 시간
- success/data 구조 유지

### 거래
- 일반·시즌 모두 시장가/지정가 BUY·SELL 지원
- 시장가·FX: durable quote → execute; 양 모드 모두 quote에서 fee rate pin, 체결 시 가격/환율 재검증
- 지정가: quote → create(submitted + 예약) → scheduler Path A/B 전량 체결 또는 cancel/시즌 cleanup
- 매칭 권위: PostgreSQL submitted orders + scheduler polling + OpsJobLock + 주문별 execution transaction
- 신규 지정가는 `LIMIT_ORDER_ENABLED`, 자동 체결은 `SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED`로 각각 제어
- lock order·fee 예외는 [주문 계약](orders-api-contract.md)과 [정책](policy-decisions.md) 참조

### 상태
- 공통 TradingAccount: active / suspended / closed
- 아래 시즌 상태·참가 gate는 시즌모드에 적용
- active + joined
- active + not joined
- upcoming
- ended
- settled

### 금지
- fake 데이터 생성 금지
- schema 임의 변경 금지
- API 계약 임의 변경 금지
