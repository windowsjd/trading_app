# 홈 시즌 계정 카드 — 티어 엠블럼 (2026-10-06)

## 목적과 작업 기준

시즌 홈 카드의 정보 중심을 텍스트 지표에서 티어 엠블럼으로 이동했다.
사용자가 홈 진입 즉시 시즌 성취를 인지하도록 하면서 계정·랭킹 데이터 의미와
금융 앱의 차분한 카드 구조를 유지한다.

- 시작/종료 HEAD: `364493707f868a41eb68de236accc2c554810aff`
- 브랜치: `codex/fix-friends-profile-image-ci`, 시작 working tree clean.
- `git ls-remote origin refs/heads/main` 결과: `3acf7f7e1b09602120cc17fce8791d1a1c760bb3`.
  로컬 HEAD는 참고 main 이후의 홈 아이콘 변경을 포함했다.
- branch/worktree 생성, checkout/reset/rebase, commit/push/merge는 수행하지 않았다.
- 최종 전체 검사에는 시작 HEAD에서도 재현되는 기존 탭 테스트 실패 6개가 남는다.
  Android/iOS 실기기 검증은 NOT_RUN이다. 모든 완료 조건이 PASS인 것으로 해석하지 않는다.

## 실제 구조와 선택한 구현

예상과 같이 HomeAccountContext가 `/me`와 선택 계정 seasonId의 ranking을 조회하고,
AccountSwitcher가 카드 외곽·상태 안내·투자 계정 선택 Bottom Sheet를 소유한다.
테마는 AppearanceProvider와 theme/native의 semantic 색상 해석을 사용한다.
기존 벡터는 react-native-svg의 Svg/Path 방식이며 별도 공용 PNG registry는 없었다.
테스트는 Node의 TSX 로더, React renderer/QueryObserver, 외부 esbuild/Playwright harness다.

따라서 홈 내부에 작은 설정과 엠블럼 컴포넌트를 추가했다. 공유 AccountSwitcher에는
선택적인 `homeCardStyle`만 전달한다. 공유 컴포넌트가 ranking 도메인을 알거나
6개의 별도 카드 컴포넌트를 가지지 않는다. 새 앱 의존성이나 글로벌 테마 변경은 없다.

| 파일 | 역할 |
| --- | --- |
| `src/screens/home/HomeAccountContext.tsx` | 기존 조회 유지, 상태 판정, 프로필/순위와 엠블럼 배치 |
| `src/screens/home/tierPresentation.ts` | 홈 한정 canonical→표시명/visual id, Light/Dark 카드 색상 |
| `src/screens/home/TierEmblem.tsx` | 정적 frame import, 내부 좌표, 개미 SVG, 고래와 파도 |
| `src/components/tradingAccount/AccountSwitcher.tsx` | 시즌 카드 스타일 적용, 홈 변경 glyph, 기존 sheet/안내 유지 |
| `src/assets/home-tiers/` | 파생 PNG 7개와 원본 해시·크기·crop 기록 |
| `scripts/prepare-home-tier-assets.cjs` | 원본을 덮어쓰지 않는 재현 가능한 전처리 |
| `src/screens/home/homeTier.test.ts` | 프레임/명칭/일반 계정/상태/기존 tier 정책 회귀 |
| `test/browser/homeTierBrowser.cjs` | 실제 Home 렌더·가독성·계정 선택 시나리오와 캡처 |

기존 Home/Header/Layout/Ranking 소비자 테스트의 새 표시 기대값 및 PNG 호스트 경계도
갱신했다. `ranking.test.ts`는 MY에서 master가 그대로 남는 것도 확인한다.
Home를 import하는 기존 browser harness에는 필요한 PNG loader만 추가했다.

## 정보 위계와 상태

엠블럼 → 티어명 → 시즌명 → 프로필/닉네임 → `#순위` → 계정 변경 순으로 강조한다.
엠블럼 영역은 320px 화면에서 132px, 360px 이상에서 160px이다.
프로필은 36px을 유지하고, 시즌명/닉네임/순위는 자르지 않는다.
글꼴 배율이 1.3을 넘으면 엠블럼과 티어명 아래에 사용자 정보를 쌓는다.
기본 시즌 카드 높이는 약 266–294px이며 큰 글꼴·긴 텍스트에는 내용만큼 늘어난다.

