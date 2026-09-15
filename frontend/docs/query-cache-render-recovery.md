# MY 크래시와 query cache / render 복구 검증

## 확인한 원인

로컬 설치 버전 `@tanstack/react-query 5.100.5`의 `QueryClient`, `QueryObserver`,
`InfiniteQueryObserver`로 재현했다. query cache는 query key의 hash로 항목을 찾으며,
일반 query와 infinite query를 자동으로 별도 저장하지 않는다.

수정 전 MY와 전적 목록은 둘 다 `['record', 'seasons', 20, 0]`을 사용했다.

- 전적 → MY: 전적이 저장한 `{ pages, pageParams }`를 MY가 일반 페이지로 읽고
  `recordsQuery.data.items.length`에서 `undefined.length`가 발생했다.
- MY → 전적: `{ items, pagination }`를 읽은 InfiniteQueryObserver가 다음 페이지 여부를
  계산하다 `pages.length`에서 같은 오류를 냈다. 화면의 optional chaining으로는 해결되지 않는다.
- 앱에는 이를 받아줄 React Error Boundary가 없었다.

초기 가설은 맞았다. 추가 확인 사항은 역방향에서도 충돌한다는 점,
랭킹·보유 종목에도 두 hook이 같은 factory를 사용하는 구조가 있다는 점이다.
랭킹·보유 종목은 **현재 인자로는 직접 충돌하지 않는다**.

`getMySeasonRecords()`는 서버의 `seasons`를 `items`로 정상 변환하고 pagination을 보존한다.
서버 `/records/me/seasons` 계약, mapper, `/api/v1` base path는 변경하지 않았다.
서버가 전체 참여 수를 `pagination.total`로 제공하므로 MY는 이를 표시한다.
기존 `items.length`는 첫 페이지의 최대 20개만 셌다.

## 전체 query 조사

`frontend/`의 query hook, QUERY_KEYS, 직접 cache read/write, fetch, invalidation,
reset, session clear 사용처를 조사했다. 현재 production hook은 일반 39곳, infinite 8곳이며,
수정 후 25개 key factory/상수를 사용한다.

| 영역 | 현재 사용/응답 | 판단 및 조치 |
| --- | --- | --- |
| 시즌 전적 목록 | MY 일반 페이지 / 전적 InfiniteData | 실제 동일 key 충돌. `record.infiniteSeasons` 분리 |
| 랭킹 목록 | Home·MY 일반 응답 / Ranking InfiniteData | 시즌 ID·rankType·limit이 달라 현재 충돌 없음. `ranking.infiniteList` 분리 |
| 계정 보유 종목 | Home·자산·주문 일반 응답 / Portfolio InfiniteData | preview limit·assetId·assetType 필터가 달라 현재 충돌 없음. `tradingAccount.infinitePositions` 분리 |
| 마켓 목록·검색 | 두 화면 모두 InfiniteData, 같은 getAssets | 검색/자산 필터가 key에 포함됨. 같은 조건의 cache 공유 유지 |
| 계정 지갑 거래·주문 내역, 시즌 환전 내역 | 각각 infinite만 사용 | accountId/seasonId, 필터, limit 포함. 변경 없음 |
| 계정 목록·상세·portfolio·지갑 | 일반 query, 동일 API/응답 | 사용자/계정 key 격리 유지 |
| 계정 equity | 일반 query | accountId, range, daily granularity 격리 유지 |
| 자산 상세·캔들 | 일반 query | assetId 및 캔들 range/interval/limit 격리 유지 |
| 현재 시즌 | 일반 query, 동일 getCurrentSeason | 정상 공유 유지 |
| 전적 상세·equity | 일반 query | seasonId 및 pagination 포함. 상세와 수익분석 화면의 동일 상세 공유 유지 |
| 유저 시즌 요약, FX rate, 보상·뱃지 | 각각 일반 query | 서로 다른 key/응답. 변경 없음 |
| me | 일반 query 및 로그인 시 초기 seed | 초기 AuthUser는 MeDto의 공통 필드 부분집합. 현재 reader는 id/nickname/email/role/status를 사용하므로 충돌 위험 없음. 기존 로그인 정책 유지 |

미사용 legacy factory는 그대로 두었다. 별도의 suspense query, query persistence,
여러 형태를 저장하는 다른 cache writer는 확인되지 않았다. 마켓 WebSocket은 query cache를
덮어쓰지 않고 별도 ticker store에서 동작한다.

## key 원칙과 기존 동작

일반 조회 key는 유지하고, 데이터 형태가 혼용된 세 리소스의 무한 조회에만 명시적인
`infinite*` factory와 마지막 `'infinite'` 토큰을 추가했다.

- 페이지: `['record', 'seasons', 20, 0]`
- 무한 목록: `['record', 'seasons', 20, 0, 'infinite']`

기존 factory를 재사용해 시즌·계정·필터 정규화를 그대로 보존한다.
`record.all`, `ranking.all`, `positionsAll(accountId)` prefix는 두 형태를 모두 대상으로 한다.
랭킹 snapshot 복구의 `exact: true` reset은 변경된 infinite key만 대상으로 한다.
로그인/로그아웃/만료 시 전체 session cache clear 정책도 그대로다.
탭 이동 시 clear·강제 refetch·일괄 unmount는 추가하지 않았다.

## Error Boundary 범위

`RootNavigator`의 `Stack.Navigator.screenLayout`에 `ScreenErrorBoundary`를 적용했다.
Splash/AuthStack/ModeSelection/MainTabs/SeasonJoin의 하위 render 오류를 받으며,
기존 `ErrorState`로 안내와 **화면 다시 열기** 버튼을 표시한다.
오류와 component stack은 console에 남긴다. 재시도해도 버그가 지속되면 오류 UI로 돌아온다.

