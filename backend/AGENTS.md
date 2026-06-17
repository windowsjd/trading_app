# AGENTS.md

## Project
가상트레이딩 앱 백엔드

## Role
개발자 B (백엔드 / DB / 계산 / 서버)

## Hard Rules
- 금융 값은 문자열로 주고받는다
- 홈은 집계형 API 1개
- 주문/환전은 quote → execute
- 시즌 미참가는 empty가 아니라 blocked/guide
- 미국 주식은 USD wallet 사용
- 최종 평가는 KRW 기준 총자산
- 시즌 종료 후 거래/환전 차단

## Source of Truth
1. docs/codex-rulepack.md
2. docs/current-status.md

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