- `현재/최종 순위`, `현재/최종 등급` metric header를 제거했다. 현재/최종 의미는
  순위의 접근성 label 및 기존 계정/시즌 상태 안내로 유지한다.
- 계정 변경은 양방향 화살표 SVG, 최소 44×44 target, button role 및 현재 계정·상태 label을 유지한다.
- 소유 계정 선택, 일반 투자 시작, 시즌 참가, 반환율 의미, 선택 정책, 상태 badge와 sheet 내용은 유지한다.
- 일반 계정은 기존 프로필 정보와 중립 카드만 표시한다. 홈 변경 버튼만 같은 아이콘을 사용한다.
- 로딩은 중립 원형과 `티어 확인 중`; 오류는 중립 원형과 `티어 확인 실패` 및 오류 안내다.
  오류에 캐시가 남아 있어도 정상 티어처럼 표시하지 않는다.
- null/알 수 없는 티어는 `티어 미정`, neutral 배경/테두리/도형을 쓴다.
  유효한 순위가 있으면 그대로 유지한다. unknown을 Bronze로 추정하지 않는다.
- response unavailable, myRanking unavailable/not_joined, 데이터 없음은 랭킹 없음 안내를 표시한다.
  시즌 자체가 없으면 기존 AccountSwitcher의 시즌 정보 안내를 유지한다.
- me 로딩/정보 없음은 기존 skeleton/안내를 유지한다. 티어의 유일한 전달 수단은 이미지가 아니며,
  장식 이미지/SVG는 접근성 트리에서 제외하고 티어명을 텍스트로 제공한다.

## 원본과 티어 구성

| 제품 티어 | canonical | 제공 원본 → 파생 frame |
| --- | --- | --- |
| Bronze | bronze | 단일 V형 하단 장식 청동 엠블럼.png → bronze-frame.png |
| Silver | silver | 스모키 젬 실버 랭크 엠블럼.png → silver-frame.png |
| Gold | gold | gold-frame-refined.png → gold-frame.png |
| Platinum | platinum | 청록빛 삼중 곡선 엠블럼.png → platinum-frame.png |
| Diamond | diamond | 빙결빛 다이아몬드 랭크 엠블럼.png → diamond-frame.png |
| Whale | master | whale-diamond-evolution.png → whale-frame.png |

고래 주체는 `청백색 바다의 혹등고래.png` → `whale-subject.png`이다.
Diamond 원본은 1377×1142, 나머지 6개는 1254×1254이다.
프레임은 모두 alpha가 있고 외부가 투명하다. Bronze~Diamond의 어두운 내부는
원본에 포함되어 있고, Whale 프레임의 내부는 투명하다. 고래 원본은 불투명 흰 배경이다.

원본 7개는 전달 위치에 보존했으며 전처리 전후 SHA-256 일치를 확인했다.
alpha>8의 visible bounds와 12px 여유를 기준으로 정사각 canvas에 비율을 유지해 배치하고
512×512 PNG로 축소했다. Diamond의 가로로 넓은 프레임 형태도 유지한다.
고래는 가장자리와 연결된 밝은 무채색 배경만 flood-fill로 제거했다. 전체 흰색 threshold로
복부를 지우지 않는다. 분리 이미지와 실제 Light/Dark 카드에서 복부·지느러미·외곽을 확인했다.
외부 이미지를 다운로드하거나 생성형 이미지로 대체하지 않았다.

같은 정면 자세, 더듬이, 6개 다리, 좁은 허리의 개미를 공유한다.
Bronze는 단순 실루엣, Silver는 절제된 등판/복부 선, Gold는 머리와 턱을 강화했다.
Platinum에는 몸통을 가리지 않는 좌우 날개를 추가했다. Diamond는 그 날개를 유지하면서
머리·등판·복부에 제한적인 결정 면을 넣었다. 최종 단계가 별개의 곤충이 되지 않게 했다.
고래는 원본을 재색칠하지 않고 작은 남청 원형 바탕 위에 배치한다. 하단 파도는
낮고 넓은 2개 Path로 고래를 받치며 프레임 장식이나 지느러미를 크게 가리지 않는다.

카드 색은 브론즈/쿨그레이/웜골드/민트청록/딥블루/심해네이비 순이다.
Light는 옅은 surface, Dark는 기존 화면에 연결되는 낮은 채도의 surface를 사용한다.
프레임보다 강한 glow, shadow, particle, animation이나 복잡한 gradient는 추가하지 않았다.

