# 홈 시즌 티어 카드 2차 리파인먼트 — 2026-10-07

## 인수인계와 구현 의도

완성 엠블럼의 존재감을 유지하면서 카드의 불필요한 공간을 줄였다. 티어별 배경색과
절제된 크기 상승으로 승급감을 보조하고, 사용자가 허용한 미세 비율 보정으로
주요 원형 테두리의 가로·세로 지름을 맞췄다. 랭킹·계정·시즌의 의미는 유지한다.

시작 HEAD는 `2694c3aec96a4ddaddf276f407d9b3db19499048`, 시작 working tree는 clean이었다.
모든 변경은 `frontend/`에 한정했다. 이 문서가 이번 작업의 frontend 인수인계 기록이다.
커밋·push·배포는 수행하지 않았다. 1차 작업의 이미지 증거는 기존 2026-10-06 폴더에 남아 있다.

## 실제 구조와 가설 검증

- `HomeAccountContext`가 `/me`와 **선택 계정 자신의 seasonId**에 대한 ranking을 조회한다.
- `AccountSwitcher`가 카드 외곽·제목·상태 안내와 기존 Bottom Sheet를 소유한다.
- 기존 배치는 제목 행 아래에서 프로필/순위와 132/160px 엠블럼이 시작하여,
  기본 390px 화면에서 카드 높이가 293px이었다.
- 기존 `TierEmblem`은 PNG 프레임, 생성된 개미 SVG, 별도 고래/파도를 합성했다.
  이번에는 사용자가 제공한 완성 PNG 6개로 교체하고 사용하지 않는 7개 파생 자산을 제거했다.
- Light/Dark 팔레트는 이미 별도로 존재했다. 새로운 전역 테마나 계산 계층 없이
  기존 Home 전용 팔레트의 배경/테두리/티어 색을 강화했다.
- 가설과 달리 원형 문제는 화면 비율만의 문제가 아니었다. 원본 내곽 테두리에
  약 0.3~2.8%의 축 비율 차이가 있었다. 사용자가 **“약한 비율 보정 허용”**으로 답한 후
  파생 자산에만 최소한의 보정을 적용했다.

## 레이아웃과 타이포그래피

`AccountSwitcher.homeVisual`이라는 선택적 표시 슬롯으로 왼쪽 제목/사용자 정보와
오른쪽 엠블럼을 같은 세로 공간에 배치했다. 공유 switcher는 티어/랭킹에 의존하지 않는다.
시즌 카드만 padding을 가로 12 / 세로 14px로 조정하고 기존 하단 16px 여백을 제거했다.
제목과 변경 버튼은 4px 간격의 상단 그룹이다. 공간이 부족하면 버튼을 같은 그룹의
다음 줄로 이동시켜 44×44px 터치 영역을 유지한다. 특히 320px와 넓은 Diamond 장식에서는
줄바꿈을 허용하며 글자를 자르거나 엠블럼을 작게 만들지 않는다.

fontScale > 1.3에서는 제목·사용자 정보 다음에 엠블럼을 세로로 배치한다.
카드 높이에 상한을 두지 않아 긴 Season 이름/닉네임/순위가 자연스럽게 늘어난다.
계정/시즌/참가자 상태 안내와 ranking loading/error/neutral 처리는 그대로다.

| 항목 | 이전 | 이후 |
| --- | --- | --- |
| 시즌명 | 16px / 600 | 18px / 800 |
| 시즌 닉네임 | 15px / 600 | 18px / 700 |
| 프로필 | 36px | 36px |
| 순위 | 20px, `#rank` | 20px, `#rank`, 티어 팔레트로 대비 확보 |
| 총자산 | 기존 HomeAssetHero | 변경 없음 |

일반 계정에는 엠블럼/티어 배경/순위를 추가하지 않았고 기존 typography/padding을 유지한다.
현재/최종 순위·등급 metric label도 추가하지 않았다. 현재/최종 의미는 접근성 label에 남는다.

### 같은 브라우저 조건에서 측정한 카드 높이

390px 화면, fontScale 1, 짧은 이름, Light/Dark에서 동일하다.
전/후 모두 같은 로컬 Chromium 및 맑은 고딕 폰트로 실제 production Home을 렌더했다.

| 티어 | 이전 px | 이후 px | 감소 |
| --- | ---: | ---: | ---: |
| Bronze | 293 | 224.48 | 23.4% |
| Silver | 293 | 223.33 | 23.8% |
| Gold | 293 | 227.06 | 22.5% |
| Platinum | 293 | 226.25 | 22.8% |
| Diamond | 293 | 224.91 | 23.2% |
| Whale | 293 | 221.64 | 24.4% |

