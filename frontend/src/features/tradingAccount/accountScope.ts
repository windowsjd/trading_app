/**
 * Response↔request account cross-check (작업 10 §A-10).
 *
 * Every account-scoped route names its account in the PATH, and most of them
 * echo a `tradingAccountId` back in the payload. When those two disagree, one
 * of exactly two things has happened: the server resolved the request against a
 * different account than the one asked for, or a response was routed to the
 * wrong caller. Neither is recoverable by retrying, and both mean the numbers
 * on screen would belong to an account the user did not ask about.
 *
 * So a mismatch is not "unexpected data" to be rendered defensively — it is
 * refused. The value never reaches a screen, never becomes a mutation success,
 * and never gets written to the cache under the requested account's key. It
 * surfaces as a structural integrity error like every other fail-closed
 * condition in this app.
 *
 * DELIBERATELY NOT A VALIDATION FRAMEWORK
 * ---------------------------------------
 * This checks ONE field, and only when the server actually sent it. A response
 * without `tradingAccountId` is not a violation: several routes (order detail,
 * order create, cancel, FX quote/execute) return the legacy row shape, which
 * has no such envelope. Treating absence as mismatch would break every one of
 * them for no safety gain — the path already named the account, and the server
 * re-verifies ownership per request.
 *
 * LOGGING
 * -------
 * The log line carries the endpoint and the two ids and NOTHING else. The
 * payload that triggered it belongs to some other account: dumping balances,
 * orders, or positions into a log to explain an isolation failure would be the
 * same leak in a different place (작업 10 §B-10).
 */

export class TradingAccountScopeMismatchError extends Error {
  readonly endpoint: string;
  readonly expectedAccountId: string;
  readonly actualAccountId: string;
  /**
   * Routed through the normal integrity path so this renders with the same
   * fail-closed copy as a server-detected scope fault, not as a network blip.
   */
  readonly serverCode = 'TRADING_ACCOUNT_SCOPE_MISMATCH';

  constructor(params: {
    endpoint: string;
    expectedAccountId: string;
    actualAccountId: string;
  }) {
    super(
      `Account scope mismatch on ${params.endpoint}: requested ${params.expectedAccountId}, response named ${params.actualAccountId}.`,
    );
    this.name = 'TradingAccountScopeMismatchError';
    this.endpoint = params.endpoint;
    this.expectedAccountId = params.expectedAccountId;
    this.actualAccountId = params.actualAccountId;
  }
}

export function isTradingAccountScopeMismatchError(
  error: unknown,
): error is TradingAccountScopeMismatchError {
  return error instanceof TradingAccountScopeMismatchError;
}

type MaybeScoped = { tradingAccountId?: unknown } | null | undefined;

/**
 * Reads the account id a response claims, if it carries one at a place this
 * surface actually uses. Nested lookups are limited to the two shapes the
 * backend really returns (`data.tradingAccountId`, and `data.order` /
 * `data.quote` style rows) — not a recursive search, which would start finding
 * unrelated fields and turn a safety check into a guessing game.
 */
function readResponseAccountId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;

  const direct = (payload as MaybeScoped)?.tradingAccountId;
  if (typeof direct === 'string' && direct) return direct;

  for (const key of ['order', 'quote', 'execution', 'claim'] as const) {
    const nested = (payload as Record<string, unknown>)[key];
    if (nested && typeof nested === 'object') {
      const nestedId = (nested as MaybeScoped)?.tradingAccountId;
      if (typeof nestedId === 'string' && nestedId) return nestedId;
    }
  }

  return null;
}

/**
 * Returns the payload unchanged when the response either omits its account id
 * or names the requested one; throws otherwise.
 */
export function assertAccountScope<T>(
  endpoint: string,
  expectedAccountId: string,
  payload: T,
): T {
  const actualAccountId = readResponseAccountId(payload);

  if (actualAccountId === null || actualAccountId === expectedAccountId) {
    return payload;
  }

  // Endpoint + the two ids only. See the LOGGING note above.
  console.error(
    JSON.stringify({
      event: 'trading_account_response_scope_mismatch',
      endpoint,
      expectedAccountId,
      actualAccountId,
    }),
  );

  throw new TradingAccountScopeMismatchError({
    endpoint,
    expectedAccountId,
    actualAccountId,
  });
}
