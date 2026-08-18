# Frontend TradingAccount Switching (작업 9 + 작업 10 + 작업 11 + 작업 13)

Reference for the account-selection layer added by WORK-ID
`SEASON-RANKING-HARDENING-AND-FRONTEND-ACCOUNT-SWITCH-V1`, completed across
every current financial screen and mutation by
`FRONTEND-ACCOUNT-SCOPE-COMPLETION-AND-RELEASE-HARDENING-V1` (작업 10),
extended to app ENTRY, per-user cache separation and the season Home itself by
`VIRTUAL-TRADING-ACCOUNT-UX-AND-RELEASE-HARDENING-V1` (작업 11), and given an
explicit investment-mode choice at login by
`TRADING-MODE-ENTRY-AND-GENERAL-ACCOUNT-ACCESS-V1` (작업 13). General-account
market/limit trading was enabled on 2026-08-18 without changing this accountId
binding or cache-isolation design; general FX remains unavailable.

Backend contracts this depends on:
`backend/docs/trading-accounts-api-contract.md`,
`trading-account-finance-api-contract.md`,
`trading-account-orders-api-contract.md`,
`general-account-and-ad-rewards-api-contract.md`.

## Stack (unchanged)

Expo + React Native, React Navigation, `@tanstack/react-query`, axios,
AsyncStorage. **No new global state or query library was introduced.** The owned
account list is server state and lives in react-query like every other server
read; the only genuinely client-side fact — the selected id — is one `useState`
plus one AsyncStorage entry.

## Files

| File | Role |
| --- | --- |
| `features/tradingAccount/api.ts` | account-scoped API calls (existing backend routes only) |
| `features/tradingAccount/accountSelection.ts` | pure selection policy + display ordering |
| `features/tradingAccount/capabilities.ts` | mode/status → what the UI may offer |
| `features/tradingAccount/accountDisplay.ts` | human-readable names, status labels, return-rate meaning |
| `features/tradingAccount/selectionStorage.ts` | per-user AsyncStorage persistence |
| `features/tradingAccount/integrityErrors.ts` | structural-error classification |
| `features/tradingAccount/TradingAccountContext.tsx` | the single source of truth |
| `features/tradingAccount/accountScope.ts` | response↔request accountId cross-check (작업 10) |
| `features/tradingAccount/accountBinding.ts` | is this mutation flow still safe to continue (작업 10) |
| `features/tradingAccount/invalidation.ts` | which cache entries a mutation refreshes (작업 10) |
| `features/auth/sessionCache.ts` / `session.ts` / `useLogout.ts` | the session boundary (작업 10) |
| `services/api/sessionExpiry.ts` | the one seam from a dead refresh token to teardown (작업 10) |
| `features/record/accountOrders.ts` | account-scoped order row → record row shape (작업 10) |
| `screens/home/GeneralAccountHome.tsx` | Home for a general account (작업 10) |
| `screens/home/SeasonAccountHome.tsx` | Home for a season account, account-scoped (작업 11) |
| `features/auth/entry.ts` / `useEnterApp.ts` | app entry decided by owned accounts (작업 11) |
| `components/tradingAccount/AccountSetupPanel.tsx` | the no-account landing; opens a general account (작업 11) |
| `features/tradingAccount/legacyFinancialCalls.test.ts` | the guard that keeps legacy implicit-account calls out (작업 11) |
| `components/tradingAccount/AccountSwitcher.tsx` | switcher UI + first-time 일반 투자 start (작업 13) |
| `screens/entry/ModeSelectionScreen.tsx` | the 일반/시즌 choice every fresh login answers (작업 13) |
| `features/tradingAccount/modeSelection.ts` | pure view-model of what mode selection may offer (작업 13) |
| `features/tradingAccount/useOpenGeneralAccount.ts` / `generalAccountOpen.ts` | the ONE general-open flow all three entry points share (작업 13) |
| `features/auth/entry.ts` / `useEnterApp.ts` | intent-aware entry routing: new login vs session restore (작업 13) |
| `constants/queryKeys.ts` → `QUERY_KEYS.tradingAccount.*` | account-scoped cache keys |

## Which screen uses which account (작업 10)

