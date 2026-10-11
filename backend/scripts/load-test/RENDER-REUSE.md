# 기존 Render API/PostgreSQL 재사용 절차

이 문서는 준비한 절차다. 이번 코드 작업에서는 실제 환경변수, DB/Valkey, 배포 상태를 변경하지 않는다. 아래 서버 작업은 전환 승인 후 사용자가 수행한다. 계정 생성과 smoke/baseline 실행은 별도의 실행 승인이 필요하다.

## 대상과 승인

| 용도 | 허용 대상 |
| --- | --- |
| 기존 API | `srv-da84cg8u01pc73cjasa0`, `https://trading-app-qtsw.onrender.com` |
| 기존 PostgreSQL 인스턴스 | `dpg-da7ac0e1egvs73e2sv20-a` |
| 테스트 DB / 역할 | `trading_class_loadtest` / `load_test_trading_class` |
| 보존할 개발 DB | `trading_app_fbbk` |
| Valkey | 기존 `red-da7alead0e5s73dusbs0` 재사용 금지, 별도 테스트 인스턴스 DB 0 |
| 부하 발생기 | 별도 Linux 클라우드 머신, 외부 observer URL 사용 |

리소스 ID는 자동으로 발견하거나 확장하지 않는다. 현재 Dashboard에서 같은 리소스인지 확인한다. 복제 PostgreSQL 인스턴스나 다른 API로 바뀌었다면 임의로 보호 목록을 지우지 않고 계획을 다시 검토한다.

2026-10-12 읽기 전용 조회 결과: API는 `main` 자동 배포가 켜진 1개 인스턴스이고, 현재 live SHA는 `cb95846904d7d32fa237cac35e0b91a52fa4076d`다. 최신 build 로그(2026-10-11 15:15 UTC)의 Prisma datasource는 `trading_app_fbbk`다. PG는 PostgreSQL 17 / `0.5c-1g` / 5GB이며 **`trading_class_loadtest`도 이미 존재**한다. 두 DB 소유자는 `trading_app_fbbk_user`, ACL은 기본값(`NULL`)이고 `load_test_trading_class` 역할은 없다. 테스트 DB 내부의 테이블·데이터 상태는 이번 connector 조회로 확인하지 않았으므로 빈 DB라고 가정하지 않는다. 기존 Valkey는 `256mb`, Valkey 8.1.4, `noeviction`, journal+snapshot이다. 환경변수 값은 조회하지 않았으며 DB 대상은 실제 build 로그로 확인했다.

기존 `template --smoke`를 만들어 target을 위 값으로 바꾼 뒤 다음 필드를 추가한다. 처음에는 모든 승인을 false로 유지한다. 실제 승인과 복구 설정 보관, 기존 API의 독점 전환 확인을 마친 후에만 해당 값을 true로 바꾼다.

```json
{
  "renderReuse": {
    "transitionApproved": false,
    "restorePlanRecorded": false,
    "exclusiveApiServiceConfirmed": false
  },
  "cloudExecutionApproved": false
}
```

`renderReuse`가 없거나 하나라도 true가 아니면 기존 리소스 접근을 거절한다. API/DB ID, API origin, PG 호스트, DB와 역할도 모두 일치해야 한다. 허용 PG 호스트는 위 ID의 내부 호스트 또는 `.singapore-postgres.render.com` 외부 호스트뿐이다. 외부 PG URL은 `sslmode=require`를 사용한다. 외부 Valkey는 인증된 `rediss://` URL을 사용한다. API와 generator의 manifest는 동일하고 credentials만 내부/외부 observer URL을 함께 담는다. 자격증명 파일은 Git 밖에서 mode 0600으로 보관한다.

`cloudExecutionApproved=false`에서도 승인된 `migrate`, `serve`, `guard`, `audit`는 가능하지만 `prepare`, `run`은 거절한다. 서버의 승인 값 변경도 manifest identity를 바꾸므로, 실행 승인을 받은 manifest로 서버를 다시 시작하고 identity를 재검증해야 한다. 이번 단계에서는 이 명령을 실제 서버에서 실행하지 않는다.

## DB 역할과 권한: 사용자 수행 예시

