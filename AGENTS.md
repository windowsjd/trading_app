# Codex Repository Instructions

- Frontend app: `frontend/` (Expo React Native).
- Package manager: use npm for frontend commands because `frontend/package-lock.json` is present.
- Build/typecheck: run `npm run typecheck` from `frontend/` before finishing frontend changes.
- Lint: run `npm run lint:accounts:check` from `frontend/` when you touch the gated
  scope (auth, tradingAccount, record, wallet, order/FX/home/my screens,
  `components/tradingAccount`, `CTAButton`). It is check-only — warnings fail and
  nothing is auto-fixed. `npm run check` runs lint + typecheck + tests together.
- Keep frontend changes scoped to `frontend/` unless the user explicitly asks for backend work.
- API base path rule: the backend contract remains under `/api/v1`. Document/version v2 does not mean `/api/v2`.
- Do not create or call `/api/v2` routes from the frontend.
- Prefer existing React Query, navigation, DTO, and state component patterns over introducing new frameworks.
- Keep auth, season, API-client, DTO, and shared utility changes focused; do not migrate FX, orders, market, ranking, records, or WebSocket feature behavior unless explicitly asked.
- Lint scope is deliberately partial: the rest of the repository has pre-existing
  debt and is not gated yet. Widen the scope in the npm script (not the config)
  only together with fixing the files you add.

## Codex 테스트 작성·수정 규칙 — 대형 객체 오류 출력 방지

1. **대형 객체 직접 비교 방지:** ReactTestInstance처럼 크고 복잡한 내부
   참조를 가진 객체를 단언문의 실제값(actual)으로 직접 전달하여 `null`
   또는 `undefined`와 비교하지 않는다.
2. **원시값 비교:** UI 요소의 존재 여부는 객체 자체가 아닌 boolean 등
   작은 원시값으로 검증한다. 위험: `assert.equal(h.find('panel'), undefined)`.
   안전: `assert.equal(h.find('panel') === undefined, true)`.
3. **테스트 검증 의미 유지:** OOM을 피하기 위해 테스트를 삭제·skip하거나,
   실패를 성공으로 처리하거나, 필요한 검증을 생략하지 않는다.
4. **비정상 테스트 재실행 통제:** 메모리 급증, 비정상 종료, 장시간 응답
   없음이 발생하면 동일 테스트를 즉시 재실행하지 않는다. 먼저 기존
   프로세스의 종료 여부와 실패 원인을 확인한다. 재현이 필요하면 자식
   프로세스를 포함한 프로세스 전체에 메모리·시간 제한을 적용한다.
5. **적용 범위 최소화:** 신규·수정 테스트 및 해당 작업에서 영향을 받는
   기존 테스트에 적용한다. 매번 저장소 전체 테스트를 수정하거나 새
   테스트 관리 시스템을 도입하지 않는다.

### 완료 전 자체 검토

변경된 테스트의 단언문과 실패 처리 경로에 대형 객체 출력 위험이 남아
있는지 확인한다. 원래 검증 의미를 유지하고 OOM 방지를 이유로 필요한
검증을 축소하지 않았는지도 확인한다.

### 규칙 적용 범위

이 루트 지침은 `frontend`, `backend`를 포함한 가상 트레이딩 앱 저장소의
관련 테스트 작업에 적용한다. 기존 테스트 프레임워크를 교체하거나 별도
테스트 관리 시스템을 도입하지 않는다.
