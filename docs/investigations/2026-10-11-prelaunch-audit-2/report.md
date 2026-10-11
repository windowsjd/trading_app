# Trading Class 출시 전 2차 심층 감사

감사·초안 작성: 2026-10-11. 보고서 최종 검토: **2026-10-12**. **현재 결과로 출시 준비 완료 판정을 내릴 수 없다.** 관리자 최소 인원, 시즌 정산·제외, 티커 비동기 오류, 일관되지 않은 자산 평가에서 네 가지 결함을 재현했다. 퀘스트 코드 구현과 주요 자동검증 이후 수행한 검토 전용 감사이며 이 결함들은 수정하지 않았다. 금융 서버의 많은 원자성·격리·멱등성 방어가 검증됐지만, 이 네 경로를 대신 보호하지는 않는다.

## 1. 기준과 검증 경계

- 로컬 HEAD, origin/main, 감사 시작 때 읽은 원격 main: `f87c9666c5dd1ea35c6f9e67433cd19a797895da`.
- 실제 감사 대상: 위 SHA **+ 초보 퀘스트 구현 working tree**. 커밋되지 않은 코드를 SHA 자체에 포함된 것으로 표현하지 않는다. 정확한 변경 파일 84개는 [구현 manifest](../2026-10-11-beginner-full-quests/evidence/implementation-manifest.json)로 고정했다. 감사 중과 10월 12일 최종 검토에서 이 파일들의 해시는 변하지 않았다.
- Work 기준 `3985aa1fbdfb1be8fe7d778445a6580984f2d026` 이후 커밋은 `3433701c` 부하 도구, `f87c9666` 선물 종목 반영이다. [커밋 목록](evidence/baseline-commits.txt). 공급자/종목/현물 제외/선물 조회와 검증 fixture 변경도 있어 과거 보고서를 그대로 적용하지 않았다.
- 시작 당시 working tree는 비어 있었고 구현 변경만 누적됐다. [다른 worktree 목록](evidence/worktrees.txt)은 읽기만 했으며 다른 체크아웃을 수정하지 않았다. 감사 후 원격 변경을 섞지 않았다.
- `Trading_Class_Prelaunch_Audit_3985aa1.pdf`는 저장소와 제공 attachment에서 찾지 못했다. 사용자에게 제공된 TC 위험 목록을 조사 단서로 사용했다. PDF의 나머지 미제공 항목까지 검토했다고 주장하지 않는다.
- root/backend AGENTS, docs README/current API·금융 계약, codex-rulepack, policy-decisions, Prisma schema/SQL, HANDOVER 최신 항목을 참조했다. 별도 원본 게임규칙서·계산규칙서·ERD/QA 파일은 제공되지 않았다. 정책 승인 근거는 사용자 지시 및 current 계약, 구현은 코드·DB, 과거 HANDOVER/조사 기록은 당시 증거로 구분했다.

연결 대상은 직접 띄운 PostgreSQL 16 `127.0.0.1:55441`의 `*_test` DB 네 개뿐이다. UTC 테스트 DB에 migration을 적용했다. 로컬 env가 운영 DB를 가리킬 수 있어 모든 금융 실행에 명시적으로 이 URL을 덮어썼다. 운영 DB·Redis·Render·실제 공급자·실사용자 데이터·배포·환경변수 변경은 하지 않았다. 임시 재현 스크립트는 `/tmp`에 작성했으며 [텍스트 증거](evidence/)로 보존했다. [감사 경계](evidence/audit-boundary.json).

## 2. 주요 결과와 1차 지적 재평가

