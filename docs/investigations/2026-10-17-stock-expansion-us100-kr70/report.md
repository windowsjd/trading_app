# 미국주식 100·국내주식 70 확대와 중앙 시세·캔들 수집 전환 (2026-10-17)

- 기준: `main` = `origin/main` = `9c1307e5`(작업 시작 시 미커밋 변경 없음). 작업 결과는 **미커밋**이다(커밋·push·배포·운영 DB·환경변수 변경 없음).
- 선정 근거 원자료: [research/kr](research/kr/README.md), [research/us](research/us/README.md).
- 운영 적용은 §6 순서로, 승인 뒤에만 한다.

## 0. 요약

| 항목 | 결과 |
|---|---|
| 종목 수 | 미국 25 → **100**(+75), 국내 15 → **70**(+55). 기존 40종목 Asset ID·이력 유지, 신규만 추가(`kis-fixed-asset-universe.ts`) |
| 선정 기준 | 2026-01-02 ~ 2026-10-16(각 시장 마지막 확정 거래일) 누적 거래대금. 국내 = **실제 KRX 거래대금 합계**(KIS 시장코드 J, NXT 제외). 미국 = §2.2 |
| 국내 시세 | KOSCOM 5초 중앙 수집, 70종목 = KOSPI 54·KOSDAQ 16 → 요청 4개/주기, **국내 호가 API 호출 0**(코드 기본값 5000ms·호가 꺼짐으로 고정) |
| 미국 시세 | Tiingo 정식 WS 100종목 한 소켓, 5초 저장, 유동성 추정 소켓 기본 꺼짐, REST 자체 제한 300/분·12,000/시간 |
| 중앙 캔들 | KRX 코호트 2개(기존 15·신규 55, A = 2026-10-19 00:00 KST) 등록 → 운영의 `KOSCOM_CENTRAL_CANDLES_ENABLED=true` 부팅 실패 해소 |
| 미국 4h 96세션 | 5m를 97세션 이상 백필한 뒤 4h 합성 → 5m는 기존 45일 보존으로 정리(보존 기간 불변). Tiingo 5m 제공 깊이는 **미검증**(토큰 없음) |
| 이력 점검 | 읽기 전용 자동 점검 `stock-chart-history-audit.ts`(6개 차트 창 × 170종목, 상장·수집 시작·공급자 한계 구분) |
| 숨은 결함 | 고정 미국 목록이 100이 되면 **모든 공급자 설정 읽기가 `KIS_WATCHLIST_LIMIT_EXCEEDED`로 실패**(KIS 41 한도) → KIS 기본 목록을 1차 40으로 고정 |
| 운영 상태 | 미적용. 코드 배포 전 환경변수 2건 변경 필요(§5). 운영 DB 읽기·Tiingo/KOSCOM 실호출은 권한·토큰 없음으로 BLOCKED |

## 1. 시작 상태 (2026-10-17 16:30–17:00 KST 확인)

- 저장소: 로컬 `main` = `origin/main` = `9c1307e5`(주문화면개편), 미커밋 없음. 병행 worktree는 다른 브랜치(eval/claude-watchlist 등)뿐이다.
- Render(읽기 전용 API·공개 `/readiness`):
  - live = `f9cd0813`(2026-10-16 22:34Z). 정식 Tiingo 25종목(`trialMode:false`, `persistence:official`), 유동성 소켓 켜짐.
  - **`9c1307e5` 수동 배포 2회(07:26Z·07:36Z) 모두 `update_failed`.** 원인은 부팅 시
    `KrxCentralCandlesConfigError: KOSCOM_CENTRAL_CANDLES_ENABLED requires at least one KRX collection cohort`.
    환경변수는 이미 `KOSCOM_CENTRAL_CANDLES_ENABLED=true`인데 코드의 코호트 레지스트리가 비어 있었다.
    이 상태에서는 **다음 백엔드 배포도 같은 이유로 실패**한다(이 변경이 코호트를 넣어 해소한다).
  - 환경변수(비밀값 제외): Tiingo `TRIAL_MODE=false`, `US_STOCK_PRICE_PROVIDER=tiingo`, `ALLOWED_SYMBOLS=`(빈 값),
    `WS_LIQUIDITY_ENABLED=true`, `REST 120/분·3000/시간`; KOSCOM `POLL_INTERVAL_MS=5000`, `ORDERBOOK_COLLECTION_ENABLED=false`,
    `PRICE_SLOT/RETRY_CAPS/LIST_BACKOFF/BUDGET_ENFORCEMENT/PRIORITY_LANE/RAW_SLIM=true`, `CENTRAL_CANDLES_ENABLED=true`;
    캔들 `SCHEDULER_MARKET_CANDLE_SYNC_ENABLED=true`(ASSET_IDS 빈 값), `LONG_SYNC_ENABLED=true`(spot,krx,us),
    `MARKET_CANDLE_5M_RETENTION_DAYS=45`, `SCHEDULER_MARKET_CANDLE_RETENTION_ENABLED` 미설정(=꺼짐, readiness `disabled`);
    가격 보존 14일 켜짐, `DATABASE_STORAGE_CAPACITY_GB=100`.
  - DB(readiness): 15.6 GB / 100 GB(17 %), 최근 9.2시간 기준 증가 6.4 GB/일, `DB_STORAGE_RUNWAY_SHORT` 경보(암호화폐 100+100 직후).
