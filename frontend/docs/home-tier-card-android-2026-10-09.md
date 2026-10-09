# 홈 시즌 티어 카드 — Native 레이아웃 수정·최종 PNG 교체 (2026-10-09)

## 기능 구현 의도와 범위

Android에서 시즌 티어 카드가 비정상적으로 세로 확장되는 문제를 해결해 기존의
컴팩트한 정보 구조를 복구하고, 사용자가 제공한 최종 배경과 앰블럼 디자인을
원본 비율과 시각적 정체성을 유지하면서 적용한다.

시작 HEAD `017c221a`. 기존 backend 및 CI의 미커밋 변경은 보존했다.
제품 코드는 frontend 표시 계층 3개 파일과 이미지/메타데이터에 한정한다.
루트 HANDOVER는 사용자가 요청한 인수인계만 추가했다. 커밋·push·배포 없음.

## 확인한 원인과 한계

`AccountSwitcher`의 시즌 제목은 `homeTitle.flex = 1`을 상속하면서
`flexGrow = 0`, `flexShrink = 1`, `flexBasis = auto`를 덮어썼다.
설치된 RN 0.83.6의 `ReactCommon/yoga/yoga/node/Node.cpp::processFlexBasis()`는
Native 기본값에서 양수 flex + auto basis를 **0 basis**로 해석한다.
Web 기본값에서는 auto로 해석하므로 Web 결과만으로 이를 발견하기 어려웠다.

실제 컴포넌트의 스타일을 읽는 `test/native/homeTierYoga.cjs`로 이를 재현했다.
Native Yoga 3.2.1, 제목 측정 함수를 96×27dp로 통제한 390px 조건에서:

| 측정 | 수정 전 flex 조합 | 수정 후 |
| --- | ---: | ---: |
| 제목 너비×높이 | 0×216 | 96×27 |
| 제목·버튼 행 높이 | 216 | 44 |
| 같은 이전 스타일의 Web 기본값 | 96×27, 행 44 | — |

이 결과는 **Yoga 엔진 재현**이다. Android OS의 실제 fontScale·폰트 측정이나
사용자 실기기의 카드 전체 높이 측정값이 아니다. Android SDK/adb/에뮬레이터를
찾지 못해 Android/iOS 실기기 검증은 NOT_RUN이다.

원인 가설 판단:

- 세로 전환: 실제로 문제를 증폭한다. 직접 원인은 짧은 이름의 길이 자체가 아니라
  Native에서 제목 너비를 0으로 만드는 상속된 flex다. 큰 측정 높이가 이후
  `wrappedHeading`을 고정할 수 있었다.
- 중복 최소 높이: 확인했다. 세로 앰블럼 영역에 배경 전체 높이를 다시 주고 그 아래
  티어명/사용자 정보를 더했다. 이 최소 높이를 제거했다.
- 배경 연장: 기존 1px scanline 연장은 이미 커진 카드의 빈 영역을 채우는 후속 동작이다.
  원본 비율 역전은 없었다. `TierCardBackground.tsx`의 원본/모서리/금속 띠 렌더러는 유지했다.

## 수정 방식

- 시즌 제목은 일반 제목 스타일과 별도로 선택해 양수 flex를 상속하지 않는다.
  실제 너비가 0인 중간 layout 이벤트는 줄바꿈 판정에 쓰지 않는다.
  실제 여러 줄 제목만 전환 대상으로 하며, viewport/계정/이름/글꼴 변경 시 판정이 갱신된다.
- 정상 모바일은 좌측 제목·버튼/프로필·닉네임·순위, 우측 앰블럼·티어명이다.
  열 간격을 4→1px로 조정해 390px Diamond의 `Season 1`과 44×44 버튼도 같은 행에 둔다.
- 긴 제목/확대 글꼴은 정보 다음에 앰블럼·티어명이 이어지는 세로 배치다.
  앰블럼 영역은 실제 앰블럼/문구 높이만 차지한다. 배경의 원본 비율 최소 높이는
  카드 전체에 한 번만 적용하며 고정 높이, 줄 수 제한, font scaling 제한은 없다.
- Whale은 카드 전체의 8% 상단 여백을 8dp로 줄이고, 제목 영역만 카드 폭의 6% 아래로
  배치해 밝은 상단 패싯을 피한다. 확대 문구가 다른 밝은 패싯과 만나는 경우에는
  작은 어두운 text shadow로 흰 글씨를 보호한다. Dark의 밝은 문구도 같은 처리를 하고,
  변경 아이콘에는 동일 색의 얇은 외곽선을 둔다. PNG 색/패싯/금속 반사는 바꾸지 않는다.
- 선택 계정/seasonId/query key/API/daily·provisional/final 정책은 수정하지 않았다.
  Home 전용 master→Whale, 일반 계정, Bottom Sheet, role/label, neutral/loading/error는 유지한다.

## 최종 에셋 매핑

