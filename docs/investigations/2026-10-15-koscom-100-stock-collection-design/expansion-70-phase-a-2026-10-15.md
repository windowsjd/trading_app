# 국내주식 70종목 확대 — Phase A 사전 검증 결과 (2026-10-15)

- 작성: 2026-10-15 23:40 KST
- 기준 설계: [report.md](report.md) v2.1, [implementation-runbook.md](implementation-runbook.md), [followup-audit-2026-10-15.md](followup-audit-2026-10-15.md)
- 지시: 15 → 70종목 직접 확대(조건부 실행 승인). 사전 조건이 모두 충족될 때만 등록·백필·활성화한다.
- **최종 판정: `BLOCKED`.** 운영 변경은 0건이다(운영 DB·Redis 쓰기, env 변경, 배포, KOSCOM 호출 없음).

## 0. 결론

1. **운영 DB 디스크가 확대와 무관하게 위급하다 (A4 FAIL).**
   - 2026-10-15 14:00Z(23:00 KST)에 8.67GB / 10.53GB, 82.3%다. 자동 확장은 꺼져 있다.
   - 최근 증가율은 하루 986–1,505MB다(24·72시간 평균).
   - 이 속도면 90%는 10-16(금) 11:54–18:42 KST, 가득 참은 10-17(토) 04:41–20:20 KST다.
   - 증가는 KOSCOM 수집이 시작된 10-12부터 뛰었다. 지금 15종목 수집(3초, 현재가+호가, 원문 그대로)만으로 장중 약 0.57–0.76GB/일로 보인다(§6).
   - 디스크 증설은 비용이 들고, 정리 작업은 데이터 삭제다. 둘 다 사용자 승인 대상이라 하지 않았다. 결정이 필요하다(§10 D0).
2. **70종목은 지금 운영 설정으로는 일 한도를 넘는다.**
   - 지금 설정: 3초, 호가 수집 켬, 중앙 캔들 꺼짐.
   - 같은 형태로 70종목이면 현재가+호가만 62,400–78,000건/일이다(한도 50,000건).
   - 70종목에서 3초는 호가를 꺼도 월 한도 목표(80%)를 넘는다. 4배치 81.6%, 5배치 98.8%다.
   - 그래서 두 가지가 모두 필요하다.
     - 주기 변경(§13 P4)
     - 중앙 캔들(3b). 사용자 차트 요청발 호출을 0으로 만든다. §13 P1–P3 승인이 필요하다.
   - 둘 다 미승인이다. 이번 지시는 이 승인을 대신하지 않는다.
3. **운영 DB 읽기가 이 세션에서 막혔다.**
   - 읽기 전용 쿼리를 한 번 시도했고, 권한 분류기가 거부했다. 우회하지 않았다.
   - 그래서 다음 항목이 BLOCKED다: Q1(테이블 크기), Q3(행 크기), Q2′(ER₃), 1d·4h 이력 상태, 활성 자산의 정확한 상태.
   - 대신 Render API의 디스크 지표(읽기 전용)를 썼다.
   - 실행할 SQL은 [expansion-70/readonly-checks.sql](expansion-70/readonly-checks.sql)에 있다.
4. **할 수 있는 검증과 결함 수정은 했다.**
   - Q14(2024 달력): KRX 공식 근거로 PASS다. 데이터는 그대로 두고 잠정 표시만 뗐다.
   - 70종목 호출 예산(calc §10)
   - 후보 55종목(근거 포함, §3)
   - G4 진단 도구 결함 수정: 비활성 종목의 사전 이력 판정이 불가능했다.
   - 선물 fixture 실패 원인 규명과 수정: 픽스처 시작 경합이고, 제품 회귀가 아니다.
   - 롤백 한계 확인: 보유자가 생긴 뒤 비활성화하면 매도가 막힌다.

## 1. 작업 시작 시 상태

