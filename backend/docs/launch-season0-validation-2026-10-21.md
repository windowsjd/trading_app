# season0 구현·검증 보고서 (2026-10-21)

## 상태와 기준

| 항목 | 결과 |
| --- | --- |
| 기준 main / 로컬 HEAD / origin/main | `5986d7f7111f6c8eb4f80f2a3eb1282c8f5b88e1` (시작 clean, 반영 전 재 fetch도 동일) |
| 작업 위치 | main. 기존 병행 worktree/브랜치 유지, 기존 사용자 변경 덮어쓰기 없음 |
| 구현 및 로컬 검증 | 아래 결과 참조 |
| 운영 적용 준비 | [운영 절차](launch-season0-operations.md): 코드·절차 준비. 실제 백업/기기/운영 설정 확인은 승인 단계의 필수 잔여 작업 |
| 운영 DB 실제 적용 | **미실행**. 조회만 수행. migrate/seed/시즌 생성·활성화·삭제/worker 설정 변경/배포 없음 |
| 정식 출시 시각 | **미정**. 임의 날짜를 넣지 않음 |
| 최종 Git SHA | 이 문서를 포함한 main 커밋 SHA와 push 결과는 최종 작업 보고 및 Git log 참조 |

## 실제 문제와 선택한 설계

개발 시즌은 2000~2099 active다. 기존 lifecycle은 동시 active를 `DUPLICATE_ACTIVE_SEASON`으로 막는다. 단순히 다음 시즌을 넣으면 이 검증과 충돌한다. 개발 시즌을 ended로 바꾸는 방법은 기존 자동 정산의 대상이 되어 주문/포지션/잔액을 보존한 일시 복구와 충돌한다. status만 전환하면 scheduler 지연과 stale 계정/클라이언트 사이에 거래 경계도 남는다. 기존 참가자별 rankingHiddenAt은 시즌 전체 비공개의 대안이 아니다.

기존 상태·스케줄러·참가/거래 금융 엔진을 유지하고 Season의 7개 추가 필드로 명시적 출시 식별, 예약 승인, 중단/공개 정책, DB 시각 거래 cutoff, 테스트 전환 소유권/복구 검증을 표현했다. 기존 행은 null/false/빈 배열 기본값이므로 배포/마이그레이션만으로 시즌을 바꾸지 않는다. 개발과 출시의 변경은 기존 lifecycle의 단일 트랜잭션에서 처리한다. 원장/주문/환전/위험관리 계산은 변경하지 않는다.

- `season0`: 초기 1,000만 원, 개발 시즌 수수료 복사, UTC 시작 + 정확히 504시간, 5종목 AND 3배의 기존 자격 정책. 개발 시즌에는 자격을 소급하지 않는다.
- upcoming이며 원래 시작 이전이고 활동이 없는 경우에만 날짜 변경. 종료를 재계산하고 다른 시즌과 충돌하면 거부. 활성화/시각 도달 뒤 날짜 이동 금지와 DB CHECK/trigger 보완.
- 공통 공개 시즌/계정 필터와 잠금 후 DB cutoff 검사를 적용. 기존 개발 status를 active로 보존하되 공개/거래/정산 대상에서 제외. 일반·초보는 기존 정책 유지.
- 개발 → 허용 사용자 test(새 ID) → stop → dry-run/승인 cleanup과 개발 복구 → release(다른 새 ID) → 날짜 확정/arm → 기존 lifecycle 전환. 출시 전까지 준비된 unarmed upcoming은 개발을 막지 않는다.

## 운영 DB와 배포 조사 (읽기 전용)

`league of trading` workspace, service `srv-da84cg8u01pc73cjasa0`, PostgreSQL `dpg-da7ac0e1egvs73e2sv20-a` / `trading_app_fbbk` / PG17.

