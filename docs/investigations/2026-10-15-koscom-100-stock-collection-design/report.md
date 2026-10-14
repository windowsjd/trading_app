# KOSCOM 국내주식 100종목 확대 — 수집 구조 검증과 설계안

작성일: 2026-10-15 (KST). 이번 단계는 **검토와 설계만** 다룬다.

- 코드, DB, Redis, 환경변수, 배포는 바꾸지 않았다.
- 실제 KOSCOM 호출은 0회, 운영 DB·Redis 접속도 0회다.
- 계산 근거는 [calc/koscom_budget.py](calc/koscom_budget.py)와 그 출력 [calc/koscom_budget.out.txt](calc/koscom_budget.out.txt)에 있다.
- 월별 KRX 세션 수는 [calc/krx_sessions.py](calc/krx_sessions.py)로 저장소 달력에서 계산했다.

**계산상 한도 안에 들어가더라도 운영 검증은 끝나지 않았다.** KOSCOM 응답 지연, 오류율, 한도의 적용 단위, 체결→수신 지연은 아직 실측되지 않았다.

## 0. 결론 요약

1. **지금 구조 그대로 100종목으로 늘리면 계약 한도를 크게 넘는다.**
   - 기존 코드의 국내 기능을 모두 켠 기준: 16.6만~18.2만 건/거래일. 일 한도의 332~363%, 최악 월의 426%다.
   - 기록된 운영 설정(현재가+호가 3초) 기준: 7.9만~9.5만 건/거래일(158~190%).
   - 운영 설정 그대로면 **25종목만 돼도** 시장 분포에 따라 일 95%, 월 104%에 이른다.
2. **비용 대부분은 쓰이지 않는 수집과 반복 재조회에서 나온다.**
   - 국내 호가(`koscom_krx_orderbook`)는 앱과 백엔드 어디에서도 읽지 않는다. 그런데 현재가와 같은 횟수로 호출되고, 매 주기 무조건 DB에 쌓인다.
   - 정기 캔들 sync는 일봉·주봉을 10분마다, 24시간 내내 다시 조회한다.
3. **권장안(R)의 구성**
   - 현재가만 5초 **고정 주기**로 수집하고, 호가 정기 수집은 중단한다.
   - 1분봉은 5분 버킷이 끝날 때마다 종목당 1회 조회한다.
   - 장 종료 후 1d·1w·4h와 누락 복구를 일괄 처리한다.
   - KRX에 대해 사용자 요청이 KOSCOM 호출을 일으키는 경로를 막는다.
   - 일·월 예산 관리자를 둔다.
   - 100종목 비용: 32,280~36,960건/거래일(일 한도의 65~74%), 최악 월 71~81%.
4. **GPT안의 '현재가 6초'는 예산상 가능하다.** 다만 시장가 체결의 10초 신선도는 **거래소 체결시각 기준**으로 판정된다. 그래서 6초에서는 수신 지연 여유가 약 2.5초뿐이다(주기 흔들림 1.5초 가정).
   - 체결→수신 지연(L)은 아직 측정되지 않았다.
   - 따라서 5초로 시작한다. 운영 DB에서 L을 측정해 기준을 만족하면 6초로 완화한다. 완화하면 하루 약 4.7천 건이 줄어든다.
5. **GPT안의 '주봉 정기 수집 중단'은 그대로 채택하면 안 된다.**
   - 앱의 1w 탭이 실제로 주봉을 요청한다(`interval=1w, range=1y`).
   - 일봉은 화면 전반의 '전일대비 등락률' 계산에 필수다. 이 값은 저장된 전 세션 1d 캔들로 계산된다.
6. **새로 발견한 결함 (§4)**
   - 사용자 차트 요청이 KOSCOM 호출을 직접 일으킨다.
   - KOSCOM 폴링 타이머가 인스턴스마다 돈다.
   - Binance용 전역 live 플래그를 켜면 운영에서 기동이 실패하거나, 국내 분봉 조회가 자동으로 시작된다.
   - 상한 없는 재시도 경로가 3곳 있다.
   - 스냅샷과 sync-state에 보존 정책이 없다.
7. **P0 즉시 확인: 운영 DB 증가량.**
   - 기록된 운영 PostgreSQL 디스크는 5GB이고 자동 확장이 꺼져 있다(2026-10-10 기준).
   - 현재 15종목 기준 스냅샷 증가는 행 크기 가정에 따라 **146~560MB/거래일**로 추정된다.
   - KOSCOM 폴링이 2026-10-10 배포로 켜진 뒤 여러 거래일이 지났다.

## 1. 조사 범위와 근거

| 항목 | 내용 |
|---|---|
| 코드 기준 | `main` `5b08cf5a`, 작업 트리 clean |
| 운영 설정 근거 | 저장소에 기록된 증거 2건만 사용했다. [render-current.json](../2026-10-11-render-1000-user-load-test-design/evidence/render-current.json)(2026-10-10 18:38 UTC, env 이름 목록과 비밀이 아닌 값), [production-effective-flags.json](../2026-10-12-futures-production-launch/evidence/production-effective-flags.json)(2026-10-12). **현재 Render 환경변수는 다시 조회하지 못했다**(자격증명 접근 권한 거부). 그 이후의 변경 여부는 [미검증]이다. |
| KOSCOM 실측 근거 | [10-12 1차](../2026-10-12-koscom-history-limits/report.md), [10-13 2차](../2026-10-13-koscom-10m-date-quota/report.md) 진단. `X-RateLimit-Limit-Day: 50000`, 잔여 카운터가 여러 흐름으로 관찰됨, 09:00 KST 초기화(공식 문서), 10분봉 1회 = 1세션 39행. |
| 하지 않은 것 | KOSCOM 호출, 운영 DB/Redis 접속, 환경변수 조회·변경, 배포, 코드 수정 |
| 표기 | [사실]은 코드 또는 기록 증거로 확인한 것, [추론]은 근거에서 도출한 것, [미검증]은 실측이 필요한 것이다. |

기록 증거 기준으로 정리한 운영 설정은 다음과 같다. 이후 바뀌었는지는 미확인이다.

- **KOSCOM:** `KOSCOM_POLLING_ENABLED=true`. `KOSCOM_POLL_INTERVAL_MS`, `KOSCOM_MAX_CONCURRENCY`, `KOSCOM_MIN_REQUEST_INTERVAL_MS`가 없으므로 기본값 3초 / 2 / 200ms다.
- **라이브 캔들:** `CANDLE_LIVE_STREAMING_ENABLED=false`. 따라서 OpsScheduler 타이머 경로가 동작한다.
- **캔들 sync**
  - `SCHEDULER_MARKET_CANDLE_SYNC_ENABLED=true`, 간격은 기본 600초다.
  - `SCHEDULER_MARKET_CANDLE_SYNC_ASSET_IDS`에 12개 ID가 있다.
  - 그중 10개는 증거 파일로 crypto임을 확인했다: BTC, ETH, BNB, SOL, XRP, DOGE, LINK, XLM, ZEC, TRX. 나머지 2개(`698abc13…`, `d5ff905c…`)는 확인하지 못했다.
- **꺼져 있는 것:** `CANDLE_RECONCILIATION_KRX_ENABLED`, `SCHEDULER_MARKET_CANDLE_LONG_SYNC_ENABLED`, `SCHEDULER_MARKET_CANDLE_RETENTION_ENABLED`는 env에 없다. 즉 모두 꺼져 있다.
- **캔들 서빙:** `CANDLE_SERVING_MODE=database`. on-demand 갱신은 기본값으로 켜져 있고 신선도 기준은 60초다.
- **인프라:** 인스턴스 1대. PostgreSQL은 0.5c-1g, 디스크 5GB, 자동 확장 꺼짐.

## 2. GPT 분석 검증