| ID | 현재 판정 | 심각도 / 출시 판단 |
|---|---|---|
| TC-A01 | **CONFIRMED_DEFECT**: 두 관리자 동시 강등·정지·혼합 모두 active admin 0명 | 6/7, 출시 전 수정 |
| TC-D01 | **CONFIRMED_DEFECT**: 정산 완료 뒤 제외가 계정을 suspended로 변경 | 6/7, 출시 전 수정 |
| TC-E01 | **CONFIRMED_DEFECT**: ticker subscribe Promise reject가 child process 종료 | 6/7, 출시 전 수정 |
| TC-D05 | **CONFIRMED_DEFECT**: 조회 중 상태 전환으로 총자산 혼합 평가 | 5/7, 출시 전 수정 |
| TC-E02 | **CONFIRMED_STRUCTURAL_RISK**: 반복 ticker 구독의 입력 DB 작업 예산 부재 | 4/7, 실제 WS/PG 부하 검증 |
| TC-F01 | **CONFIRMED_STRUCTURAL_RISK**: production 설정 누락 시 개발용 HTTP/WS fallback | 4/7, 릴리스 빌드 검증 |
| TC-A02 | **CONFIRMED_STRUCTURAL_RISK**: 공개 인증 자원 admission 미확인 | 4/7, ingress 포함 검증 |
| TC-D02 | **OPERATIONAL_VERIFICATION_GAP**: 종료 경계 Last 확보·복구 | 5/7, 선물 시즌 운영 전 확인 |
| TC-G06 | **CONFIRMED_STRUCTURAL_RISK**: Last-only 기록 이후 구버전 rollback | 5/7, 실제 binary/DB 리허설 |
| TC-E03 | **POLICY_DECISION_REQUIRED**: Spot·호가·FX의 장기 보존·용량 정책 | 3/7, 운영 계약 필요 |
| TC-D04 | **CONFIRMED_STRUCTURAL_RISK**: 랭킹 발행 season 배타 잠금과 거래 대기 | 3/7, 목표 부하 계측 |
| TC-G05 | **CONFIRMED_STRUCTURAL_RISK**: SIGTERM lifecycle/drain 미연결 | 4/7, 종료·takeover 리허설 |
| AUDIT-01 | **CONFIRMED_STRUCTURAL_RISK**: 신규 퀘스트 증거 조회 비용이 계정 이력에 비례 | 3/7, 먼저 계측; 이후 개선 가능 |
| AUDIT-02 | **TEST_COVERAGE_GAP**: PG runner의 동일 DB 사용 시 fixture 오염 | 2/7, 테스트 DB 분리 |

발생 가능성, 조건, 현재/기대 동작, 직접 증거, 파일·라인, 기존 방어, 영향, 세 가지 선택지, 불변조건·회귀 위험·수정 후 기준은 [위험 등록부 14항목](risk-register.json)에 기록했다. 변경하지 않은 코드의 소스 링크는 정확한 `f87c9666…` SHA에 고정했다. 신규 퀘스트 파일은 별도 manifest 기준이다.

### 실제 재현과 반증

**TC-A01.** `OperatorAccountManagementService.updateUserRole` / `OperatorUserStatusService.updateUserStatus`는 자기 변경을 막고 각 transaction에서 active admin 수를 센다. 두 실제 PG transaction이 count=2를 읽은 다음 각기 다른 관리자를 변경하도록 barrier만 삽입했다. 역할/상태/혼합 세 경우 모두 두 요청이 성공하고 관리자 수가 0이었다. 사용자 값이나 count 결과를 mock하지 않았다. 감사 로그의 원자성은 이 집합 불변조건을 보장하지 않는다. [결과](evidence/audit-admin-races.log), [재현](evidence/trading-audit-admin.ts.txt).

**TC-D01.** 제외 서비스가 ended 시즌·active 계정을 읽은 지점에서 대기시킨 뒤 실제 `createFinalSettlementAtomically`를 커밋하고 제외를 재개했다. 결과는 `{season:settled, account:suspended, participant:excluded, finalRanks:1}`이다. 시즌 종료 후 신규 거래 가능성을 재현한 것은 아니다. 기존 거래시간 gate는 남아 있지만 최종 계정/참가자/랭킹 불변조건은 깨진다. 이 재현은 최종 쓰기 함수와 실제 moderation 서비스 경합이며 전체 배치 HTTP 호출은 아니다. 최초 잘못된 tier fixture는 `FINAL_RESULTS_INTEGRITY`로 거부됐고, 정책에 맞는 master 값을 사용한 최종 재현에서 경합을 확인했다. [결과](evidence/audit-settlement-race-verified.log), [재현](evidence/trading-audit-settlement.ts.txt).

