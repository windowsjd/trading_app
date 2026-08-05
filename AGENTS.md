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
