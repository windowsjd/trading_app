import { readTiingoConfig, TiingoConfigService } from './tiingo.config';
import { TiingoError } from './tiingo.errors';
import {
  parseRetryAfterMs,
  TiingoRestClient,
  type TiingoFetch,
} from './tiingo-rest.client';

const TOKEN = 'synthetic-secret-token';

function createClient(
  env: Record<string, string> = {},
  fetchImpl: jest.Mock = jest.fn(),
) {
  let nowMs = Date.parse('2026-10-13T15:00:00.000Z');
  const sleeps: number[] = [];
  const config = new TiingoConfigService(
    readTiingoConfig({
      TIINGO_ENABLED: 'true',
      TIINGO_API_TOKEN: TOKEN,
      TIINGO_ALLOWED_SYMBOLS: 'AAPL,MSFT',
      ...env,
    }),
  );
  const client = new TiingoRestClient(config, {
    fetch: fetchImpl as unknown as TiingoFetch,
    now: () => nowMs,
    sleep: (ms) => {
      sleeps.push(ms);
      nowMs += ms;
      return Promise.resolve();
    },
  });
  return {
    client,
    fetchImpl,
    sleeps,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

async function failureOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error instanceof TiingoError
      ? { code: error.code, retryAfterMs: error.retryAfterMs }
      : { code: 'NOT_TIINGO', retryAfterMs: null };
  }
  return { code: 'NO_THROW', retryAfterMs: null };
}

