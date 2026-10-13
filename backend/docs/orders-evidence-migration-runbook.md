# Orders 종가 증거 CHECK Migration 잠금 검증과 적용 경로

대상은 `20261013120000_add_conditional_sell_and_loc_sell`이다. 이 문서는
운영 Migration 실행을 승인하지 않는다. 최초 검증 당시 운영·공유 DB 적용 상태는
`UNKNOWN`이었다. 아래 PR #5 후속 조회에서 확인한 두 Render DB만 해당 상태를
갱신한다. 확인하지 않은 환경은 `UNKNOWN`이며 CI 적용 결과는 운영 적용 증거가 아니다.

## 잠금과 무결성

원본 SQL은 하나의 `BEGIN`–`COMMIT`에서 CHECK를 DROP하고, 완화한 CHECK를
`NOT VALID`로 ADD한 뒤 VALIDATE한다. DROP/ADD의 `ACCESS EXCLUSIVE` 잠금은
COMMIT까지 유지되므로 검증 스캔 중에도 일반 SELECT/INSERT/UPDATE가 대기한다.
원본의 `validated without blocking writes` 주석은 이 트랜잭션 범위에서는
맞지 않는다. 파일 불변성을 위해 주석도 기존 Migration 안에서 고치지 않는다.

`NOT VALID`는 기존 행 스캔만 생략하며 새 INSERT/UPDATE에는 즉시 적용된다.
검증을 별도 트랜잭션으로 실행하면 `SHARE UPDATE EXCLUSIVE`를 사용하여
일반 조회와 쓰기를 허용한다. 같은 트랜잭션에서 DROP/ADD를 커밋한 뒤 검증하는
후보안은 다른 세션에 제약조건 없는 쓰기 구간을 노출하지 않는다. CHECK는 기존
BUY 전용 조건에서 `side = 'buy'`만 제거한다. limit 주문 및 종가 증거와
snapshot/candle 링크의 상호 배타성은 유지한다.