- 현재 시즌은 `sea_2026_s1` / Season 1 / active / 2000-01-01T00:00:00Z ~ 2099-12-31T23:59:59Z. 10,000,000 KRW, trade/fx fee 0.001.
- 작업 중 재조회도 **참가자 7, 랭킹 19**. 과거 제시된 21과 다르므로 실제 최신 조회 수치를 사용했다. 계정 최초 조회는 시즌 7, 일반 5, 초보 6 active였다.
- 운영 세션 시간대는 `UTC`였으며 FK/trigger도 조회했다. 원장 삭제 금지 trigger를 임의 제거하는 경로를 만들지 않았다. cleanup은 현재 catalog 전체 FK와 실제 행 범위를 다시 검사한다.
- Render main commit 자동 배포이며 build는 `pnpm install --frozen-lockfile && pnpm exec prisma generate && pnpm exec prisma migrate deploy && pnpm build`. 작업 전 live는 `48ef6741a87a9732ab01c3a2ee899e769b297d1d` / deploy `dep-dbbmqlt9fdbs73ecev80`.
- 코드 push는 `[skip render]`만 사용한다. 이는 [Render 자동 배포](https://render.com/docs/deploys#skipping-an-auto-deploy)를 건너뛰며 GitHub CI와 수동/다음 배포를 막지 않는다. 운영 환경을 변경하지 않았다.
- 유료 PG의 [PITR/백업 문서](https://render.com/docs/postgresql-backups)를 확인했지만, 실제 복구 창·완료된 백업·복원 연습은 미확인이다. 별도 운영 승인의 선행 조건이다. 신규 클라우드 DB는 만들지 않았다.

## 공개 경로 및 beta UI

- 서버: 현재/시즌 목록, 계정 선택/명시적 조회, 홈, 랭킹/최종 자격, 내 시즌 기록/최종 결과, 타인 시즌 요약/보유자산, 지갑/포트폴리오/보유자산/주문/FX, 보상/배지 목록에 같은 비공개 기준. 숨긴 계정의 기존 주문 재조회/재시도도 일반 종료 시즌의 committed replay와 구분해 접근에서 제외한다. 기존 일반 종료 시즌 replay/멱등 계약은 유지한다.
- 자동 쓰기: 기존 Season 잠금에서 DB 시각과 새 표식을 검사. 랭킹/스냅샷/정산, 현물/선물/조건/LOC/취소·이체의 숨긴 개발 시즌 신규 변경 차단. 중지된 dev의 미체결/예약/포지션을 ended cleanup으로 취소하지 않는다.
- 알림: 테스트 시즌의 금융/시즌 push 생성/발송 제외, 이미 대기 중인 숨긴 계정의 알림도 발송 직전 제외. 일반/초보/출시 release는 기존 정책.
- 앱: metadata 기반 공통 SeasonTitle; 홈·참가/차단 화면·계정 선택/전환·MY 배지·전적/수익 분석·최종 결과·타인 시즌 요약. 일반/초보/개발 및 동일 이름만 있는 시즌에는 beta 없음. 계정 목록 polling/경계 timer/계정 제거 감지로 기존 선택과 관련 캐시를 갱신한다.
- RN-Web의 실제 SeasonTitle 컴포넌트를 320/390px × 글꼴 1/2 × Light/Dark **8조합**에서 검사했다. 기존 읽기 전용 fixture의 실제 HomeScreen·AccountSwitcher·TradingAccountProvider도 320/390 × 1/2배 × Light/Dark × 기본/긴 이름 **16조합**에서 제목/배지/계정 변경 버튼이 서로 겹치거나 경계를 넘지 않음을 확인했다. 브라우저 fixture에는 앱처럼 SafeAreaProvider와 beta metadata를 공급했다. [측정 결과](../../frontend/docs/season0-ui-validation-2026-10-21.json). 전체 한국어 글리프를 포함한 공식 Google Fonts Nanum Gothic TTF를 검증 호스트에서만 사용했다(앱에 추가하지 않음). 긴 한국어 이름 포함, 제목/배지 경계·교차·수평 넘침 없음. 최소 높이 확장과 wrap, 색·접근성 이름은 자동 테스트로 검사. **전체 네이티브 화면·Android/iOS 시스템 글꼴/스크린리더/실기기 이동은 미검증**이다.

## 테스트 데이터 정리와 참조

[운영 문서의 44개 테이블 표](launch-season0-operations.md#cleanup-영향삭제-순서와-방어)와 코드의 명시적 자식 우선 순서가 기준이다. target participant의 전용 season account ID를 사용하며 일반·초보 행은 0건이어야 한다. 사용자/시장·시세·환율·캔들·공통 운영/감사는 유지한다. 공유 운영 JSON에 테스트 ID가 남는 것은 보존해야 하는 감사 흔적이다.

strict read-only dry-run, 테이블별 건수/행 내용 지문, 전체 incoming FK 및 복합 키 검사, 테이블당 10,000행 제한, 전체 Ops lease drain, outbox 잠금, 외부 발송/지급 차단, 계정/JSON 알림 참조 모순 차단, 검토 계획과 apply 사이 상태 변경 거부, 전용 부모/자식 삭제 및 개발 복구의 단일 트랜잭션, 사후 잔존 검사, 기존 감사에 남은 ID의 재사용 거부와 삭제 ID 반복 정리 거부를 구현했다. 실제 삭제에는 plan·정확한 대상 확인·백업 증거 참조·worker 중단 확인과 별도 승인이 필요하다.

## 실행한 검사

결과는 최종 검사 종료 후 아래 표에 확정한다. opt-in skip은 기존 테스트 설정이며 새 테스트를 삭제하거나 skip으로 바꾸지 않았다.

| 검사 | 명령/환경 | 결과 |
| --- | --- | --- |
| 프런트 필수 전체 | frontend `npm run check` (lint:accounts·lint:guides·typecheck·test), Node heap 1536 MB | **3,392/3,392 PASS**, 397 suites, skip 0 |
| 프런트 관련 재검사 | `node --test` homeHeader/SeasonTitle/AccountSwitcherSheet/TradingAccountContext/capabilities | **73/73 PASS**. 전체 검사 이후 홈 wrapper 폭 배분 보완에 대해 재검사; 마지막 typecheck/계정 lint와 홈 16조합도 재확인 |
| 백엔드 전체 | backend `pnpm exec jest --runInBand`, heap 1536 MB | **5,790 PASS**, 358 suites. 기존 opt-in 126 tests/87 suites skip |
| 신규 시즌 실제 DB | `NODE_ENV=test SEASON0_DB_INTEGRATION=1 pnpm run integration:launch-season`, 로컬 PG17 UTC / 빈 `*_test` | **57 assertions PASS**. 원자 전환·동시 참가·잠금 경계·중복 지급 거부·504시간·설정 변경 제한·비공개·cleanup FK/외부 효과/지문·삭제/복구 롤백·개발/일반/초보 보존 |
| 금융 계정 DB 회귀 | `TRADING_ACCOUNT_DB_INTEGRATION=1 pnpm exec jest --runInBand` trading-account-trading-scope / trading-account-financial-scope, 로컬 PG17 UTC | **2 suites/2 PASS** (현물 주문/체결/예약/취소/FX·계정 분리·멱등/손상 거부) |
| 기존 최종 자격/정산 | `SEASON_FINAL_QUALIFICATION_DB_INTEGRATION=1 pnpm exec tsx scripts/season-final-qualification-integration.ts`, 로컬 PG17 UTC | **16/16 scenarios PASS**, 실제 선물/FX 증거·자격/무자격·동시 정산·실패 롤백·최종 결과 무결성 |
| 운영 CLI | 로컬 UTC의 read-only reschedule plan → 잘못된 confirm/backup 누락 거부 → 승인 apply/audit → stale plan 거부 | **PASS**, 운영 쓰기 0 |
| 백엔드 타입/빌드 | `pnpm run typecheck`, `pnpm run build` | **PASS** |
| 계정 린트 | `pnpm run lint:accounts:check` | **PASS** |
| 신규/직접 변경 코드 린트 | 새 launch 정책·정리·CLI·통합검사 + dev-baseline + asset-candles에 `eslint --no-fix --max-warnings=0` | **PASS** |
| 기존 전체 candle 린트 | `pnpm run lint:candles:check` | **기존 오류 1건으로 FAIL**: 변경하지 않은 `scripts/lib/auth-email-fixture.ts:22`의 async send에 await 없음(`require-await`). HEAD와 동일임을 확인. 범위/규칙을 약화하지 않음 |
| candle 포맷 | `pnpm run format:candles:check` | **PASS** |
| 마이그레이션/드리프트 | 빈 로컬 PG17 UTC에 `prisma migrate deploy`, `prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code` | **PASS / No difference**. 운영 migrate 미실행 |
| Prisma 생성물 | `prisma generate` 전후 해시 비교 | **84 generated files 동일** |
| 진단 게이트 | `DIAGNOSTIC_AUDIT_BASE=5986d7f7... node scripts/diagnostic-enforcement.cjs backend` / frontend | **양쪽 PASS** |
| 제목/홈 레이아웃 | RN-Web 실제 SeasonTitle 8조합 + 실제 홈/계정 provider 16조합(기본/긴 이름), 320/390 × 1/2배 × Light/Dark | **24조합 PASS**, native device 아님 |
| diff 자체 검토 | 전체 변경 파일/신규 SQL·운영 코드 검토, `git diff --check` | **PASS**. 금융 수식/공유 데이터 삭제/무승인 운영 apply 없음 |


초기 로컬 통합 검사에서는 raw advisory lock의 PostgreSQL void 반환을 Prisma가 역직렬화하지 못하는 문제를 발견해 `::text`로 수정했다. 새 알림 fixture의 필수 nextAttemptAt도 보완했다. 전체 단위 검사의 query/transaction mock은 비공개 조건과 잠금을 검사하도록 보완했으며 기존 검증을 축소하지 않았다. 프런트 최초 전체 검사 3,392건 중 홈 제목 24건은 새 composite 컴포넌트를 Text로 오인한 assertion이었다. 실제 host Text를 대상으로 검증하도록 고쳤고 해당 69건 재검사 후 전체 검사를 다시 실행했다. 추가 금융 회귀에서 로컬 PG 초기 세션이 KST여서 quote 만료가 재현됐다. 운영 PG는 읽기 전용으로 UTC임을 확인했고, 로컬 DB를 UTC로 맞춘 뒤 시즌/금융/정산/CLI를 다시 검증했다. 운영 CLI에는 비UTC 세션 거부도 추가했다. 최초 샌드박스에서 기존 HTTP/WebSocket 자식 테스트가 EPERM으로 종료된 것을 확인하고 허용된 로컬 실행으로 재검증했다. 메모리 오류/테스트 삭제/검증 우회는 없었다.

## 남은 위험과 운영 적용 조건

1. 운영 DB의 마이그레이션·테스트 생성/전환/정리·정식 release 생성은 **승인 전 미실행**이다. 공식 시작 시각이 미정이므로 현재 운영 DB에 release 행도 없다.
2. 실제 backup/PITR 복구 가능성, 운영자/테스트 사용자 ID와 제한 시간, 기존 scheduler/금융·push worker의 중단·drain/재개 설정을 확인해야 한다. --backup-ref는 운영자 증거 참조이며 자동 백업 검증이 아니다.
3. 테스트를 실제 앱에서 수행하며 초기 지급/거래/랭킹/beta/캐시 복구/타 계정 불변을 재확인해야 한다. 기기·EAS 빌드·스토어 반영·실기기 UI 검증은 수행하지 않았다.
4. 삭제 dry-run에 외부 효과, 새 참조/trigger, 범위/건수 변화가 나오면 자동 삭제를 중지한다. 공유 데이터·운영 감사 흔적을 무리하게 지우지 않는다.
5. cutoff 경계와 lifecycle 활성화 사이 거래 가능 시즌이 잠시 없을 수 있다. 안전하게 닫는 동작이며 기존 scheduler의 정상 tick을 운영에서 확인해야 한다. 새 scheduler는 만들지 않았다.
6. `[skip render]`는 다음 커밋의 자동 배포를 막지 않는다. 다음 backend 배포가 새 schema를 포함함을 운영자가 알고 별도 승인해야 한다.

## 변경 파일과 목적

| 파일 | 목적 |
| --- | --- |
| [.github/workflows/ci.yml](../../.github/workflows/ci.yml) | 기존 core-account CI에 별도 로컬 시즌 fixture 단계 |
| [HANDOVER.md](../../HANDOVER.md) | 설계 이유·검증·운영 미적용 인수인계 |
| [backend/docs/README.md](README.md) | 공개 계약·운영 절차·검증 증거 |
| [backend/docs/home-api-contract.md](home-api-contract.md) | 공개 계약·운영 절차·검증 증거 |
| [backend/docs/launch-season0-operations.md](launch-season0-operations.md) | 공개 계약·운영 절차·검증 증거 |
| [backend/docs/launch-season0-validation-2026-10-21.md](launch-season0-validation-2026-10-21.md) | 공개 계약·운영 절차·검증 증거 |
| [backend/docs/ranking-api-contract.md](ranking-api-contract.md) | 공개 계약·운영 절차·검증 증거 |
| [backend/docs/records-api-contract.md](records-api-contract.md) | 공개 계약·운영 절차·검증 증거 |
| [backend/docs/rewards-api-contract.md](rewards-api-contract.md) | 공개 계약·운영 절차·검증 증거 |
| [backend/docs/trading-accounts-api-contract.md](trading-accounts-api-contract.md) | 공개 계약·운영 절차·검증 증거 |
| [backend/package.json](../package.json) | 기존 pnpm 기반 운영/통합검사 명령 등록 |
| [backend/prisma/migrations/20261021020000_add_launch_season_control/migration.sql](../prisma/migrations/20261021020000_add_launch_season_control/migration.sql) | 추가 필드·출시 CHECK/시작 후 변경 trigger |
| [backend/prisma/schema.prisma](../prisma/schema.prisma) | 기존 Season에 출시/중지 메타데이터 추가 |
| [backend/scripts/launch-season-integration.ts](../scripts/launch-season-integration.ts) | 실제 로컬 PostgreSQL의 원자 전환·정리·금융 보존 검증 |
| [backend/scripts/launch-season.ts](../scripts/launch-season.ts) | 기존 역할/감사의 읽기 전용 계획·명시적 승인 CLI |
| [backend/scripts/lib/dev-baseline.spec.ts](../scripts/lib/dev-baseline.spec.ts) | 기존 검증 유지 + 새 조건/잠금/표시/경계 회귀 |
| [backend/scripts/lib/dev-baseline.ts](../scripts/lib/dev-baseline.ts) | 개발 seed/복구의 원격/production 쓰기 거부 |
| [backend/src/assets/asset-candles.service.ts](../src/assets/asset-candles.service.ts) | 공개 조회/계정 접근의 공통 비공개 필터·표시 metadata |
| [backend/src/batch/daily-portfolio-snapshot-job.service.spec.ts](../src/batch/daily-portfolio-snapshot-job.service.spec.ts) | 기존 검증 유지 + 새 조건/잠금/표시/경계 회귀 |
| [backend/src/batch/daily-portfolio-snapshot-job.service.ts](../src/batch/daily-portfolio-snapshot-job.service.ts) | 비공개 시즌 배치 제외·기존 쓰기 잠금 재검사 |
| [backend/src/batch/season-lifecycle-transition-job.service.spec.ts](../src/batch/season-lifecycle-transition-job.service.spec.ts) | 기존 검증 유지 + 새 조건/잠금/표시/경계 회귀 |
| [backend/src/batch/season-lifecycle-transition-job.service.ts](../src/batch/season-lifecycle-transition-job.service.ts) | 기존 lifecycle에서 명시적 arm만 원자 전환 |
| [backend/src/batch/season-ranking-job.service.ts](../src/batch/season-ranking-job.service.ts) | 비공개 시즌 배치 제외·기존 쓰기 잠금 재검사 |
| [backend/src/batch/season-settlement-job.service.ts](../src/batch/season-settlement-job.service.ts) | 비공개 시즌 배치 제외·기존 쓰기 잠금 재검사 |
| [backend/src/conditional/conditional-buy-worker.service.ts](../src/conditional/conditional-buy-worker.service.ts) | 기존 금융 경로의 시즌 중지 fencing·자동 취소 방지 |
| [backend/src/conditional/conditional-buy.service.ts](../src/conditional/conditional-buy.service.ts) | 기존 금융 경로의 시즌 중지 fencing·자동 취소 방지 |
| [backend/src/conditional/conditional-policy.ts](../src/conditional/conditional-policy.ts) | 기존 금융 경로의 시즌 중지 fencing·자동 취소 방지 |
| [backend/src/conditional/conditional-sell-worker.service.ts](../src/conditional/conditional-sell-worker.service.ts) | 기존 금융 경로의 시즌 중지 fencing·자동 취소 방지 |
| [backend/src/conditional/conditional-sell.service.ts](../src/conditional/conditional-sell.service.ts) | 기존 금융 경로의 시즌 중지 fencing·자동 취소 방지 |
| [backend/src/conditional/conditional-worker.service.ts](../src/conditional/conditional-worker.service.ts) | 기존 금융 경로의 시즌 중지 fencing·자동 취소 방지 |
| [backend/src/conditional/conditional.service.ts](../src/conditional/conditional.service.ts) | 기존 금융 경로의 시즌 중지 fencing·자동 취소 방지 |
| [backend/src/futures/futures-conditional-entry-worker.service.ts](../src/futures/futures-conditional-entry-worker.service.ts) | 기존 금융 경로의 시즌 중지 fencing·자동 취소 방지 |
| [backend/src/futures/futures-conditional-entry.service.ts](../src/futures/futures-conditional-entry.service.ts) | 기존 금융 경로의 시즌 중지 fencing·자동 취소 방지 |
| [backend/src/futures/futures-limit-worker.service.ts](../src/futures/futures-limit-worker.service.ts) | 기존 금융 경로의 시즌 중지 fencing·자동 취소 방지 |
| [backend/src/futures/futures-limit.service.ts](../src/futures/futures-limit.service.ts) | 기존 금융 경로의 시즌 중지 fencing·자동 취소 방지 |
| [backend/src/futures/futures-liquidation.service.ts](../src/futures/futures-liquidation.service.ts) | 기존 금융 경로의 시즌 중지 fencing·자동 취소 방지 |
| [backend/src/futures/futures-tp-sl-worker.service.ts](../src/futures/futures-tp-sl-worker.service.ts) | 기존 금융 경로의 시즌 중지 fencing·자동 취소 방지 |
| [backend/src/futures/futures-tp-sl.service.ts](../src/futures/futures-tp-sl.service.ts) | 기존 금융 경로의 시즌 중지 fencing·자동 취소 방지 |
| [backend/src/futures/futures.service.ts](../src/futures/futures.service.ts) | 기존 금융 경로의 시즌 중지 fencing·자동 취소 방지 |
| [backend/src/fx/fx.service.ts](../src/fx/fx.service.ts) | 공개 조회/계정 접근의 공통 비공개 필터·표시 metadata |
| [backend/src/generated/prisma/internal/class.ts](../src/generated/prisma/internal/class.ts) | Season 7개 필드의 Prisma 생성물 |
| [backend/src/generated/prisma/internal/prismaNamespace.ts](../src/generated/prisma/internal/prismaNamespace.ts) | Season 7개 필드의 Prisma 생성물 |
| [backend/src/generated/prisma/internal/prismaNamespaceBrowser.ts](../src/generated/prisma/internal/prismaNamespaceBrowser.ts) | Season 7개 필드의 Prisma 생성물 |
| [backend/src/generated/prisma/models/Season.ts](../src/generated/prisma/models/Season.ts) | Season 7개 필드의 Prisma 생성물 |
| [backend/src/home/home.service.ts](../src/home/home.service.ts) | 공개 조회/계정 접근의 공통 비공개 필터·표시 metadata |
| [backend/src/notifications/push-dispatcher.service.spec.ts](../src/notifications/push-dispatcher.service.spec.ts) | 기존 검증 유지 + 새 조건/잠금/표시/경계 회귀 |
| [backend/src/notifications/push-dispatcher.service.ts](../src/notifications/push-dispatcher.service.ts) | 비공개/테스트 시즌 push 발행·발송 제외 |
| [backend/src/notifications/push-sources.spec.ts](../src/notifications/push-sources.spec.ts) | 기존 검증 유지 + 새 조건/잠금/표시/경계 회귀 |
| [backend/src/notifications/push-sources.ts](../src/notifications/push-sources.ts) | 비공개/테스트 시즌 push 발행·발송 제외 |
| [backend/src/ops/ops-job-runner.service.spec.ts](../src/ops/ops-job-runner.service.spec.ts) | 기존 검증 유지 + 새 조건/잠금/표시/경계 회귀 |
| [backend/src/ops/ops-job-runner.service.ts](../src/ops/ops-job-runner.service.ts) | 비공개 시즌 배치 제외·기존 쓰기 잠금 재검사 |
| [backend/src/orders/limit-on-close-settlement.service.ts](../src/orders/limit-on-close-settlement.service.ts) | 기존 금융 경로의 시즌 중지 fencing·자동 취소 방지 |
| [backend/src/orders/limit-order-cancel.service.spec.ts](../src/orders/limit-order-cancel.service.spec.ts) | 기존 검증 유지 + 새 조건/잠금/표시/경계 회귀 |
| [backend/src/orders/limit-order-cancel.service.ts](../src/orders/limit-order-cancel.service.ts) | 기존 금융 경로의 시즌 중지 fencing·자동 취소 방지 |
| [backend/src/orders/limit-order-candidate.repository.ts](../src/orders/limit-order-candidate.repository.ts) | 기존 금융 경로의 시즌 중지 fencing·자동 취소 방지 |
| [backend/src/orders/limit-order-create.service.spec.ts](../src/orders/limit-order-create.service.spec.ts) | 기존 검증 유지 + 새 조건/잠금/표시/경계 회귀 |
| [backend/src/orders/limit-order-create.service.ts](../src/orders/limit-order-create.service.ts) | 기존 금융 경로의 시즌 중지 fencing·자동 취소 방지 |
| [backend/src/orders/limit-order-execution.service.ts](../src/orders/limit-order-execution.service.ts) | 기존 금융 경로의 시즌 중지 fencing·자동 취소 방지 |
| [backend/src/orders/orders.service.spec.ts](../src/orders/orders.service.spec.ts) | 기존 검증 유지 + 새 조건/잠금/표시/경계 회귀 |
| [backend/src/orders/orders.service.ts](../src/orders/orders.service.ts) | 공개 조회/계정 접근의 공통 비공개 필터·표시 metadata |
| [backend/src/portfolio/portfolio.service.ts](../src/portfolio/portfolio.service.ts) | 공개 조회/계정 접근의 공통 비공개 필터·표시 metadata |
| [backend/src/positions/positions.service.ts](../src/positions/positions.service.ts) | 공개 조회/계정 접근의 공통 비공개 필터·표시 metadata |
| [backend/src/ranking/ranking-refresh.service.ts](../src/ranking/ranking-refresh.service.ts) | 비공개 시즌 배치 제외·기존 쓰기 잠금 재검사 |
| [backend/src/ranking/ranking.service.spec.ts](../src/ranking/ranking.service.spec.ts) | 기존 검증 유지 + 새 조건/잠금/표시/경계 회귀 |
| [backend/src/ranking/ranking.service.ts](../src/ranking/ranking.service.ts) | 공개 조회/계정 접근의 공통 비공개 필터·표시 metadata |
| [backend/src/ranking/season-write-lock.ts](../src/ranking/season-write-lock.ts) | 기존 Season 잠금 후 DB 시각/중지 표식 검사 |
| [backend/src/records/records.service.spec.ts](../src/records/records.service.spec.ts) | 기존 검증 유지 + 새 조건/잠금/표시/경계 회귀 |
| [backend/src/records/records.service.ts](../src/records/records.service.ts) | 공개 조회/계정 접근의 공통 비공개 필터·표시 metadata |
| [backend/src/records/season-final-result.service.ts](../src/records/season-final-result.service.ts) | 공개 조회/계정 접근의 공통 비공개 필터·표시 metadata |
| [backend/src/rewards/rewards.service.ts](../src/rewards/rewards.service.ts) | 공개 조회/계정 접근의 공통 비공개 필터·표시 metadata |
| [backend/src/seasons/launch-season.operations.ts](../src/seasons/launch-season.operations.ts) | 21일 준비·날짜 변경·arm·원자 전환·test stop/복구 |
| [backend/src/seasons/launch-test-cleanup.ts](../src/seasons/launch-test-cleanup.ts) | 한정 test 계정/시즌 44개 테이블 계획·FK 검사·원자 정리 |
| [backend/src/seasons/season-availability.policy.spec.ts](../src/seasons/season-availability.policy.spec.ts) | 기존 검증 유지 + 새 조건/잠금/표시/경계 회귀 |
| [backend/src/seasons/season-availability.policy.ts](../src/seasons/season-availability.policy.ts) | 시즌 전체 공개/거래 중지·beta의 단일 정책 |
| [backend/src/seasons/season-lifecycle.policy.ts](../src/seasons/season-lifecycle.policy.ts) | 공개 조회/계정 접근의 공통 비공개 필터·표시 metadata |
| [backend/src/seasons/season-trading-lock.ts](../src/seasons/season-trading-lock.ts) | 기존 Season 잠금 후 DB 시각/중지 표식 검사 |
| [backend/src/seasons/seasons.service.spec.ts](../src/seasons/seasons.service.spec.ts) | 기존 검증 유지 + 새 조건/잠금/표시/경계 회귀 |
| [backend/src/seasons/seasons.service.ts](../src/seasons/seasons.service.ts) | 공개 조회/계정 접근의 공통 비공개 필터·표시 metadata |
| [backend/src/trading-accounts/trading-account-access.service.ts](../src/trading-accounts/trading-account-access.service.ts) | 공개 조회/계정 접근의 공통 비공개 필터·표시 metadata |
| [backend/src/trading-accounts/trading-accounts.service.spec.ts](../src/trading-accounts/trading-accounts.service.spec.ts) | 기존 검증 유지 + 새 조건/잠금/표시/경계 회귀 |
| [backend/src/trading-accounts/trading-accounts.service.ts](../src/trading-accounts/trading-accounts.service.ts) | 공개 조회/계정 접근의 공통 비공개 필터·표시 metadata |
| [backend/src/wallets/trading-account-wallet-transfer.service.ts](../src/wallets/trading-account-wallet-transfer.service.ts) | 기존 금융 경로의 시즌 중지 fencing·자동 취소 방지 |
| [backend/src/wallets/wallets.service.ts](../src/wallets/wallets.service.ts) | 공개 조회/계정 접근의 공통 비공개 필터·표시 metadata |
| [frontend/docs/season0-ui-validation-2026-10-21.json](../../frontend/docs/season0-ui-validation-2026-10-21.json) | 공개 계약·운영 절차·검증 증거 |
| [frontend/src/components/states/BlockedState.tsx](../../frontend/src/components/states/BlockedState.tsx) | 기존 시즌 제목에 공통 beta 표시 |
| [frontend/src/components/tradingAccount/AccountSetupPanel.tsx](../../frontend/src/components/tradingAccount/AccountSetupPanel.tsx) | 기존 시즌 제목에 공통 beta 표시 |
| [frontend/src/components/tradingAccount/AccountSwitcher.tsx](../../frontend/src/components/tradingAccount/AccountSwitcher.tsx) | 기존 시즌 제목에 공통 beta 표시 |
| [frontend/src/components/tradingAccount/SeasonTitle.test.ts](../../frontend/src/components/tradingAccount/SeasonTitle.test.ts) | 기존 검증 유지 + 새 조건/잠금/표시/경계 회귀 |
| [frontend/src/components/tradingAccount/SeasonTitle.tsx](../../frontend/src/components/tradingAccount/SeasonTitle.tsx) | metadata 기반 공통 beta 제목/줄바꿈 |
| [frontend/src/features/ranking/api.ts](../../frontend/src/features/ranking/api.ts) | 기존 DTO/선택 모델에 선택 표시 metadata 전달 |
| [frontend/src/features/record/api.ts](../../frontend/src/features/record/api.ts) | 기존 DTO/선택 모델에 선택 표시 metadata 전달 |
| [frontend/src/features/record/seasonBadges.ts](../../frontend/src/features/record/seasonBadges.ts) | 기존 DTO/선택 모델에 선택 표시 metadata 전달 |
| [frontend/src/features/season/api.ts](../../frontend/src/features/season/api.ts) | 기존 DTO/선택 모델에 선택 표시 metadata 전달 |
| [frontend/src/features/tradingAccount/TradingAccountContext.test.ts](../../frontend/src/features/tradingAccount/TradingAccountContext.test.ts) | 기존 검증 유지 + 새 조건/잠금/표시/경계 회귀 |
| [frontend/src/features/tradingAccount/TradingAccountContext.tsx](../../frontend/src/features/tradingAccount/TradingAccountContext.tsx) | cutoff/계정 목록 갱신·선택/캐시 복귀 |
| [frontend/src/features/tradingAccount/api.ts](../../frontend/src/features/tradingAccount/api.ts) | 기존 DTO/선택 모델에 선택 표시 metadata 전달 |
| [frontend/src/features/tradingAccount/capabilities.test.ts](../../frontend/src/features/tradingAccount/capabilities.test.ts) | 기존 검증 유지 + 새 조건/잠금/표시/경계 회귀 |
| [frontend/src/features/tradingAccount/capabilities.ts](../../frontend/src/features/tradingAccount/capabilities.ts) | cutoff/계정 목록 갱신·선택/캐시 복귀 |
| [frontend/src/features/tradingAccount/modeSelection.ts](../../frontend/src/features/tradingAccount/modeSelection.ts) | 기존 DTO/선택 모델에 선택 표시 metadata 전달 |
| [frontend/src/models/dto/home.ts](../../frontend/src/models/dto/home.ts) | 기존 DTO/선택 모델에 선택 표시 metadata 전달 |
| [frontend/src/models/dto/season.ts](../../frontend/src/models/dto/season.ts) | 기존 DTO/선택 모델에 선택 표시 metadata 전달 |
| [frontend/src/screens/entry/ModeSelectionScreen.tsx](../../frontend/src/screens/entry/ModeSelectionScreen.tsx) | 기존 시즌 제목에 공통 beta 표시 |
| [frontend/src/screens/home/homeHeader.test.ts](../../frontend/src/screens/home/homeHeader.test.ts) | 기존 검증 유지 + 새 조건/잠금/표시/경계 회귀 |
| [frontend/src/screens/my/SeasonBadgeCard.tsx](../../frontend/src/screens/my/SeasonBadgeCard.tsx) | 기존 시즌 제목에 공통 beta 표시 |
| [frontend/src/screens/ranking/UserSeasonSummaryScreen.tsx](../../frontend/src/screens/ranking/UserSeasonSummaryScreen.tsx) | 기존 시즌 제목에 공통 beta 표시 |
| [frontend/src/screens/record/RecordProfitAnalysisScreen.tsx](../../frontend/src/screens/record/RecordProfitAnalysisScreen.tsx) | 기존 시즌 제목에 공통 beta 표시 |
| [frontend/src/screens/record/RecordSeasonDetailScreen.tsx](../../frontend/src/screens/record/RecordSeasonDetailScreen.tsx) | 기존 시즌 제목에 공통 beta 표시 |
| [frontend/src/screens/record/RecordSeasonListScreen.tsx](../../frontend/src/screens/record/RecordSeasonListScreen.tsx) | 기존 시즌 제목에 공통 beta 표시 |
| [frontend/src/screens/season/SeasonFinalResultScreen.tsx](../../frontend/src/screens/season/SeasonFinalResultScreen.tsx) | 기존 시즌 제목에 공통 beta 표시 |
| [frontend/src/screens/season/SeasonJoinScreen.tsx](../../frontend/src/screens/season/SeasonJoinScreen.tsx) | 기존 시즌 제목에 공통 beta 표시 |

모든 tracked diff와 신규 운영 코드/SQL/테스트를 자체 검토했다. 생성물은 Prisma 재생성과 동일함을 확인했다. 금융 수식/엔진/기존 정산 자격 계산, 사용자 데이터 초기화, 새로운 관리자 웹/API/스케줄러, production seed/운영 쓰기를 추가하지 않았다. 실제 catalog의 대상 간 FK 90개로 삭제 순서를 점검했다. 이 중 보상/지급 요청의 nullable 양방향 FK 2개는 대상 시즌 포인터만 명시 해제하고, 나머지 관계는 자식 우선 삭제한다. 실제 양방향 fixture와 processing/과거 처리 흔적의 거부, 전체 롤백을 로컬에서 검증했다. catalog 변경으로 순서가 어긋나면 dry-run부터 거부한다. 테스트 assertion에서 복잡한 React 객체를 actual로 직접 비교하지 않았고, 실패 시 대형 객체를 출력할 경로를 새로 만들지 않았다.
