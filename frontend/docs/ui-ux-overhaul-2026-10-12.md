# Trading Class 전반 UI/UX 개선 (2026-10-12)

시작 `main` = `origin/main` = `c4fea106`, working tree clean. 커밋·push·배포·운영 DB Migration 없음.
14개 요구사항을 기존 디자인 시스템(ActionPressable/CTAButton, transitionPolicy, financialColors,
TierEmblem/TierCardBackground, AccountHoldings, quest bridge)을 재사용해 구현했다.

## 참고 영상 실측 (프레임 분석)

세 영상 모두 1080×2340, 30fps, HEVC. 시스템 ffmpeg가 없고 Playwright ffmpeg/Chromium은 HEVC를
디코드하지 못해 scratchpad에 `ffmpeg-static`을 받아 프레임을 추출했다(저장소 밖, 원본 미복사).

| 영상 | 실측 | 구현 |
| --- | --- | --- |
| 1 터치 물결 (8.67s, Toss `보내기`/`채우기`) | 터치 지점(버튼 오른쪽 78%)에서 **경계가 뚜렷한 원**이 커져 ~130ms에 버튼을 덮음, 누르는 동안 유지, 손을 떼면 ~100ms에 전체가 사라짐. 버튼은 ~0.98로 축소. 진한 버튼은 더 어둡게, 연한 버튼은 같은 색 계열로 진해짐 | `InkRipple` — 터치 좌표 원점, 가장 먼 모서리까지 반경, ease-out cubic 240ms(Web 실측 133ms에 반경 94%), 해제 130ms 페이드, 기존 0.97 축소 유지, 모서리 clip |
| 2 슬라이딩 선택 (3.21s, 구매/판매/대기) | 흰 pill이 회색 트랙 위를 이동: 33/67/100ms에 50/82/96%, ~130ms 정착. 라벨 색은 즉시 전환, 레이아웃 변화 없음, 대상 칸에 짧은 눌림 tint | `SegmentedControl` — 140ms ease-out cubic(Web 실측 47/81/96%), 라벨 즉시 전환, 고정 트랙, 정적 selection tint |
| 3 화면 전환 (1.95s, 홈→계좌 상세) | 새 화면이 오른쪽에서 진입: 33ms 38%, 67ms 64%, 100ms 77%, 167ms 89%, ~380ms 정착(강한 감속). 이전 화면은 진입 거리의 0.31배(-30%) 왼쪽 이동 + 약 15% 어두워짐 | iOS `simple_push`(과감쇠 spring, -30%, dim 0.1)를 350ms로. Android `ios_from_right`(-30%, 플랫폼 시계·dim 없음) 유지. Web은 방향 cue 260ms. 영상에는 뒤로가기 장면이 없어 역방향은 플랫폼 기본(반대 방향) |

차이: Android의 native-stack 애니메이션 곡선/길이는 `config_shortAnimTime`·accelerate-decelerate로 고정되어
있어(react-native-screens 리소스) 영상의 감속 곡선·dim과 완전히 같지 않다. native 패치는 하지 않았다.

## 항목별 최종 동작과 의도

1. **터치 물결** (`ActionPressable`, `InkRipple`, `pressFeedback`)
   - 의도: 누른 위치에서 즉시 퍼지는 반응으로 "눌렸다"는 확신을 주되, 기존 축소/배경/그라데이션은 그대로.
   - 버튼(`feedback="button"`, CTA): 축소 + 잉크. 카드/행(default): 잉크만(축소 없음).
     선택형 컨트롤(`feedback="selection"`): 정적 tint(물결 대신 슬라이딩 pill이 피드백).
   - 색: 표면 색을 진하게(유채색 16%, 연한 표면 10%, 흰 표면 7%), 무채색 진한 표면(다크 카드, neutral CTA)은 흰색으로 밝힘.
     매수/매도 주문 실행 버튼(`ripple="subtle"`)은 같은 색 60% 강도.
   - 위치: 버튼 표면은 `pointerEvents="none"`이라 locationX가 대상 기준. 행은 자식 터치 가능성 때문에
     native에서 행을 measure(새 아키텍처에서 동기)해 page 좌표로 원점을 구하고, Web은 RNW가 currentTarget 기준.
     키보드/접근성 실행은 중앙에서 시작. Reduced Motion은 정지된 전체 tint.
