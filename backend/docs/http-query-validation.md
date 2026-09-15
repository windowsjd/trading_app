# HTTP query runtime validation — 작업 4

## 기준과 실제 원인

시작 HEAD와 fetch 후 `origin/main`은 모두
`66046741761ffe190b782f74cb1162b85a11683a`였고 working tree는 clean이었다.
현재 main에서 작업하며 branch/worktree를 만들지 않는다. 원격 push, GitHub 변경,
Render 또는 운영 DB 접근은 하지 않는다.

Nest의 TypeScript query type은 런타임 검증이 아니다. 이 저장소에는 global
ValidationPipe 또는 DTO 변환이 없으며 class-validator/class-transformer도
사용하지 않는다. 설치된 Express 5.2.1의 기본 query parser는 `simple`이고,
bootstrap에서 이를 변경하지 않는다.

실제 AppModule HTTP 재현 결과:

| 요청 | 실제 query shape | 변경 전 | 변경 후 |
| --- | --- | --- | --- |
| `assets?limit=20&limit=30` | `{limit: ['20', '30']}` | 500 `INTERNAL_SERVER_ERROR` | 400 `INVALID_LIMIT` |
| `assets?limit[]=20` | `{'limit[]': '20'}` | 200, limit 기본값 50 | 400 `INVALID_LIMIT` |
| `assets?limit[x]=20` | `{'limit[x]': '20'}` | 200, limit 기본값 50 | 400 `INVALID_LIMIT` |
| `assets?withPrice=true&withPrice=false` | `{withPrice: ['true', 'false']}` | 200, 기본값 true | 400 `INVALID_WITH_PRICE` |
| `assets?assetType=crypto&assetType=us_stock` | `{assetType: ['crypto', 'us_stock']}` | 200, 필터 생략 | 400 `INVALID_ASSET_TYPE` |

숫자 parser의 `value.trim()`에서 TypeError가 발생한다는 가설은 맞았다.
하지만 bracket 표기가 현재 설정에서 곧바로 배열/객체가 된다는 가설은 달랐다.
또한 optional text helper는 이미 `typeof` guard가 있으나 non-string을
undefined로 처리하므로 잘못된 입력과 생략을 구분하지 못했다.
Rewards/Badges의 regex/Number 조합은 singleton array를 문자열/숫자로 coercion할
수 있다. Records.type, Ranking.rankType, legacy Portfolio.range의 optional
`value?.trim()`도 배열을 안전하게 처리하지 못한다.

## 조사 범위와 분류

19개 controller의 HTTP GET **26개 endpoint / 기존 @Query decorator 29개**를
조사했다. 아래 표는 모두 `/api/v1` 상대 경로다. 다중 값 계약은 발견하지 못했다.

- **B (취약): 24개 endpoint.** unchecked trim, regex/Number coercion 또는
  malformed 값을 optional/default로 버리는 경로가 있다.
- **A (값 shape에 안전): 2개 endpoint.** FX current-rate와 operator market-session
  override는 unknown/type/equality guard로 배열/객체 값을 기존 4xx로 거부한다.
  다만 simple parser의 bracket key는 서비스가 받는 필드에서 빠져 필터/기본값으로
  무시된다. 이 부분 때문에 두 endpoint에도 HTTP bracket 경계를 적용했다.
  기존 domain validation은 그대로 재사용한다.
- **C (미확정): 0개.** 실제 parser 설정과 HTTP 재현으로 확인했다.

| Endpoint | 입력 필드 | 시작 코드 분류 |
| --- | --- | --- |
| `assets` | assetType, currencyCode, market, search, includeInactive, withPrice, limit, offset | B |
| `assets/:assetId/candles` | interval, range, limit, date, to, includePrevious | B |
| `orders` | seasonId, status, side, assetId, limit, offset | B |
| `trading-accounts/:accountId/orders` | 같은 OrdersQuery | B |
| `wallets/transactions` | currency, direction, txType, limit, offset | B |
| `trading-accounts/:accountId/wallet-transactions` | 같은 WalletTransactionsQuery | B |
| `positions` | seasonId, includeClosed, assetType, currencyCode, assetId, limit, offset | B |
| `trading-accounts/:accountId/positions` | 같은 PositionsQuery | B |
| `fx/exchanges` | limit, offset | B |
| `trading-accounts/:accountId/fx/transactions` | limit, offset | B |
| `fx/rates/current` | baseCurrency, quoteCurrency, refresh | A |
| `portfolio/equity` | range | B |
| `trading-accounts/:accountId/portfolio/equity` | range, granularity | B |
| `seasons` | status, limit, offset | B |
| `ranking` | seasonId, rankingDate, rankType, capturedAt, scope, limit, offset | B |
| `records` | seasonId, type, currencyCode, limit, offset | B |
| `records/me/seasons` | seasonStatus, limit, offset | B |
| `records/me/seasons/:seasonId/equity` | limit, offset | B |
| `records/me/seasons/:seasonId/orders` | status, side, assetId, limit, offset | B |
| `records/me/seasons/:seasonId/exchanges` | fromCurrency, toCurrency, limit, offset | B |
| `rewards/me` | limit, offset | B |
| `badges/me` | limit, offset | B |
| `operator/reward-fulfillments` | status, seasonId, userId, seasonParticipantId, rewardCode, limit, offset | B |
| `operator/users` | role, status, search, limit, offset | B |
| `operator/market-session-overrides` | market, from, to, includeInactive | A |
| `trading-accounts/:accountId/ad-rewards/claims` | limit, offset | B |

