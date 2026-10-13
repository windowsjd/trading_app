# Orders 종가 증거 CHECK Migration 잠금 검증과 적용 경로

대상은 `20261013120000_add_conditional_sell_and_loc_sell`이다. 이 문서는
운영 Migration 실행을 승인하지 않는다. 운영·공유 DB 적용 상태는 소유자가
확인하기 전까지 `UNKNOWN`으로 취급한다. CI 적용 결과는 운영 적용 증거가 아니다.

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

파일 변경을 승인할 충분한 증거가 없는 현재 경로는 **PARTIAL**이다. 원본
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
