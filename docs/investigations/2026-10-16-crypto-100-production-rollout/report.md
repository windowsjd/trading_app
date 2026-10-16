# 암호화폐 현물 100 · 선물 100 · 호가 이력 운영 전환

2026-10-16 UTC 10:20–12:10 (KST 19:20–21:10). 이전 작업 [2026-10-16-binance-crypto-100](../2026-10-16-binance-crypto-100/report.md)의 보완과 실제 운영 적용 기록이다. 운영 DB 디스크 증설·백업 확인은 사용자가 직접 수행했다(이번 작업에서는 디스크 크기 메타데이터만 읽었다). **24시간 이상 연속 수집·장시간 soak은 수행하지 않았다.**

## 요약

| 항목 | 결과 |
| --- | --- |
| 시작 SHA | 로컬 HEAD = origin/main = `3b4a7685`. 이 SHA는 09:51Z부터 Render에 배포돼 있었다(migration `20261016200000` 09:49Z 적용) |
| 코드 보완 | `27c74787` — CI 빌드 힙, ASTERUSDT 폴백 tick, Spot 메타데이터 부분 갱신, 백필 예산 절차·신선도 진단 문서 |
| GitHub Actions | CI `38890652675` 7개 작업 전부 success, Futures release fixture `38890652629` success(10계정 감사 CORRECTNESS PASS ×2, findings 0) |
| 운영 배포 | `27c74787` 자동 배포 1회 + 환경변수 적용 배포 2회. 최종 live `dep-db90t8vf3r2c73fnal30`(11:48:31Z) |
| 현물 | 운영 Spot 노출 29(기존 25 + 09:51 배포로 노출된 PUMP/AAVE/BCH/FIL) → **100**. 신규 Asset 71행 |
| 선물 | 계약 25 → **100**(전부 활성·Mark 검증). Futures-only 기초자산 20행 추가(총 21) |
| 캔들 | 현물 신규 75: 1d/1w 365일 28,883행, 5m 35일 약 75.4만 행. 선물 100계약 4h 96일 57,394행 + 정기 갱신 활성화 |
| 호가 이력 | 60초 기록·14일 보존 활성화. 처음 21분 4,090행(닫힌 상품·분의 97.4 %), 중복·거부·쓰기 실패 0 |
| 가격 보존 | 14일 보존 활성화, 약 9.9만 행 삭제 진행 중. 초기에 statement timeout 반복 → 배치 250행 설정과 VACUUM 1회로 해소(§3) |
| 금융 데이터 | 지갑·원장·주문·체결·현물/선물 포지션·기존 30 Asset·기존 25 계약 지문 **변경 전후 동일** |

## 1. 시작 상태와 운영 환경 확인

- Render 서비스 `srv-da84cg8u01pc73cjasa0`: 브랜치 `main`, autoDeploy on(트리거 commit, CI 통과를 기다리지 않음), rootDir `backend`, 1 vCPU/2 GB 1대, health check 경로 없음(포트 검사).
- 운영 PostgreSQL 17(`0.5c-1g`, 디스크 100 GB, 자동 확장 off), Key Value(Redis). 시작 시 DB 9.39 GB.
- Migration 81개 전부 적용, 실패·롤백 0.
- 환경변수: `BINANCE_CRYPTO_SYMBOLS` 미설정(정상), `BINANCE_REST_WEIGHT_BUDGET_PER_MINUTE` 미설정(코드 기본 600), 가격 보존·호가 이력·저장소 감시 미설정(OFF). `SCHEDULER_MARKET_CANDLE_SYNC_ASSET_IDS`는 12개 ID(암호화폐 8, KRX 2, 없는 ID 2) — 변경하지 않았다.
- 운영 노출: 4명의 현물 보유(ADA·BNB·BTC×2·NIGHT), 미체결 주문·대기 진입·열린 선물 포지션 0.
- `futures_market_candles` 0행: **기존 25계약도 선물 차트 데이터가 없었다**(선물 4h 갱신 작업이 운영에서 한 번도 켜지지 않았음). Spot long-range 4h 갱신도 운영에서 꺼져 있다.

## 2. 이전 작업 문제 보완 (`27c74787`)

### A. Futures release fixture CI OOM