320px에서는 265px → 193.53~236px다. Diamond의 제목/버튼/닉네임 줄바꿈으로
236px가 필요하지만 10.9% 감소한다. 확대 글꼴/긴 이름에는 이 높이 제한을 적용하지 않는다.
기본 모바일의 모든 티어가 이전보다 최소 10% 낮아지는 것을 browser assertion으로 검사한다.

## 완성 이미지 매핑과 보존

Home의 canonical `master`만 `Whale`/`whale.png`로 매핑한다. 다른 canonical 키는 동일하다.
제공 순서는 Bronze → Silver → Gold → Platinum → Diamond → Whale로 적용했다.

| 티어 | 제공 원본 | 원본 해상도 | alpha > 8 visible bounds [left, top, right, bottom] |
| --- | --- | --- | --- |
| Bronze | `청동 원형 엠블럼의 개미 실루엣.png` | 1254 × 1254 | `[101, 74, 1151, 1153]` |
| Silver | `실버 개미 엠블럼.png` | 1254 × 1254 | `[99, 77, 1155, 1118]` |
| Gold | `매끈해진 황금 개미 엠블럼.png` | 1254 × 1254 | `[66, 70, 1188, 1160]` |
| Platinum | `플래티넘 날개개미 엠블럼.png` | 1254 × 1254 | `[18, 66, 1237, 1202]` |
| Diamond | `장엄한 다이아몬드 여왕개미 엠블럼.png` | 1377 × 1142 | `[5, 53, 1368, 1132]` |
| Whale | `whale_emblem_stately_sapphire.png` | 1254 × 1254 | `[58, 138, 1197, 1144]` |

모두 RGBA/투명 배경이다. Diamond의 원본 aspect ratio는 1.205779, 나머지는 1이다.
`preparation.json`에 원본/출력 SHA-256, alpha 면적·무게중심, 원본/visible bounds,
crop 위치, 비율 보정, 출력 해상도, 원형 측정 및 표시 크기를 기록했다.
원본 파일은 Downloads에 보존했고 전처리 전후 원본 hash 일치를 확인했다.

alpha > 8로 여백을 판별한 뒤 12 source px의 주변 여유를 남긴다. 불투명한 장식은
잘리지 않는다. 매우 희미한 외부 stray pixel만 crop 밖으로 제외될 수 있다.
작품을 다시 그리거나 개미/고래/파도를 합성하지 않았다. 보정과 축소 과정의
보간은 premultiplied alpha로 처리하여 투명 가장자리에 검은 테두리가 생기지 않게 한다.
외부 이미지 다운로드, 이미지 생성, 새 앱 의존성 추가는 없다.

## 실제 크기 progression

기준은 canvas width나 장식의 최장 폭이 아니라 **alpha로 가중한 보이는 면적의 제곱근**이다.
면적 환산 크기를 128 × (1 + 티어 index × 0.01)로 설정했다.
인접 티어의 길이 환산 차이는 약 1%, 면적 차이는 약 2%다.
Whale은 Bronze보다 환산 크기 5%, 면적 10.25% 크다.

| 티어 | 표시 면적의 제곱근 px | 표시 면적 px² |
| --- | ---: | ---: |
| Bronze | 128.00 | 16384.00 |
| Silver | 129.28 | 16713.32 |
| Gold | 130.56 | 17045.91 |
| Platinum | 131.84 | 17381.79 |
| Diamond | 133.12 | 17720.93 |
| Whale | 134.40 | 18063.36 |

320px에서는 기존 132/160 배율을 그대로 곱한다. 큰 화면/확대 글꼴이라고 엠블럼을
계속 키우지는 않는다. 기존 Bronze 프레임의 면적 환산 크기는 126.75px, 새 이미지는
128px이며 보이는 세로 크기도 156.56px → 약 159.98px로 유지/증가했다.
다른 기존 프레임도 면적 기준으로 작아지지 않는다.

Diamond의 좌우 장식은 원래 넓기 때문에 **최장 가로 폭은 Diamond가 Whale보다 크다**.
모든 bbox 축까지 동시에 단조 증가시키려면 작품 형태를 바꾸거나 Whale을 과도하게 키워야 한다.
따라서 면적 기준을 일관되게 사용했다. 최종 PNG를 브라우저 canvas에서 다시 읽어
실제 표시 배율에 따른 면적을 측정했으며, 504개 조건에서 목표 환산 크기와의 차이는 0.03px 미만이다.
인접 티어의 주관적 체감은 첨부 contact sheet로 최종 디자인 판단할 수 있다.

## 원형 보정과 측정의 한계