**TC-E01/E02.** 수동 `client.on('message')` 콜백은 `void handleMessage`로 Promise를 버린다. ticker subscribe의 snapshot 조회 reject는 polling의 catch나 order-book의 catch를 거치지 않는다. 실제 gateway 함수, EventEmitter client, DB 오류 주입으로 Node 24 기본 모드 child exit 1을 확인했다. 같은 종목 100회 요청은 조회 완료를 기다리지 않고 snapshot selection 100개를 시작했다. 실제 네트워크 WS 서버/운영 DB 폭주는 실행하지 않았다. 출력 coalescing, realtime metadata cache, 일부 채널 제한이 있어도 입력 subscribe의 경로는 별개다. 일반 provider event bus는 Promise 오류를 잡으므로 모든 pub/sub 경로가 같은 결함이라고 확대하지 않는다. [종료](evidence/audit-ws-rejection.log), [반복 요청](evidence/audit-ws-flood.log), [재현](evidence/trading-audit-ws.ts.txt).

**TC-D05.** 실제 Prisma adapter가 `trading_accounts → season_participants → cash_wallets → positions → futures_positions…`를 별도 SELECT로 읽는 것을 확인했다. cash 읽기 뒤 다른 PG transaction에서 현금 1,000 USD를 900 USD + 100 USD 현물로 원자적으로 바꿨다. 실제 평가 함수는 변경 전·후 각각 1,400,000 KRW, 중간에는 1,540,000 KRW를 반환했다. writer는 금융 상태 전환을 모사한 격리 SQL fixture이며 실제 주문 API까지 실행한 재현은 아니다. 일반/초보 portfolio GET의 RepeatableRead wrapper는 별도 방어가 있다. 시즌 daily snapshot과 current ranking은 이 함수를 기본 client로 호출하므로 보호되지 않는다. 읽기 문제를 원장 잔액 손상으로 표현하지 않는다. [결과/SQL 순서](evidence/audit-valuation-race.log), [재현](evidence/trading-audit-valuation.ts.txt).

**반증·정상 방어.** 오래된 랭킹 발행이 최신 결과를 덮는다는 일반 가설은 현재 generation/membership 재검증과 PG 30개 시나리오에서 반증됐다. 일반 포트폴리오가 모두 혼합 조회라는 주장도 RepeatableRead 경계 때문에 부정확하다. 친구 상세에는 최초/최종 공개권한 재검사와 UI 재조회 중 숨김·cache reset이 있다. Last가 없을 때 Spot/Mark로 임의 체결·정산한다는 가설은 현재 코드와 F3/가격 안전성 검사로 반증했다. DB rollback·명령 멱등성·예약/취소 방어를 무시하고 SIGTERM이 곧 금융 중복을 뜻한다고 분류하지 않았다.

## 3. 영역별 심층 검토

### A. 인증·계정·권한·개인정보

경로: AuthController → AuthService → users/refresh_token_sessions, AccessTokenGuard → TradingAccountAccessService → 계정 API; operator controller → 역할/상태/moderation; Records → friendship 공개 검증. JWT는 매 HTTP 요청에 DB의 현재 사용자 상태/역할을 확인한다. 계정 소유권은 id+userId WHERE로 강제하고 존재 여부를 타 사용자에게 구별하지 않는다. refresh는 hash 저장·새 session 생성·이전 active session의 조건부 update count=1을 한 transaction으로 처리한다. logout은 refresh 폐기이며 이미 발급된 access JWT의 즉시 폐기와 동일하지 않다.

인증 PG smoke 1건(가입·로그인·회전·logout·비활성 사용자), 관련 unit/E2E, 관리자 실제 경합을 검토했다. refresh 동시 사용은 조건부 update의 rollback 방어를 확인했지만 이번에 별도 barrier PG 재현은 하지 않았다. 공개 인증 admission은 TC-A02, 관리자 집합은 TC-A01이다. WS 인증은 연결 시이며 장기 연결의 토큰 만료·역할 변경 재인가 정책은 추가 운영 검증 대상이다. Native token 저장은 AsyncStorage를 사용한다. 실제 기기 저장소 보호·탈옥/백업 위협 모델은 검증하지 않았다. 진단·감사 로그의 민감 키 정제 경로는 확인했으며 모든 로그/수집 시스템의 유출 부재를 보증하지 않는다.