- 원인: 잡 전체 `NODE_OPTIONS=--max-old-space-size=1536`(fixture 서버·하네스용)이 `nest build`에도 적용됐다. 빌드가 성공하는 최소 힙을 직접 측정했다: `ead934cd` 1408 MB 실패 / 1536 MB 성공, `3b4a7685` 1536 MB 실패 / 1664 MB 성공. 즉 기존에도 상한 대비 여유가 128 MB 이하였고 100+100 카탈로그·Prisma 모델·호가 이력 추가로 넘어갔다. 로컬에서 같은 상한으로 exit 134 재현([build-oom-head-1536.log](evidence/build-oom-head-1536.log)).
- 수정: 빌드 단계에만 `NODE_OPTIONS=--max-old-space-size=4096`(이 러너의 Node 기본 힙과 같은 값, CI 워크플로의 빌드와 동일 조건). fixture 서버·하네스의 1536 MB 상한은 유지. 테스트·빌드 생략 없음.
- 결과: run `38890652629` — prepare·최종 감사 모두 `CORRECTNESS PASS`, 10계정, findings 0. catalog smoke PASS(Spot 100, Futures 100, Futures-only 21, 현물 quote 거부 84, WS 거부 63, 시장가 체결 84, 외부 provider 접근 0), 시계 역행 0.

### B. ASTERUSDT 폴백 tickSize

- 2026-10-16 `exchangeInfo?symbolStatus=TRADING`으로 100종목 전부 대조: ASTERUSDT만 불일치(폴백 0.001 / 실제 0.0001). 나머지 99개 tick·표시 소수·baseAsset·quote·status 일치.
- 폴백을 0.0001(소수 4)로 수정. 동결된 2026-09 조사 artifact는 수정하지 않고 테스트에 "재검토 폴백" 목록으로 명시(식별 필드는 그대로 비교). 폴백은 표시 소수 전용이며 주문·체결 산식은 읽지 않는다. Spot seed는 tick을 DB에 쓰지 않아 운영 seed 계획에 영향 없음.
- 실데이터 smoke(2회): exchangeInfo 100/100, **tick·표시 소수 100/100**, REST 100/100, depth10 100/100·99/100. 남은 FAIL은 15초 창 안에 체결이 없던 얇은 종목 1개씩(FOGO, 다음 회 BARD)의 WS ticker 미수신이다(D 항목 현상, 메타데이터 문제 아님).

### C. Spot 메타데이터 갱신 안정성

- 실제 Binance 정책 재현: `symbols=[…]`에 존재하지 않는 심볼 1개 → HTTP 400 `{"code":-1121,"msg":"Invalid symbol."}`로 **배치 전체 실패**. 반면 상장폐지 종목은 `BREAK` 상태로 계속 응답에 포함된다(EOSUSDT 200, BREAK 2,349개 중 2018년 폐지분 포함). 응답 누락은 기존 파서가 이미 개별 무시한다. 따라서 위험 경로는 "심볼이 exchangeInfo에서 완전히 사라지는 경우"뿐이다.
- 최소 수정: `ProviderHttpError`에 비 2xx HTTP 상태(`httpStatus`, 본문 미보관)를 추가하고, 메타데이터 갱신이 **400일 때만** 배치를 반으로 나눠 나머지 심볼을 갱신한다. 단독으로도 거부된 심볼은 기존 폴백을 유지하고 이후 요청에서 제외한다. 5xx·timeout·rate limit은 분할하지 않는다(기존과 같이 실패 기록, 마지막 정상값 유지).
- 실데이터 검증([metadata-unknown-symbol-live.json](evidence/metadata-unknown-symbol-live.json)): ASTERUSDT가 사라진 것처럼 만든 배치 → 15회 호출로 분리, 99개 live 갱신, ASTER는 폴백, 다음 갱신은 99개 1회 호출(200).

### D. 신규 현물 가격 신선도 (정책 변경 없음)

