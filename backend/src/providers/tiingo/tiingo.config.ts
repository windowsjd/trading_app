import { Inject, Injectable, Optional } from '@nestjs/common';

/**
 * Tiingo US-equity provider (first integration phase, 7-day trial).
 *
 * Trial data is display-only and ephemeral: it lives in process memory and is
 * never written to PostgreSQL, Redis keys, files, logs or queues. The licensed
 * (persistent) mode is reserved and refused until a storage/redistribution
 * license exists, so `TIINGO_TRIAL_MODE=false` fails closed instead of
 * silently behaving like the trial.
 */
export const TIINGO_PROVIDER = 'tiingo' as const;
/** Tiingo consolidated reference price (`tngoLast`, WebSocket thresholdLevel 6). */
export const TIINGO_REFERENCE_PRICE_SOURCE = 'tiingo_equity_reference_price';
/** Statistical liquidity estimate (`lq*`, WebSocket thresholdLevel 4). Never an exchange book. */
export const TIINGO_LIQUIDITY_SOURCE = 'tiingo_equity_liquidity_estimate';
/** Historical intraday bars (`/tiingo/equity/intraday/<ticker>/prices`). */
export const TIINGO_INTRADAY_CANDLE_SOURCE = 'tiingo_equity_intraday';
/** End-of-day bars (`/tiingo/daily/<ticker>/prices`). */
export const TIINGO_EOD_CANDLE_SOURCE = 'tiingo_eod';

/** Trial guard: a small explicit test universe, never the full US list. */
export const TIINGO_MAX_ALLOWED_SYMBOLS = 5;
export const TIINGO_DEFAULT_REST_BASE_URL = 'https://api.tiingo.com';
export const TIINGO_DEFAULT_WS_URL = 'wss://api.tiingo.com/equity/intraday';

export type TiingoConfigErrorCode =
  | 'TIINGO_INVALID_FLAG'
  | 'TIINGO_TOKEN_MISSING'
  | 'TIINGO_ALLOWED_SYMBOLS_EMPTY'
  | 'TIINGO_ALLOWED_SYMBOLS_INVALID'
  | 'TIINGO_ALLOWED_SYMBOLS_LIMIT'
  | 'TIINGO_LICENSED_MODE_UNAVAILABLE'
  | 'TIINGO_URL_INVALID'
  | 'TIINGO_TRIAL_PRODUCTION_BLOCKED';

export type TiingoConfig = {
  /** TIINGO_ENABLED was requested (before validation). */
  requested: boolean;
  /** Requested AND valid. Every Tiingo path checks this, fail closed. */
  enabled: boolean;
  configError: TiingoConfigErrorCode | null;
  /** Backend-only secret. Never logged, returned or stored. */
  token: string;
  restBaseUrl: string;
  wsUrl: string;
  /** Upper-case internal symbols (e.g. AAPL for asset NAS:AAPL). */
  allowedSymbols: readonly string[];
  trialMode: true;
  streamEnabled: boolean;
  liquidityStreamEnabled: boolean;
  httpTimeoutMs: number;
  httpMaxRetries: number;
  maxResponseBytes: number;
  requestsPerMinute: number;
  requestsPerMinutePerSymbol: number;
  requestsPerHour: number;
  wsReconnectMinMs: number;
  wsReconnectMaxMs: number;
  wsHeartbeatTimeoutMs: number;
  wsSubscribeTimeoutMs: number;
};

type Env = Record<string, string | undefined>;