- 운영 DB 읽기 전용 조회(자산·캔들 이력 현황)는 auto-mode 분류기가 거부했다(**BLOCKED**). §8의 SQL로 사용자가 확인할 수 있다.

## 2. 종목 선정

### 2.1 국내 신규 55 — 실제 KRX 거래대금

- 기간 2026-01-02 ~ 2026-10-16(앱 KRX 달력 192세션). 종목별 일간 `acml_tr_pbmn`(KIS `FHKST03010100`, 시장코드 **J**) 합계.
  - J가 NXT를 포함하지 않음을 3종목×4일에서 J + NX = UN(원·주 단위 일치)으로 확인했다.
  - KRX 정보데이터시스템은 여전히 로그인 필요(HTTP 400 `LOGOUT`). KIS는 KRX 시세의 공식 중계 데이터이며 KRX 파일과 직접 대조하지는 못했다.
  - Naver 종가×거래량은 후보 범위(상위 155)를 정하는 데만 썼다. 범위 밖 최대 추정치 8.19조원 < 기준선 17.85조원의 절반.
- 대상: KRX KIND의 KOSPI·KOSDAQ 상장사(보통주). ETF·ETN·우선주·레버리지 제외, 거래정지·관리·실질심사·스팩·리츠는 기준선 근처에 없다.
- 결과: 신규 55 기준선 **#55 에이비엘바이오 17.854조원**, #56 고영 17.799조원(차 0.30 %). 70 = KOSPI 54 · KOSDAQ 16.
  기존 15 중 HLB는 전체 136위(9.47조원)지만 정책상 유지한다.
- 예비 후보 55와 비교: 39 유지, 16 교체(모두 YTD 순위가 기준선 아래). 추가 16 중 5개는 10-15 조사 필터에 걸렸던 종목, 11개는 목록에 없던 종목이다.
- 확인 필요(순위는 바꾸지 않음): 신규 10종목은 최근 20세션 중앙 거래대금이 300억원 미만(휴림로봇 70억원)이라 5초 시세가 체결 신선도 10초를 자주 넘을 수 있다.
  9종목은 2026년에 투자경고 이력이 있고 제주반도체는 10-07 지정예고가 있었다. 상태는 활성화 직전에 다시 본다.
- 목록·수치: [research/kr/kr_new55.csv](research/kr/kr_new55.csv), 예비 대비 [kr_preliminary_diff.csv](research/kr/kr_preliminary_diff.csv).

### 2.2 미국 신규 75

- 기간 2026-01-02 ~ 2026-10-16(NYSE 199세션). 공개 자료에는 거래소가 집계한 체결대금이 없어 **금액은 모두 추정치**다:
  EST = Σ(일 종가 × 일 통합 거래량), Nasdaq 일별 이력.
  - Nasdaq 거래량은 Yahoo 통합 거래량과 같다(159종목·31,039종목일). 나스닥 단독 거래량이 아니다.
  - 분할은 가격·거래량을 함께 조정해 곱이 변하지 않는다(KLAC 10:1, BKNG 25:1, CRWD 4:1, APH 2:1).
  - 민감도: (H+L+C)/3 기준과 Yahoo 자료로 다시 계산해도 같은 75종목·같은 기준선(PEP)이고, 순위는 2단계 넘게 움직이지 않는다.
