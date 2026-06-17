# codex-rulepack.md

## Domain
시즌 기반 가상 트레이딩 앱

## Core Flow
login → current season → join → home → fx

## Fixed Rules

### Wallet
- KRW wallet
- USD wallet

### 초기값
- KRW 10,000,000
- USD 0

### 평가
총자산 = KRW + (USD × 환율) + 자산 평가금액

### API 규칙
- 모든 금액 문자열
- UTC ISO 시간
- success/data 구조 유지

### 거래
- 시장가만
- quote → execute

### 상태
- active + joined
- active + not joined
- upcoming
- ended
- settled

### 금지
- fake 데이터 생성 금지
- schema 임의 변경 금지
- API 계약 임의 변경 금지