[Render는 동일 PostgreSQL 인스턴스 안의 추가 DB를 지원한다](https://render.com/docs/postgresql-creating-connecting#adding-multiple-databases-to-a-single-instance). 기존 기본 계정의 URL에서 DB 이름만 바꾸는 방식은 사용하지 않는다. 새로운 로그인 역할을 만들고 테스트 DB만 소유하게 한다. migration과 런타임은 이 테스트 역할을 사용한다. 기존 역할의 비밀번호/소유권은 변경하지 않는다.

먼저 관리자 세션에서 `SELECT current_database(), current_user;`와 `pg_database`, `pg_roles`, `pg_auth_members`, 기존 DB ACL을 읽어 호스트·역할·기존 연결 사용자를 기록한다. 테스트 DB로도 별도로 연결해 스키마·테이블 소유자·users·migration 이력·DB comment를 읽는다. 이미 있는 DB를 삭제/재생성하지 않는다. 아래 SQL은 운영자가 검토하고 실행할 예시이며 자동 실행 파일이 아니다.

```sql
-- 먼저 기존 테스트 DB에 원래 관리자 역할로 연결하고 대상 결과를 확인.
-- \connect trading_class_loadtest trading_app_fbbk_user
SELECT current_database(), current_user;
-- 결과가 trading_class_loadtest / trading_app_fbbk_user일 때만 다음 진행.
-- 비밀번호는 psql의 \password로 대화형 입력한다.
CREATE ROLE load_test_trading_class NOLOGIN NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
-- \password load_test_trading_class
-- 소유권을 이전할 관리자에게만 새 역할의 SET 권한을 잠시 제공한다.
-- 테스트 역할이 개발 역할의 멤버가 되는 역방향 GRANT는 금지.
GRANT load_test_trading_class TO trading_app_fbbk_user WITH INHERIT FALSE, SET TRUE;
-- 현재 이미 존재하는 DB: 데이터 상태와 이력을 검토한 후 소유권만 이전.
ALTER DATABASE trading_class_loadtest OWNER TO load_test_trading_class;
-- 새 owner 권한으로 설정. NOLOGIN 역할에도 관리자의 SET ROLE은 가능.
SET ROLE load_test_trading_class;
ALTER DATABASE trading_class_loadtest SET timezone TO 'UTC';
REVOKE ALL ON DATABASE trading_class_loadtest FROM PUBLIC;
GRANT CONNECT, CREATE, TEMPORARY ON DATABASE trading_class_loadtest
  TO load_test_trading_class;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO load_test_trading_class;
RESET ROLE;
REVOKE load_test_trading_class FROM trading_app_fbbk_user;
```

위 절차는 현재 이미 있는 DB를 위한 것이다. DB가 없다고 별도로 확인된 경우에는 새 역할을 만든 뒤 관리자의 SET ROLE 권한을 보유한 상태에서 `CREATE DATABASE trading_class_loadtest OWNER load_test_trading_class`로 준비하고, 테스트 DB에 연결한 다음 위 owner 설정을 수행한다. 기존 DB에서 CREATE를 시도하거나 재생성하지 않는다.

기존 객체가 있으면 DB owner 변경만으로 테이블 owner가 바뀌지 않는다. 테스트 DB 안의 검토한 객체에 한해서 소유권/권한 이전 계획을 별도로 세운다. `REASSIGN OWNED`를 개발 DB에서 실행하거나 전체 인스턴스에 적용하지 않는다. 기존 test users가 있으면 migrate/preparation은 거절되며 이 작업은 데이터를 지우지 않는다. 비관리자가 DB owner를 바꾸려면 기존 owner의 CREATEDB와 새 역할에 대한 SET ROLE 권한이 필요하다. [PostgreSQL 17 ALTER DATABASE](https://www.postgresql.org/docs/17/sql-alterdatabase.html)를 따른다. 테스트 역할에는 CREATEDB를 부여하지 않는다.

**개발 DB의 CONNECT 차단을 실제로 확인해야 한다.** PostgreSQL의 `PUBLIC` 기본 CONNECT/TEMPORARY 권한은 모든 역할에 적용된다. 테스트 역할에서만 REVOKE해도 PUBLIC 권한을 상쇄하지 못한다. [PostgreSQL 권한 규칙](https://www.postgresql.org/docs/17/ddl-priv.html)에 따라 다음 ACL 전환을 별도로 검토한다. 개발 DB 데이터와 스키마는 건드리지 않지만 ACL은 바뀌므로, 원래 ACL과 정당한 접속 역할 목록을 보관하고 같은 트랜잭션 안에서 그 역할들에 필요한 권한을 먼저 부여한다. 목록을 모르면 여기서 멈춘다.

```sql
BEGIN;
-- 조사된 기존 접속 역할 각각에 필요한 권한만 유지.
GRANT CONNECT, TEMPORARY ON DATABASE trading_app_fbbk TO trading_app_fbbk_user;
-- 다른 정당한 기존 역할이 있으면 각각 추가한다.
REVOKE CONNECT, CREATE, TEMPORARY ON DATABASE trading_app_fbbk FROM PUBLIC;
REVOKE ALL ON DATABASE trading_app_fbbk FROM load_test_trading_class;
COMMIT;
-- 기존 앱 역할의 CONNECT가 여전히 true인지 확인한 뒤 테스트 역할을 활성화.
ALTER ROLE load_test_trading_class LOGIN;
```

역할에 다른 역할 멤버십이나 `pg_monitor`, `pg_read_all_data`, `pg_write_all_data`를 부여하지 않는다. `NOINHERIT`만으로 SET ROLE을 막을 수 없으므로 멤버십 자체를 거절한다. preflight는 실제 서버의 역할 속성, 멤버십, 테스트 DB 소유권, public 스키마 권한, 개발 DB 존재와 CONNECT/CREATE/TEMPORARY 권한 부재, 다른 DB의 CREATE 권한 부재를 확인한다. 잘못된 권한이면 DB comment나 Valkey claim을 쓰기 전에 종료한다.

```sql
-- 테스트 역할/테스트 DB 세션에서 읽기 전용 확인.
SELECT current_database(), current_user;
SELECT has_database_privilege(current_user, 'trading_app_fbbk', 'CONNECT')
  AS dev_connect,
  has_database_privilege(current_user, 'trading_app_fbbk', 'CREATE') AS dev_create,
  has_database_privilege(current_user, 'trading_app_fbbk', 'TEMPORARY') AS dev_temp;
-- 세 결과 모두 false여야 한다. 실제 개발 DB 접속 시도도 거절돼야 한다.
```

외부 접근 allowlist에는 generator의 고정 IP만 추가하고 기존 정상 접근 규칙을 보존한다. 내부 URL은 Render API에서 사용한다. shared PG의 CPU/RAM/디스크/연결 한도는 DB별로 분리되지 않는다. 개발 DB에 다른 정상 프로세스가 계속 접속하면 성능 측정과 가용성에 영향을 줄 수 있으므로 테스트 창에 동시 사용을 중지하거나 별도 승인을 받고 측정 한계를 기록한다. 연결 풀 설정이나 금융 정책은 변경하지 않는다.

## Valkey 판단

기존 인스턴스의 동시 재사용은 허용하지 않는다. 현재 코드의 `candles:live:v1:fanout`, `market:order-book:v1`, provider price/FX 채널, candle cache generation, live candle lease와 Binance REST 제한 상태는 테스트 환경별 namespace가 없다. 테스트 replay가 실제 프로세스의 구독·상태에 섞일 수 있다. [Pub/Sub는 논리 DB 번호로 분리되지 않는다](https://redis.io/docs/latest/develop/pubsub/#database--scoping). prefix를 일부 추가하는 것만으로 전체 격리를 보장할 수 없으며 이번 작업에서 금융/시세 서비스를 재설계하지 않는다.

기존 API를 멈춰도 다른 구독자와 남은 키, 공유 memory/eviction 상태, 복구 시 오염을 배제하기 어렵다. 기존 Valkey는 지우거나 claim하지 않고 복구용으로 보존한다. 별도 테스트 Key Value 인스턴스가 최소 변경이다. 비용 우선이면 [Free 계획의 제약](https://render.com/docs/free#free-key-value)을 검토해 smoke에 사용한다. workspace당 Free 1개 제한이 있으며 이번 inventory에는 기존 유료 `256mb` 1개만 있었다. [한도](https://render.com/docs/compute-plans#all-plans)는 Free 25MB/50 연결, 가장 작은 유료 `256mb`는 256MB/250 연결이다. 현재 코드는 WS 사용자마다 Valkey 연결을 만들지 않고 공유 service와 소수 subscriber를 사용하므로 1,000 WS를 1,000 Valkey 연결로 계산하지 않는다. 실제 메모리/연결 수를 smoke에서 확인한다. 재시작 시 Free 상태가 사라지므로 측정 중 재시작은 INVALID RUN이다. 현재 기존 환경과 같은 용량/지속성으로 비교하려면 별도 `256mb`가 최소 유료 권고안이다. 가격은 [Render 가격표](https://render.com/pricing)에서 실행 시 확인한다. 이 작업은 리소스를 생성하거나 업그레이드하지 않는다.

## Render 전환, build와 migration

이번 읽기 전용 조회에서 확인한 build는 다음과 같다. 실행 전 live Dashboard에서 재확인한다.

```text
rootDir: backend
build: pnpm install --frozen-lockfile && pnpm exec prisma generate && pnpm exec prisma migrate deploy && pnpm build
start: node dist/src/main.js
```

일반 Prisma config는 `process.env > .env.local > .env.development > .env` 순으로 `DATABASE_URL`을 선택한다. 따라서 현재 일반 build의 migrate 대상은 **build 환경에서 최종 선택된 DATABASE_URL**이다. 런타임 `serve`가 URL을 바꾸더라도 먼저 실행된 build migration을 보호할 수 없다. 이번 수정은 일반 config에서 테스트 DB/역할/전환 모드를 감지하면 `generate`를 제외한 일반 Prisma 명령을 거절한다. 일반 `main.js`도 테스트 대상/전환 모드에서 시작을 거절한다.

사용자는 승인된 테스트 창에 다음 순서로 전환한다:

1. 원래 build/start/pre-deploy command, autoDeploy, 스케일(인스턴스 수), 환경변수·env group 연결, 원래 배포 SHA, DB/Valkey URL과 ACL을 비밀 저장소에 보관한다. 모든 DB를 대상으로 한 pre-deploy hook도 확인한다.
2. autoDeploy를 일시 중지하고 일반 API와 같은 서비스의 다른 인스턴스/worker가 종료되도록 **배타적 유지보수 전환**을 한다. Render의 일반 무중단 배포는 구/신 프로세스가 겹칠 수 있으므로 test serve와 일반 프로세스의 중첩을 허용하지 않는다. 필요하면 수동 suspend/resume 절차를 사용자가 승인해 수행한다.
3. DB 역할/ACL과 별도 Valkey를 준비하고, 각 URL을 별도로 확인한다. 환경값은 한 번에 적용할 수 있게 준비하되 자동 배포를 트리거하는 저장 동작을 피한다. test build에는 migration을 포함하지 않는다:

   ```text
   pnpm install --frozen-lockfile && pnpm exec prisma generate && pnpm build
   ```

4. Git 밖의 private manifest/credentials 파일을 API에 공급한다. base64 JSON 등을 env로 보관한다면 셸에서 mode 0600 파일로 안전하게 풀고 로그에 출력하지 않는다. 소스에 비밀 파일을 커밋하지 않는다. 이번 도구는 파일을 자동 업로드하거나 Render secret을 자동 변경하지 않는다.
5. `LOAD_TEST_MODE=render-reuse`, `DATABASE_URL=<테스트 역할의 내부 test DB URL>`, `REDIS_URL=<별도 Valkey 내부 URL>`로 전환하고 아래 start를 설정하되 아직 시작하지 않는다. `RENDER_SERVICE_ID`, `RENDER_GIT_COMMIT`은 Render가 제공한 값이어야 한다. 서버는 manifest API ID/SHA와 ambient DB/Valkey URL까지 검증한 뒤 preflight를 실행한다. 기존 JWT/provider 자격증명은 테스트 프로세스에서 제거한다. 테스트 창의 API 접근은 generator와 승인된 점검자로 제한하고 원래 allowlist를 복구용으로 보관한다.

   ```text
   node dist/scripts/load-test/cli.js serve --manifest /secure/smoke.json --credentials /secure/smoke.credentials.json --out /evidence/server
   ```

6. 서버가 시작되기 **전**에 같은 SHA의 generator checkout 또는 통제된 shell에서 명시적으로 `migrate`를 실행한다. 이 CLI는 URL scope와 실제 DB 권한/UTC/빈 users를 확인한 후에만 전용 Prisma config에 preflight proof를 전달한다. 내부/외부 URL 혼동 없이 동일 observer URL로 검사와 migration을 수행한다. 일반 `.env`, 일반 `DATABASE_URL`, seed, `db push`는 사용하지 않는다.

   ```bash
   node dist/scripts/load-test/cli.js migrate --manifest /secure/smoke.json --credentials /secure/smoke.credentials.json --out /evidence/migrate
   ```

   CLI는 기존 migration의 `deploy`, `status`, `diff --from-config-datasource --to-schema ... --exit-code`를 순서대로 실행한다. drift가 있으면 실패하며 검사 삭제/덮어쓰기를 하지 않는다. 전용 config를 직접 실행하면 preflight proof가 없어서 거절한다. migration은 API build/restart와 분리된 사용자 승인 작업이다.

7. 서버를 테스트 entry로 시작한 뒤 `/health`의 HMAC identity와 `guard`를 확인한다. generator는 공개 API + 외부 TLS observer URLs만 사용한다. 테스트 서버의 network guard는 허용 DB/Valkey 외 연결을 차단하고 provider replay는 기존 parser/저장/금융 검증을 사용한다. 건강 확인만으로 준비/부하 실행 승인을 대신하지 않는다.
8. 별도 실행 승인 전에는 `cloudExecutionApproved=false`를 유지하고 계정을 생성하지 않는다. 승인을 받은 뒤 API와 generator의 manifest를 동일하게 갱신하고, smoke의 준비/실행/금융 audit를 먼저 수행한다. baseline은 새 빈 금융 데이터셋이 필요하다. 현재 고정 test DB에 smoke 이력이 있으면 이 도구가 삭제/초기화하지 않으며, 보존/재준비 방식을 별도 승인 없이 진행하지 않는다.

Render 파일시스템의 `/evidence` 경로는 예시다. 쓰기 가능한 경로를 사용하고 종료 전에 외부로 증거를 보관한다. ephemeral filesystem은 복구 후 증거를 보존하지 않는다. push가 필요한 경우 `[skip render]`를 사용해 승인 없는 자동 배포를 피한다.

## 복구

1. generator와 test serve를 종료하고 HTTP/WS/process 종료 및 테스트 DB 접속 종료를 확인한다. 증거를 export한다. 테스트 DB/Valkey를 삭제하거나 flush하지 않는다.
2. 원래 내부 DB URL(정확히 `trading_app_fbbk`와 원래 역할), 원래 Valkey URL, JWT/provider/flag/env group 설정과 일반 start를 복구한다. `LOAD_TEST_MODE`와 테스트 secret/file 주입 항목을 제거한다. 테스트 역할은 필요하면 NOLOGIN으로 잠그되 기존 역할은 변경하지 않는다.
3. 원래 역할의 읽기 전용 `SELECT current_database(), current_user;`로 복구 대상을 확인하고, CONNECT와 기존 ACL이 정상인지 확인한다. 원래 env에서 `prisma migrate status`를 조회해 차이를 검토한다. test DB 변경을 dev DB에 복제하지 않는다.
4. 처음 복구 build에는 migration을 넣지 않고 검증한 원래 SHA/일반 entry로 시작한다. test identity 헤더가 없어야 하며 정상 auth/HTTP/WS와 데이터 보존을 확인한다. 원래 build의 migration 부분을 복구하기 전에는 원래 DB에 pending migration이 있는지 검토하고 별도 승인받는다. 데이터 보존을 위해 pending migration을 자동 적용하지 않는다.
5. 개발 DB PUBLIC ACL을 원래 상태로 되돌려야 한다면 test 역할 NOLOGIN과 기존 테스트 세션 종료를 먼저 확인한 뒤 저장한 정확한 ACL로 복구한다. 테스트 역할 LOGIN을 유지하면서 PUBLIC CONNECT를 복구하면 격리가 깨지므로 이후 harness preflight가 거절한다.
6. 원래 스케일/pre-deploy/autoDeploy 설정을 복구한다. 정상 환경의 보호 설정이나 금융 정책을 완화하지 않는다.

## 현재 작업에서 확인할 범위

단위 테스트는 네트워크/Prisma 실행을 mock하고 잘못된 DB/역할/호스트/URL override, 불완전 승인, 잘못된 Render runtime identity, 개발 DB 접근 권한, 위험한 역할 속성/멤버십, 일반 build/start 오사용을 거절하는지 확인한다. 정상 local/dedicated 경로와 승인된 reuse 경로도 검증한다. 실제 migration, Render 전환, 계정 생성, cloud smoke/baseline은 이 준비 단계의 검증 결과에 포함하지 않는다.

2026-10-12 검증 결과: `pnpm run test:load-test` 2 suites / 99 tests 통과, 기존 `env-validation` / `load-runtime-env` 2 suites / 24 tests 통과, `pnpm run typecheck`, `pnpm run build`, 변경 TS 파일 Prettier check와 `git diff --check` 통과. 역할 격리 SELECT의 문법도 기존 DB의 읽기 전용 transaction으로 확인했다. 서버는 migration 전 users 테이블이 없는 상태에서 claim/시작을 거절한다. 실제 Prisma 프로세스/migration은 단위 테스트에서 mock했으며 Render 환경변수·배포·DB/Valkey 데이터는 변경하지 않았다.