- 모집단 2,931종목: 시가총액 상위 600 ∪ 당일 거래대금 상위 400 ∪ 예비·대체 목록 ∪ 기존 25.
- 규칙 R1: 미국 상장 보통주와 직접 상장 보통주식(외국 발행사 포함: NBIS, STX, IREN, CRDO, SHOP, ACN). ADR/ADS 등 예탁증서, ETF·ETN·레버리지,
  우선주, 워런트·유닛, 상장폐지·거래불가는 제외한다("보통주 여부" 확인 요구에 따라 예탁증서를 뺐다).
- 결과: 기준선 #75 **PEP 2,354억 달러(추정)**. 다음 ABT −3.65 %, LIN −3.77 %, CIEN −4.15 %. ±5 % 안: TMO·TER·MCD·MS·PEP(포함),
  ABT·LIN·CIEN(제외). 신규 상장시장 NAS 36·NYS 39.
- SPCX = Space Exploration Technologies Corp. Class A 보통주(나스닥, 2026-06-12 상장, 88세션).
- Tiingo: 75종목 모두 현재 행이 1개(Stock·USD·endDate 2026-10-16·거래소 일치)다. 과거에 다른 발행사가 쓴 티커(SNDK, DELL, COHR, SNOW, CRCL,
  MRNA)는 현재 행 시작일로 구분된다. BRK.B는 Tiingo `brk-b`(기존 변환 규칙). 장중 5m·WS 지원은 토큰이 없어 확인하지 못했다.
- 예비 후보와 비교: 64 유지, 11 제외(모두 순위: NKE 79위, IONQ 80, AMGN 90, MDT 91, ETN 93, SCHW 94, SNPS 107, PM 109, HPE 113, SBUX 126,
  CCC 1,025), 대체 후보 승격 3(IBM, C, CRCL), 새 이름 8(APP, GE, BA, BKNG, ASTS, ALAB, APH, VZ).
  - 예비 목록은 YTD가 아니라 10-15 하루 거래대금 순위와 84개 자리가 모두 일치했다. CCC는 10-15 하루 거래량 급증(연중 중앙값의 약 32배)으로 들어왔고
    YTD로는 1,119위다.
- **결정 필요 ① ASML**: NY Registry Shares는 예탁증서가 아니라 뉴욕에 등록된 보통주식이다. 연구 규칙대로 제외했다. 포함하면 신규 #18(5,499억 달러)로 들어오고
  PEP가 빠진다. (ADR까지 넣는 R2면 TSM·ARM·SKHY·BABA가 들어오고 TER·MCD·MS·PEP가 빠진다.)
- **결정 필요 ② WBD(기존 25)**: SEC에 2026-10-06 Form 25-NSE(나스닥 상장폐지 통지)·8-K, 10-16 Form 15를 냈다. 인수 완료로 상장폐지됐다.
  지침(기존 종목 삭제·교체 금지)대로 등록은 유지했다. 따라서 **미국 100종목 중 거래 가능 99**다.
  - 운영 Tiingo 소켓에 WBD가 들어 있어도 구독은 정상이다(10-16 22:35Z 이후 WBD tick 0, 나머지 정상).
  - 선택지: (가) 유지 — 가격이 없어 견적·체결이 막히고 보유는 그대로. (나) WBD 비활성화 + #76 ABT 추가 — 거래 가능 100. Tiingo 목록 상한(100) 때문에
    WBD를 고정 목록에서 빼야 하고, WBD 보유분 처리(현금화 등)는 기업행위 정책상 별도 결정이다.
- 목록·수치: [research/us/us_new75.csv](research/us/us_new75.csv), 전체 순위 [us_ranked_pool.csv](research/us/us_ranked_pool.csv),
  예비 대비 [us_preliminary_diff.csv](research/us/us_preliminary_diff.csv).

### 2.3 상장일

576세션 일봉 창 시작(KRX 2024-06-03, 미국 2024-07-01) 뒤 상장 종목은 `listedOn`을 기록해 점검이 상장 전 구간을 결함으로 세지 않게 했다.
국내는 LG CNS(2025-02-05) 한 종목이다. 미국은 SNDK(2025-02-24), CRWV(2025-03-28), CRCL(2025-06-05), SPCX(2026-06-12), NBIS(2024-10-21, 2022-02 거래정지 뒤 나스닥 재개)다.

