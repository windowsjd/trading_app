# 내 순위 티어 카드 — 엠블럼 스포트라이트 (2026-10-16)

## 의도와 범위

랭킹 탭 `내 순위` 카드(`MyStandingCard` → `TierCard`)의 티어 엠블럼에 무대 조명 같은 빛을 더한다.
위에서 내려오는 원뿔 빛줄기, 엠블럼 발밑의 타원 바닥 글로우, 천천히 떠오르는 입자 9개,
상위 티어의 아주 약한 떠 있음(bob), 그리고 처음 보일 때와 티어가 바뀔 때의 입장(drop-in)이다.
과하지 않고 고급스러운 인상을 목표로 한다.

- 시작 HEAD `c398d8af`, 작업 트리 clean. 커밋·push·배포 없음.
- **바뀌지 않는 것:** 카드의 모든 글자(문구·글꼴·색·위치·크기·줄바꿈)와 접근성 라벨·역할, 왼쪽 정보 열과 티어명 캡션.
  글자에는 애니메이션, 이동, 투명도, 래퍼, 어둡게 덮기가 없다. 배경 PNG·`TierCardBackground`·티어 팔레트,
  Home 카드, 랭킹 목록 행, 사용자 요약 화면, API·query key·rankType/시즌 로직, 백엔드도 그대로다.
- **이번에 하지 않은 것:** 승급·강등을 구분하는 연출(강등도 같은 입장을 쓴다), 마지막 티어의 저장(AsyncStorage), 햅틱,
  새 라이브러리(RN core `Animated`와 기존 `react-native-svg`만 사용), 비네트, 거울 반사, 글자 연출.

## 구조

| 파일 | 내용 |
| --- | --- |
| `src/screens/home/tierStage.ts` (신규) | 순수 로직: 티어별 빛(tint, heavy, bob 주기), 앵커(`emblemSlot`, `stageAnchor`), 레이어 기하(`stageGeometry`, `stageMotion`, `beamPoints`), CSS 곡선(cubic-bezier, 키프레임 샘플링), 루프 재개 위치, 입장 재생 판정과 프로세스 메모리 |
| `src/screens/home/TierCardStage.tsx` (신규) | `useTierStage`(측정·입장·루프·저모션), `TierCardStage`(효과 레이어) |
| `src/screens/home/TierCard.tsx` | opt-in `spotlight?: { context, paused }`. 없으면 JSX가 이전과 같다. 켜면 자신이 그리는 패딩을 효과에 넘긴다(카드 크기는 효과 루트가 잰다) |
| `src/screens/home/TierEmblem.tsx` | `tierEmblemVisibleBox()`(슬롯 안 보이는 실루엣 상자) 계산 함수만 추가(컴포넌트는 그대로) |
| `src/screens/ranking/RankingScreen.tsx` | `MyStandingCard`에만 `spotlight` 전달(`seasonId`, `focused`를 내려줌) |
| `src/theme/useReducedMotion.ts` | `useReducedMotionSettled()` 추가. `useReducedMotion()`의 반환은 그대로 |
| `test/interactionTestHarness.cjs`, `test/ledgerTestHarness.cjs` | 공용 저모션 mock에 `useReducedMotionSettled: () => true` 추가(기존 테스트 파일은 수정 없음) |

- 레이어 순서(아래→위): 배경 → **빛줄기(+플래시)** → **바닥 글로우** → **바닥 링(입장 중에만)** → **입자** → 엠블럼(입장·bob) → 왼쪽 정보 열과 캡션.
  `TierCardStage`는 카드의 절대 배치 자식으로 배경 바로 다음, 정보 열 앞에 그려진다. 카드의 `overflow: hidden`과 둥근 모서리가 모든 레이어를 자른다.
- 엠블럼은 `TierCard` 안에서 `Animated.View`로 감싼다(`key`는 티어 id만). 이 상자가 카드 안의 엠블럼이므로
  기존 `home-emblem-<tier>` testID와 숨김·터치 없음 속성을 그대로 가진다. 안쪽 `TierEmblem`에는 `tier-card-emblem`을 넘긴다.
  `ranking.test.ts`(id 1개)와 `RankingRows.test.ts`(엠블럼의 부모가 캡션이 있는 열) 단언이 이 구조로 수정 없이 통과한다.
- 효과 상태는 `TierCardBackground`의 `key={tier-mode}` 밖(`TierCard`의 훅)에 있어서 라이트/다크 전환에 다시 시작하지 않는다.

## 레이어와 수치

