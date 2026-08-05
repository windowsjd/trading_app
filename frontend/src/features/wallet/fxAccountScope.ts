/**
 * Which FX responses are allowed to touch the screen (작업 12 §2).
 *
 * THE FAILURE THIS PREVENTS
 * ------------------------
 * A quote or an execute is issued for account A. Before the server answers, the
 * user switches to account B and the screen wipes its FX state. Then A's
 * response lands. Every callback on the mutation is re-created each render, so
 * by the time it runs it closes over B — and it happily wrote A's quote into
 * B's screen, showed A's error under B's heading, popped A's success sheet over
 * B, and invalidated B's cache for a movement in A's money.
 *
 * THE RULE
 * --------
 * A response may only touch the screen when the request that produced it was
 * issued for the account the screen is showing NOW, in the SAME scope the
 * screen is in now.
 *
 * `scopeEpoch` is what makes the second half true. Account id alone cannot tell
 * A→B→A apart from never having left A: the ids match again, but the screen was
 * reset in between and the in-flight request describes a quote the user can no
 * longer see. One counter, bumped on every account change, closes that window.
 *
 * This is NOT a cancellation framework. React Query still cancels the outgoing
 * account's queries on a switch; cancellation is a best-effort optimisation
 * (a mutation already in flight on the server cannot be recalled), so the
 * callbacks check as well rather than trusting it.
 *
 * WHAT IS DELIBERATELY *NOT* GATED
 * --------------------------------
 * Cache invalidation. If A's execute succeeded on the server, A's money really
 * moved, and A's cache is stale whether or not the user is still looking at it.
 * It is invalidated using the REQUEST's accountId — never the current selection
 * — so the write lands on the account that actually changed.
 */

export type FxRequestScope = {
  /** The account the request was issued for. */
  accountId: string;
  /** The screen's account-change counter at issue time. */
  scopeEpoch: number;
};

export type FxQuoteRequestScope = FxRequestScope & {
  fromCurrency: string;
  toCurrency: string;
  sourceAmount: string;
};

/**
 * True when `request` was issued for the scope the screen is in now.
 *
 * An empty `accountId` on either side is never in scope: no account selected
 * means there is no screen for the answer to belong to.
 */
export function isFxResponseInScope(
  request: FxRequestScope,
  current: FxRequestScope,
): boolean {
  if (!request.accountId || !current.accountId) return false;

  return (
    request.accountId === current.accountId &&
    request.scopeEpoch === current.scopeEpoch
  );
}

/**
 * True when a quote response is both in scope AND still describes what the user
 * is asking for.
 *
 * The input comparison is the pre-existing latest-quote-wins rule (a slow
 * earlier quote must not overwrite a newer one); the scope check is what stops
 * a different ACCOUNT's quote from being treated as merely an older one.
 */
export function isFxQuoteResponseCurrent(
  request: FxQuoteRequestScope,
  current: FxQuoteRequestScope,
): boolean {
  if (!isFxResponseInScope(request, current)) return false;

  return (
    request.fromCurrency === current.fromCurrency &&
    request.toCurrency === current.toCurrency &&
    request.sourceAmount === current.sourceAmount
  );
}
