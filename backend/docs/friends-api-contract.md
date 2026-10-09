# Friends and portfolio visibility

All routes are authenticated and remain under `/api/v1`. The active-user guard
applies. Friendship and privacy reads use PostgreSQL on every request; they do
not depend on JWT claims or a server cache.

- `GET /friends/search?nickname=...&limit=...&offset=...`: active users whose
  nickname starts with the case-insensitive search text (1–30 characters).
  Self is excluded. Returns `users`, `pagination`; user fields are `userId`,
  `nickname`, `profileImageUrl`, `relationship` (none/sent/received/friend),
  and `requestId` when related. No email or account metadata.
- `GET /friends`: paginated accepted relationships; inactive friends remain
  removable and are labelled `active: false`.
- `GET /friends/requests`: paginated incoming pending requests from active users.
- `POST /friends/requests` with `{ userId }`: create pending request; self and
  either-direction duplicates fail with 400/409. Concurrent insert uniqueness
  is enforced in PostgreSQL.
- `POST /friends/requests/:requestId/accept` or `/reject`: only the recipient
  may transition/delete a pending request. Accept requires both users active.
- `DELETE /friends/:friendshipId`: either member may delete an accepted pair.
  Unknown, stale or unowned request/relationship IDs return 404.

One sorted unordered user pair is stored once, with pending/accepted status and
the requesting member. Database CHECKs enforce ordering, distinct members and
requester membership; a unique constraint prevents reverse-direction races.

`GET/PATCH /me` adds Boolean `portfolioPublic`. Its database default is `true`
for existing and new users; PATCH accepts only an actual Boolean.

`GET /users/:userId/season-summary` retains public competition fields and adds
`portfolioAccess` (available/private/not_friend/unavailable), `portfolioReason`,
and `portfolio` (null unless authorized). The payload contains allocation,
holdings with canonical valuation weights, and existing daily snapshots from
the last 30 calendar days. Missing valuation is represented explicitly with
null amounts/weights; no synthetic zero values or interpolated history.

The authorized detail additionally includes Spot holding `quantity`, `market`,
`currencyCode` and a minimal canonical `valuation` (state, local currency/value,
unrealized PnL and return rate). It reuses the owner Positions valuation policy,
including explicitly labelled stale cache and unavailable states; it exposes no
cost basis, order, wallet, ledger, diagnostic or provider metadata.
`futures` contains `evaluatedAt` and open position summaries: public underlying
identity, direction, margin mode, leverage, fresh Mark
notional/PnL/ROI and Mark timestamps. It exposes no shared collateral, risk or
transaction controls or margin balances. The ROI basis is calculated on the
server and is not returned. See the Futures position display projection for the basis.
The existing friend holding asset-id ordering is retained.
Both projections are read only and exist solely inside this guarded detail.
Friendship/privacy and current season/participant/account eligibility are
revalidated after all financial reads; a revoked permission discards the entire
portfolio. Ranking, friend search and historical public records are unchanged.

Portfolio access requires an active target, an accepted friendship, the target's
public setting, and participation in the selected current active season with a
valid season account. Hidden/excluded participants remain hidden. Self can use
the existing owner APIs, but gets no special bypass on this friend surface.
Public competition information remains readable without friendship or sharing.
The existing `/users/:userId/records/:seasonId` retains public competition
summary only: it returns `portfolio: null` and directs current portfolio reads
to the guarded season-summary route. It never returns holdings/allocation.

`GET /ranking?scope=friends` filters accepted active friends inside the existing
repeatable-read snapshot, before counting/pagination. Global ranks, percentile
denominator, tiers, daily/final selection, visibility and capturedAt rules remain
unchanged. `near_me` is removed; MY and season Home use `all&limit=1` for myRanking.
No ranking writer, financial transaction, balance or snapshot is modified.

UI: fifth tab is 전체 (same internal MyTab/MyStack names), with MY, 친구,
공지사항 and 설정. Notices are an empty independent screen without an API.
Friend mutations invalidate friends/search/requests, friend ranking and the
affected user summary; privacy saves use the returned `/me` value.