- 기존 정책 확인: 시장가 체결은 수신 시각(`captured_at`) 기준 10초(정수 초 비교라 11초부터 거절), 견적 60초, 표시 300초. 오래된 가격의 시장가 주문은 503 `PRICE_STALE` → 앱은 "최신 가격을 확인할 수 없어 주문할 수 없습니다."(코드 기반 매핑), 주문 패널은 화면 시세가 60초를 넘으면 예상 수량·금액 대신 경고를 표시한다. 목록의 `tradable`은 300초 기준이라 11–300초 구간에서는 거래 가능으로 보이고 주문 시 거절된다(서버가 최종 판단).
- REST 응답으로 오래된 체결가가 새 가격처럼 보이는 경로: WebSocket 사용 중에는 REST 가격 수집이 꺼져 있다(`provider_binance_ingest` off). 이번 작업은 REST 보완을 추가하지 않았다.
- 화면 보완은 하지 않았다(주문 거절과 사유 전달이 이미 동작). 진단 SQL을 운영 문서에 추가했다([binance-crypto-100-2026-ytd.md](../../../backend/docs/binance-crypto-100-2026-ytd.md) "Operator check").
- 운영 실측(11:17–11:55 UTC, 38분, 100종목, [spot-freshness-38m.txt](evidence/spot-freshness-38m.txt)): 체결 거절 구간 >0 % 69종목, >1 % 46, >5 % 21, >20 % 6(ZKP 40.2 %, BARD 37.3 %, BABY 32.6 %, BANK 22.5 %, BREV 21.6 %, 币安人生 21.0 %). 견적 거절(60초 초과)은 6종목(최대 ZKP 7.1 %). 짧은 단일 시간대 측정이며 장기 통계가 아니다.

### E. 캔들 백필과 Futures Last REST 예산 경합

- 원인 재확인: 공유 coordinator는 Redis의 분당 weight 카운터 하나를 쓰지만, 각 프로세스는 **자기 `BINANCE_REST_WEIGHT_BUDGET_PER_MINUTE`** 로 허용을 판단한다(`shared + w ≤ own budget`). 이전 실측(90초 공백)은 서버와 백필이 모두 600이었다.
- 새 우선순위 시스템 없이 운영 절차로 해결: 서버 1200, 백필 스크립트 480 + `MARKET_CANDLE_SYNC_ASSET_CONCURRENCY=1`. 로컬 Redis 실측: 백필 480 소진 후에도 서버가 같은 분에 720 허용([coordinator-budget-split.ts](repro/coordinator-budget-split.ts)).
- 운영 실측: 12분간의 5m 백필(11:25–11:38) 동안 Futures Last 25계약 최대 공백 **7.1초**, 10초 초과 0회(이전 89.7초). 공유 weight 최대 약 365–449/분(예산 1200).

### F. 종목 수 증가에 따른 화면·구독 (변경 없음)

- 현물 목록: 정렬 스냅샷 + offset 20개씩(100개 = 5페이지), FlatList, 25 고정·하드코딩 심볼 없음. 검색은 서버 검색(Futures-only는 현물 검색에서 제외), 선물은 카탈로그 전체를 받아 클라이언트 필터.
- 앱 WS: 로드된 목록 행마다 `asset_ticker` 구독(가시 행만이 아님, 구독 수 상한 없음). 게이트웨이의 64는 "느린 소켓(버퍼 1 MB 초과)일 때 클라이언트별 대기 ticker 큐" 상한이지 구독 상한이 아니다. 운영 readiness `dropped 0`.
- 계정·종목 전환: 자산 ID 일치 검사, 계정 ID 포함 쿼리 키, 화면 key 재생성으로 이전 가격 혼입을 막는다.
- 정상 사용자에게 확인된 문제 없음 → UI 변경하지 않았다. 남은 성능 위험: 선물 목록은 가상화되지 않고 5초마다 100행을 다시 그린다(§8).

## 3. 운영 적용 순서와 결과

| 시각(UTC) | 단계 | 결과 |
| --- | --- | --- |
| 10:57 | `27c74787` push → Render 자동 배포(10:59 live), CI·fixture 진행 | 배포 정상, pending migration 없음 |
| 11:11 | CI 전체 success 확인 후 운영 쓰기 시작. 변경 전 지문·스냅샷 | — |
| 11:12 | 환경변수: REST 예산 1200, 가격 보존 ON, 저장소 감시 ON(100 GB) | — |
| 11:13 | Spot seed `--apply` | 100/100 검증, 71 생성, 0 수정, 검증 100/100 |
| 11:13–11:15 | 배포(환경변수 적용 + depth10 재구독) | Spot 스트림 200(ticker 100 + depth 100) |
| 11:21–11:25 | 1d/1w 백필(75종목, 365일) | 150 feed 완료(4개는 예산 양보 후 재실행) |
| 11:25–11:38 | 5m 백필(35일, 15종목 배치) | 75/75 완료(12개 재실행), Last 공백 최대 7.1초 |
| 11:28 | Futures provisioning dry-run(읽기 전용 트랜잭션, loopback Redis) | assets create 20 / maintain 80, instruments create 75 / maintain 25, blockers 0 |
| 11:39 | Futures provisioning `--apply` | 그대로 적용, Spot·금융 행 수정 0. 30초 내 Mark 대상 100, stale 0 |
| 11:43–11:46 | 선물 4h 백필(96일, 100계약, 2회) | 57,394행, 실패 0 |
| 11:46–11:48 | 환경변수: 호가 이력 ON, 호가 보존 ON, 선물 4h 갱신 ON, 가격 보존 배치 250/80 → 배포 | 호가 기록 100+100, 보존 작업 정상 |
| 12:00 | `VACUUM (ANALYZE) asset_price_snapshots`(autovacuum와 같은 cost delay) | 68초, 사망 항목 78,990 제거, Mark stale 0 유지 |
| 12:08 | 가격 보존 정상 실행 | 109배치, 19,991행 삭제, 경보 해제 |