친구 상세는 accepted 관계·portfolioPublic·active 상태 및 응답 직전 재검사를 사용한다. 사용자 공개 철회의 모든 네트워크 in-flight 시점에 대한 선형화 정책, Native cache 실측은 미완료다. **준비 상태: TC-A01 수정 전 차단, 공개 API 및 운영 권한 검증 필요.**

### B. 지갑·원장·현물·환전·이체

경로: OrderPanel/FX/Transfer → `/api/v1/trading-accounts/:id` → 기존 Orders/FX/Wallet 서비스 → account/quote/wallet/position 잠금 → 원장·주문·실행 응답 원자적 저장. 증권 KRW/USD·현물 USD·선물 USD를 canonical scope로 구분하고 기존 주문 scope를 다른 지갑으로 재해석하지 않는다. 견적의 수수료 pin, 실행 시 DB 시각·시세·잔액/예약금·계정/시즌 재검증, 동일 key 커밋 응답 재생을 확인했다.

금액은 Decimal/string이고 현물·FX 정책을 퀘스트가 바꾸지 않는다. 지정가는 접수 예약과 체결을 구별하며 Path A/B, 취소와 체결 경합, 시즌 종료 cleanup을 기존 엔진이 소유한다. 학습 상태는 금융 증거를 읽으며 일반/시즌과 위험 축소를 막지 않는다. 복합 FX+이체도 하나의 transaction이다.

PG 주문 입력·지정가 matching·지갑 FX/이체·F1의 이체/증거금 경합, rollback fault, exact key replay, quote deadline 후 재검증을 실행했다. 퀘스트 실제 10단계와 UI 확인 API도 포함했다. 수학 코어에서 이번 변경으로 인한 회귀는 확인하지 못했다. 장기간 모든 원장 대사·production 데이터 integrity·복원 후 전체 대사는 미실행이다. **준비 상태: 검증 경로의 금융 불변조건 통과; 운영 데이터/목표 부하 확인 필요.**

### C. 선물·증거금·지정가·청산·보호주문

경로: FuturesScreen/LimitEntry/ProtectionPanel → 계정·상품·wallet·lifetime fence → FuturesExecution/command/ledger, risk·limit·conditional worker → Ops lease → 동일 금융 코어. 허용된 25개 정확한 USDT 상품 identity와 계약 검증, One-way lifetime, 레버리지/마진 변경 제한, local Decimal precision, fee/PnL rounding을 확인했다.

사용자 체결·지정가·TP/SL·시즌 종료는 Last, UPNL·위험·청산·평가는 Mark, 현물은 Spot이다. 서로 fallback하지 않는다. Last/Mark 수신/유효 시각·instrument/source 검사, 영속 FK/CHECK/trigger, 예약금·isolated/cross collateral, 동일 lifetime 종료, OCO·pending child, 사용자 축소와 보호 실행 경합을 확인했다. risk worker는 lease loss를 관측하면 새 작업을 중단하고 시작한 lane을 정리한다.

실제 PG F1 290, F2 83, F3 49, Conditional 82, 가격 readiness/retention 통합을 실행했다. F2는 느린 wallet에 다른 lane 진행, rollback, bankruptcy, worker cursor/takeover 관련 시나리오를 포함한다. 테스트의 오래된 출력 중 “Spot final pin” 문구는 현재 제품 정책 근거로 사용하지 않았고 실제 소스의 Last pin을 확인했다. 실제 공급자 latency/모든 종목 24시간 coverage 및 실시간 종료 장애는 미실행이다. **준비 상태: 격리 금융 검증 통과; TC-D02/G06 및 운영 플래그 활성화 전 검증 필요.**

### D. 시즌·평가·랭킹·정산

경로: join의 계정·지갑·초기 원장 원자성 → 거래의 시즌 공유 잠금/DB 시각 → daily valuation/current ranking → season 배타 publication → Futures 최종 pin/계정별 종료 → 최종 결과 transaction. scope 무결성, 결과 수치·tier 비교, 예약금/미종료 선물 차단, 최종 계정 closed 확인, generation 역전 거부와 ranking GET의 RepeatableRead를 확인했다.

