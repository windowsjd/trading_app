import { Inject, Injectable, Optional } from '@nestjs/common';
import { KIS_FIXED_ASSET_UNIVERSE } from '../kis/kis-fixed-asset-universe';

/**
 * Tiingo US-equity provider.
 *
 * Trial mode (`TIINGO_TRIAL_MODE=true`, the default; 2026-10-14): display-only
 * and ephemeral — data lives in process memory and is never written to
 * PostgreSQL, Redis keys, files, logs or queues; at most 5 allow-listed
 * symbols; production runtimes need an explicit opt-in.
 *
 * Official mode (`TIINGO_TRIAL_MODE=false`; 2026-10-17, user contract): the
 * licensed provider for the US universe. One lease-holding server collects
 * the reference price and persists regular-session snapshots, candles and LOC
 * close evidence (policy-decisions "Tiingo 미국주식 정식 공급자"). The symbol
 * list defaults to the fixed US universe; financial use still requires
 * `US_STOCK_PRICE_PROVIDER=tiingo`.
 */
export const TIINGO_PROVIDER = 'tiingo' as const;
/** Tiingo consolidated reference price (`tngoLast`, WebSocket thresholdLevel 6).
 * Trial display only: memory-only, never stored; the app labels it trial data. */
export const TIINGO_REFERENCE_PRICE_SOURCE = 'tiingo_equity_reference_price';
/**
 * The same reference price stored as an official `asset_price_snapshots` row
 * (official mode, 2026-10-17). A distinct name, so a stored financial price
 * can never be mistaken for the display-only trial value (or the reverse) by
 * eligibility, the realtime fan-out or the app. Equals
 * PROVIDER_SOURCE_NAMES.usStockTiingo.
 */
export const TIINGO_STORED_PRICE_SOURCE = 'tiingo_us_reference_price';
/** Statistical liquidity estimate (`lq*`, WebSocket thresholdLevel 4). Never an exchange book. */
export const TIINGO_LIQUIDITY_SOURCE = 'tiingo_equity_liquidity_estimate';
/** Historical intraday bars (`/tiingo/equity/intraday/<ticker>/prices`). */
export const TIINGO_INTRADAY_CANDLE_SOURCE = 'tiingo_equity_intraday';
/** End-of-day bars (`/tiingo/daily/<ticker>/prices`). */
export const TIINGO_EOD_CANDLE_SOURCE = 'tiingo_eod';

/** Trial guard: a small explicit test universe, never the full US list. */
export const TIINGO_MAX_ALLOWED_SYMBOLS = 5;
/** Official mode: the 25-symbol first phase, room for the 100-symbol phase. */
export const TIINGO_MAX_OFFICIAL_SYMBOLS = 100;
/** Official mode default list: the fixed US universe (Asset IDs unchanged). */
export const TIINGO_DEFAULT_OFFICIAL_SYMBOLS: readonly string[] =
  KIS_FIXED_ASSET_UNIVERSE.filter(
    (entry) => entry.assetType === 'us_stock',
  ).map((entry) => entry.symbol);
export const TIINGO_DEFAULT_REST_BASE_URL = 'https://api.tiingo.com';
export const TIINGO_DEFAULT_WS_URL = 'wss://api.tiingo.com/equity/intraday';

export type TiingoConfigErrorCode =
  | 'TIINGO_INVALID_FLAG'
  | 'TIINGO_TOKEN_MISSING'
  | 'TIINGO_ALLOWED_SYMBOLS_EMPTY'
  | 'TIINGO_ALLOWED_SYMBOLS_INVALID'
  | 'TIINGO_ALLOWED_SYMBOLS_LIMIT'
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
  /** True: memory-only trial. False: official (licensed, persisted) mode. */
  trialMode: boolean;
  /** Official mode: regular-session snapshots/candles/close evidence are stored. */
  persistenceEnabled: boolean;
  /** Official mode: at most one stored reference snapshot per symbol per this interval. */
  snapshotThrottleMs: number;
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
  const explicit = readSymbols(env.TIINGO_ALLOWED_SYMBOLS);
  // Official mode without an explicit list serves the fixed US universe.
  const symbols =
    !trialMode && !explicit.invalid && explicit.values.length === 0
      ? { values: [...TIINGO_DEFAULT_OFFICIAL_SYMBOLS], invalid: false }
      : explicit;
  const maxSymbols = trialMode
    ? TIINGO_MAX_ALLOWED_SYMBOLS
    : TIINGO_MAX_OFFICIAL_SYMBOLS;

  if (requested) {
    if (!token) errors.push('TIINGO_TOKEN_MISSING');
    if (symbols.invalid) errors.push('TIINGO_ALLOWED_SYMBOLS_INVALID');
    else if (symbols.values.length === 0)
      errors.push('TIINGO_ALLOWED_SYMBOLS_EMPTY');
    else if (symbols.values.length > maxSymbols)
      errors.push('TIINGO_ALLOWED_SYMBOLS_LIMIT');
    if (!restBaseUrl || !wsUrl) errors.push('TIINGO_URL_INVALID');
    // Trial data must not reach general users: refuse shared/production
    // runtimes unless an internal evaluation deployment opts in explicitly.
    // The official (licensed) mode is meant for production.
    if (trialMode && isProductionLikeRuntime(env) && !allowProductionTrial)
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
    allowedSymbols: symbols.invalid ? [] : symbols.values.slice(0, maxSymbols),
    trialMode,
    persistenceEnabled: !trialMode,
    snapshotThrottleMs: integer(
      env.TIINGO_SNAPSHOT_THROTTLE_MS,
      5_000,
      1_000,
      60_000,
    ),
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
    // Local self-limits, far below the contract (30,000/hour, 400,000/day).
    requestsPerMinute: integer(
      env.TIINGO_REST_REQUESTS_PER_MINUTE,
      trialMode ? 30 : 120,
      1,
      600,
    ),
    requestsPerMinutePerSymbol: integer(
      env.TIINGO_REST_SYMBOL_REQUESTS_PER_MINUTE,
      20,
      1,
      600,
    ),
    requestsPerHour: integer(
      env.TIINGO_REST_REQUESTS_PER_HOUR,
      trialMode ? 600 : 3_000,
      1,
      20_000,
    ),
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
    // Tiingo's equity socket sends a HeartBeat at subscribe and then every
    // 120 s (measured 2026-10-13/16; not 30 s). Any frame counts as life, so
    // in quiet periods only heartbeats arrive: allow 2.5 intervals before
    // declaring the socket dead. Liveness never refreshes a price's time.
    wsHeartbeatTimeoutMs: integer(
      env.TIINGO_WS_HEARTBEAT_TIMEOUT_MS,
      300_000,
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
