# Codex Repository Instructions

- Frontend app: `frontend/` (Expo React Native).
- Package manager: use npm for frontend commands because `frontend/package-lock.json` is present.
- Build/typecheck: run `npm run typecheck` from `frontend/` before finishing frontend changes.
- Keep frontend changes scoped to `frontend/` unless the user explicitly asks for backend work.
- API base path rule: the backend contract remains under `/api/v1`. Document/version v2 does not mean `/api/v2`.
- Do not create or call `/api/v2` routes from the frontend.
- Prefer existing React Query, navigation, DTO, and state component patterns over introducing new frameworks.
- Keep auth, season, API-client, DTO, and shared utility changes focused; do not migrate FX, orders, market, ranking, records, or WebSocket feature behavior unless explicitly asked.
- TODO: add `lint` and `test` scripts after the frontend has agreed lint/test tooling. Do not wire placeholder scripts that fail by default.
