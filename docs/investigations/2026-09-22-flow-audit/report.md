# 실제 앱 흐름 기반 운영 안정성·중요 품질·확장성 조사

## A. 조사 기준과 요약

조사일: 2026-09-22. **제품 코드는 수정하지 않았다.** 먼저 [흐름 등록부](flow-register.md)에 F01~F29를 등록한 뒤, 화면→API→권한→금융 처리→저장→후속 조회 순으로 조사했다. 이 문서는 수정 승인 요청이나 정책 변경안이 아니라, 이후 작업을 선택하기 위한 근거다.

| 기준 | 직접 확인한 내용 |
|---|---|
| 로컬 HEAD | `dc138a3ffede091c32b17359ec79585ec7f32e9c` |
| 시작 상태 | working tree clean. 보존해야 할 기존 미커밋 변경 없음 |
| 원격 main | 읽기 전용 GitHub 조회에서 같은 SHA |
| 비교 기준 | 사용자 제시 `fc79a794e4024bf4eb8c955f4dcd590135b6495a`. HEAD까지 변경은 frontend 비율 슬라이더·관련 테스트 등 11개 파일 |
| 환경 | Linux 작업 공간, Node v24.14.1, npm 11.11.0, 설치된 pnpm·프로젝트 의존성 사용 |
| 자료 | 루트/백엔드 AGENTS, HANDOVER의 안내·관련 이력, backend README/정책·API·운영 문서, frontend 계정 전환·캐시 복구·홈/원장·거래 UI 문서, scripts, CI, schema 및 관련 migration SQL |
| 접근하지 않은 환경 | 운영 DB, Render 설정/로그, Valkey, 실제 KIS/Binance/환율/광고 공급자, 실제 브라우저·Android/iOS 기기 |
| 미입수 자료 | 별도 첨부된 2026-09-19 v3 인수인계서. 접근 가능한 첨부는 조사 요청문이었으며, v3를 읽었다고 간주하지 않았다. `622823…`는 전달받은 역사적 기준일 뿐이다 |

주요 결론은 **P1 6건, P2 6건**이다. 확인된 범위에서 별도의 서버 권한 우회나 이중 차감 P0는 입증하지 못했다. 이는 모든 금융 동시성 조합에 대한 안전 인증이 아니다. 특히 R01은 공용 기기에서 이전 사용자 세션이 되살아날 수 있어 먼저 다뤄야 한다.

| ID | 우선순위·분류 | 핵심 결과 | 검증 수준 |
|---|---|---|---|
| R01 | P1 운영 결함 | 이전 세션의 늦은 refresh가 새 로그인 토큰을 덮어쓰거나 삭제 | 실제 client 제어 흐름 재현 |
| R02 | P2 운영 결함 | 저장소 오류가 세션 만료 통지·로그아웃 화면 전환을 중단 | 만료 통지 재현, logout 연결 정적 확인 |
| R03 | P1 운영 결함 | 시즌 참가 가능성 확인 후 종료 경계를 넘겨도 계정·초기 자금 생성 | 실제 service+policy의 통제된 시각 재현; 정산 경합은 정적 위험 |
| R04 | P1 운영 결함 | 앞쪽 미체결 후보 때문에 뒤쪽 체결 가능 주문을 계속 탐색하지 못함 | 양 모드·매수/매도, 3주기 재현 |
| R05 | P1 운영 결함 | ticker 폴링의 DB 오류가 처리되지 않은 Promise 거부로 프로세스 종료 가능 | 실제 timer 경로, 기본 Node 자식 프로세스 종료 재현 |
| R06 | P1 운영 결함 | 늦은 이전 랭킹 계산이 최신 랭킹·참가자 평가를 덮어씀 | 실제 refresh/writer 제어 흐름 재현 |
| R07 | P2 구조·확장성 | 거래 후 시즌 전체 재평가·전 이력 조회·행별 교체, 일부 제곱 비용 | 정적 비용 구조 확인 |
| R08 | P2 구조·확장성 | 일반계정 누적 FX 검증에서 원장 비교가 환전 수의 제곱으로 증가 | 실제 검증 함수의 연산 횟수 재현 |
| R09 | P2 조건부 운영 위험 | 일부 작업은 잠금 TTL이 지나도 실행을 계속하고 갱신하지 않음 | 설정·호출 연결 정적 확인; 다중 인스턴스 조건 |
| R10 | P1 릴리스 검증 결함 | Prisma 생성이 추적 파일을 바꿔 캔들 검증이 시작 전에 중단 | 현재/이전 CI 로그 + 격리 clone 재현 |
| R11 | P2 중요 품질 | 현재 정책으로 안내된 문서에 주문 종류·잠금·fee·scope 설명 충돌 | 현재 코드·SQL·문서 대조 |
| R12 | P2 운영 결함 | 랭킹 한 응답의 기준 시각·목록·내 순위가 서로 다른 갱신본을 읽을 수 있음 | reader/writer 연결 정적 확인 |

재현의 “실제”는 원본 TypeScript를 변환하여 해당 함수를 실행했다는 뜻이다. DB·HTTP·저장소·시세 공급자는 대역(mock)이다. PostgreSQL 잠금, AsyncStorage 실제 고장, 모바일 화면 동작을 재현했다고 주장하지 않는다. [재현 코드](reproduce.cjs), [결과 JSON](reproduction-results.json), [CI 증거](ci-evidence.json)를 함께 보관했다.

| 선행 가설 | 판정 |
|---|---|
| H1 랭킹 비용 | 확정 R07. 추가로 오래된 writer R06, 조회 중 갱신본 혼합 R12 확인. DB 잠금은 있지만 계산 결과의 선후를 보장하지 않음 |
| H2 지정가 탐색 정체 | 확정 R04. 함수명의 buy와 달리 매수·매도 모두 영향 |
| H3 스냅샷·계정 조회 | 수정하여 확정 R08. 기존 snapshot 일괄 조회·skip은 구현됨. 홈의 네 요청 모두가 전체 FX 검증을 한다는 가설은 기각 |
| H4 실시간·공급자 중복 | 일부 확정 R05. 공유 socket·최신 메시지 합치기·실시간 candle 소유권 lease는 이미 있음. 독립 공급자 수집과 FX 요청 병합의 다중 인스턴스 한계는 E/G의 조건부 항목 |
| H5 세션·계정 경합 | 세션은 R01/R02 확정. 계정 전환의 거래 대상 혼동은 기존 계정 고정·캐시 분리·완료 시 대상 계정 갱신으로 반박됨 |
| H6 가격 계약 분산 | 광범위한 정책 불일치 가설 기각. 목적별 freshness와 휴장 평가/거래 차이는 의도적. 공통 selector/calendar를 재사용하며 실행 기준 완화 근거 없음 |
| H7 대형 서비스·DI | 현재 wiring 누락 결함은 확인 못함. 필수 역할을 Optional로 표현한 부분은 다음 관련 변경 때 개선. 파일 크기만의 분리 제안은 기각 |
| H8 설정 조합 | strict parser·조합 검증·readiness가 상당 부분 존재. 실제 배포 조합 미확인. 전면 설정 교체 근거 없음. 전역 scheduler false가 강제 정지를 뜻하지 않는 점은 G에서 명시 |
| H9 CI | R10 확정. 현재 SHA 5개 job PASS/캔들 FAIL; 이전 baseline도 같은 원인. opt-in 금융 PG 테스트는 별도 CI에서 실제 실행 |
| H10 문서 | R11 확정. historical이라고 표시된 이력 자체는 결함에서 제외 |

## B. 실제 흐름 목록과 조사 현황

시작·완료 조건, 적용 모드, 쓰기 데이터, 주요 진입점은 [최초 등록부](flow-register.md)를 유지하고, 아래 C가 정상·차단·실패·복구·테스트·공백을 보완한다. 공통 기능 설정은 G에 모았다. “정적 조사”는 연결된 코드와 보호장치를 읽었다는 뜻이며 운영 성공을 뜻하지 않는다.

| 흐름 | 운영 안정성 | 중요 품질·확장성 | 검증 근거·남은 공백 |
|---|---|---|---|
| F01 시작/복원 | 정적 조사, R01/R02 연계 | 초기 실패와 세션 구분 | auth/entry/session 테스트; 실제 기기 저장소 미실행 |
| F02 인증/갱신/종료 | 재현 R01/R02 | 경계 책임의 누락 | client 원본 실행, auth unit/E2E/CI PG; 실제 앱 동시 로그인 미실행 |
| F03 시즌 참가 | 재현 R03 | lifecycle와 쓰기 경계 | seasons join 테스트·CI PG; 종료/정산 실제 PG 경합 추가 필요 |
| F04 일반 개설 | 정적 조사 | 금융 조회와 개설 분리 유지 | general-account 테스트·CI PG; 운영 데이터 미조회 |
| F05 계정 전환 | 정적 조사 | 계정별 query/명령 고정 유지 | accountSelection/accountScope/quotedAction; 기기 lifecycle 공백 |
| F06 마켓 목록 | 정적 조사 | 페이지·시장/검색 scope | assets/ticker store 테스트; provider 실시간 공백 |
| F07 상세/주문 UI | 정적 조사 | route/account/asset 고정 | trading UI·비율 slider Node 테스트; native 터치 미실행 |
| F08 차트 | 정적 조사 | HTTP/실시간 merge·수명주기 | candle/merge/shared socket 테스트; fixture CI R10, 실기기 공백 |
| F09 시세 수신 | 정적 조사 | 공급자별 중복 억제 범위 | ingestion/streaming 테스트; 실공급자·다중 인스턴스 공백 |
| F10 캘린더/휴장 | 정적 조사 | 공통 세션 selector 유지 | calendar/closed-price tests; 미래 달력·실제 override 미확인 |
| F11 WebSocket | 재현 R05 | bounded queue·poll overlap | gateway/shared socket 테스트; 실제 연결 부하 미측정 |
| F12 캔들 파이프라인 | 정적 조사 | sync lock/cache/retention | unit PASS, 현 HEAD fixture 미실행 R10 |
| F13 지갑/원장 | 정적 조사 | scope·예약·batch metadata | wallets/ledger 테스트, 금융 CI; 깊은 페이지 비용 미측정 |
| F14 환율 | 정적 조사 | 프로세스 내 single-flight | fx-refresh 테스트; 실 API 한도/다중 instance 공백 |
| F15 시장가 | 정적 조사 | 공통 금융 코어 유지 | orders/transaction-time/fee CI; 응답 유실 실제 단말 공백 |
| F16 지정가 등록 | 정적 조사 | durable quote·예약 | 양 모드·양 방향 unit/PG CI; 새 결함 없음, R08 연계 |
| F17 지정가 매칭 | 재현 R04 | 탐색/체결 예산, R09 | 실제 repository+matcher 제어 흐름; PG 실행부 CI 별도 PASS |
| F18 취소/정리 | 정적 조사 | order lock·원자적 해제 | reservation/cancel/cleanup PG CI; 장기 중단 복구 운영 공백 |
| F19 환전 | 정적 조사 | 멱등·수수료 고정, R08 | FX PG CI; 환율 공급자 미연결 실험 없음 |
| F20 홈/성과 | 정적 조사 | TWR·부분 장애, R08 | 실제 API mapper/query/render Node tests; 물리 기기 미실행 |
| F21 광고 보상 | 정적 조사 | 자금 유입 전후 경계 유지 | fake verifier unit/CI; 실제 verifier 미연동 |
| F22 일별 기록 | 정적 조사 | 기존 행 skip, 전체 대상 비용 | 일반/시즌 snapshot unit; 누적 규모 실측 없음 |
| F23 현재 랭킹 | 재현 R06, 정적 R12 | 전체 갱신 R07 | ranking unit + 통제된 경쟁; PG 새 경쟁 시험 미실행 |
| F24 종료/정산 | 정적 조사 | final 불변성·계정 종료 유지 | settlement/lifecycle unit; 참가 경합 R03 PG 확인 필요 |
| F25 전적/공개 요약 | 정적 조사 | cache shape 분리 유지 | records/cache/render tests; 실제 native 화면 공백 |
| F26 보상/배지 | 정적 조사 | 내부 상태·외부 지급 분리 | fulfillment unit/E2E; 외부 지급 연동 없음 |
| F27 운영자 | 정적 조사 | service 권한·audit | operator/admin/calendar tests; 모든 관리자 경쟁 조합 전수 검증 아님 |
| F28 시작/작업/복구 | 정적 R09/R10/R11 | lease·flags·릴리스 상태 | configs/ops locks CI; 운영 설정·중단/재배포 실험 없음 |
| F29 보조 화면 | 정적 조사 | 세션 경계 R01/R02 | guide/MY/record tests; native 복귀 공백 |

