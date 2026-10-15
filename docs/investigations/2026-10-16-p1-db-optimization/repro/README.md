# 재현 스크립트 (P0 보완·P1)

[보고서](../report.md)의 측정을 다시 실행하는 스크립트다. 운영 읽기 전용 확인 2개를 빼면 모두 **루프백의 `*_test` 데이터베이스에서만** 동작한다(스크립트가 검사한다). 공급자 API는 호출하지 않는다.

## 측정 환경 (2026-10-16)

| 클러스터 | 용도 | 설정 |
|---|---|---|
| PostgreSQL 16.14, 127.0.0.1:55816 | CI 재현 (postgres:16 이미지와 같은 기본값) | initdb 기본값 + `timezone=UTC`, `jit=off` |
| PostgreSQL 17.10, 127.0.0.1:55817 | 운영 메이저, 기본값 | 같음 |
| PostgreSQL 17.10, 127.0.0.1:55818 | 성능 측정 | 운영 `pg_settings`(감사 evidence): `shared_buffers=256MB`, `effective_cache_size=768MB`, `work_mem=6617kB`, `random_page_cost=1.1`, `effective_io_concurrency=200`, `max_wal_size=1280MB`, `checkpoint_timeout=300s`, `wal_level=replica`. 로컬 차이: `jit=off`, `track_io_timing=on`, 아카이브 없음 |

- 바이너리: `@embedded-postgres/linux-x64@16.14.0-beta.17`, `@embedded-postgres/linux-x64@17.10.0-beta.17`(lz4 미포함).
- **로컬 ms는 운영값이 아니다.** 운영 디스크는 훨씬 느리다. 비교에는 버퍼 수·계획·WAL 바이트·행 수를 쓴다.
- 마이그레이션: 작업 트리 기준 `pnpm exec prisma migrate deploy`. `DATABASE_URL`은 항상 명시한다(`backend/.env.local`은 운영 DB다).

## 스크립트

| 스크립트 | 측정 | 보고서 |
|---|---|---|
| `futures-retention-sql.ts` | 선물 보존 문장: 운영 빌더(`fixed`)와 70f51455 문장(`p0`, DELETE 단계만 CTE 조인으로 되돌림) | §2 |
| `measure-futures-retention.ts <adminUrl> <템플릿> <끝 시각> <mark\|last> <p0\|fixed> <시나리오>` | P0 `measure-retention.cjs`와 같은 시나리오(steady·backlog·held·deadprefix·one12h, `BATCH`) | §2 |
| `probe-futures-retention-plans.ts <url> <끝 시각> <mark\|last> <회수>` | 반복 ANALYZE × 비용 설정 2종 × cutoff 2종 × 배치 2종의 DELETE 단계 계획 | §2 |
| `measure-uuid-wal.cjs <adminUrl> <템플릿> <끝 시각> <v4\|v7> [초]` | Mark 정상 상태(초당 다중 행 INSERT, 60초마다 보존, 300초마다 CHECKPOINT)의 WAL·FPI | §11 |
| `probe-reference-prices.cjs <url> <끝 시각> <회수>` | 선물 기준가 읽기 API의 Mark 조회 인덱스 선택(등호판 vs 범위판) | §11 |
| `gen-asset-prices.cjs <url>` | 운영형 `asset_price_snapshots` 템플릿(530만 행, 7.1 GB) | §6 |
| `measure-asset-retention.ts <adminUrl> <템플릿>` | 실제 워커(운영 기본값)로 첫 정리·동시 INSERT·WAL·VACUUM·공간 재사용·계획 | §6 |
| `probe-carry-forward.cjs`, `probe-carry-forward-stale-stats.cjs` | 미국주식 휴장 이월 가격 조회 계획(통계 최신 / 창이 마지막 ANALYZE보다 새로운 경우) | §11 |
| `measure-row-bytes.ts <url>` | 원문 프로필별 행당 저장 바이트(힙+인덱스, 10만 행, 기본·`toast_tuple_target=128`) | §7 |
| `prod-readonly-check.cjs [라벨]` | **운영 읽기 전용** 통계·크기·보존 실행·Mark 공백 (`default_transaction_read_only=on`, 20 s timeout) | §3 |
| `render-metrics-readonly.cjs <시작> <끝> <해상도>` | **Render API GET만**: DB·웹 CPU·메모리·디스크 | §3 |

선물 템플릿은 P0 `repro/gen-mark.cjs <url> 25|100 48 3600 0.5`, `gen-last.cjs <url> 25|100 48`로 만들었다.

예:

```bash
export NODE_PATH=<repo>/backend/node_modules
cd <repo>/backend
pnpm exec tsx ../docs/investigations/2026-10-16-p1-db-optimization/repro/measure-asset-retention.ts \
  postgresql://u:p@127.0.0.1:55818/postgres p1_aps_test
# 운영 읽기 전용: TZ=UTC 필수 (node-pg는 naive timestamp를 로컬 시각으로 읽는다)
TZ=UTC DATABASE_URL=<운영 URL, 출력 금지> node ../docs/investigations/2026-10-16-p1-db-optimization/repro/prod-readonly-check.cjs sample-2
```
