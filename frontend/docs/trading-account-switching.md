# Frontend TradingAccount Switching (작업 9)

Reference for the account-selection layer added by WORK-ID
`SEASON-RANKING-HARDENING-AND-FRONTEND-ACCOUNT-SWITCH-V1`.

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
| `components/tradingAccount/AccountSwitcher.tsx` | switcher UI |
| `constants/queryKeys.ts` → `QUERY_KEYS.tradingAccount.*` | account-scoped cache keys |

## Selection policy

`selectTradingAccountId(accounts, storedId)` is a pure function, in this order:

1. the stored id, **if it is still in the owned list** (`stored`)
2. the season the user is actually competing in — `mode=season`,
   `status=active`, participant not `excluded` (`active_season`)
3. their active general account (`active_general`)
4. the most recently opened readable account (`most_recent`)
5. `null` — an explicit empty state, never a fabricated account (`none`)

A stored id that is no longer owned is **dropped**, not retried: it means the
account left the list, the token now belongs to a different user, or the id was
never valid. Ties on `openedAt` break on `id` so selection never depends on
input order.

## Per-user persistence and logout

The storage key is `selectedTradingAccountId:<userId>`. With a single global key,
user A logs out, user B logs in, and B's first financial screen requests A's
accountId — the server correctly answers 404, but B sees an error on their own
portfolio.

On logout `clearTradingAccountSession(queryClient, userId)`:

- **removes** (not invalidates) `['tradingAccount']` and `['me']` — an
  invalidated entry is still readable while its refetch is in flight, so the
  next user's first frame could render the previous user's balances;
- clears the stored selection for that user.

The provider also drops the in-memory selection first whenever the userId
changes, so no render can hand a new user the previous user's accountId.

## Query keys

Every financial key carries the **accountId itself**, not the mode. Mode is not
an identity: a user can hold several season accounts across seasons, and two of
them keyed only by `'season'` would share one cache entry.

```
tradingAccount.list                                  // per user
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

### Switching

`selectAccount()` cancels the outgoing account's in-flight queries. Beyond that,
correctness is structural: the key CHANGES on a switch rather than being
invalidated, so react-query treats the new account as a different query with no
data, and a slow response from the old account resolves into the OLD key's
entry. There is no path for it to repaint the new account's screen.

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
| new order / quote / FX | season only | ✗ | ✗ |
| cancel order | ✓ | ✓ | ✓ |
| ad-reward claim | general only | ✗ | ✗ |

General trading and FX are blocked as `general_trading_not_implemented` /
`general_fx_not_implemented` and presented as 준비 중. Nothing here can enable
anything — the server is still authoritative. What it prevents is a live-looking
button whose only possible outcome is a 409.

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

`node --test` (no Jest in this project). Coverage: selection policy and
fallbacks, per-user storage isolation, cache separation and cross-account
invalidation safety, filter normalisation, mode/status capabilities, display
naming with long Korean season names, and error classification.