누락 대조: `app/navigation`의 Root/Auth/Home/Market/Ranking/Record/My/Guide stack, 모든 `*controller.ts`의 HTTP 진입점, `AssetTickerGateway`의 현재가·캔들·호가·환율, OpsScheduler와 전용 limit/candle scheduler를 대조했다. 구 `/orders`, `/fx`, `/wallets`, `/positions`, `/portfolio`, `/home`도 접근 가능한 시즌 호환 경로로 F13~F20에 포함했다. API base는 `/api/v1`이다. `/health`, `/health/db`, `/readiness`는 F28, 프로필 PATCH는 F02/F29, 운영자 user/role/status/season/calendar/provider/reward는 F26/F27이다.

CLI는 `admin-run-batch-job`, 일별/랭킹 생성, provider-ingest, candle baseline/smoke, asset seed/upsert·수동 가격/환율, general audit/backfill·account/ranking repair·dev recovery를 F09/F10/F12/F22~F28에 연결했다. 환경 로더·실행 의도·dry-run/apply 경계를 읽었으며, 데이터 변경 CLI는 실행하지 않았다. 모든 복구 도구의 모든 손상 입력을 시험한 것은 아니다. 폐기된 Redis Stream matcher는 현재 실행 경로로 포함하지 않았다.

## C. 흐름별 조사 결과

이 절의 backend 경로는 `backend/src/`, frontend 경로는 `frontend/src/` 기준이다. 관련 단위 테스트의 이름군은 대상과 같은 디렉터리의 `*.spec.ts`/`*.test.ts`를 뜻한다. 전체 테스트 실행 범위는 H에 명시했다.

### F01. 앱 시작과 세션 복원

`screens/auth/SplashScreen.tsx → features/auth/useEnterApp.ts → me API / entry.ts → TradingAccountContext`를 따라갔다. 토큰이 없으면 로그인, 유효 사용자이면 소유 계정·사용자별 저장 선택과 진입 intent로 이동한다. 초기 네트워크 실패는 재시도 상태이며 미참가를 가짜 계정으로 만들지 않는다. 화면 unmount 보호와 선택 저장 실패의 fallback이 있다. 백엔드 `/me`는 전역 guard가 현재 User 상태를 확인한다. 세션 자체의 새 세대 판정은 없으므로 R01/R02가 복원 이후에도 영향을 준다. entry/session 단위 테스트 PASS; 실제 OS 저장소 고장·앱 재개는 미실행.

### F02. 회원가입·로그인·갱신·로그아웃

`Login/Signup → auth/api → AuthController/AuthService → User/RefreshTokenSession → saveTokens → beginSession → navigation`이다. 가입·로그인은 서버 검증, refresh는 저장된 hash·만료·사용자 상태 검증 후 transaction 안에서 교체하며 이전 세션의 조건부 revoke가 동시 사용을 막는다. HTTP마다 DB의 active/role을 다시 확인한다. logout-all은 refresh들을 폐기하며 발급된 access token의 계약상 수명을 즉시 모두 없애는 기능은 아니다.

클라이언트의 동시 401 요청 병합(single-flight)은 같은 프로세스에서 중복 refresh를 줄인다. 하지만 logout/login과 연결된 세션 세대가 없어서 R01이 발생한다. 저장소 오류는 R02다. 캐시 seed/clear helper 테스트는 interceptor부터 실제 로그아웃까지의 경계를 다 검증하지 않는다. 재현은 HTTP 없이 그 경계를 실행했다. 서버 auth PG CI는 기존 refresh 경합을 검증하지만 이번 frontend 경쟁을 반박하지 않는다.

### F03. 시즌 조회와 참가

`SeasonJoinScreen → GET seasons/current/list → POST seasons/:id/join → SeasonsService.joinSeason`이다. 거래 가능 시간과 사용자 상태를 확인하고 같은 transaction에 시즌 TradingAccount·Participant·KRW/USD wallets·initial_grant 원장·origin equity를 생성한다. `(seasonId,userId)` unique가 중복 참가를 차단하며 재참가는 재지급되지 않는다. 다만 최초 시간 검사 이후 쓰기까지 재검증이 없어 R03을 확인했다. 종료·정산 job과의 실제 PG 경합은 추가 시험해야 한다.

### F04. 일반계정 개설

`ModeSelection → POST trading-accounts/general → GeneralAccountsService`가 소유 사용자 기준 일반계정을 명시적으로 연다. 일반계정은 현재 시즌 없이 사용할 수 있다. partial unique, 초기 grant unique, transaction이 중복 계정·중복 초기 지급을 막는다. 기존 일반계정 재진입은 조회이며 손상 시 자동 보정·재지급하지 않는다. 일반 origin equity와 초기자본 계약을 같이 확인했다. 개설/조회·손상 분기 unit와 현재 SHA의 Core account PG job PASS. 현재 자료에서 별도 주요 결함은 확인하지 못했다.

### F05. 계정 선택과 전환

`TradingAccountContext → owned accounts query → selectionStorage → account-scoped API`가 기준이다. 목록 key는 사용자, 금융 key는 accountId, 선택 저장은 사용자별이다. 목록에 없는 저장 ID는 버린다. 새 로그인은 모드 선택, 복원은 소유한 저장 계정을 우선한다. 서버는 `TradingAccountAccessService`로 실제 소유권을 재확인한다.

주문 route/accountId 고정, panel key와 epoch, FX 상태 초기화, `quotedAction.ts`의 실행 중/완료 잠금이 있다. 전환 도중 완료된 거래의 invalidation도 원래 거래 계정을 사용한다. 화면이 살아 있는 불확정 재시도는 같은 명령 key를 유지한다. unmount 후 key를 영속적으로 복원하는 기능은 없으므로 기록 조회로 성공을 확인해야 한다(G). 계정 캐시 혼합 가설은 해당 보호와 테스트로 기각했으나 사용자 세션 경계 R01은 별개다.

### F06. 마켓 목록·검색

`MarketScreen/MarketSearchScreen → assets API/AssetsService → active Asset + snapshot selector → ticker store`이다. 검색/market/filter/page가 query key에 반영되며 일반/시즌 모두 공개 시장 데이터를 공유한다. 국내 KRW, 미국 USD, crypto의 내부 USD/외부 USDT 표시는 현행 계약을 따른다. 가격 미제공은 nullable/state로 전파되며 0을 실행 가능한 가격으로 만들지 않는다. 목록 batch 가격 처리·pagination을 확인했다. DB/외부 공급자 비용은 자산 수·동시 요청에 따라 증가(E). 현재가 전파 장애는 R05로 묶었다.

### F07. 상세·보유·매수/매도 패널

`AssetDetailScreen → asset/price/orderbook + 계정 positions → OrderPanel 또는 OrderScreen`을 확인했다. 화면 시세/호가는 주문 승인 자료가 아니며 서버 durable quote와 실행 재가격을 거친다. 종목/계정 변경 때 기존 quote·입력 비동기 결과가 다른 주문에 적용되지 않도록 경계가 있다. 비율 slider를 포함한 현재 HEAD frontend 테스트가 PASS했다. 실제 native drag·회전·백그라운드 복귀는 검증하지 않았다. 실제 기기 확인을 source 결함으로 대체하지 않는다.

### F08. 차트와 실시간 합성

`AssetChart/useAssetCandle → GET assets/:id/candles → AssetCandlesService`, 그리고 shared realtime의 candle snapshot/update를 합친다. 자산·interval·range별 캐시, 봉 시각/sequence/revision, subscribe/unsubscribe와 재연결 재동기화가 존재한다. fullscreen과 일반 상세는 같은 데이터 의미를 사용한다. incomplete/stale 상태를 완전한 과거 봉으로 조용히 승격하지 않도록 provider completeness 경로를 확인했다. 단위·Node 합성 테스트는 PASS; 현 HEAD의 PG+Redis fixture는 R10 때문에 본문이 실행되지 않았고 native gesture는 미실행이다.

### F09. 공급자 시세 수신

`ProvidersModule → KIS/Binance transport/parser/ingestion → AssetPriceSnapshot/event bus/pubsub → Assets/valuation/orders/ticker`를 확인했다. source/effectiveAt/capturedAt 의미와 유효 숫자·자산 매핑·저장 제한이 있다. 현재 고정 universe는 Binance 25개, KIS 40개(코드 기준)이며 실제 DB 활성 종목 수는 미조회다.

live candle 수집이 해당 provider를 소유하면 standalone streaming은 시작하지 않는다. live supervisor는 Redis 임대 잠금(lease)으로 provider 소유자를 정하고 상실 시 socket을 닫는다. 반면 standalone 모드와 일부 REST refresh 병합은 프로세스 범위다. 단일 프로세스 보호를 다중 인스턴스 보호로 확대 해석하지 않았다. 공급자 한도·실제 정체·재접속 부하는 G의 운영 공백이다.

### F10. 캘린더·휴장·종가 복구

`market-calendar registry/override loader → market-aware source selector → KIS closed-price recovery`다. 휴장 표시/평가는 최근 완료 세션의 시간 범위를 DB 조건에 먼저 적용하고 적격 source를 고른다. 최신 N개 조회 후 우연히 과거 종가를 찾는 구조가 아니다. 실행은 개장·fresh provider 조건을 별도로 요구한다. KIS 종가 복구는 정확한 business date·symbol·OHLCV 증거로 effectiveAt을 결정하고 capturedAt을 실제 수신 시각으로 보존한다.

캘린더 불명은 차단하고, override 초기 로딩 실패와 이후 마지막 정상본 유지 상태를 구별한다. 현 코드의 달력은 2025~2027, provisional 연도의 readiness 저하가 있다. 운영 override/미래 공휴일을 현재 검증했다고 할 수 없다. 수동 가격을 조용한 execute fallback으로 허용하는 결함은 확인하지 못했다.

### F11. 공유 WebSocket

`services/ws/sharedRealtimeSocket.ts/socketClient.ts → /api/v1/ws AssetTickerGateway`를 따라 현재가·캔들·호가·환율을 확인했다. frontend는 URL별 공유 연결/구독 참조 계수와 재연결·resync를 사용한다. gateway는 handshake 인증, 자산 검증, 최신 메시지 합치기, candle/orderbook 구독 상한과 1MiB backpressure 기준을 둔다. ticker 대기열은 client당 64개로 제한된다.

그러나 3초 snapshot fallback polling은 비동기 오류를 잡지 않으며 이전 poll 완료도 기다리지 않는다(R05). 이벤트 전파를 per-event DB 조회로 바꾸는 해결은 역효과다. Node 대역 재현에서 default unhandled rejection으로 exit 1을 확인했다. 운영 NODE_OPTIONS·실접속 부하·토큰 교체 시 모든 native socket의 재인증은 미확인이다.

### F12. 캔들 수집·저장·집계·보존

`sync scheduler/CLI/GET → sync state/provider reader → MarketCandle upsert → aggregation/cache → API`와 live finalization/reconciliation을 조사했다. active sync partial unique, provider cursor·coverage, 요청 병합, revision, 재시도와 incomplete 표시가 있다. retention은 기본 35일 지난 5m 대상·기본 5,000행 batch이며 모든 봉과 금융 증거를 일괄 삭제하는 작업이 아니다. 지정가 candle evidence에는 당시 체결 판단 자료가 보존된다.

장애 중 멈춘 수집의 재개와 차트의 사후 복구는 가능하지만, 그것이 장애 당시 지정가 매칭을 모두 수행했다는 뜻은 아니다. 현재 CI fixture의 검증 공백 R10이 크다. 단위 테스트 통과만으로 Redis/PG/실공급자 복구까지 확인했다고 하지 않는다.

### F13. 지갑·사용 가능 잔액·원장

`WalletTransactions/Portfolio → account wallets/transactions controller → WalletsService` 및 시즌 legacy 경로를 조사했다. 잔액과 예약액을 별도로 보내고 가용액을 도출한다. `balanceAfter`는 실제 기록이며 원장 수량은 해당 account의 executed Order.quantity를 batch로 연결한다. 금액/가격 역산 수량이 아니다. 통화·방향·type·pagination key와 타계정 참조 검증이 있다.

손상은 구조화된 무결성 오류이며 0/빈 원장으로 숨기지 않는다. 금액은 Decimal 문자열이다. 관련 serializer/fixture/frontend mapper/render 테스트 PASS. 깊은 offset/count 비용은 E의 측정 후보이며 새 index를 무조건 추가할 근거는 없다.

### F14. 환율 조회·수집·전파

`fx/rates/current 또는 ops ingest → FxService/provider refresh → EXIM, 실패 시 대체 provider → FxRateSnapshot → fx channel`이다. 실제 fetch 성공은 같은 환율이라도 새 observation으로 남기며 오래된 행의 수신 시각을 덮어쓰지 않는다. FX freshness 목적별 구분과 금액 양수 검증이 있다. 지갑 API 실패와 환율 미제공을 frontend에서 구분한다.

