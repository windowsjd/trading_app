# Futures Limit Entry v1

An account may have one submitted entry per instrument while flat. This is a
full-fill entry into a new lifetime; increase, reduce and close remain on the
existing execution/Conditional paths. API base remains `/api/v1`.

- `POST trading-accounts/:accountId/futures/limit-orders`: instrumentId,
  direction, marginMode, integer leverage 1–100, quantity, limitPrice,
  idempotencyKey, optional `attachedProtection` legs in the existing format.
- `GET .../limit-orders`: account-owned pending entries; bounded pagination.
- `POST .../limit-orders/:orderId/cancel`: idempotent terminal cancel. Read and
  cancel remain available with trading disabled and after Season end.

Prices, quantity and reserved amount are decimal strings. Create/cancel return
`{ tradingAccountId, order }` with lifecycle timestamps and terminal/execution
IDs; list rows additionally include the presented instrument. A create replay
returns the current state of the same entry, including a terminal state.

Submission reserves ceil8(quantity × limit / leverage) plus the existing normal
opening fee at the limit in the Futures USD wallet. Balance does not change.
Reservations protect transfers and other openings; pending entries contribute
no Position, UPNL, maintenance, ledger event or fill count.

The bounded PostgreSQL/Ops matcher uses fresh canonical Binance Spot evidence:
Long fills at Spot <= limit, Short at Spot >= limit. The financial transaction
rechecks evidence and lifecycle, releases only its own reservation, and runs
the existing Futures execution plan, settlement, history and user fill count.
Fresh Mark remains a risk-readiness requirement, never trigger/execution price.
Additional free collateral can fund Short price improvement. Failed readiness,
maintenance or collateral checks roll back everything and leave the entry
pending. ENABLED permits creation/matching; REDUCE_ONLY/DISABLED pause matching
and preserve reservations until cancel or ENABLED resumes. No timeout/fallback
or source-priority policy changes.

Attached SL/TP uses the existing Conditional group/legs/children. Validate only
provided legs against entry limit (Long SL < entry < TP; Short TP < entry < SL).
The group is holding before fill and binds to the new lifetime atomically on
fill. Gap fills do not rewrite triggers: the existing Conditional worker handles
subsequent fresh evidence. Parent cancellation/lifecycle cleanup releases the
reservation and cancels holding protection in the same transaction.

Existing lifecycle/account/wallet fences serialize create, market open, fill,
cancel, transfer and final settlement. A unique submitted account/instrument
index and account/idempotency key preserve durable ownership. Existing migration
files are immutable; schema additions use one new migration. Feature flags are
not enabled by this implementation.

The API list returns only `submitted` entries, default 30/max 100 per page and
offset up to 100000, with the standard `nextOffset` contract. Frontend pending
reads stop at null and reject malformed/non-advancing offsets so an invalid
response cannot create an unbounded request/accumulation loop.

Creation and its idempotency replay use the same account fence. Reusing a key
with a different normalized intent conflicts; the same committed request can
be read back after an operating-mode or lifecycle change. The matcher records
its committed response on the entry itself, avoiding a second accounting or
command engine. Cancel after fill returns the existing terminal order without
releasing collateral again. Existing Season cleanup includes entries without
attachments, because every pending reservation must be resolved before final
valuation, regardless of whether TP/SL was requested. Final settlement additionally
counts submitted Futures entries in the target Season, both before and inside its
Season lock, independently of wallet reservations. Executed/canceled entries and
other Season/General accounts do not block it.

The pending Limit tab aggregates Spot and Futures emptiness; TP/SL retains its
independent state. The existing Protection editor checks attached trigger direction
against the entry limit with decimal arithmetic and presents direction-specific
SL/TP guidance. Backend validation remains authoritative.

The worker polls every second, at most 200 entries per cycle with an indexed
cursor and the existing 30-second Ops lease. The lease limits duplicate work;
the PostgreSQL financial fence determines the single winner even after lease
loss or duplicate execution. A read-only canonical Spot preview skips only
negative price predicates on currently tradable accounts. Every candidate retains
the original lifecycle cleanup transaction and the complete financial execution
transaction; preview evidence never authorizes a fill. Stale/missing evidence
remains fail-closed. Pre-creation Spot evidence is ineligible for a fill.
Database time, current operating mode and account lifecycle are rechecked after
the wallet lock. Maintenance, fees, PnL, loss allocation and rounding stay in the
existing Futures primitives.

Before production enablement: deploy the additive migration, verify canonical
Spot and Mark coverage/freshness, current collateral integrity, worker lease and
backlog, Conditional capabilities, Season cleanup and all financial/release
gates. Default DISABLED is unchanged. No instrument provisioning, real exchange
order, production database write or feature activation is part of this change.
