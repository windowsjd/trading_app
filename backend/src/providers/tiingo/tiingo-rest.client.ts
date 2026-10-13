import { Inject, Injectable, OnModuleDestroy, Optional } from '@nestjs/common';
import {
  TiingoConfigService,
  toTiingoTicker,
  type TiingoConfig,
} from './tiingo.config';
import { TiingoError, type TiingoErrorCode } from './tiingo.errors';

export type TiingoFetchResponse = {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
};

export type TiingoFetch = (
  url: string,
  init: {
    method: 'GET';
    headers: Record<string, string>;
    signal: AbortSignal;
  },
) => Promise<TiingoFetchResponse>;

/** Test seam for transport and clocks; production uses global fetch. */
export type TiingoRestRuntime = {
  fetch?: TiingoFetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};
export const TIINGO_REST_RUNTIME = Symbol('TIINGO_REST_RUNTIME');

export type TiingoRestEndpoint = 'snapshot' | 'intraday' | 'daily' | 'meta';

export type TiingoRestResult = {
  json: unknown;
  receivedAt: Date;
  bytes: number;
};

export type TiingoAuthState = 'unknown' | 'ok' | 'unauthorized' | 'forbidden';

/** Codes, counts and timestamps only. No URL, body or token. */
export type TiingoRestStatus = {
  networkRequests: number;
  sharedRequests: number;
  successes: number;
  failuresByCode: Record<string, number>;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastErrorCode: string | null;
  lastFailureEndpoint: TiingoRestEndpoint | null;
  lastHttpStatus: number | null;
  authState: TiingoAuthState;
  rateLimitedUntil: string | null;
  budget: {
    minuteUsed: number;
    minuteLimit: number;
    hourUsed: number;
    hourLimit: number;
    perSymbolMinuteLimit: number;
  };
};

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** A Retry-After longer than this is surfaced instead of blocking a request. */
const MAX_INLINE_RETRY_WAIT_MS = 2_000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
const RETRY_BACKOFF_MS = [250, 750, 1_500, 3_000];

/**
 * Tiingo REST transport. The token travels only in the Authorization header
 * (never in a URL), the de-duplication key is the token-free URL, and every
 * failure is a fixed `TiingoError` category.
 */
@Injectable()
export class TiingoRestClient implements OnModuleDestroy {
  private readonly inFlight = new Map<string, Promise<TiingoRestResult>>();
  private readonly attempts: number[] = [];
  private readonly symbolAttempts = new Map<string, number[]>();
  private readonly shutdown = new AbortController();
  private readonly fetchImpl: TiingoFetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private rateLimitedUntilMs = 0;
  private readonly counters = {
    networkRequests: 0,
    sharedRequests: 0,
    successes: 0,
    failuresByCode: {} as Record<string, number>,
    lastSuccessAt: null as string | null,
    lastFailureAt: null as string | null,
    lastErrorCode: null as string | null,
    lastFailureEndpoint: null as TiingoRestEndpoint | null,
    lastHttpStatus: null as number | null,
    authState: 'unknown' as TiingoAuthState,
  };