PG ranking 30, F3 49, 정산·제외와 평가 혼합 시점 재현을 수행했다. 정산과 주문의 경계는 기존 금융/선물 테스트가 검증하며, 모든 운영 정정 API 조합을 추가 경합으로 열거·실행하지는 않았다. TC-D01·D05가 핵심 결함이다. 랭킹 write lock의 거래 latency는 TC-D04다. 수익률 산식의 외부 유입/TWR와 초기자본 대비 시즌 수익률을 구분했으며 임의 reward 지급은 만들지 않는다. **준비 상태: 두 확정 결함 수정 전 차단.**

### E. 공급자·WS·캔들·호가·캐시

현재 계약은 Binance Spot/Last/Mark, KOSCOM 국내, KIS 미국, canonical FX로 역할을 분리한다. ticker → snapshot selector, provider normalized event → metadata cache → fanout, candle supervisor/overlay/pubsub, 호가 loadTarget/역압력 경로를 검토했다. 캘린더 open/closed와 시세 부족을 구분하며 휴장 표시 가격을 신규 시장가 실행에 재사용하지 않는다. Binance REST의 Redis 공유 budget/cooldown과 Last/Mark retention의 참조/시즌 경계 제외도 확인했다.

TC-E01/E02를 gateway 함수 격리 실행으로 재현했다. Last retention PG는 참조된 실행·trigger·final pin을 보호했다. 다중 서버 Redis pub/sub 장애·재구독, KOSCOM/KIS 장중 끊김, 모든 candle 재조정/coverage, 호가 sequence gap 복구를 이번에 실제 provider/Redis로 검증하지 않았다. 기존 soak 문서는 당시 증거로만 읽고 이번 실행 PASS로 합치지 않는다. **준비 상태: WS 확정 결함 수정 전 차단. 이 영역 전체를 상세 검토 완료로 선언하지 않는다.**

### F. Frontend·상태·API·사용성

경로: token storage 직렬 queue/session generation → Axios auth/refresh 단일 실행 → Query key/account binding → 금융 draft/quote/idempotency → 오래된 성공·오류 reject → 계정별 invalidate. 서버 금액/DTO·거래 권한을 UI가 임의 확정하지 않도록 검사했다. 주문 입력이 바뀌지 않은 불확실 응답은 같은 key로 확인하고 계정/세션 전환 시 늦은 명령 결과를 다른 화면에 적용하지 않는다.

친구 상세는 fetch 중 cached portfolio를 표시하지 않고 초보 학습도 서버 증거와 실습 session을 구분한다. 현물 holding과 선물 position을 분리하고 일반/시즌을 학습 제한에서 제외한다. 퀘스트 구현 검증에서 167 test file, 관련 후속 테스트, typecheck/lint/Web build, 19 layout·9 기존 안내·신규 8개 퀘스트 두 환경을 실행했다. 확대 글꼴 compact 스포트라이트는 직접 screenshot으로 확인했다.

TC-F01은 실제 production env 모듈 평가로 Android `http://10.0.2.2:3000`, iOS localhost, HTTPS Web에서도 HTTP host:3000 fallback을 확인했다. 실제 출시 bundle의 설정 값은 미확인이다. iOS/Android physical device, VoiceOver/TalkBack, native keyboard/safe area, OS background 중 거래 응답은 미실행이다. **준비 상태: Web 검증 통과; 릴리스 설정과 Native 검증을 남긴다.**

### G. 인프라·DB·워커·운영 복구

Nest 모듈형 monolith, PrismaPg pool, DB ownership/FK/CHECK/부분 unique, OpsJobLock owner 조건·lease 갱신, 워커 주기와 transaction 경계를 검토했다. migration deploy는 별도 로컬 빈 DB에 실행했다. CI는 Node 24/백엔드 pnpm/프론트 npm 및 opt-in integration을 사용한다. 이번 구현은 frontend npm을 준수했다.

`main.ts`에는 shutdown hook 등록이 없고 worker destroy가 timer 정리에 그친 경로가 있어 TC-G05로 남긴다. PG 원자성·replay가 있으므로 즉시 중복 금융 손상으로 단정하지 않는다. Last migration 이후 old binary rollback은 TC-G06이다. 가격 데이터 장기 용량, 백업/PITR 복원, 실제 Render instance/pool/metric, Redis topology/예산, SIGTERM chaos는 미실행이다. 저장소의 1,000명 도구는 기능 smoke 산출물이며 실제 목표 부하 수행 증거가 아니다. 현재 WSL에서 −1.6초대 역행도 관측해 이 환경의 latency 값을 운영 기준선으로 삼지 않는다.