## 3. 구현

### 3.1 종목 등록 — `kis-fixed-asset-universe.ts`

- `FIRST_PHASE_UNIVERSE`(기존 40, 순서·값 그대로) + `EXPANSION_2026_10_17`(신규 130)을 이어 붙인 것이 `KIS_FIXED_ASSET_UNIVERSE`(170)다.
  시드(`dev:seed-kis-universe`)·로컬 복구·Tiingo 기본 목록이 모두 이것을 쓴다. 시드는 (market, symbol) 기준 멱등이고 기존 행은 계약 필드만 비교한다.
- 국내는 기존과 같이 `market: 'KRX'`로 등록한다. KOSPI/KOSDAQ는 KOSCOM 공식 목록으로 해석한다(코드 변경 없음).
- 새 관리 계층·스키마 변경은 없다. 선택적 `listedOn` 필드만 더했다(점검 전용).

### 3.2 국내 — KOSCOM 5초·호가 중단·코호트

- 수집 대상은 이미 "활성 국내 Asset 전체"다. 등록만 하면 5초 슬롯·배치(시장별 20)·저장·전파에 들어간다(코드 변경 없음).
- 코드 기본값: `KOSCOM_POLL_INTERVAL_MS` 3000 → **5000**, `KOSCOM_ORDERBOOK_COLLECTION_ENABLED` true → **false**.
  운영 env와 같고, env가 지워져도 70종목에서 예산을 넘는 3초·호가 수집으로 돌아가지 않게 한다. 호가를 부르는 경로는 수집기 하나뿐이다.
- 코호트(`KRX_COLLECTION_COHORTS`): `krx-first-phase-15-2026-10-19`, `krx-expansion-55-2026-10-19`, 둘 다 A = 2026-10-19 00:00 KST.
  설정 테스트가 레지스트리를 고정하고, 두 코호트가 고정 universe의 국내 1차·확대 목록과 정확히 같은지 검사한다.
  **배포가 2026-10-19 09:00 KST보다 늦어지면 배포 전에 A를 그 뒤 첫 거래일로 옮긴다**(배포된 A는 바꾸지 않는다).

### 3.3 미국 — Tiingo 100

- 기본 허용 목록 = 고정 universe의 미국 100(코드 그대로 따라감, 상한 100). 소켓은 매핑된 종목 전체를 한 subscribe 프레임으로 구독하고,
  asset map 5분 갱신 때 목록이 바뀌면 재구독한다(재시작 불필요).
- 유동성 추정 소켓(thresholdLevel 4) 기본값 true → **false**.
- REST 자체 제한(정식 기본) 120/분·3,000/시간 → **300/분·12,000/시간**.
  - 이유: 입장 거절(`TIINGO_BUDGET_EXHAUSTED`)은 기다리지 않고 즉시 실패한다. 100종목 sync 한 번이 300회(5m·1d·1w)라 분당 120이면 앞쪽 약 120회
    뒤의 종목이 매번 즉시 실패해, 알파벳 뒤쪽 종목은 영영 동기화되지 않는다.
  - 시간당 12,000은 계약(30,000/시간)의 40 %, ×24 = 288,000으로 일 계약(400,000) 아래다.
- KIS 롤백 범위: KIS 기본 목록은 1차 25만이다. `US_STOCK_PRICE_PROVIDER=kis`로 되돌리면 확대 75종목은 가격이 없어 견적·체결이 막힌다(대체 원천 없음).

### 3.4 과거 캔들

| 시장·창 | 원천 | 확보 방법 |
|---|---|---|
| 미국 5m/15m/30m/1h (3/6/12/24세션) | Tiingo 5m 저장 | 확대 백필 `--days 150`에 포함 |
| 미국 4h 96세션 | 저장 Tiingo 5m에서 합성(`tiingo_equity_intraday_4h`) | **5m를 97세션 이상 백필 → `candle:long-backfill --market us --sessions 97`** → 5m는 45일 보존이 정리, 4h는 180일 보존 |
| 미국 1d 576세션 | Tiingo EOD 원시 | `--mode repair --days 875 --target 1d --target 1w` |
| 국내 4h 96세션 | KOSCOM 10분 이력(일봉 교차 검증) | `candle:long-backfill --market krx --sessions 97` |
| 국내 1d 576세션 | KOSCOM 일 이력 | `--mode repair --days 875 --target 1d` |
| 국내 5m 계열 | KOSCOM 1분(당일만 조회) | A부터 중앙 수집이 채운다. 과거 날짜 1분 조회는 계약 미검증이라 백필하지 않는다 |