`FxService.providerRefreshInFlight`는 동일 freshness key의 프로세스 내 요청을 합친다. display/quote/execute key와 여러 인스턴스까지 하나로 합치지는 않는다. 거래 전 provider I/O 후 transaction 안에서 적격 rate를 다시 읽는다. 실 공급자 속도·quota는 미측정이며 무조건 분산 큐 도입을 제안하지 않는다.

### F15. 시장가 매수·매도

`OrderPanel/OrderScreen → account orders quote/create → OrdersService → durable Quote → execution → wallet/position/ledger/order/equity → invalidation/ranking`이다. 서버는 account ownership, 상태, quote 사용·만료, request 내용, 멱등 키(idempotency key)를 확인한다. Quote 잠금 후 시즌은 공통 Season→Account→Participant 잠금, 일반은 Account 쓰기 잠금 아래 처리하며 필요한 잠금 뒤 DB 시각으로 실행 조건을 확인한다.

신규 양 모드 시장가 quote는 fee를 고정하고 가격은 실행 시 재산정한다. 예약액·예약수량을 제외한 가용액/수량의 조건부 UPDATE와 DB CHECK가 이중 소비를 방어한다. 금융 사건과 저장된 응답은 한 transaction으로 확정한다. replay는 소유권을 먼저 확인하고 이미 성공한 결과를 mutable gate 때문에 다시 거래하지 않는다. 관련 PG CI/fee/transaction-time PASS. 후속 랭킹의 R06/R07이 체결 자체 rollback이나 재차감을 의미하지는 않는다.

### F16. 지정가 매수·매도 등록

`quote → LimitOrderCreateService → submitted Order + cash 또는 position reservation`이다. durable fee basis를 검증하며 매수는 금액, 매도는 수량을 예약한다. 등록은 즉시 체결이 아니고 provider/Redis 정상 여부를 금융 정확성의 유일한 근거로 삼지 않는다. 같은 계정의 다른 차감은 예약을 침범하지 않는다. flag off에서는 신규 quote/create를 차단하되 취소·정리는 가능하다. 일반/시즌 양 방향을 확인했고 기존 reservation/replay PG CI가 PASS했다. 등록 후 처리 정체는 R04, 누적 일반계정 비용은 R08이다.

### F17. 지정가 매칭

`전용 scheduler → OpsJobRunner → CandidateRepository → MatchingService → ExecutionService`다. A는 신선한 적격 snapshot의 buy≤limit/sell≥limit, B는 유효한 완료 candle의 low/high 접촉을 보고 주문 limit 가격으로 체결한다. 실행 transaction이 최신 상태·시간·예약·가격 근거를 재검증하고 모든 금융 반영을 확정한다. 주문별 실패 격리와 DB 잠금은 있다.

탐색에서는 앞쪽 N건이 가격 미충족이면 다음 페이지로 가지 않는다(R04). batch=2, 첫 두 주문 미충족·세 번째 충족의 세 주기를 양 모드·양 방향에서 실행했으며 세 번째는 한 번도 조회되지 않았다. `ordersConsidered=0`, `batchExhausted=false`도 반복됐다. 기본 B lookback 15분 밖의 outage 재처리는 제공하지 않는다(G). matcher PG job의 정상 체결 PASS는 이 탐색 반례를 검증하지 않는다.

### F18. 취소·제외·시즌 종료 정리

`주문 목록 cancel / operator exclude / lifecycle end → cancellation/cleanup → Order lock → reserved release`다. 체결·취소가 같은 주문 상태를 잠그고 transaction 안에서 예약 해제와 상태를 일치시킨다. 차단된 신규 주문과 별개로 취소를 허용한다. 참가자 제외는 계정 상태를 함께 변경하고 정리를 호출한다. 종료 정리가 중간 실패하면 다음 실행이 잔여 submitted를 재처리하며 정산은 열린 예약을 다시 검사한다. 주문별 정확성 보호를 확인했으며 실제 장기간 장애 후 운영 재개는 시험하지 않았다. 다중 실행 비용은 R09, 늦은 신규 참가자는 R03에 연결한다.

### F19. KRW↔USD 환전

`WalletFxScreen → account fx quote/execute → FxService → quote/context/time/rate 검증 → 두 wallet·두 ledger·ExchangeTransaction·FxExecuteRequest·equity`다. 계정·사용자·요청 hash의 멱등성과 저장 응답 replay, 예약금 제외 차감, 30bps 재견적 기준, 양 모드 신규 quote fee 고정을 확인했다. 일반계정은 TWR 경계를 보존한다. foreign quote/request는 소유권 검사로 차단된다. 양 방향/동시성 PG CI PASS. 누적 전체 검증 비용 R08과 화면 unmount 뒤 불확정 결과 확인 한계는 별도다.

### F20. 홈·포지션·포트폴리오·성과

`GeneralAccountHome/SeasonAccountHome → portfolio/wallets/positions/equity(+시즌 ranking)`을 대조했다. 일반 portfolio는 반복 읽기 일관성(Repeatable Read) 아래 현재 평가와 TWR 기준을 연결한다. 일반 외부 자금과 투자 손익을 분리하며 시즌 initial-capital 수익률과 동일 숫자로 취급하지 않는다. KRW만 있는 평가가 불필요하게 USD 환율 실패에 종속되지 않도록 분기가 있다.

시세/환율 장애는 section unavailable, 금융 scope·성과 불일치는 무결성 오류로 차단한다. 일별 추이는 실제 저장 행만 표시한다. 일반 홈은 주요 조회 네 개지만 **positions는 foundation/trading 검증이고 wallets도 전체 FX 원장을 모두 읽는 경로가 아니다.** portfolio의 R08, holdings의 반복 가격 평가 비용을 구분해야 한다. 정산된 final 결과는 F24/F25에서 읽고 현재 평가와 같은 계약으로 보지 않는다. Node 실제 화면/query 테스트 PASS, 실제 mobile layout·gesture 미실행.

### F21. 광고 보상

`eligibility → claim → provider verifier registry → proof/event 검증 → general account lock → 입금·원장·claim·자금 유입 전후 equity`다. provider event unique와 계정 command key, 한도·cooldown, 소유권·일반모드 검증이 있다. 입금은 수익이나 초기자본 수정으로 처리하지 않는다. 현재 실제 verifier adapter가 없어 활성화만으로 지급되지 않고 의도적으로 막힌다. fake verifier 테스트는 지급 코어를 검증할 뿐 실광고 검증 연동 증거가 아니다. 기능 미연동을 결함으로 집계하지 않았다.

### F22. 일별 스냅샷

`OpsScheduler/CLI → DailyPortfolioSnapshotJobService / GeneralDailySnapshotJobService → 평가 → equity/daily writer`다. 시즌 참가자·일반계정을 구분하고 대상의 기존 daily 행을 일괄 읽어 Set으로 건너뛴다. 일반은 account lock 뒤 새 시각·TWR state를 확인해 같은 transaction으로 저장하며 unique가 중복 날짜를 보호한다. 실패 대상 재시도와 날짜 변경·timezone 불일치 차단이 있다.

반면 대상 목록과 IN 집합은 전체를 메모리에 읽는다. 신규 대상마다 valuation과 누적 검증이 있어 활성 계정/이력 증가에 비례해 batch 시간이 커진다(E/R08/R09). 이미 구현된 skip을 다시 만들거나 빈 날짜를 과거 수익으로 채우는 개선은 제안하지 않는다. unit 실행; 대규모 DB·실제 자정 경합 미실행.

### F23. 현재 랭킹 갱신·조회

`거래/FX/limit 완료 또는 scheduled job → RankingRefreshService → 전 참가자 valuation/history → Season lock → daily ranking replace → RankingService → Home/MY/RankingScreen`이다. 계정 scope, 제외/숨김, MDD·동률 정렬과 최종 등급 구분이 있다. writer는 한 transaction이고 ended/settled 상태를 잠금 뒤 재확인해 final을 보호한다.

그 보호는 R06의 늦은 계산 저장이나 R12의 여러 read 사이 교체를 막지 않는다. 참가자 인자는 전체 갱신으로 연결되고, 같은 종류의 진행 중 trigger는 skip되며 뒤따르는 갱신을 예약하지 않는다(R07). 원본 refresh를 통제해 최신 00:02가 먼저 저장된 뒤 이전 00:01이 덮어쓰는 것을 확인했다. 실제 PG 새 경쟁 재현은 미실행이다.

### F24. 종료와 최종 정산

`lifecycle transition → limit cleanup → settlement → endAt 기준 평가 → final rankings/tiers/participant values/account close/settled`다. settlement transaction은 Season FOR UPDATE 후 상태·참가자/계정·열린 예약·기존 final scope/coverage를 다시 검사한다. 부분 실패는 rollback, 이미 확정된 결과는 조용히 다시 평가하지 않는다. excluded/registered도 계약에 따라 금융 계정을 닫으며 final 참가 대상과 구별한다.

현재 거래 writer의 잠금 순서는 이 Season 잠금과 정렬되어 있다. join은 같은 경계에 참여하지 않으므로 R03의 추가 위험이 남는다. 대규모 정산 시간과 공급자 가격 availability, 중단 후 재실행은 unit로 일부 보호되지만 운영 크기 PG 실험은 하지 않았다. 최종 결과를 성능 이유로 약하게 검증하는 방향은 제외했다.

### F25. 전적·과거 계정·공개 요약

`RecordStack/MY/UserSeasonSummary → RecordsController/RecordsService + 명시적 account orders/FX`다. 내 전적은 인증 사용자·해당 시즌 참가자와 account를 연결하며 공개 응답은 nickname/profile 등 허용 정보만 선택한다. hidden/excluded와 final/current의 차이를 확인했다. 페이지/무한 목록은 서로 다른 query key 형태이고 이전 `items`/`pages` 충돌은 현재 코드에서 이미 수정되어 있다. 과거 수정 기록을 새 결함으로 재집계하지 않았다. 조회 기간·offset 상한과 account ID 도착 화면 검증이 있으며 테스트 PASS. 큰 이력의 count/offset 비용은 E에 남겼다.

### F26. 시즌 보상·배지·지급 요청

`rewards/me,badges/me 또는 operator fulfillment → RewardFulfillmentService → 조건부 상태 전이 + SeasonReward/UserBadge + audit`다. global JWT 외에 service 자체에서도 운영자 권한을 확인한다. controller decorator만 보고 무권한이라고 판단하지 않았다. 같은 참가자·reward code/요청 key unique와 transaction이 중복 내부 지급을 막는다. 실패 재시도·취소·이미 fulfilled 구분이 있다. fulfilled는 구현된 내부 기록이며 외부 송금 완료 증거가 아니다. 외부 지급 adapter는 별도 미연동 범위다. unit/E2E PASS.

### F27. 관리자·운영자 작업

`operator/admin guards + service checks → 사용자 상태/role·참가자 제외/숨김·final correction·calendar override·provider run → audit`를 조사했다. 토큰 claim만으로 권한을 유지하지 않고 현재 User 상태/role을 읽으며, 상태 변경 시 refresh 폐기가 연결된다. 중요 mutation과 감사 기록을 같은 transaction에 두는 경로를 확인했다. calendar 변경은 loader/pubsub를 통해 반영되며 즉시 금융 시각을 조작하지 않는다. CLI는 서버 계정 보유 권한을 전제로 하는 별도 운영 진입점이다. 전체 관리자 동시성·외부 접근통제·실제 로그 redaction 전수 시험은 미실행이며, 접근 가능한 route를 frontend 미사용 이유로 제외하지 않았다.

### F28. 시작·스케줄러·작업 잠금·복구

`main/AppModule → config providers/Prisma/Redis → schedulers → OpsJobRunner/Lock/Run → handlers`다. DB startup 연결, flag parser, job 별 활성화, 작업 기록과 소유자 조건부 lock release를 확인했다. candle retention/sync/reconciliation 일부는 lease 갱신을 사용하지만 matcher 등은 default nonrenewal이므로 R09다. SIGTERM 실제 graceful 종료·재배포 겹침은 시험하지 않았다. `/health` 단독은 provider/DB/매칭 정상 실행 증거가 아니며 `/readiness`와 job/시세 지표가 필요하다. 현재 캔들 CI 공백 R10과 정책 문서 R11도 이 흐름에 속한다.

### F29. 가이드·MY·설정

일반모드 GuideTab, 시즌 RankingTab과 MY/Settings/Reward의 실제 navigation 연결을 확인했다. 가이드는 로컬 교육 흐름이며 금융 API에 가짜 거래를 쓰지 않는다. nickname PATCH는 인증 API, 로그아웃은 공통 hook(F02), 전적·보상은 F25/F26이다. notification 토글 같은 UI 상태를 실제 push 연동으로 간주하지 않았다. root 화면 Error Boundary와 세션 provider 경계를 확인했다. 장식/문구를 개선 목록으로 만들지 않았으며 실제 모바일 복귀·OS notification 연동은 미검증이다.