`request.query`, `req.query`, URLSearchParams, query DTO, 정수/boolean/enum/date/text
helper도 검색했다. batch/CLI/env parser와 provider로 보내는 outbound URL query는
HTTP 수신 경계가 아니므로 변경하지 않았다. WebSocket URL token 처리는 별도
범위이며 손대지 않았다. query를 사용하지 않는 계좌/지갑/주문 detail 등도 변경 없다.

## 입력 경계와 API 계약

`ScalarQueryPipe`는 controller의 `@Query(...)`에 명시적으로 연결한다.
unknown query의 선언된 scalar 필드에 string 이외 값이 있으면 400으로 거부한다.
simple parser의 `field[]`/`field[x]`도 알려진 field의 malformed 표기로 거부한다.
extended parser의 실제 array/object도 거부하며, production parser 설정은 바꾸지 않는다.
알 수 없는 query key는 기존처럼 무시한다. 알려진 scalar의 첫/마지막 값을 고르거나
`String(value)`로 변환하지 않는다.

Pipe는 정상 string을 변경하지 않는다. 서비스의 기존 parser가 trim/case 정규화,
정수 형식, 안전한 정수 범위, enum/date/boolean 의미 및 기본값을 검증한다.
즉 `HTTP unknown → scalar shape 검증 → 기존 service parsing → business logic`이다.
정수 parser를 다시 구현하거나 모든 service helper를 통합하지 않았다.

각 controller는 기존 필드 오류 코드를 명시한다. `satisfies Record<keyof QueryType,
string>`으로 query type에 필드가 추가될 때 경계 선언 누락을 typecheck로 잡는다.
기존 오류 코드가 없던 자유 문자열 검색/ID 필드의 잘못된 shape에는 이미 전역
400 계약에 존재하는 `VALIDATION_ERROR`를 사용한다. 정상 문자열 ID의 도메인
조회/권한/404 의미는 바꾸지 않는다. malformed shape 오류 메시지는 필드명만
사용하며 입력 내용을 반사하지 않는다.

보존한 세부 의미:

- limit 생략과 잘못된 limit은 다르다. `limit=`는 기존대로 400이다.
- 음수, 소수, exponent, non-numeric, unsafe integer는 기존 코드의 400이다.
- **기존 상한 초과의 clamp는 유지한다.** Assets `limit=101`은 100으로 제한된다.
  요구사항의 숫자 예시를 이유로 이 정상 기존 계약을 400으로 바꾸지 않았다.
- 대다수 목록 기본값/max는 50/100, operator user/fulfillment는 20/100,
  Records season equity는 100/500, candle limit은 100/1000이다. offset 기본값은 0.
- 일반 목록은 정수 문자열 주변 공백을 trim한다. Rewards/Badges는 기존의
  공백 없는 digit-only 정수 계약을 유지한다.
- Assets의 blank optional text와 blank boolean은 기존처럼 생략/default 처리한다.
  scalar enum의 대소문자, FX currency의 대문자 정규화 등도 기존 service대로다.
- `withPrice=false`의 metadata-only 의미와 Assets의 account-neutral tradability는 유지한다.
- 인증 guard와 도메인 권한 검사는 유지한다. query 검증은 권한을 부여하지 않는다.
- 내부 TypeError/unknown exception은 계속 500 `INTERNAL_SERVER_ERROR`다.
  GlobalHttpExceptionFilter에 변경은 없다.

## 검증 결과

| 실행 | PASS | FAIL | SKIP |
| --- | ---: | ---: | ---: |
| 새 Pipe unit | 21 | 0 | 0 |
| Assets unit | 54 | 0 | 0 |
| Backend 전체 unit (위 75개 포함) | 2726 | 0 | 43 |
| HTTP query E2E 신규 검사 | 215 | 0 | 0 |
| 전체 release-critical E2E (위 215개 포함) | 341 | 0 | 0 |