describe('TiingoRestClient', () => {
  it('sends the token only in the Authorization header', async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValueOnce(json([{ ticker: 'AAPL' }]));
    const result = await client.getSnapshot('AAPL');
    expect(result.json).toEqual([{ ticker: 'AAPL' }]);
    const [url, init] = fetchImpl.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(url).toBe('https://api.tiingo.com/tiingo/equity/intraday/aapl');
    expect(url.includes(TOKEN)).toBe(false);
    expect(init.headers.Authorization).toBe(`Token ${TOKEN}`);
    expect(JSON.stringify(client.getStatus()).includes(TOKEN)).toBe(false);
  });

  it('requests regular-session 5m bars without force fill', async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValueOnce(json([]));
    await client.getIntradayPrices('AAPL', {
      startDate: '2026-10-01',
      endDate: '2026-10-13',
    });
    const url = new URL((fetchImpl.mock.calls[0] as [string])[0]);
    expect(url.pathname).toBe('/tiingo/equity/intraday/aapl/prices');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      startDate: '2026-10-01',
      endDate: '2026-10-13',
      resampleFreq: '5min',
      columns: 'open,high,low,close,volume',
      afterHours: 'false',
      forceFill: 'false',
    });
  });

  it.each([
    [401, 'TIINGO_UNAUTHORIZED'],
    [403, 'TIINGO_FORBIDDEN'],
    [404, 'TIINGO_NOT_FOUND'],
    [418, 'TIINGO_HTTP_ERROR'],
  ])('does not retry HTTP %i', async (status, code) => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValue(new Response('{"detail":"x"}', { status }));
    expect((await failureOf(client.getSnapshot('AAPL'))).code).toBe(code);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('records the auth state without retaining response text', async () => {
    const { client, fetchImpl } = createClient();
    fetchImpl.mockResolvedValue(
      new Response(`{"detail":"Invalid token ${TOKEN}"}`, { status: 401 }),
    );
    await failureOf(client.getSnapshot('AAPL'));
    const status = client.getStatus();
    expect(status.authState).toBe('unauthorized');
    expect(status.lastErrorCode).toBe('TIINGO_UNAUTHORIZED');
    expect(status.lastHttpStatus).toBe(401);
    expect(JSON.stringify(status).includes(TOKEN)).toBe(false);
  });

  it('retries 5xx a bounded number of times', async () => {
    const { client, fetchImpl, sleeps } = createClient({
      TIINGO_HTTP_MAX_RETRIES: '2',
    });
    fetchImpl.mockResolvedValue(new Response('', { status: 503 }));
    expect((await failureOf(client.getSnapshot('AAPL'))).code).toBe(
      'TIINGO_SERVER_ERROR',
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([250, 750]);
  });

  it('honours a short Retry-After and then succeeds', async () => {
    const { client, fetchImpl, sleeps } = createClient();
    fetchImpl
      .mockResolvedValueOnce(
        new Response('', { status: 429, headers: { 'retry-after': '1' } }),
      )
      .mockResolvedValueOnce(json([{ ticker: 'AAPL' }]));
    await client.getSnapshot('AAPL');
    expect(sleeps).toEqual([1000]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('surfaces a long Retry-After and pauses every later request', async () => {
    const { client, fetchImpl, advance } = createClient();
    fetchImpl.mockResolvedValueOnce(
      new Response('', { status: 429, headers: { 'retry-after': '120' } }),
    );
    expect(await failureOf(client.getSnapshot('AAPL'))).toEqual({
      code: 'TIINGO_RATE_LIMITED',
      retryAfterMs: 120_000,
    });
    // Another endpoint/symbol is refused locally during the cooldown.
    const blocked = await failureOf(client.getMeta('MSFT'));
    expect(blocked.code).toBe('TIINGO_RATE_LIMITED');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(client.getStatus().rateLimitedUntil).not.toBeNull();
    advance(121_000);
    fetchImpl.mockResolvedValueOnce(json({ ticker: 'msft' }));
    await client.getMeta('MSFT');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('enforces the global and per-symbol request budgets locally', async () => {
    const { client, fetchImpl } = createClient({
      TIINGO_REST_REQUESTS_PER_MINUTE: '3',
      TIINGO_REST_SYMBOL_REQUESTS_PER_MINUTE: '2',
    });
    fetchImpl.mockImplementation(() => Promise.resolve(json([])));
    await client.getDailyPrices('AAPL', {
      startDate: '2026-10-01',
      endDate: '2026-10-01',
    });
    await client.getDailyPrices('AAPL', {
      startDate: '2026-10-02',
      endDate: '2026-10-02',
    });
    expect(
      (
        await failureOf(
          client.getDailyPrices('AAPL', {
            startDate: '2026-10-03',
            endDate: '2026-10-03',
          }),
        )
      ).code,
    ).toBe('TIINGO_BUDGET_EXHAUSTED');
    await client.getDailyPrices('MSFT', {
      startDate: '2026-10-01',
      endDate: '2026-10-01',
    });
    expect(
      (
        await failureOf(
          client.getDailyPrices('MSFT', {
            startDate: '2026-10-02',
            endDate: '2026-10-02',
          }),
        )
      ).code,
    ).toBe('TIINGO_BUDGET_EXHAUSTED');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(client.getStatus().budget).toMatchObject({
      minuteUsed: 3,
      minuteLimit: 3,
    });
  });

  it('shares one in-flight request between identical callers', async () => {
    const { client, fetchImpl } = createClient();
    let resolve!: (response: Response) => void;
    fetchImpl.mockReturnValueOnce(
      new Promise<Response>((done) => {
        resolve = done;
      }),
    );
    const first = client.getSnapshot('AAPL');
    const second = client.getSnapshot('AAPL');
    resolve(json([{ ticker: 'AAPL' }]));
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(client.getStatus().sharedRequests).toBe(1);
  });

  it('lets one caller cancel without cancelling the shared request', async () => {
    const { client, fetchImpl } = createClient();
    let resolve!: (response: Response) => void;
    fetchImpl.mockReturnValueOnce(
      new Promise<Response>((done) => {
        resolve = done;
      }),
    );
    const controller = new AbortController();
    const cancelled = client.getSnapshot('AAPL', controller.signal);
    const kept = client.getSnapshot('AAPL');
    controller.abort();
    expect((await failureOf(cancelled)).code).toBe('TIINGO_ABORTED');
    resolve(json([{ ticker: 'AAPL' }]));
    await expect(kept).resolves.toMatchObject({ json: [{ ticker: 'AAPL' }] });
  });

  it('classifies a timeout and a transport failure', async () => {
    const timeout = createClient({
      TIINGO_HTTP_TIMEOUT_MS: '500',
      TIINGO_HTTP_MAX_RETRIES: '0',
    });
    timeout.fetchImpl.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    expect((await failureOf(timeout.client.getSnapshot('AAPL'))).code).toBe(
      'TIINGO_TIMEOUT',
    );
    const transport = createClient({ TIINGO_HTTP_MAX_RETRIES: '0' });
    transport.fetchImpl.mockRejectedValue(new TypeError('fetch failed'));
    expect((await failureOf(transport.client.getSnapshot('AAPL'))).code).toBe(
      'TIINGO_REQUEST_FAILED',
    );
  });

  it('rejects oversized and invalid bodies', async () => {
    const declared = createClient({ TIINGO_HTTP_MAX_RESPONSE_BYTES: '16384' });
    declared.fetchImpl.mockResolvedValueOnce(
      new Response('[]', {
        status: 200,
        headers: { 'content-length': '999999' },
      }),
    );
    expect((await failureOf(declared.client.getSnapshot('AAPL'))).code).toBe(
      'TIINGO_RESPONSE_TOO_LARGE',
    );
    const streamed = createClient({ TIINGO_HTTP_MAX_RESPONSE_BYTES: '16384' });
    streamed.fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ pad: 'x'.repeat(40_000) }), {
        status: 200,
      }),
    );
    expect((await failureOf(streamed.client.getSnapshot('AAPL'))).code).toBe(
      'TIINGO_RESPONSE_TOO_LARGE',
    );
    const invalid = createClient();
    invalid.fetchImpl.mockResolvedValueOnce(
      new Response('<html>', { status: 200 }),
    );
    expect((await failureOf(invalid.client.getSnapshot('AAPL'))).code).toBe(
      'TIINGO_INVALID_JSON',
    );
  });

  it('refuses disabled configuration and non-allow-listed symbols without a call', async () => {
    const disabled = createClient({ TIINGO_ENABLED: 'false' });
    expect((await failureOf(disabled.client.getSnapshot('AAPL'))).code).toBe(
      'TIINGO_DISABLED',
    );
    const missingToken = createClient({ TIINGO_API_TOKEN: '' });
    expect(
      (await failureOf(missingToken.client.getSnapshot('AAPL'))).code,
    ).toBe('TIINGO_DISABLED');
    const scoped = createClient();
    expect((await failureOf(scoped.client.getSnapshot('TSLA'))).code).toBe(
      'TIINGO_SYMBOL_NOT_ALLOWED',
    );
    expect(disabled.fetchImpl).not.toHaveBeenCalled();
    expect(scoped.fetchImpl).not.toHaveBeenCalled();
  });

  it('parses Retry-After seconds and HTTP dates', () => {
    const now = Date.parse('2026-10-13T15:00:00.000Z');
    expect(parseRetryAfterMs('3', now)).toBe(3000);
    expect(parseRetryAfterMs('Tue, 13 Oct 2026 15:00:10 GMT', now)).toBe(
      10_000,
    );
    expect(parseRetryAfterMs('soon', now)).toBeNull();
    expect(parseRetryAfterMs(null, now)).toBeNull();
  });
});