## D. 중복을 제거한 발견사항 상세

심각도는 영향과 도달 조건, 검증 수준은 증거의 종류다. 아래 라인 범위는 조사 HEAD 기준이다. 모든 제안은 후속 구현 후보이며 이번 조사에서는 적용하지 않았다.

### R01 — 늦은 이전 refresh가 새 세션을 변경한다

- **흐름·분류·우선순위:** F01/F02/F05/F11/F29, 운영 결함, P1. 공용 기기 사용자 교체 후 인증 주체가 되돌아갈 수 있어 우선 처리한다.
- **근거:** [client.ts](../../../frontend/src/services/api/client.ts) 11–14, 51–95, 110–134; [session.ts](../../../frontend/src/features/auth/session.ts) 24–67; [useLogout.ts](../../../frontend/src/features/auth/useLogout.ts) 31–54; [AuthService](../../../backend/src/auth/auth.service.ts) 201–319.
- **도달 조건·연결:** A의 보호 API 401 → interceptor가 A refresh 전송 → 서버 rotation 완료/응답 지연 → A logout 및 B login/token/cache 설치 → A 응답 도착 → 무조건 `saveTokens(A)` → 원 요청 재전송. A refresh 실패도 무조건 `clearTokens()`로 B를 종료한다.
- **정상/실제:** 종료된 세션의 결과는 새 세션에 영향을 주지 않아야 한다. 현재는 refreshPromise와 토큰 저장·expiry 통지가 전역이며 세션 세대/요청 발행 사용자 확인이 없다.
- **기존 보호·한계:** backend refresh 단일 사용, account 소유권, 사용자별 선택/cache clear는 있다. 하지만 server rotation 뒤 old token logout은 새 refresh를 폐기하지 못할 수 있다. account ownership은 잘못된 B account로 A가 거래하는 것은 막아도 `/me`·A의 계정 목록 같은 사용자 API의 인증 주체 복귀를 막지 않는다.
- **재현:** `reproduce.cjs` session success/failure. A 응답을 보류하고 저장소를 B로 바꾼 뒤 완료시키면 A token으로 교체·retry; 실패시키면 B token 삭제·expiry 1회. 실제 Axios interceptor 코드, HTTP/storage 대역. 물리 기기 인증 유출 재현은 아니다.
- **최소 개선·범위:** frontend session 경계에 세대 번호를 두고 login/logout/expiry에서 동기적으로 변경. refresh/read/write/retry/expiry에 발행 세대를 대조하고 오래된 결과를 폐기한다. 취소만으로 완료된 HTTP 결과를 막을 수 없으므로 저장 직전·재전송 직전 검증이 필요하다. 기존 API/DB 변경은 필수 아님.
- **불변조건·회귀 위험:** 같은 세션 동시 401은 계속 한 번만 갱신; 새 로그인 token/cache는 old expiry가 삭제하지 않음; 유효하지 않은 거래를 자동 새 key로 실행하지 않음. 세대 갱신 순서·저장 비동기 경계가 새 경쟁을 만들 수 있다.
- **완료 기준:** A refresh 성공/실패, old 401의 늦은 도착, logout만 수행, A→B→A, 동시 401, 저장 지연을 통제한 실제 interceptor+session 통합 테스트. 이전 refresh로 B의 저장소/cache/navigation이 변경되지 않아야 한다.

### R02 — 저장소 실패가 세션 종료의 후반부를 막는다

- **흐름·분류·우선순위:** F01/F02/F29, 운영 결함, P2. AsyncStorage I/O 실패 때 logout/expiry 복구가 중단되는 구체적 조건이며 일반 네트워크 실패와 구분한다.
- **근거:** [client.ts](../../../frontend/src/services/api/client.ts) 11–14, 86–89; [useLogout.ts](../../../frontend/src/features/auth/useLogout.ts) 35–53; [session.ts](../../../frontend/src/features/auth/session.ts) 54–67; [sessionTeardown.ts](../../../frontend/src/features/auth/sessionTeardown.ts) 38–49.
- **연결·실제:** 401 refresh 실패 → `endExpiredSession` → `clearTokens` reject → `notifySessionExpired` 미호출. 명시적 logout은 `getRefreshToken`이 try 밖이고, `endSession` reject 뒤 navigation.reset까지 도달하지 않는다. 서버 revoke 실패는 catch하지만 로컬 저장소 오류는 같은 보호를 받지 못한다.
- **정상·영향:** 종료 의도 후 cache를 지우고 로그인 화면으로 돌아가야 한다. 현재 일부 실패에서는 기존 화면/인증 재료가 남아 종료 성공을 보장하지 못한다. 별도 teardown helper의 finally는 올바르지만 해당 callback까지 도달하지 못하거나 hook이 그 helper를 사용하지 않는 문제가 있다.
- **검증:** 실제 client의 clearTokens를 reject시키면 expiry 통지 0회·기존 token 잔존을 재현. hook의 get/remove 실패와 navigation 중단은 정적 확인. OS 저장소 고장은 실행하지 않았다.
- **최소 개선·범위:** 세션 무효화를 메모리에서 먼저 확정하고, cache clear/화면 reset을 storage 성공 여부와 분리된 finally 경계로 통일한다. storage 제거 재시도/진단은 별도 처리하되 로그인 차단이 가능한 상태를 유지한다. frontend auth/storage/bridge만; API/DB 불필요.
- **유지·위험·완료:** 이전 데이터는 navigation보다 먼저 지워야 하고 저장 실패를 성공적인 영구 삭제로 오인하면 안 된다. token get/remove/selection remove 각각의 실패를 실제 useLogout/expiry bridge 경로에서 주입해 화면 reset, stale API 차단, 새 세션 보호를 검증한다. R01과 함께 바꿔도 테스트 원인은 분리한다.

### R03 — 시즌 참가 쓰기가 종료 경계를 다시 확인하지 않는다

- **흐름·분류·우선순위:** F03/F24/F27/F28, 운영 결함, P1. 종료 직전 참가가 종료 후 초기 자금과 active account를 만들 수 있다.
- **근거:** [SeasonsService.joinSeason](../../../backend/src/seasons/seasons.service.ts) 214–415, 특히 230–251/272–325; [season-lifecycle.policy.ts](../../../backend/src/seasons/season-lifecycle.policy.ts) 46–106; [settlement](../../../backend/src/batch/season-settlement-job.service.ts) 838–865, 1203–1259; [season-write-lock.ts](../../../backend/src/ranking/season-write-lock.ts) 43–80.
- **연결·조건:** join HTTP 인증 → transaction 초반 plain season read/시간 검사 → user·기존 participant 조회 지연 → 계정/참가자/지갑/원장/equity 생성. season 잠금이나 잠금 뒤 DB 시각 재검증이 없다.
- **정상/실제:** 종료 후 참가·초기 지급을 막아야 한다. 재현은 endAt−1ms에 검사한 뒤 중간 조회에서 +1ms로 시각을 전진시켰다. 응답 success와 endAt+1ms joinedAt, account/participant/wallet×2/ledger/equity 생성이 확인됐다.
- **보호·한계:** 한 transaction과 참가 unique는 중복 지급·반쪽 쓰기를 막지만 stale join 판정을 갱신하지 않는다. 정산의 Season FOR UPDATE 및 final coverage 검사는 그 시점에 보이는 참가자를 다룬다. 늦은 join이 정산 잠금 뒤 재개되는 경우의 실제 PG 순서는 이번에 미실행이다. 늦은 참가자가 final/closed set 밖에 남는 시나리오는 정적 조건부 위험으로 남긴다.
- **최소 개선·범위:** 참가도 lifecycle/settlement와 호환되는 season 잠금 경계에 참여하고, 필요한 대기 뒤 실제 DB 시각으로 참가 가능성을 검사한다. 사용자 상태의 최종 승인 시점도 함께 명시한다. SeasonsService/공통 잠금/PG 테스트; 공개 API·schema 변경 필수 아님.
- **불변조건·회귀:** 중복 참가409, 초기 grant 정확히 한 번, 일반모드 독립성, Season→Account→Participant의 기존 금융 잠금 순서를 유지. 잠금 추가가 역순 교착을 만들면 안 된다.
- **완료 기준:** 독립 PG 두 연결과 barrier로 join↔end, join↔settle, join↔동일 사용자 join, 시간 경계 대기를 시험. 종료 판정 후 새 participant/잔여 active season account가 없어야 하며 실패 join은 모든 초기 금융 행이 rollback되어야 한다.

### R04 — 지정가 탐색이 앞쪽 미충족 주문에 고정된다

- **흐름·분류·우선순위:** F16/F17/F18, 운영 결함, P1. 신선한 체결 가격이 있어도 주문이 무기한 검사되지 않을 수 있다.
- **근거:** [candidate repository](../../../backend/src/orders/limit-order-candidate.repository.ts) 90–205; [matching service](../../../backend/src/orders/limit-order-matching.service.ts) 104–183, 201–240; [config](../../../backend/src/orders/limit-order-matching.config.ts) 14–35.
- **연결:** 5초 scheduler → assetId 정렬/distinct 목록 → 자산마다 `submittedAt,id ASC take=budget` → 가격 계획 없으면 continue → 다음 주기에 동일 query. cursor/다음 페이지/순환 시작점이 없다.
- **정상/실제·재현:** batch=2, 오래된 두 buy limit=50, 뒤 buy limit=100, snapshot=100(매도는 앞150/뒤100). 세 주기 모두 order1/2만 조회하고 fill0. 일반·시즌, buy/sell 네 조합 동일; 뒤 주문 자체의 plan은 유효함. 원본 repository와 matcher, DB query 결과·가격/evidence 대역으로 재현했다.
- **원인·보호:** query 한도와 실행 예산을 같은 값으로 쓰면서 가격 미충족 후보를 넘긴 탐색 진척을 저장하지 않는다. `ordersConsidered`는 계획 있는 후보만 세어 0, `batchExhausted=false`가 반복된다. per-order lock·예외 catch·예약 정확성은 후보 발견을 보장하지 않는다.
- **확대 조건:** 기본 batch200이면 앞200 미충족 뒤201번째부터 같은 문제. 앞 asset의 계획/실패가 예산을 모두 쓰면 뒤 asset도 정체. B 기본15분 window가 지나면 과거 접촉 근거가 탐색 전에 소실될 수 있다. 종목 고정 universe가 작아도 한 종목 주문 수는 제한되지 않는다.
- **최소 개선·범위:** 검색 예산과 체결 예산을 분리하고 `(submittedAt,id)` keyset으로 유한한 탐색을 이어간다. 자산 간 순환·반복 실패 후보 처리와 scanned/planned/filled/oldest-unscanned 지표를 정의한다. 같은 우선순위의 금융 체결 규칙을 유지한다. matcher/repository/config/테스트 대상; API 변경 불필요. durable cursor가 꼭 필요한지는 재시작 요구에 따라 결정하며 먼저 기존 구조에서 해결한다.
- **회귀·완료:** stale candidate는 실행부에서 계속 재검증; 예약·전량 체결·A/B 우선순위 불변. N+1 반례, 매수/매도·양 모드, 여러 asset, 앞 후보 반복 exception, 취소/신규 삽입, process 재시작, B 경계에서 모든 적격 주문이 정해진 주기 한도 내 검사되는지 확인한다. 별도 PG 체결 정확성 suite도 유지한다.

### R05 — ticker fallback 폴링의 예외와 중첩 실행을 제어하지 않는다