주요 **내곽 원형 테두리의 하이라이트**를 원본 픽셀에서 추출하고 축에 정렬된 타원을
최소제곱으로 맞췄다. 아래 보석, 고래의 머리·꼬리처럼 테두리를 가리는 부분은 제외했다.
하나의 ellipse 보정을 양 축에 나누어 적용하여 면적을 보존한다 (`sx × sy = 1`).
실제 파생 PNG에서 같은 테두리 픽셀을 다시 측정하고 최대 8회 내에서 샘플링 편차를 보정한다.
매번 원본에서 새로 렌더하여 반복 리샘플링 손실을 피한다. 실제 보정은 축당 최대 약 1.43%다.

| 티어 | 원본 추정 지름 X×Y px | 보정 sx / sy | 앱 크기 환산 지름 X×Y px | 차이 px |
| --- | ---: | --- | ---: | ---: |
| Bronze | 785.12 × 763.23 | 0.985958 / 1.014242 | 113.066 × 113.048 | 0.017 |
| Silver | 755.27 × 743.83 | 0.992690 / 1.007364 | 113.445 × 113.429 | 0.016 |
| Gold | 756.59 × 754.13 | 0.997672 / 1.002333 | 112.193 × 112.197 | 0.004 |
| Platinum | 755.31 × 743.13 | 0.992918 / 1.007132 | 106.067 × 106.091 | 0.024 |
| Diamond | 720.57 × 700.40 | 0.985903 / 1.014299 | 104.177 × 104.093 | 0.083 |
| Whale | 781.39 × 778.39 | 0.995152 / 1.004871 | 120.843 × 120.780 | 0.063 |

전처리는 축당 보정 2% 초과 또는 최종 표시 지름 차이 0.1px 이상이면 실패한다.
앱은 파생 PNG의 고유 비율 그대로 `contain`으로 표시한다. 브라우저에서 실제 image rect,
natural size와 computed `background-size: contain`을 검사했다. 모든 화면/테마/글꼴에서
추가 비등방 스케일 없이 동일한 원형 비율이 유지된다. CSS rect의 1/64px 양자화도 계측했다.

**엄밀한 모든 픽셀의 eccentricity = 0을 증명한 것은 아니다.** 원본은 두께·질감·빛 반사가
있는 래스터 일러스트이며 모든 테두리 픽셀이 하나의 수학적 곡선 위에 있지 않다.
검증한 것은 지정한 주요 테두리의 추정 가로/세로 지름 차이 **최대 0.084 표시 px**와
렌더 단계의 등방성이다. 다른 장식 곡선의 완전한 정원성 및 Android/iOS 실제 래스터 결과는
보장하지 않는다. 엄밀한 벡터 정원이 필수라면 원본 프레임의 별도 디자인 수정이 필요하다.

## 팔레트와 가독성

| 티어 | Light 배경 | Dark 배경 |
| --- | --- | --- |
| Bronze | `#f1d8c6` | `#432c23` |
| Silver | `#dce2e8` | `#343c48` |
| Gold | `#f2e0ae` | `#44371e` |
| Platinum | `#c8e9e1` | `#173e3a` |
| Diamond | `#d1e4fc` | `#1b365c` |
| Whale | `#cbd7eb` | `#202d4b` |

기존 appearance 정책을 사용한다. Silver는 그래파이트 회색, Diamond는 파랑,
Platinum은 청록, Whale은 남청 계열로 구분했다. 순위도 기존 secondary 고정색 대신
티어 foreground를 사용하여 강화한 배경 위의 대비를 확보했다. 실제 카드 텍스트 최소
대비는 5.738:1이며 4.5:1 이상을 검사한다. 새 glow/particle/animation/gradient는 없다.

## 기존 동작과 데이터 경계

- 선택 계정은 TradingAccountContext, 시즌은 해당 계정의 seasonId다.
- active는 기존 daily/provisional 우선 정책, settled는 finalTier 정책을 유지한다.
  `getRankingTier`와 query key/API 호출은 바꾸지 않았다.
- 실 Bottom Sheet에서 active Whale → 과거 settled Diamond/#245 → general → active Whale/#2를 검증했다.
  과거 seasonId와 rankType=final 요청을 확인했다.
- 일반 계정의 무티어 UI, 계정 전환 후 새 ranking, 계정/시즌/참가자 상태 안내를 유지한다.
- loading/error/unknown/null/unavailable/not_joined/cached-error 상태의 neutral 처리도 유지한다.
- 다른 화면의 master 표시, ranking/settlement/reward/backend/DB/API `/api/v1`/주문/지갑은 변경하지 않았다.
- 장식 이미지는 접근성 트리에서 제외하고 티어 텍스트와 순위 label을 유지한다.
  계정 변경 button role/label 및 44px target도 유지한다.

