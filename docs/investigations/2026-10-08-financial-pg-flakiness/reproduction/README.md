# Archive 전용 재현 자료

제품 checkout에는 적용하지 않는다. HEAD 또는 `2411a0c6`의 별도 `git archive`
디렉터리에서 `archive-observation.patch`를 적용하고, 이 디렉터리의 세
`investigation-*.ts` 파일을 archive의 `backend/scripts/`에 복사한다.
같은 Backend lockfile의 dependencies와 독립 disposable PostgreSQL/Redis를 사용한다.
운영 DB 및 전역 시스템 시계/동기화 설정을 바꾸지 않는다.

기존 검증된 cgroup memory=3GiB, swap=0, Node heap=1152MiB, tasks=256,
runtime/외부 감시/그룹 종료 절차 안에서 순차 실행한다. 이번 실행의 정확한
상한/env/명령/DB와 raw cgroup 결과는 상위 `verification.json`에 있다.
사용한 실행 harness/archive는 `/tmp/finance-pg-investigation/`에 남아 있다.

Archive Backend cwd에서 필요한 opt-in:

```text
NODE_ENV=test
FUTURES_DB_INTEGRATION=1
LIMIT_ORDER_RESERVATION_DB_INTEGRATION=1
DATABASE_URL=<독립 테스트 DB>
REDIS_URL=<독립 테스트 Redis>
```

독립 DB에 archive의 기존 migrations를 적용한 뒤 실행한다:

```sh
pnpm tsx scripts/investigation-clock-step-futures.ts
PG_CLOCK_STEP_REPRO=1 pnpm tsx scripts/spot-wallet-transfer-integration.ts
pnpm tsx scripts/investigation-coverage-guards.ts
```

첫 두 명령은 실제 host wall clock의 backward step을 기다리는 환경 재현이다.
`Date.now()` mock, 금융 서비스의 DB 시계 override, 미래 timestamp 주입을 하지 않는다.
두 step의 monotonic 간격으로 다음 step 직전에 증거를 준비한다. 원래 판정과
assertion은 유지하며, 거부 branch의 이미 읽은 값만 출력한다.

시계가 안정적인 환경에서 bounded wait가 timeout되는 것은 해당 환경 조건을
재현하지 못했다는 뜻이다. 테스트를 PASS시키려는 명령이 아니다. Futures 최소
명령은 실제 `FUTURES_INSTRUMENT_UNVERIFIED`와 execution 0건을 assert하므로
재현 성공 시 exit 0이다. Legacy Spot은 원래 `filled` assertion이 실패해 exit 1이다.
coverage guard 명령은 missing/future/stale/paused/wrong identity 거부와 rollback,
valid coverage 수락을 검증한다.

`wallclock-probe.py`는 DB와 무관한 120초 wall/monotonic 관측기다.
출력 경로는 이번 임시 조사 디렉터리이며 step/집계만 기록한다.
`clock-conversion-probe.cjs`는 이번 workspace의 Prisma/pg와 loopback 테스트 DB를
읽는 작은 시각 변환 비교다. 경로·DB는 파일에 명시되어 있다.
이들 probe는 금융 판정 코드와 연결하지 않는다.

평상시 matrix의 순서는 evidence의 initial/retries-results.json에 있다. 각 단독은
새 DB, Futures sequence와 Spot sequence는 조합 내부에서 같은 DB를 재사용했다.
F1 retry2는 실패한 DB, retry3는 다른 새 DB였다. matrix runner의 exit 0을 내부
개별 suite의 성공으로 해석하지 않는다.
