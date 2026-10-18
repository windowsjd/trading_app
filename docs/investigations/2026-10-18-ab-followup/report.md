# Trading Class A·B 후속 보완 — 2026-10-18

기준 SHA: `4b376d2a40036a61faf50870e39390b68104473a`(작업 시작 원격 main과 로컬 HEAD 일치, clean).
완료 커밋 SHA와 push 결과는 최종 작업 보고를 따른다. 원격 main은 커밋 직전 다시 확인한다.

## 결과와 최소 변경

| 항목 | 상태 | 결과 |
| --- | --- | --- |
| Logo.dev 환경변수 | 수정 완료·검증 완료 | 공식 정적 dot 참조. production EAS 환경 명시. 현재 SDK의 기존 선택적 참조도 Babel release 테스트는 통과했으므로 실제 치환 장애 재현으로 보고하지 않음 |
| 로고 매핑·대체 | 검증 완료·변경 불필요 | 미국 ticker/BRK.B ISIN, 국내 보통주 ISIN, 무키 이니셜, `onError` 대체, 재사용 행의 다른 로고 재시도, 40dp 원/28dp contain/여백, 암호화폐 로컬 아이콘 유지 |
| 한국어명·검색·총자산 | 검증 완료·변경 불필요 | 기존 한국어 기본/영문 부제·시장 없는 심볼 추측 금지·식별자 보존, 30초 캐시·실패/재시도·늦은 응답·입력 유지, 확대 글꼴의 아래쪽 엠블럼 대체 배치 유지 |
| 호가 | 수정 완료·검증 완료 | 전용 Ask/Bid 역할만 빨강/파랑 고정. 서버 측 구분·정렬·수량·현재가 유지. 두 금융 설정·Light/Dark 대비 4.5:1 이상 테스트 |
| 선물 학습 거절 | 수정 완료·검증 완료 | 시장가/지정가/조건부 진입의 명확한 학습 403에 해당 계정 퀘스트를 invalidate. 기존 현물은 이미 처리하므로 테스트만 추가 |
| 서버 단계별 권한 | 검증 완료·변경 불필요 | 10개 퀘스트·증거·위험 축소·취소·멱등성 기준 유지. 백엔드 제품 코드 변경 없음 |
| 초보 성능 공백 | 검증 완료(소규모) | 별도 격리 프로파일 러너 추가. 기본 부하 테스트 beginner=0 유지 |
| B차 기타 UI | 검증 완료·변경 불필요 | 선물 목록 폭/선택/검색/정렬/요청, 미국 종가 날짜 제거, 빈 상태/오류/로딩 구분, 매도 예상 행 제거와 매수 행/수량 검증 유지 |

## Logo.dev·Expo

- `eas project:info --non-interactive`: `@mycroft7947/leagueoftrading`, 프로젝트 `ea6190e3-80cd-43df-a7b1-d2b780f05985`; 로컬 app.json과 일치.
- `eas env:exec preview|production` 안에서 공개 키 존재와 `pk_` 형식만 확인. 키 값/전체 환경/인증 URL은 로그나 저장소에 남기지 않았다. 실제 키로 번들을 만들지 않았다.
- `EXPO_NO_DOTENV=1`과 테스트 공개 값으로 `expo export --platform all --no-bytecode --max-workers 2` 실행. Android/iOS/Web JS 모두 테스트 값 포함, `EXPO_PUBLIC_LOGO_DEV_KEY` 미치환 참조 없음, `sk_` Secret Key 표식 없음. 이는 로컬 번들이며 EAS 클라우드 빌드가 아니다.
- 기존 release 변환 테스트는 빌드 시 값과 다른 런타임 미끼 값을 구분하고 무키 결과도 확인한다. 새 정적 문법 단언 추가.
- 실제 키의 CDN GET(Referer 없이 모바일 방식): 아래 6종목이 preview/production 양쪽에서 모두 PNG 200, 128×128. 직접 이미지를 확인해 Apple/Microsoft/Berkshire/Samsung/SK/Naver의 표식을 확인했다. 진단용 임시 이미지만 사용했고 저장소에 복제하지 않았다.

| 종목 | CDN 경로 | 결과 |
| --- | --- | --- |
| AAPL | `/ticker/AAPL` | 두 환경 200 |
| MSFT | `/ticker/MSFT` | 두 환경 200 |
| BRK.B | `/isin/US0846707026` | 두 환경 200 |
| 삼성전자 005930 | `/isin/KR7005930003` | 두 환경 200 |
| SK하이닉스 000660 | `/isin/KR7000660001` | 두 환경 200 |
| NAVER 035420 | `/isin/KR7035420009` | 두 환경 200 |

