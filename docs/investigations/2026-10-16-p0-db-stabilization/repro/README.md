# 재현 스크립트

[P0 보고서](../report.md)의 측정을 다시 실행하는 스크립트다. 모두 **루프백의 `*_test` 데이터베이스에서만** 동작한다(스크립트가 검사한다). 운영 DB나 공급자 API에는 접속하지 않는다.

## 측정 환경 (2026-10-16)

- **PostgreSQL 17.10** (운영 17.11과 같은 메이저). `@embedded-postgres/linux-x64@17.10.0-beta.17`, 127.0.0.1.
- **설정은 운영값을 그대로 썼다**(감사 evidence의 `pg_settings`):
  - `shared_buffers=256MB`, `effective_cache_size=768MB`, `work_mem=6617kB`, `maintenance_work_mem=64MB`
  - `random_page_cost=1.1`, `effective_io_concurrency=200`, `max_parallel_workers_per_gather=1`
  - `max_wal_size=1280MB`, `timezone=UTC`
- **로컬과 운영의 차이.** 로컬은 `jit=off`, `track_io_timing=on`이다.
  - 로컬 디스크와 OS 캐시는 Render 디스크보다 훨씬 빠르다. 그래서 **시간(ms)은 운영값이 아니다.** 비교에는 버퍼 수와 계획 모양을 쓴다.
- 마이그레이션: 저장소 HEAD 기준 `pnpm exec prisma migrate deploy`.

## 데이터셋

`gen-mark.cjs <url> <계약 수> <시간> <REST 간격 s> <REST 계약 비율>`은 Mark 이력을 운영과 같은 방식으로 만든다.
- 계약마다 1초에 1행(WS)을 시간 순서로 넣는다.
- 지난 24시간 창만 남기고 오래된 1시간씩 지운다. 4시간마다 `VACUUM`을 돌린다.

| DB | 인자 | 결과 | 운영(10-15) |
|---|---|---|---|
| `p0_mark_perf_test` | 25, 48, 300, 1 | 2,167,200행, heap 441 MB, unique 401 MB (REST 촘촘함) | 2.09M행, 444 MB / 412 MB |
| `p0_mark_norest_test` | 25, 48, 3600, 0.5 | 2,160,312행 (**운영형: REST 희소**) | REST 0.013% |
| `p0_mark_zero_test` | 25, 48, 0, 0 | 2,160,000행 (REST 없음) | — |
| `p0_mark100_norest_test` | 100, 48, 3600, 0.5 | 8,641,200행, heap 1.76 GB, unique 1.60 GB | 100계약 가정 |
| `p0_last_perf_test` (`gen-last.cjs`) | 25, 48 | 2,208,000행, heap 449 MB, 인덱스 1.23 GB | 1.67M행, 347 MB / 929 MB |

## 스크립트

| 스크립트 | 측정 |
|---|---|
| `measure-freshness.cjs <url> <끝 시각> [회수]` | 이전 Mark 신선도 `groupBy`(Prisma가 만드는 SQL 그대로)와 계약별 `LATERAL LIMIT 1`의 버퍼 수 |
| `plan-probe-mark.cjs`, `plan-probe-last.cjs <url> <끝 시각>` | 보존 후보 질의 계획(EXPLAIN만). 이전 SQL과 새 SQL, cutoff 6개 × 배치 2개 |
| `measure-retention.cjs <admin url> <템플릿 DB> <끝 시각> <mark\|last> <old\|new> <시나리오>` | 보존 DELETE 실제 실행. 템플릿 복제본에서 서비스와 같은 `statement_timeout=5s`. 시나리오: `steady`, `backlog`(12시간), `held`(오래 열린 스냅샷), `deadprefix`(VACUUM 전 40만 행 삭제), `one12h`(`BATCH` 지정) |
| `probe-tie.cjs <admin url> <템플릿 DB> <mark\|last> <횟수>` | 보존 문장의 계약·소스별 최신 행 조회가 ANALYZE 표본마다 어느 인덱스를 고르는지 본다. 처음 초안(source 등호)과 최종(source 범위)을 비교한다 |
| `mark-ingestion-bench.ts` | 수집 서비스 부하 시험. `BACKEND_DIR`의 실제 `FuturesMarkIngestion`(작업 트리, 또는 `git archive HEAD` 사본)을 실제 PostgreSQL에 연결한다. WS(계약당 초당 1프레임)와 REST는 가짜. 시나리오: `steady`, `silent-one`, `ws-outage`, `slow-write`, `write-fail` |

예:

```bash
export NODE_PATH=<repo>/backend/node_modules
node gen-mark.cjs postgresql://u:p@127.0.0.1:55731/p0_mark_norest_test 25 48 3600 0.5
node measure-freshness.cjs postgresql://u:p@127.0.0.1:55731/p0_mark_norest_test 2026-10-15T08:21:38 3
cd <backend 루트> && BACKEND_DIR=$PWD DATABASE_URL=postgresql://u:p@127.0.0.1:55731/<복제 *_test> \
  SCENARIO=steady SECONDS=60 LABEL=new NODE_OPTIONS=--experimental-vm-modules \
  pnpm exec tsx <repro>/mark-ingestion-bench.ts
```

이전 구현은 `git archive 4f5c4dda backend | tar -x -C <dir>`로 풀고 `node_modules`를 심볼릭 링크로 연결해 같은 스크립트로 실행했다.