- 기존 런북은 미국 5m를 `--days 45`(약 31세션)로만 받아 4h 96세션을 만들 수 없었다. 도구는 이미 900일까지 받으므로 코드가 아니라 **순서와 기간**이 문제였다.
  5m 보존 기간은 늘리지 않는다. 운영의 5m 보존 작업은 지금 꺼져 있으므로, 4h 합성을 끝낸 뒤 켜야 원천이 먼저 지워지지 않는다.
- 4h는 빠짐없는 5m 세션만 합성하고, 그 밖은 `pending`으로 남는다(보간·IEX 대체 없음). 재실행은 저장된 버킷을 다시 쓰지 않는다.
- 미국 4h 96세션의 가장 오래된 세션은 2026-06-01이다. Tiingo 통합 equity intraday 제품은 2026-07-07에 나왔다(2026-10-14 조사).
  그 이전 5m 제공 여부는 토큰이 없어 **확인하지 못했다**. smoke에 깊이 점검을 넣었다(§7).
- 국내 5m 계열: 신규 55의 5m/15m/30m/1h 창은 활성화 뒤 3/6/12/24세션 동안 차오른다. 점검은 이를 `limited_by_collection_start`로 따로 센다.

### 3.5 자동 이력 점검 — `scripts/stock-chart-history-audit.ts`

- 읽기 전용(저장 캔들만, 공급자 호출·쓰기 없음). 활성 주식 전체 × 차트 창 6개(5m 3·15m 6·30m 12·1h 24·4h 96·1d 576세션).
- 판정은 조회 경로 규칙을 따른다: 5m 필수 슬롯 전부(KRX 종가 단일가 슬롯 제외), 4h 계획 버킷의 저장 행 또는 최근 30일의 빠짐없는 5m,
  1d 일봉 창의 닫힌 행. 미국은 현재 공급자(`tiingo_*`) 행만 센다.
- 상태: `complete` / `limited_by_listing` / `limited_by_collection_start`(KRX 5m 계열, A 이전) /
  `limited_by_provider`(측정한 Tiingo 깊이를 `--us-intraday-history-from`으로 줄 때만) / `incomplete` / `calendar_unavailable`.
  공급자 한계는 가정하지 않는다. 주지 않으면 오래된 미국 공백은 `incomplete`다.
- "45일치 5m만 있는 상태를 96세션 4h 완료로 판단하지 않는다"를 단위 테스트로 고정했다.

### 3.6 중복 수집 방지 (역할 분리, 변경 없음)

- KRX: 중앙 수집기만(10분 공통 sync는 중앙 수집이 켜지면 `us_stock`·`crypto`만 돈다, KRX 정합 작업도 건너뜀).
- 미국: 10분 공통 sync(Tiingo 5m·1d·1w, 체크포인트·잠금) + long sync 4h 합성(공급자 호출 없음). 사용자 차트 요청은 DB만 읽는다.
- 암호화폐·선물: 기존 그대로. `SCHEDULER_MARKET_CANDLE_SYNC_ASSET_IDS`는 운영에서 이미 빈 값이고 바꿀 필요가 없다.
- 관찰: 공통 sync는 주식 종목을 순서대로 처리한 뒤 암호화폐를 처리한다. 미국 100종목이면 한 번에 약 300회 호출이 앞서므로
  암호화폐 5m 저장이 실행마다 수 분 늦어질 수 있다(암호화폐 정합 작업은 따로 돈다). 측정하지 않았고 바꾸지 않았다.

### 3.7 발견해 고친 결함 — KIS 감시 목록 41 한도