NavigationContainer, root navigator, QueryClientProvider, SessionExpiryBridge,
TradingAccountProvider는 boundary 바깥에 유지한다. 따라서 예외 후에도 계정 선택과 캐시가
유지되고, session expiry가 Login으로 navigation reset을 할 수 있다.
MainTabs에서 오류가 나면 탭 subtree만 내려가고 재시도 시 기본 홈부터 다시 연다.
정상 탭 이동의 mounting/구독 정책은 변경하지 않았다.

앱 바깥을 통째로 감싸는 boundary보다 세션 처리와 navigation을 유지하기 쉽고,
각 화면에 개별 wrapper를 추가하지 않아도 되는 최소 범위다. React Query의 throwOnError나
인증 만료 동작을 변경하지 않았으며, 정상 API 오류는 각 화면 ErrorState가 처리한다.

## 검증 결과

- 수정 전 production screen을 사용하는 회귀 테스트에서 양방향 `undefined.length` 재현.
  동일 테스트는 수정 후 통과. 의도적으로 key를 공유하는 작은 재현 테스트도 보존했다.
- MY 직접 방문(참여 수 0/3/23), 양방향 방문, 전적↔MY 20회 반복, 캐시 shape 확인.
- offset 0 → 20 다음 페이지 요청, 20개 → 23개 표시, 마지막 hasNextPage=false 확인.
- 홈 → 마켓 → 랭킹 → 전적 → MY → 홈 20회 cache 수준 반복 확인.
  MY/전적은 실제 화면·mapper·query observer를 사용하고, 나머지 세 탭은 해당 query key와
  응답 형태의 fixture를 사용한다. 실제 native navigation / WebSocket E2E는 아니다.
- AST 회귀 검사: production의 39 useQuery + 8 useInfiniteQuery가 동일 factory를 혼용하면 실패.
- 동일 인자의 일반/infinite key 분리, 랭킹 시즌 격리, 계정 격리, mutation prefix,
  랭킹 exact reset, session clear 및 다음 사용자 seed 확인.
- 실제 React renderer에서 예외를 발생시켜 fallback / 재시도 / 지속 예외 확인.
  provider와 캐시 보존, 일반 API rejection 처리, 정상 화면과 fallback 상태 모두에서
  session expiry → cache clear → credential teardown → Login 경로 확인.
  native navigation과 storage는 테스트 대역을 사용하며, 실제 AppProviders와
  SessionExpiryBridge 및 root screenLayout을 실행한다.
- `npm run check`: gated lint + TypeScript + frontend 전체 **63개 테스트 파일 통과**.
  새 회귀 테스트는 **17개**(cache 9, key 조사 3, boundary 5).
- `npm run export:web`: 성공.
- `git diff --check`: 통과. 전체 diff와 새 파일을 다시 검토했다.

추가로 gate 밖의 변경 파일도 lint했다. RecordSeasonListScreen은 통과했고,
queryKeys(1개)·RankingScreen(6개)에서 기존 lint 오류가 나왔다.
`git show HEAD:<file>`의 수정 전 코드에 같은 lint를 적용해 동일한 7개 오류임을 확인했다.
이 작업과 무관한 기존 lint 부채는 변경하지 않았다.

## 변경 파일

| 파일 | 역할 |
| --- | --- |
| `src/constants/queryKeys.ts` | 세 리소스의 infinite key 분리 |
| `src/screens/record/RecordSeasonListScreen.tsx` | 전적 infinite key 사용 |
| `src/screens/ranking/RankingScreen.tsx` | 랭킹 infinite key 및 기존 reset 경로 연결 |
| `src/screens/home/PortfolioScreen.tsx` | 보유 종목 infinite key 사용 |
| `src/screens/my/MyScreen.tsx` | 전체 참여 수를 pagination.total로 표시 |
| `src/components/states/ScreenErrorBoundary.tsx` | render 예외 fallback/로그/재시도 |
| `src/app/navigation/RootNavigator.tsx` | root scene 단위 boundary 적용 |
| `test/recordCacheHarness.cjs` | 실제 화면·API mapper와 QueryObserver를 연결하는 테스트 대역 |
| `src/features/record/queryCache.test.ts` | 양방향 충돌, 반복 방문, pagination/count/session 회귀 |
| `src/constants/queryUsage.test.ts` | 전체 hook 조사 및 key/invalidation 격리 회귀 |
| `src/components/states/ScreenErrorBoundary.test.ts` | 실제 React render·복구·세션 만료 회귀 |
| `src/features/ranking/ranking.test.ts` | MY record fixture에 정상 pagination 계약 반영 |
| `package.json`, `package-lock.json` | React와 버전을 맞춘 테스트 전용 renderer, boundary 관련 lint gate |
| `docs/query-cache-render-recovery.md` | 조사·검증·남은 확인 사항 기록 |

## 남은 확인

실제 Chrome/Android 기기에서 전체 탭 navigation을 실행하지는 못했다. 웹 export와
위 cache/render 통합 검증을 완료했으며, 배포 전 실기기에서 반복 탭 이동·다음 페이지·재로그인을
확인해야 한다. Android 중단에 별도의 native 원인이 있는지는 이번 JS 재현만으로 확정할 수 없다.

Error Boundary는 하위 React render/lifecycle 예외를 받는다. native process crash,
이벤트 handler/비동기 예외, provider 자체 오류까지 복구하는 장치는 아니다.
실제 계정 provider·navigation 구현의 기존 동작은 변경하지 않았다.

공식 참고: [TanStack Infinite Queries](https://tanstack.com/query/latest/docs/framework/react/guides/infinite-queries),
[React Error Boundary](https://react.dev/reference/react/Component#catching-rendering-errors-with-an-error-boundary).