**가격 보존 초기 실패**: 운영 DB(0.5 vCPU·1 GB, shared_buffers 256 MB)에서 1,000행 배치가 차가운 페이지 읽기로 고정 5초 statement timeout에 걸렸다(AVAX 첫 배치 읽기 부분만 3.9초, 디스크 읽기 약 8천 페이지). 배치를 250행으로 줄였지만 재시작으로 메모리 커서가 초기화되면 보호(유지) 행을 다시 검사하면서 앞서 지운 행의 사망 인덱스 항목을 따라가 다시 시간 초과가 났다. autovacuum 기준(약 75만 사망 행)까지는 멀어 수동 VACUUM(비 FULL, 잠금 없음)을 1회 실행했고 이후 실행이 성공했다. 실행 계획은 모두 인덱스 기반이었다([retention-explain-*.txt](evidence/)). 금융 경로·데이터와 무관하다.

## 4. 최종 운영 상태 (12:09Z, [06-final.json](evidence/06-final.json))

- `/health` 200, `/readiness/alerts` 200 `[]`(사유는 기존 `MARKET_CALENDAR_PROVISIONAL`뿐).
- Spot WS: ticker 100 + depth10 100, 실패 0. 기동 시 시세 점검에서 암호화폐 100·KRX 15 전부 가격 있음(미보유 25는 기존과 같은 미국 주식).
- Futures Mark: 대상 100, stale 0, 11:41–11:55 최대 공백 2.01초(3초 초과 0). Futures Last: 100계약, 최대 공백 7.1초, 10초 초과 0.
- 호가 이력: 추적 100+100, 저장 4,090행(97.4 %), 분·상품당 1행, 10단계, 분 종료 약 0.4초 후 기록, 실패 0. 보존 작업 성공(삭제 대상 아직 없음).
- 가격 보존: 성공, 약 9.9만 행 삭제(진행 중, 실행당 최대 2만 행 검사). 저장소 감시: 9.94 GB, 11.3 %(WAL 여유 1.34 GB 포함).
- 정기 작업: 선물 4h 갱신(1분), 암호화폐 캔들 정합(5분, 100종목), Mark·Last 보존 정상. 공유 REST weight 최대 약 450/분.

## 5. 금융 데이터 보호 검증

- 읽기 전용 지문([fingerprint-before.txt](evidence/fingerprint-before.txt) / [after](evidence/fingerprint-after.txt)): `wallet_transactions` 63, `cash_wallets` 32, `orders` 8, `futures_executions` 8, `futures_positions` 3, `positions` 8, 기존 crypto Asset 30(ID·이름·활성), 기존 선물 계약 25 — **digest 전부 동일**.
- 보유 4건·주문 상태·포지션 상태 변화 없음. 운영 DB 쓰기는 Asset 91행·FuturesInstrument 75행 추가, 캔들 upsert와 그 동기화 체크포인트·`ops_job_runs` 기록, 보존 삭제(가격 스냅샷·호가), VACUUM뿐이다. Migration은 이번 작업에서 새로 실행하지 않았다(`20261016200000`은 3b4a7685 배포 때 이미 적용).

## 6. 남은 위험과 대응

