# current-status.md

## 현재 상태

### 완료
- 개발환경 세팅 완료
- Nest + Prisma + Postgres 연결 완료
- migration 완료
- seed 완료
- health API 완료

### 구현 완료 API
- GET /api/v1/seasons/current
- POST /api/v1/seasons/{seasonId}/join

### 현재 구조
- Nest
- Prisma 7 (adapter 방식)
- PostgreSQL (Docker)
- Redis (Docker)

### 현재 인증 가정
- 보호 API에서 사용자 식별자는 `request.user.userId` 기준
- auth 본체는 아직 미구현 또는 미완성
- 따라서 보호 API는 실제 auth 연결 전까지 런타임 검증 필요

### 현재 DB 상태(실제 존재 확인 기준)
- users
- seasons
- season_participants
- cash_wallets

### 현재 DB 상태(아직 없음 / 미도입)
- wallet_transactions
- exchange_transactions
- fx_rate_snapshots
- positions
- equity_snapshots
- season_rankings

---

## 아직 안 한 것
- home API
- wallets API
- fx API
- orders API
- ranking
- records
- settlement

---

## 다음 작업
- 1순위: GET /api/v1/home
- 단, 구현 전에 현재 스키마로 truthfully 가능한지 먼저 판단
- 불가능하면 구현하지 말고 STOP 후 부족한 구조 보고

### 다음 작업 STOP 가능성
- ranking 계산 근거 부족 가능
- allocation 계산 근거 부족 가능
- equityChart 생성 근거 부족 가능
- USD KRW 환산용 환율 소스 부족 가능

---

## 최근 합의(외부 공유된 계약)
- records orders item에 `side` 포함
- records orders item에 `orderId`, `assetId`, `name` 포함 방향 유지
- records exchanges item에 `feeCurrency` 포함
- records exchanges item에 `exchangeId` 포함 방향 유지

---

## 마지막 검증 상태
- season current / season join 기준 build 통과
- x-user-id fallback 제거 완료
- join API는 request.user.userId 기준
- join 시 KRW/USD wallet 2개 생성
- schema 변경 없이 구현됨

---

## TODO
- wallet_transactions 도입
- exchange_transactions 도입
- fx_rate_snapshots 도입
- equity_snapshots 도입
- positions 도입
- season_rankings 도입