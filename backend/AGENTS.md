# AGENTS.md

## Project
가상트레이딩 앱 백엔드

## Role
개발자 B (백엔드 / DB / 계산 / 서버)

## Hard Rules
- 금융 값은 문자열로 주고받는다
- 홈은 집계형 API 1개
- 주문/환전은 quote → execute
- 시즌모드 미참가는 empty가 아니라 blocked/guide; 일반모드는 시즌 참가를 요구하지 않는다
- 미국 주식은 USD wallet 사용
- 최종 평가는 KRW 기준 총자산
- 시즌계정은 시즌 종료 후 신규 거래/환전 차단; 취소·예약 cleanup과 committed replay는 기존 계약 유지

## Source of Truth
1. 현재 구현·tests·migrations와 명시적 current 제품 정책을 함께 확인한다. 충돌은 자동으로 어느 한쪽이 옳다고 보지 말고 조사하며, 제품 정책을 임의로 바꾸지 않는다.
2. [docs/README.md](docs/README.md)의 current API/finance/order/ops 계약을 따른다. API base는 `/api/v1`이다.
3. [docs/policy-decisions.md](docs/policy-decisions.md)의 current section과 [docs/codex-rulepack.md](docs/codex-rulepack.md)를 함께 확인한다.
4. HANDOVER, investigations, Historical/superseded 전환 기록은 당시 증거이며 현행 계약을 덮어쓰지 않는다.

## Change Policy
- 문서 → 합의 → 코드
- 구조 변경 시 STOP
- 임의 API 변경 금지

## Coding Rules
- Prisma 7 adapter 방식 유지
- PrismaService 재사용
- migration/seed 임의 변경 금지
- unrelated refactor 금지

## Output Rules
항상:
1. 수정 파일 목록
2. 변경 이유
3. 규칙 준수 체크
4. 코드
5. 검증 방법
6. 리스크