- **흐름·분류·우선순위:** F06/F07/F08/F09/F11/F28, 운영 결함, P1. 조회용 DB 장애가 전체 API 프로세스 중단으로 확대될 수 있다.
- **근거:** [AssetTickerGateway](../../../backend/src/realtime/asset-ticker.gateway.ts) 181–185, 630–662, 901–912; [AssetsService](../../../backend/src/assets/assets.service.ts) 503–550. `backend/src`에서 전역 unhandledRejection handler는 찾지 못했다.
- **조건·호출:** 현재가 구독 client 하나 이상 → 3초 interval → `void pushChangedTickers()` → 종목별 `buildSnapshotTickerMessage` → DB/가격 조회 reject. timer 경계의 catch와 진행 중 실행 guard가 없다.
- **정상/실제:** 해당 종목/주기의 unavailable·재시도를 다뤄야 하지만 rejection이 주인 없이 전파된다. Node24 기본 자식 프로세스에서 원본 timer 경로와 합성 DB 오류로 exit1을 확인했다. 실 DB/네트워크는 사용하지 않았고 운영 NODE_OPTIONS는 미확인이다. 다른 unhandled rejection 정책이라도 그 poll의 나머지 종목 전파는 중단된다.
- **기존 보호·한계:** websocket send backpressure·latest-only queue·이벤트 경로의 metadata cache는 유효하다. 이들은 fallback 비동기 조회의 예외를 잡거나 이전 3초 poll 완료를 기다리지 않는다. 느린 DB에서는 조회 주기가 겹쳐 진행 중 작업이 늘어난다.
- **최소 개선·범위:** timer 소유 경계에 오류 처리와 in-flight 제어, 종목별 실패 격리·진단·다음 주기 회복을 둔다. 기존 realtime event의 per-tick DB 미조회 원칙을 유지. gateway와 테스트만, DB/API 변경 필수 아님.
- **회귀·완료:** 실패를 0 가격이나 정상 메시지로 바꾸지 않는다. 한 종목 reject 후 다른 종목 전달, 다음 tick 회복, 3초 이상 지연에서 동시 poll 상한, disconnect/destroy 정리, socket 느린 수신을 시험한다. 자식 프로세스가 살아 있고 잘못된 금융 가격이 송신되지 않아야 한다.

### R06 — 이전 랭킹 계산이 최신 계산을 덮어쓴다

- **흐름·분류·우선순위:** F15/F17/F19/F23/F24/F28, 운영 결함, P1. 최신 순위·참가자 평가가 과거 값으로 되돌아간다.
- **근거:** [RankingRefreshService](../../../backend/src/ranking/ranking-refresh.service.ts) 78–118, 146–205, 223–255, 311–495; [season-write-lock](../../../backend/src/ranking/season-write-lock.ts) 43–80.
- **연결·조건:** 거래 후 `participant-change:season` refresh A(먼저 시작, 느림)와 `scheduled:season` refresh B(나중 시작, 빠름)가 같은 프로세스에서도 겹친다. 다른 프로세스면 같은 key의 Set도 공유되지 않는다. 평가·history 계산은 transaction 밖, 쓰기만 season lock 안이다.
- **정상/실제·재현:** B capturedAt00:02/value200 저장 후 A00:01/value100을 재개하면 daily set과 participant value가 A로 바뀐다. 실제 public refresh·writer를 실행했고 valuation/scope/transaction은 대역이다. PG row lock의 물리 동작을 시험한 결과는 아니다.
- **보호·한계:** season lock은 동시 교체의 원자성과 ended/settled 차단을 보장한다. 기존 ranking의 scope만 검증하며 capturedAt/세대가 더 최신인지 검사하지 않는다. 따라서 저장 순서가 계산 시작 순서와 반대여도 모두 유효로 처리한다.
- **최소 개선·범위:** lock 안에서 최신 갱신본의 기준 시각/버전을 비교하고 오래된 계산을 폐기한다. 모든 trigger의 per-season 실행 병합과 진행 중 변경의 후속 실행 예약도 검토하되 프로세스 Set만으로 다중 인스턴스 문제를 해결했다고 하지 않는다. ranking service/테스트 대상; 기존 capturedAt 사용은 schema 없이 가능하나 동일 시각 충돌 정책이 필요하다. 단조 revision을 택하면 migration은 별도 결정이다.
- **불변조건·회귀:** 정렬/동률/MDD, scope 검증, final 불변성 유지. 낡은 결과를 막다가 변경 trigger를 영구히 버리지 않아야 한다.
- **완료 기준:** barrier로 old/new의 계산·commit 순서를 뒤집고 양 trigger 및 두 인스턴스에서 최신 결과가 유지됨을 PG로 확인. 동일 timestamp, 빈 참가자 집합, exclusion/settlement 겹침, stale 작업의 scheduled snapshot 처리도 명시적으로 시험한다.

### R07 — 거래마다 시즌 전체 평가·전 이력을 다시 읽는다

- **흐름·분류·우선순위:** F15/F17/F19/F22/F23/F24, 중요한 구조 개선·확장성 위험, P2. 현재 부하의 장애를 측정한 것은 아니지만 증가 항과 금융 잠금 영향이 코드로 확인된다.
- **근거:** [RankingRefreshService](../../../backend/src/ranking/ranking-refresh.service.ts) 78–90(참가자 인자 미사용), 149–198(순차 평가·history), 279–309(무제한 history), 422–486(행별 update/create, `rows.find`); [season-trading-lock.ts](../../../backend/src/seasons/season-trading-lock.ts) 17–84.
- **연결·비용:** 체결 후 callback → 시즌 P명 모두 valuation → 각 참가자 Hᵢ개 equity 조회·MDD/reached 정렬 → P명 정렬 → season 쓰기 잠금 아래 participant P번 update + ranking P번 create. holdings 평가 비용을 Vᵢ라 하면 계산은 대략 Σ(Vᵢ+Hᵢ log Hᵢ)+P log P, `rows.find`는 전체 합 O(P²), 반환 이력 메모리는 O(ΣHᵢ). DB statement는 valuation 내부 쿼리 외에 적어도 participant별 history/update/create의 3P와 scope·season·delete 조회가 추가된다.
- **정상·영향:** 현재 정책인 전체 순위 일관성 자체는 필요하다. 문제는 거래 빈도와 참가자·이력이 곱해지고 잠금 안의 행별 쓰기가 길어지는 구조다. 시즌 거래의 Season SHARE가 ranking FOR UPDATE에 대기할 수 있다. 한 참가자의 평가 불가로 전체 갱신이 실패하는 것도 비용/가용성 지표로 드러나야 한다.
- **기존 보호:** account scope map은 이미 한 번 batch 생성하고, 같은 trigger의 진행 중 refresh는 skip한다. limit fill 결과도 target을 dedupe한다. 하지만 거래가 skip되면 후속 갱신 예약이 없고 scheduled와 trigger key가 달라 겹칠 수 있다. 기존 보호를 제거할 이유는 없다.
- **검증:** 호출·query·반복문 정적 확인. 실제 P/H/Holdings 부하 측정은 하지 않았으므로 TPS 한계를 제시하지 않는다.
- **최소 개선·시점:** R06 수정과 함께 per-season trailing refresh 병합을 먼저 정리하고 rank lookup을 Map으로 바꿔 O(P²)를 없앤다. 다음으로 기존 함수 경계에서 bounded batch read/write와 history 재사용 가능성을 측정한다. MDD summary 영속화는 데이터·정합성 복잡도가 추가되므로 첫 작업으로 제안하지 않는다. public API/DB 변경은 초기 개선에 불필요하다.
- **불변조건·완료:** 전체 rank·tie/MDD·hidden/excluded·scope·final lock 유지. 100/1,000/가상 10,000 참가자와 여러 history 크기의 격리 PG fixture로 query 수·peak memory·season lock 시간·동시 거래 p95를 기록하고 이전 숫자와 정확히 비교한다. 개선 후 trigger가 남김없이 최종 상태로 수렴해야 한다. 전체 service 재작성보다 이 비용 경계만 수정하는 편이 회귀 위험이 작다.

### R08 — 일반계정 전체 환전 무결성 검사가 제곱 비용이다

- **흐름·분류·우선순위:** F15/F16/F19/F20/F21/F22, 중요한 구조 개선·확장성 위험, P2. 오래 사용한 계정의 정상 요청 비용이 누적 환전 수에 따라 급증한다.
- **근거:** [general-account-integrity.ts](../../../backend/src/trading-accounts/general-account-integrity.ts) 332–482, 특히 385–451; [GeneralAccountPerformanceService](../../../backend/src/portfolio/general-account-performance.service.ts) 278–290, 543–565; [OrdersService](../../../backend/src/orders/orders.service.ts) 2115–2125, 2434–2450; [FxService](../../../backend/src/fx/fx.service.ts) 1075–1087, 2500–2520; [account portfolio](../../../backend/src/portfolio/trading-account-portfolio.service.ts) 133–156.
- **호출·실제:** 일반계정 quote/execute 또는 portfolio/성과 준비 → `assertGeneralAccountReady` → 금융 foundation/trading 검증 → FX exchanges 전체 + 해당 ledgers 전체 → 매 exchange마다 `ledgers.filter(referenceId)` 재순회. 거래의 account 잠금 안에서도 이 검증이 사용된다. 시즌에는 이 일반계정 전용 경로를 적용하지 않는다.
- **재현:** E개의 정상 exchange와 2E개의 정상 원장으로 실제 검증 함수 실행. referenceId 접근은 E=100에서20,400, E=200에서80,800, E=1,000에서2,004,000회. 정확히 2E²+4E. 이는 CPU 비교 횟수이며 DB 지연/밀리초 측정이 아니다. 원장 자료 및 query는 대역이다.
- **원인·보호:** exchangeById Map이 있어도 연결 원장 분류에 쓰지 않아 반복 filter가 남는다. 검증은 foreign account/잘못된 request/쌍 누락을 막는 중요한 보호이고 삭제하면 안 된다. 홈 네 API 전부가 이 함수를 호출하는 것은 아니다.
- **최소 개선·효과·시점:** referenceId별 원장 Map을 한 번 만들고 같은 검증을 O(E+L)로 수행하는 변경은 지금 가치가 높다. 한 요청 안의 불변 상태 재사용은 읽기/잠금 경계가 같은 경우에만 검토한다. 장기적으로 전체 이력을 매번 읽는 O(E) 비용은 별도 측정 후 개선한다. 함수/관련 금융 테스트 범위, API/schema 불필요.
- **회귀·완료:** 정확히 한 succeeded request·정확히 source/target 두 원장·통화/방향/모든 소유권을 계속 검사해야 한다. 중복·고아·foreign wallet·불완전 쌍을 기존과 동일하게 reject하고 정상 이력의 비교 횟수가 선형인지 시험. 양 모드 거래·FX PG suite에서 잠금 순서/TWR/멱등성이 그대로여야 한다.

### R09 — 일부 장기 작업은 잠금 만료 뒤에도 실행을 계속한다

- **흐름·분류·우선순위:** F17/F22/F23/F28, 조건부 운영·확장성 위험, P2. 작업 시간이 TTL을 넘고 두 인스턴스 또는 별도 수동 실행이 겹칠 때 발생한다.
- **근거:** [ops-config.ts](../../../backend/src/ops/ops-config.ts) 60–62, 172–180; [OpsJobRunner](../../../backend/src/ops/ops-job-runner.service.ts) 183–200, 1144–1273; [OpsJobLockService](../../../backend/src/ops/ops-job-lock.service.ts) 27–104, 139–180; [OpsScheduler](../../../backend/src/ops/ops-scheduler.service.ts) 138–166.
- **연결·조건:** 기본 TTL600초 acquire → matcher handler(renewLock 없음) → 실행 중 TTL 경과 → 다른 process가 takeover → 첫 process도 계속 candidate 조회/체결 시도. `lockOwned`는 갱신 실패 callback에서만 false가 되므로 갱신 미사용 작업은 만료를 인지하지 못하고 성공 기록까지 갈 수 있다.
- **정상·영향:** 작업 전체에 대한 단일 실행 설명이 실제 lease 수명과 맞아야 한다. 중복 계산·provider 조회·DB 경쟁·서로 다른 job 성공 기록이 가능하다. R06과 함께 ranking writer 경쟁이 커진다. **이 사실만으로 이중 체결/이중 차감을 주장하지 않는다.** 주문 row lock·unique·최종 상태 재검증은 별도로 작동한다.
- **보호·반례:** 같은 process limit tick에는 running guard가 있다. release는 ownerId를 확인해 후임의 잠금을 지우지 않는다. candle retention/sync/reconciliation은 `renewLock:true`가 이미 존재하며 전체 작업이 모두 무갱신인 것은 아니다. renewal 사용 handler의 중단 반응도 작업별로 다르다.
- **검증:** TTL·takeover SQL 조건·caller option·진행 플래그 연결 정적 확인. 현재 운영 duration과 두 인스턴스 takeover는 미실행이므로 조건부 판정이다.
- **최소 개선·범위:** 긴 작업에 기존 renewal을 적용하고, batch 사이 ownership 상실을 확인해 새 작업 시작을 중단한다. 짧은 operation은 duration 경보로 충분한지 판단한다. 단순 TTL 증가만으로 보장하지 않는다. ops runner/해당 handler/tests 대상; schema/API 불필요.
- **회귀·완료:** transaction 중 금융 반영을 임의 중간 취소하지 않고 완료된 사건은 보존한다. 짧은 TTL의 격리 PG 두 worker로 takeover·갱신 오류·느린 DB·process kill을 시험. 이전 owner는 새 batch를 진행하지 않고 후임 lock을 release하지 않으며, 결과에 ownership 상실이 드러나야 한다.

### R10 — 캔들 릴리스 검증이 generated 파일 차이로 실행되지 않는다