  constructor(
    private readonly configService: TiingoConfigService,
    @Optional() @Inject(TIINGO_REST_RUNTIME) runtime?: TiingoRestRuntime,
  ) {
    this.fetchImpl =
      runtime?.fetch ??
      ((url, init) =>
        fetch(url, init) as unknown as Promise<TiingoFetchResponse>);
    this.now = runtime?.now ?? (() => Date.now());
    this.sleep =
      runtime?.sleep ??
      ((ms) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms);
          timer.unref?.();
        }));
  }

  onModuleDestroy(): void {
    this.shutdown.abort();
    this.inFlight.clear();
  }

  /** `GET /tiingo/equity/intraday/<ticker>` — reference price + liquidity snapshot. */
  getSnapshot(symbol: string, signal?: AbortSignal) {
    return this.request(
      'snapshot',
      symbol,
      `/tiingo/equity/intraday/${encodeURIComponent(toTiingoTicker(symbol))}`,
      {},
      signal,
    );
  }

  /**
   * `GET /tiingo/equity/intraday/<ticker>/prices` — 5-minute bars. Regular
   * session only (`afterHours=false`) and never force-filled, so a quiet
   * period stays a gap instead of a copied previous bar.
   */
  getIntradayPrices(
    symbol: string,
    input: { startDate: string; endDate: string; afterHours?: boolean },
    signal?: AbortSignal,
  ) {
    return this.request(
      'intraday',
      symbol,
      `/tiingo/equity/intraday/${encodeURIComponent(toTiingoTicker(symbol))}/prices`,
      {
        startDate: input.startDate,
        endDate: input.endDate,
        resampleFreq: '5min',
        columns: 'open,high,low,close,volume',
        afterHours: input.afterHours ? 'true' : 'false',
        forceFill: 'false',
      },
      signal,
    );
  }

  /** `GET /tiingo/daily/<ticker>/prices` — end-of-day bars (raw + adjusted). */
  getDailyPrices(
    symbol: string,
    input: { startDate: string; endDate: string },
    signal?: AbortSignal,
  ) {
    return this.request(
      'daily',
      symbol,
      `/tiingo/daily/${encodeURIComponent(toTiingoTicker(symbol))}/prices`,
      { startDate: input.startDate, endDate: input.endDate },
      signal,
    );
  }

  /** `GET /tiingo/daily/<ticker>` — security metadata (identity check only). */
  getMeta(symbol: string, signal?: AbortSignal) {
    return this.request(
      'meta',
      symbol,
      `/tiingo/daily/${encodeURIComponent(toTiingoTicker(symbol))}`,
      {},
      signal,
    );
  }

  getStatus(): TiingoRestStatus {
    const config = this.configService.getConfig();
    const now = this.now();
    this.prune(now);
    return {
      networkRequests: this.counters.networkRequests,
      sharedRequests: this.counters.sharedRequests,
      successes: this.counters.successes,
      failuresByCode: { ...this.counters.failuresByCode },
      lastSuccessAt: this.counters.lastSuccessAt,
      lastFailureAt: this.counters.lastFailureAt,
      lastErrorCode: this.counters.lastErrorCode,
      lastFailureEndpoint: this.counters.lastFailureEndpoint,
      lastHttpStatus: this.counters.lastHttpStatus,
      authState: this.counters.authState,
      rateLimitedUntil:
        this.rateLimitedUntilMs > now
          ? new Date(this.rateLimitedUntilMs).toISOString()
          : null,
      budget: {
        minuteUsed: this.attempts.filter((time) => time > now - MINUTE_MS)
          .length,
        minuteLimit: config.requestsPerMinute,
        hourUsed: this.attempts.length,
        hourLimit: config.requestsPerHour,
        perSymbolMinuteLimit: config.requestsPerMinutePerSymbol,
      },
    };
  }

  private request(
    endpoint: TiingoRestEndpoint,
    symbol: string,
    path: string,
    query: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<TiingoRestResult> {
    const config = this.configService.getConfig();
    if (!config.enabled)
      return Promise.reject(
        /* @diagnosticSurface internal: Fixed Tiingo REST category for callers and diagnostics. */ new TiingoError(
          'TIINGO_DISABLED',
        ),
      );
    const normalized = symbol.trim().toUpperCase();
    if (!config.allowedSymbols.includes(normalized))
      return Promise.reject(
        /* @diagnosticSurface internal: Fixed Tiingo REST category for callers and diagnostics. */ new TiingoError(
          'TIINGO_SYMBOL_NOT_ALLOWED',
        ),
      );
    const search = new URLSearchParams(query).toString();
    const url = `${config.restBaseUrl}${path}${search ? `?${search}` : ''}`;
    let shared = this.inFlight.get(url);
    if (shared) {
      this.counters.sharedRequests += 1;
    } else {
      shared = this.execute(endpoint, normalized, url, config).finally(() =>
        this.inFlight.delete(url),
      );
      this.inFlight.set(url, shared);
    }
    return withCallerAbort(shared, signal);
  }

  private async execute(
    endpoint: TiingoRestEndpoint,
    symbol: string,
    url: string,
    config: TiingoConfig,
  ): Promise<TiingoRestResult> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        this.admit(symbol, config);
        const result = await this.fetchOnce(url, config);
        this.counters.successes += 1;
        this.counters.lastSuccessAt = new Date(this.now()).toISOString();
        this.counters.authState = 'ok';
        return result;
      } catch (caught) {
        const failure =
          caught instanceof TiingoError
            ? caught
            : /* @diagnosticSurface internal: Fixed Tiingo REST category for callers and diagnostics. */ new TiingoError(
                'TIINGO_REQUEST_FAILED',
                true,
              );
        if (failure.code === 'TIINGO_RATE_LIMITED' && failure.httpStatus) {
          // A real 429 pauses every Tiingo request, not just this URL.
          this.rateLimitedUntilMs = Math.max(
            this.rateLimitedUntilMs,
            this.now() +
              (failure.retryAfterMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS),
          );
        }
        const waitMs = retryDelayMs(failure, attempt);
        const retry =
          waitMs !== null &&
          attempt < config.httpMaxRetries &&
          !this.shutdown.signal.aborted;
        if (!retry) {
          this.recordFailure(endpoint, failure);
          throw failure;
        }
        await this.sleep(waitMs);
      }
    }
  }

  /** Global cooldown after a 429 plus sliding global and per-symbol budgets. */
  private admit(symbol: string, config: TiingoConfig): void {
    const now = this.now();
    if (this.rateLimitedUntilMs > now)
      throw /* @diagnosticSurface internal: Fixed Tiingo REST category for callers and diagnostics. */ new TiingoError(
        'TIINGO_RATE_LIMITED',
        true,
        null,
        this.rateLimitedUntilMs - now,
      );
    this.prune(now);
    const minuteAgo = now - MINUTE_MS;
    const perSymbol = (this.symbolAttempts.get(symbol) ?? []).filter(
      (time) => time > minuteAgo,
    );
    const minuteUsed = this.attempts.filter((time) => time > minuteAgo).length;
    if (
      minuteUsed >= config.requestsPerMinute ||
      perSymbol.length >= config.requestsPerMinutePerSymbol ||
      this.attempts.length >= config.requestsPerHour
    )
      throw /* @diagnosticSurface internal: Fixed Tiingo REST category for callers and diagnostics. */ new TiingoError(
        'TIINGO_BUDGET_EXHAUSTED',
        true,
      );
    this.attempts.push(now);
    perSymbol.push(now);
    this.symbolAttempts.set(symbol, perSymbol);
    this.counters.networkRequests += 1;
  }

  private prune(now: number): void {
    while (this.attempts.length > 0 && this.attempts[0] <= now - HOUR_MS)
      this.attempts.shift();
  }

  private async fetchOnce(
    url: string,
    config: TiingoConfig,
  ): Promise<TiingoRestResult> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), config.httpTimeoutMs);
    timer.unref?.();
    const signal = AbortSignal.any([timeout.signal, this.shutdown.signal]);
    const transportFailure = () =>
      this.shutdown.signal.aborted
        ? /* @diagnosticSurface internal: Fixed Tiingo REST category for callers and diagnostics. */ new TiingoError(
            'TIINGO_ABORTED',
          )
        : timeout.signal.aborted
          ? /* @diagnosticSurface internal: Fixed Tiingo REST category for callers and diagnostics. */ new TiingoError(
              'TIINGO_TIMEOUT',
              true,
            )
          : /* @diagnosticSurface internal: Fixed Tiingo REST category for callers and diagnostics. */ new TiingoError(
              'TIINGO_REQUEST_FAILED',
              true,
            );
    try {
      let response: TiingoFetchResponse;
      try {
        response = await this.fetchImpl(url, {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Token ${config.token}`,
          },
          signal,
        });
      } catch {
        throw transportFailure();
      }
      this.counters.lastHttpStatus = response.status;
      if (!response.ok) {
        await cancelBody(response);
        throw classifyHttpFailure(response, this.now());
      }
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > config.maxResponseBytes) {
        await cancelBody(response);
        throw /* @diagnosticSurface internal: Fixed Tiingo REST category for callers and diagnostics. */ new TiingoError(
          'TIINGO_RESPONSE_TOO_LARGE',
        );
      }
      let body: { text: string; bytes: number };
      try {
        body = await readBodyLimited(response, config.maxResponseBytes);
      } catch (error) {
        if (error instanceof TiingoError) throw error;
        throw transportFailure();
      }
      let json: unknown;
      try {
        json = JSON.parse(body.text);
      } catch {
        throw /* @diagnosticSurface internal: Fixed Tiingo REST category for callers and diagnostics. */ new TiingoError(
          'TIINGO_INVALID_JSON',
        );
      }
      return { json, receivedAt: new Date(this.now()), bytes: body.bytes };
    } finally {
      clearTimeout(timer);
    }
  }

  private recordFailure(
    endpoint: TiingoRestEndpoint,
    failure: TiingoError,
  ): void {
    const code: TiingoErrorCode = failure.code;
    this.counters.failuresByCode[code] =
      (this.counters.failuresByCode[code] ?? 0) + 1;
    this.counters.lastFailureAt = new Date(this.now()).toISOString();
    this.counters.lastErrorCode = code;
    this.counters.lastFailureEndpoint = endpoint;
    if (code === 'TIINGO_UNAUTHORIZED')
      this.counters.authState = 'unauthorized';
    if (code === 'TIINGO_FORBIDDEN') this.counters.authState = 'forbidden';
  }
}

/**
 * Inline retry delay, or null when the failure must surface now: 401/403/404,
 * local admission refusals (cooldown/budget), and server waits longer than a
 * request can reasonably block.
 */
function retryDelayMs(failure: TiingoError, attempt: number): number | null {
  if (!failure.retryable) return null;
  if (
    failure.httpStatus === null &&
    (failure.code === 'TIINGO_RATE_LIMITED' ||
      failure.code === 'TIINGO_BUDGET_EXHAUSTED')
  )
    return null;
  const backoff =
    RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)];
  if (failure.code === 'TIINGO_RATE_LIMITED') {
    return failure.retryAfterMs !== null &&
      failure.retryAfterMs <= MAX_INLINE_RETRY_WAIT_MS
      ? Math.max(failure.retryAfterMs, backoff)
      : null;
  }
  if (failure.retryAfterMs !== null) {
    return failure.retryAfterMs <= MAX_INLINE_RETRY_WAIT_MS
      ? Math.max(failure.retryAfterMs, backoff)
      : null;
  }
  return backoff;
}

function classifyHttpFailure(
  response: TiingoFetchResponse,
  nowMs: number,
): TiingoError {
  const status = response.status;
  if (status === 401)
    return /* @diagnosticSurface internal: Fixed Tiingo REST category for callers and diagnostics. */ new TiingoError(
      'TIINGO_UNAUTHORIZED',
      false,
      status,
    );
  if (status === 403)
    return /* @diagnosticSurface internal: Fixed Tiingo REST category for callers and diagnostics. */ new TiingoError(
      'TIINGO_FORBIDDEN',
      false,
      status,
    );
  if (status === 404)
    return /* @diagnosticSurface internal: Fixed Tiingo REST category for callers and diagnostics. */ new TiingoError(
      'TIINGO_NOT_FOUND',
      false,
      status,
    );
  if (status === 429)
    return /* @diagnosticSurface internal: Fixed Tiingo REST category for callers and diagnostics. */ new TiingoError(
      'TIINGO_RATE_LIMITED',
      true,
      status,
      parseRetryAfterMs(response.headers.get('retry-after'), nowMs),
    );
  if (status >= 500)
    return /* @diagnosticSurface internal: Fixed Tiingo REST category for callers and diagnostics. */ new TiingoError(
      'TIINGO_SERVER_ERROR',
      true,
      status,
      parseRetryAfterMs(response.headers.get('retry-after'), nowMs),
    );
  return /* @diagnosticSurface internal: Fixed Tiingo REST category for callers and diagnostics. */ new TiingoError(
    'TIINGO_HTTP_ERROR',
    false,
    status,
  );
}

/** Retry-After as delta-seconds or an HTTP date; null when absent/invalid. */
export function parseRetryAfterMs(
  value: string | null,
  nowMs: number,
): number | null {
  const text = value?.trim();
  if (!text) return null;
  if (/^\d{1,6}$/u.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

async function readBodyLimited(
  response: TiingoFetchResponse,
  maxBytes: number,
): Promise<{ text: string; bytes: number }> {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = await response.text();
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > maxBytes)
      throw /* @diagnosticSurface internal: Fixed Tiingo REST category for callers and diagnostics. */ new TiingoError(
        'TIINGO_RESPONSE_TOO_LARGE',
      );
    return { text, bytes };
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw /* @diagnosticSurface internal: Fixed Tiingo REST category for callers and diagnostics. */ new TiingoError(
        'TIINGO_RESPONSE_TOO_LARGE',
      );
    }
    chunks.push(value);
  }
  return {
    text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
      'utf8',
    ),
    bytes,
  };
}

async function cancelBody(response: TiingoFetchResponse): Promise<void> {
  // The error body is released unread: it may echo request details.
  await response.body?.cancel().catch(() => undefined);
}

/** A caller may stop waiting; a shared request keeps serving other callers. */
function withCallerAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted)
    return Promise.reject(
      /* @diagnosticSurface internal: Fixed Tiingo REST category for callers and diagnostics. */ new TiingoError(
        'TIINGO_ABORTED',
      ),
    );
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(
        /* @diagnosticSurface internal: Fixed Tiingo REST category for callers and diagnostics. */ new TiingoError(
          'TIINGO_ABORTED',
        ),
      );
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(
          error instanceof Error
            ? error
            : /* @diagnosticSurface internal: Fixed Tiingo REST category for callers and diagnostics. */ new TiingoError(
                'TIINGO_REQUEST_FAILED',
              ),
        );
      },
    );
  });
}