**준비 상태: 운영 검증 필요. G는 코드 경계 검토와 일부 lease/PG 검증이며 운영 복구까지 완료했다고 선언하지 않는다.**

## 4. 교차 시나리오와 커버리지

| 통합 경로 | 실제 확인 수준 / 남은 범위 |
|---|---|
| 시즌 종료 × 현물/선물 체결 | 주문 입력·지정가·F1/F3 PG; 모든 시장 실제 휴장 시각/운영 배포 경계 미측정 |
| 금융 명령 × 사용자/관리자 상태 | HTTP 최신 사용자 guard·계정 잠금 코드, 관리자 동시 변경 PG 결함; 모든 사용자 정지 중 체결 interleaving 미실행 |
| 지갑 이체 × 선물 증거금 | F1/F2/복합 지갑 PG 경합 통과 |
| 시세 장애 × 지정가/청산/정산 | matcher/조건부/F2/F3/price-safety PG; 실제 공급자 장애 미실행 |
| 포지션 종료 × 보호주문 | Conditional/F2 PG 및 lifetime/자동 종료 제외 코드 검토 |
| 계정 전환 × 늦은 금융 응답 | frontend test 및 기존 browser 흐름; Native 미실행 |
| 공개 철회 × cache/API | 양쪽 서버 검사·frontend fetch 숨김/reset, 기존 tests; 실제 두 기기 경합 미실행 |
| 서버 종료 × transaction/lease | 코드·rollback/replay·worker tests. OS SIGTERM/강제 종료 chaos 미실행 |
| DB/Redis 장애 × 구독 | gateway DB 오류 주입 재현. 실제 Redis 중단/다중 서버 미실행 |
| 배포 × migration/상품/worker | 로컬 migration/상품 identity·설정 코드 검토. Render 실제 배포 미실행 |
| 랭킹 발행 × 거래/평가 | PG 30 시나리오 + 평가 SQL interleaving 결함; 목표 부하 lock latency 미실행 |
| 보존 × 과거 재생/정산 | 실제 Last readiness/retention PG. Spot/호가/FX 장기 보존 정책 미확정 |
| 고부하 × 금융/worker 경쟁 | F2 느린 wallet·lane PG. 실제 1,000명 cloud 시험 미실행 |

상태를 구분하면 A/B/C/D/F의 위 명시 경로는 상세 검토와 실행을 수행했다. E의 provider별 복구 전체, G의 실제 배포·종료·복원은 **부분 검토/운영 확인 필요**다. 별도 문서 미제공과 Native·Redis·실제 cloud 접근 범위 때문에 전체 시스템 무결성이나 7개 영역 모든 세부 경로 완료를 선언하지 않는다.

## 5. 실행 결과와 실패 분류

- 구현 검증은 [구현 보고서](../2026-10-11-beginner-full-quests/implementation.md)에 모두 기록했다. Backend API E2E 406, 신규 unit 37, 전체 퀘스트 PG 2, 기존 frontend 167 file, Web export 통과.
- 감사 추가 unit: **11 suite / 210건 PASS**. source-selected test 이름 중 별도 파일이 없는 이름은 실행 건수에 포함하지 않았다. [로그](evidence/audit-targeted-unit.log).
- 인증 PostgreSQL smoke **1 PASS**, 랭킹 **30 scenarios PASS**, 선물 F2 **83 checks PASS**, F3 **49 scenarios PASS**, 지정가 매칭 단독 DB **PASS**. 각각 [로그](evidence/).
- 가격 안전성 PG **1 integration PASS**. F2/F3와 같은 DB에서 묶어 실행했을 때 **2 FAIL(P2002 symbol 충돌)**이 발생했다. 원인은 앞선 price-safety runner가 fixture를 남기는 전용 DB 계약이다. F2/F3를 각각 빈 DB로 나누어 83/49를 확인했다. 실패를 제품 금융 결함으로 취급하거나 원래 실행을 PASS로 바꾸지 않았다. [원 실행](evidence/audit-futures-pg-enabled.log).
- opt-in flag를 지정하지 않은 최초 futures 감사 호출은 **3 SKIP**이었다. 이후 각 실행 플래그를 명시했다. [최초 로그](evidence/audit-futures-pg.log).
- 확정 결함 재현: 관리자 PG **3가지 경합**, 정산·제외 PG **1가지**, 평가 PG **1가지**, WS source subprocess **exit 1**, 반복 subscribe **100 input → 100 selections**. 이는 안전성 PASS가 아니라 결함 재현 성공이다.
- 시계 역행/소켓 권한/테스트 초기화·fixture 간섭은 구현 보고서에 분리했다. OS 시간, freshness, 검증 단언을 완화하지 않았다. Native 실기기·실제 Redis 장애·provider/cloud 부하·SIGTERM·backup restore는 **미실행**이다. 10월 12일 iOS·Android Hermes 및 Web 번들 export는 통과했다.