| 위험 | 내용 | 대응 |
| --- | --- | --- |
| 가격 보존 재검사 비용 | 커서가 메모리에 있어 재시작·하루 1회 초기화 후 유지 행을 다시 검사한다. VACUUM 전 사망 항목이 많으면 시간 초과가 반복될 수 있다 | `ops_job_runs`·`/readiness` `assetPriceRetention` 확인. 반복 시 저부하 시간 수동 VACUUM. 근본 개선(커서 영속화, 실패 자산 건너뛰기, 테이블별 autovacuum 기준)은 별도 작업 |
| 얇은 현물 신선도 | 38분 실측 6종목이 20 % 이상 거절 구간 | 정책대로 fail-closed. 장기 비율은 진단 SQL로 사용자 확인 |
| 경보 전달 없음 | `OPS_READINESS_ALERTS_URL` 미설정으로 readiness 경보가 어디에도 전달되지 않는다 | 저장소 변수 또는 외부 모니터 설정 권장 |
| 운영 DB 규모 | 0.5 vCPU·1 GB, I/O가 병목(삽입 대기 이벤트 IO 관찰) | Render DB CPU·메모리·지연 지표 관찰 |
| 앱 1 vCPU | 100+100 수신·기록 부하는 로컬 측정만 있음 | Render 앱 CPU·메모리 확인 |
| 선물 목록 | 가상화 없음, 5초마다 100행 재렌더 | 저사양 기기 확인 |
| 기존 관찰(이번 변경 무관) | 스케줄 allowlist의 암호화폐 8종목(BTC·ETH 등) 5m 커버리지 증거가 10-14/10-15에서 멈춤(캔들 행은 계속 저장됨) | 별도 확인 권장 |

**롤백**: 호가 이력 `CRYPTO_ORDER_BOOK_HISTORY_ENABLED=false`(보존은 14일 유지), 선물 4h 갱신 `SCHEDULER_FUTURES_CANDLE_SYNC_ENABLED=false`, 가격 보존 `ASSET_PRICE_SNAPSHOT_RETENTION_ENABLED=false`(삭제분 복원 불가) — 각각 배포 1회로 독립 중단. 신규 현물·선물은 아직 사용자 거래가 없어 카탈로그 코드 되돌림 + 신규 현물 비활성화가 깨끗하다. 거래가 생긴 뒤에는 현물 비활성화가 보유자의 매도까지 막는다(종목별 매수 전용 차단 수단 없음, `isActive`가 매수·매도 모두 차단). 신규 선물 계약은 카탈로그에서 빠져도 열린 포지션의 Last·Mark·청산은 유지된다. 기존 25+25는 어떤 단계에서도 바뀌지 않았다.

## 7. 사용자가 직접 확인할 항목 (장시간 수집 검증)

1. 가격 신선도: "Operator check" SQL을 1시간·24시간 창으로 실행(`execute_refused_pct`, `quote_refused_pct`, `longest_gap_s`).
2. 호가 이력: `/readiness` `cryptoOrderBookHistory.recorder.counts`(inserted ÷ closedMinutes, staleMinutes, duplicates, rejected), `consecutiveWriteFailures`; 하루 행 수(최대 288,000)와 테이블 크기.
3. 보존: `ops_job_runs`의 `asset_price_snapshot_retention`(실패 연속 여부, deletedCount), `crypto_order_book_retention`(14일 후 deletedCount·oldestRemaining).
4. Futures: `futuresMark.staleTargets`, Last 공백 SQL([last-gaps.sql](repro/last-gaps.sql)), Binance 24시간 강제 재연결 시점의 재구독.
5. 저장소: `databaseStorage.growthBytesPerDay`·`daysUntil80Percent`(24시간 이후 계산), Render 디스크 지표.
6. REST: 공유 weight가 1200에 닿는지, `PROVIDER_RATE_LIMITED` 로그.
7. 앱 화면: 현물 목록 100(끝까지 스크롤), 신규 종목 검색·상세·차트(1d/1w·5m 기반 차트), 선물 목록 100·Futures-only 종목의 현물 미노출, 선물 차트 표시, 얇은 종목 주문 시 거절 문구.

## 8. 실행하지 못했거나 하지 않은 것

- 운영 API·화면의 인증 호출 검증: 운영 사용자 계정을 만들거나 기존 사용자 토큰을 쓰지 않았다. 대신 같은 코드의 CI catalog smoke(100/100·Futures-only 404 등), 운영 DB 상태, readiness로 확인했다. **실기기·브라우저 화면 확인은 NOT_RUN.**
- 24시간 연속 수집, 장시간 soak, 장기 메모리 관찰: **NOT_RUN**(요청 범위 밖).
- Spot long-range 4h 백필·갱신: 운영에서 기존 25종목도 꺼져 있어 맞춰 두었다(KRX가 포함된 작업이라 변경하지 않음).
- 원문 슬림(`BINANCE_WS_RAW_SLIM_ENABLED`), 캔들 보존 스케줄, 경보 전달 설정: 이번 지시에 없어 변경하지 않았다.