| Screen | accountId source | Endpoints |
| --- | --- | --- |
| Home (season) | selected | `/trading-accounts/:id/portfolio`, `/portfolio/equity`, `/wallets`, `/positions`, and `/ranking?seasonId=<the account's season>` (작업 11) |
| Home (general) | selected | `/trading-accounts/:id/portfolio`, `/wallets`, `/positions` |
| Home (no account) | — | nothing is read; `POST /trading-accounts/general` on an explicit press (작업 11) |
| My (rank/tier) | selected | `/ranking?seasonId=<the account's season>` (작업 11) |
| Portfolio | selected | `/portfolio`, `/portfolio/equity`, `/positions` |
| AssetDetail | selected (positions only) | `/positions`; price/candles stay public |
| Order | **route param**, fixed at entry | `/orders/quote`, `/orders`, `/positions`, `/wallets` |
| Wallet FX | selected | `/wallets`, `/fx/quote`, `/fx/execute`; public `/fx/rates/current` |
| Wallet ledger | selected | `/wallet-transactions` |
| Order list + cancel | season record's account or General Home's pinned accountId | `/orders`, `/orders/:orderId/cancel` |

Market data (asset detail, price, candles, market list) keeps account-free cache
keys: those rows are identical for every account and every user, and an order
changes what the user OWNS, not what a share is worth.

## Selection policy

`selectTradingAccountId(accounts, storedId)` is a pure function, in this order:

1. the stored id, **if it is still in the owned list** (`stored`)
2. the season the user is actually competing in — `mode=season`,
   `status=active`, **`season.seasonStatus=active`**, participant not
   `excluded` (`active_season`)
3. their active general account (`active_general`)
4. the most recently opened readable account (`most_recent`)
5. `null` — an explicit empty state, never a fabricated account (`none`)

A stored id that is no longer owned is **dropped**, not retried: it means the
account left the list, the token now belongs to a different user, or the id was
never valid. Ties on `openedAt` break on `id` so selection never depends on
input order.

The season-status condition in rule 2 was missing until 작업 10. Season accounts
are closed by settlement, but an `ended` season sits between "trading stopped"
and "settled", and a settled season whose close-out failed leaves an active
account behind by definition of the failure. Either one outranked a live general
account, landing the user on a frozen leaderboard position they could not trade
from while the account they could actually use sat one tap away. Those accounts
are still reachable through rule 4 — readable history, just not the landing
place.

## App entry (작업 11 · rewritten by 작업 13)

Entry routes on the caller's INTENT plus the stored selection — never on
`getCurrentSeason()`, and (since 작업 13) never on "owns anything → home".

작업 11 removed the season from the decision: *is there a season to join* is a
property of the server, *does this user have an account* a property of the
user. 작업 13 removes the remaining guess. "Owns an account → straight to
Home" silently answered a question that belongs to the user: WHICH account is
this session about? Because the fallback policy prefers the active season, a
user holding only a season account was always dropped into season Home, and a
season participant who wanted 일반 투자 had no doorway to it at all.

`resolveAuthedEntryRoute(intent, accounts, storedAccountId)` in
`features/auth/entry.ts`:

| Intent | Stored selection | Route |
| --- | --- | --- |
| `new_login` (login, signup) | ignored — not even read | `ModeSelection`, always |
| `session_restore` (splash) | still in the owned list | `MainTabs` on that account |
| `session_restore` | missing / no longer owned | `ModeSelection` |

The order after authentication is:

1. save tokens;
2. seed `me` (from the login response, or from `GET /me` on session restore);
3. read `tradingAccount.list(<userId>)` — the same cache entry the provider
   mounts on, so entry and the provider make ONE request between them;
4. route by the table above;
5. the provider restores the stored selection and applies the fallback policy
   (mode selection writes an explicit selection before navigating home).

A failure to read the list is NOT treated as "no accounts": login/signup stay
put with the real error, and splash shows an explicit retry instead of
guessing between "logged out" and "owns nothing".

`getCurrentSeason()` keeps its real jobs — may I join, what is the public
season, which season does the leaderboard default to — and
`features/tradingAccount/legacyFinancialCalls.test.ts` fails the build if it
reappears anywhere else. Mode selection is on that allowlist for exactly the
"may I join" question; the entry ROUTE still never consults it.

## Mode selection (작업 13)

`screens/entry/ModeSelectionScreen.tsx` asks: **"이번 세션에서 어떤 투자
계정으로 시작할 것인가?"** Its options come from the pure view-model
`buildModeSelectionModel(accounts, currentSeason)`:

- **일반 투자 — always offered.** With a general account (any status): use it.
  Without one: "일반 투자 계정 시작하기", which fires the explicit
  `POST /trading-accounts/general`. The card states the standing policy: 초기
  자금 10,000,000원, 시간가중 수익률, 매매 가능, 환전은 준비 중.
