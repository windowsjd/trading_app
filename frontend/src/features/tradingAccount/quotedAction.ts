/** One user action retains its executable quote/key across an uncertain response.
 * In particular, a transport retry must NOT obtain a new quote and spend twice.
 * No automatic retries: the caller invokes this only from the final button.
 */
export interface QuotedAction<Request, Quote> {
  readonly request: Request;
  readonly idempotencyKey: string;
  quote?: Quote;
  running?: boolean;
  completed?: boolean;
}

export async function runQuotedAction<Request, Quote, Result>(
  action: QuotedAction<Request, Quote>,
  operations: {
    quote: (request: Request) => Promise<Quote>;
    execute: (request: Request, quote: Quote, key: string) => Promise<Result>;
    isCurrent: () => boolean;
  },
): Promise<{ quote: Quote; result: Result } | null> {
  // Synchronous lock also covers two presses before React renders disabled.
  if (action.running || action.completed || !operations.isCurrent())
    return null;
  action.running = true;
  try {
    action.quote ??= await operations.quote(action.request);
    // A late quote after an account switch/unmount cannot start execution.
    if (!operations.isCurrent()) return null;
    const result = await operations.execute(
      action.request,
      action.quote,
      action.idempotencyKey,
    );
    action.completed = true;
    return { quote: action.quote, result };
  } finally {
    action.running = false;
  }
}