2. **화면 전환** (`transitionPolicy`, `stackScreenLayout`) — 위 표. 하단 탭은 기존 190ms 페이드 유지,
   바텀시트는 아래에서 등장/퇴장. Web native-stack은 전환이 없어, 스택 top이 바뀌는 화면만
   오른쪽(push)/왼쪽(back)에서 260ms 감속 진입(첫 화면·탭 전환·Reduced Motion 제외). native에는 래퍼 자체가 없다.
3. **고래 로딩** (`WhaleLoader`) — 기존 티어 Whale 앰블럼은 버튼 크기에서 읽히지 않아, 앰블럼과 같은
   "원 안의 고래" 개념의 단순 SVG(두 갈래 꼬리)를 만들었다. 진행률 미상: 원을 따라 도는 호
   (`Animated.loop`, native driver, 허위 수치 없음, `accessibilityValue` 없음). 진행률 지정: 시계 방향 채움,
   완료 전 최대 99%. Reduced Motion: 회전/부분 호 없음. 적용: FullPageLoading, Splash, CTA loading,
   로그인/회원가입, 목록 더보기·섹션 로더, 퀘스트 카드 busy. Pull-to-refresh(native)와 스켈레톤은 유지.
4. **로그인 버튼** — 원인: 요청 중 `disabled`가 되면 ActionPressable이 그라데이션을 빼서 `semantic.selected`(#202a35)가
   보였다. 이제 `accessibilityState.busy` 버튼은 입력만 막고 외형(그라데이션)을 유지. 라벨 자리에 흰 고래(같은 높이 박스).
   동기 `inFlight` ref로 렌더 전 연타도 1회만 요청, settle 후 재시도 가능. 오류 문구 흐름은 그대로.
   CTAButton `loading`도 같은 이유로 더 이상 검게 변하지 않는다.
5. **금융 색** (`financialColors`) — 상승/하락 텍스트만 채도 상향(빨강 #c8241e/#ff6b64, 파랑 #1b5ec9/#64a2ff,
   초록 #118038/#4ed472 + 초록 캔들 동일). 모든 배경·자기 surface 대비 4.5:1 이상 유지(테스트). 0%/미상은 기존 중립.
   주문 액션·현금흐름·브랜드·티어 색은 불변.
6. **홈 계정박스** (`AccountSwitcher home`, `HomeAccountContext`) — 일반/초보/시즌 공통 한 구조: 첫 줄 제목+계정변경(36dp 표시,
   hitSlop으로 44dp), 둘째 줄 프로필·닉네임(시즌은 순위). minHeight 96·상하 20 패딩 제거 → 390px에서 104px(이전 ≥136px).
   긴 이름/큰 글꼴은 줄바꿈, 순위는 공간이 없으면 다음 줄로.
7. **티어 앰블럼 재배치·랭킹 카드** — 홈: 시즌 계정만 `HomeTierBadge`가 총자산 오른쪽(84/68px, 원본 비율·optical scale 유지,
   티어명 caption). 숫자가 주정보. 공간이 부족하면 아래로 wrap. 일반/초보에는 아무 티어도 없다.
   랭킹: 홈의 티어 카드 디자인을 `TierCard`로 분리해 '내 순위'에 사용(배경 띠·모서리 비율·전경 halo 그대로),
   계정변경 버튼·시즌명 없음. 티어 미상이면 같은 정보의 일반 카드.
8. **랭킹 화면** — 퍼센타일 행 삭제(UI만; API/DB 불변), '등급 gold' → 앰블럼(수익률 왼쪽), 전체·친구·TOP10·상위 랭커·
   내 순위·사용자 상세 모두 사진 왼쪽/이름 오른쪽, 수익률 18/800 + 상승/하락 색, 총자산 15/600, 순위 20/800.
   탭은 SegmentedControl. 정렬·동점·티어 정책 불변.
9. **이체 바텀시트** (`WalletTransferSheet`, `InlineBottomSheet`, `ScreenSheetHost`) — 지갑에서 이체하기를 누르면 시트가 올라온다.
   **왜 RN Modal/native modal이 아닌가**: Android Dialog·iOS 모달 VC는 MainTabs 위의 퀘스트 스포트라이트까지
   덮어 QUEST 02(이체)가 깨진다(환전 성공 시트가 퀘스트 중 생략되는 이유와 같다). 그래서 시트를 MainTabs의
   `ScreenSheetHost`(탭/헤더 위, 퀘스트 오버레이 아래)에 그린다. 이체 폼 로직(사전 잔액 확인, 고정 멱등키, 동기 fence,
   불확실 재시도, scope)은 그대로 이동했다. 요청 중에는 배경·닫기·Android 뒤로가기가 모두 비활성(취소로 오인 방지).
   지갑을 떠나면 시트가 닫히고 다시 열면 새 폼(새 키). 완료 영수증은 시트 안에서 표시, 버튼은 `확인`(닫기)/
   `마켓으로 가기`. 환전 완료 시트도 `지갑으로 돌아가기` → `확인`(동작 동일). 퀘스트는 Wallet 라우트 + 이체 폼 facts를
   'transfer' 화면으로 인식하고, 시트를 닫으면 기존처럼 1단계로 돌아간다. iOS 키보드는 시트가 높이만큼 올리고
   Android는 adjustResize.
10. **문의하기** — 기존 기능 없음 → 최소 백엔드: `inquiries` 테이블(사용자·client request id·유형·제목·내용·시각,
    unique(user, request id)), `POST /api/v1/inquiries`, `GET /api/v1/inquiries/me`(본인 것만). 전역 access-token guard,
    엄격 검증(유형 6종, 제목 2–100, 내용 10–2000, 제어문자 거부), 같은 키 재전송은 같은 문의 반환, 다른 내용은 409,
    10분 5건 제한(재전송 응답은 허용). 화면은 MY > 문의하기: 유형 chip, 제목/내용(글자수), 전송 중 고래, 서버 영수증이
    확인될 때만 성공, 결과 불명은 같은 키로 재확인, 거절은 새 키, 내 문의 내역. 외부 SaaS/실시간 채팅/티켓 상태 없음.
11. **잔액 부족 즉시 안내** — 현물 매수: 입력 중 미리보기 총액(수수료 포함; 지정가는 지정가 기준)이 주문 가능 금액
    (잔액−예약금)을 넘으면 '잔액이 부족합니다.'와 실행 버튼 비활성, 정상 범위면 해제. Decimal 비교. 가격·수수료·잔액이
    불확실하면 판단하지 않음(서버가 최종). 불확실 주문 재시도(같은 키)는 예외. 퀘스트 금액 단계도 이 안내와 일치.
    매도 수량 초과 안내는 기존 그대로. 주식 비율 100%는 실제 수수료가 0.2% 버퍼보다 클 때 수수료를 쓰도록 맞춤.
    선물: 증거금 계산은 서버 정책이라 재현하지 않고, **확실한 경우만**(진입/증가인데 free collateral ≤ 0) 서버와 같은
    문구로 즉시 안내·비활성. 환전/이체는 기존 즉시 안내가 이미 같은 구조.
12. **주문 화면 보유종목 이동** — 다른 종목 보유 행 상단(카드 모서리까지)이 버튼: 누르면 기존 `selectAsset`
    (`setParams`)로 같은 계정의 그 종목 주문 화면으로 전환. 화면이 assetId 키로 재마운트되어 금액·수량·견적이 넘어가지 않음.
    현재 종목 행은 이동 대상 아님. TP/SL 버튼·편집기는 별도 컨트롤.
13. **버튼 그룹·슬라이딩** — 홈 HOT(국내/미국/암호화폐), 마켓 현물/선물(+같은 범주인 국내/미국/암호화폐 탭), 주문 시장가/지정가
    (드롭다운 → 세그먼트), TP/SL 각 다리의 시장가/지정가, 보유종목 필터(현재 종목/전체 보유/대기 목록), 퀘스트 화면
    퀘스트/가이드, 랭킹 전체/친구/TOP10. 매수/매도(`OrderSideSegment`)도 같은 140ms로 통일. 손절/익절 체크박스,
    비율 버튼 등 독립 액션은 묶지 않았다. 지정가 학습 잠금은 caller의 gate가 그대로 판단(거부되면 pill 불이동).
14. **종목 상세 보유종목 삭제** — `AssetDetailScreen`에서 `AccountHoldings` 제거(계정 없음 안내만 유지).
    컴포넌트는 주문 화면에서 계속 사용. 퀘스트: holdings/TP·SL/지정가 결과 단계가 order 화면으로 이동,
    marketSell은 '판매하기'(상세) → 보유 확인(주문) → 주문 단계 순(단계 수·증거 규칙 불변), protection은 해당 종목 주문
    화면으로 열림, 체결 후 상세로 강제 이동 제거, 보유 없음 안내는 주문 화면 메시지.

## 검증

- frontend `npm run lint:accounts:check`, `lint:guides:check`, `typecheck`: PASS.
- frontend 전체 `npm test`: **2291 pass / 0 fail / 0 skip**(신규: 고래·세그먼트·시트·잔액·선물 담보·보유 이동·이체 영수증/busy·
  문의 화면·로그인 fence·퀘스트 전환 테스트). 기존 테스트는 바뀐 계약에 맞게 갱신했고 검증 의미는 유지(삭제·skip 없음).
- backend: `tsc`(build config) PASS, 신규 파일 eslint/prettier PASS, inquiries 단위 25 PASS,
  격리 user-space PostgreSQL(127.0.0.1:55471, 운영 DB 아님)에서 **빈 DB 전체 migration 체인 적용 + drift 없음**,
  HTTP+guard+DB 통합 22 assertions PASS(401/403, 검증, 소유권, 동시 중복 탭 1건, 409, 429, 금융 테이블 불변, 정리).
- Web export, Android/iOS Metro·Hermes export: PASS.
- 실제 Web 렌더(Playwright, RN-Web, production 화면/내비게이터 + fixture transport, scratchpad):
  물결 원점/확산·세그먼트 프레임·Web push/back 프레임 실측, 홈 박스 높이·앰블럼 배치, 랭킹 카드(390/320×2/다크),
  주문 잔액 부족(라이트/다크), 보유종목 이동, 상세 보유 삭제, 이체 시트(헤더·탭바 덮음)→영수증→확인, 문의 접수,
  로그인 busy(그라데이션 유지, 연타 1회), 지갑 빠른 실행 아이콘.
- `test/browser/beginnerBrowser.cjs`: 표준(19 layouts, 9 guided flows, 이체 시트 포함) PASS,
  `FULL_QUEST_BROWSER=1` 8개 거래 퀘스트 PASS, compact(320/글꼴 2/다크/Reduced Motion) PASS.

## 남은 제한

- **Android/iOS 실기기·시뮬레이터 NOT_RUN**(도구 없음). native 잉크 clip, measure 동기성, iOS 키보드 시트, 실제 push 곡선은
  기기 확인이 남는다. 화면 검증은 Web 렌더다.
- Android 화면 전환은 플랫폼 고정 곡선(감속만이 아닌 accelerate-decelerate, dim 없음).
- 저장소의 다른 browser 스크립트: `walletBrowser`, `conditionalBrowser`는 **HEAD에서도 동일하게 실패**(fixture 부트/번들 오류,
  `git archive` 사본으로 확인). `homeBrowser`, `homeTierBrowser`, `orderControlsBrowser`, `primaryButtonBrowser`,
  `motionBrowser`, `uiCleanupBrowser`, `tradingBrowser`, `orderLayoutBrowser`는 의도적으로 바뀐 이전 계약(시즌 홈 카드,
  드롭다운, 25% wash 등)을 단언하므로 갱신이 필요하다(이번에 미수정, `npm run check` 밖).
- 문의 답변/관리자 화면은 없다(접수·본인 조회만). 운영 반영은 migration 적용 승인 후.
- 선물 증거금 부족의 일반 사례(free collateral > 0)는 서버 응답으로만 안내.

## 보충 요구사항 9개 (15–23)

시작 `main` = `origin/main` = 원격 main `953576fb`(14개 작업은 `bfb9d016`에 반영됨), working tree clean.
frontend만 변경. 커밋·push·배포·Migration·서버/API 변경 없음. 화면 계산은 표시용이며 서버 금융 값이 기준이다.

15. **홈 평가손익 통합** (`features/tradingAccount/homePortfolio.ts` `homeUnrealizedPnlKrw`, `HomeAssetHero`)
    - 근거: 서버 valuation은 현물 포지션의 `unrealizedPnlKrw`와 선물 포지션의 `futuresUnrealizedPnlKrw`(Mark PnL USD ×
      같은 USD/KRW)를 따로 합산하고, 총자산은 둘 다 이미 포함한다 → 두 값을 더해도 중복이 없다.
    - '선물 Mark 미실현손익' 줄 삭제, '평가 손익' = 두 서버 값의 decimal.js 합(scale 8), 부호별 금융 색, 0은 중립.
      어느 한쪽이라도 없거나 형식이 틀리면 '알 수 없음'(0으로 간주하지 않음). 서버는 선물이 없어도 `0.00000000`을 보낸다.
    - 평가 불가(summary null)·정산 완료(final result) 표시는 그대로. 총자산·수익률·실현손익·Portfolio 화면 표기는 불변.
16. **홈 티어 앰블럼 확대** (`HomeTierBadge` 84/68 → 112/88, `HomeAssetHero`)
    - 원본 비율·optical scale 유지. 총자산의 자연 폭(숨김 측정 Text), 앰블럼 폭, 행 폭을 onLayout으로 재서 옆에 들어가면
      총자산 옆, 아니면 총자산 아래 수익률·평가손익 줄 옆으로 '약간 아래' 배치한다(측정 전 기본값도 아래).
    - 36dp 8자리 총자산(약 236px) + 112 앰블럼은 390px에서도 한 줄에 못 들어가므로 휴대폰에서는 보통 아래 배치다.
      추정 폭으로 정하면 글꼴에 따라 '원'이 줄바꿈되거나 360px에서 빈 공간이 크게 생겼다(실측으로 교체한 이유).
17. **보유종목·포지션 통합 목록** (`orderHomeHoldings`, `HomeHoldings`)
    - 정렬 값: 현물 = 서버 `positionValueKrw`(available/stale_cache — 서버의 현물 정렬과 같은 기준), 선물 = 행이 보여주는
      Mark notional(신선할 때만) × 현재 USD/KRW. 환율은 지갑 환전과 같은 `/fx/rates/current` query key와
      `isPreviewFxAvailable` 검증을 재사용하고, 현물과 선물을 함께 보유할 때만 조회한다(validUntil+1s 재조회, 최대 5분).
    - 금액 큰 순, 같은 금액은 현물→선물·각 서버 순. 환율이 없으면 USD와 KRW를 비교하지 않는다: 평가된 현물 뒤에 선물
      (USD끼리 정렬) + 안내 문구. 금액을 표시하지 못하는 행(현물 평가 불가, Mark stale)은 맨 뒤 서버 순.
      notional은 순서만 정한다(총자산·증거금과 무관).
    - 접힘: 서버가 KRW 순으로 준 현물 1위(`limit: 1`)와 선물 전체(선물 API는 전체 반환) 중 최대 → 전체 최대와 같다.
      펼침: 기존 전체 현물 조회 + 선물. 현물·선물(혼합이면 환율까지) 응답 전에는 스켈레톤(부분 결과를 순위로 보이지 않음),
      한쪽 실패 시 다른 쪽 + 그 오류 상태. 계정별 key와 `tradingAccountId` 검사는 그대로(늦은 응답 격리).
    - '보유종목'/'포지션' 하위 제목 삭제(카드 제목은 유지), 행 UI·이동(현물 → 종목 상세, 선물 → Futures)·자세히/접기 유지.
18. **계정 카드 순위 삭제** — 순위 숫자와 '아직 표시할 랭킹 정보가 없습니다.' 삭제, 닉네임이 남는 폭 사용. 랭킹 조회는
    티어용으로 유지하고 조회 실패 안내(자체 진단 포함)는 남겼다.
19. **랭킹 수익률 글씨** — 앱의 다른 퍼센트(홈 HOT 등락률, 보유 수익률)와 같은 시스템 폰트·regular(400)·tabular-nums.
    18 크기와 상승/하락 색 정책 유지(이전 800 굵기 제거).
20. **내 티어카드 수익률 삭제** — '수익률' 라벨·숫자·chip 배경 삭제(티어 미상 일반 카드도 같다). 목록 수익률 유지.
21. **사용자 카드 앰블럼** — 오른쪽 [앰블럼][수익률 위/총자산 아래]. 380dp 이상 60, 미만 48, 카드 상하 패딩 7 →
    390px 한 줄 카드에서 앰블럼 높이/카드 높이 0.79–0.80, 360px 0.74–0.76. 티어 미상은 같은 크기 빈 슬롯.
    왼쪽(순위·프로필·이름) 기준 폭 106: 320px·글꼴 확대에서는 숫자 묶음이 다음 줄로, 그래도 좁으면 숫자가 앰블럼 아래로
    감긴다. 긴 값은 자기 줄 안에서 줄바꿈(앰블럼과 겹치지 않음). 순위 숫자는 줄지 않게 했다(긴 닉네임에서 잘리던 문제).
    360px에서는 이름 폭이 좁아 긴 닉네임이 여러 줄이 된다(80% 앰블럼과 두 숫자를 한 줄에 두는 대가).
22. **상위 랭커 삭제** — 카드 삭제. `limit: 3` publication 조회는 유지한다(모든 scope의 rankType/rankingDate/capturedAt
    pin, 내 순위, snapshot 변경 복구). 전체·친구·TOP10, 페이지네이션, 프로필 이동, 현재/최종 구분 유지.
23. **지정가 호가창** — 원인(실화면 재현): 지정가 매수에서 OrderPanel이 TP/SL 편집기 표시를 알리면 OrderScreen이 좁은
    화면(<600)에서 주문·호가를 세로로 쌓았다. 호가창은 렌더되지만 긴 폼 아래로 밀려(390px: y 170 → 901, 뷰포트 780 밖)
    사라진 것처럼 보였다. 수정: 모든 주문 유형에서 두 열 유지(편집기는 원래 세로 구성이라 주문 열에 들어간다),
    표시 신호·세로 스타일 제거. TP/SL·주문 정책·호가 구독/최신성·WebSocket 무변경.

### 보충 검증

- `npm run lint:accounts:check`, `lint:guides:check`, `typecheck`, `git diff --check`: PASS. 전체 `npm test`
  **2316 pass / 0 fail / 0 skip**. 신규 단위 테스트 `homePortfolio.test.ts`(합산 6종, 정렬·환율 4종·stale·tie·형식 오류),
  홈 통합 목록·환율 대기/실패·선물 대기, 앰블럼 크기, 지정가 두 열 회귀 테스트(수정 전 코드에서 실패 확인).
  바뀐 계약(순위·상위 랭커·수익률 chip)을 단언하던 기존 테스트는 같은 의미로 갱신(삭제·skip 없음).
- 하네스: 홈이 `features/wallet/api`를 읽어 `ledgerTestHarness`에 기본 USD/KRW mock, `homeDiscoveryHarness`에 제어용 mock 추가.
- Web/Android/iOS `expo export`: PASS. `test/browser/beginnerBrowser.cjs` 표준(19 layouts, 9 guided flows),
  `FULL_QUEST_BROWSER=1` 8개 거래 퀘스트(protection·limitBuy 포함), `QUEST_COMPACT=1`: PASS.
- 간헐 실패: 중간 전체 실행에서 `FuturesLimitEntry` 1건(실행마다 다른 케이스)이 실패했다. 변경 범위가 닿지 않는 화면이고
  단독 재실행 6회 중 4회 PASS, 같은 시간대 시계 프로브에서 −1.79s 역행을 관측(WSL 시계, 기존 분류와 같음). 최종 전체 실행 PASS.
- 실제 Web 렌더(Playwright, production navigator + fixture transport, scratchpad): 홈 36조합(320/360/390 × 글꼴 1/1.5/2 ×
  라이트/다크 × 일반/16자리 총자산) 앰블럼-총자산 겹침 0·순위 0·잘림 0, 평가손익 6사례, 통합 목록 6사례(혼합·선물 1위·
  환율 실패·현물만·선물만·없음) 순서와 이동. 랭킹 54조합 × 5행 겹침·잘림 0, 수익률 폰트=홈 퍼센트, 탭 3종, 50→53
  페이지네이션, 정산 상태. 주문 18조합에서 시장가/지정가 × 매수/매도 + TP/SL(손절 지정가+익절) 펼침 모두 호가창 위치
  동일·주문 옆·첫 화면, 입력 포커스 후 복귀, 호가 미지원(KRX)·호가 실패 상태·종목 전환.
- **NOT_RUN:** Android/iOS 실기기(소프트 키보드·native 글꼴 폭은 Web 렌더로 대체 불가). 호가 실시간 갱신은 이번 변경이
  닿지 않는 hook(기존 테스트)으로만 확인.
- 기존 문제(변경 전과 동일): 호가 사다리 수량 열이 320px·글꼴 확대에서 자기 칸을 넘는다(HEAD 비교 동일). 주문 입력
  열이 320px·2배 글꼴에서 좁은 것도 시장가와 같은 기존 폭이다.