배경은 `Tier_Backgrounds_12 (2).zip`의 원본 12개를 기존 경로에 그대로 적용했다.
아래 크기는 이전 파일과 동일하다. manifest에는 새 SHA-256을 기록했다.
Diamond/Whale 배경 4개는 제공 파일 자체가 기존 파일과 같으므로 Git binary diff가 없다.

| 티어 | Light / Dark 파일 | 크기 Light / Dark |
| --- | --- | --- |
| Bronze | `01_Bronze_Light.png` / `01_Bronze_Dark.png` | 538×322 / 538×322 |
| Silver | `02_Silver_Light.png` / `02_Silver_Dark.png` | 538×318 / 538×318 |
| Gold | `03_Gold_Light.png` / `03_Gold_Dark.png` | 538×315 / 538×315 |
| Platinum | `04_Platinum_Light.png` / `04_Platinum_Dark.png` | 538×318 / 538×318 |
| Diamond | `05_Diamond_Light.png` / `05_Diamond_Dark.png` | 538×318 / 538×318 |
| Whale | `06_Whale_Light.png` / `06_Whale_Dark.png` | 848×533 / 849×530 |

| 표시 에셋 | 제공 원본 | 이전 가공 PNG → 최종 원본 크기 |
| --- | --- | --- |
| `home-tiers/bronze.png` | ZIP `Bronze_Balanced_Legs.png` | 530×560 → 1254×1254 |
| `home-tiers/silver.png` | ZIP `Silver_Balanced_Legs.png` | 537×537 → 1254×1254 |
| `home-tiers/gold.png` | ZIP `Gold_Balanced_Legs.png` | 572×559 → 1254×1254 |
| `home-tiers/platinum.png` | ZIP `Platinum_Balanced_Legs.png` | 618×585 → 1254×1254 |
| `home-tiers/diamond.png` | 별도 `Diamond_Depth_Legs.png` (사용자 확인) | 685×560 → 1377×1142 |
| `home-tiers/whale.png` | 기존 파일 유지 | 580×518 → 동일 |

새 원본은 이전 **입력 원본**과 같은 크기이며, 저장소의 이전 **가공 결과물**과는
크기가 다르다. 새 파일에 이전 crop/리샘플/원형 보정을 다시 적용하지 않았다.
배경 12개+개미 5개는 제공 파일과 byte-identical이고 Whale PNG와 metadata도 HEAD와 같다.

투명 여백 때문에 단순 contain만 적용하면 앰블럼이 작아지므로 이전의 표시 슬롯,
가시 면적 목표(160 기준 128/129.28/130.56/131.84/133.12/134.4)와 optical scale을 유지했다.
`imageAt160`은 alpha>8 영역을 측정해 **원본 전체 캔버스를 등방 배율로 표시하는 좌표**다.
`scale = equivalentSize / sqrt(alphaArea)`, `left = (slotWidth - (leftBound + rightBound) * scale) / 2`
이며 세로도 동일하다. 이 과정에서 파일 픽셀을 편집하거나 비등방 보정하지 않는다.
기존 optical 배율 1/1.005/1.01/1.015/.985/1.065와 320px의 기존 132 기준도 그대로다.
오래된 `prepare-home-tier-assets.cjs`는 이전 승인된 가공 과정을 재현하는 스크립트이며,
이번 최종 원본에는 실행하지 않는다.

## 전후 실제 Web 치수

동일 Chromium·폰트·390px viewport·기본 글꼴·짧은 이름. 카드 폭은 모두 358px다.
Web은 원래 Native의 0 너비 문제를 재현하지 않았으므로 정상 Gold의 높이가 유지되는 것이 맞다.

| 티어 | 이전 높이 | 최종 높이 |
| --- | ---: | ---: |
| Bronze | 224.80 | 224.80 |
| Silver | 224.45 | 224.45 |
| Gold | 229.03 | 229.03 |
| Platinum | 229.03 | 229.03 |
| Diamond | 222.75 | 222.75 |
| Whale | 250.61 | 229.98 |

같은 390px·2배 글꼴·아주 긴 시즌명과 닉네임에서는 Gold 957.92→904.03,
Whale 991.53→926.45px다. 이 극단 조건의 높이는 감추지 않은 여러 줄 텍스트가 차지하며,
별도 앰블럼 최소 높이에 의한 빈 공간은 없다. 320/360/430px 전후 수치도 JSON에 보존한다.

## 검증 상태

- `npm run lint:accounts:check`: PASS, warnings 0.
- `npm run typecheck`: PASS.
- Home/AccountSwitcher/tradingAccount 관련 단위 테스트: **490 PASS, fail/skip/cancel 0**.
- Native Yoga: 320/360/390/430px × fontScale 1/1.5/2, **12 조건 PASS**.
  제어된 Text measure 사용. OS 텍스트/SVG/터치 검증으로 대체하지 않는다.
- 전체 tier Web: **588 records PASS, JavaScript 오류 0**.
  기본 504 layout과 status/선택 계정/늦은 응답/테마 전환을 검사했다.
  44px target, 전체 visible glyph bounds, 이미지 비율/가시 면적/클리핑,
  배경 원본·하단 금속 띠 비율과 실제 픽셀 대비를 검사한다.