## 6. 후속 우선순위

**출시 전 수정:** TC-A01, TC-D01, TC-E01, TC-D05. 관리 집합의 공통 직렬화, 시즌 상태 변경의 같은 경계, 비동기 Promise 소유권, 계정별 일관된 평가 읽기를 목표로 한다. 기존 monolith/PG 구조 안에서 좁게 보완하는 것이 우선이며 마이크로서비스·메시지 큐·새 matching engine은 현재 증거로 필요하지 않다. 구체적인 파일/알고리즘 변경은 별도 수정 작업에서 다시 확인해야 한다.

**출시 전 검증 후 결정:** ticker 입력 예산/인증 ingress, 릴리스 HTTPS/WSS, 종료 drain/lease takeover, Last rollback, 실제 목표 부하와 ranking lock latency, Native 화면·키보드·접근성. 안정된 시계와 실제 배포에 대응하는 격리 자원이 필요하다.

**정책/운영 결정:** Last 종료 경계 증거 유실 처리·수집 지속·복원, Spot/호가/FX 보존 기간. 퀘스트 전체 체험에는 조건부·지정가·선물 및 관련 worker/price readiness의 승인된 운영 활성화가 필요하다. 지금의 기본 OFF 설정을 감사 편의로 변경하지 않았다.

**출시 후 개선 가능:** AUDIT-01의 계정 이력 규모별 조회 최적화. 먼저 EXPLAIN/쿼리 수·잠금 시간을 측정하고 Backend 증거 검증을 약화하지 않는다. AUDIT-02는 테스트 runner의 독립 DB 계약을 명시하면 제품 코드 변경 없이 개선할 수 있다.

**수정 불필요/반증:** Last 누락 시 임의 대체를 허용하자는 방향, 미체결 주문을 완료 체결로 보자는 방향, 모든 평가 경로가 이미 동일하게 취약하다는 일반화, worker 프로세스 종료를 곧바로 중복 금융 효과로 단정하는 주장은 채택하지 않는다.

감사 중 source/test/schema/migration 변경·commit/push/PR/배포는 없었다. 최종 자체 반증을 거쳐 영향 범위와 증거 수준을 낮춰 표현한 항목은 구조적 위험/운영 공백으로 남겼다. 네 확정 결함과 운영 미검증 항목이 해소되기 전에는 이 보고서를 출시 승인으로 사용하면 안 된다.

## 7. 보고서 확정 — 2026-10-12

퀘스트 마무리 검토와 실행 가능한 최종 검사가 끝난 뒤 보고서·위험 등록부·증거를 대조했다. Backend 관련 unit 37건, Frontend `npm run check`의 167개 test file 및 타입·두 lint gate, Web/iOS/Android export가 통과했고 구현 파일 84개의 해시가 감사 기준과 일치한다. [구현 최종 검토](../2026-10-11-beginner-full-quests/implementation.md)와 [확인 기록](../2026-10-11-beginner-full-quests/evidence/final-review.json)을 참조한다.

14개 위험의 분류·심각도·출시 판단·근거·현재 방어·선택지·수용 기준과 네 결함의 재현 로그를 확인했다. 로컬 링크·JSON·위험 ID·필수 필드, 고정 SHA 소스 경로, 미실행 범위, PASS/FAIL/SKIP 구분도 검토했다. 보고서 작성과 최종 검토는 완료했다. 확정 결함 수정, 실기기·운영 장애/부하·복원 검증 및 출시 승인은 별도 미완료 사항으로 남는다.
