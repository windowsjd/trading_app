# 초보모드 1차 기반 통합 구현 검토

사용자 요청의 확정 정책을 기준으로 구현했다. 운영 배포·실사용자 활성화 기록은
아니다. 현행 계약은 [초보모드 기반 계약](../../../backend/docs/beginner-mode.md)에
있으며 아래 내용은 이번 조사·구현·검증의 기록이다.

## 1. 조사한 영향 범위와 가설 확인

| 영역 | 실제 구조와 조치 |
| --- | --- |
| Prisma·마이그레이션 | `TradingAccountMode`는 general/season 두 값이었다. 계정 소유자별 general partial unique index, 초기 지급 reference unique index, TWR origin 제약, 네 canonical wallet identity를 확인했다. beginner enum과 별도 소유자 unique index만 추가했다. |
| 생성·소유권·금융 무결성 | `GeneralAccountsService`가 이미 네 지갑·원장·TWR origin을 한 transaction에서 생성했다. 이 코어를 재사용했다. `TradingAccountAccessService`의 userId+accountId 소유권 검사와 비시즌 participant 금지를 유지했다. |
| 주문·시세·포지션 | accountId가 이미 canonical scope였다. 신규 quote/execute, 지정가 예약·취소·matcher, 수수료 pinning, 계정 잠금·성과 snapshot의 general 분기를 beginner까지 확장했다. 시세/캔들/provider/체결 계산은 변경하지 않았다. |
| 환전·지갑 이체 | 독립 계정 FX context와 request hash, 계정 잠금, USD 이체 및 KRW composite 이체를 확인했다. 동일 계정의 지갑만 찾는 기존 검증을 유지했다. |
| 선물·보호 주문 | 기존 open/increase/reduce/close, 지정가 진입, 수수료·TWR·청산, Conditional lifecycle 분기에서 beginner를 시즌으로 취급하지 않게 했다. 기존 Futures/Conditional feature flag는 유지했다. |
| 총자산·TWR·일별 기록 | 일반계정 TWR/외부 유입 코어와 포트폴리오 일관 읽기·스냅샷을 재사용했다. 일반 일별 batch와 누락 작업 탐색에 beginner를 포함했다. |
| 시즌·랭킹·티어·보상 | participant/season account를 명시적으로 검사하는 기존 경로였다. 시즌 금융 정책 및 정산 코드는 수정하지 않았다. 광고 보상은 기존 general-only 검증을 유지했다. |
| Frontend | 계정 DTO·provider·선택/생성·capability·계정 표시·home/wallet·탭을 조사했다. 금융 query key, 응답 accountId 검증, mutation account binding 및 logout 경계는 이미 있었다. |
| 가이드·내비게이션 | GuideStack의 기존 10개 학습 화면과 GuideScreen을 공유한다. 원래 탭 navigator key는 mode여서 같은 모드의 계정 전환에는 재사용됐다. accountId로 바꿔 계정 전환 때 로컬 상태를 초기화한다. |
| 운영 도구 | 일반 전용 audit/backfill과 시즌 repair 도구도 검색했다. 기존 도구의 목적·데이터 수정 범위는 넓히지 않았다. 초보계정은 runtime integrity와 신규 DB 통합 검증으로 검사한다. |

따라서 “일반이 아니면 시즌”인 일부 분기가 문제라는 가설은 맞았다. 반면 별도 금융
저장소나 지갑 생성 체계를 새로 만들 필요는 없었다. 기존 금융 행들이 이미
TradingAccount별로 분리되어 있어 필요한 모드 분기만 보완했다.

## 2. 설계와 정책

- `beginner`는 사용자당 평생 하나다. closed/suspended도 unique 제약을 점유한다.
- 초기 10,000,000 KRW는 한 번만 지급한다. 증권 KRW/USD, 암호화폐 현물/선물
  USD 네 지갑, 초기 원장, TWR origin이 모두 같은 DB transaction에 속한다.
- 생성 동시 요청의 unique 충돌은 승리한 계정을 다시 읽어 반환한다. 기존 계정을
  자동 복구·재활성화·재지급하지 않는다. GET와 계정 선택에는 쓰기가 없다.
- 재사용한 원장 reference와 snapshot reason의 역사적 이름은
  `general_account_open`이다. 실제 금융 소유권/referenceId는 초보 accountId이고
  기존 단일 지급·origin 유일 제약을 그대로 적용한다. 별도 지급 엔진은 추가하지 않았다.