- `buildProviderConfig()`는 `KIS_US_SYMBOLS`가 없으면 고정 미국 목록으로 KIS 감시 목록을 만들고, 41개를 넘으면 예외를 던진다.
  이 함수는 Binance·FX를 포함한 **모든 공급자 설정 읽기마다** 호출된다. 고정 미국 목록이 100이 되면 운영(`KIS_US_SYMBOLS` 미설정) 전체가 실패한다.
- 수정: KIS 런타임 기본값(`KIS_FIXED_DOMESTIC_SYMBOLS`/`KIS_FIXED_US_SYMBOLS`)을 1차 40으로 고정했다. KIS 동작은 이전과 같다.
- 기존 문제(고치지 않음): 운영·기본값 모두 꺼진 `provider_kis_ingest` 작업은 merged 대상에서 env의 `NAS:X`와 Asset의 `X`가 따로 남아
  25종목만으로도 41을 넘는다(확대 전부터). 켜지 않는 한 영향이 없다.

## 4. 호출 예산·저장

### 4.1 KOSCOM (일 50,000·월 1,000,000 기준)

| 항목 | 거래일당 |
|---|---:|
| 현재가 4배치 × 4,680주기(6.5시간, 5초) | 18,720 |
| 중앙 1분봉 70종목 × 79틱 | 5,530 |
| 장후 복구·1d·4h·목록·LOC 등(상한) | ≤ 약 1,000 |
| 합계 | 약 25,000(50 %) — 22거래일 월 약 55만(55 %) |

설계의 4배치 모델(24,625/일)과 같다. 호가는 0이다. 백필(1회): 4h 97세션 × 70 ≈ 6,800 + 1d ≈ 500(주말·장후, P4 예산 안).

### 4.2 Tiingo (시간 30,000·일 400,000)

sync 1,800/시간(일 4.3만), 소켓 장애 시 보충 최대 6,000/시간, LOC 종가 조회 LOC 종목·거래일당 ≤ 22, 백필 1회 약 1,200.

### 4.3 DB

- 가격 스냅샷: 국내 70 × 4,680행 × 약 1.1 KB ≈ 0.36 GB/거래일, 미국 100 × 최대 4,680행 ≈ 최대 0.47 GB/거래일. 14일 가격 보존으로
  각각 약 3.6 GB·4.7 GB에서 멈춘다. 캔들은 하루 수 MB다.
- 백필로 미국 5m가 일시적으로 약 50만 행(수백 MB) 늘고, 5m 보존을 켜면 45일 밖은 정리된다.
- 현재 증가(6.4 GB/일)는 대부분 암호화폐 100+100이다. 주식 추가분은 정상 상태에서 약 8–9 GB다.

## 5. 환경변수

- **실제 변경한 값: 없음**(운영 쓰기 없음).
- 이 코드 배포와 함께 바꿀 값:

| 변수 | 지금 | 목표 | 시점·선행 조건 |
|---|---|---|---|
| `TIINGO_REST_REQUESTS_PER_MINUTE` | 120 | 지움(기본 300) 또는 300 | 배포 전. 남기면 100종목 sync 뒤쪽이 매번 실패 |
| `TIINGO_REST_REQUESTS_PER_HOUR` | 3000 | 지움(기본 12000) 또는 12000 | 배포 전 |
| `TIINGO_WS_LIQUIDITY_ENABLED` | true | false(또는 지움) | 배포와 함께 |
| `SCHEDULER_MARKET_CANDLE_RETENTION_ENABLED` | (없음=꺼짐) | true | 미국 4h 합성·점검 **뒤**. 그 전에 켜면 4h 원천 5m가 지워짐 |

- 그대로 둘 값: `CANDLE_LIVE_STREAMING_ENABLED=false`(켜면 KOSCOM 1분 조회가 종목당 분당 1회 더 붙어 70종목에서 일 한도를 넘는다), `KOSCOM_*`(5000·호가 false·슬롯·예산·레인), `KOSCOM_CENTRAL_CANDLES_ENABLED=true`(코호트가 들어간 코드가 배포되면 유효),
  `TIINGO_ALLOWED_SYMBOLS` 빈 값, `US_STOCK_PRICE_PROVIDER=tiingo`, `SCHEDULER_MARKET_CANDLE_LONG_SYNC_MARKETS=spot,krx,us`,
  `MARKET_CANDLE_5M_RETENTION_DAYS=45`, `TIINGO_SNAPSHOT_THROTTLE_MS=5000`.