- 대비 검사는 글자 fill만 투명하게 한 실제 underlay 캡처와 원래 캡처를 비교한다.
  명시적 text shadow는 유지되어 실제 글자 밑 배경을 측정한다. 작은 일반 굵기 한국어도
  실제 ink coverage 50% 이상 픽셀로 확인한다. 완전 불투명 픽셀이 없다는 이유로
  글자가 없다고 판정하지 않는다. 글자색과 배경의 대비 기준(큰 글씨 3, 작은 글씨 4.5)은 그대로다.
  CSS pre-wrap의 행 끝 공백이 0.78px 넘친 사례는 ink가 없음을 문자별 측정으로 확인했고,
  잘림 검사는 공백을 제외한 모든 단어/한국어 글리프를 계속 검사한다.
- Web Metro export: PASS. 최종 PNG들이 내용 해시가 붙은 asset으로 포함된다.
- 전체 `npm run check`: **최종 PASS — 2,044 tests, fail/cancel/skip 0**.
  첫 실행은 180초 제한으로 종료(1,870 pass / 1 fail / 16 cancelled)됐으며,
  별도 Futures request count assertion 1건도 기록됐다. 해당 파일 단독 58/58 PASS와
  프로세스 종료를 확인한 뒤, 충분한 600초 제한 아래 전체를 다시 실행해 통과했다.
  관련 없는 Futures 코드/테스트는 변경하지 않았다.
- Android Metro/Hermes export: PASS. Android 번들에 배경 12개+앰블럼 6개가 실제 원본 바이트로 포함됨을 확인했다. APK/기기 렌더 검증은 아니다.
- Android 실기기/에뮬레이터: **NOT_RUN**. iOS: **NOT_RUN**.
  사용자 실기기의 실제 fontScale/측정값/전후 캡처와 Native SVG·그림자 검증이 남는다.

## 변경 파일·자체 검토

제품: `AccountSwitcher.tsx`, `HomeAccountContext.tsx`, `TierEmblem.tsx`,
배경 PNG/manifest, 개미 PNG/preparation. 검증: `homeHeader.test.ts`,
`tierAssets.test.ts`, `test/browser/homeTierBrowser.cjs`, `test/native/homeTierYoga.cjs`.
문서: 이 문서, 기존 home-tier-card.md 최신 기록 링크, 루트 HANDOVER, 아래 증거 폴더.

전체 diff/3개 production 파일/최종 에셋 매핑을 재검토했다.
계정/시즌/랭킹 정책과 API 경로는 불변이다. 이미지 원본·Whale 보존을 독립 해시 검사로
확인했다. 변경 테스트는 ReactTestInstance를 null/undefined와 직접 비교하지 않으며
대형 객체 실패 출력을 추가하지 않았다. 필요한 검증을 삭제/skip하지 않았다.

## 증거와 재실행

증거 폴더: [home-tier-card-android-2026-10-09](artifacts/home-tier-card-android-2026-10-09/verification.json).
[에셋 무결성](artifacts/home-tier-card-android-2026-10-09/assets.json),
[Native Yoga 전후](artifacts/home-tier-card-android-2026-10-09/yoga.json),
[수정 전 Web 치수](artifacts/home-tier-card-android-2026-10-09/before-web.json),
[큰 글꼴 이전](artifacts/home-tier-card-android-2026-10-09/before-large-text.json) /
[이후](artifacts/home-tier-card-android-2026-10-09/after-large-text.json).

실제 Web 렌더 캡처 (Android 캡처가 아님):

- Gold [이전](artifacts/home-tier-card-android-2026-10-09/before-gold-light.png) / [이후](artifacts/home-tier-card-android-2026-10-09/gold-light.png)
- Diamond [이전](artifacts/home-tier-card-android-2026-10-09/before-diamond-light.png) / [이후](artifacts/home-tier-card-android-2026-10-09/diamond-light.png)
- Whale [이전](artifacts/home-tier-card-android-2026-10-09/before-whale-light.png) / [이후](artifacts/home-tier-card-android-2026-10-09/master-light.png)
- [6티어 Light](artifacts/home-tier-card-android-2026-10-09/tiers-light.png) / [Dark](artifacts/home-tier-card-android-2026-10-09/tiers-dark.png)
- [320px·2배 글꼴·긴 이름](artifacts/home-tier-card-android-2026-10-09/large-text-dark.png)

```sh
cd frontend
npm run lint:accounts:check
npm run typecheck
node --test --test-concurrency=1 'src/screens/home/*.test.ts' 'src/components/tradingAccount/*.test.ts' 'src/features/tradingAccount/*.test.ts'
# 진단용 Yoga는 /tmp에만 설치. 앱 dependency/lockfile 변경 없음.
YOGA_LAYOUT_MODULE=/path/to/yoga-layout/dist/src/index.js node test/native/homeTierYoga.cjs
NODE_PATH=/path/to/browser-tools/node_modules BROWSER_EXECUTABLE_PATH=/path/to/chromium node test/browser/homeTierBrowser.cjs
```