export function readTiingoConfig(env: Env = process.env): TiingoConfig {
  const errors: TiingoConfigErrorCode[] = [];
  const flag = (name: string, fallback: boolean): boolean => {
    const raw = env[name]?.trim();
    if (raw === undefined || raw === '') return fallback;
    if (raw === 'true' || raw === '1') return true;
    if (raw === 'false' || raw === '0') return false;
    errors.push('TIINGO_INVALID_FLAG');
    return fallback;
  };

  const requested = flag('TIINGO_ENABLED', false);
  const trialMode = flag('TIINGO_TRIAL_MODE', true);
  const allowProductionTrial = flag('TIINGO_ALLOW_PRODUCTION_TRIAL', false);
  const streamEnabled = flag('TIINGO_WS_ENABLED', true);
  const liquidityStreamEnabled = flag('TIINGO_WS_LIQUIDITY_ENABLED', true);
  const token = env.TIINGO_API_TOKEN?.trim() ?? '';
  const restBaseUrl = normalizeUrl(
    env.TIINGO_REST_BASE_URL,
    TIINGO_DEFAULT_REST_BASE_URL,
    'https:',
  );
  const wsUrl = normalizeUrl(env.TIINGO_WS_URL, TIINGO_DEFAULT_WS_URL, 'wss:');
  const symbols = readSymbols(env.TIINGO_ALLOWED_SYMBOLS);

  if (requested) {
    if (!token) errors.push('TIINGO_TOKEN_MISSING');
    if (symbols.invalid) errors.push('TIINGO_ALLOWED_SYMBOLS_INVALID');
    else if (symbols.values.length === 0)
      errors.push('TIINGO_ALLOWED_SYMBOLS_EMPTY');
    else if (symbols.values.length > TIINGO_MAX_ALLOWED_SYMBOLS)
      errors.push('TIINGO_ALLOWED_SYMBOLS_LIMIT');
    // Persistent (licensed) storage is not implemented in this phase.
    if (!trialMode) errors.push('TIINGO_LICENSED_MODE_UNAVAILABLE');
    if (!restBaseUrl || !wsUrl) errors.push('TIINGO_URL_INVALID');
    // Trial data must not reach general users: refuse shared/production
    // runtimes unless an internal evaluation deployment opts in explicitly.
    if (isProductionLikeRuntime(env) && !allowProductionTrial)
      errors.push('TIINGO_TRIAL_PRODUCTION_BLOCKED');
  }

  const configError = requested ? (errors[0] ?? null) : null;
  return {
    requested,
    enabled: requested && configError === null,
    configError,
    token,
    restBaseUrl: restBaseUrl ?? TIINGO_DEFAULT_REST_BASE_URL,
    wsUrl: wsUrl ?? TIINGO_DEFAULT_WS_URL,
    allowedSymbols: symbols.invalid
      ? []
      : symbols.values.slice(0, TIINGO_MAX_ALLOWED_SYMBOLS),
    trialMode: true,
    streamEnabled,
    liquidityStreamEnabled,
    httpTimeoutMs: integer(env.TIINGO_HTTP_TIMEOUT_MS, 5_000, 500, 30_000),
    httpMaxRetries: integer(env.TIINGO_HTTP_MAX_RETRIES, 2, 0, 4),
    maxResponseBytes: integer(
      env.TIINGO_HTTP_MAX_RESPONSE_BYTES,
      4_000_000,
      16_384,
      16_000_000,
    ),
    requestsPerMinute: integer(env.TIINGO_REST_REQUESTS_PER_MINUTE, 30, 1, 600),
    requestsPerMinutePerSymbol: integer(
      env.TIINGO_REST_SYMBOL_REQUESTS_PER_MINUTE,
      20,
      1,
      600,
    ),
    requestsPerHour: integer(env.TIINGO_REST_REQUESTS_PER_HOUR, 600, 1, 20_000),
    wsReconnectMinMs: integer(
      env.TIINGO_WS_RECONNECT_MIN_MS,
      1_000,
      250,
      60_000,
    ),
    wsReconnectMaxMs: integer(
      env.TIINGO_WS_RECONNECT_MAX_MS,
      60_000,
      1_000,
      600_000,
    ),
    // Tiingo sends a HeartBeat every 30 seconds; two missed beats = dead.
    wsHeartbeatTimeoutMs: integer(
      env.TIINGO_WS_HEARTBEAT_TIMEOUT_MS,
      75_000,
      35_000,
      600_000,
    ),
    wsSubscribeTimeoutMs: integer(
      env.TIINGO_WS_SUBSCRIBE_TIMEOUT_MS,
      10_000,
      1_000,
      60_000,
    ),
  };
}

/** Internal symbol (NAS:AAPL → AAPL, BRK.B) → Tiingo ticker (aapl, brk-b). */
export function toTiingoTicker(symbol: string): string {
  return symbol.trim().toLowerCase().replace(/\./gu, '-');
}

/** Tiingo ticker (any case) → the internal upper-case symbol it was built from. */
export function fromTiingoTicker(ticker: string): string {
  return ticker.trim().toUpperCase().replace(/-/gu, '.');
}

export function isProductionLikeRuntime(env: Env = process.env): boolean {
  return (
    env.NODE_ENV?.trim() === 'production' ||
    ['true', '1'].includes(env.RENDER?.trim() ?? '')
  );
}

export const TIINGO_CONFIG_OVERRIDE = Symbol('TIINGO_CONFIG_OVERRIDE');

@Injectable()
export class TiingoConfigService {
  private cached: TiingoConfig | null = null;

  constructor(
    @Optional()
    @Inject(TIINGO_CONFIG_OVERRIDE)
    private readonly override?: TiingoConfig,
  ) {}

  getConfig(): TiingoConfig {
    if (this.override) return this.override;
    this.cached ??= readTiingoConfig(process.env);
    return this.cached;
  }
}

function readSymbols(raw: string | undefined): {
  values: string[];
  invalid: boolean;
} {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const part of (raw ?? '').split(',')) {
    const symbol = part.trim().toUpperCase();
    if (!symbol) continue;
    // Plain US equity tickers (share classes as BRK.B); exchange prefixes such
    // as NAS:AAPL are resolved from the Asset row, not from configuration.
    if (!/^[A-Z][A-Z0-9.]{0,9}$/u.test(symbol))
      return { values: [], invalid: true };
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    values.push(symbol);
  }
  return { values, invalid: false };
}

function normalizeUrl(
  raw: string | undefined,
  fallback: string,
  protocol: 'https:' | 'wss:',
): string | null {
  const text = raw?.trim() || fallback;
  try {
    const url = new URL(text);
    // The token is sent to this origin, so only Tiingo hosts are accepted.
    if (
      url.protocol !== protocol ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !(url.hostname === 'tiingo.com' || url.hostname.endsWith('.tiingo.com'))
    )
      return null;
    return url.toString().replace(/\/$/u, '');
  } catch {
    return null;
  }
}

function integer(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const text = raw?.trim();
  if (!text || !/^\d+$/u.test(text)) return fallback;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}