근거: [PostgreSQL 16 ALTER TABLE](https://www.postgresql.org/docs/16/sql-altertable.html),
[PostgreSQL 16 잠금](https://www.postgresql.org/docs/16/explicit-locking.html).

## 환경별 판단

| 환경 상태 | 대응 |
|---|---|
| 영속 DB 적용 완료, 체크섬 일치 | 원본 보존. 완료된 검증에 후속 Migration을 추가해도 과거 잠금은 되돌릴 수 없다. |
| 모든 영속 환경에서 미적용임을 확인 | 배포 책임자와 파일 변경 가능 여부를 결정한 후 DDL 커밋과 VALIDATE를 분리한 새 배포안을 검토한다. 전체 Migration의 다른 DDL/FK 잠금도 함께 검토한다. |
| 일부만 적용 또는 적용 상태 UNKNOWN | 기존 파일 수정·대체 자동 배포를 보류한다. 미적용 환경의 원본 잠금 위험은 남는다. |
| 원본을 유지해야 하는 미적용 DB | 승인된 유지보수 구간에 쓰기/조회 중단 영향을 수용하고 적용하는 경로를 검토한다. 실제 배포 세션의 lock/statement timeout, 복구·재시도와 트랜잭션 완료 여부를 확인한다. |
| 실패·진행 중·체크섬 불일치 | 일반 배포를 중지하고 실제 DDL·Migration 상태를 조사한다. 임의 history 수정이나 `migrate resolve`로 숨기지 않는다. |

후속 Migration만 추가해도 미적용 DB는 먼저 원본을 실행하므로 잠금 위험이
해결되지 않는다. 원본 SHA-256은
`0d859c88f7dd82102c39b151536ac0fc664237dbb659cf07e3914c99b16bb1ac`다.
`_prisma_migrations`의 이름·checksum·finished_at·rolled_back_at을 해당 환경의
책임자가 읽기 전용으로 대조해야 한다. Prisma deploy/status의 성공만으로
파일 체크섬 일치를 주장하지 않는다.
[Prisma Migration history](https://www.prisma.io/docs/orm/v7/prisma-migrate/understanding-prisma-migrate/migration-histories).

원본 변경이 안전한 미적용 환경만 존재한다는 증거가 없는 현재 경로는 **PARTIAL**이다. 원본
Migration과 Prisma Schema를 그대로 보존하고, 분리 후보는 격리 테스트에서만
실행한다. 신규 DB 및 원본 업그레이드의 최종 Schema는 기존 계약과 같다.

## 격리 PostgreSQL 16에서 재현

새로운 전용 로컬 PostgreSQL 16 DB를 사용한다. DB 이름은
`safety_migration_worker_`로 시작해야 한다. 기존 개발 DB도 공유하지 않는다.
DB 세션 TimeZone은 UTC로 설정한다. Prisma 7 pg adapter가 읽는 DB 시각과
Node 시각이 일치하는지 먼저 확인한다. 기존 금융 race 테스트는 약 2.5초의
의도적인 잠금 대기를 사용하므로 예를 들어 lock_timeout 10초,
statement_timeout 30초 및 프로세스 전체 timeout을 사용한다. 잠금 재현
runner는 두 연결에 lock_timeout 150ms, statement_timeout 3초,
idle_in_transaction_session_timeout 10초를 별도로 적용한다.

`backend/`에서 명시적으로 `NODE_ENV=test`, 전용 `DATABASE_URL`을 설정한 후:

```sh
pnpm exec prisma migrate deploy
pnpm exec prisma migrate status
pnpm exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
ORDERS_EVIDENCE_LOCK_DB_INTEGRATION=1 pnpm run integration:orders-evidence-lock
FUTURES_DB_INTEGRATION=1 CONDITIONAL_WORKER_SCAN_DB_INTEGRATION=1 pnpm run integration:conditional-worker-scan
```

잠금 runner는 원본 SQL에서 CHECK 표현식을 추출해 전용 probe schema에서
테스트한다. 실제 검증 직후 트랜잭션을 열어 둔 상태의 보유 잠금과 별도 세션
접근을 관찰한다. 큰 테이블의 실제 스캔 시간 측정은 아니다. 정상/비정상
INSERT·UPDATE, DDL 중 쓰기 차단, NOT VALID 기간의 무결성, 분리안의 최종 CHECK
정의 동일성 및 모든 실제 Migration 파일의 체크섬을 검증한다. probe schema는
종료 시 삭제하며 public 금융 테이블이나 Migration 이력을 변경하지 않는다.

Worker runner는 BUY/SELL 각 100·101·500개 합성 watch를 계정당 최대 20개로
분산한다. 중앙 수집 증거 형식의 fresh fixture와 실제 PostgreSQL 조회·lease·
평가 서비스를 사용한다. 발동하지 않는 watch만 대상으로 하며 금융 서비스
호출이 생기면 실패한다. 첫 tick부터 1초 간격으로 직접 호출한 순회시간,
배치시간, 고유 ID 누락·중복·오류를 기록한다. 서버 timer의 첫 1초 대기는
포함하지 않는다. timer 주기·중첩 실행·lease 중단/재시도는 단위 테스트로
추가 확인한다. 특정 SLA 판정이나 운영 용량 추정에는 사용하지 않는다.

금융 체결은 기존 `conditional-buy-orders-integration.ts`와
`conditional-sell-orders-integration.ts`의 opt-in 경로로 별도 검증한다.
추가한 16건 시장가/지정가 사례는 두 Worker와 직접 평가를 동시에 시작하고,
replay·재시작 후 주문/원장/현금/예약/보유수량을 검사한다. SELL은 10개 보유에
16개 watch가 발동해도 총매도·예약이 보유수량을 초과하지 않아야 한다.
테스트 후 전용 DB/클러스터를 삭제한다. 외부 거래 API·Redis·운영 DB는 필요 없다.

## PR #5 후속 조회와 판단 (2026-10-13)

작업 브랜치는 `codex/migration-worker-safety-20261013`이며 시작 HEAD는
`29e896d92ec7c645654bd7e232f8786e82d208eb`이다. 기존 Worktree
`/tmp/trading-migration-worker-safety`를 재사용했다. 모든 변경은 추가 커밋으로
게시하며 main/다른 Worktree/기존 커밋을 변경하지 않는다.

사용자가 지정한 Render `league of trading` Workspace의 두 DB에서 읽기 전용
도구로 `_prisma_migrations`, 시스템 카탈로그와 CHECK 정의만 조회했다. 사용자
금융 행·인증 정보·환경변수 값은 조회하지 않았으며 Migration/설정/배포를 실행하지 않았다.

| 확인 대상 | 실제 상태 | 판단 |
|---|---|---|
| 관리 DB `dpg-da7ac0e1egvs73e2sv20-a` (PostgreSQL 17.11) | 74개 완료 이력 모두 로컬 파일 체크섬과 일치, 미완료·rollback 이력 없음. 대상은 2026-10-13 07:30:05.503438Z에 시작해 07:30:05.610089Z에 완료. 대상 CHECK와 기존 executed/unfilled CHECK가 validated이며 LOC BUY/SELL의 종가 증거 배타성 유지 | **APPLIED / 이력·CHECK PASS**. 완료된 과거 잠금을 소급 수정하지 않는다. 추가 Migration 불필요 |
| upgrade clone `dpg-dattqaou01pc73agrsr0-a` (PostgreSQL 17.11) | 55개 완료 이력 모두 체크섬 일치, 미완료·rollback 이력 없음. 19개 미적용이며 대상 이력·Conditional SELL 테이블·종가 증거 CHECK 없음 | **UNAPPLIED**. 원본을 실행하는 업그레이드에는 기존 잠금 위험이 남음 |
| 조회 범위 밖의 영속 DB/논리 DB | 목록에 없는 환경과 각 서비스의 실제 DATABASE_URL 연결 관계는 확인하지 않음 | **UNKNOWN**. 모든 영속 환경을 확인했다고 주장하지 않음 |
| 조회한 두 DB의 실패·진행 중·체크섬 불일치 | 해당 이력 없음 | 발견되지 않음. 다른 환경까지 정상으로 일반화하지 않음 |

Render 서비스 `trading_app`의 조회된 live 배포는
`cf21e6884c749124fcb5360cc96c7994213dd7f5`이며 main 브랜치의 build command에
`prisma migrate deploy`가 들어 있다. 이 배포 정보만으로 어느 DB에 연결됐는지
추정하지 않고 위 DB별 직접 조회 결과를 사용한다. 이력의 시작/완료 간격은
운영 요청이 차단된 시간이나 대용량 스캔 성능 측정값이 아니다.

이미 적용된 DB가 확인됐으므로 원본 파일·주석·체크섬·Prisma Schema·Migration
이력을 보존한다. 후속 Migration으로 과거 잠금이 제거됐다고 표현하지 않는다.
미적용 clone의 업그레이드 및 신규 설치는 원본을 실행하므로 전체 판단은
**PARTIAL**이다. 원본을 유지한 신규/업그레이드 최종 Schema 검증은 기존 결과를
재사용하고 새 격리 PostgreSQL 16에서도 deploy/status/diff와 CHECK 잠금 검사를
확인한다. clone/운영 DB의 실제 업그레이드는 이번 작업에 포함되지 않는다.

미적용 환경을 배포하기 전 책임자는 실제 연결 DB와 이력을 확인하고, 영향을
수용할 유지보수 구간·트래픽 관리·timeout·백업/복구·재시도 기준을 정한다.
이 Migration뿐 아니라 앞선 미적용 Migration의 DDL/FK/검증도 함께 평가한다.
실패/진행 중/불일치가 있으면 자동 재시도를 멈추고 실제 DDL과 이력을 조사한다.
임의 `migrate resolve`·수동 이력 조작·검증 생략은 대응안이 아니다.

## BUY 지정가 16건: 조사 범위와 남은 한계

최초 실패 로그는 1/16이라는 건수만 남겼으며 당시 watch 상태/실패 코드/가격
증거/clock 경계는 보존되지 않았다. 원본 격리 PostgreSQL 로그의 해당 시각에는
lease key의 unique 경합이 보이지만 이는 정상적인 lease 패자 처리와 일치한다.
그 로그만으로 최초 실패 원인이나 모든 금융 잠금 대기를 입증할 수 없다.

- Worker는 live watch를 조회하고 전역 lease를 얻은 뒤 순차 평가한다. 직접
  `evaluate()`는 그 lease를 사용하지 않으므로 두 경로의 같은 watch 경합은
  account/lifecycle fence와 watch row lock으로 조정된다.
- trigger는 DB `clock_timestamp()`로 기록한 뒤 트랜잭션을 끝내고 기존
  quote→create를 호출한다. create가 account/watch를 다시 잠그고 등록 의도와
  30초 경계를 검사하며, 주문과 watch 링크를 같은 트랜잭션에 기록한다.
  마지막 경계 검사 실패는 주문/예약/원장을 함께 rollback한다.
- deterministic idempotency key와 unique/FK는 재실행의 중복 주문을 막는다.
  경합에서 패한 호출의 `CONDITIONAL_BUY_CHANGED`가 있더라도 watch가 이미
  `ordered`면 실패 기록이 그 성공을 덮어쓰지 않는다.
- crypto의 조건 발동은 등록 이후의 적격 Spot 가격을 요구한다. stale/future
  증거 또는 Node/DB 시각 차이·시각 역행은 후보지만 최초 기록으로 입증되지
  않았다. 지정가 주문 등록은 limit/fee/가용 현금 예약 코어를 사용하며,
  시장가 체결의 Spot 가격 선택과 구분한다. USD quote의 FX 증거도 별도 확인한다.
- quote/create 경합, 금융 transaction 오류·timeout, 가용 현금 실패, 30초 초과,
  fixture/조회 범위 문제도 조사했다. 최초 조회는 account의 전체 주문을 읽었고
  생성된 fixture의 정상자금으로 16건을 예약할 수 있다. 현재 코드/회귀로
  실패 가설을 구분하지만 당시 상태가 없으므로 하나로 확정하지 않는다.

기존 16건 테스트의 금융 단언은 그대로 유지하며 진단만 추가했다. 두 Worker,
직접 평가, replay의 반환 상태와 watch별 상태·실패 코드·종료 사유·attempt 수·
등록/증거/발동/시도 경과·일반 주문 상태를 작은 문자열로 기록한다. account/order
ID, 가격, 현금, 인증 정보나 큰 Prisma 객체는 출력하지 않는다. 성공한 watch의
상태와 단순 평가 반환 코드를 구분하며, 정상 `submitted` 주문을 `executed`로
잘못 해석하지 않는다.

후속 격리 재현은 기존 16건 지정가 사례를 3회만 실행하고 기존 전체 BUY 회귀의
동일 사례를 추가로 확인한다. 별도 대규모 부하나 500건 측정을 추가하지 않는다.
전체 자식 프로세스 그룹의 RSS와 경과시간을 제한하며 실패 시 원인·종료·정리를
먼저 확인한다. 실제 실행 결과와 이전 결과/게시 상태는
`backend/test/results/20261013-migration-worker-safety.json`의 후속 기록을 따른다.
비재현과 금융 단언 통과만으로 최초 원인까지 해결됐다고 주장하지 않는다.

## 이후 Migration과의 적용 순서 (2026-10-14)

통합 브랜치에는 이 Migration 뒤에 `20261013200000_add_long_range_four_hour_candles`가
있다(로컬 Migration 75개). 위 관리 DB의 74개 이력 대조는 당시 기록이며 갱신하지 않는다.

- 미적용 DB의 `migrate deploy`는 이 Migration을 먼저, 4시간봉 Migration을 다음에 실행한다.
  잠금 위험이 큰 쪽은 명시적 `BEGIN`–`COMMIT`으로 `orders`의 ACCESS EXCLUSIVE를 VALIDATE까지
  유지하는 이 Migration이다.
- 격리 PostgreSQL 16에서 Prisma 7.6이 Migration 파일의 각 문장을 별도 트랜잭션으로 실행하고,
  명시적 `BEGIN`–`COMMIT` 블록은 하나의 트랜잭션으로 유지함을 `txid_current()` 비교로 확인했다.
  따라서 이 문서의 잠금 판단은 그대로 유효하다. 명시적 트랜잭션이 없는 4시간봉 Migration의
  VALIDATE는 SHARE UPDATE EXCLUSIVE만 사용하며, 600만 행 사본에서 조회·쓰기 지연은 5ms 이하였다.
  잠금 대기 상한, 중간 실패 복구와 Render 배포 조건은 `long-range-4h-candles.md`의
  "Applying the migration"을 따른다.
- `integration:orders-evidence-lock`은 `_prisma_migrations` 행 수와 Migration 디렉터리 수가
  같아야 하므로, 4시간봉 Migration까지 배포한 격리 DB에서 실행한다(75개로 통과, 2026-10-13).