전체 unit은 190 suite PASS / 39 opt-in suite SKIP이다. SKIP은 PASS로 세지 않았다.
기존 Orders/FX/Wallet/Position account-scoped controller/service contract,
Seasons/Records/Ranking/Rewards/Operator/Ad rewards 및 error-filter unit도 전체
suite에 포함했다. HTTP 검사는 real AppModule/guards/controllers/pipes/services/filter를
사용하고 Prisma/Redis 등 기존 E2E infrastructure mock만 재사용했다.
모든 query route에 대해 중복 scalar, bracket array, bracket object를 실제 URL로
요청한다. parser를 extended로 설정한 별도 테스트에서도 실제 배열/객체를 확인한다.
정상 Assets 기본값/조합/trim/clamp, malformed 숫자/enum/boolean, 진짜 내부 500과
인증 우선 처리도 검증했다. 기존 assertion은 삭제하거나 느슨하게 만들지 않았다.

```sh
# backend/
pnpm exec jest --runInBand src/common/scalar-query.pipe.spec.ts src/assets/assets.service.spec.ts
pnpm test --runInBand
pnpm run test:e2e --runInBand
pnpm run typecheck
pnpm run build
pnpm run lint:accounts:check
pnpm run lint:candles:check
pnpm run format:candles:check
# 새 Pipe/spec 및 변경 controller에 eslint --no-fix --max-warnings=0
# 위 파일과 E2E 파일에 prettier --check
git diff --check
```

모두 통과했다. HTTP socket이 필요한 E2E는 실행 가능한 로컬 환경에서 수행했다.
새 integration gate나 CI job, 테스트 skip은 추가하지 않았다.

## 시작 CI baseline과 미실행 항목

시작 SHA의 [CI run 34858247835](https://github.com/windowsjd/trading_app/actions/runs/34858247835)을
읽기 전용으로 확인했다. Backend quality, Frontend quality, Core account PostgreSQL,
Limit order PostgreSQL, Release-critical E2E는 성공했다.

Candle fixture job `104023334949`는 assertion 전에 clean-checkout 검사에서
exit 2로 실패했다. 로그의 원인은 "The working tree is dirty"이다. 추적된
Prisma generated inlineSchema의 이전 fee 주석과 현재 schema 주석 차이도 그대로
확인했다. 이는 작업 3 검토에서 재현한 기존 문제이며 이번 query diff와 무관하다.
생성 파일, schema, candle subsystem, clean guard는 수정하지 않았다.

이번 작업에서는 금융 PostgreSQL opt-in suite, candle fixture smoke, frontend suite를
재실행하지 않았다. service/transaction/DB/schema/frontend가 변경되지 않았고,
HTTP query 경계는 DB fixture만 호출하는 기존 금융 suite보다 실제 HTTP E2E로
검증한다. 관련 CI 목록을 확인하고 account-scoped contract unit을 모두 재실행했다.
원격 push/새 CI 실행 없이 시작 CI의 결과를 이번 변경의 PASS로 계산하지 않는다.

## 복잡도 및 diff 자체 검토

- 새 production 로직은 scalar shape를 검사하는 작은 Pipe 한 개다. 숫자/enum/date
  parser framework, validation dependency, DTO transformation은 도입하지 않았다.
- 변경은 19개 controller의 query decorator와 operator query 묶음 전달에 한정한다.
  별도 global pipe를 설치하지 않아 Body/Param/WebSocket 입력에 영향이 없다.
- 어떤 HTTP query도 TS annotation만 믿고 들어가지 않는다. HTTP 뒤의 service는
  검증된 문자열을 기존처럼 파싱한다. query가 아닌 CLI/env/body helper는 유지한다.
- 금융/시장/계좌 서비스, transactionNow/lock, fee pinning, reservation, matcher,
  TWR, season/general 권한, 작업 3 AssetsService/frontend capability는 변경 없다.
- DB schema/migration/generated/dependency/frontend/CI workflow diff는 없다.
- 정상 query 계약과 기존 error code는 유지한다. 의도적 변화는 malformed scalar의
  500/조용한 default/coercion을 명시적 400으로 바꾸는 것뿐이다.
- 가상트레이딩 앱에 필요한 수준이다. 서비스 parser 중복 제거를 위한 추가
  abstraction이나 API 전면 재작성은 하지 않았다.

변경 production 파일은 `src/common/scalar-query.pipe.ts`와 표의 endpoint를 가진
19개 `*.controller.ts`다. 테스트는 새 `src/common/scalar-query.pipe.spec.ts`와 기존
`test/app.e2e-spec.ts`에만 추가했다. 문서는 이 계약과 Assets API의 참조 링크다.
