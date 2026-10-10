# 격리 재현 절차

운영 `.env.local`은 사용하지 않는다. 모든 쓰기 스크립트는 `NODE_ENV=test`,
명시적 loopback DB/Redis, DB 이름 `_test`를 요구한다. 스크립트마다 **새 DB**를
사용한다. 금융 게이트·core 게이트·보존 테스트는 서로 DB를 공유하지 않는다.
Redis 예산 fixture는 실수집과 다른 Redis DB 번호를 사용한다.

안정적인 UTC Linux, Node 24, backend pnpm 10.33.0, PostgreSQL 16,
Redis 7을 사용한다. frontend는 npm이다. 현재 WSL에서는 시계 역행을 기록하며
실행했으므로 안정성 합격 환경으로 사용할 수 없다. 테스트를 가짜 시계로
통과시키거나 가격 허용 시간을 늘리지 않는다.

## 준비

CI와 같이 독립 PG/Redis를 준비한다. 예시 포트는 이 작업의 localhost 전용
포트다. 컨테이너도 사용할 수 있으며 기존 운영 DB를 복제하지 않는다.

```bash
docker run -d --name futures-followup-pg \
  -e POSTGRES_USER=futures_test -e POSTGRES_PASSWORD=fixture-only \
  -e POSTGRES_DB=futures_safety_test -e TZ=UTC \
  -p 127.0.0.1:55439:5432 postgres:16 \
  -c shared_preload_libraries=pg_stat_statements
docker run -d --name futures-followup-redis \
  -p 127.0.0.1:56389:6379 redis:7
export DATABASE_URL=postgresql://futures_test:fixture-only@127.0.0.1:55439/futures_safety_test
export REDIS_URL=redis://127.0.0.1:56389/0 NODE_ENV=test
cd backend
pnpm install --frozen-lockfile
pnpm exec prisma generate
pnpm exec prisma migrate deploy
pnpm exec prisma migrate status
pnpm exec prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --exit-code
```

현재 작업에서는 Docker 대신 `/tmp`에 추출한 PG16.15/Redis7 바이너리를
사용했다. PG timezone UTC, fsync/synchronous_commit on, shared_buffers 128MB.
LLVM 라이브러리가 없는 추출본에서 JIT가 실패하여 대량 보존 검증 DB에만
`ALTER DATABASE ... SET jit=off`를 적용했다. 완전한 PG 배포판에는 불필요하다.
추출본의 데이터/소켓: `/tmp/futures-followup-pg/{data,socket}`,
Redis 작업 디렉터리: `/tmp/futures-followup-redis`.

## 필수 검사와 실 DB 안전성

```bash
pnpm run typecheck
pnpm run build
pnpm run lint:accounts:check
pnpm exec jest --runInBand
pnpm run test:e2e --runInBand
node ../scripts/diagnostic-enforcement.cjs backend
FUTURES_PRICE_SAFETY_DB_INTEGRATION=1 \
  pnpm exec jest --runInBand --runTestsByPath src/futures/futures-price-safety.integration.spec.ts
```

새 DB에서 200만 행 검증을 별도로 실행한다. `RETENTION_TEST_ROWS=2000000`
및 `SAFETY_REPORT=/absolute/path.json`을 추가한다. EXPLAIN ANALYZE도 실제
1,000행을 삭제하고 전체 삭제 수에 포함한다. 실제 execution/trigger/pin
불변성, 양방향 FK 경합, 동시 SKIP LOCKED, 다중 worker lease, 실패 후 재실행,
종료 시즌 readiness를 함께 검사한다. 기존 22 금융/22 core 게이트는 각각
`run-financial-gate.sh`, `run-core-gate.sh`에 CI 명령을 그대로 보존했다.
`FINANCIAL_GATE_JSON`/`CORE_GATE_JSON`을 절대 경로로 지정한다.