## 주요 변경 파일

| 파일 | 역할 |
| --- | --- |
| `src/components/tradingAccount/AccountSwitcher.tsx` | Home 전용 visual 슬롯, 상단 그룹, 반응형 배치 |
| `src/screens/home/HomeAccountContext.tsx` | 기존 데이터 그대로 사용자/티어 표시 연결 |
| `src/screens/home/TierEmblem.tsx` | 완성 PNG 하나와 면적 기반 크기 |
| `src/screens/home/tierPresentation.ts` | Light/Dark 홈 티어 색상 |
| `src/assets/home-tiers/` | 완성 PNG 6개, 재현 가능한 측정 manifest |
| `scripts/prepare-home-tier-assets.cjs`, `scripts/home-tier-geometry.cjs` | 원본 보존, 미세 보정, crop/축소/크기 계산과 측정 |
| 관련 Home/Account/Ranking 테스트 및 test harness | 새로운 visual 슬롯/PNG JSON 로더와 기존 정책 회귀 |
| `test/browser/homeTierBrowser.cjs`, `homeBrowser.cjs` | 실 렌더 측정·before 비교·기존 홈 회귀 |

## 검증

| 검사 | 결과 |
| --- | --- |
| `npm run check` | PASS: accounts/guides lint + typecheck + 1,650 tests, 0 failures |
| `npm run export:web` | PASS: 완성 PNG 6개 포함 |
| 기존 Home tier baseline | PASS: 시작 HEAD 실제 173 기록, 전/후 조건 동일 |
| 최종 homeTierBrowser | PASS: 504 layout + 5 state/switch records, unknown 별도 검사 |
| 기존 homeBrowser | PASS: 244 layout/state + 전환/늦은 응답/저장/appearance |
| 자산 재생성/원본 hash/파생 hash | PASS: 동일 출력 재현, 원본 불변 |
| `git diff --check` 및 전체 자체 검토 | PASS |
| Web | Chromium / 실제 React Native Web, HTTP fixture |
| Android runtime / iOS runtime | NOT_RUN / NOT_RUN |

1차 문서에 적혀 있던 과거 탭 테스트 6개 실패는 이번 시작 HEAD의 최종 검사에서 발생하지 않았다.
브라우저 fontScale은 기존 RN Web adapter를 사용한다. 320/360/390/430/768/1280px,
fontScale 1/1.5/2, 긴/짧은 이름, Light/Dark를 모두 검사했다. 일반 Home 회귀 검사는
1920px까지 포함한다. clipped text, emblem overlap, 이미지 로드, 텍스트 대비,
최소 버튼 크기, 상단 엠블럼 위치, typography, 면적 progression 및 균일 스케일을 확인한다.
실제 Android/iOS 글꼴·이미지 래스터·VoiceOver/TalkBack은 기기 검토가 남는다.

전체 production 변경, test harness diff, 원본 순서/해시, 전처리 산출물과 Light/Dark
실제 캡처를 재검토했다. 데이터 조회/계산 및 Bottom Sheet 내용 변경은 없다.

## 증거와 재실행

- [이전 Light](artifacts/home-tier-card-2026-10-07/before-light.png)
- [최종 Light](artifacts/home-tier-card-2026-10-07/tiers-light.png)
- [최종 Dark](artifacts/home-tier-card-2026-10-07/tiers-dark.png)
- [홈 Whale 전체](artifacts/home-tier-card-2026-10-07/home-whale-light.png)
- [320px / 2배 글꼴 / 긴 이름](artifacts/home-tier-card-2026-10-07/large-text-dark.png)
- [브라우저 측정 요약](artifacts/home-tier-card-2026-10-07/verification.json)

frontend에서 실행:

```sh
node scripts/prepare-home-tier-assets.cjs /path/to/provided-images
npm run check
npm run export:web
NODE_PATH=/path/to/browser-tools/node_modules node test/browser/homeTierBrowser.cjs
NODE_PATH=/path/to/browser-tools/node_modules node test/browser/homeBrowser.cjs
```

선택적으로 `HOME_TIER_BASELINE_RESULTS=/path/to/baseline/results.json`을 지정하면
동일 조건의 기존 카드보다 최소 10% 낮은지도 검사한다. 브라우저 도구와 한글 폰트/필요한
Linux 라이브러리는 테스트 환경에만 둔다. 앱 package/lockfile에는 추가하지 않았다.
전체 상세 로그는 `/tmp/home-tier-*`, 전체 layout 기록은 `/tmp/home-tier-final/results.json`에 있다.