| 항목 | 값 | 근거 |
|---|---|---|
| 로컬 HEAD / origin/main | `15668962` = `15668962`, 작업 트리 clean | `git status`, `git fetch` |
| 브리프 기준과의 차이 | `52dde62c` 뒤 커밋 1개(`15668962`). 프런트 13개 파일만 바꿨다. 백엔드 변경 0 | `git diff --stat 52dde62c 15668962` |
| 운영 배포 | 라이브 `52dde62c`(2026-10-15 13:18Z). `15668962`는 frontend만이라 배포되지 않았다(rootDir `backend`) | `render deploys list` |
| GitHub Actions(HEAD) | CI success, Futures release fixture success(13:51Z) | `gh run list --commit 15668962…` |
| 직전 실패 | `52dde62c` Futures release fixture `REPLAY_INITIAL_PRICES_TIMEOUT`(13:19Z). 원인은 §8.2 | run 38741391258 |
| 진행 중인 다른 작업 | 별도 worktree 3개(`eval/claude-watchlist`, `fix/futures-ws-ack-verify-20261014`, `feat/long-4h-candles-20261013`)와 /tmp의 prunable worktree들. main 작업 트리와 분리돼 있다 | `git worktree list` |
| 운영 KOSCOM env | `KOSCOM_API_KEY` 설정, `KOSCOM_POLLING_ENABLED=true`. 그 밖의 `KOSCOM_*`는 설정 없음(모두 기본값). `CANDLE_LIVE_STREAMING_ENABLED=false`, `CANDLE_SERVING_MODE=database` | Render env API(값은 플래그만 출력) |
| 기본값이 뜻하는 운영 동작 | 3초, 호가 수집 켬, 원문 그대로, 슬롯·재시도 상한·목록 백오프 꺼짐, 중앙 캔들 꺼짐, 예산 집계만(강제 꺼짐), 가격 레인 꺼짐, 5분봉 보존 45일 | [koscom.config.ts](../../../backend/src/providers/koscom/koscom.config.ts), [krx-central-candles.config.ts](../../../backend/src/assets/krx-central-candles.config.ts) |
| 운영 PostgreSQL | plan `0.5c-1g`, 디스크 10GB(용량 10,530,681,000B), 자동 확장 false, PG17, 1대 | Render API |
| 시즌 | `sea_2026_s1` active, 2000-01-01 → 2099-12-31(상시 시즌) | 공개 `GET /api/v1/seasons` |
| 활성 국내주식 | GPT 확인값은 15개 활성, 비활성 0개, market `KRX`. **이 세션에서는 재확인하지 못했다(DB 차단, 자산 API는 인증 필요)** | — |
| 코호트 레지스트리 | `KRX_COLLECTION_COHORTS = []` | [krx-central-candles.config.ts:39](../../../backend/src/assets/krx-central-candles.config.ts#L39) |

## 2. 항목별 판정

| # | 항목 | 판정 | 근거 |
|---|---|---|---|
| A1.1 | 기존 15종목 유지 | PASS(코드) / NOT_VERIFIED(운영 DB) | 고정 목록 15개. 운영 행은 GPT 확인값만 있다 |
| A1.2 | 신규 55종목 확정 | 후보 확정, **사용자 확인 필요** | §3. G7 기준(거래대금·체결 주식 수·인지도·상태·업종)으로 골랐다. ER 기준(P5)은 실측이 있어야 판정된다 |
| A1.3 | KOSPI·KOSDAQ 식별(KRX KIND 공식 목록) | PASS | §3 |
| A1.4 | KOSCOM 공식 시장 목록 매핑 | NOT_VERIFIED | KOSCOM 실호출 3건이 필요하다. 이번에는 호출하지 않았다. 등록 뒤 비활성 상태에서는 매핑을 쓰지 않으므로, 백필 첫 호출에서 `KOSCOM_MARKET_UNRESOLVED`로 드러난다 |
| A1.5 | 거래정지·관리·투자경고 | §3 참고 | KRX KIND 목록 대조 |
| A2.1 | 일·월 한도와 초기화 | 일 50,000: 헤더 실측(10-12·10-13 실행, 사용자 요약) / 월 1,000,000·09:00 초기화: 문서값 / **Q15 NOT_VERIFIED** | 계약 단위(달력월·롤링)와 공용 풀 여부는 계약서·KOSCOM 확인 사항 |
| A2.2 | 현재 누적 호출량 | NOT_VERIFIED | 단계 1 카운터와 잔여량 헤더는 운영 Redis에만 있다. 로그에는 없다. 10-12 관찰 잔여 약 33,540·34,039가 마지막 근거다 |
| A2.3 | 현재 운영 호출 형태 | 모델: 현재가+호가 31,200건/일(62.4%), 22세션 686,400건(68.6%). 캔들 호출은 별도 | §4 |
| A2.4 | 70종목 주기별 일·월 | **3초 FAIL**(월 81.6–98.8%) / 4초 4배치 PASS, 5배치는 롤링 80.9%로 경계 / **5초·6초 PASS**(월 47–65%, 최악일 52–68%) | calc §10 |
| A2.5 | 백필 추가량 | 5,775건(+15종목 4h 미실행이면 1,455) | 주말 쿼터일 하루에 들어간다 |
| A2.6 | 429·재시도 | NOT_VERIFIED | 10-12 이후 운영 로그에 KOSCOM 줄이 0건이다. 그러나 기존 수집 경로는 사이클 실패를 로그로 남기지 않는다(요약만 반환). 그래서 오류가 없었다는 근거가 아니다. 카운터는 운영 Redis에 있다 |
| A3.1 | 기존 15종목 ER₃(5세션) | **BLOCKED** | 운영 행이 필요하다(Q2′). KOSCOM 수집은 10-12 세션부터라, 10-16 세션이 끝나야 5세션이 된다 |
| A3.2 | 5·6초 ER 추정·시험 | NOT_RUN | 추정은 행이 필요하다(BLOCKED). 운영 시험은 P4 승인이 필요하다 |
| A3.3 | 수집 지연 p99 ≤ T − 1초 | NOT_VERIFIED | 사이클 계측이 10-15 17:03 KST에 배포됐다. 첫 측정 세션은 10-16이다. 모델 한도는 §5 |
| A3.4 | 10초 신선도 기준 | PASS(변경 없음) | 코드 그대로 |
| A4.1 | 디스크 실측 | **FAIL** | 82.3%, 1.86GB 남음, 1.2–1.9일 뒤 가득 |
| A4.2 | 테이블·인덱스·행 크기(Q1·Q3) | **BLOCKED** | DB 차단 |
| A4.3 | 호가 중단·원문 축소 | **FAIL**: 호가는 지금도 수집·저장 중이고(`KOSCOM_ORDERBOOK_COLLECTION_ENABLED` 기본 `true`), 원문 축소는 꺼져 있다(`KOSCOM_PRICE_RAW_SLIM_ENABLED` 기본 `false`) | 운영 env에 두 키가 없다 |
| A4.4 | G1(3개월 여유 또는 보존 가동) | **FAIL** | 여유 1.86GB vs 증가 약 1–1.5GB/일. 보존은 P6 미승인 |
| A5.1 | 중앙 수집 플래그 | 꺼짐 | env |
| A5.2 | 코호트 | 비어 있음. 코호트 1 사전 등록은 **하지 않았다**(§7.2) | — |
| A5.3 | Redis 슬롯·잠금, 예산 관리자 | 코드 배포됨, 슬롯 꺼짐·강제 꺼짐(집계만) | env 기본값 |
| A5.4 | 5분봉 보존 45일 | PASS(기본값 45, env 없음) | [market-candle-retention.config.ts](../../../backend/src/assets/market-candle-retention.config.ts) |
| A5.5 | G4-I·G4-H 진단 | 도구 결함 1건 수정(비활성 종목 G4-H 불가). 운영 실행은 BLOCKED | §7.3 |
| A5.6 | 1d 576·4h 96 | 백필 도구가 비활성 종목을 받는다(PASS). 기존 15종목 상태는 BLOCKED(S6·S7) | §7.4 |
| A5.7 | Q14 KRX 2024 달력 | **PASS** | §7.5 |
| A5.8 | 기존 15종목 중앙 수집 안정성 | NOT_STARTED | 3b가 한 번도 켜진 적이 없다 |
| A6.1 | CI·금융 회귀 | PASS(HEAD CI·fixture success) | §8.1 |
| A6.2 | Futures fixture 실패 | 원인 규명: 픽스처 시작 경합, 제품 회귀 아님 | §8.2 |
| A6.3 | 미국주식·Binance | 코드 경로 분리 확인. 이번 변경 없음 | §8.3 |
| A6.4 | 활성 시즌 공정성 | 위험 있음(조건부) | §8.4 |
| A6.5 | 롤백 방법 | **부분 PASS** | 비활성화는 데이터를 지우지 않는다. 그러나 보유자가 생긴 뒤에는 매도가 막히고 가격이 멈춘다(§8.4) |

## 3. A1 — 후보 55종목

세부 근거(종목별 시총·20/60세션 거래대금·최소일·초당 체결 주식 수·상태 점검·ISIN·KRX 영문명)는 [candidates_55.csv](expansion-70/candidates_55.csv)에 있다. 대체 후보는 [alternates_10.csv](expansion-70/alternates_10.csv), 제외한 주요 종목과 사유는 [excluded_notable.csv](expansion-70/excluded_notable.csv), 출처와 수집 시각은 [sources_fetch_log.csv](expansion-70/sources_fetch_log.csv)에 있다.

**선정 규칙** (설계 G7: 유동성 → 인지도 → 상품 다양성. 20의 배수 맞추기는 기준이 아니다)

- 대상: KOSPI·KOSDAQ 보통주. 우선주·ETF·ETN·리츠·SPAC·펀드·외국기업은 뺐다. 2026-07-15 이전 상장만 넣었다.
- 상태: 매매거래정지·관리종목·투자경고/위험·상장적격성 실질심사·투자주의환기 목록(KRX KIND)에 없고, 09-15 이후 투자경고 지정예고도 없다. 하루짜리 투자주의는 제외 사유가 아니라 기록만 했다.
- 거래대금(20세션 2026-09-14…10-15, KRX만, 종가 × 거래량): 중앙값 ≥ 300억원, 평균 ≥ 300억원, 최저일 ≥ 100억원.
- 체결 주식 수: 하루 평균 70,200주(정규장 23,400초에 초당 3주) 이상, 최저일 23,400주(초당 1주) 이상. 하루 체결 횟수는 체결 주식 수를 넘을 수 없다. 그래서 이 기준은 초당 1회 체결의 필요조건일 뿐 충분조건은 아니다. 이 기준으로 고가 저회전 종목(삼양식품·효성중공업·삼성바이오로직스)을 뺐다.
- 인지도: 시총 1조원 이상이면서 KOSPI200·KOSDAQ150 편입, 비편입이면 5조원 이상.
- 순서: 20세션 중앙값 순으로 고른 뒤, 업종을 넓히려고 5종목을 바꿨다. KT&G·현대로템·한국전력·하이브·한국금융지주를 넣고, 후성·가온전선·고영·이오테크닉스·두산테스나를 대체 후보 1–5로 돌렸다. KOSPI200·KOSDAQ150 편입은 55종목 중 54이다. 비편입: 대덕전자(353200, 시총 6.06조원).
- 업종: 은행 4·보험 2·증권 1·지주 4·2차전지와 소재 4·방산 4·전력기기와 전선 4·조선 2·정유와 화학 4·철강·자동차부품·건설 3·통신·전력·항공·소비재(에이피알, KT&G)·제약바이오(알테오젠, 한미약품)·엔터·로봇. 반도체·전자부품·PCB가 12다.
- 기준을 통과하는 종목이 없어 비어 있는 업종: 식품(삼양식품은 주식 수 미달, 오리온·CJ제일제당·농심은 300억원 미만), CDMO(삼성바이오로직스는 주식 수 미달), 게임(크래프톤·엔씨소프트는 300억원 미만), 유통·물류(신세계·롯데·현대글로비스는 300억원 미만), 해운(HMM 중앙값 161억원).

**결과**: 55종목 = KOSPI 47 / KOSDAQ 8. 70종목 = KOSPI 59 / KOSDAQ 11 → 가격 **4배치**(calc §10).

- 55종목 모두 지금 거래정지·관리종목·투자경고/위험이 아니다.
- 최근 3개월(07-15…10-15)에 하루짜리 투자주의가 있었던 종목은 4개다. 지금은 지정이 없다: 대덕전자 1회 (2026-08-05 매매관여과다종목); 한화시스템 2회 (2026-08-06 매매관여과다종목; 2026-08-05 매매관여과다종목); 로보티즈 1회 (2026-08-06 투자경고 지정예고); 현대건설 1회 (2026-08-07 매매관여과다종목). 테마성 유동성 위험이 있는 종목은 활성화 직전에 다시 본다.

| 유동성 순위 | 코드 | 종목 | 등록 이름(영문) | 시장 | 업종 | 20세션 중앙 거래대금(억원) | 초당 체결 주식 수(평균) | 지수 |
|---:|---|---|---|---|---|---:|---:|---|
| 1 | 009150 | 삼성전기 | Samsung Electro-Mechanics | KOSPI | Electronic components | 8,858 | 27.2 | KOSPI200 |
| 2 | 402340 | SK스퀘어 | SK Square | KOSPI | Holding company | 5,864 | 26.8 | KOSPI200 |
| 3 | 036930 | 주성엔지니어링 | Jusung Engineering | KOSDAQ | Semiconductor equipment | 3,049 | 68.7 | KOSDAQ150 |
| 4 | 006400 | 삼성SDI | Samsung SDI | KOSPI | Batteries | 1,821 | 18.2 | KOSPI200 |
| 5 | 353200 | 대덕전자 | Daeduck Electronics | KOSPI | PCB / semiconductor package substrates | 1,645 | 48.4 | — |
| 7 | 105560 | KB금융 | KB Financial Group | KOSPI | Banks / financial holding | 1,573 | 39.2 | KOSPI200 |
| 8 | 240810 | 원익IPS | Wonik IPS | KOSDAQ | Semiconductor equipment | 1,440 | 52.2 | KOSDAQ150 |
| 9 | 012450 | 한화에어로스페이스 | Hanwha Aerospace | KOSPI | Defense / aerospace | 1,432 | 6.7 | KOSPI200 |
| 10 | 042700 | 한미반도체 | Hanmi Semiconductor | KOSPI | Semiconductor equipment | 1,349 | 26.1 | KOSPI200 |
| 11 | 096770 | SK이노베이션 | SK Innovation | KOSPI | Refining / energy | 1,339 | 37.3 | KOSPI200 |
| 12 | 000150 | 두산 | Doosan Corp. | KOSPI | Holding company | 1,165 | 4.1 | KOSPI200 |
| 14 | 373220 | LG에너지솔루션 | LG Energy Solution | KOSPI | Batteries | 1,110 | 15.6 | KOSPI200 |
| 15 | 011070 | LG이노텍 | LG Innotek | KOSPI | Electronic components | 1,087 | 10.4 | KOSPI200 |
| 17 | 055550 | 신한지주 | Shinhan Financial Group | KOSPI | Banks / financial holding | 1,027 | 44.7 | KOSPI200 |
| 18 | 403870 | HPSP | HPSP | KOSDAQ | Semiconductor equipment | 1,000 | 91.2 | KOSDAQ150 |
| 19 | 028260 | 삼성물산 | Samsung C&T | KOSPI | Holding / construction & trading | 999 | 14.0 | KOSPI200 |
| 20 | 012330 | 현대모비스 | Hyundai Mobis | KOSPI | Auto parts | 991 | 12.0 | KOSPI200 |
| 21 | 007660 | 이수페타시스 | ISU Petasys | KOSPI | PCB | 984 | 41.0 | KOSPI200 |
| 22 | 222800 | 심텍 | Simmtech | KOSDAQ | PCB / semiconductor substrates | 980 | 31.3 | KOSDAQ150 |
| 24 | 329180 | HD현대중공업 | HD Hyundai Heavy Industries | KOSPI | Shipbuilding | 926 | 10.6 | KOSPI200 |
| 25 | 278470 | 에이피알 | APR | KOSPI | Cosmetics / beauty devices | 895 | 13.6 | KOSPI200 |
| 26 | 267260 | HD현대일렉트릭 | HD Hyundai Electric | KOSPI | Power equipment | 876 | 6.2 | KOSPI200 |
| 27 | 086790 | 하나금융지주 | Hana Financial Group | KOSPI | Banks / financial holding | 875 | 30.1 | KOSPI200 |
| 28 | 010120 | 엘에스일렉트릭 | LS ELECTRIC | KOSPI | Power equipment | 838 | 20.3 | KOSPI200 |
| 29 | 009830 | 한화솔루션 | Hanwha Solutions | KOSPI | Chemicals / solar | 835 | 140.5 | KOSPI200 |
| 30 | 047040 | 대우건설 | Daewoo Engineering & Construction | KOSPI | Construction | 822 | 241.1 | KOSPI200 |
| 31 | 316140 | 우리금융지주 | Woori Financial Group | KOSPI | Banks / financial holding | 781 | 149.3 | KOSPI200 |
| 33 | 032830 | 삼성생명 | Samsung Life Insurance | KOSPI | Insurance | 751 | 12.3 | KOSPI200 |
| 34 | 067310 | 하나마이크론 | Hana Micron | KOSDAQ | Semiconductor packaging & test | 741 | 87.6 | KOSDAQ150 |
| 35 | 000990 | DB하이텍 | DB HiTek | KOSPI | Semiconductor foundry | 735 | 27.2 | KOSPI200 |
| 36 | 028050 | 삼성E&A | Samsung E&A | KOSPI | Engineering / plant construction | 729 | 73.7 | KOSPI200 |
| 37 | 272210 | 한화시스템 | Hanwha Systems | KOSPI | Defense electronics / ICT | 715 | 38.2 | KOSPI200 |
| 38 | 058470 | 리노공업 | Leeno Industrial | KOSDAQ | Semiconductor test sockets / probes | 714 | 44.7 | KOSDAQ150 |
| 39 | 196170 | 알테오젠 | Alteogen | KOSDAQ | Biotech | 711 | 13.3 | KOSDAQ150 |
| 40 | 108490 | 로보티즈 | ROBOTIS | KOSDAQ | Robotics | 704 | 11.4 | KOSDAQ150 |
| 41 | 000720 | 현대건설 | Hyundai Engineering & Construction | KOSPI | Construction | 700 | 28.2 | KOSPI200 |
| 42 | 034730 | SK | SK Inc. | KOSPI | Holding company | 690 | 6.3 | KOSPI200 |
| 43 | 005490 | POSCO홀딩스 | POSCO Holdings | KOSPI | Steel / materials holding | 680 | 9.8 | KOSPI200 |
| 44 | 079550 | LIG디펜스앤에어로스페이스 | LIG Defense & Aerospace | KOSPI | Defense | 676 | 4.5 | KOSPI200 |
| 45 | 001440 | 대한전선 | Taihan Cable & Solution | KOSPI | Power cables | 672 | 125.3 | KOSPI200 |
| 46 | 003670 | 포스코퓨처엠 | POSCO Future M | KOSPI | Battery materials | 666 | 16.5 | KOSPI200 |
| 48 | 003490 | 대한항공 | Korean Air | KOSPI | Airline | 600 | 101.6 | KOSPI200 |
| 49 | 017670 | SK텔레콤 | SK Telecom | KOSPI | Telecom | 586 | 30.1 | KOSPI200 |
| 51 | 062040 | 산일전기 | Sanil Electric | KOSPI | Power equipment | 570 | 12.2 | KOSPI200 |
| 52 | 009540 | HD한국조선해양 | HD Korea Shipbuilding & Offshore Engineering | KOSPI | Shipbuilding | 553 | 7.9 | KOSPI200 |
| 54 | 128940 | 한미약품 | Hanmi Pharmaceutical | KOSPI | Pharmaceuticals | 513 | 5.4 | KOSPI200 |
| 55 | 010950 | S-Oil | S-Oil | KOSPI | Refining | 507 | 14.5 | KOSPI200 |
| 57 | 066970 | 엘앤에프 | L&F | KOSPI | Battery materials | 492 | 19.6 | KOSPI200 |
| 59 | 010060 | OCI홀딩스 | OCI Holdings | KOSPI | Chemicals / polysilicon holding | 479 | 10.7 | KOSPI200 |
| 61 | 000810 | 삼성화재해상보험 | Samsung Fire & Marine Insurance | KOSPI | Insurance | 462 | 3.6 | KOSPI200 |
| 72 | 033780 | 케이티앤지 | KT&G | KOSPI | Tobacco / consumer staples | 390 | 10.1 | KOSPI200 |
| 73 | 064350 | 현대로템 | Hyundai Rotem | KOSPI | Defense / rail | 389 | 15.9 | KOSPI200 |
| 83 | 015760 | 한국전력공사 | Korea Electric Power Corporation (KEPCO) | KOSPI | Utility | 331 | 47.0 | KOSPI200 |
| 87 | 352820 | 하이브 | HYBE | KOSPI | Entertainment / music | 324 | 9.3 | KOSPI200 |
| 91 | 071050 | 한국금융지주 | Korea Investment Holdings | KOSPI | Securities / brokerage holding | 304 | 7.9 | KOSPI200 |

- 순위는 신규 후보 전체에서의 20세션 중앙 거래대금 순위다. 빠진 순위는 위 제외 규칙이나 업종 쏠림 때문이다(excluded_notable.csv).
- 대체 후보 10: 093370 후성(KOSPI, 542억), 000500 가온전선(KOSPI, 488억), 098460 고영(KOSDAQ, 449억), 039030 이오테크닉스(KOSDAQ, 437억), 131970 두산테스나(KOSDAQ, 418억), 178320 서진시스템(KOSDAQ, 411억), 052690 한전기술(KOSPI, 394억), 161890 한국콜마(KOSPI, 391억), 089970 브이엠(KOSDAQ, 376억), 078930 GS(KOSPI, 375억).
- 등록 이름은 기존 15종목처럼 영문으로 둔다(KRX 공식 영문명 기반). 앱은 `assets.name`을 그대로 보여 주므로 한글과 섞이면 목록 언어가 섞인다. 이름 언어 전환은 별도 결정이다.

**한계와 확인 방법**

- 거래대금·주식 수는 체결 횟수가 아니다. 5초에서 ER ≥ 94%(기준 d)를 지키려면 대략 초당 1회 이상 체결이 필요하다(§5 모델).
- 거래대금 하위 10종목(한국금융지주, 하이브, 한국전력공사, 현대로템, 케이티앤지, 삼성화재해상보험, OCI홀딩스, 엘앤에프, S-Oil, 한미약품)과 체결 주식 수가 가장 적은 종목(삼성화재해상보험 초당 3.6주, 두산 초당 4.1주, LIG디펜스앤에어로스페이스 초당 4.5주, 한미약품 초당 5.4주, HD현대일렉트릭 초당 6.2주)은 이 조건이 증명되지 않았다. 공개 자료에는 체결 건수가 없다.
- 확인 방법은 둘이다. ① 활성화 전 Q8(장후 1분봉 누락률, KOSCOM 약 100건, 승인 필요) ② 활성화 뒤 ER₅ 실측. 미달이면 P5(저유동 포함 여부)로 정하고, 대체 후보는 같은 검증을 거쳐 쓴다.
- KOSCOM 공식 목록 매핑은 확인하지 못했다(A1.4).
- KRX 정보데이터시스템은 로그인이 필요해 쓰지 못했다. 거래대금은 공개 일별 시세(KRX만)로 계산했다. 2종목(009150, 071050)은 이 세션에서 따로 받아 다시 계산했고 값이 같았다.
- 자료 시점: 2026-10-15 장 마감 뒤(14:02–14:30Z 수집). 10-15는 급락일이었다(KOSPI200 −8.13%). 그날을 뺀 19세션 평균도 CSV에 있다. 거래량은 KRX만이고 NXT는 빠졌다. 종가 × 거래량은 실제 거래대금보다 중앙값 기준 1.5% 낮다(10-15, 327종목 대조). 지수 편입과 상태 플래그는 바뀌므로 활성화 직전에 다시 확인한다.

## 4. A2 — 호출량

**한도 근거**

- 일 50,000건: 10-12·10-13 실제 호출의 `X-RateLimit-Limit-Day` 헤더(사용자 실행 요약).
- 월 1,000,000건, 09:00 KST 초기화: 설계 §7.1의 문서값이다.
- Q15(월 단위가 달력월인지 롤링인지, 일 한도가 공용 풀인지)는 계약 확인 전이다. 그래서 달력월(22세션)과 롤링 31일(23세션)을 모두 본다.

**지금 운영**

- 15종목, 2배치, 3초, 현재가+호가 = 31,200건/일(62.4%), 22세션이면 686,400건(68.6%)이다.
- 이것만으로도 월 목표(80%)의 대부분을 쓴다. 차트 요청발 캔들 호출이 여기에 더해진다.

**70종목 ([calc §10](calc/koscom_budget.out.txt), 최종안 F: 호가 끔, 중앙 캔들, 1w 주 1회)**

| T | 배치 | 평상일 | 최악일 | 월(22) | 롤링 31일(23) | 판정 |
|---|---:|---:|---:|---:|---:|---|
| 3초 | 4 | 37,105 (74.2%) | 41,722 (83.4%) | 81.6% | 85.4% | FAIL(월) |
| 3초 | 5 | 44,905 (89.8%) | 49,522 (99.0%) | 98.8% | 103.3% | FAIL |
| 4초 | 4 | 29,305 (58.6%) | 33,922 (67.8%) | 64.5% | 67.4% | PASS |
| 4초 | 5 | 35,155 (70.3%) | 39,772 (79.5%) | 77.4% | 80.9% | 경계(롤링) |
| 5초 | 4 | 24,625 (49.2%) | 29,242 (58.5%) | 54.2% | 56.6% | PASS |
| 5초 | 5 | 29,305 (58.6%) | 33,922 (67.8%) | 64.5% | 67.4% | PASS |
| 6초 | 4 | 21,505 (43.0%) | 26,122 (52.2%) | 47.3% | 49.5% | PASS |
| 6초 | 5 | 25,405 (50.8%) | 30,022 (60.0%) | 55.9% | 58.4% | PASS |

**권고안(70종목, 4배치, 5초)의 범주별 평상일 호출** (calc §10과 같은 모델, 재시도 1% 포함)

| 범주 | 우선순위 | 건/거래일 |
|---|---|---:|
| 현재가 | P1 | 18,720 |
| 시장 목록 | P1 | 12 |
| 1d 장후 | P2 | 78 |
| LOC 증거 | P2 | 141 |
| recoverClose | P2 | 0 (최악 종목당 3회 상한) |
| 장중 1분봉(5분 버킷당 1회) | P3 | 5,585 |
| 당일 갭 복구 | P3 | 4 |
| 4h long sync | P4 | 71 |
| 1w(한시) | P4 | 14 |
| **합계** | | **24,625 (49.2%)** |

- 모든 거래일이 최악일이어도 5초 5배치는 월 74.8%다. 이것은 실측이 아니라 모델이다.
- 사용자 요청발 호출 0은 3b(중앙 캔들)가 켜져 있어야 성립한다. 3b가 꺼진 채 70종목이면 차트 조회가 KOSCOM을 부른다. 그 양은 사용자 수에 비례하고 상한이 없다.
- 백필(일회): 1d 576 385건 + 4h 97 5,335건 + 1w 55건 = 5,775건. 기존 15종목의 4h 97이 운영에서 돌지 않았다면 1,455건이 더 든다. 주말 쿼터일 여유(85%) 42,488건 안이다.

## 5. A3 — 현재가 주기와 체결 적격성

**실측이 없다.**

- 기존 15종목의 3초 ER₃는 운영 행으로 계산한다(Q2′). DB가 막혀 계산하지 못했다.
- 사이클 계측은 10-15 17:03 KST 배포라 장중 데이터가 아직 없다.
- 그래서 아래 값은 모두 설계 §6.3 모델이다.

| 체결/초 | 3초 대비 5초 손실 | 3초 대비 6초 손실 | 판정 기준 (a) 1.0%p |
|---:|---:|---:|---|
| 5 이상 | 약 0%p | 약 0%p | 통과 |
| 1 | 0.14–0.25%p | 0.36–0.68%p | 통과 |
| 0.5 | 1.60–1.82%p | 2.89–3.77%p | 실패 |

**처리량** (calc §10, 배치당 저장 0.3초, 동시성 2)

| 배치 | 5초에서 D ≤ 4초인 평균 지연 한도 | 6초 | 3초 |
|---:|---:|---:|---:|
| 4 | 1.69초 | 2.20초 | 0.69초 |
| 5 | 1.03초 | 1.36초 | 0.36초 |

**권고 (P4 승인 사항)**

- **5초를 권한다.**
  - 예산에 여유가 있다(월 54–65%).
  - 6초보다 ER 손실이 작다.
  - 3초는 예산상 불가다.
- 시험 순서:
  1. 승인 뒤 기존 15종목에서 5초를 3세션 이상 실측한다(ER₅).
  2. 직전 5세션 ER₃(10-12…10-16)와 비교해 (a)–(d)를 판정한다.
  3. 실패하면 3초로 되돌린다(15종목은 3초 예산 안이다).
- 신규 55종목은 3초 기준선이 없다. 그래서 활성화 뒤 `ER₅ ≥ 94%`(d)로 판정한다.
- 제안 유니버스(§3)는 4배치다. 그래서 5초에서는 실측 평균 지연이 1.69초 이하이면 된다. 5배치 분포라면 1.03초다. 넘으면 6초나 동시성 3(L2 시험 필요)을 쓴다. 10-16 사이클 계측이 첫 근거다.
- 10초 체결 신선도 기준은 바꾸지 않는다.

## 6. A4 — DB 저장 공간

**실측** ([render-postgres-disk.json](expansion-70/render-postgres-disk.json), Render API 1시간 해상도, 2026-10-06 → 10-15)

| 시각 (UTC) | 사용 | 용량 | 사용률 |
|---|---:|---:|---:|
| 2026-10-07 14:00 | 약 2.01GB | 5.25GB | 38% |
| 2026-10-13 08:00 | 약 5.37GB | 10.53GB(증설됨) | 51% |
| 2026-10-15 14:00 | 8.668GB | 10.531GB | **82.3%** |

| KST 날짜 | 하루 증가 | 그중 09–16시 | 비고 |
|---|---:|---:|---|
| 10-07(수)·10-08(목) | 65 / 144MB | 34 / 41MB | KOSCOM 수집 전 |
| 10-09(금, 휴장) | 123MB | 11MB | |
| 10-10(토)·10-11(일) | 265 / 450MB | — | 주말. 24시간 작성기(Binance 등) |
| 10-12(월) | 1,290MB | 454MB | KOSCOM 수집 첫 세션. 10-12 선물 Last·Mark 수집 개시 |
| 10-13(화) | 1,736MB(17시간분) | — | 장중 시간대에 지표 공백이 있어 장중 몫을 나누지 못한다 |
| 10-14(수) | 1,645MB | 838MB | |
| 10-15(목) | 1,001MB(23시간분) | 700MB | 시간별 감소분 합 −1,010MB 포함(원인 미확인. WAL 재활용·보존 작업 추정) |

**해석**

- 장중(09–16시) 증가에서 주말 하루치 24시간 작성기 몫(7시간분 77–131MB)을 빼면, 지금 15종목 KOSCOM 형태는 약 569–761MB/세션일이다.
- 저장 행(현재가 약 111,150 + 호가 117,000/일) 하나당 약 2.6–3.4KB다. 설계 가정(0.4–3.0KB)의 위쪽 끝이거나 그보다 크다.
- 선물 Last·Mark 테이블은 24시간 보존(분당 최대 10,000행 삭제)이 돌아 일정 크기에서 멈출 것이다 [추론]. `asset_price_snapshots`·`asset_orderbook_snapshots`는 보존이 없어 계속 는다 [사실].
- 주말 증가(265–450MB/일)의 주된 원천은 Binance Spot 스냅샷으로 보인다 [추론].
  - 고정 유니버스 약 25종목, WS 저장 간격 5초(`BINANCE_WS_SNAPSHOT_THROTTLE_MS` 기본값)다.
  - 그러면 하루 최대 약 432,000행이다. 24시간 돌고 보존이 없다.
  - 그래서 KOSCOM을 정리해도(호가 끔 + 원문 축소) 하루 약 0.3–0.45GB는 계속 는다. 이것은 국내 확대와 무관하다. Binance 동작은 이번 범위에서 바꾸지 않는다.
- 정확한 귀속은 Q1이 있어야 한다(S1·S3·S4).

**전망**

| 기준 | 하루 증가 | 90% 도달 | 가득 참 |
|---|---:|---|---|
| 최근 24시간 | 986MB | 10-16 18:42 KST | 10-17 20:20 KST |
| 최근 48시간 | 1,293MB | 10-16 14:01 KST | 10-17 09:35 KST |
| 최근 72시간 | 1,505MB | 10-16 11:54 KST | 10-17 04:41 KST |

**70종목에서** (calc §10, KOSCOM 현재가 행만)

| 형태 | MB/거래일 |
|---|---:|
| 5초·호가 끔·원문 그대로 | 122–608 |
| 5초·원문 축소 | 106–182 |
| 6초·원문 축소 | 89–152 |

- 실측 행 크기(2.6–3.4KB)를 쓰면 원문 그대로는 위쪽 끝에 가깝다.
- 그래서 70종목에는 호가 중단(단계 1)과 원문 축소(2a)가 모두 필요하다. 그리고 G1(보존 가동 또는 3개월치 여유)이 필요하다.
- 지금은 어느 것도 없다.

## 7. A5 — 중앙 수집과 장기 이력

### 7.1 상태

- `KOSCOM_CENTRAL_CANDLES_ENABLED`는 미설정, 즉 꺼짐이다.
- 켜려면 P1–P3 승인과 코호트 1 기록이 필요하다. 코호트가 없으면 부팅을 거부한다.
- 3b는 운영에서 한 번도 켜진 적이 없다. 그래서 "기존 15종목 중앙 수집 3거래일 G4-I"는 시작 전이다(NOT_STARTED).

### 7.2 코호트 1을 지금 등록하지 않은 이유

- 브리프는 "코호트가 비어 있으면 기존 15종목 코호트부터 사전 등록"을 요구했다. 하지만 지금 등록하면 고칠 수 없는 결함을 만든다.
- 이유: G4-I의 `collectionStartedInTime`은 코호트 `A` 뒤 첫 틱 기한을 영구 기준으로 쓴다([krx-collection-gates.ts](../../../backend/src/assets/krx-collection-gates.ts) g4i의 `firstSessionAfter(start)` 이후 블록).
  - 3b가 `A`의 첫 틱보다 늦게 켜지면 그 15종목은 `startedInTime=false`가 영구히 남는다.
  - 그러면 `pass.collectionStartedInTime`은 다시는 `true`가 되지 못한다.
  - 배포한 `A`는 바꾸지 않는 것이 규칙이다.
- 3b 활성화 날짜는 P1–P3 승인이 있어야 정해진다.
- 그래서 설정 주석의 규칙대로 한다. 코호트 1은 3b를 켜는 변경에, 활성화 세션 00:00 KST를 `A`로 넣는다. 준비된 항목은 §11.2에 있다.

### 7.3 G4 진단 도구 결함 (수정)

- 결함: `krx-collection-gates`는 `--asset-id`를 줘도 `isActive: true`로 걸렀다.
- 그래서 B3("비활성 상태에서 1d·4h 백필 → G4-H 완전성 확인")를 할 수 없었다. 결과가 소리 없이 빈 배열이었다.
- 수정: 명시 목록이면 G4-H는 비활성 종목도 판정한다. 백필 도구와 같은 규칙이다.
- G4-I는 그대로 활성 종목만 센다. 수집 의무는 활성 종목에만 있다.
- 테스트 3개를 더했다(명시 목록 G4-H, 목록 없는 G4-H, 명시 목록 G4-I).

### 7.4 백필 도구 (B3)

- 1d: `candle-baseline-sync --include-inactive --asset-id`가 비활성 종목을 받는다([candle-baseline-args.ts:54-55,122-123](../../../backend/scripts/lib/candle-baseline-args.ts#L54-L55)).
- 4h: `candle:long-backfill --market krx --asset-id`도 받는다. 명시 id가 `isActive` 조건을 대신한다([market-candle-long-sync.service.ts:683-689](../../../backend/src/assets/market-candle-long-sync.service.ts#L683-L689)).
- 둘 다 장중에는 멈춘다.

### 7.5 Q14 — KRX 2024 달력: PASS

- KRX 자체 근거와 대조했다.
  - KRX 공개 휴장일 목록 2024: 평일 휴장 18일이 모두 일치한다. 빠진 날도 더한 날도 없다.
  - KRX 보도자료 5건(2023121402, 2024032702, 2024091001, 2024103104, 2024121701)
- 특수 세션 두 날은 보도자료 PDF 본문으로 직접 확인했다.
  - 2024-01-02: 주식 정규시장 09:00~15:30 → 10:00~15:30
  - 2024-11-14: 10시 개장, 종료 1시간 순연(16:30)
- 함의 세션 수 244는 공개 일별 시세 두 출처와 날짜 단위로 일치한다.
- 데이터는 바꾸지 않았다. 출처와 `version`(`2024.1-provisional` → `2024.1`)만 바꿨다.
- 근거: [krx-2024-calendar-audit.json](expansion-70/krx-2024-calendar-audit.json)
- 범위 밖 발견: KRX의 현재 목록에는 2027-06-07이 없다. 잠정 `krx-2027.ts`는 이날을 현충일 대체 휴장으로 둔다. 2027 감사 때 다시 본다.

## 8. A6 — 운영·금융 회귀

### 8.1 CI

- HEAD `15668962`: CI success, Futures release fixture success.
- 이번 변경으로 돌린 것(로컬, DB 없는 단위 테스트):
  - `src/assets` 전체 + 달력 + 앱 readiness + baseline 달력 spec: 51 suites, 1,016 tests 통과(13 suites는 옵트인 DB 통합이라 건너뜀)
  - `pnpm test:load-test` 110/110
  - 변경 파일 ESLint(경고 0, `prepare.ts`는 §8.2)·Prettier
  - backend typecheck
- 금융 경로(주문·체결·지갑·정산·랭킹)는 바꾸지 않았다.

### 8.2 Futures release fixture `REPLAY_INITIAL_PRICES_TIMEOUT` (52dde62c, 13:19Z)

- 원인: 픽스처의 시작 경합이다.
  - `prepare.ts`가 서버가 뜬 뒤 자산을 한 행씩 따로 커밋했다(수정 전 161–182행, [prepare.ts](../../../backend/scripts/load-test/prepare.ts)).
  - 라이브 캔들 감독자는 연결할 때 crypto 자산을 한 번 읽고 다시 읽지 않는다([live-candle-stream-supervisor.service.ts:427](../../../backend/src/realtime/live-candle-stream-supervisor.service.ts#L427)).
  - 그 실행에서는 첫 재시도가 crypto 25개 중 2개만 읽었다. 서버 표본의 프레임 속도가 정확히 2종목분이었다.
  - 그래서 45초 대기 조건(crypto 스냅샷 ≥ 25)을 못 채웠다.
- 시간대와 무관하다. 시장 시간 분기가 없고, 같은 코드로 13:38Z·13:51Z에 통과했다.
- `52dde62c`는 이 경로를 건드리지 않았다. 제품 회귀가 아니다.
- 수정(적용, 픽스처만):
  - 자산 생성을 `createMany` 한 문장으로 바꿨다. 감독자는 crypto 0개(빈 목록 재시도)나 25개 전부만 본다.
  - 시간 초과 메시지에 대기 조건의 현재 값을 넣었다(`futuresLast=n/m cryptoRows=n/25`). 판정 기준은 그대로다.
  - 검증: backend typecheck, `pnpm test:load-test` 110/110. ESLint는 HEAD와 같은 39건으로, 모두 바꾸지 않은 줄의 기존 부채다(게이트 밖 파일).
  - 경합 자체가 사라졌는지는 CI 실행에서만 확인된다. 아직 push하지 않았다.
- 제품 쪽에도 기존 한계가 하나 있다. 실행 중 추가한 crypto 자산은 재연결 전까지 라이브 스트림에 들어가지 않는다. KRX는 해당 없다. KOSCOM 수집은 사이클마다 활성 자산을 다시 읽는다.

### 8.3 미국주식·Binance

- 운영 KIS REST·WS는 미국 전용이다(국내 `domesticSymbols: []`).
- 국내 수집은 KOSCOM 경로만 쓴다. Binance·Tiingo·선물 경로는 국내 자산 수와 무관하다.
- 국내 70종목이 이 경로에 주는 영향은 공유 DB 디스크뿐이다(§6).

### 8.4 활성 시즌 공정성과 롤백

- 시즌은 상시(2000–2099)다. 시즌 사이에 확대할 창이 없다.
- 추가 자체는 모든 참가자에게 동시에 열리므로 기회는 같다.
- 신규 종목은 5분봉 계열 이력이 최대 25세션 짧다. 정책상 정상이다.
- **롤백 한계** [사실]:
  - 비활성 자산은 견적·주문에서 `ASSET_NOT_TRADABLE`이다([orders.service.ts:3099](../../../backend/src/orders/orders.service.ts#L3099), [:6863](../../../backend/src/orders/orders.service.ts#L6863)).
  - 지정가 실행은 `asset_inactive`로 건너뛴다.
  - 평가·랭킹은 `isActive`를 보지 않아 마지막 가격으로 계속 평가한다.
  - 그래서 사용자가 신규 종목을 보유한 뒤 비활성화로 롤백하면 이렇게 된다.
    - 그 종목을 팔 수 없다.
    - 가격은 수집 중단 시점에 멈춘 채 순위에 반영된다.
  - 현물에는 매도 전용 모드가 없다.
- 결론: 비활성화 롤백은 첫 체결 전에만 깨끗하다. 체결 뒤의 롤백 방식(예: 가격 수집은 유지하고 확대 중단, 또는 매도 전용 모드 신설)은 제품 결정이다(§10 D6).

## 9. 실행 승인 판정 (브리프 §5)

| 조건 | 상태 |
|---|---|
| 최종 70종목 후보 검증 | 후보 확정(§3), KOSCOM 매핑 NOT_VERIFIED, 사용자 확인 필요 |
| 실제 KOSCOM 계약 한도 | 일 50,000 헤더 확인 / 월 단위 Q15 NOT_VERIFIED |
| 주기별 일·월 호출량 | 모델 PASS(5·6초) / 실측 NOT_VERIFIED |
| 수집 지연·ER | BLOCKED(DB) / NOT_VERIFIED(계측 첫 세션 10-16) |
| DB 저장 공간 | **FAIL** |
| 호가 중단·원문 축소 | 미적용(운영 env 변경 필요) |
| 중앙 수집·코호트·백필 | 3b·코호트 미가동(P1–P3), 백필 미실행 |
| CI·금융 테스트 | PASS |
| 운영 변경 권한 | 운영 DB 읽기조차 이 세션에서 차단됨 |
| 제품 정책 승인 | P1–P4 미승인, P6 미승인 |
| 롤백 방법 | 부분 PASS(체결 전만 깨끗) |

→ **`BLOCKED`.** 필수 기술 조건(디스크)이 FAIL이다. 운영 승인(P1–P4, 디스크 비용 또는 P6)과 운영 DB 접근이 없다.

## 10. 필요한 결정

| # | 결정 | 선택지 | 권고 |
|---|---|---|---|
| D0 | **디스크 (긴급, 확대와 무관)** | ① Render PG 디스크 증설(유료, 줄일 수 없음) ② `KOSCOM_ORDERBOOK_COLLECTION_ENABLED=false`(단계 1. 호가 행을 읽는 곳 0곳, KOSCOM 호출 절반) ③ `KOSCOM_PRICE_RAW_SLIM_ENABLED=true`(2a. 새 행부터, 되돌릴 수 없음) ④ P6 보존 활성화(삭제) ⑤ 기존 호가 행 정리(삭제) | 오늘 ①과 ②. ②·③만으로는 부족하다. Binance 등 24시간 작성기가 하루 약 0.3–0.45GB를 계속 쌓는다(§6, 추론). 그래서 ①은 필수다. S1·S3·S4 SQL로 증가원을 확인한 뒤 ③. ④·⑤는 dry-run 뒤 별도 승인 |
| D1 | P1–P3 (3b 중앙 캔들) | 승인 / 보류 | 70종목의 전제다. 승인 시 15종목에서 먼저 켠다 |
| D2 | P4 (주기와 ER 기준) | 5초 / 6초 / 기준값(95%, 1.0%p, 94%) | 5초. 15종목에서 3세션 시험. 시험 전 세션에 `KOSCOM_POLL_LOG_ENABLED=true`로 폴링 로그(Q2‴)를 남기면 6초 추정의 가정 A1·A3가 실측이 된다(로그만, DB 쓰기 없음) |
| D3 | 유니버스 55종목 | §3 목록 승인 / 수정 | 이름은 기존 15종목처럼 영문으로 둔다. 혼용하지 않는다 |
| D4 | 운영 DB 읽기 | SQL을 직접 실행 / 이 세션 유형에 읽기 권한 허용 | Q1(24시간 간격 2회), S3, S4, S5–S7, 10-16 장 마감 뒤 S8 |
| D5 | Q15 계약 | KOSCOM 문의 | 월 단위·초기화·공용 풀 |
| D6 | 체결 뒤 롤백 방식 | 비활성화(보유자 동결) / 수집 유지 + 신규 매수만 중단(코드 필요) | 확대 전에 정한다 |
| D7 | 순서 | 15종목 3b 3거래일 관찰 생략 여부 | 생략하지 않는다(G4-I 근거) |

## 11. 승인 뒤 실행 순서 (Phase B 초안, 미실행)

### 11.1 순서

1. **D0 해소.** 디스크 증설 또는 정리. 단계 1(호가 끔)과 2a(원문 축소)를 적용한다. Q1을 24시간 간격으로 두 번 잰다. G1을 확인한다.
2. **3b·3c 준비.** P1–P3 승인 뒤 코호트 1(15종목, `A` = 3b 활성화 세션 00:00 KST)을 넣은 변경을 배포한다. 같은 날 `KOSCOM_CENTRAL_CANDLES_ENABLED=true`. 2b–2d 플래그도 runbook §1에 따라 켠다.
3. **15종목 관찰 3거래일.**
   - G4-I(`krx-collection-gates --sessions 3`)
   - 카테고리 카운터와 모델 ±5%
   - 사용자 요청발 KOSCOM 0
   - P4 승인 시 5초 시험 3세션(ER₅ vs ER₃)
   - 이어서 3c 강제(`KOSCOM_BUDGET_ENFORCEMENT_ENABLED=true`)
4. **55종목 비활성 등록.** 코호트 단위 등록 도구를 먼저 만든다(아래 11.3). 모두 `market='KRX'`, `domestic_stock`, KRW, 영문 이름, `isActive=false`.
5. **주말 백필(쿼터일).**
   - 1d: `candle-baseline-sync --apply --mode repair --days 875 --target 1d --include-inactive --asset-id …`
   - 4h: `candle:long-backfill --market krx --apply --sessions 97 --asset-id … --max-calls 800`
   - 그다음 `krx-collection-gates --asset-id …`로 G4-H 1d `ready`, 4h `ready|held`를 확인한다(이번 수정으로 가능).
6. **코호트 2 배포.** 55종목, `A` = 활성화 세션 00:00 KST. 활성화 전날까지 배포한다.
7. **활성화.** 활성화 세션 개장 전에 정확히 55종목만 `isActive=true`. 주기는 승인된 T다.
8. **즉시 확인.**
   - 활성 70
   - `KOSCOM_MARKET_UNRESOLVED` 0
   - 슬롯 중복 0
   - 예산 초과 0
   - 신규 종목 가격 갱신
   - 차트 DB 경로
   - 기존 15종목·US·crypto 정상
9. **3거래일 관찰.**
   - G4-I(신규 코호트 포함)
   - 종목별 ER
   - D p50/p99
   - 호출량·429
   - DB 일 증가(모델 + 30% 이내)
   - 금융 오류율

### 11.2 코호트 항목 (활성화 변경에 넣을 형태)

```ts
export const KRX_COLLECTION_COHORTS: readonly KrxCollectionCohort[] = [
  {
    id: 'krx-15-<3b 활성화일 YYYYMMDD>',
    obligationStart: '<3b 활성화일 전날>T15:00:00.000Z', // 활성화일 00:00 KST
    symbols: ['005930', '000660', '034020', '010140', '042660', '005380', '000270',
      '035420', '035720', '068270', '051910', '066570', '086520', '247540', '028300'],
  },
  {
    id: 'krx-70-<55종목 활성화일 YYYYMMDD>',
    obligationStart: '<55종목 활성화일 전날>T15:00:00.000Z',
    symbols: [/* §3의 55종목 */],
  },
];
```

- 고정 테스트([krx-central-candles.config.spec.ts:28-31](../../../backend/src/assets/krx-central-candles.config.spec.ts#L28-L31))도 같은 변경에서 바꾼다.

### 11.3 등록·활성화·롤백 도구 (만들어야 함)

지금 도구로는 안전하게 할 수 없다.

- `seed-kis-fixed-asset-universe`·`dev:recover-local-data`는 목록 전체를 `isActive=true`로 만든다. 55종목을 고정 목록에 넣으면 아무 seed 실행이 순서를 건너뛰고 활성화한다.
- `admin-upsert-asset`은 한 종목씩 upsert한다. 기존 행도 바꾼다.

필요한 것은 코호트 단위 스크립트다.

- 생성만 하고 기존 행은 바꾸지 않는다. dry-run이 기본이다.
- 등록과 해제는 그 코호트의 행만 뒤집는다. 한 트랜잭션으로 한다.
- 코호트가 레지스트리에 없거나 `A`가 미래가 아니면 활성화를 거부한다.

### 11.4 함께 바꿀 것

- 고정 테스트: `provider-config.service.spec.ts:129-130`(국내 15), load-test `harness.spec.ts`의 국내 목록. 고정 목록을 바꿀 때만 해당한다.
- `replay.ts` `DOMESTIC_MARKET`: 부하 시험 재생에서 쓰는 국내 시장 구분이다.
- 문서의 15·40 표기.
- 작은 확인 사항 둘:
  - `GET /api/v1/assets?includeInactive=true`는 역할 확인이 없다. 로그인 사용자는 비활성 등록된 55종목을 목록으로 볼 수 있다. 민감 정보는 아니지만 등록과 활성화 사이를 짧게 둔다.
  - 예산 정책의 비가격 P1+P2 예약 하한 600건([koscom-budget-policy.ts:43](../../../backend/src/providers/koscom/koscom-budget-policy.ts#L43))은 그날 첫 가격 사이클이 종목 수를 게시하기 전에만 쓰인다. 70종목의 최악 예약은 약 3,449건이다. 개장 전 P4(백필)가 그 차이만큼 먼저 들어갈 수 있다. 5초 기준 하루 총량이 한도의 50–68%라 영향은 작다. 강제(3c)를 켤 때 다시 본다.

## 12. 이번 변경 파일

| 파일 | 내용 |
|---|---|
| `backend/src/orders/market-calendar/data/krx-2024.ts` | Q14: 출처를 KRX 공식으로, `version` `2024.1`. 데이터 변경 없음 |
| `backend/src/orders/market-calendar/market-calendar.registry.spec.ts` | 2024 감사 반영(version, provisionalYears, 2024 비잠정 단언) |
| `backend/src/assets/krx-collection-gates.ts` | G4-H는 명시 목록의 비활성 종목도 판정 |
| `backend/scripts/krx-collection-gates.ts` | 사용법 주석에 위 동작을 적었다(코드 변경 없음) |
| `backend/scripts/load-test/prepare.ts` | 픽스처 경합 수정(자산 한 문장 생성), 시간 초과 메시지에 대기 값 |
| `backend/src/assets/krx-collection-gates.spec.ts` | 2024 반영 + 2027 잠정 연도 보고 + 자산 선택 3개 |
| `docs/…/calc/koscom_budget.py`, `koscom_budget.out.txt` | §10 70종목. §1–§9 출력은 바이트 단위로 같다 |
| `docs/…/expansion-70-phase-a-2026-10-15.md` | 이 문서 |
| `docs/…/expansion-70/*` | 디스크 지표, Q14 근거, 후보 CSV, 읽기 전용 SQL |

커밋·push·배포는 하지 않았다. `main` push는 Render 자동 배포를 부른다(backend 변경 포함).

## 13. 남은 관찰·측정

- 10-16 세션: 첫 사이클 계측(`koscom_price_cycle_summary`). 실제 D·지연·스킵을 Render 로그에서 확인한다.
- 10-16 장 마감 뒤: S8로 15종목 ER₃ 5세션 기준선(10-12…10-16)
- Q1 2회(24시간 간격), Q3, S4(증가원), S5(자산 상태), S6·S7(이력)
- Q15 계약, Q13(1분봉 단일가 표현), Q10(지연 분포)
- 3b 15종목 3거래일 G4-I(승인 뒤)
- 70종목 활성화 뒤 3거래일 G4-I·ER·호출량·DB(활성화 뒤)