`run-bounded.py REPORT.json SECONDS RSS_MIB -- COMMAND ...`은 프로세스 그룹
전체 메모리/시간을 제한하고 clock step과 로그를 보존한다. 이상 종료 시
기존 프로세스 종료와 실패 원인을 먼저 확인한다. sandbox의 Node 자식
프로세스 제한으로 EPERM 또는 내부 테스트 누락이 발생하면 정상 실행
환경에서 검증한다. 파일 개수만 표시한 Node test 성공을 인정하지 않는다.

frontend는 `cd frontend && npm run check`; 실제 개별 테스트 결과를 확인한다.
현재 `f512dab0`에는 2,120개가 있으며 파일/suite 개수와 구분한다.
변경 테스트는 객체 자체의 존재 비교를 피하고 boolean/ID/개수로 단언한다.

## 조회 API 실측

새 `futures_perf_test` DB를 migrate하고 `CREATE EXTENSION pg_stat_statements`
후 실행한다. 스크립트가 사용한 테스트 데이터를 정리하므로 전용 DB가 필요하다.

```bash
BENCH_REPORT=/absolute/path/api.json BENCH_ACCOUNTS=50 \
  FUTURES_DB_INTEGRATION=1 pnpm exec tsx scripts/futures-read-api-benchmark.ts
```

23개 상품, 계정당 2개 Cross 포지션, 실제 Nest HTTP/서비스/PG, fixture 인증,
Last/Mark/FX 1초 갱신, C=1/10/50 각각 12초, 절반 catalog/절반 positions.
JWT 검증·인터넷 RTT·전체 서비스 다른 API 비용은 포함하지 않는다.
closed-loop 처리량은 실제 10,000 사용자 도착 부하 시험과 다르다.
쿼리 수에는 Prisma relation reads와 transaction statement도 포함한다.
원본 SQL 집계와 Node/PG CPU·RSS·연결·오류·가격 누락은 JSON에 남는다.

## 실수집 및 24시간

새 `futures_soak_test` DB에서 다음을 실행한다. 공개 Binance market data만
호출한다. 실제 거래소 주문/계정 endpoint는 사용하지 않는다.

```bash
SOAK_SECONDS=300 SOAK_REPORT=/absolute/path/soak-short.json \
  FUTURES_DB_INTEGRATION=1 pnpm exec tsx scripts/futures-collection-soak.ts
# 사용자 systemd 세션과 PG/Redis가 24시간 유지되는 환경에서:
bash ../docs/investigations/2026-10-10-futures-last-price-followup/reproduction/start-soak-24h.sh
systemctl --user show trading-futures-soak-followup-24h -p ActiveState -p SubState -p ExecMainStatus
```

24시간은 monotonic elapsed >=86,400초를 요구한다. RUNNING/INTERRUPTED/FAIL은
PASS가 아니다. `.samples.jsonl`은 10초마다 종목별 Last/Mark 출처/시간,
Spot 상태, PG 누적 통계/연결, Ops lease 및 최근 job별 run, 검증 갱신 시각,
프로세스 메모리/CPU를 기록한다. JSON에는 REST 응답/실패/429/418 횟수,
Last 수신 간격/프레임 거절, 수집량/크기, 시장가·지정가 지연도 남는다.

60초에 Last/Mark socket을 끊고 150–170초에 WS+REST를 차단한다.
초기 30초와 계획 장애/회복 구간 150–190초를 신선도 판정에서 명시적으로
분리하되 원시 관측을 지우지 않는다. 합격은 그 밖의 평가 표본에서 가격
누락 <=1%, 최종 23종 Last/Mark 회복, 세 출처 수집, 비정상 프레임 전부
거절, 실제 시장가/지정가 체결, 예상 밖 금융 오류 0, clock step 0이다.
정상 지정가 미도달은 별도 대기 결과로 기록한다. 실제 지정가 체결은
`executed` 및 execution FK를 확인하고 같은 계정에서 정상 청산한다.
계획 장애 중 새 Last가 없어 지정가가 계속 submitted이면 정상 취소 명령으로
예약을 해제하고 `expectedOutageBlocks`로 기록한다. 계획 구간 밖의 체결
timeout은 오류이며 이 처리로 숨기지 않는다.