| # | GPT 조사 내용 | 판정 | 근거 | 보정 |
|---|---|---|---|---|
| 1 | 일 50,000건 / 월 1,000,000건 | 일 한도 헤더는 [사실]. 월 한도와 적용 단위는 [미검증] | 진단 응답 헤더. 잔여 카운터가 여러 흐름으로 관찰됐다. 공식 문서상 09:00 KST 초기화 | 단일 공용 풀로 보수 계산했다. **월 한도가 먼저 걸린다**: 최다 22세션 × 50,000 > 1,000,000 |
| 2 | 시장별 최대 20종목 배치 | 코드상 [사실] | [koscom.client.ts:48](../../../backend/src/providers/koscom/koscom.client.ts#L48). KONEX는 1종목씩 | 실측은 시장당 2종목 요청만 확인했다. 20종목 실요청은 1회 확인이 필요하다 |
| 3 | 현재가·호가를 같은 주기로, 기본 3초 | [사실] | [koscom-ingestion.service.ts:163](../../../backend/src/providers/koscom/koscom-ingestion.service.ts#L163), [koscom.config.ts:29](../../../backend/src/providers/koscom/koscom.config.ts#L29) | 실제 주기는 경로에 따라 다르다. 운영(라이브 꺼짐)은 [ops-scheduler.service.ts:84](../../../backend/src/ops/ops-scheduler.service.ts#L84)의 `setInterval(3s)`이고, 수집이 3초를 넘으면 그 틱을 건너뛰어 6초가 된다. 라이브 모드는 '수집 후 3초 대기'다 |
| 4 | 당일 캔들을 종목별 약 1분마다 조회 | 코드상 [사실]. **운영 경로 설명으로는 부정확** | [supervisor:229](../../../backend/src/realtime/live-candle-stream-supervisor.service.ts#L229), [:326](../../../backend/src/realtime/live-candle-stream-supervisor.service.ts#L326). `CANDLE_LIVE_STREAMING_ENABLED=true`일 때만 동작하는데, 기록상 운영은 false | 운영에서는 사용자 차트 조회 시의 관리형 on-demand 갱신이 사실상 국내 캔들 갱신 경로다. 자산·피드별로 60초마다 최대 1회 실행된다 (§4 F2) |
| 5 | 정기 sync가 5m·1d·1w를 반복 조회 | 코드상 [사실]이고, **서술보다 심하다** | [market-candle-sync.service.ts:1617](../../../backend/src/assets/market-candle-sync.service.ts#L1617), [:1107](../../../backend/src/assets/market-candle-sync.service.ts#L1107) | 600초마다 1d·1w를 **24시간·주말 포함** 다시 조회한다. 5m은 장 종료 후에도 13:15–15:30 구간을 자정까지 2회씩 다시 조회한다. 단, 운영에서는 대상이 12개 ID로 제한돼 국내 종목 대부분이 빠졌을 가능성이 크다 [추론] |
| 6 | 국내 실시간 호가는 화면에서 쓰지 않음 | [사실] (보강) | 프런트 호가 UI는 Binance 전용이다(`assetOrderBookPolicy.ts:10-11`). 백엔드에서 `koscom_krx_orderbook`을 읽는 코드와 FK가 모두 0개다. ERS 어댑터는 등록되어 있지 않다 | 최우선 호가(topOfBook)는 이미 현재가 응답의 `bidordPrc_1`/`askordPrc_1`로 받는다 ([koscom-normalizer.ts:116-131](../../../backend/src/providers/koscom/koscom-normalizer.ts#L116-L131)) |
| 7 | 가격·호가 스냅샷 저장량이 상당함 | 코드상 [사실]. 크기는 [미검증] | 호가는 매 주기 중복 확인 없이 insert된다([:351](../../../backend/src/providers/koscom/koscom-ingestion.service.ts#L351)). 가격은 체결시각이 바뀔 때마다 insert된다. 둘 다 원문 JSON을 함께 저장하고, 삭제 경로가 없다 | §7.4 추정 범위와 §12 측정 SQL 참고 |
| 8 | 장기 4h는 별도 수집·검증 경로 | [사실] | 10분봉 + dated 일봉 O/H/L/C 정확 일치 검증 | 기본 OFF이고 운영에서 아직 켜지지 않았다. held 세션은 매 실행마다 재조회된다. 저장된 `koscom_history` 1d에 의존한다 |
| 9 | 운영 활성 국내주식 15종목 | 문서상 [사실](KOSPI 12 / KOSDAQ 3) | KIND 시장 구분 확인 | 운영 DB 값은 미확인 |

**잔여량 관찰과 계산의 불일치 [추론]**

- 2026-10-12 21:43 KST 이후 관찰된 잔여량은 약 34,000이었다.
- 3초 주기와 단일 공용 풀을 가정하면 장중 사용량은 31,200건이고, 그러면 잔여량은 약 18,800 이하여야 한다. 관찰값과 맞지 않는다.
- 가능한 설명은 두 가지다. 하나만 성립해도 앞뒤가 맞는다.
  - **H1:** 실제 수집 주기가 약 6초로 밀려 있다. 이 경우 현재 운영 가격이 생각보다 오래됐을 수 있다.
  - **H2:** 카운터가 단일 풀이 아니다(노드별 또는 API 종류별).
- 두 가설은 모두 **KOSCOM 호출 없이** 판별할 수 있다(§12 Q2, Q7).
- 같은 관찰로 **과금이 종목 수가 아니라 요청 수 단위**라는 점도 추론된다. 종목 단위였다면 15종목 폴링만으로 하루 23만 건이 넘는다.

## 3. KOSCOM 호출 경로 전수 목록

'운영'은 기록된 설정 기준이다. 일 호출량은 현재 코드를 그대로 둔 수치다.

| # | 경로 | 트리거 | 운영 | 호출 단위 | 15종목 | 100종목 |
|---|---|---|---|---|---:|---:|
| 1 | 현재가 multiquote ([ingestion:163](../../../backend/src/providers/koscom/koscom-ingestion.service.ts#L163)) | 스케줄러 3초 타이머 또는 supervisor | 켜짐 | 시장별 20종목당 1회/주기 | 15,600 | 46,800 |
| 2 | 호가 multiquote | 1과 같음 | 켜짐 | 1과 같음 | 15,600 | 46,800 |
| 3 | 분봉 라이브 갱신 ([supervisor:274-345](../../../backend/src/realtime/live-candle-stream-supervisor.service.ts#L274-L345)) | 1분마다 종목당 1회, 09:00–15:40 | 꺼짐 | 1회/종목/분 | 6,000 | 40,000 |
| 4 | 정기 sync 5m | 600초마다 | 국내는 대부분 제외 [추론] | 실행당 1~2회, 09:00–24:00 | 2,466 | 16,440 |
| 5 | 정기 sync 1d / 1w | 600초마다 | 위와 같음 | 실행당 1회씩, 24시간·주말 포함 | 4,320 (+비거래일 4,320) | 28,800 (+28,800) |
| 6 | KRX reconciliation ([service](../../../backend/src/assets/market-candle-reconciliation.service.ts)) | 매일 16:00 | 꺼짐 | 5m 5창 + 1d 1회 | 90 | 600 |
| 7 | 라이브 finalizer 복구 ([finalizer:317-395](../../../backend/src/assets/live-candle-finalizer.service.ts#L317-L395)) | 미완성 버킷마다 60초 간격 재시도, 상한 없음 | 꺼짐 | 1회/버킷/분, 당일 한정 | 변동 | 변동 |
| 8 | **관리형 on-demand 갱신** ([candle-serving:308-347](../../../backend/src/assets/candle-serving.service.ts#L308-L347)) | **사용자 차트 조회**, DB 최신 행이 60초보다 오래됐을 때 | **켜짐** | 5m 1~2회, 1d·1w 1회 | 상한: 5m 8,775 + 1d·1w 43,200 | 상한: 58,500 + 288,000 |
| 9 | **직접 조회(legacy)** ([candle-serving:141](../../../backend/src/assets/candle-serving.service.ts#L141), [read-plan:125](../../../backend/src/assets/candle-read-plan.builder.ts#L125)) | `interval=1m`, 정책 범위 밖, cold baseline 비집계 | **켜짐** | 요청당 최대 5페이지, 캐시 기본 꺼짐 | 요청 수에 비례 | 요청 수에 비례 |
| 10 | 장 종료 가격 복구 recoverClose ([ingestion:410-493](../../../backend/src/providers/koscom/koscom-ingestion.service.ts#L410-L493)) | 장 종료 후 가격이 없는 종목 | 켜짐 | 누락 종목당 1회, 미완료 시 자정까지 60초마다 재시도 | 보통 0 | 보통 0 |
| 11 | LOC 종가 증거 ([settlement:186-215](../../../backend/src/orders/limit-on-close-settlement.service.ts#L186-L215)) | LOC 주문이 있는 종목·세션, 300초 간격, 최종 확정까지 | LOC 플래그에 따름 | 정상 2회, 최대 약 32회 | ≤30 | ≤200 |
| 12 | 장기 4h ([long-sync:594](../../../backend/src/assets/market-candle-long-sync.service.ts#L594)) | 900초마다, 장중 제외 | 꺼짐 | 누락 세션당 1회, held 세션은 매 실행 재시도, 실행당 ≤60 | 15 | 100 |
| 13 | 시장 목록 ([market-map:144](../../../backend/src/providers/koscom/koscom-market-map.service.ts#L144)) | Redis 6시간 캐시 | 켜짐 | 3회/6시간. 한 시장이 실패하면 30초마다 재조회 | 12 | 12 |
| 14 | 재시도 ([client:186-187](../../../backend/src/providers/koscom/koscom.client.ts#L186-L187)) | network·timeout·5xx | 켜짐 | 500ms 뒤 1회. 과금된다고 가정 | +1~2% | +1~2% |

중복 조회도 여러 곳에 있다.

- 당일 일봉(history D)을 서로 다른 세 경로가 따로 가져온다: 1d sync, recoverClose, LOC 증거.
- 5m은 라이브 갱신, 정기 sync, reconciliation, on-demand가 같은 1분봉 구간을 겹쳐서 다시 조회한다.
- LOC 증거는 금융 증거로서 독립 관측이 정책상 필요하다. 그래서 이 중복은 유지한다.

## 4. 실제 코드에서 발견한 추가 결함

| ID | 심각도 | 결함 | 근거 | 영향 |
|---|---|---|---|---|
| F1 | 높음 | 국내 호가를 매 주기 수집·저장한다. 읽는 곳이 0개이고, 중복 확인도 보존 정책도 없다 | [ingestion:163,351](../../../backend/src/providers/koscom/koscom-ingestion.service.ts#L351) | 시세 호출의 50%가 쓰이지 않는다. DB 증가의 절반 이상을 차지한다 |
| F2 | 높음 | 사용자 요청이 KOSCOM 호출을 일으킨다. 관리형 경로는 자산·피드별 60초마다 최대 1회이고, 1d·1w는 야간·주말도 포함된다. 직접 조회 경로(1m, 정책 범위 밖)는 캐시와 사용자별 제한이 없다 | [serving:308-347](../../../backend/src/assets/candle-serving.service.ts#L308-L347), [config:49-56](../../../backend/src/assets/candle-serving.config.ts#L49-L56), [koscom-candle-reader](../../../backend/src/assets/koscom-candle-reader.service.ts) | 사용자가 늘수록 호출이 상한(100종목 기준 하루 수십만 건)까지 늘 수 있다. 인증된 클라이언트 하나가 `interval=1m` 반복 요청으로 한도를 소진할 수 있다. 같은 5 req/s 입장 제한을 쓰므로 가격 폴링도 지연된다 |
| F3 | 높음 | 기존 설계는 100종목에서 처리량을 넘는다. 평균 6.49 req/s로 간격 한도 5 req/s의 130%이고, 매 분 첫 20초에는 9 req/s를 요구한다 | §7.3 | 대기열과 `KOSCOM_QUEUE_TIMEOUT`이 생기고 가격 주기가 늘어난다. 그러면 10초 체결 신선도를 위반한다 |
| F4 | 높음 | 보존 정책이 없다: 가격·호가 스냅샷, `market_candle_sync_states`, 5m(운영에서 보존 작업이 꺼져 있음) | 보존 작업 목록, [sync:651](../../../backend/src/assets/market-candle-sync.service.ts) `createRunning` | 기록상 디스크 5GB(§7.4). 가격 스냅샷은 `RESTRICT` FK 8개가 참조하므로 정리 작업은 참조를 고려해야 한다 |
| F5 | 높음 [추론] | 1d 유지에 기대는 기능이 많다: 전일대비([daily-change-rate:80-110](../../../backend/src/assets/daily-change-rate.service.ts#L80-L110)), 4h 검증, 1d 탭. 그런데 운영 sync 대상이 국내를 제외했을 수 있다 | §1 | 아무도 1d 탭을 열지 않은 종목은 다음 날 전일대비가 null일 수 있다. 4h를 켜도 증분이 `DAILY_REFERENCE_UNAVAILABLE` 상태로 남는다 (§12 Q4·Q5로 확인) |
| F6 | 중간 | KOSCOM 폴링 타이머가 **인스턴스마다** 돈다. lease는 겹침만 막고 주기는 공유하지 않는다 | [ops-scheduler:74-86](../../../backend/src/ops/ops-scheduler.service.ts#L74-L86) | 배포 중 겹치는 시간과 스케일아웃 때 인스턴스 수만큼 호출이 늘어난다 |
| F7 | 중간 | 전역 `CANDLE_LIVE_STREAMING_ENABLED`가 KOSCOM 경로를 바꾼다. KOSCOM 폴링이 켜진 상태에서 이 플래그를 켜면 둘 중 하나가 된다. ① `CANDLE_RECONCILIATION_KRX_ENABLED`가 없으면 운영에서 **앱이 기동을 거부**한다. ② 그 플래그가 있으면 supervisor로 전환되면서 분당 종목별 조회가 자동으로 시작된다 | [supervisor:125](../../../backend/src/realtime/live-candle-stream-supervisor.service.ts#L125), [ops-scheduler:79](../../../backend/src/ops/ops-scheduler.service.ts#L79), [live-candle.config:220-243](../../../backend/src/assets/live-candle.config.ts#L220-L243) | Binance 라이브 캔들 하나를 켜려다 배포가 실패하거나, 국내 호출이 15종목 기준 +6,000, 100종목 기준 +40,000건/일(KRX reconciliation +6/종목 별도) 늘어난다. 다른 시장 설정이 국내 정책을 바꾸는 셈이다 |
| F8 | 중간 | 상한 없는 재시도 3곳: ① finalizer pending은 60초마다, 시도 수 제한이 없다. 당일에는 1회씩 호출하고, 자정 이후에는 호출 없이 sync-state 행만 영구적으로 만든다 ② recoverClose는 자정까지 60초마다 재시도하고, 시도마다 전체 COUNT(*)를 2회 실행한다 ③ long sync는 held 세션을 실행마다 다시 조회한다(≤60/실행) | [finalizer:385](../../../backend/src/assets/live-candle-finalizer.service.ts#L385), [ingestion:493](../../../backend/src/providers/koscom/koscom-ingestion.service.ts#L493), [long-sync:594](../../../backend/src/assets/market-candle-long-sync.service.ts#L594) | 거래정지 종목, 체결 없는 분, VI 구간이 지속적인 호출 누수와 DB 증가를 만든다 |
| F9 | 중간 | 정기 sync가 같은 데이터를 다시 가져온다(§2 #5). 실행마다 sync-state 행을 새로 만든다 | [sync:1617](../../../backend/src/assets/market-candle-sync.service.ts#L1617) | 국내를 포함하면 하루 43,200행(100종목) |
| F10 | 중간 | 가격 요청 timeout은 5초이고 500ms 뒤 재시도한다. 그러면 한 주기를 넘기고, 다음 주기와 중복 과금된다 | [config:30](../../../backend/src/providers/koscom/koscom.config.ts#L30), [client:186](../../../backend/src/providers/koscom/koscom.client.ts#L186) | 장애 때 호출이 2배가 되고, 그 배치의 가격이 오래된 상태로 남는다 |
| F11 | 중간 | 예산 관리가 없다. 한도 헤더는 파싱하지만([client:287-296](../../../backend/src/providers/koscom/koscom.client.ts#L287-L296)) 장기 백필의 예비분에만 쓴다. 429가 오면 10초 쿨다운을 반복한다 | — | 한도 소진에 대비한 단계적 기능 제한이 없다 |
| F12 | 낮음 | health 검사가 `assetPriceSnapshot.count()`로 전체 행 수를 센다 | [health:221](../../../backend/src/providers/market-snapshot-health.service.ts#L221) | 스냅샷이 늘어날수록 느려진다 |
| F13 | 낮음 | 입장 대기가 25ms 간격 Redis polling이다. 대기자 하나당 약 120 ops/s | [client:298-340](../../../backend/src/providers/koscom/koscom.client.ts#L298-L340) | Redis 부하 |
| F14 | 낮음 | 수집 lease가 60초다. 비정상 종료 시 최대 60초 동안 아무도 수집하지 못한다 | [ingestion:105-108](../../../backend/src/providers/koscom/koscom-ingestion.service.ts#L105-L108) | 그동안 체결이 불가하다(fail-closed라 안전하지만 체감된다) |
| F15 | 낮음 | 시장 목록 하나가 계속 실패하면 30초마다 다시 조회한다 | [market-map:169](../../../backend/src/providers/koscom/koscom-market-map.service.ts#L169) | 최대 약 2,880건/일 |
| F16 | 낮음 | `KOSCOM_POLL_INTERVAL_MS`가 범위(1000–60000)를 벗어나면 경고 없이 3000으로 돌아간다 | [config:29](../../../backend/src/providers/koscom/koscom.config.ts#L29) | 설정 실수가 드러나지 않는다 |
| F17 | 정책 한계 | 유동성 의존: ① 마지막 체결이 5분을 넘으면 가격 행을 거부한다(`KOSCOM_STALE_PRICE`) ② 마지막 체결 10초 뒤부터 시장가 체결이 불가하다 ③ 1분 행이 하나라도 빠지면(무체결, VI 단일가) 5m과 그 상위 15m/30m/1h·당일 4h 버킷이 모두 결손된다 | [normalizer:89](../../../backend/src/providers/koscom/koscom-normalizer.ts#L89), [policy:774-796](../../../backend/src/providers/source-eligibility.policy.ts#L774-L796), [builder:93](../../../backend/src/providers/kis/candles/kis-domestic-five-minute.builder.ts#L93) | 폴링 주기와 무관한 결함이다. **100종목 선정 기준에 유동성을 넣어야 한다** |

## 5. 설계 대안 비교 (100종목)

| 안 | 구성 | 호출/거래일 (5–6배치) | 일 한도 | 최악 월 | 체결 신선도 여유 | 캔들 갱신 | 위험 |
|---|---|---:|---:|---:|---|---|---|
| S0 운영 그대로 | 현재가+호가 3초, 캔들은 사용자 조회 시 갱신 | 79k–95k | 158–190% | 208% | 크다 | 조회 시 갱신 | 한도 초과, DB 폭증, 사용자 수에 연동 |
| S1 기존 코드 전부 켬 | +분당 분봉, sync, reconciliation, 4h | 166k–182k | 332–363% | 426% | 처리량 초과로 붕괴 | 1분 | 처리량 130%, 한도 3.6배 |
| S2 GPT안 | 현재가 6초, 호가 중단, 분봉 3분마다, 1d 장후, 1w 중단 | 33.7k–37.6k | 67–75% | 83% | L ≤ 2.5초에서만 100% | 3~4분 | 1w 탭 회귀, 6초 여유 부족 |
| **R 권장** | 현재가 5초 고정, 호가 중단, 1분봉은 버킷당 1회, 장후 1d/1w/4h, 진행 중 1d는 5m에서 합성 | **32.3k–37.0k** | **65–74%** | **71–81%** | L ≤ 3.5초에서 100% | 완성 5m은 버킷 종료 후 약 1~3분 | KOSCOM 지연·누락 실측이 필요 |
| R(6s) | R과 같고 현재가만 6초 | 28.4k–32.3k | 57–65% | 62–71% | L ≤ 2.5초 | 위와 같음 | L 측정 후 선택 |
| S4 최소 | 현재가 8초, 캔들은 장 종료 후만 | 15.6k–18.6k | 31–37% | 41% | L ≤ 0.5초 (사실상 불가) | 장 종료 후 | 시장가·조건부 체결 실패가 잦다 |

GPT안과 권장안은 비용이 비슷하다. 차이는 예산을 **어디에 쓰느냐**다.

- GPT안은 형성 중인 캔들의 신선도(3분)를 우선한다.
- 권장안은 체결 판정의 가격 신선도(5초)를 우선한다.
- 이유: 체결 신선도는 금융 기능의 성공·실패를 가르는 하드 기준(10초, env로 바꿀 수 없음)이다. 반면 형성 중 캔들은 표시 품질 문제다.

## 6. 권장 설계 (R) 상세

### R1 현재가 수집
- **대상과 주기**
  - multiquote **현재가만** 수집한다.
  - **5초 고정 주기**로 돌린다. 직전 수집 종료와 무관하게 시작 시각을 고정한다.
- **클러스터 전체에서 한 번만 실행** (F6 해결)
  - Redis 슬롯 키(`SET NX PX`, 예: `koscom:{ns}:price-slot:{floor(now/5s)}`)를 인스턴스의 1초 틱이 선점한다.
  - 기존 수집 lease는 겹침 방지용으로 계속 쓴다.
- **요청 처리**
  - 가격 요청 timeout은 2.5초다.
  - 주기 안에서는 재시도하지 않는다. 다음 슬롯이 재시도 역할을 한다(F10 해결).
  - 가격 요청에 우선 레인을 준다. 백그라운드 캔들 작업은 동시성 1로 돌리고, 가격 주기 중에는 대기한다.
- **저장**
  - 기존 규칙을 유지한다: 체결시각이 전진할 때만 insert하고, 이벤트를 발행하고, 신선도 판정은 그대로다.
  - `rawPayloadJson`은 필요한 필드로 줄인다: `accTrdval`(회전율 정렬), `trdDd`, `trdTm`, `trdPrc`, `cmpprevdd*`, 최우선호가, `accTrdvol`. 이때 `truncated:false`가 보장돼야 한다([asset-list-turnover.ts:36](../../../backend/src/assets/asset-list-turnover.ts#L36)).
- **유니버스 조건**
  - KONEX는 제외한다. 종목당 1회씩 따로 호출해야 하기 때문이다.
  - **KOSPI·KOSDAQ 종목 수를 20의 배수**(예: 60/40, 80/20)로 맞추면 6배치가 5배치로 줄어 하루 4,680건을 아낀다.
- **주기 선택 규칙.** 측정한 L_p99(체결→수신 지연)와 J_p99(주기 흔들림)에 대해 `T + J + L ≤ 9초`를 만족하는 가장 큰 T를 고른다. 1초는 시계 오차 여유다.
  - T=6초: L_p99 ≤ 1.5초
  - T=5초: L_p99 ≤ 2.5초
  - T=4초: L_p99 ≤ 3.5초. 이때는 분봉을 10분 주기로 바꿔야 100종목이 월 80% 안에 들어온다 (§7.1 표).

### R2 호가
- 정기 수집과 저장을 중지한다. 새 플래그를 두고 기본값을 false로 한다.
- 코드와 운영자 dry-run 경로는 남긴다. 나중에 ERS 등에 필요하면 플래그로 다시 켠다.
- 이미 쌓인 `koscom_krx_orderbook` 행에는 FK가 없다. 정리는 운영 데이터 삭제이므로 **별도 승인**을 받아 야간에 일괄로 처리한다.

### R3 장중 1분봉 → 5분봉
- **조회 방식**
  - 5분 버킷 종료 +70초에 전 종목을 1회씩 조회한다. 기존 [`ingestDomesticFiveMinuteCandles`](../../../backend/src/assets/market-candle-ingestion.service.ts)를 쓰므로 sync-state 행이 생기지 않는다.
  - 창은 직전 2개 버킷(≤11행, 1페이지)이다.
  - 호출은 60~120초에 걸쳐 분산한다(≤1 req/s).
- **완전성**
  - 각 버킷은 장중에 최소 2번 조회된다.
  - 미완성 버킷은 저장하지 않는다. 기존 빌더의 '5개 연속 1분' 규칙을 그대로 유지한다.
- **비용:** 종목당 79회/일, 100종목 7,900건.
- 3분 주기 대안은 +5.3천 건/일이다. 5초 현재가와 함께 쓰면 최악 월 93%라 권장하지 않는다.
- 국내 `asset_candle` WebSocket 반영은 선택 과제다. 현재 운영에도 국내 라이브 캔들이 없으므로 넣지 않아도 회귀가 아니다.

### R4 장 종료 후 KRX 일괄 작업
기존 Ops 작업 틀(DB 잠금, 멱등)을 쓴다.

- **15:31–15:45** 마지막 버킷들을 1회 스윕한다.
- **누락 버킷 표적 복구**
  - DB에서 당일 미완성·누락 버킷만 골라 95분 창으로 묶는다.
  - 종목당 3회 이하, 전역 상한(예: 300), 버킷당 최대 2회 시도.
  - **당일 안에 끝내야 한다.** 어댑터가 당일 데이터만 신뢰하기 때문이다([adapter:86](../../../backend/src/providers/koscom/koscom-candle.adapter.ts#L86)).
- **1d**
  - 15:50 이후 당일 history D를 요청하고 `trdDd` 일치를 검증해 저장한다.
  - 아직 제공되지 않으면 16:30과 18:00에 다시 시도한다.
  - 이 값은 다음 날 전일대비, 1d 탭, 4h 검증의 입력이다.
- **1w:** 1d를 저장한 뒤 종목당 1회 조회한다. 앱의 1w 탭에 필요하다.
- **4h:** 기존 long sync를 쓴다(종목·세션당 1회). held 세션에는 백오프를 둔다: 다음 거래일에 1회 더 시도하고, 그 뒤에는 운영자가 처리한다.
- **LOC 증거:** 정책을 그대로 둔다.
- **recoverClose:** 종목·일당 시도 상한을 둔다. COUNT 조회는 쓰지 않는다.

### R5 진행 중인 1d/1w 봉
- 당일 저장된 완성 5m을 읽는 시점에 합성한다. 4h 현재 버킷과 같은 방식이고, 호출은 0회, 지연은 최대 약 6~7분이다.
- 장 종료 후 확정 1d가 저장되면 그것으로 대체한다.
- 대안으로 매시 1d를 조회할 수 있다(+700건/일). 하지만 최대 60분 묵은 미확정 봉을 현재 봉처럼 보여주게 되므로 권장하지 않는다.

### R6 사용자 요청에서 KOSCOM 호출 차단 (KRX만, F2 해결)
- 관리형 on-demand 갱신에서 KRX의 provider 호출을 멈춘다. DB에서 서빙하고, 오래된 데이터에는 신선도 메타데이터를 붙인다.
- KRX의 `1m`, 정책 범위 밖, cold baseline 직접 조회는 막는다(4xx/503). 또는 운영자 전용으로 둔다. 앱은 1m을 요청하지 않는다.
- US와 crypto는 바꾸지 않는다.
- **결합 주의:** 중앙 작업이 5분마다 갱신하면 기존 60초 신선도 기준 때문에 조회 시 on-demand가 계속 실행된다. 그래서 R3·R4와 R6은 **반드시 함께** 적용해야 한다.

### R7 예산 관리자 (F11 해결)
- **집계**
  - Redis INCR 카운터를 쿼터일(09:00 KST 경계)과 월 단위로 두고 카테고리별로 센다: price, minute, post_close, backfill, loc, lists.
  - 응답 헤더의 잔여량과 비교해 **더 보수적인 값**을 쓴다.
- **단계적 제한**
  - 70%: 경보
  - 80%: 백필과 선택 작업 중지
  - 90%: 분봉을 10분 주기로
  - 95%: 현재가를 10초로. 이때 시장가 체결은 fail-closed로 제한된다.
  - 98%: 장후 필수 작업(1d, LOC)만 수행
- 월 한도는 `남은 월 예산 ÷ 남은 거래일`로 하루 예산을 정한다.

### R8 DB
- 호가 행 생성을 중단한다.
- 가격 원문 JSON을 줄인다.
- sync-state 행을 보존 기간(예: 7일) 뒤 정리한다.
- 5m 보존 작업을 켤지 검토한다.
- 가격 스냅샷의 **참조 인지형 보존**은 별도 설계로 다룬다. 고려할 점:
  - RESTRICT FK 8개
  - `futures_season_prices.asset_price_snapshot_id`에 인덱스가 없음
  - 세션 종가 증거와 일별·시즌 평가가 읽는 행은 유지해야 함
- health의 COUNT를 추정치로 바꾼다.

### R9 결합 분리 (F6·F7 해결)
- KOSCOM 루프를 전역 live 플래그에서 떼어 내고, KOSCOM 전용 플래그로 제어한다.
- 슬롯 키를 써서 인스턴스 수와 무관하게 주기를 한 번만 실행한다.
- KRX reconciliation 필수 조건은 KOSCOM 라이브 모드에만 적용한다.

### 선택 이유와 트레이드오프
| 결정 | 이유 | 대가 |
|---|---|---|
| 현재가 5초 (6초 아님) | 체결 10초 판정이 거래소 체결시각 기준이고 L이 미측정이다 | 6초보다 +4,680건/일. L 측정 후 완화할 수 있다 |
| 분봉은 버킷당 1회 | 완성 5m 품질은 같다(각 2회 시도). 비용은 3분 주기의 60% | 형성 중 캔들 표시가 최대 약 6분 늦다 |
| 진행 중 1d를 5m에서 합성 | 호출 0회, 검증된 원천만 사용 | 서빙 코드 변경. 장중 일봉에 종가 단일가가 빠진다(장후 확정 봉으로 대체) |
| KRX on-demand 차단 | 사용자 수가 호출로 이어지는 연결을 끊는다 | 중앙 작업이 실패하면 차트가 스스로 복구되지 않는다. 경보가 필요하다 |
| 호가 중단 | 사용처 0, 호출 50%, DB 절반 이상 | 향후 ERS는 다시 켜야 한다(플래그) |

## 7. 예상 호출량·갱신 지연·처리량·DB 부담

### 7.1 호출량 (Python 계산, 거래일 기준, 최악 월 = 22세션 + 비거래일 9일)

배치 수는 KOSPI/KOSDAQ 분포에 따라 달라진다. KONEX는 제외했다.

| N | 가능한 배치 수 | 예 |
|---:|---|---|
| 15 | 1–2 | 현재 12/3 → 2 |
| 25 | 2–3 | 20/5 → 2, 21/4 → 3 |
| 50 | 3–4 | 40/10 → 3, 45/5·25/25 → 4 |
| 100 | 5–6 | 80/20·60/40 → 5, 70/30·61/39·50/50 → 6 |

**R (현재가 5초, 버킷당 분봉, 진행 중 1d/1w는 합성)**

| N | 호출/거래일 | 일 한도 | 최악 월 | 월 한도 |
|---:|---:|---:|---:|---:|
| 15 | 6,022–10,702 | 12–21% | 235,556 | 24% |
| 25 | 11,589–16,269 | 23–33% | 358,026 | 36% |
| 50 | 18,486–23,166 | 37–46% | 509,760 | 51% |
| 100 | 32,280–36,960 | 65–74% | 813,228 | 81% |

100종목·6배치 기준 R의 구성은 다음과 같다.

- 현재가: 28,080
- 분봉: 7,900
- 누락 복구 상한: 300
- 장후 1d(재시도 10% 포함): 110
- 1w: 100
- 4h: 100
- LOC: ≤200
- 시장 목록: 12
- 캔들 재시도: 158
- **합계: 36,960건.** 5배치면 32,280건이다.

**월 80% 이내에 들어가는 최대 종목 수**

| 현재가 | 분봉 주기 | 유리한 분포 | 불리한 분포 | 100종목 월 사용률 (유리/불리) |
|---|---|---:|---:|---:|
| 4초 | 5분 | 80 | 80 | 84% / 97% |
| 4초 | 10분 | 100 | 81 | 75% / 88% |
| **5초** | **5분** | **100** | **93** | **71% / 81%** |
| 6초 | 5분 | 120 | 102 | 62% / 71% |

해석:
- 5초 주기로 100종목을 운영하면서 월 80% 아래를 지키려면 **5배치 분포(20의 배수)**가 필요하다.
- L이 커서 4초가 필요하다면 분봉을 10분으로 늦추거나 종목 수를 80 수준으로 줄여야 한다. 아니면 계약 한도를 늘려야 한다.

**일회성 백필 (15 → 100종목, 신규 85종목)**
- 4h(97세션): 8,245건
- 1d(1년): 255건
- 1w: 85건
- 합계 **8,585건**
- 평일 밤의 여유는 R@100(6배치) 기준 약 5.5천 건(일 85% 기준)으로 빠듯하다. **주말 쿼터일**에 하루 약 4.2만 건 여유가 있으므로 하루 이틀이면 끝난다. 월 한도에는 1% 미만이다.
- 5m 과거 백필은 선택 사항이다. 10세션이면 4,250건인데, 당일 외 1분봉을 날짜 검증하는 경로를 새로 구현해야 한다.

### 7.2 갱신 지연

이 절의 기호:
- L: KOSCOM 체결→수신 지연
- J: 주기 흔들림
- D: 수집 소요 시간

**시장가 체결 판정이 통과하는 시간 비율 (유동성 높은 종목)**

| 주기 (최악 간격) | L=0.5초 | 1초 | 2초 | 3초 | 4초 | 5초 |
|---|---:|---:|---:|---:|---:|---:|
| 고정 3초, J=1 (4초) | 100% | 100% | 100% | 100% | 100% | 100% |
| **고정 5초, J=1.5 (6.5초)** | 100% | 100% | 100% | 100% | 92% | 77% |
| 고정 6초, J=1.5 (7.5초) | 100% | 100% | 100% | 93% | 80% | 67% |
| 수집 후 6초 대기, D+J=3 (9초) | 100% | 100% | 89% | 78% | 67% | 56% |
| 고정 10초, J=1.5 (11.5초) | 83% | 78% | 70% | 61% | 52% | 43% |

- 판정 기준은 두 가지다([policy:774-796](../../../backend/src/providers/source-eligibility.policy.ts#L774-L796)).
  - `capturedAt` 기준: 경과 초를 내림해서 10을 넘으면 실패.
  - KRX는 추가로 `effectiveAt`(거래소 체결시각) 기준: 10초 초과면 실패. 이쪽이 더 엄격하다.
- 화면 가격 지연은 대략 `T + D + L`이다. 5초 주기에서 약 6.5~8.5초로, 10초 목표 안이다.
- 지정가 경로 A의 '제출 이후 체결' 대기는 현재 3초에서 5초로 바뀌면 약 2초 늘어난다. 최악은 `T + D + 매처 5초`다.
- 체결이 드문 종목은 **폴링 주기와 무관하게** 마지막 체결 10초 뒤부터 시장가 체결이 불가하다. 기존 정책이고 바꾸지 않는다.

### 7.3 처리량

| 안 | 장중 평균 req/s | 간격 한도(5/s) 대비 | 2슬롯이 포화되는 평균 지연 |
|---|---:|---:|---:|
| S1 100종목 | 6.49 | **130%** | 0.31초 |
| S2 100종목 | 1.59 | 32% | 1.26초 |
| R 100종목 | 1.57 | 31% | 1.27초 |

- S1은 매 분 첫 20초에 9 req/s를 요구한다. 구조적으로 불가능하다.
- R의 가격 주기 수집 시간 D는 6배치, 2슬롯, 배치당 저장 0.3초를 가정해 계산했다.

  | 평균 지연 | D |
  |---:|---:|
  | 0.15초 | 1.4초 |
  | 0.3초 | 1.8초 |
  | 0.6초 | 2.7초 |
  | 1.0초 | 3.9초 |
  | 1.5초 | 5.4초 |

  **평균 지연이 약 1.3초를 넘으면 5초 주기를 지키지 못한다.** 이 경우 `KOSCOM_MAX_CONCURRENCY`를 3~4로 올린다(허용 범위 안). 다만 D가 커지면 그만큼 체결 신선도 여유도 줄어든다.
- KOSCOM 응답 지연 분포는 아직 실측되지 않았다.

### 7.4 DB 부담 (행 크기는 미측정 가정: 가격 0.4~2.0KB, 호가 0.9~3.0KB, 인덱스 포함)

| 상황 | 가격 행/일 | 호가 행/일 | MB/거래일 |
|---|---:|---:|---:|
| 운영 그대로, 15종목, 3초 | 111,150 | 117,000 | 146–560 |
| 운영 그대로, 100종목, 3초 | 741,000 | 780,000 | 975–3,732 |
| R 100종목, 5초 | 444,600 | 0 | 174–868 |
| R 100종목, 5초, 원문 축소(0.35~0.6KB) | 444,600 | 0 | 152–261 |

- 정기 sync에 KRX를 넣으면 sync-state 행이 100종목 기준 43,200행/일 생긴다. R의 분봉 경로에서는 0행이다.
- 5m 캔들은 100종목 기준 7,600행/일, 4h는 200행/일이다.
- **결론:** 호가 중단만으로는 부족하다. 100종목·5초에서는 가격 스냅샷만으로 하루 약 44만 행(174~868MB)이 쌓인다. 따라서 **원문 축소와 참조 인지형 보존을 함께** 하거나, DB 디스크·플랜을 증설해야 한다.

## 8. 5분봉 완전성, 장애 복구, 재시작, 동시성

**5분봉 완전성**
- R은 각 버킷을 장중 2회 조회하고, 장후 같은 날 표적 복구를 한다. 수집 주기를 늘려도 **빌더 규칙(5개 연속 1분)은 그대로**이고, 보간이나 합성은 하지 않는다.
- KOSCOM 1분 행의 공개 지연(+70초 가정)은 아직 실측되지 않았다. 늦게 공개되더라도 다음 주기(+5분)가 그 버킷을 다시 덮는다.
- 무체결 분이나 VI 단일가처럼 공급자에 행이 없는 분은 영구 결손이다.
  - 결손은 15m/30m/1h·당일 4h(5m 집계분)까지 번진다.
  - 4h는 장후 10분봉 검증 행이 따로 저장되므로 회복된다.
  - 이것은 유동성 문제이므로 **종목 선정 기준**으로 다룬다. 저유동 후보 종목의 1분 행 누락률을 장 종료 후 표본으로 측정한다(§12 Q8).
- 자정 제약: 어댑터는 당일 1분봉만 신뢰한다. 그래서 복구는 당일 안에 끝나야 한다. 다음 날 복구를 하려면 날짜를 검증하는 과거 1분봉 경로를 새로 만들어야 한다. 1차 실측에서 약 60세션 전까지 데이터가 제공됐지만, 날짜를 독립적으로 증명하지는 못했다.

**장애 복구**
- 가격은 재시도하지 않고 다음 슬롯에 맡긴다.
- 연속 실패가 3주기 이어지면 15 → 30 → 60초로 백오프한다(서킷 브레이커).
- 429가 오면 기존 공유 쿨다운을 쓰고 예산 관리자에 반영한다.
- 가격이 오래되면 체결 API가 `PRICE_STALE`/`ASSET_PRICE_UNAVAILABLE`(503)을 돌려준다. fail-closed이며 기존과 같다.
- 복구된 뒤에는 2버킷 창과 장후 복구로 당일 공백을 메운다.

**재시작·배포 겹침**
- 슬롯 키 방식이므로 살아 있는 어떤 인스턴스든 다음 슬롯을 실행한다. lease를 넘겨받을 때 생기던 공백이 없다.
- 수집 lease TTL은 60초에서 약 20초로 줄이고 5초마다 갱신한다(F14).
- 분봉 작업은 upsert라 멱등이다. 닫힌 KIS 행 보존 규칙도 유지된다.
- 장후 작업은 Ops DB 잠금 아래에서 돌고, DB 상태를 기준으로 재개한다.

**동시성**
- 가격 주기는 lease로 한 번에 하나만 돈다.
- 백그라운드 레인은 동시성 1이다.
- 복구는 기존 자산·피드별 백필 잠금을 재사용한다.
- 인스턴스가 N대가 돼도 슬롯 수는 같으므로 호출 수도 같다.

## 9. 변경이 필요한 영역과 영향 범위

| 영역 | 파일 | 변경 | 영향 범위 |
|---|---|---|---|
| 설정 | [koscom.config.ts](../../../backend/src/providers/koscom/koscom.config.ts) | 호가 플래그(기본 off), 가격 timeout, 분봉 모드, 예산·임계치, 범위 밖 값 경고 | KRX만 |
| 수집 | [koscom-ingestion.service.ts](../../../backend/src/providers/koscom/koscom-ingestion.service.ts) | 수집 종류를 플래그로 제어, 원문 축소, recoverClose 상한, lease TTL | KRX만 |
| 클라이언트 | [koscom.client.ts](../../../backend/src/providers/koscom/koscom.client.ts) | 카테고리별 카운터, 예산 관리자, 우선 레인, 호출자별 재시도 정책 | KRX만 |
| 스케줄 | [ops-scheduler.service.ts](../../../backend/src/ops/ops-scheduler.service.ts) | 슬롯 키 가격 주기, 분봉 작업, 장후 KRX 작업 | KRX만. 다른 Ops 작업은 그대로 |
| 라이브 결합 | [live-candle-stream-supervisor.service.ts](../../../backend/src/realtime/live-candle-stream-supervisor.service.ts), [live-candle.config.ts](../../../backend/src/assets/live-candle.config.ts) | KOSCOM을 전역 live 플래그에서 분리 | Binance/KIS 동작은 그대로 |
| 서빙 | [candle-serving.service.ts](../../../backend/src/assets/candle-serving.service.ts), [candle-read-plan.builder.ts](../../../backend/src/assets/candle-read-plan.builder.ts), [candle-database.loader.ts](../../../backend/src/assets/candle-database.loader.ts) | KRX on-demand/직접 조회 차단, 진행 중 1d/1w 합성 | KRX만. US/crypto 경로는 그대로 |
| 정기 sync | [market-candle-sync.service.ts](../../../backend/src/assets/market-candle-sync.service.ts) 또는 env 대상 | KRX는 10분 sync에서 빼고 장후 작업으로 옮김 | crypto/US 주기는 그대로 |
| 장기 4h | [market-candle-long-sync.service.ts](../../../backend/src/assets/market-candle-long-sync.service.ts) | held 백오프 | KRX만 |
| 복구 큐 | [live-candle-finalizer.service.ts](../../../backend/src/assets/live-candle-finalizer.service.ts) | 시도 상한·기한 | 모든 시장(안전 방향) |
| health | [market-snapshot-health.service.ts](../../../backend/src/providers/market-snapshot-health.service.ts) | COUNT를 추정치로 | 진단만 |
| 보존 | 신규 Ops 작업 | 호가(FK 없음), sync-state, 이후 가격 스냅샷(참조 인지형) | 스키마 변경 없이 가능. 가격 스냅샷은 별도 검토 |
| 문서 | `koscom-market-data.md`, `candle-live-operations.md`, `scheduler-ops-foundation.md` | 운영 계약 갱신 | — |
| 프런트 | 없음 | — | API 계약은 `/api/v1` 그대로 |

**바꾸지 않는 것**
- 주문·체결·지갑·원장·시즌·랭킹 계산
- 신선도 임계값(표시 300초, 견적 60초, 체결 10초)
- 견적 TTL 15초
- LOC 증거 규칙
- 지정가 A/B 경로, 조건부 주문 규칙
- 미국·암호화폐·선물 수집 정책

## 10. 구현 시 반드시 지킬 안전 불변조건

1. 체결 10초·견적 60초·표시 300초 판정과 그 시계 기준(`capturedAt`, KRX `effectiveAt`)을 바꾸지 않는다. 주기를 바꿀 때는 측정된 L로 검증한다.
2. 가격 스냅샷은 KOSCOM 응답에서만 만들고, 체결시각이 전진할 때만 insert한다. 오래된 응답, 날짜가 다른 응답, 미래 시각 응답은 지금처럼 거부한다.
3. 캔들은 검증된 원천에서만 만든다.
   - 5m은 1분 행 5개가 모두 있어야 한다.
   - 1d는 `trdDd`가 일치하고 장 종료 후 관측된 것이어야 한다.
   - 4h는 10분봉과 dated 일봉이 정확히 일치해야 한다.
   - 보간과 현재가 기반 합성은 금지한다. 진행 중 봉은 '미확정'으로 남긴다.
4. 사용자 요청과 WebSocket 구독은 KRX 공급자 호출을 일으키지 않는다. 호출량은 종목 수와 시각에만 의존해야 한다.
5. 인스턴스 수가 늘어도 주기당 호출 수는 같아야 한다.
6. 일·월 예산 카운터는 모든 시도를 센다(재시도 포함). 임계치에 따라 정해진 순서로 기능을 제한하고, 한도를 넘는 호출은 하지 않는다.
7. 장애가 나면 fail-closed다. 오래된 가격으로 체결하지 않는다. 휴장과 '상태 확인 불가'를 구분한다(`unknown`은 `closed`가 아님).
8. 가격 스냅샷 보존은 RESTRICT FK가 참조하는 행과 세션 종가 증거 행을 지우지 않는다. 일괄 삭제가 FK 오류로 중단되지 않게 참조를 확인하며 배치로 처리한다.
9. 닫힌 KIS 과거 행은 KOSCOM import로 덮어쓰지 않는다(기존 규칙).
10. 휴장일에는 1분봉·10분봉·일봉을 요청하거나 저장하지 않는다. 휴장일 요청에 직전 세션 데이터가 그대로 돌아오는 것이 실측됐다.
11. 재시도에는 모두 상한(횟수 또는 기한)이 있다. 상한에 도달하면 held로 기록하고 경보를 낸다.
12. 미국·암호화폐·선물 경로의 플래그, 주기, 신선도는 바뀌지 않아야 한다. 회귀 테스트로 확인한다.

## 11. 구현 및 부하 테스트 계획

### 단계 (각 단계는 별도 승인)
| 단계 | 내용 | 기대 효과 |
|---|---|---|
| 0. 측정 (코드 변경 없음, 읽기 전용) | §12의 Q1–Q8, 앱 호출 카운터 로그 확인 | H1/H2 판별, L·D 분포, DB 증가율 |
| 1. 저위험 즉시 조치 | 호가 off(F1), KRX on-demand·직접 조회 차단(F2), 슬롯 키(F6), COUNT 교체(F12), 카운터와 경보(R7 계측) | 15종목 기준 호출 31.2k → 15.6k(3초 유지), DB 증가 절반 이하 |
| 2. 중앙 수집 | R1(5초 고정, 우선 레인, 재시도 없음), R3, R4, R5, F8 상한, F7 분리 | 100종목 비용 구조 완성 |
| 3. 저장 정리 | 원문 축소, sync-state·호가 보존, 가격 스냅샷 참조 인지형 보존(별도 설계 검토) | 디스크 안정화 |
| 4. 단계적 확대 | 15 → 25 → 50 → 100. 각 단계 전에 1d/1w/4h를 백필(주말 쿼터일)하고, 활성화 뒤 3거래일 관찰 | 단계별 통과 기준 충족 |

### 모의 부하 테스트 (실제 KOSCOM 대량 호출 없음)
기존 [scripts/load-test](../../../backend/scripts/load-test/README.md) 하네스를 재사용한다. 이 하네스의 replay transport에는 KOSCOM `lists`, `intraday`, `multiquote` 경로가 이미 있다.

replay에 추가할 것:
- 100종목과 시장 분포
- 응답 지연 분포와 오류·timeout·429 주입
- 쿼터 헤더와 소진 시 429
- 1분 행 누락·공개 지연
- D/W/10분봉 응답

| ID | 시나리오 | 통과 기준 |
|---|---|---|
| L1 | 정상 장중 1시간 이상, 100종목 6배치 | 공급자 요청 수가 모델 ±5% 이내. 유동 종목 `now − effectiveAt` p95 ≤ 7초, p99 ≤ 9초. 체결 신선도 통과율 ≥ 99.5%. `KOSCOM_QUEUE_TIMEOUT` 0건 |
| L2 | 분봉 작업과 가격 주기 동시 실행 | 분봉 버스트 중에도 가격 주기 지연 p99 ≤ 1초. 간격 한도 사용률 ≤ 50% |
| L3 | 사용자 10명 vs 1,000명 (차트·호가·티커 조회) | **KOSCOM 호출 수 차이 ≤ 1%**. KRX 1m·정책 범위 밖 요청은 공급자 0회 |
| L4 | 공급자 지연 p99 3초 / 5xx 5% / 60초 중단 / 429 | 재시도 폭주 없음(시도 ≤ 주기 수 + 상한). 가격이 오래되면 체결은 503(fail-closed). 복구 후 2주기 안에 정상화 |
| L5 | 소유 인스턴스 강제 종료, 배포 겹침 2인스턴스 | 슬롯당 호출 1주기분 이하. 가격 공백 ≤ 1슬롯 + 2초. DB 중복 행 0 |
| L6 | 장 종료 후 작업 | 누락 분 주입 시 해당 버킷은 held, 시도 ≤ 2. 1d·1w·4h 각 1회/종목. 재실행해도 추가 호출 0(멱등) |
| L7 | 예산 임계치 | 70/80/90/95/98% 단계가 순서대로 동작. 0%에서 호출 0. 09:00 리셋 뒤 정상 복귀 |
| L8 | DB 증가 | 호가 행 0. 가격 행 ≤ N × 주기 수. 분봉 경로의 sync-state 행 0. 행당 평균 크기 기록 |
| L9 | 금융 회귀 | 기존 하네스 재무 감사 0건. 주문·지정가·조건부·LOC 회귀 테스트 통과. US·crypto 호출 수 변화 0 |

모의 테스트를 통과해도 운영 검증 완료가 아니다. 실제 지연, 오류율, 한도 적용 단위는 1단계 계측과 4단계 단계적 관찰로 확인한다.

## 12. 운영 전 추가 확인 사항

**읽기 전용 SQL (운영 DB, 사용자 실행)**

참고할 점:
- `asset_price_snapshots`의 시각 컬럼은 UTC 숫자를 담은 naive `timestamp`다. 그래서 `now() AT TIME ZONE 'UTC'`와 비교한다.
- `BEGIN READ ONLY`와 `statement_timeout`을 걸고 실행한다.

```sql
-- Q1 DB/테이블 크기 (P0)
SELECT pg_size_pretty(pg_database_size(current_database()));
SELECT c.relname, pg_size_pretty(pg_total_relation_size(c.oid)) total, c.reltuples::bigint est_rows
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname IN ('asset_price_snapshots','asset_orderbook_snapshots',
  'market_candles','market_candle_sync_states','ops_job_runs')
ORDER BY pg_total_relation_size(c.oid) DESC;

-- Q2 실제 수집 간격과 체결→수신 지연 (H1 판별, 5초/6초 결정). 종목 하나, 한 세션 단위
WITH s AS (
  SELECT captured_at, effective_at,
         captured_at - lag(captured_at) OVER (ORDER BY captured_at) AS gap
  FROM asset_price_snapshots
  WHERE asset_id = :asset_id AND source_name = 'koscom_krx_realtime_price'
    AND captured_at >= :session_open_utc AND captured_at < :session_close_utc)
SELECT count(*),
  percentile_cont(ARRAY[0.5,0.9,0.99]) WITHIN GROUP (ORDER BY extract(epoch FROM gap)) gap_s,
  percentile_cont(ARRAY[0.5,0.9,0.99]) WITHIN GROUP (ORDER BY extract(epoch FROM captured_at - effective_at)) lag_s
FROM s;

-- Q3 행 크기 표본
SELECT 'orderbook' t, count(*), avg(pg_column_size(raw_payload_json))::int raw_b, avg(pg_column_size(o.*))::int row_b
FROM asset_orderbook_snapshots o TABLESAMPLE SYSTEM (0.1) WHERE source_name = 'koscom_krx_orderbook'
UNION ALL
SELECT 'price', count(*), avg(pg_column_size(raw_payload_json))::int, avg(pg_column_size(p.*))::int
FROM asset_price_snapshots p TABLESAMPLE SYSTEM (0.1) WHERE source_name = 'koscom_krx_realtime_price';

-- Q4 국내 1d 유지 상태 (전일대비 null 위험, F5)
SELECT a.symbol, max(m.open_time) latest_closed_1d, max(m.source_updated_at) updated
FROM assets a LEFT JOIN market_candles m
  ON m.asset_id = a.id AND m.interval = '1d' AND m.is_closed
WHERE a.asset_type = 'domestic_stock' AND a.is_active
GROUP BY a.symbol ORDER BY 2 NULLS FIRST;

-- Q5 sync 대상 미확인 ID 2개
SELECT id, symbol, asset_type FROM assets
WHERE id IN ('698abc13-a207-4f50-b2dc-80040814c456','d5ff905c-e2d5-4c7c-b8a3-8cf2d5d51804');

-- Q6 최근 국내 sync 실행 (정기와 on-demand 합산)
SELECT a.symbol, s.feed, s.mode, count(*) runs, max(s.created_at)
FROM market_candle_sync_states s JOIN assets a ON a.id = s.asset_id
WHERE a.asset_type = 'domestic_stock' AND s.created_at >= now() - interval '1 day'
GROUP BY 1,2,3 ORDER BY 1,2,3;
```

**나머지 확인 항목**
- **Q7 한도 적용 단위(H2).** 1단계 계측 후, 엔드포인트 종류별로 하루 동안 `X-RateLimit-Remaining-Day`와 앱의 시도 카운터를 비교한다. 추가 호출은 0건이다. 판별되기 전까지는 단일 50,000 풀을 유지한다. 월 1,000,000의 집계 기준(달력월 여부, 리셋 시각)은 계약서로 확인한다.
- **Q8 저유동 후보의 1분 행 누락률.** 장 종료 후 후보 하위 20종목의 당일 1분봉을 조회한다(종목당 5회, 약 100건). 누락 분과 VI 구간을 확인한다. 실제 호출이므로 별도 승인이 필요하다.
- **Q9 multiquote 20종목 실요청.** 시장별 1회, 총 2건. 장중에 하면 신선도도 함께 본다.
- **Q10 응답 지연 분포.** 1단계 계측에서 p50/p95/p99를 측정한다. D와 동시성 설정을 정하는 데 쓴다.
- **Q11 현재 env 재확인.** `CANDLE_LIVE_STREAMING_ENABLED`, `KOSCOM_*`, `SCHEDULER_MARKET_CANDLE_SYNC_ASSET_IDS`, `CANDLE_SERVING_*`, `LOC_*`, 인스턴스 수, PostgreSQL 디스크·플랜.
- **Q12 신규 종목 활성화 전 백필 가능 여부.** 비활성 상태에서도 백필 명령이 `--asset-id`로 돌 수 있는지 확인한다(`activeOnly` 기본값).

## 13. 자체 재검토

- **누락된 호출 경로:** KOSCOM 서비스를 주입하는 모든 곳을 전수 확인했다: 수집, 라이브, sync, reconciliation, 4h, LOC, 서빙(관리형/직접), 운영자, 목록. hydrator는 KOSCOM 이벤트(absolute)에서는 호출하지 않는다. home·랭킹·포트폴리오는 캔들 서빙과 sync를 호출하지 않는다.
- **호출량 계산**
  - 22세션 + 9일의 최악 월, 단일 풀, 재시도 과금으로 보수적으로 계산했다.
  - S1의 sync 실행 횟수(144회/일)는 실행 시간을 빼지 않은 상한이다.
  - on-demand는 상한만 제시했다. 실제 값은 Q6으로 확인한다.
- **근거가 약한 가정**은 모두 [미검증]으로 표시했다: 행 크기, L, D, 한도 적용 단위, 운영 env의 현재 값. 결론이 이 값들에 민감한 곳(주기 5/6/4초, DB 증설 필요 여부)은 측정 후 결정 규칙으로 남겼다.
- **과도한 설계 점검:** 새 서비스, 메시지 큐, 인프라는 없다. 기존 클라이언트, Ops 작업, 잠금, 어댑터, 빌더, long sync를 재사용한다. 새로 생기는 것은 플래그, 슬롯 키, 카운터, 스케줄, KRX 분기다. 가격 스냅샷 보존만 비교적 큰 작업이어서 별도 설계로 분리했다.
- **금융 회귀 가능성**
  - 임계값과 판정 로직은 바꾸지 않는다.
  - 현재가 주기가 3초에서 5초로 늘면 지정가 경로 A 대기가 약 2초 늘어난다.
  - L이 크면 시장가 실패가 늘 수 있다. 그래서 L 측정을 주기 결정보다 먼저 한다.
  - 호가 중단은 금융 경로에 영향이 없다. 읽는 곳이 0이다.
  - KRX on-demand를 차단하면 중앙 작업이 실패했을 때 차트가 스스로 복구되지 않는다. 그래서 경보를 함께 둔다.
- **GPT안과의 차이:** 1w 중단은 반대한다(1w 탭 사용). 1d 장후 처리는 동의하되 전일대비와 4h가 의존한다는 점을 보강했다. 현재가 6초는 측정을 조건으로 한다. 분봉 3분은 버킷당 1회로 대체했다. 사용자 요청 경로, 인스턴스 배수, 플래그 결합, 무한 재시도, 보존 문제를 추가했다.

## 부록
- 계산 스크립트: [calc/koscom_budget.py](calc/koscom_budget.py) (출력: [calc/koscom_budget.out.txt](calc/koscom_budget.out.txt))
- 월별 KRX 세션: [calc/krx_sessions.py](calc/krx_sessions.py) (출력: [calc/krx_sessions.out.txt](calc/krx_sessions.out.txt)). 2026–2027 최다 22세션, 최소 17세션.
- 재현:

  ```bash
  python3 -I docs/investigations/2026-10-15-koscom-100-stock-collection-design/calc/koscom_budget.py
  ```