- **흐름·분류·우선순위:** F08/F09/F12/F28, 릴리스 검증의 운영 결함, P1. 캔들 기능 고장을 입증한 것이 아니라 필수 검증 결과를 얻지 못하는 상태다.
- **근거:** [CI](../../../.github/workflows/ci.yml) 345–459, 특히 388–406; [smoke-git-identity.ts](../../../backend/scripts/lib/smoke-git-identity.ts) 94–108; `backend/src/generated/prisma/internal/class.ts:23`의 inlineSchema; `backend/prisma/schema.prisma` Quote fee 주석; `backend/.gitignore` generated 경로. [현재 run](https://github.com/windowsjd/trading_app/actions/runs/35624316629), [baseline run](https://github.com/windowsjd/trading_app/actions/runs/35613759643).
- **실제 연결:** clean checkout → install → `prisma generate` → migration → smoke clean-tree preflight → exit2. 현 SHA의 다른 5개 job은 PASS, candle job의 smoke step은 dirty tree로 FAIL했다. 이전 SHA도 같은 preflight 실패이며 현재 slider 변경의 신규 캔들 회귀로 분류하지 않는다.
- **격리 재현:** 원본을 건드리지 않는 `/tmp` local clone에서 generate 전 clean, 후 tracked `src/generated/prisma/internal/class.ts` 변경. embedded schema의 **fee 주석**만 이전 “limit/general market만 pin”에서 현재 “양 모드 market/limit/FX pin”으로 바뀌었다. runtime 컬럼 변화나 migration 실패가 원인이라는 증거는 없다. 기존 ignore는 `/generated/prisma`이고 실제 추적 경로는 `/src/generated/prisma`다.
- **영향·보호:** smoke가 dirty artifact를 릴리스 증거로 사용하지 않도록 막는 것은 올바르다. 그 guard 때문에 pipeline 본문·새 fixture artifact·traceability 검증에 도달하지 못한다. GitHub main 조회는 `protected:false`, required status checks enforcement off/contexts [], repository rulesets []였다. 현재 보이는 설정에는 실패를 막는 branch gate가 없다; 외부 조직 절차 존재 여부는 별도다.
- **최소 개선·범위:** generated 파일을 추적하는 정책이면 schema와 같은 커밋에서 재생성하여 clean generation을 보장한다. 추적하지 않는 정책으로 바꾸려면 generator/빌드·배포 소비자를 먼저 대조한다. `SMOKE_ALLOW_DIRTY=1`로 릴리스 guard를 우회하지 않는다. CI/generated 산출물 관리의 독립 작업; 금융 API/DB 정책 변경 불필요. branch protection 변경은 별도 저장소 관리 결정이다.
- **완료 기준:** 새 clean checkout에서 install+generate 뒤 `git diff --exit-code` PASS, 실제 PG+Redis fixture 실행 및 **이번 run의 SHA/clean 상태/새 artifact** 검증 PASS. 과거 artifact나 다른 SHA의 성공을 재사용하지 않는다. 5개 기존 job도 유지하고 알려진 실패가 제거된 상태에서 required checks 적용 여부를 결정한다.

### R11 — 현재 정책 안내 문서가 중요한 실행 계약과 충돌한다

- **흐름·분류·우선순위:** F03/F04/F15/F16/F17/F19/F24/F28, 중요한 품질 문제, P2. 후속 구현·운영 판단에 쓰라고 명시된 자료의 충돌이다.
- **근거:** [backend AGENTS](../../../backend/AGENTS.md) 10–24는 rulepack을 최상위로 지정. [codex-rulepack](../../../backend/docs/codex-rulepack.md) 5–8/27–29는 시즌 중심·시장가만을 고정 규칙으로 제시. [docs index](../../../backend/docs/README.md) 23–30은 NOT NULL을 남은 제외 범위로 안내. [policy-decisions](../../../backend/docs/policy-decisions.md) 23–24/123–142는 현재 지정가 지원을 안내하면서 fee null·이전 잠금 순서 설명을 포함한다.
- **현재 대조:** 실제 양 모드 시장가/지정가 매수·매도·FX 경로와 fee pinning 테스트, `season-trading-lock.ts:17–84`의 Season→Account→Participant 순서, [canonical scope migration](../../../backend/prisma/migrations/20260910120000_make_trading_account_canonical_scope/migration.sql) 358–380 및 [legacy 제거](../../../backend/prisma/migrations/20260911120000_remove_legacy_financial_participant_scope/migration.sql)를 확인했다. 일반 FX 정책의 pinning 설명과 같은 파일의 “시장가·FX 모두 null”도 서로 맞지 않는다.
- **정상/실제·영향:** 작업자는 적용 중 계약을 찾을 수 있어야 한다. 현 안내대로 해석하면 정상 지정가를 범위 밖으로 제거하거나, 기존 잠금과 역순으로 신규 코드를 작성하거나, 완료된 NOT NULL 작업을 재계획할 수 있다. 코드가 다르다고 임의로 제품 정책을 바꾸자는 결론은 아니다. 현재 테스트/계약/구현의 합의 상태를 문서 소유자가 정리해야 한다.
- **제외·보호:** policy 상단이 명시적으로 historical이라고 한 nullable/dual-write 작업7·8 설명, HANDOVER의 과거 실행 결과, 과거 Android export 기록은 이 결함의 근거로 쓰지 않았다. source universe를 가리키는 KIS 목록 안내는 올바르다. 최신 account finance contract도 canonical ownership을 명확히 한다.
- **최소 개선·시점:** AGENTS와 짧은 docs index에서 현행 계약 우선순위·기능/flag/필수조건을 가리키고, 충돌한 구절만 현행화 또는 historical로 표시한다. 모든 문서 통합/전면 재작성 불필요. 지금 후속 금융 작업 전 정리할 가치가 높다. docs만, API/DB 불필요.
- **회귀·완료:** 수수료·잠금·가격 정책을 문서 정리 명목으로 변경하지 않는다. 신규 작업자가 지정가 양 방향·양 모드·fee pinning·canonical scope·matching flag·provider 범위를 단일 index에서 모순 없이 추적하고, 구현/계약/migration/tests의 근거 링크를 찾을 수 있으면 완료다.

### R12 — 현재 랭킹 조회가 서로 다른 갱신본을 한 응답에 섞는다

- **흐름·분류·우선순위:** F20/F23/F25, 운영 결함, P2. 갱신과 조회가 겹칠 때 빈 목록·서로 다른 시각의 내 순위·잘못된 분모/near-me 위치가 나타날 수 있다. R06은 writer 순서, 이 항목은 reader의 읽기 경계라는 다른 원인이다.
- **근거:** [RankingService.getRanking](../../../backend/src/ranking/ranking.service.ts) 194–386, 특히 244–323; [RankingRefreshService](../../../backend/src/ranking/ranking-refresh.service.ts) 440–488.
- **연결·조건:** GET ranking → latest metadata(capturedAt=A) → set scope 검증 → count(where A)와 myRanking unique(date/account, **capturedAt 없음**) → page(where A). 이 여러 read는 공통 transaction/read snapshot에 묶이지 않는다. 그 사이 writer가 A를 삭제하고 B를 넣을 수 있다.
- **정상/실제:** 한 응답의 count·page·내 순위·metadata가 같은 갱신본이어야 한다. A metadata 뒤 B commit이면 count/page는 0 또는 서로 다르고 myRanking은 B일 수 있다. `state=available` 조립까지 가능하다. static scope 검증은 소유권을 검증하므로 계산 버전 혼합을 막지 않는다.
- **기존 보호·한계:** frontend의 capturedAt 기반 다음 페이지/스냅샷 변경 재시도는 **서로 다른 요청 사이** 변화에 유효하다. 최초 단일 응답을 조립하는 도중의 교체를 원자화하지는 않는다. final set은 정상 운영에서 immutable이므로 영향은 주로 current daily다.
- **검증:** 실제 reader 쿼리와 delete/recreate writer 연결을 정적으로 확인; 새로운 PG interleaving 재현은 미실행. 실제 발생 빈도는 측정하지 않았다.
- **최소 개선·범위:** metadata/scope/count/my/page를 짧은 일관된 read transaction으로 묶거나 버전 대조 후 제한된 재시도를 한다. myRanking도 같은 capturedAt로 검증한다. reader/tests 범위, API/schema 변경 필수 아님. 긴 transaction으로 금융 writer를 지연시키지 않도록 read 범위를 제한한다.
- **완료 기준:** metadata 이후, count 이후, page 이전 각각에 refresh commit을 삽입한 PG barrier 테스트. 응답은 A 또는 B 한 세대 전체이거나 명시적 snapshot-changed여야 하며 mixed available을 반환하면 실패. all/top10/near_me·hidden/excluded·최종 ranking도 회귀 검증한다.

## E. 확장성 분석

운영 사용자 수, DB CPU/RAM/연결 한도, Render instance 수·요금제, 실제 요청량은 확인하지 않았다. 아래 식은 **코드 비용 구조**이고 장애가 시작되는 사용자 수를 예측한 측정값이 아니다. P=시즌 참가자, A=활성 계정, H=계정당 성과 행, E=계정당 환전 수, K=보유 종목, O=미체결 주문, U=동시 socket, S=연결당 구독, M=서버 인스턴스로 둔다.

| 증가 요인·실제 경로 | 단일 인스턴스 보호와 남는 비용 | 규모/다중 인스턴스 변화 | 먼저 볼 지표·개선 착수 조건 |
|---|---|---|---|
| 전체 가입자 vs 활성 계정 | 모든 가입자가 요청 비용을 만드는 것은 아님. daily job은 대상 account/participant 전체 배열·IN 집합을 읽음 | 대상 A와 미처리 계정의 valuation/history에 비례; M개가 TTL 뒤 겹치면 R09 | 대상/skip/성공/실패 수, heap peak, 종료 시각·미처리 최고 age. 일별 완료 창에 가까워지면 keyset batch 도입 검토 |
| 거래 빈도×시즌 P/H/K | transaction 밖 ranking callback, process 내 중복 skip 존재 | R07의 전체 계산이 호출 수에 곱해지고 season 쓰기 lock 중 trades 대기. M개의 Set은 독립 | 거래 한 건당 ranking 시작/skip/trailing 횟수, valuation/query 수, lock wait, 갱신 lag. 부하 전에 R06, Map 비용 제거 우선 |
| 계정당 누적 FX E | 무결성 검사로 잘못된 scope/원장 쌍 차단 | R08 2E² 비교, 전체 exchange/ledger 반환. Account lock 안 비용은 같은 계정 명령을 지연 | E별 비교·read rows·tx 시간·timeout. 제곱 항은 지금 제거, 전체 검증 축소는 증거를 보존한 별도 설계 |
| 한 종목 O·자산별 분포 | batch 기본200/max1000, 자산 스캔 최대1000, per-order transaction | O가 batch를 넘으면 부하와 무관하게 R04. 앞 asset plan/failure가 체결 예산 독점 가능 | scanned/planned/filled/skip/error 분리, 미탐색 oldest age, 자산별 마지막 cursor. N+1 반례 자체가 수정 착수 기준 |
| U×S·시세 빈도 | frontend 공유 연결, server 종목 Set으로 fallback 조회 dedupe, 최신 메시지 queue64·candle/orderbook 상한20 | 이벤트 fanout은 현재 구현상 연결들을 순회하며 대상별 전송. fallback은 인스턴스별 distinct subscribed assets 조회; M배까지 증가. 느린 poll 중첩 R05 | active clients/subscriptions, 메시지 send/coalesce/drop, buffered bytes, poll duration/inflight, event loop delay, reconnect/s. poll 주기 초과가 지속되면 상한/조회 공유 조정 |
| 실제 provider 대상 수·서버 M | Binance25/KIS40 코드 기준, throttle·metadata cache, live lease·pubsub | live lease 모드는 한 provider owner; standalone은 각 process가 시작할 수 있음. snapshot read-then-create throttle은 분산 event unique가 아님 | provider 연결·call/min·429/재접속, source별 수신/저장 수 차이. 실제 다중 배포 중 중복이 확인되면 기존 live owner 범위 활용 검토 |
| FX/차트 동시 최초 요청 | FX process/key single-flight, candle sync state/locks/cache 존재 | 서로 다른 freshness key와 M개 process는 병합되지 않음. cache cold 시 source 조회·대기 증가 | key별 in-flight 수·hit/miss·provider latency·waiters. 같은 자료에 대한 실제 중복이 한도에 접근할 때만 병합 범위 조정 |
| 원장/주문/전적 장기 행 수 | account/time index와 조회 상한·metadata batch | 깊은 offset/count와 전 history 조회는 반환 크기보다 많은 스캔 가능. 가입자 수만으로 추정 불가 | `EXPLAIN (ANALYZE, BUFFERS)`를 합성 DB에서 account 분포·offset별 측정. 운영 DB에는 이번에 실행하지 않음 |
| 가격/FX/성과/작업 로그 누적 | candle5m retention 및 copied fill evidence 존재 | price observations, EquitySnapshot, OpsJobRun 등은 시간과 실행 빈도로 누적. 무작위 금융 purge는 감사 근거를 훼손 | table/index bytes·행/일·vacuum/backup/restore 시간. 보존 기준과 조회 창이 정해지면 archive/partition 필요성을 검토 |
| 긴 batch와 연결 pool | 한 사건 transaction·SQL lock·idempotency | 여러 job+API가 pool 경쟁. `PrismaService`는 connectionString으로 adapter를 만들며 앱에서 별도 pool sizing을 지정하지 않음 | active/waiting connections, tx duration·lock wait·deadlock·job overlap. 실제 DB 한도와 adapter 설정을 먼저 확인; 임의 pool 증설 금지 |

**행동 한 번의 비용을 구분했다.** 일반 홈은 portfolio/wallets/positions/equity의 4개 주요 요청이며 시즌은 ranking 등 추가 조회가 있다. 화면 가격·계정 valuation·원장 조회의 목적이 달라 4개라는 숫자만으로 한 API 합병을 요구하지 않는다. 일반 portfolio의 완전성/TWR 검증, positions의 holdings별 가격 선택, equity 범위 조회가 각각 비용을 만든다. 시장가/FX의 quote→execute는 2개의 금융 명령 요청이고, execute 안의 여러 write는 하나의 사건 transaction이다. React Query가 같은 key의 요청을 합쳐도 서로 다른 API 내부의 valuation을 자동 병합하지는 않는다.

**인덱스·SQL 반대 증거.** Prisma 밖의 `trading_accounts_general_owner_unique`, 초기 지급 partial unique, reserved cash CHECK, reserved quantity CHECK, active candle sync partial unique, external funding boundary unique를 확인했다. 2026-09-10 canonical NOT NULL과 09-11 legacy participant 제거도 반영했다. `orders_live_limit_buy_fifo_idx`는 07-25 제거 migration에서 `(asset_id,submitted_at,id)`의 buy-only partial index로 다시 생성되어 있다. 따라서 “후보 FIFO index 없음”은 잘못된 결론이다. 현재 repository는 buy/sell OR 조건이므로 그 buy-only index 하나가 전체 후보 query를 완전히 지원한다고도 말할 수 없다. 실제 plan을 양 방향 분포로 비교한 뒤 index 변경 여부를 결정해야 한다. 오래된 `orders_open_limit_buy_idx`는 participant column 제거 이후의 현행 인덱스로 가정하지 않았다.

실측은 R08의 비교 횟수와 재현 제어 흐름뿐이다. 가상 P=100/1,000/10,000, E=100/1,000/10,000, U/S 증가 시나리오는 **다음 격리 부하 시험의 입력 제안**이며 현재 환경에서 그런 처리량을 달성했다는 뜻이 아니다. 금융 원본 전체를 메모리 캐시로 우회하거나 Redis를 체결 source of truth로 승격할 이유는 없다.

## F. 중요한 코드 품질 개선 우선순위

| 시점 분류 | 개선 단위·효과 | 범위·추가 복잡성·유지할 구조 |
|---|---|---|
| **1. 지금 수정할 가치가 높음** | R01/R02 세션 경계의 발행/저장/종료 순서를 한 책임으로 연결 | 기존 auth/session/client/storage 사용. 새 상태 관리 framework 없이 세대와 teardown만 추가. 테스트는 helper 단독이 아닌 실제 interceptor/hook 경계 |
| **1. 지금** | R03 참가 승인과 lifecycle 잠금을 같은 금융 시간 경계로 정렬 | Season service·공통 SQL helper·PG 경쟁 테스트. lock order 회귀를 검토하며 일반 금융 코어는 유지 |
| **1. 지금** | R04 후보 탐색 전진과 지표 | repository/matcher의 검색 vs 실행 예산. 별도 matching server/queue 불필요 |
| **1. 지금** | R05 poll 오류·중첩 처리 | timer 경계와 per-asset 실패 격리. 기존 event bus/pubsub/metadata cache 유지 |
| **1. 지금** | R06/R12 랭킹 저장 순서와 읽기 일관성 | 두 원인은 테스트/작업을 분리. 기존 Season lock·ranking contract를 재사용 |
| **1. 지금** | R08 원장 인덱싱, R07의 rank Map | 검증 동일성 유지하며 제곱 연산만 제거. 파일/계층 증가가 거의 필요 없음 |
| **1. 지금** | R10 릴리스 fixture 복원, R11 canonical index 정리 | CI 산출물 정책·짧은 문서 연결. 릴리스 guard 삭제나 전면 lint 정리는 제외 |
| **2. 다음 관련 기능 수정 시** | R07 전체 history/valuation batch 및 trailing refresh 구조 | R06 작업과 인접하면 함께 수행하되 지속 summary 도입은 별도 측정 후. 새로운 summary가 rollback/정산/보정에 추가하는 책임을 먼저 평가 |
| **2. 다음 관련 수정/다중 배포 전** | R09 job renewal과 ownership 중단 경계 | 기존 OpsJobLock 확장. 모든 작은 job에 복잡한 lease 상태 기계를 일괄 적용할 필요 없음 |
| **2. 다음 관련 수정 시** | OrdersService/FxService의 필수 dependency 표현과 fixture 구성 | 현재 wiring은 정상. `@Optional()`인 access/performance helper가 실제 public 경로에서 필수이면 production constructor는 mandatory로 두고 test builder를 정리하는 방향. 실패 시점이 request INTERNAL_ERROR에서 bootstrap으로 이동하는 효과 |
| **2. 다음 운영 설정 변경 시** | legacy scheduler parser/alias/effective state 진단 | 기존 parser·readiness에 실제 effective flags/이유를 모아 노출. 잘못된 문자열을 fallback false로 읽는 legacy config와 strict limit/ad/live config의 차이를 명확히 함 |
| **3. 현재 구조 유지** | 일반/시즌 공통 주문·FX·valuation 금융 코어 | 두 모드를 다시 분리하면 예약·fee·time·replay 정책이 갈라짐. 분기별 account context만 명확히 유지 |
| **3. 유지** | Decimal·source eligibility·calendar·general performance 정책 함수 | 표시·quote·execute·정산의 의도된 차이를 지우는 단일 가격 함수로 합치지 않음 |
| **3. 유지** | React Query key factory·무한/일반 shape 분리·공유 socket·bounded queues | 이미 구현된 보호. 새 state store/메시지 큐를 도입할 근거 없음 |
| **3. 유지** | lookup 무결성 fail-closed, batch snapshot 기존 행 skip | 검증 삭제·자동 repair·과거 행 채우기는 성능 개선이 아니라 금융 의미 변경 |

**대형 서비스 판단.** OrdersService는 quote/create/execute/read/replay를 연결하고 FxService도 provider refresh부터 금융 실행을 연결한다. 그러나 limit create/execution/cancellation/candidate, source policy, account access, performance, season lock이 이미 분리되어 있다. 파일 길이를 이유로 전면 분할하지 않는다. R08은 공유 검증 함수 한 곳을 개선하면 여러 흐름이 개선되는 명확한 경계다. R07은 ranking 계산·publication 비용 경계가 명확하다. RecordsService의 여러 조회 형식은 현재 주요 오류나 중복 금융 writer를 입증하지 못했으므로 즉시 분리 목록에서 제외한다.

**필수/선택 DI(의존성 주입, dependency injection).** Orders/Fx의 account access/performance는 실제 module imports/providers에 연결되어 있다. 테스트 편의/과거 migration 흔적의 Optional 때문에 향후 빠진 wiring이 늦게 오류가 날 가능성은 있지만 현재 결함으로 별도 집계하지 않았다. TypeScript `?`만 있고 Nest `@Optional()`이 없는 parameter는 자동 선택 의존성이라고 해석하지 않았다. gateway의 live/호가 부가기능과 feature가 꺼진 상태의 선택 서비스는 실제 이유가 있으므로 일괄 Optional 제거도 제외한다.

**테스트·lint 범위.** frontend gated product 범위는 auth/tradingAccount/record/wallet/주요 화면과 CTA이고, backend accounts gate는 계정 기능과 account controller 중심이다. OrdersService/FxService/ranking/gateway 전체가 이 scoped lint의 대상이라는 보장은 없다. 그렇다고 전체 lint debt 정리를 요구하지 않는다. R01/R04/R05처럼 실제 경계 테스트가 없는 원인부터 추가하고, 해당 파일을 바꾸는 작업에서만 lint scope를 넓힐지 판단한다. 현재 green unit 숫자는 신규 반례를 덮지 않는다.

## G. 운영 확인·정책 결정·미연동 사항

### 기능 플래그와 실제 활성화 수준

| 기능 | 코드상 조건·확인된 보호 | 현재 운영 활성화 여부 / 추가 확인 |
|---|---|---|
| 신규 지정가 | `LIMIT_ORDER_ENABLED` 기본 false; strict boolean. frontend `EXPO_PUBLIC_LIMIT_ORDER_ENABLED`는 UI 공개 조건 | 배포 env와 빌드 시 공개 env 미조회. 서버 false인데 UI true여도 서버가 차단 |
| 지정가 매칭 | `SCHEDULER_LIMIT_ORDER_MATCHING_ENABLED` 기본 false, 5초/default200/15분 lookback; 별도 interval/batch/window 범위 검증 | 실제 tick·적격 price/candle·processed age 확인 필요. 등록 off+matching on은 기존 주문 drain이며 startup warning이 있는 의도된 조합 |
| Ops scheduler | `SCHEDULER_ENABLED || anyJobEnabled`. job별 default off, 일부 legacy alias는 canonical `?? alias`로 결정 | **SCHEDULER_ENABLED=false는 전체 강제 종료 스위치가 아니다.** effective jobs/readiness 확인 필요. scheduler dispatch는 실제 실행 `dryRun:false`; manual/CLI의 dry-run default와 혼동 금지 |
| KIS/Binance 수집 | provider enable·credentials·transport/stream flags·시장 상태와 universe. live 소유 모드면 해당 standalone 비활성 | 코드25/40은 DB seeded/active/수신 성공 증거가 아님. symbol별 최신 적격 snapshot·소유 연결·quota 로그 필요 |
| live candle | `CANDLE_LIVE_STREAMING_ENABLED`와 provider별 live flag, Redis owner/pubsub, reconciliation/production 관련 조합 검증 | 실제 Redis/readiness 및 소유 lease·수신 age 필요. startup parser PASS가 실공급자 증거는 아님 |
| 광고 | `AD_REWARD_ENABLED` 기본 false, true면 provider/금액/한도/cooldown/timezone 필수 | real verifier 미연동은 의도적 차단. 운영자가 flag만 켠 상태를 지급 가능 상태로 보면 안 됨 |
| 일반 수수료 | `GENERAL_TRADE_FEE_RATE`, `GENERAL_FX_FEE_RATE` 유효 범위·scale 검증, quote에 pin | 현재 배포 값 미조회. 제품의 fee 변경을 이 조사에서 결정하지 않음 |
| 달력 override | 초기 load·주기 poll·pubsub·last-known-good, unknown calendar fail-closed | 실제 override·향후 달력 확정·readiness degraded 이유 확인 필요 |

설정 수만으로 새 framework를 권고하지 않는다. limit/ad/live/fee에는 엄격한 validation이 있고 legacy scheduler booleans는 미인식 값을 fallback으로 처리한다. alias로 활성화된 job을 무심코 계속 돌리거나 오타로 꺼지는지 판단하려면 **배포의 비밀을 제거한 effective config와 시작 로그**가 필요하다. 이를 현재 운영 오설정으로 단정하지 않았다.

### 코드 결함과 분리할 항목

| 분류 | 현재 판단 | 추가 증거·결정에 따른 후속 행동 |
|---|---|---|
| 운영 제한: process 중단 | Render가 실제 Free인지 미확인. process가 중단되면 그 안의 수집·스케줄러·매칭도 중단되는 구조 | 실제 plan/instance count/uptime/deploy gap·job 시각 확인. Free 전제의 외부 keep-alive·별도 worker를 기본 처방하지 않음 |
| 정책/복구: B window | 지정가 candle lookback 기본15분, 설정 상한1일. 오래 멈춘 기간의 모든 가격 접촉을 소급 체결하지 않음 | 장기 중단 뒤 주문 처리 정책을 명시하고 gap·oldest order·evidence coverage 확인. chart backfill 성공을 매칭 성공으로 간주하지 않음 |
| 정책/UX: 응답 유실 후 unmount | 서버 명령은 멱등이고 mounted UI는 같은 key 재시도. 재시작을 넘긴 pending command 저장은 없음 | 실제 모바일 네트워크 손실 후 history로 결과를 확인할 수 있는지 점검. 영속 pending-command UX가 필요하면 별도 scope로 결정; 새 거래 자동 생성 금지 |
| 미연동: 광고/외부 보상 | 광고 real verifier 없음, reward fulfilled는 내부 결과 | provider 계약/검증·정산 증빙 모델이 정해져야 구현. fake verifier를 production으로 연결하지 않음 |
| 조건부: standalone 중복 수집 | live supervisor는 분산 owner, standalone/FX single-flight는 process 한정 | 다중 배포 중 실제 연결/저장 중복 측정 후 기존 소유권 경계 활용 여부 결정. 중복 관측 행은 곧 중복 금융 실행이 아님 |
| 미검증: socket 세션 재인증 | handshake 검증·공유 연결을 확인했으나 token 교체/사용자 상태 변경 동안 모든 native socket의 종료·재인증은 실험하지 못함 | 실제 refresh/logout/suspend·reconnect barrier 시험. 시장 데이터 채널과 사용자 금융 HTTP의 권한 위험을 혼동하지 않음 |
| 운영: 장기 데이터 보존 | 5m candle retention 외 전체 price/FX/equity/job log 수명 정책은 이번 코드 경로에서 자동 정리로 확인되지 않음 | rows/day·저장비·백업 복구 시간·감사 요구로 retention 결정. 금융/event evidence 무단 삭제 금지 |
| 배포: graceful shutdown | destroy hook 구현은 있으나 실제 SIGTERM·drain 시간·shutdown hook 활성 상태는 운영 실험 안 함 | 인스턴스 중단 중 진행 중 transaction·socket·lock·job 기록 확인. DB rollback과 lease 만료 뒤 재개를 검증 |
| 운영: 관측·알림 | health/readiness·OpsJobRun·provider 진단은 존재. 실제 알림 라우팅/임계값 미확인 | DB unavailable, active orders인데 fill/scan정체, calendar unknown, lease loss, fixture failure를 운영자가 언제 알게 되는지 확인 |

## H. 검증 기록과 다음 작업 단위

### 이번에 실행한 검사

검사 전 package scripts와 테스트 초기화를 읽었다. backend의 `.env.local/.env.development/.env`가 있음을 확인했지만 값은 출력하지 않았다. Prisma CLI는 자체 runtime env loader를 부르므로 단순 test env 표기만으로 격리됐다고 가정하지 않았다. DB 관련 generate/E2E/build는 **env 파일이 없는 `/tmp` local clone**에서 수행했고 DB·Redis 환경값은 사용하지 않는 loopback 테스트 대상으로 제한했다. 운영 migration·seed·repair·reset·provider smoke는 실행하지 않았다.

| 검사·명령 | 결과·증거 해석 |
|---|---|
| `frontend/`: `npm run check` | PASS. accounts/guide check-only lint, `npm run typecheck`, Node 테스트 **85 pass/0 fail**. 실제 mobile 검증 아님 |
| `backend/`: `pnpm run typecheck` | PASS |
| `backend/`: `pnpm exec jest --runInBand --testPathIgnorePatterns=integration.spec.ts` | **198 suites / 2,956 tests PASS**. env를 최소 상속·dummy loopback으로 제한. 실제 PG opt-in integration은 명시적으로 제외 |
| 격리 clone: `pnpm run test:e2e --runInBand` 첫 실행 | 환경 실패. socket `listen EPERM 0.0.0.0`, 340 fail/1 pass. 제품 회귀로 집계하지 않음 |
| 같은 격리 clone: 로컬 테스트 socket 허용 후 동일 E2E | **1 suite / 341 tests PASS**, exit0. HTTP controller/app 경계는 실제 실행, DB/provider는 test override. Jest 종료 지연 경고가 있었으므로 자원 종료 검증 PASS로 확대하지 않음 |
| 격리 clone: `pnpm run build` | PASS. app bootstrap·provider 실행은 하지 않음 |
| 격리 clone: `pnpm run lint:accounts:check`, `pnpm run lint:candles:check`, `pnpm run format:candles:check` | 모두 PASS. auto-fix/format write 명령 사용 안 함 |
| 격리 clone: `pnpm exec prisma generate` + git diff | generate 성공, tracked generated class 변경으로 dirty. R10 재현. DB migration/연결을 실행한 결과가 아님 |
| root: `node docs/investigations/2026-09-22-flow-audit/reproduce.cjs` | 성공 종료. R01/R02/R03/R04/R05/R06/R08의 **결함 증상이 기대대로 재현됨**. 테스트 green은 제품이 고쳐졌다는 뜻이 아님 |
| GitHub read-only | 현재 SHA와 baseline의 runs/jobs/실패 로그, main branch protection/rulesets 확인. [ci-evidence.json](ci-evidence.json)에는 필요한 값과 오류 줄만 보관 |
| 실제 PG·Redis 로컬 통합 | 미실행. 이 작업 공간에서 격리 서버를 구성하지 않았으며 기존 로컬 환경/운영 DB를 사용하지 않음. 아래 현재 SHA CI 실행을 별도 증거로 사용 |
| 실제 browser/mobile, 공급자, 운영 중단/재배포·부하 | 미실행. 과거 docs의 export·기기 기록을 이번 PASS로 사용 안 함 |

현재 HEAD [GitHub Actions run 35624316629](https://github.com/windowsjd/trading_app/actions/runs/35624316629)은 2026-09-21 UTC 실행이다.

| job | 확인 결과 | 실제 검증 범위 |
|---|---|---|
| Backend quality | PASS | scoped lint/format/typecheck/build/unit. opt-in DB 테스트 존재만으로 DB 검증했다고 하지 않음 |
| Frontend quality | PASS | scoped lint/typecheck/tests/web export. browser/native 조작 아님 |
| Release-critical E2E | PASS | test module의 DB/provider 대역을 사용하는 API 통합 |
| Core account PostgreSQL integration | PASS | CI의 PG16 격리 서비스. migration/drift, trading-account/general trading/general FX/season join/auth/ops-lock opt-in 및 general audit dry-run 연결 |
| Limit order PostgreSQL integration | PASS | CI PG16. reservation/idempotent replay/matching/order/FX/MVP 흐름, transaction-time·fee/tradability 통합 연결 |
| Candle fixture integration | FAIL | PG16/Redis7 준비 후 smoke **clean-tree 사전 검사에서 중단**. fixture 시나리오 본문 미검증, 새 결과 artifact 없음 |

Core/Limit job의 명시 env와 testPathPatterns를 확인했으므로 “금융 DB 통합이 CI에서 전부 skip”이라는 결론은 틀리다. 반대로 그 성공이 이번 신규 경쟁 반례를 다루는 것도 아니다. 캔들 baseline [35613759643](https://github.com/windowsjd/trading_app/actions/runs/35613759643)도 동일 dirty preflight 실패였다. generated 차이는 주석만이므로 제품 runtime 회귀를 암시하지 않는다.

### 재현 실행·읽는 방법

```sh
node docs/investigations/2026-09-22-flow-audit/reproduce.cjs
```

기존 backend TypeScript/Decimal 의존성을 사용한다. 원본 `.ts`를 읽어 CommonJS로 변환하고 vm에서 제한된 의존성 대역으로 실행한다. DB·HTTP·실제 credential store를 연결하지 않는다. socket 오류 재현은 실제 서버 socket 없이 timer callback을 자식 Node에서 호출한다. ranking은 실제 refresh/writer를 실행하지만 valuation·scope·transaction을 대역으로 제공한다. matcher는 실제 repository의 정렬/take query와 matching loop를 사용하지만 SQL 실행 계획·row lock은 시험하지 않는다. 합성 시각은 `2026-09-22T00:00:00Z` 부근의 고정값이며 비밀·개인정보가 아니다.

raw 임시 검사 로그는 `/tmp/trading-audit-*.log`에 남겼고 지속 산출물에는 요약과 합성 재현 결과만 보관했다. 운영 token/password/DB 연결문자열/provider key/proof/사용자 개인정보는 보고서나 결과 파일에 포함하지 않았다.

### 이후 하나씩 구현할 작업 단위

| 작업 | 허용할 변경 범위 | 완료 검증·핵심 불변조건 |
|---|---|---|
| T01 R01 세션 세대 | frontend auth/session/client/storage와 관련 테스트 | old refresh/401이 새 token/cache를 건드리지 않음, 동시401 병합 유지 |
| T02 R02 종료 보장 | frontend logout/expiry bridge/teardown 테스트 | storage get/remove 실패에도 cache clear→Login, old credential로 보호 API 재개 금지 |
| T03 R03 참가 시간/잠금 | backend SeasonsService/공통 SQL helper/PG tests | 종료/정산/중복 join barrier, account+grant 정확히 한 번·실패 rollback |
| T04 R04 후보 탐색 | candidate repo/matcher/필요 config·지표/tests | N+1/양 모드·양 방향/다자산·실패 후보에도 전진, 체결부 정책 유지 |
| T05 R05 ticker 오류 | gateway timer/조회 실패 격리/tests | DB reject가 process를 종료하지 않음, poll 동시성 상한·회복, 허위 가격 금지 |
| T06 R06 writer 순서 | ranking refresh/기존 lock 경계/PG tests | 두 trigger/두 instance의 최신 계산 유지, final 불변성 |
| T07 R12 reader 일관성 | ranking read/짧은 tx 또는 version retry/tests | metadata/count/my/page 한 세대, pagination contract 유지 |
| T08 R08/R07 작은 비용 제거 | integrity ledger grouping, ranking row lookup 및 동치성 tests | 선형 비교, 모든 손상 입력 동일 차단, Decimal/TWR 결과 동일 |
| T09 R07 batch/병합 | ranking 계산·후속 trigger 병합, 합성 부하 fixture | query/lock/memory 근거로 효과 확인. summary/schema는 별도 승인 범위로 분리 |
| T10 R09 lease | ops runner/장기 handler/tests | takeover 뒤 old owner 새 batch 중단, 금융 사건 원자성·후임 lock 유지 |
| T11 R10 CI | generated 추적/재생성 규칙·workflow 검증 | clean generation + 같은 SHA의 PG/Redis fixture 새 artifact PASS; dirty bypass 금지 |
| T12 R11 문서 | AGENTS/짧은 index/충돌한 정책 문단 | 현행 계약·역사 기록 구분, 제품 정책 변경 없음 |

먼저 T01/T03/T04/T05/T06과 릴리스 검증 T11을 처리할 가치가 높다. T02/T07/T08은 경계가 작고 효과가 명확하다. T09/T10은 현재 부하·다중 배포 계획을 확인해 범위를 정한다. 이 순서는 전체 코드를 한 번에 리팩터링하자는 제안이 아니다.

### 자체 검토와 변경 내역

- F01~F29에 화면·모든 controller 표면·네 realtime 채널·scheduler/CLI를 연결했고, 미실행 환경은 C/B/H에 남겼다. 금융 PG CI 성공과 새 대역 재현을 구분했다.
- 일반/시즌·buy/sell·KRW/USD·current/final을 구분했다. source selection의 의도된 차이, account 소유권, Decimal/fee/TWR/예약·멱등/SQL CHECK/partial unique를 반대 증거로 대조했다.
- 폐기된 Redis Stream, 이미 고친 query cache shape, 기존 snapshot skip/metadata batch/shared socket을 새 문제로 집계하지 않았다. 역사 문서·비활성/미연동/운영 제한은 코드 결함과 분리했다.
- R06(writer 순서)과 R12(reader snapshot), R01(세션 세대)과 R02(storage 실패)의 다른 원인을 구분하고, 같은 gateway 장애의 여러 화면 영향은 R05 하나로 묶었다. 중요한 효과 없는 naming/포맷·파일 크기 지적은 제외했다.
- 소스/기존 테스트/config/schema/migration/package/lockfile을 수정하지 않았다. 추가 파일은 이 디렉터리의 `flow-register.md`, `report.md`, `reproduce.cjs`, `reproduction-results.json`, `ci-evidence.json`뿐이다. commit/stage/push/운영 설정 변경은 하지 않았다.
- 최종 `git diff --check`, tracked `git diff --exit-code HEAD`, 새 문서 링크/재현 결과 대조로 허용 범위 밖 변경이 없는지 확인했다.

완료 기록(2026-09-22): tracked diff 없음, 새 파일은 위 조사 산출물 5개뿐이다. F01~F29와 R01~R12의 중복·누락, 로컬 파일 링크, JSON 증거, 새 파일 whitespace 검사를 통과했다. 기존 소스·테스트·설정·schema·migration·dependency 파일 변경은 없다.