- 일반과 초보가 공유하는 것은 초기 지급·수수료·평가·TWR·거래 잠금 등 금융 규칙이다.
  광고 보상과 시즌 참가·랭킹·티어·정산·보상 자격은 공유하지 않는다.
- 기본 비활성이다. `NODE_ENV=development|test`와 `BEGINNER_MODE_ENABLED=true`를
  모두 만족해야 개설·목록 노출·신규 금융 진입을 허용한다. production에서는 true여도
  비활성이다. 계정 목록의 `beginnerModeEnabled`가 Frontend 진입 경계다.
- 비활성화 뒤에도 소유 계정 조회, 기존 주문 취소, 선물 reduce/close·청산 및 이미
  커밋된 명령 재시도를 위한 기존 안전 경로를 유지한다. 개발용 거래 접근은 제품의
  공식 기능 해금 판정이 아니다.

## 3. 파일과 마이그레이션

정확한 신규·수정 파일은 [changed-files.txt](changed-files.txt)에 있다.

주요 신규 파일은 `account-mode-policy.ts`, 두 DB migration,
`beginner-account-integration.ts`/DB spec, `BeginnerAccountEntry.tsx`,
`BeginnerLearningScreen.tsx` 및 각각의 검증이다. 기존 계정·금융 서비스의 작은 모드
분기를 수정했고 Prisma generated client를 재생성했다. 기존 core account CI job에
초보 DB 검증을 추가했다. 패키지·lockfile·seed 및 기존 마이그레이션은 수정하지 않았다.

1. `20261009120000_add_beginner_account_mode`: enum 값 추가.
2. `20261009120100_add_beginner_account_owner_constraint`: beginner 사용자별 unique index.

두 migration을 나누어 PostgreSQL에서 새 enum 값을 인덱스에 사용하기 전 commit되게
했다. 기존 계정·지갑·금액·원장·snapshot을 UPDATE/DELETE하거나 backfill하지 않는다.
기존 사용자 데이터는 그대로 유지한다. 서버 배포 전 migration 적용과 client 생성이
필요하다. 이번 검증은 `/tmp`에 별도로 만든 PostgreSQL 16의 로컬 테스트 DB에서만
수행했다. 설정된 원격 DB에 migration이나 금융 쓰기를 수행하지 않았다.

## 4. 생성·조회·전환과 화면

`POST /api/v1/trading-accounts/beginner`만 개설한다. 응답의 `created`로 신규/재시도를
구분하고 실제 서버 accountId를 선택한다. POST 성공 후 목록을 갱신한 뒤 선택하며,
기존 계정 선택은 POST를 호출하지 않는다. `/api/v2`는 추가하지 않았다.

| 계정 | 하단 탭 |
| --- | --- |
| 초보 | 홈 / 마켓 / 퀘스트 / 지갑 / MY |
| 일반 | 홈 / 마켓 / 가이드 / 지갑 / MY |
| 시즌 | 홈 / 마켓 / 랭킹 / 지갑 / MY |

마지막 탭의 표시 이름은 요청한 MY로 맞췄으며 기존 MY 하위 화면·기능은 유지한다.
초보 홈은 기존 비시즌 자산 화면과 TWR를 사용한다. 퀘스트 탭은 명확한
퀘스트/가이드 세그먼트를 제공하며, 준비 문구 외에 퀘스트 수치나 잠금 상태를 만들지
않았다. 가이드 세그먼트는 기존 콘텐츠와 학습 내비게이션을 직접 사용한다.

320px·글자 2배에서 퀘스트 탭 이름이 잘리는 현상을 브라우저로 발견해 해당 탭의 폭을
늘렸다. 세그먼트는 최소 48px 터치 영역이다. [화면·전환 결과](browser-validation.json)와
[밝은 화면](quest-2-light.png), [어두운 화면](quest-2-dark.png)을 함께 보관했다.

## 5. 금융 검증

실제 PostgreSQL에서 다음을 확인했다.

- 동시 개설 8개 요청이 한 accountId에 수렴하고 `created=true`는 하나다.
  네 지갑·지급 원장 하나·TWR origin 하나, 중복 계정/지급에 대한 DB unique 거절.
- 지갑 첫 번째/네 번째, 원장, TWR origin 생성 단계의 주입 실패가 모든 행을 롤백.
- 재시도·GET가 행 수를 늘리지 않음. closed 재시도에도 지급하지 않음.
  손상된 TWR origin을 POST가 복구하지 않음.
- 다른 사용자의 계정/포트폴리오/지갑/주문 조회 및 FX 접근 거절.
  같은 사용자의 일반·시즌 지갑과 초보 지갑 사이 양방향 이체 거절.