## 6. 운영 적용 순서 (승인 필요, 모두 미실행)

1. 환경변수 3건(§5 앞 세 줄) 변경 → 이 변경을 커밋·push(백엔드 자동 배포). 배포가 성공하면 KRX 중앙 수집이 2026-10-19 첫 틱부터 돈다.
2. 시드: Render Shell에서 `pnpm dev:seed-kis-universe --dry-run` → create 130·unchanged 40·update 0 확인 → `--dry-run` 없이 실행(기본이 적용).
3. 확인: `/readiness` `data.tiingo.allowedSymbols` 100·`mapping.unmapped` []·소켓 tickers 100.
4. 이력 백필(미국 정규장·KRX 장 밖, Render Shell, 토큰은 서비스 env):
   - 미국: `candle-baseline-sync --apply --asset-type us_stock --target 5m --days 150` → `candle:long-backfill --market us --apply --sessions 97`
     → `candle-baseline-sync --apply --asset-type us_stock --mode repair --days 875 --target 1d --target 1w`.
   - 국내: `candle-baseline-sync --apply --mode repair --days 875 --target 1d --asset-type domestic_stock` →
     `candle:long-backfill --market krx --apply --sessions 97 --max-calls 8000`.
5. 점검: `stock-chart-history-audit.ts`(미국은 smoke의 깊이를 `--us-intraday-history-from`으로) → 결과를 이 문서 §7에 붙인다.
6. `SCHEDULER_MARKET_CANDLE_RETENTION_ENABLED=true`.
7. Tiingo 깊이 smoke(4번 전에 하면 좋다): 운영 밖 호스트에서 `TIINGO_LIVE_SMOKE=1 TIINGO_API_TOKEN=… pnpm smoke:tiingo-official`
   (`NODE_ENV=production`이면 거부한다). `intraday5mDepth96Sessions`, `eodDepth576Sessions`, `historyDepth.intradayHistoryReach`를 본다.

## 7. 검증

| 검증 | 결과 |
|---|---|
| 종목 등록(단위) | PASS — 미국 100·국내 70, 1차 40 값·순서 그대로, 중복 없음, 국내 6자리·KRX·KRW, 미국 NAS/NYS·USD·Tiingo 티커 왕복, Tiingo 기본 100, KIS 기본 25(41 한도, `buildProviderConfig` 예외 없음), 시드 계획 멱등 |
| 종목 등록(로컬 PostgreSQL) | PASS — 1차 40만 있는 상태에서 시드 dry-run create 130·update 0·unchanged 40 → 적용 170(모두 활성) → 재실행 0·0·170. 1차 40 ID 해시 불변 |
| Tiingo 100 구독(단위) | PASS — 100 티커를 한 프레임으로 구독·ack, 유동성 소켓은 기본으로 열지 않음 |
| Tiingo 실제 구독·시세·과거 깊이 | NOT_RUN — 토큰 없음. 운영 소켓(25종목)은 정상 구독 중(readiness) |
| KOSCOM 5초(모의 L1: 100종목·6배치·T=5초, 70종목·4배치보다 무거움) | PASS — 주기 p50 1.44초·p99 1.69초, 장애 주입 구간 밖 누락·중복 슬롯 0, 최신 가격 나이 최대 6.9초(체결 10초 안), 호가 호출 0, 사용자 요청 호출 0. 모의라 실제 지연·한도는 증명하지 못한다 |
| 국내 호가 호출 0 | PASS — 코드 기본 false, 수집기 kinds가 price만, 설정·수집 테스트. 운영 env도 false |
| 코호트 | PASS — 레지스트리 고정, universe 국내 1차·확대와 일치, 켠 상태 부팅 검증 통과 |
| 이력 점검 도구 | PASS — 단위 9건(45일 5m를 96세션 4h 완료로 보지 않음, 상장·수집 시작·측정 깊이 구분), 로컬 DB에서 CLI 실행(170종목, 종료 코드 1, KRX 5m 계열 70건 `limited_by_collection_start`) |
| 운영 이력 점검(미국 100·국내 70) | BLOCKED — 운영 DB 읽기 거부, 백필 미실행 |
| 주문 회귀(로컬 PostgreSQL, CI 편입) | PASS 5/6 — NAS:SNDK·NYS:ORCL·KRX:009150 각각 시장가 BUY가 공급자 가격으로 체결(미국은 더 새 KIS·admin 가격 무시), 지정가 대기 뒤 Path A 체결, 10초 지난 가격 거부, 가격 없는 종목 거부. 6회 중 1회는 첫 종목에서 `OrdersService` 오류로 멈췄고(파이프 필터로 전문 유실) 이어진 4회 모두 PASS. WSL 시계 역행(알려진 환경 요인)으로 보이나 증명하지 못했다 |
| 백엔드 단위 전체 | PASS — 331 스위트·5,410건, 실패 0(DB·실호출 스위트 81개는 env 게이트로 skip) |
| typecheck(`tsconfig.build.json`) | PASS |
| 부하 하네스(`test:load-test`) | PASS 110 |
| 변경 파일 eslint·prettier | PASS(기존 부채 파일은 HEAD와 같은 상태) |
| Binance·선물 회귀 | 단위 전체에 포함되어 PASS(코드 변경 없음) |
| 프런트엔드 | 변경 없음 — 실행하지 않음 |