디자인 기준은 카드 폭 358, 엠블럼 한 변 132다. 앱은 실제 엠블럼 크기 E(360dp 이상 124, 미만 104)로 `k = E / 132`를 곱한다.
모든 레이어의 위치 기준은 **앵커 하나**, 카드 좌표계에서 화면에 보이는 엠블럼의 (cx, cy, visibleBottom)이다(아래 [앵커와 흔들림 축](#앵커와-흔들림-축-2026-10-16-후속-수정)).

| 레이어 | 수치 |
| --- | --- |
| 빛줄기 | 폭 260k, 가로 중심선 = cx, 카드 위에서 시작. 가로 배치는 카드 전체 높이, stacked(fontScale > 1.3)는 보이는 하단 + 0.6E까지. 사다리꼴(카드 윗변에서 38–62%, 끝에서 0–100%, `preserveAspectRatio="none"`). 세로 그라디언트 0% → .3(52%) → 0(100%), 시작 알파는 어두운 면(Dark, Whale) .78, 밝은 면 .88(아래 '시안과의 차이' 1). **엠블럼 중심 (cx, cy)를 축으로** −3.5°↔+3.5°, 한 방향 7초 ease-in-out 왕복(2026-10-16 후속: 축을 카드 윗변 가운데에서 옮겼다). 상자는 카드 윗변보다 조금 위에서 시작하고 카드가 자른다 |
| 플래시 | 같은 사다리꼴, tint를 흰색 쪽으로 75% 섞은 색. 입장 시작부터 opacity .55 → 0, 0.9초 ease-out |
| 바닥 글로우 | 180k × 26k 타원, 가로 cx, 세로 중심 = 보이는 하단 − 8k. 방사 그라디언트 중심 tint α(heavy .7 / 아니면 .85) → 70%에서 투명(CSS farthest-corner 기준: SVG r = √½). 4.5초 주기 opacity .75→1→.75, scaleX 1→1.08→1, ease-in-out |
| 바닥 링 | 글로우와 같은 타원의 2k 테두리(tint α .9). 0.38초 지연 후 0.9초 ease-out, scale .25→1.7, opacity .95→0. 지연 동안은 작은 링이 보인다(시안 60ms 프레임과 같음). 끝나면 그리지 않는다 |
| 입자 9개 | (cx, cy)에서 표의 오프셋(디자인 px)×k, 흰 점(지름 2–3k)과 tint 후광(점 지름의 4배, 방사 그라디언트 α .55 → 0). linear 반복, (0,0) → (dx·k, −120k), opacity 0 → .95(15%) → .5(80%) → 0. 첫 반복 전에만 delay |
| bob | platinum·diamond 4.6초, whale 5.5초. translateY 0→−6k→0, rotate 0→1.2°→0, ease-in-out |
| 입장 | 0.85초, 키프레임 0%(−96k, ×1.25, 투명) → 52%(+6k, ×.97, 불투명) → 72%(−5k, ×1.01) → 100%. 구간마다 `cubic-bezier(.3,.9,.4,1)` |

- 이징은 CSS 정의 그대로 순수 함수로 계산한다(ease-in-out = `cubic-bezier(.42,0,.58,1)`, ease-out = `cubic-bezier(0,0,.58,1)`).
  루프 값은 0→1 linear 위상이고, 이징은 `interpolate`의 샘플 점(구간당 16점)에 넣는다. 그래서 native driver가 그대로 돌리고,
  포커스를 잃었다 돌아오면 멈춘 위상에서 이어 간다(`loopPosition`). 입장은 키프레임 번호 0→3을 한 번의 timing으로 움직이고,
  구간별 이징을 합친 easing(`dropEasing`)을 쓴다. native driver는 easing을 60fps 프레임 표로 미리 계산하므로 곡선이 그대로 간다.
- 모든 애니메이션: `useNativeDriver: Platform.OS !== 'web'`, `isInteraction: false`(무한 루프가 InteractionManager를 막지 않게).
  SVG 속성은 애니메이션하지 않고 정적 SVG를 `Animated.View`의 transform/opacity로 움직인다.
- 시안의 드롭 위치와 맞춰 봤다. Gold 프레임을 템플릿 매칭한 엠블럼 이동량(200/330/420/520/700ms에 −5, +5, +6, −4, −1px)이
  이 곡선(−4.9, +4.9, +6.0, −3.9, −1.0)과 0.5px 안에서 같다(단위 테스트로 고정).

## 앵커와 흔들림 축 (2026-10-16 후속 수정)

사용자 측정(Gold Light, 390dp, 카드 폭 약 360): 빛줄기 윗부분 중심이 엠블럼 검은 원판 중심(약 280, 86)보다 약 30px 왼쪽, 바닥 글로우 중심이
스펙보다 약 23px 아래(캡션 줄). 같은 계열의 어긋남이 모든 티어·모드·폭에 있었다(아래 측정).

### 원인

1. **기준점을 onLayout x/y로 조립했다.** 기준점 = 열의 onLayout(x, y, 카드 기준) + 엠블럼 상자의 onLayout(x, y, 열 기준) + 슬롯 중심.
   부모 기준은 맞았다(카드 → 열 → 상자, 변환 전 값). 문제는 **RN-Web의 onLayout이 ResizeObserver라서 크기가 바뀔 때만 다시 잰다**는 점이다.
   카드가 열을 옮기기만 하면(열 크기는 그대로) 예전 x/y가 남는다. native(Fabric)는 위치만 바뀌어도 onLayout을 보내므로 이 경로로는 틀리지 않는다.
   - 첫 레이아웃은 카드 폭 state가 0이라 minHeight가 없고 패딩이 최소값이다. 그때 잰 열 y가 남아서, 웹에서 그대로 열어도
     390dp에서 글로우·입자가 스펙보다 9.7–25.0px **위**에 있었다(Whale은 위쪽 패딩도 달라 25px).
   - 첫 레이아웃 뒤 폭이 바뀌면(360 → 390) 열이 29.5px 오른쪽으로 가도 기준점은 그대로라 빛줄기·글로우가 29.5px **왼쪽**에 남는다(사용자 측정과 같은 값).
     프로필이 늦게 오면(320dp) 카드가 커져 열이 내려가도 기준점은 그대로라 글로우가 15–35px 위에 남는다.
     사용자 화면의 '23px 아래'는 첫 레이아웃의 카드가 최종보다 컸던 경우로, 같은 원인의 반대 방향이다(이 값 자체는 재현하지 않았다).
2. **흔들림 축이 카드 윗변 가운데였다.** 빛줄기 중심선은 (cx, 0)을 지나서, ±3.5°에서는 엠블럼 높이의 중심선이 cy·tan 3.5° ≈ 5–7px 비켜 간다(측정 5.1–7.5px).
3. 원인이 아닌 것: 슬롯 중심과 보이는 실루엣 중심은 현재 에셋에서 같다(`preparation.json`이 슬롯을 실루엣 가운데에 맞춰 두었다. Whale만 가로 0.12px).
   캡션 높이는 기준점에 섞이지 않았다(슬롯 높이와 보이는 하단만 썼다).

### 앵커 정의

- **앵커 = 카드 좌표계에서 화면에 보이는 엠블럼의 (cx, cy, visibleBottom).** 모든 레이어가 이 하나에서 나온다.
  빛줄기 가로 중심선 = cx, 흔들림 축 = (cx, cy), 바닥 글로우 중심 = (cx, visibleBottom − 8k), 링 = 글로우와 같은 타원, 입자 = (cx, cy) + 오프셋 × k.
- **실루엣(슬롯 안):** `tierEmblemVisibleBox(tier, E)`. `preparation.json`의 alpha bounds(임계 8)를 TierEmblem이 캔버스를 놓는 기하
  (`imageAt160`, Whale은 슬롯 = 캔버스)와 `EMBLEM_OPTICAL_SCALE`로 슬롯 안에 놓은 상자다. cx·cy는 그 중심, visibleBottom은 아래 변이다.
  슬롯 상자나 이미지 캔버스의 중심이 아니다. 티어마다 비율이 달라도(Diamond는 넓고 Whale은 높다) 같은 식이다.
  보이는 하단은 alpha > 8의 마지막 행이라 밑 장식의 뾰족한 끝이다. Gold(E 124)는 마지막 약 8px가 폭 17px에서 0으로 좁아지므로
  눈으로 잡는 하단보다 약 7px 아래다. 390dp 픽스처의 Gold에서 보이는 하단은 157.0, 글로우 중심은 149.5다.
- **슬롯 위치(카드 안):** `emblemSlot()`. TierCard의 레이아웃 규칙을 **크기만으로** 계산한다. 가로 배치는 열이 오른쪽 패딩에 붙고
  위·아래 패딩 사이 가운데, stacked는 위 패딩에서 시작하는 첫 줄이다. 슬롯은 열의 맨 위, 가로 가운데에 있다. 입력은 카드 크기,
  TierCard가 실제로 그리는 패딩, 열 크기(onLayout)뿐이다. onLayout의 x/y는 쓰지 않고, 엠블럼 상자의 onLayout은 없앴다.
  TierCard 스타일이 이 규칙과 같은지는 단위 테스트가 고정한다.
- **카드 크기는 효과 루트(`tier-stage`)의 onLayout으로 잰다.** 카드를 덮는 inset 0 레이어이고 자기 패딩이 없다.
  RN-Web의 ResizeObserver는 content box를 보므로, 카드 자신은 패딩만 커질 때(폭이 정해진 뒤 Whale의 위 패딩 14 → 27.3) 다시 보고되지 않는다.
  처음 이 수정을 카드 자신의 onLayout으로 했을 때 Whale 320dp 가로 배치에서 글로우·입자가 6.7px 위에 남았고, 브라우저 검사가 잡았다.
  효과 루트는 카드 크기가 바뀌면 항상 같이 바뀐다. 그래서 효과 루트는 측정 전에도 그리고(빈 레이어), 레이어는 카드와 열을 잰 뒤에 그린다.
- 단위 테스트에서 TierEmblem이 렌더한 `home-tier-image` 노드의 스타일 + alpha bounds가 이 상자와 같고(오차 1e-9),
  브라우저에서 렌더된 이미지 사각형 + PNG에서 다시 읽은 alpha bounds가 앵커와 1px 안에서 같다(아래 검증).

### 흔들림 축: 카드 윗변 → 엠블럼 중심

- `transformOrigin`을 `'top'`에서 엠블럼 중심으로 옮겼다(빛줄기 상자 기준 `[130k, over + cy, 0]`). 흔들리는 동안에도 엠블럼이 중심선 위에 있다.
  폭, 사다리꼴 비율, 그라디언트, 각도(±3.5°), 속도(한 방향 7초)는 그대로다.
- 축이 아래로 내려가면 윗변 모서리 하나가 카드 윗변 아래로 내려온다. 그래서 상자를 카드 윗변보다 `over`만큼 위에서 시작한다.
  `over = ⌈(cy·(1 − cos 3.5°) + 0.12·폭·sin 3.5°) / cos 3.5°⌉ + 1`(390dp에서 3px)이고, 카드 위로 넘친 부분은 카드의 `overflow: hidden`이 자른다.
  사다리꼴과 그라디언트는 카드 안 구간에 고정했다. `viewBox="0 −e 100 100+e"`(e = over/길이 × 100), 옆변을 같은 기울기로 연장(`beamPoints(e)`),
  그라디언트는 `gradientUnits="userSpaceOnUse"`의 y 0 → 100(카드 위 부분은 시작 색)이다. 0°에서 카드 안의 모양·폭·알파는 이전과 같다.

## 입장 재생 규칙

모듈 수준 메모리 `presented = { tier, context }`(앱 프로세스 동안 유지, `tierStage.ts`)로 판정한다.

| 상황 | 판정 |
| --- | --- |
| 프로세스에서 처음 보임(탭 포커스 + 티어 확정) | 재생 |
| 같은 맥락에서 티어가 바뀜(승급·강등 모두) | 재생 |
| 맥락이 바뀜(다른 시즌, daily → final, 다른 계정) | 재생하지 않고 티어·맥락만 조용히 갱신 |
| 같은 티어로 다시 포커스, 화면 다시 마운트, 라이트/다크, 글꼴 크기, 같은 티어의 순위·수익률 변화 | 재생 안 함 |

- **맥락 키 = `seasonId|rankType|seasonParticipantId`.** 내 순위의 티어는 `topQuery` publication
  (`ranking.list({ scope: 'all', seasonId, rankType: daily|final, limit: 3 })`)의 `myRanking`을 `getRankingTier(ranking, rankType)`로
  읽는다(daily: provisionalTier, final: finalTier). 그래서 데이터 선택은 시즌과 rankType이다. 같은 선택 안에서는 60초 재조회,
  당겨서 새로고침, 새 rankingDate/capturedAt publication으로 티어가 바뀔 수 있고, 이것이 실제 승급·강등이므로 재생한다.
  rankingDate·capturedAt은 넣지 않았다. 넣으면 같은 시즌의 매일 갱신이 모두 맥락 전환이 되어 진짜 티어 변화가 묻힌다.
  `seasonParticipantId`는 같은 프로세스에서 다른 계정으로 로그인했을 때 앞 계정의 티어와 비교해 가짜 '승급'이 재생되지 않게 넣었다.
- **재생 여부는 애니메이션이 실제로 시작될 때만 소모한다.** 입장이 남은 상태(`play`)에서 화면이 포커스를 잃었거나 OS 설정이
  아직 확정되지 않았으면 기다린다. 저모션이면 재생하지 않고, 소모하지도 않는다. 입장 도중 포커스를 잃거나 저모션이 켜지면
  즉시 최종 상태로 놓고 다시 재생하지 않는다.
- **첫 프레임:** 입장이 남은 티어의 엠블럼 값은 처음부터 드롭 시작 상태(투명)로 만든다. 그래서 최종 위치에 보였다가 시작
  위치로 튀는 프레임이 없다. 티어가 바뀌면 그 티어의 값과 상자(`key`)를 새로 만든다.

## 저모션·포커스·접근성

- `useReducedMotion()`은 OS 답을 받기 전에 `true`(저모션)를 돌려준다. 그래서 `useReducedMotionSettled()`를 추가했다.
  OS 답(초기 읽기 또는 실시간 변경), 읽기 실패, matchMedia가 없는 웹에서 확정된다. 판단은 다음과 같다.
  - 확정 전에 입장이 남아 있으면 엠블럼은 숨긴 채 기다린다(루프·입장 없음).
  - 확정되어 저모션이면 엠블럼을 최종 상태로 즉시 보인다(숨긴 채 남지 않음, 입장 없음).
  - 확정되어 저모션이 아니면 입장을 시작 상태부터 재생한다.
- 저모션 표시는 각도 0의 빛줄기와 고정 opacity(.875, 펄스의 가운데)의 바닥 글로우뿐이다. 입자, 링, 플래시, bob, 입장이 모두 없다.
- 탭 포커스(`RankingScreen`의 `useIsFocused`)를 `spotlight.paused`로 받는다. 포커스를 잃으면 루프를 멈추고, 돌아오면
  멈춘 위상에서 이어 간다. 언마운트하면 모든 애니메이션을 멈춘다. 앱 백그라운드(AppState) 정지는 넣지 않았다(선택 사항).
- 효과 레이어 전체와 엠블럼 상자는 `pointerEvents="none"`이고 스크린리더에서 숨는다
  (`accessible={false}`, `accessibilityElementsHidden`, `importantForAccessibility="no-hide-descendants"`, `aria-hidden`).
  `ranking-my-card`, `ranking-my-tier`, `home-emblem-<tier>`, `home-tier-image`, `home-tier-background-*` 등 기존 id와 라벨·역할은 그대로다.
- 티어가 없거나 알 수 없으면(`getHomeTier`가 null) 지금처럼 일반 카드이고 효과도 없다.

## 시안과의 차이

기준 이미지 2장(`REF-steady-6tiers-light-dark.png`, `REF-entrance-gold-light.png`)과 같은 조건(카드 폭 358, DPR 2, 왼쪽 30% 제외)으로 찍어
나란히 비교했다. 시안의 거울 반사·비네트·왼쪽 큰 숫자와 글자 연출(60ms 프레임에서 글자가 흐리다)은 비교에서 뺐다.
아래 1–3은 프롬프트가 허용한 차이이고, 4–7은 남은 차이다.

1. **합성(허용, 알파 조정 보고):** 시안의 `mix-blend-mode: screen` 대신 일반 알파로 합성한다. 밝은 면에서는 알파가 screen보다 덜 밝힌다.
   배경보다 어두운 tint 채널이 오히려 어둡게 만들기 때문이다. 빛줄기 위쪽 세 지점에서 그림 대비 밝기 증가를 재면,
   조정 전 Light(Bronze–Diamond)는 시안의 74–100%(평균 약 87%, Diamond가 가장 약함)였고, Dark·Whale은 83–113%(대부분 95–100%)였다.
   그래서 **밝은 면(Light, Whale 제외)만 시작 알파를 .78 → .88(+0.1, 허용 상한)** 으로 올렸다. 조정 후 Light는 Bronze 94–106%,
   Silver 107–114%, Gold 97–101%, Platinum 89–100%, Diamond 83–87%다. Dark·Whale은 바꾸지 않았다.
   색감은 screen만큼 하얗지 않다(알파로는 맞출 수 없는 차이). 참고로 RN 0.83 타입에는 `mixBlendMode`가 있다(New Architecture).
   프롬프트에 따라 쓰지 않았고, 네이티브·웹 지원은 확인하지 않았다.
2. **글린트 생략(허용):** 같은 이미지를 흰 tintColor로 같은 슬롯에 겹치고 정점 opacity .28로 구현해 비교했다. 정점에서 Gold·Silver의
   검은 원판이 회색으로 뜨고 엠블럼 전체가 뿌옇게 보였다. 시안의 brightness(1.35)는 어두운 곳을 그대로 두고 밝은 곳만 올린다.
   흰 덮개는 반대로 어두운 곳을 올려서 납작한 흰 실루엣이 된다. 그래서 프롬프트에 따라 글린트만 생략했다
   (`TierEmblem` 컴포넌트에도 prop을 남기지 않았다). 근거 캡처: `artifacts/home-tier-card-spotlight-2026-10-16/glint-rejected.jpg`.
3. **그림자 없음(허용):** drop-shadow는 RN에서 엠블럼 모양을 따르지 않아 넣지 않았다.
4. **바닥 글로우 높이:** 시안의 글로우 중심은 엠블럼 하단보다 Light 약 5–7px, Dark 약 11–13px **아래**에 있다. 시안에서 Dark 엠블럼이
   6px 높게 그려졌는데 글로우는 카드 기준 같은 높이(≈156)에 있다. 이 구현은 프롬프트 수치(보이는 하단 − 8k, 위)를 따른다(테스트로 고정).
   앱은 엠블럼 바로 아래에 티어명 캡션이 있어서, 시안 위치로 내리면 글로우가 캡션 글자 바로 뒤에 깔린다.
   (후속) 처음 적은 '앱의 글로우는 엠블럼 아래쪽 뒤에 일부 가려진다'는 관찰의 상당 부분은 앵커 버그였다(웹에서 글로우가 스펙보다 9.7–25px 위).
   수정 후 글로우 중심은 실루엣 마지막 행(밑 장식 끝)에서 8k 위에 있고, 끝이 좁아지는 티어에서는 장식 끝 양옆으로 퍼져 보인다.
   캡션 대비는 HEAD와 같거나 높다(캡션 최저 4.69:1, HEAD 4.63).
5. **플래시 곡선:** 시안은 빛줄기 밝기 2.4→1에서 채널이 포화되어 약 0.33초까지 하얗게 유지되다가 줄어든다
   (파랑 채널은 ~330ms, 초록은 ~700ms까지 포화로 측정). 이 구현은 프롬프트대로 opacity .55→0 ease-out이라 시작부터 옅어진다.
   시작 시각은 시안과 같다(드롭과 동시. 착지 시점이 아니라 0ms부터 밝다).
6. **엠블럼 크기·위치:** 시안은 엠블럼 실루엣을 132 상자에 최대 변 기준으로 맞췄다. 앱은 기존 `TierEmblem`(같은 면적 + optical scale, E=124)이고
   카드 레이아웃(정보 열, 캡션)도 다르다. 그래서 엠블럼 중심이 시안보다 오른쪽·아래에 있다(Gold 390dp: 시안 (268.4, 87.5) → 앱 (279.0, 93.6)).
   효과는 엠블럼 기준이라 같이 따라간다. 다만 k = E/132로 줄인 효과 대비 엠블럼 비율은 티어마다 다르다.
   시안 대비 앱 실루엣 폭은 Bronze 0.93, Silver 0.94, Gold 0.99, Platinum 1.03, Diamond 1.15배다.
7. **입자 시점:** 정지 캡처는 시작 후 3초다. 입자는 첫 delay(0–5초)가 지난 것부터 보이므로, 시안 캡처와 보이는 입자 수·위치가 다를 수 있다.

## 검증

### 단위 테스트 (`src/screens/home/tierStage.test.ts`, 신규 31개)

- 티어별 빛: 6티어 × Light/Dark의 tint·heavy·bob 주기, 알 수 없는 id(`master`, `grandmaster`, `__proto__` 등)는 효과 없음.
- 시안 기하: E=132에서 빛줄기 폭 260(가로 배치는 카드 전체, stacked는 하단 + 79.2), 글로우 180×26·중심 = 보이는 하단 − 8,
  링 두께 2, 입자 9개의 오프셋·크기·dx·상승 120·주기·delay, bob 6/1.2°, 드롭 −96/+6/−5·×1.25/.97/1.01, 시간 상수(링 지연 .38s 등).
  E=124·104에서 길이만 k배이고 시간·각도는 그대로다. 보이는 하단은 alpha bounds로 따로 계산한 값과 같다.
- 곡선: CSS cubic-bezier, 시안 Gold 프레임과 드롭 위치(±0.5px), 키프레임 통과 시각, 흔들림·펄스·입자 키프레임, 빛줄기 그라디언트(밝은 면 .88/어두운 면 .78), 루프 재개 위치.
- 입장 판정 표: 최초 → 재생, 같은 티어 재진입 → 미재생, 같은 맥락 티어 변경(승급·강등) → 재생, 맥락 전환 → 미재생 + 갱신, 테스트용 초기화.
- OS 저모션 확정: native 읽기 전/후, 읽기 실패, 실시간 변경, 웹(media query 있음/없음).
- TierCard(공용 interaction harness): spotlight를 끄면 효과·이동 상자·핸들러가 없고 엠블럼 열이 이전과 같다.
  기존 id가 유지되고 효과 레이어와 엠블럼 상자가 터치·스크린리더에서 숨는다. 레이어 순서와 측정 기반 위치(가로·stacked)를 본다.
  저모션이면 루프·입장·입자·링·플래시·bob이 없다. OS 확정 전에는 숨긴 채 기다린다(이후 저모션이면 최종 상태, 아니면 시작 상태부터).
  입장 타이밍·이징·isInteraction도 본다. 포커스·리마운트·라이트/다크·글꼴에 재생하지 않고, 같은 맥락의 승급·강등은 재생하며
  맥락 전환은 재생하지 않는다. 포커스 이탈 시 대기·즉시 정착, 루프 정지와 위상 재개, 언마운트 정리를 본다.
  bob은 상위 3티어만이고, 글린트 사본은 없다.
- 글자 불변(실제 `RankingScreen`): 6티어 × Light/Dark와 Gold Dark 2배 글꼴에서 spotlight를 켜고 끈 렌더를 비교한다.
  비교 대상은 왼쪽 정보 열과 티어명 캡션의 host 트리(타입·id·평탄화한 스타일·속성·글자)와 카드까지의 조상 사슬이다.
  해시가 같고, 글자와 카드 사이에 Animated/opacity/transform 조상이 없다. 알 수 없는 티어는 일반 카드이고 효과가 없다.
  큰 객체는 단언에 넣지 않았다(해시·boolean·짧은 문자열만).
- 변이 확인 11개(모두 실패 확인 후 원복): 탭 포커스마다 재생, 라이트/다크에 재생(두 방식), 저모션인데 루프 시작,
  효과 레이어 스크린리더 노출, 엠블럼 상자 노출, 맥락 전환에 재생, 정보 열에 opacity·내부 래퍼·Animated 래퍼, 캡션 래퍼.
- 기존 `ranking.test.ts`, `RankingRows.test.ts`, `RankingInsightSlot.test.ts`, `rankingPublication.test.ts`, `tierAssets.test.ts`,
  `homeTier.test.ts`, `useReducedMotion.test.ts`, `secondaryDiagnostics.test.ts`, `pressFeedback.test.ts`는 수정 없이 통과한다.

### 전체 검사와 export

- `npm run check`: PASS. accounts·guides lint 경고 0, typecheck, 테스트 2,815개 / 326 suites, 실패·취소·skip 0(약 8분 22초, heap 3GB·40분 제한). 마지막 테스트 파일 수정 뒤 typecheck·해당 파일(31/31)·변이 확인을 다시 실행했다.
- `npm run export:web`: PASS(웹 번들에 효과 레이어 포함 확인).
- `npx expo export --platform android`(scratchpad 출력): PASS(Hermes 번들에 `tier-stage-*` 포함). 번들 생성만이며 기기 실행이 아니다.

### 브라우저 (RN-Web, Chromium headless shell 1243, Playwright fake clock)

`test/browser/rankingSpotlightBrowser.cjs`(신규)와 `rankingSpotlightFixture.jsx`(탭 포커스를 검사가 쥔다)를 쓴다.
모든 화면은 포커스 직전에 시계를 멈추고, 포커스 순간을 입장 0ms로 둔다.

| 검사 | 결과 |
| --- | --- |
| HEAD 사본(`c398d8af`)과 레이아웃 비교 | 48개(6티어 × Light/Dark × 320/390dp × 글꼴 1/2배), 카드 크기·모든 글자 상자·아바타·엠블럼 슬롯·이미지·티어명 차이 0 |
| 가로 넘침 / 카드 밖 픽셀 | 0 / 0 of 434,992(카드 둥근 가장자리 안티앨리어싱 1.5px 제외) |
| 글자 대비(효과 3초 시점, HEAD와 같은 방법) | 정보 열 336개 중 9개만 0.02 이상 변함, 최저 4.37:1 = HEAD(Platinum Dark 320 닉네임, 기존 값). 가장 큰 하락은 Silver Dark 320dp 총자산 10.98 → 9.28:1. 캡션 최저 4.69:1(HEAD 5.11, Whale Light 2배) |
| 저모션(`reducedMotion: 'reduce'`) | 12개 카드: 빛줄기·글로우만, 각도·엠블럼 변환 없음, 2.5초 동안 픽셀 불변 |
| 입장 프레임 | 12개(6티어 × Light/Dark, 390dp): 60/200/330/420/520/700/1000ms의 드롭 위치가 곡선과 일치(16ms 프레임 범위 ±0.6px), 1.3초에 링·플래시 없음·최종 상태 |
| 재생 안 함 | 포커스 이탈 → 복귀, Dark → Light 전환 후 최종 상태 유지, 링 없음 |

- 대비 하락 판단: 빛줄기의 아래쪽 왼편이 320dp(E=104)에서 총자산 끝자리 뒤에 걸린다. stacked에서는 캡션 아래까지 내려온다(프롬프트 수치).
  하락 폭이 작고 모든 글자가 기준을 지키므로(기존 미달 1건은 변화 없음) 아래쪽 폭을 줄이지 않았다.
  필요하면 `BEAM_POINTS`의 아래 꼭짓점만 바꾸면 된다.
- 기존 `rankingTierBrowser.cjs`는 페이지를 연 직후 엠블럼을 재기 때문에, 입장 도중에 재면 'emblem cut'이 났다(stacked 복원 대조군).
  그래서 이 검사의 페이지를 `reducedMotion: 'reduce'`로 연다. 정지 빛줄기·글로우 위에서 기존 레이아웃·대비 검사를 그대로 한다.
  quick 실행 PASS: 14 layouts / 56 rows, 내 행 112, 내 순위 대비 48장 최저 5.41:1, 순위 안내 슬롯 8.
- 캡처를 직접 열어 확인했다: 바닥 글로우와 엠블럼 접지, 라이트 모드 빛줄기 세기, 왼쪽 글자 대비, stacked·104dp, 저모션, 입장 프레임.

증거 폴더 [home-tier-card-spotlight-2026-10-16](artifacts/home-tier-card-spotlight-2026-10-16/verification.json):
[정지 상태 시안 비교](artifacts/home-tier-card-spotlight-2026-10-16/steady-vs-mockup.jpg),
[Gold Light 입장 시안 비교](artifacts/home-tier-card-spotlight-2026-10-16/entrance-gold-light-vs-mockup.jpg),
[Diamond Dark 입장](artifacts/home-tier-card-spotlight-2026-10-16/entrance-diamond-dark.jpg) /
[Whale Dark 입장](artifacts/home-tier-card-spotlight-2026-10-16/entrance-whale-dark.jpg),
[320dp stacked·104](artifacts/home-tier-card-spotlight-2026-10-16/narrow-320-stacked-and-104.jpg),
[저모션](artifacts/home-tier-card-spotlight-2026-10-16/reduced-motion.jpg),
[글린트 기각 근거](artifacts/home-tier-card-spotlight-2026-10-16/glint-rejected.jpg).
모든 캡처는 실제 Web 렌더다(Android/iOS 캡처가 아님).

### 앵커 후속 검증 (2026-10-16)

**이전 검사가 못 잡은 이유.** 단위 테스트는 onLayout을 최종값 한 벌로 동시에 넣었고, 기대값도 구현과 같은 식(열 x/y + 상자 x/y + 슬롯 중심)으로
계산했다. 구현을 그대로 다시 계산한 셈이라, RN-Web처럼 위치가 늦게(또는 아예) 오지 않는 순서는 시험하지 않았다. 브라우저 검사는
HEAD 대비 레이아웃·대비·카드 밖 픽셀·입장 포즈만 봤고, 빛 레이어와 렌더된 엠블럼의 위치 관계는 재지 않았다. 흔들림은 0°에 가까운
3초 캡처만 봐서 축 문제(±3.5°에서 5–7px)가 드러나지 않았다. 육안 확인에서 본 '글로우가 엠블럼 뒤에 일부 가려진다'는 스펙 탓으로 해석했다.

**단위 테스트**(`tierStage.test.ts`, 39개 PASS). 바뀐 것과 추가한 것:
- 순수 기하: 슬롯 중심과 보이는 실루엣 중심이 다른 입력(슬롯 중심 270, 실루엣 중심 250)에서 빛줄기·축·글로우·입자가 실루엣을 따른다.
  6티어 × E 104/124 × 가로/stacked에서 빛줄기 중심선 x = cx, 축 = (cx, cy), 글로우 = (cx, visibleBottom − 8k)(1px 안, 실제로는 1e-9).
  ±3.5°로 돌려도 엠블럼 중심이 중심선 위(1e-9)이고 윗변 모서리가 카드 윗변 위에 있다. 카드 안 사다리꼴(38·62% → 0·100%)은 그대로다.
- 교차 확인: TierEmblem이 렌더한 `home-tier-image` 노드 스타일 + alpha bounds = `tierEmblemVisibleBox`(6티어 × 104/124/132, 1e-9).
- TierCard(harness, RN-Web식 onLayout): 열의 x/y를 엉뚱한 값으로 줘도, 열 이벤트 없이 카드만 커져도, 효과 루트만 새 크기를 보고해도(패딩만 증가)
  레이어가 렌더된 스타일의 패딩과 크기로 계산한 실루엣을 따른다. 실루엣을 슬롯 중심에서 비켜 놓은 TierEmblem으로 바꿔도 따른다.
  그라디언트는 `userSpaceOnUse` y 0 → 100, `viewBox`·폴리곤은 연장분과 맞는다. TierCard 스타일이 슬롯 규칙의 전제(가로: row·center·정보 열 flex 1·열이 마지막,
  stacked: column·stretch·열이 처음, 열: center·엠블럼 상자가 처음)와 같다. 6티어 × E 104/124 × 글꼴 1/2배 렌더도 본다.
- 글자 불변 테스트는 수정 없이 같은 조건이 되도록 켜고 끈 렌더 모두 카드에 같은 onLayout을 준다(해시 비교 PASS).

**브라우저**(신규 `test/browser/rankingSpotlightAnchorBrowser.cjs`, 실제 RankingScreen, fake clock). 엠블럼 중심과 하단은 렌더된
`home-tier-image` 사각형(드롭·bob 변환을 빼고 잰 정지 위치)과 PNG에서 다시 읽은 alpha bounds(6티어 모두 `preparation.json`과 같음)로 구한다.
빛줄기 중심선은 변환 전 상자 + 계산된 transform·transform-origin으로 구한다. 허용오차 1px.

| 항목 | HEAD(`153062de`, 390·1배) | 수정 후 |
| --- | --- | --- |
| 범위 | 12 레이아웃 | 48 레이아웃(6티어 × Light/Dark × 320/390 × 글꼴 1/2배) × −3.5°/0°/+3.5° = 144 프레임 |
| 빛줄기 중심선 ↔ 엠블럼 중심 | 0°: 0.46–0.90px, ±3.5°: 5.1–7.5px | 최대 0.28px(측정 각도 −3.500…−3.498 / −0.026…0 / +3.498…+3.500°) |
| 글로우 중심 − (cx, 하단 − 8k) | x 0.46–0.87, y −9.7…−25.0px | x 최대 0.26, y 최대 0.44px |
| 입자(오프셋 × k) | 9.7–24.8px | 최대 0.50px |
| 0° 빛줄기 윗부분(픽셀, 빛만 켠 캡처 − 빛을 끈 캡처) | 0.13–1.00px | 최대 0.59px |
| 링(입장 0.6초) | — | 글로우와 같은 타원(0.5px 안) |
| 저모션(정지 빛줄기·글로우) | 글로우 y 390: −9.7…−25.0px, 320: Whale −13.7px(나머지 0.5px 안) | 12개 최대 0.44px |
| 레이아웃 이력: 360→390 / 390→360(Gold·Diamond·Whale) | 빛줄기 24.3–25.3 / 33.7–34.7px, 글로우 x −29.1…−29.5 / +30.0…+30.4px | 최대 0.27px |
| 레이아웃 이력: 320↔390(E 변경) / 늦게 온 프로필(320) | 빛줄기 3.5–5.7 / 3.6–4.3px, 글로우 y −12…+10 / −15…−35px | 최대 0.27px, 글로우 0.29px |

- 처음 수정은 카드 크기를 카드 자신의 onLayout으로 쟀다. 이때 Whale 320·1배에서 글로우·입자가 6.7px 위에 남아 81개가 실패했다(위 '앵커 정의' 참고).
  효과 루트로 재게 바꾼 뒤 전체가 통과했다.
- 효과 레이어는 계속 스크린리더에서 숨는다(`tier-stage`의 `aria-hidden`, 포커스 가능한 자식 없음. 모든 프레임에서 확인).

**변이 확인**(각각 적용 → 단위 + 브라우저(Gold·Whale, 390·1배, 이력 포함) → 원복):

| 변이 | 단위 | 브라우저 |
| --- | --- | --- |
| M1 앵커 가로를 슬롯 중심으로 되돌림 | 실패 1(실루엣을 슬롯에서 비켜 놓은 테스트) | 0 — 현재 에셋은 `preparation.json`이 슬롯을 실루엣 가운데에 맞춰 두어 차이가 Whale 0.12px뿐이다 |
| M2 열의 카드 안 위치(오프셋) 빼기 | 실패 4 | 328 |
| M3 예전 방식(열 onLayout x/y로 조립) | 실패 3 | 281(일반 로드의 y, 360↔390 이력) |
| M4 흔들림 축을 카드 윗변으로 되돌림 | 실패 6 | 22(±3.5° 중심선) |

**디버그 이미지**(엠블럼 중심 십자선 = 자홍, 빛줄기 중심선 = 청록, 글로우 중심과 세로축 = 노랑. 왼쪽부터 −3.5°, 0°, +3.5°, 390dp·1배.
−3.5°는 드롭이 끝난 두 번째 주기 시작에서 찍었다. 상위 세 티어는 bob 때문에 엠블럼이 십자선(정지 위치) 둘레로 조금 떠 있다):
[Gold Light](artifacts/home-tier-card-spotlight-2026-10-16/anchor-gold-light.jpg) /
[Gold Dark](artifacts/home-tier-card-spotlight-2026-10-16/anchor-gold-dark.jpg) /
[Diamond Light](artifacts/home-tier-card-spotlight-2026-10-16/anchor-diamond-light.jpg) /
[Diamond Dark](artifacts/home-tier-card-spotlight-2026-10-16/anchor-diamond-dark.jpg) /
[Whale Light](artifacts/home-tier-card-spotlight-2026-10-16/anchor-whale-light.jpg) /
[Whale Dark](artifacts/home-tier-card-spotlight-2026-10-16/anchor-whale-dark.jpg),
360→390 폭 변경 뒤 Gold Light [수정 전](artifacts/home-tier-card-spotlight-2026-10-16/anchor-gold-light-resized-360-390-before.jpg) /
[수정 후](artifacts/home-tier-card-spotlight-2026-10-16/anchor-gold-light-resized-360-390-after.jpg).
수치 전체: [anchor-verification.json](artifacts/home-tier-card-spotlight-2026-10-16/anchor-verification.json).

**불변 확인.** 기존 `rankingSpotlightBrowser.cjs`를 HEAD(`153062de`) 사본과 전체 실행했다: 48 레이아웃에서 카드 크기·모든 글자 상자·아바타·
엠블럼 슬롯·이미지·티어명 차이 0, 카드 밖 픽셀 변화 0, 대비 기준 유지(최저 4.37:1 = HEAD의 기존 값, 384개 중 55개가 0.02 이상 변함,
가장 큰 하락 Whale Light 320·2배 캡션 9.48 → 9.25), 저모션 12·입장 12·재생 안 함 3 PASS.
`npm run check`: PASS(lint 경고 0, typecheck, 테스트 2,836개 / 327 suites, 실패·취소·skip 0, 약 8분 38초).
기존 `rankingTierBrowser.cjs` quick: PASS(14 layouts / 56 rows, 내 행 112, 내 순위 대비 48장 최저 5.41:1, 순위 안내 슬롯 8).

### NOT_RUN

- iOS·Android 실기기/에뮬레이터(실행 도구 없음): 입장·루프 재생, 90/120Hz와 저사양 기기의 프레임 드롭.
  native driver에서 `transformOrigin`, `Animated.loop` 재개, 지연 timing 연결, react-native-svg의 Linear/RadialGradient·`stopOpacity`·
  `preserveAspectRatio="none"` 렌더, 카드 `overflow: hidden` + 둥근 모서리의 자식 자르기(Android)도 확인하지 못했다.
- VoiceOver/TalkBack 실제 음성(속성만 단위·브라우저로 확인).
- 앱 백그라운드(AppState) 정지는 구현하지 않았다(선택 사항). OS가 화면을 그리지 않는 동안의 native 루프 비용은 측정하지 않았다.
- Android 이미지 `tintColor`: 글린트를 생략해 쓰지 않는다(해당 없음).
- 기존 `rankingTierBrowser.cjs`의 전체(non-quick) 행렬: quick만 실행했다.
- (후속) 앵커·축 변경의 native 렌더: 숫자 배열 `transformOrigin`과 native driver 회전, react-native-svg의 음수 `viewBox`와
  `gradientUnits="userSpaceOnUse"`. 모두 RN-Web에서만 측정했다. native는 onLayout이 위치 변화에도 오므로 이전 방식도 위치가 맞았을 가능성이 높지만,
  축 문제(±3.5°에서 5–7px)는 플랫폼과 무관했다.

## 재실행

frontend에서 실행한다.

```sh
npm run check
npm run export:web
# HEAD 사본(비교 기준)과 브라우저 도구는 저장소 밖에 둔다.
git archive HEAD frontend/src | tar -x -C /path/to/head
NODE_PATH=/path/to/browser-tools/node_modules BROWSER_EXECUTABLE_PATH=/path/to/chrome-headless-shell \
  RANKING_SPOTLIGHT_BASELINE_SOURCE=/path/to/head/frontend RANKING_SPOTLIGHT_REFERENCE=/path/to/refs \
  node test/browser/rankingSpotlightBrowser.cjs
```

앵커 검사(기준 사본 필요 없음): `NODE_PATH=… BROWSER_EXECUTABLE_PATH=… SPOTLIGHT_ANCHOR_DEBUG=/path/to/sheets node test/browser/rankingSpotlightAnchorBrowser.cjs`.
`SPOTLIGHT_ANCHOR_QUICK=1`은 390dp·1배만, `SPOTLIGHT_ANCHOR_TIERS=gold,master`는 그 티어만, `SPOTLIGHT_ANCHOR_SOURCE`는 다른 트리(예: HEAD 사본)를 본다.

`RANKING_SPOTLIGHT_QUICK=1`은 390dp·1배 글꼴만 빠르게 본다(전체 검증을 대신하지 않는다). `RANKING_SPOTLIGHT_REFERENCE`가 있으면
시안과 나란히 놓은 `sheet-steady.png`, `sheet-entrance-gold-light.png`를 만든다. 기준 이미지는 저장소에 넣지 않았다.