위 대표 종목의 지원 확인이며 전체 국내/미국 종목의 로고 품질/지원 보증은 아니다. 404/네트워크 오류는 동일 `Image.onError` 경로의 화면 테스트로 대체 아이콘을 검증했다. 실제 장애를 발생시키거나 전체 로고를 수집하지 않았다.

### 공식 조건 검토(2026-10-18 조회)

| 근거 | 확인 내용·현재 조치 |
| --- | --- |
| [출처 표기](https://www.logo.dev/docs/platform/attribution) | Community 무료 상업용은 출처 필수. 공개·무로그인 production 페이지의 가시적 링크 필요. native 앱은 앱 웹사이트 또는 스토어 listing에 링크. 유료 플랜은 표기 의무 없음. 기존 Settings의 문구/`https://logo.dev` 링크는 정확해 유지 |
| [공개/비밀 키](https://www.logo.dev/docs/platform/api-keys) | `pk_`는 CDN 및 모바일 클라이언트용, `sk_`는 서버 API용. 도메인 제한 시 Referer 없는 요청은 401이므로 모바일 키 설정 시 주의. 검사 당시 무Referer 요청은 성공 |
| [캐싱](https://www.logo.dev/docs/platform/caching) | 실제 응답도 `max-age=86400, stale-while-revalidate=600`. 기본 이미지/HTTP 캐시 유지, 별도 영구 저장·이미지 DB·프록시 없음 |
| [직접 저장](https://www.logo.dev/docs/platform/self-hosting), [fair use](https://www.logo.dev/docs/platform/fair-use) | 앱 표시는 CDN 직접 요청. CDN을 수집해 자체 복제본을 만들지 않음. 별도 저장은 API 경로/조건 확인 대상이며 이번에 도입하지 않음 |
| [요금제](https://www.logo.dev/pricing), [약관](https://www.logo.dev/legal/terms) | 공개 조건은 검토했지만 현재 계정 플랜·개별 계약·출처 승인 상태는 확인 불가. 로고 권리자 권리를 서비스가 별도 양도하지 않음 |
| [Expo 정적 참조](https://docs.expo.dev/guides/environment-variables/), [EAS 환경](https://docs.expo.dev/eas/environment-variables/) | 공식 dot 참조, 공개 값 번들 포함, preview/production 연결 근거 |

**추가 조치 필요:** 무료 상업용이라면 웹사이트의 공개 footer/about 또는 App Store/Google Play 앱 상세 설명에 `Logos provided by Logo.dev`와 `https://logo.dev` 링크를 배치하고 Logo.dev 대시보드에서 공개 URL을 제출·확인한다. 모바일은 웹사이트 또는 스토어 중 하나라는 공식 설명이며 양쪽 스토어 모두 필수라고 확대 해석하지 않았다. 현재 플랜/별도 계약과 출처 승인 상태를 운영자가 확인해야 한다. 외부 사이트·스토어 변경, 결제, Logo.dev 계정 설정 변경은 수행하지 않았다.

## 학습·금융 검증

| 경계 | 실행 증거 |
| --- | --- |
| Q1~6 순서, Q6 전체 해금 금지, Q7~10 각각 미완료 실습, 전체 완료 해금 | `beginner-learning-policy`, `beginner-quest-evidence`, `beginner-quests.service` 단위 및 전체 퀘스트 PG |
| 위조 클라이언트 증거/다른 사용자/일반·시즌 분리 | 서버 증거/소유권 테스트, 초보계정 PG의 3모드 지갑·원장·TWR·멱등성 |
| 현물 시장가 매수/완료 실습 잠금/지정가·LOC/보호 | 기존 주문 단위·전체 퀘스트 PG. 사용자 지정가/LOC SELL은 위험 축소 예외가 아님 |
| 시장가 매도·자동 보호 발동·취소·예약 해제·기존 요청 재생 | 전체 퀘스트 PG의 기존 익스포저 정리/독립 보호 발동/취소, 주문 단위 및 현물 지정가 replay PG |
| 선물 롱/숏 >1배, 중복 방향·증액 차단, 감소/종료, 강제청산 후 재진입 | 전체 퀘스트 PG·서버 정책 단위. 재생은 권한/운영 gate보다 먼저 기존 결과를 반환 |
| 이미 접수된 선물 지정가 | 새 PG 시나리오: 일반 fixture에서 접수→초보 Q0 제한 fixture 전환→예약 유지→기존 matcher 체결→예약 0→위험 축소 종료. 운영 계정 mode 변경 API를 추가한 것이 아님 |
| 조건부 진입 발동 | 새 PG 시나리오: 제한 전 등록한 예약 없는 watch→학습 제한 후 실제 가격 발동→`failed`/`BEGINNER_FEATURE_LOCKED`, 새 체결 없음. 기존 별도 러너도 45검증 통과 |
| 동시 거절·읽기 무변경 | 프로파일 러너에서 지갑/현물·선물 포지션/주문/원장/퀘스트 acknowledgement/견적·명령 개수의 전후 지문 비교 |

체결 가격·수량·수수료·레버리지/증거금/청산·FX·지갑/원장·시즌 정산/랭킹·상태 전환·락/트랜잭션·멱등 정책은 변경하지 않았다. 새 스키마/migration 없음. 모든 DB 실행은 이번에 `/tmp`에 만든 PostgreSQL 16.15, `127.0.0.1:55481`, 별도 `trading_ab_*_test`에서만 수행했다. 기존 migration을 새 DB에 적용했으며 운영/기존 사용자 데이터를 초기화하지 않았다.

## 호환성과 배포 순서

실제 구버전 `81fae931`의 파서·오류 매퍼를 `git show`로 읽어 0/6/7/8/9/10 완료 응답을 실행했다([결과](evidence/legacy-compat.json)).

| 조합 | 결과 |
| --- | --- |
| 구앱 + 신서버 | 새 `learningPermissions`를 무시해도 동결된 `learningAccess`와 파싱 호환. Q6~9 버튼은 열릴 수 있지만 서버가 신규 거래를 차단. 공통/현물 오류 매퍼는 학습 안내. 구선물 전용 매퍼는 「주문이 접수되지 않았습니다. 입력값과 거래 가능 상태를 확인해주세요.」로 거절하며 학습 사유 상세 표시는 앱 업데이트 필요. 403을 체결 불명/5xx 서버 장애로 처리하지 않음 |
| 신앱 + 구서버 | `learningPermissions` 부재 시 구서버 Q6 규칙을 따른다. 전체 10개 제한을 서버보다 먼저 강제하지 않음 |
| 신앱 + 신서버 | 서버의 각 boolean을 사용. 완료한 실습/방향은 잠기고 전체 10개 후 열림 |
| 신앱의 오래된 허용 상태 + 학습 403 | 현물 견적/실행·선물 3종 화면에서 일반 서버 오류나 불명 체결로 처리하지 않고 학습 안내, 권한 재조회, 버튼 상태 갱신 |

별도 배포 시 **서버 → 신규 앱** 순서. 구앱의 버튼/다시하기 및 선물 전용 안내를 서버만으로 고칠 수 없으므로 업데이트 안내가 필요하다. 추가 버전 협상은 도입하지 않았다. EAS 클라우드 빌드/Update, 스토어/Render 배포는 수행하지 않는다. main 커밋은 기존 `[skip render]` 관행을 따른다.

## 소규모 성능 측정

기존 실습 helper로 실제 금융 명령을 수행해 Q6 및 전체 완료 계정을 만들었다. 상태를 위조하거나 권한을 캐싱하지 않았다. `pg_stat_statements`는 sampler를 제외한 DB별 전체 SQL(트랜잭션 SQL 포함)을 계수한다. 각 항목 20회, 최대 동시 4개, 로컬 서비스 호출이며 HTTP/실사용 데이터 규모 측정은 아니다.

| 상태/호출 | 동시 | p50 / p95 ms | SQL/호출 |
| --- | ---: | ---: | ---: |
| Q6 퀘스트 조회 | 1 | 15.74 / 18.64 | 36 |
| 전체 완료 퀘스트 조회 | 1 | 16.93 / 18.82 | 37 |
| Q6 퀘스트 조회 | 4 | 33.91 / 40.23 | 36 |
| 전체 완료 퀘스트 조회 | 4 | 26.71 / 30.68 | 37 |
| Q6 권한 허용 확인 | 1 | 7.54 / 10.24 | 17 |
| 전체 완료 권한 확인 | 1 | 7.80 / 9.16 | 18 |
| Q6 전체 거래 거절 | 4 | 13.78 / 15.99 | 17 |
| 전체 완료 전체 거래 확인 | 4 | 13.07 / 14.81 | 18 |
| 일반계정 권한 확인 | 4 | 0 / 0.01 | 0 |
| Q6 시장가 매수 거절 | 4 | 23.36 / 26.56 | 34 |
| 일반 시장가 견적+체결 | 4 | 88.89 / 149.14 | 139.1 |
| 완료 초보 시장가 견적+체결 | 4 | 160.76 / 263.91 | 211 |

학습 확인 1회는 17~18 SQL, 실제 견적+체결은 약 72 SQL의 추가 비용이 관찰됐다. 이 표본에서 실패·판정 불일치·거절 요청의 금융 상태 변경은 없었다. 예상되는 증거 조회 비용을 없앴다고 주장하지 않는다. 운영 처리량/장기 이력에서의 성능은 미검증이며, 이번 규모에서 새 인프라/장기 캐시/금융 엔진 최적화는 추가하지 않았다. [측정 JSON](evidence/beginner-profile.json).

재실행은 **새 격리 DB**에 기존 migration과 `CREATE EXTENSION pg_stat_statements`를 적용하고, 서버를 `shared_preload_libraries=pg_stat_statements`, `timezone=UTC`로 실행한 뒤 backend에서 아래 명령을 쓴다. 실제 DB URL을 보고서에 복사하지 않는다.

```bash
NODE_ENV=test FUTURES_DB_INTEGRATION=1 BEGINNER_PERMISSION_PROFILE=1 \
  BEGINNER_PROFILE_OUTPUT=/tmp/beginner-profile.json \
  NODE_OPTIONS=--max-old-space-size=1536 \
  timeout --kill-after=10s 180s node_modules/.bin/tsx scripts/beginner-permission-profile.ts
```

별도로 `DATABASE_URL`은 localhost의 `_test` DB에만 지정해야 한다. 확장이 없으면 fixture 생성 전에 실패한다. 새 러너의 원격/운영/명시 opt-in 거부를 기존 안전성 테스트에 추가했다.

## 실행 결과와 미완료 구분

- **검증 완료:** frontend `npm run typecheck`, `lint:accounts:check`, `lint:guides:check`, 변경 logo/color 파일의 명시 ESLint. backend typecheck·accounts lint·변경 두 러너 ESLint(모두 check-only).
- **검증 완료:** FE 관련 최초 26개 파일, 후속 선물/로고 7개 파일, 권한 UI 2개 파일, 이름/기록 4개 파일(중복 포함, 고유 34개). Node 기본 reporter의 file 단위 수치를 개별 assertion 개수로 부풀리지 않았다. 로고/색상 상세 실행은 13개 case 통과.
- **검증 완료:** BE 단위 14스위트/535개. 실제 DB와 안전성 2스위트/17개(최종 skip 0), 별도 선물 조건부 진입 45검증, 현물 지정가 replay 7시나리오. 전체 퀘스트 러너의 추가 2경계 포함 통과.
- **검증 완료:** 최종 3플랫폼 Expo export, 브라우저 호가 16·총자산 24·미국 이름 5. 홈의 24배치에는 작은 화면, Diamond/Whale, 긴 금액, 글꼴 2배, 안전한 아래쪽 엠블럼/두 줄 배치 및 갱신 검증이 포함된다. 과거 796/720배치 전체를 반복하지 않았다.
- **검증 완료(CI로 보완):** 기존 긴 F1은 로컬 WSL 실제 시계 역전으로 중단됐으나 최종 코드의 CI에서는 통과했다. 실패한 로컬 계정의 DB Close `2026-10-18 09:47:00.917`이 Open `09:47:02.698`보다 앞섰다. 초기에 별도로 발견한 테스트 클러스터의 KST/Prisma raw 시각 9시간 차이는 UTC 설정으로 해결했다. 긍정 fixture 시간 변경 실험은 원복했고 테스트/판정/가격 공식을 완화하지 않았다.
- **검증 불가(기존 종합 UI 러너):** `profileFinancialBrowser.cjs`는 navigation context 부재, 오래된 버튼 배경 기대값에서 실패. 해당 파일 변경은 원복했다. 새 집중 러너는 기존 trading/futures fixture와 실제 렌더러를 사용해 변경된 호가 영역만 검증한다. 종합 러너 전체 통과라고 보고하지 않는다.
- **추가 조치 필요:** Logo.dev 계정 플랜/출처 승인과 외부 공개 링크, 전체 종목 로고 지원, 운영 데이터 규모 성능. 실기기/에뮬레이터는 요청상 제외.

임시 로그/번들/스크린샷은 `/tmp/trading-ab-followup/`, 키 없는 증거 JSON은 이 폴더의 `evidence/`에 보존한다. 초기 실패와 보완 후 최종 결과를 구분한다.

### push 후 기존 CI 확인

검증 코드 SHA는 `e52730691816209d2d311686b9c2df628f260f6c`. 다음 문서/증거 정리 커밋은 제품·테스트 코드를 바꾸지 않으며 `[skip ci] [skip render]`로 중복 전체 실행/배포를 피한다. [최종 CI 요약](evidence/ci-review.json)은 실행별 상태와 기존 실패 원인을 구분한다.

- [현재 CI](https://github.com/windowsjd/trading_app/actions/runs/39117473071): 프론트 전체 357스위트/3,100개 통과(fail/skip 0), 린트·타입·웹 번들·진단 게이트 통과. 금융 job의 30스위트 중 29개 통과. F1, risk, F3/F3.1, isolated boundary, 선물 limit/conditional entry, 현물 execution/market execution/idempotent replay, FX·이체 통과. 계정 job에서도 초보계정·보완한 전체 퀘스트 테스트 통과. E2E·캔들 fixture·PG17 retention job 통과.
- **전체 CI는 미통과.** 아래 실패는 [시작 SHA의 CI](https://github.com/windowsjd/trading_app/actions/runs/39115538060)와 같은 원인임을 로그/무변경 diff로 확인했다. 새 코드의 통과 결과와 섞지 않는다.

| 기존 실패 | 현재/시작 SHA 공통 증거 | 처리 |
| --- | --- | --- |
| Backend quality | `scripts/lib/auth-email-fixture.ts:22`의 `require-await` | 이메일 기능/fixture 변경은 이번 범위에서 하지 않음 |
| 지갑 이전 PG | `spot-wallet-transfer-integration.ts:1251`의 migration 재생이 `CREATE INDEX CONCURRENTLY`를 트랜잭션 블록 안에서 실행(25001) | 기존 migration/과거 스키마 재생 테스트의 별도 보완 필요. F1 등 나머지 29스위트는 통과 |
| 국내 종가 복구 PG | `krx-session-close-recovery-integration.ts:560`의 `created` 기대 4, 실제 2 | 기존 KOSCOM 복구/fixture의 별도 조사 필요. 관련 제품 정책 변경 안 함 |
| 별도 Futures release fixture | 준비 중 `EMAIL_UNAVAILABLE` | [현재](https://github.com/windowsjd/trading_app/actions/runs/39117473143)·[시작 SHA](https://github.com/windowsjd/trading_app/actions/runs/39115538003) 모두 동일. 이번 소규모 초보 부하 검증과 별도이며 통과로 계산하지 않음 |

이 선행 문제 때문에 저장소 전체 출시 검증 완료/전체 CI green으로 보고하지 않는다. 원인 대조를 위해 새로운 배포나 전체 테스트 재실행을 요청하지 않았다.

## 변경 파일 목적과 전체 자체 검토

- `frontend/eas.json`, `assetLogoSource.ts`와 테스트: 공식 환경 참조·빌드 환경 명시·문법 회귀 방지.
- `financialColors.ts`, 색상/`AssetOrderLadder` 테스트: 호가 역할만 고정하고 나머지 금융 역할/교차 호가 유지 검증.
- 선물 `FuturesScreen`/`FuturesLimitEntryForm`/`FuturesConditionalEntryForm`, `FuturesLearningGate.test.ts`: 학습 거절 후 서버 권한 재조회 및 3종 화면 검증.
- `beginnerStockGates.test.ts`: 이미 정상인 현물의 견적/실행 학습 403 안내·권한 재조회 고정.
- `orderBookColorsBrowser.cjs`, browser README: 기존 fixture를 재사용한 16화면 CSS/실시간 설정 변경 검증.
- `backend/scripts/beginner-full-quest-integration.ts`: 이미 접수된 선물 지정가와 조건부 진입 발동의 차이를 실 DB로 검증.
- `backend/scripts/beginner-permission-profile.ts`, `beginner-quest.integration.spec.ts`: 소규모 실제 명령 성능/무변경 검증, 격리 DB 안전성.
- `HANDOVER.md`, 본 보고서/증거: 결과·원인·불변조건·배포 인계·미검증 사항 연결.

전체 diff 검토: 기존 A·B 기능 재구현 없음, 백엔드 제품 코드/DB 스키마/계산/상태/운영 설정 변경 없음, 계정·API 범위 유지, 대형 React 객체를 null/undefined와 직접 비교하는 새 단언 없음. 테스트 삭제/skip/검증 축소 없음. 운영 데이터·외부 사이트·배포는 변경하지 않는다.