- 초기 총자산 10,000,000, 투자손익 0, TWR 0%, 외부 유입 10,000,000,
  TWR factor 1. 환율 1,400·수수료 0.1%의 1,400,000 KRW 환전 뒤 총자산
  9,998,600, 투자손익 -1,400, TWR -0.014%. 계정 내 USD 이체는 총자산/TWR 불변.
- 같은 사용자의 일반·시즌 총자산은 10,000,000으로 유지됨. 초보의 일별 기록도 TWR와
  외부 유입을 보존함. 실제 시즌 ranking refresh와 settlement를 실행해 초보 랭킹 0건,
  초보 계정 active·TWR 불변을 확인함. 초보 광고 보상 거절.
- 일반·시즌·초보 세 모드의 주문 입력/시장가/지정가 matcher/취소, 지갑 이체·composite
  FX, 선물 실행·동시성·실패 롤백을 기존 실제 DB 테스트 시나리오로 검증함.

## 6. 테스트·OOM 예방과 남은 검증

최종 명령·결과는 [verification.json](verification.json)에 기록한다.
전체 Frontend `npm run check`는 150개 테스트 파일을 통과했고 이후 수정된
계정·내비게이션·가이드·진입 영향 범위는 294개 검증을 실행했다. UI 테스트의
존재/부재 단언은 boolean/count/문자열을 사용하며 ReactTestInstance를
null/undefined 비교의 실제값으로 넘기지 않는다. 검증 삭제·실패 성공 처리·OOM 회피용
skip은 없다. Backend의 통합 테스트 opt-in skip은 기존 방식이고 실제 DB 명령으로
별도 실행했다.

최종 무거운 검증은 systemd cgroup v2로 모든 자식 프로세스를 포함해 메모리 2GiB,
swap 0, tasks 192, 작업별 시간 제한과 KillMode=control-group을 적용했다. 실제 제한과
브라우저 자식 membership을 확인했다. Node 힙 제한도 함께 적용했다.

Web export의 기본 병렬 Metro 실행이 cgroup 메모리 한도에 도달했다. 종료와 자식
정리를 확인하고 워커 1개로 바꾸어 통과했다(관측 peak 약 562MiB, OOM event 0).
Backend 최종 재검증에서는 768MiB Node 힙이 TypeScript 컴파일에 부족해 종료됐다.
컴파일 단계와 잔여 프로세스를 확인한 뒤 2GiB 전체 제한 안에서 힙 1.5GiB로 조정했다.
거대 assertion 출력으로 인한 실패는 없었다. 환경/계약 기대/새 fixture 관련 초기
실패는 원인을 수정해 재검증했으며 검증 조건은 유지했다.

실제 Android/iOS 실기기에서의 글꼴·safe area·터치 및 실제 provider와 연결한 거래는
이 환경에서 실행하지 않았다. 16개 RN Web 레이아웃과 실사용 컴포넌트의 내비게이션,
지연 응답·MutationObserver를 사용한 전환 중 자산/보유종목 격리, 계정별 지갑 표시,
비활성 진입 차단을 검증했다. 브라우저 검증은 native 실기기 검증을 대신하지 않는다.

## 7. 미구현 정책·회귀 위험·자체 검토

퀘스트 종류/개수/순서/완료 조건, 기능 해금 순서·엔진, 경험치·레벨·학습 등급,
퀘스트 보상금·광고 보상·추가 지급·주기 초기화·계정 간 자산 이전은 구현하지 않았다.

공통 금융 코어의 모드 분기와 잠금·TWR 적용 대상을 넓힌 것이 주요 회귀 위험이다.
기존 일반·시즌의 실제 DB 테스트와 단위 테스트로 확인했으며, 시즌 수식·수수료·참가·
정산 정책 자체는 변경하지 않았다. 기존 general 전용 원장 reason 이름을 재사용하므로
운영 SQL은 이름만 보고 계정 모드를 판단하면 안 된다. 항상 TradingAccount.mode와
accountId로 구분해야 한다.

`git diff`에서 신규 경계, 금융 소유권, 원자성·replay, 시즌/광고 전용 검사,
Frontend 계정 전환·가이드 재사용, 변경 테스트의 오류 출력 경로를 검토했다.
불필요한 금융 리팩터링, 전역 lint 확대, dependency 변경, 백필·seed·운영 활성화는 없다.
기존 tab 명칭을 쓰던 수동 browser 검증도 MY 표시에 맞추었다. 배포·commit·push는
이번 작업에 포함하지 않았다.