## 데이터 경계

`getHomeTier`의 `master → { id: whale, name: Whale }`만 홈 표시를 바꾼다.
일반 계정에는 호출 결과를 적용하지 않는다. Ranking/MY/Record/Reward의 제품 명칭과
backend canonical master, DB/API `/api/v1`, 계산/정산/보상/주문/지갑은 변경하지 않았다.

기존 `getRankingTier`는 수정하지 않았다. settled는 finalTier만 사용하고,
active daily는 provisionalTier 우선이며 기존 helper의 finalTier fallback도 보존한다.
선택 계정의 seasonId와 daily/final query key/요청을 유지한다. 현재 시즌을 암묵적으로 쓰지 않는다.
실제 sheet로 active Whale → 과거 settled Diamond/#245 → general → active Whale/#2를 확인했다.

## 검증 결과

| 검사 | 결과 |
| --- | --- |
| npm run lint:accounts:check | PASS |
| npm run lint:guides:check | PASS (check에 포함) |
| npm run typecheck | PASS |
| 관련 Home/계정 layout/Ranking tests | PASS |
| npm run check | **FAIL: 1,552 중 1,546 PASS / 기존 탭 테스트 6 FAIL** |
| npm run export:web | PASS; PNG 7개 실제 bundle 포함 |
| homeTierBrowser | PASS: 168 티어/테마/폭/글꼴 layout + 5 기록된 상태/전환 시나리오, unknown도 별도 검사 |
| homeBrowser | PASS: 244 layout/state + 전환/늦은 응답/저장/테마 |
| homeDiscoveryBrowser | PASS: 96 layout, HOT/보유 종목/실제 Market navigation |
| homeMarketBrowser | PASS: 96 Home/Market layout, 기간/툴팁/전환/정렬/페이지 |
| rootTabsBrowser | PASS: 756 layout + 96 Ranking 선택/발행 흐름 |
| git diff --check | PASS |
| Android runtime / iOS runtime | **NOT_RUN / NOT_RUN** |

기존 실패는 `src/components/navigation/TabBarButton.test.ts:81`의 3 플랫폼 × 2 계정 모드다.
기대값 `#aaa`와 실제 undefined가 다르다. 시작 HEAD를 `git archive`로 `/tmp/home-tier-baseline`에
추출해 같은 6개 실패(해당 파일 총 10개 중 4 PASS)를 재현했다. 홈 비활성 아이콘 색상용
기존 mock/기대값 문제이며 이번 작업에서 탭 구현이나 해당 테스트를 수정하지 않았다.
새 PNG import 때문에 드러난 테스트 loader 문제는 해결했다.

브라우저는 실제 React Native Web/SVG/이미지 렌더링이며 HTTP는 fixture다.
320/360/390/430px, fontScale 1/1.5/2, Light/Dark에서 카드 내 글자 bounds,
이미지 로드, 엠블럼과 글자 겹침 없음, 4.5:1 이상 텍스트 contrast, 44px target을 검사했다.
기존 Home harness는 768–1920px도 포함한다. Native 글꼴 실측/VoiceOver/TalkBack/기기별
SVG 렌더링은 확인하지 않았으므로 배포 전 기기 검토가 필요하다.

전체 diff, 신규 설정/컴포넌트/전처리/테스트, 7개 파생 asset과 6개 프레임 내부 렌더를
재검토했다. 소스 변경 범위는 frontend 및 요청한 루트 HANDOVER뿐이다.

## 시각 증거와 재실행

- [Light 전체 티어](artifacts/home-tier-card-2026-10-06/tiers-light.png)
- [Dark 전체 티어](artifacts/home-tier-card-2026-10-06/tiers-dark.png)
- [홈 전체 Whale](artifacts/home-tier-card-2026-10-06/home-whale-light.png)
- [320px / 글꼴 2배](artifacts/home-tier-card-2026-10-06/large-text-dark.png)

상세 명령은 `test/browser/README.md`, 원본 측정은 `src/assets/home-tiers/preparation.json` 참조.
임시 실행 로그는 `/tmp/home-tier-*.log`, tier 실측 결과는 `/tmp/trading-home-tiers/results.json`에 있다.