예산의 429/418/cooldown/fail-closed는 기존 Redis integration 18개로
검증한다. 실 Binance에 rate limit을 유발하지 않는다. 24시간 검증 후에는
계약 검증 갱신, 자연 만료/갱신, 자동 provider reconnect, retention 삭제량과
참조 증거 보존, 지연/RSS 추이, Ops 실패를 원시 로그로 최종 검토해야 한다.
운영 승인 기준으로 적용할 latency/RSS/DB SLA는 실제 배포 환경에서 따로
정한다. 여기의 localhost 실측을 운영 SLA로 사용하지 않는다.

중단은 해당 전용 unit만 `systemctl --user stop trading-futures-soak-followup-24h`.
전체 결과를 수집한 다음 전용 DB/PG/Redis만 정리한다. 이번 호스트는
`Linger=no`이며 WSL 종료/로그아웃 후 서비스 유지가 보장되지 않는다.
진행 중인 24시간 시도는 그 제약을 포함해 PARTIAL로 보고한다.

이번 최종 실행 unit은 `trading-futures-soak-followup-24h-v2`이고 DB는
`futures_soak_24h_final_test`, Redis DB 번호는 5다. 출력은
`evidence/soak-24h-final/`에 있다. `SOAK_UNIT`/`SOAK_REPORT_DIR`로 해당
값을 명시해 실행했다. 최초 unit은 계측의 계획 장애 처리를 보완하기 위해
정상 중단했으며 `evidence/soak-24h.json`의 INTERRUPTED 결과를 보존했다.
최종 unit을 모니터링/중단할 때는 `-v2` 이름을 사용한다.

## 현재 main 재검증 (`f512dab0`, 2026-10-10 KST)

결과는 `../evidence/main-f512-recheck/`에 있다. 각 `*-run.json`과
`backend-unit.json`, `frontend-check.json` 등에 실제 command, 시간/RSS 상한,
종료 코드와 clock step을 저장했다. 이번 DB 이름은 `futures_recheck_*_test`,
Redis는 10–15번이며 진행 중인 기존 soak의 DB/Redis 5번과 분리했다.

순수 readiness 결함 재현(연결 없음):

```bash
bash docs/investigations/2026-10-10-futures-last-price-followup/reproduction/reproduce-readiness-regression.sh
```

새 PG safety 게이트는 active 상태의 종료 시즌, 보호 기능 비활성화,
성공한 dry-run Worker를 함께 검증한다. 200만 행 시험도 동일 게이트의
`RETENTION_TEST_ROWS=2000000` 설정이다. 최신 관측 fixture는 wall clock이
아닌 실제 저장된 같은 종목/source의 최대 `capturedAt + 1ms`로 생성한다.
삭제/금융 정책이나 실행 가격의 시각을 변경하지 않는다.

REST fixture의 정확한 opt-in(실 HTTP 호출 없음):

```bash
NODE_ENV=test BINANCE_REST_REDIS_FIXTURE=1 \
  BINANCE_REST_FIXTURE_REDIS_URL=redis://127.0.0.1:56389/10 \
  pnpm exec jest --runInBand --runTestsByPath \
  src/providers/binance/binance-rest-coordinator.integration.spec.ts
```

벤치마크는 현재 부하에서 새로 생성된 PostgreSQL backend PID도 CPU 계측에
포함한다. 과거 수치의 PostgreSQL CPU는 시작 시의 PID만 포함했으므로
현재 수치와 직접 비교하지 않는다. 전체 서버/OS CPU와도 구분한다.
10,000명 추정은 실제 사용자 시험 결과가 아니다.

기존 24시간 unit은 계속 실행하며 이번 재검증은 건드리지 않았다.
고정 관측 사본 `soak-24h-observed.json`은 완료 결과가 아니다.
`RUNNING`, `actual24hCompleted=false`, clock step이 있는 결과를 PASS로
바꾸지 않는다. WSL 종료/로그아웃 및 불안정 시계 제약을 해결한 환경에서
86,400초 이상을 마친 뒤 최종 assertions와 원시 표본을 검토해야 한다.