- **시즌 투자.** Season accounts the user is competing in ("시즌 투자
  계속하기"), or — when the current season is effectively active, the server
  says not joined, AND the owned list has no account for it — "시즌 참가하기"
  into `SeasonJoin` (pushed, so back returns here). Otherwise the screen says
  outright that no season is joinable, with 일반 투자 still available.
- **지난 시즌 계정.** Finished/settled/excluded season accounts are reachable
  as history ("기록 보기") but are never a default and never look like a live
  start.

A season-lookup failure disables only the season column (with its own retry);
a general-open failure shows its message and leaves every season option
usable. Nothing is created on mount, by GET, or by navigation.

## Opening the general account (작업 11 · unified by 작업 13)

Three surfaces offer "일반 투자 시작하기" — mode selection, the account
switcher sheet (when no general account exists), and `AccountSetupPanel` (the
in-app no-account landing). All three run the ONE flow in
`useOpenGeneralAccount` / `completeGeneralAccountOpen`:

1. `POST /trading-accounts/general` — on an explicit press only; `start()` is
   a no-op while a request is in flight, and the button is disabled/loading;
2. await the owned-list refetch, so the provider can already see the account;
3. select the id THE SERVER RETURNED (`data.created` distinguishes the first
   open from a replay — a double tap or retry lands on the same account);
4. only then run the caller's `onOpened` (navigate home / close the sheet).

The switcher's row is an ACTION, not an account: no synthetic id, no fake
account row, and no financial read happens before the server has answered.
On failure the sheet stays open with the full message and the season accounts
remain selectable.

## Per-user persistence and logout

The storage key is `selectedTradingAccountId:<userId>`, and since 작업 11 the
account LIST cache key is `['tradingAccount','list',<userId>]` as well. With a
single global key,
user A logs out, user B logs in, and B's first financial screen requests A's
accountId — the server correctly answers 404, but B sees an error on their own
portfolio.

On logout `useLogout()` → `endSession()`:

- **clears the WHOLE query cache** (`queryClient.clear()`), not a key list.
  Until 작업 10 this removed only `['tradingAccount']` and `['me']`, so
  `['wallet']`, `['positions']`, `['portfolio']`, `['order']`,
  `['home','dashboard']`, `['record']` and `['ranking']` survived into the next
  user's session. An enumerated allowlist silently stops being complete the next
  time a feature adds a key; `clear()` cannot be defeated that way and drops the
  mutation cache in the same call. The cost is one cold market fetch on the next
  login.
- **removes**, never invalidates — an invalidated entry is still readable while
  its refetch is in flight, and that window is exactly the next user's first
  frame;
- clears the stored selection for that user, and the tokens.

There is now ONE logout. It used to be copy-pasted into MyScreen and
SettingsScreen, and both copies had the same gap.

A failed token refresh runs the same teardown. `services/api/sessionExpiry.ts`
is a single nullable callback — not an event bus, not an emitter — set once by
the app root: one producer (the 401 refresh path), one consumer, fired at most
once per session. Before it, an expired session cleared the TOKENS and left
every mounted screen rendering a full portfolio for a session the server had
already stopped honouring.

On login/signup `beginSession()` runs in this order: clear → seed `me` from the
login response → invalidate that user's account list key. The middle step is what makes the
switcher appear without an app restart: the provider gates its account query on
`enabled: !!userId`, so without it the provider sat on its pre-login 401.

The provider also drops the in-memory selection first whenever the userId
changes, so no render can hand a new user the previous user's accountId.

## Query keys

Every financial key carries the **accountId itself**, not the mode. Mode is not
an identity: a user can hold several season accounts across seasons, and two of
them keyed only by `'season'` would share one cache entry.

```
tradingAccount.list(userId)                          // per USER (작업 11)
tradingAccount.listAll                               // invalidation prefix only
tradingAccount.detail(accountId)
tradingAccount.portfolio(accountId)
tradingAccount.portfolioEquity(accountId, range)
tradingAccount.wallets(accountId)
tradingAccount.walletTransactions(accountId, filters)
tradingAccount.positions(accountId, filters)
tradingAccount.orders(accountId, filters)
tradingAccount.orderDetail(accountId, orderId)
tradingAccount.quote(accountId, quoteId)
tradingAccount.adRewardEligibility(accountId)
tradingAccount.adRewardClaims(accountId, filters)
```

The accountId sits immediately after the resource name, so
`['tradingAccount','portfolio',A]` is a valid invalidation prefix for everything
about A's portfolio at every range, and **cannot prefix-match B's entries**. A
mutation on A therefore refreshes A's orders/wallets/positions/portfolio and
leaves B's perfectly good cache alone.

`normalizeFilterKey()` collapses `undefined`, `null`, `''`, and omission to one
token and sorts keys, so two calls that mean the same query never produce two
cache entries.

The owned-account LIST carries the userId for the same reason (작업 11). Logout
clears the cache, but the list is also the first thing read after a login, and
any path that seeds or refetches it before the previous entry is gone would hand
user B the accounts of user A — which then selects an account B does not own and
issues account-scoped reads against it. Keyed by user, B's entry has never been
written.

The season leaderboard key carries its `seasonId` (작업 11): Home names the
selected account's season explicitly, while the public ranking tab means
"whatever is current". Sharing one entry would print this season's rank beside
last season's name.

### Switching

`selectAccount()` cancels the outgoing account's in-flight queries. Beyond that,
correctness is structural: the key CHANGES on a switch rather than being
invalidated, so react-query treats the new account as a different query with no
data, and a slow response from the old account resolves into the OLD key's
entry. There is no path for it to repaint the new account's screen.

### Mutations and targeted invalidation (작업 10)

`features/tradingAccount/invalidation.ts` decides what a successful mutation
refreshes. Two rules:

1. **Only the acting account.** `['tradingAccount','wallets',A]` matches all of
   A's wallet entries and cannot prefix-match B's. A blanket
   `QUERY_KEYS.tradingAccount.all` would discard B's still-correct cache and
   make every switch back to B a cold load, for a mutation that provably could
   not have touched it.
2. **Never shared market data.** An order changes what the user owns, not what a
   share is worth; invalidating prices/candles here would replace a live chart
   with a spinner as a side effect of buying.

| Mutation | Refreshes | Deliberately not |
| --- | --- | --- |
| create order | orders, positions, wallets, portfolio(+equity) | market data |
| cancel order | orders, wallets, portfolio | **positions** — a cancel never fills |
| FX execute | wallets, portfolio(+equity) | **positions** — cash moved, nothing was bought |
| ad reward claim | ad rewards, wallets, portfolio | season UI (general-only) |

Season-keyed views (`record`, `ranking`, `home.dashboard`) are refreshed only
for season accounts; they have no per-account key to be selective about.

### Binding a mutation flow to one account (작업 10)

`resolveAccountBinding()` answers "is this flow still safe to continue" for the
Order screen, from the id it was ENTERED with:

| State | Meaning | Screen |
| --- | --- | --- |
| `loading` | owned list not in yet | spinner |
| `account_changed` | the selection moved elsewhere | stop; drop quote/key/inputs/success; ask to re-enter |
| `unknown_account` | route id not owned (unknown id and another user's id are the same answer) | error, no probing |
| `bound` | proceed, with that account's capabilities | the form |

Following the selection would be the bug: the quote was priced for the old
account, the server pins quotes to the account that issued them, and the amounts
were chosen against the old account's balances. Pressing 주문 would then move
money in an account the numbers on screen were never about.

### Response↔request accountId cross-check (작업 10)

`assertAccountScope(endpoint, expectedAccountId, payload)` wraps every
account-scoped call. When the response carries a `tradingAccountId` and it
differs from the requested one, the value never reaches a screen, a cache write,
or a mutation success — it becomes a structural integrity error.

A response WITHOUT the field is not a violation: order detail, create, cancel
and the FX rows return the legacy shape, the path already named the account, and
the server re-verifies ownership per request. Treating absence as mismatch would
break all of them for no safety gain.

The log line carries the endpoint and the two ids and nothing else. The payload
that triggered it belongs to another account; putting balances or orders into a
log to explain an isolation failure is the same leak somewhere else.

## Mode-specific presentation

Read the label from the RESPONSE's `returnRateMethod`, never from the selected
account's mode — the two must agree, and if they disagree the response is the
fact.

| | season | general |
| --- | --- | --- |
| `returnRateMethod` | `initial_capital` | `time_weighted` |
| label | 시즌 수익률 (초기자본 대비) | 시간가중 수익률 |
| season ranking / tier / reward UI | shown | never shown |
| external funding fields | `null` (no such concept) | shown, labelled as inflow |

General mode additionally shows `initialFundingKrw`,
`cumulativeExternalFundingKrw`, `cumulativeAdRewardKrw`, `investmentPnlKrw`, with
an explicit note that external inflow is not investment profit. An unavailable
performance figure is rendered as unknown — **never as 0%**, which is a claim
about it.

## Capabilities

`getTradingAccountCapabilities(account)` derives from `mode` and `status` only.
Status is checked **before** mode, so a closed general account reads as closed
rather than "not implemented yet" — different situations, and one of them will
never change.

| | active | suspended | closed |
| --- | --- | --- | --- |
| reads | ✓ | ✓ | ✓ |
| new order / quote | season + general | ✗ | ✗ |
| FX | season only | ✗ | ✗ |
| cancel order | ✓ | ✓ | ✓ |
| ad-reward claim | general only | ✗ | ✗ |

Active general accounts can quote/create market and limit buy/sell orders through
the same account-scoped endpoints as season accounts. Suspended/closed accounts
remain readable and may cancel submitted limit orders, but cannot create new
quotes/orders. General FX stays blocked as `general_fx_not_implemented` and is
presented separately as 준비 중. The server remains authoritative for every
capability.

General Home exposes `주문 내역 보기`, carrying its accountId into the existing
Record order-list route. That route resolves the id against the owned-account
list and keeps it fixed for polling and cancel; a later global account switch
cannot retarget the request. Season record entry points keep their seasonId
lookup and use the same account-scoped list/cancel implementation.

## Errors

`classifyAccountError(error)`:

- `unauthorized` (401) → existing auth flow
- `account_not_found` (404 / `TRADING_ACCOUNT_NOT_FOUND`) → refresh the owned
  list and fall back. Unknown id and another user's id are deliberately the same
  response server-side, and the client does not probe to tell them apart.
- `integrity` → the 16 structural codes get their own error state with retry and
  contact-support copy. Rendering them as an empty portfolio would undo the whole
  point of the backend failing closed.
- `capability_limit` → 준비 중, kept separate from damage
- `account_not_active` → its own message, not folded into the above

Transient price/FX gaps arrive INSIDE a success envelope as `sectionErrors` and
keep their existing section-level treatment.

## Layout

Layout is part of the correctness here. The three things a user needs before
trusting a number — which account, what mode, what status — are all
variable-length Korean text, and a season name is user-supplied content:

- the trigger and every row **wrap** rather than truncating to one ellipsised
  line; `numberOfLines` is a cap (3 on the trigger), not the overflow strategy;
- the status badge sits on its own `flexShrink: 0` track and never disappears —
  a missing "종료" badge makes a closed account read as live;
- the mode caption and the return-rate meaning each get their own line rather
  than one long sentence that folds badly at narrow widths and enlarged
  accessibility font scales.

## Tests

`node --test` (no Jest in this project). The general-trading additions cover
active/inactive capability derivation, sell-side limit presentation, account-
scoped quote/create/cancel paths, and the existing account-switch/stale-response
guards in addition to the 작업 13 suite.

Coverage: selection policy and fallbacks including the ended/settled/upcoming
season cases; per-user storage isolation; cache separation and cross-account
invalidation safety (every mutation asserted not to touch account B or shared
market data); filter normalisation; mode/status capabilities; display naming
with long Korean season names; error classification; response-scope mismatch
(including that the log carries no payload); the session boundary (a full clear,
clear-before-seed ordering, and that the previous user's portfolio is
unreadable afterwards); order-flow account binding; the record-order row
adapter; and layout invariants.

작업 13 adds: intent-aware entry routing (`entry.test.ts` — every account
shape on a new login routes to mode selection, the stored id is not even read;
restore keeps only a still-owned selection); the mode-selection model
(`modeSelection.test.ts` — the §13 user shapes: season-only, general-only,
both, nothing, past-only, excluded, stale season answer); the general-open
ordering (`generalAccountOpen.test.ts` — refetch before select, replay lands
on the same account, no selection on failure); and the composed release
scenarios (`entryScenarios.test.ts` — 시나리오 A/B/C run through the real
functions end to end, the closest executable form of the E2E flows in a
renderer-less project).

`legacyFinancialCalls.test.ts` (작업 11) is the standing guard: no legacy
implicit-account financial function may be defined or imported anywhere, the
listed financial screens must read the account-scoped surface, and
`getCurrentSeason` may appear only in the season-specific files (작업 13 adds
`ModeSelectionScreen` for the "may I join" question). It was verified to FAIL
when a legacy import is reintroduced — a guard that cannot fail proves
nothing.

Layout has no renderer here, so `accountLayout.test.ts` asserts the two things
that can be checked without one, and that are the two that broke in practice:
the data is never pre-truncated, and the styles long text depends on
(`flexShrink: 0` badge tracks, `minWidth: 0` wrapping titles, `lineHeight`,
ScrollView on the error states, no `numberOfLines={1}`) are actually present.