## 8. 운영 확인용 읽기 전용 SQL

```sql
-- 등록 상태
SELECT asset_type, market, is_active, count(*) FROM assets
 WHERE asset_type IN ('us_stock','domestic_stock') GROUP BY 1,2,3 ORDER BY 1,2,3;
-- 주식 캔들 이력(주기·공급자별 범위)
SELECT a.asset_type, c.interval, c.source_provider, count(*) AS rows, count(DISTINCT c.asset_id) AS assets,
       min(c.open_time), max(c.open_time)
  FROM market_candles c JOIN assets a ON a.id = c.asset_id
 WHERE a.asset_type IN ('us_stock','domestic_stock') GROUP BY 1,2,3 ORDER BY 1,2,3;
```

## 9. 자체 검토

- 지시서 가설과 실제 코드의 차이:
  - "허용 목록이 비면 25만 구독" → 기본 목록은 고정 universe를 따른다. 목록 확장만으로 풀리지만, 지시서에 없던 두 장애물이 있었다:
    REST 자체 제한의 즉시 실패(100종목 sync 300회 > 분당 120)와 KIS 감시 목록 41 한도(모든 공급자 설정 읽기가 실패).
  - "코호트가 비어 중앙 캔들 조건 미충족" → 사실이고, 운영은 이미 플래그를 켜 **배포가 실패하는 상태**였다.
  - "45일 5m로는 96세션 4h 부족" → 사실. 도구는 이미 더 긴 5m 백필과 4h 합성을 지원해 코드가 아니라 런북의 기간·순서 문제였다.
    대신 Tiingo의 실제 과거 5m 깊이(96세션 = 2026-06-01, 제품 출시 2026-07-07)가 확인되지 않은 위험으로 남는다.
  - "5초·호가 중단은 env로" → 운영 env는 이미 5000·false였다. 코드 기본값을 정책에 맞췄다.
  - "공통 자산 ID 필터를 비우면 중복 호출" → 운영은 이미 빈 값이고, 중앙 수집이 켜지면 10분 sync가 KRX를 빼므로 중복이 없다. 바꾸지 않았다.
  - 국내 5m 과거 이력: KOSCOM 1분 조회가 당일 전용이라 A 이전은 채울 수 없다. 지시서의 "코호트 이전 부족과 이후 실패 구분"에 맞춰 점검 상태로 구분했다.
- 과도한 구현 여부: 스키마·마이그레이션·새 스케줄러·새 관리 계층 없음. 새 코드는 읽기 전용 점검 1개(+CLI), smoke 깊이 점검, 주문 회귀 통합 테스트 1개다.
  주문·체결·원장·평가·랭킹 코드는 바꾸지 않았다.
- diff 검토: 변경 22개 파일 + 신규 6개(테스트·도구) + 조사 자료. 의도하지 않은 변경 없음. `prettier-ignore`는 종목 표와 코호트 표 두 곳뿐이다.
- 남은 출시 전 작업: §6 운영 적용, Tiingo 깊이 smoke, 운영 이력 점검, WBD·ASML 결정, 신규 종목 상태(투자경고 등) 활성화 직전 재확인.
