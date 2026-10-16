/**
 * One-off public-data research for the Binance Spot 100 + USDⓈ-M 100 catalog
 * (2026 YTD). No DB, env-file loader, orders, accounts or provisioning.
 *
 * Collection (`--collect`) is the only network step: public GETs from a fixed
 * allowlist, strictly sequential with >= 1 s spacing, through the shared
 * ProviderHttpClient/BinanceRestCoordinator (Redis-backed weight budget,
 * 418/429 cooldown). It requires an explicit loopback REDIS_URL and never
 * retries a rate-limit response. Every raw response is cached; the analysis
 * reads only that cache, so `--replay` recomputes the exact result offline.
 *
 * Calculation: SUM(1d kline[7]) = quote asset volume in USDT, Prisma Decimal
 * precision 80 with an independent BigInt fixed-point cross-check. Completed
 * UTC days only (openTime >= 2026-01-01, closeTime < --end). No annualizing,
 * no 24h ticker, no Mark/OI substitution.
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Prisma } from '../src/generated/prisma/client';
import { ProviderHttpClient } from '../src/providers/provider-http.client';
import { ProviderHttpError } from '../src/providers/provider.types';
import { parseFuturesContracts } from '../src/futures/futures-instrument-coverage';
import { hasSpotPermission } from '../src/providers/binance/binance-exchange-info.validation';
import {
  parseTickSizeDisplayDecimals,
  readPriceFilterTickSize,
} from '../src/providers/binance/binance-tick-size';
import { underlyingExclusion } from './research-binance-futures-2026';

export const START = Date.parse('2026-01-01T00:00:00Z');
export const DAY = 86_400_000;
const SPOT = 'https://api.binance.com';
const FAPI = 'https://fapi.binance.com';
const METADATA =
  'https://www.binance.com/bapi/asset/v2/public/asset/asset/get-all-asset';
const SPOT_LIMIT = 1000;
const FUTURES_LIMIT = 499;
/** Size of each final market (existing entries + new selections). */
export const TARGET = 100;
/** Frozen research inputs: both catalogs as of main ead934cd, before this
 * expansion. Never the runtime constants, which this research extends. */
export const EXISTING_SPOT: readonly string[] = [
  'BTCUSDT',
  'ETHUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'SOLUSDT',
  'TRXUSDT',
  'DOGEUSDT',
  'ZECUSDT',
  'XLMUSDT',
  'LINKUSDT',
  'SUIUSDT',
  'NIGHTUSDT',
  'NEARUSDT',
  'PEPEUSDT',
  'ADAUSDT',
  'TAOUSDT',
  'WLDUSDT',
  'ENAUSDT',
  'AVAXUSDT',
  'UNIUSDT',
  'CHIPUSDT',
  'LTCUSDT',
  'ASTERUSDT',
  '币安人生USDT',
  'TRUMPUSDT',
];
export const EXISTING_FUTURES: readonly string[] = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'ZECUSDT',
  'XRPUSDT',
  'HYPEUSDT',
  'DOGEUSDT',
  'BNBUSDT',
  'SUIUSDT',
  'NEARUSDT',
  'ADAUSDT',
  'WLDUSDT',
  'TAOUSDT',
  'ENAUSDT',
  'LINKUSDT',
  'AVAXUSDT',
  'UNIUSDT',
  'PUMPUSDT',
  'BCHUSDT',
  'TRUMPUSDT',
  'FILUSDT',
  'AAVEUSDT',
  'LTCUSDT',
  'ASTERUSDT',
  'XLMUSDT',
];
/** Same charset the app accepts for Binance Spot crypto symbols (Han included). */
const SPOT_SYMBOL = /^[A-Z0-9\p{Script=Han}]+USDT$/u;
Prisma.Decimal.set({ precision: 80 });

type Kline = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  string,
  number,
  string,
  string,
  string,
];
type SpotSymbol = {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
  isSpotTradingAllowed?: boolean;
  permissions?: string[];
  permissionSets?: string[][];
  filters?: unknown[];
};
type FuturesContract = {
  symbol: string;
  pair: string;
  baseAsset: string;
  contractType: string;
  status: string;
  quoteAsset: string;
  marginAsset: string;
  underlyingType: string;
  onboardDate: number;
  filters?: unknown[];
};
type AssetMetadata = {
  assetCode: string;
  assetName?: string;
  tags?: string[];
  isLegalMoney?: boolean;
  etf?: boolean;
};
export type Window = { start: number; end: number };

const iso = (ms: number) => new Date(ms).toISOString();
const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Spot quote-volume candidates: every currently tradable USDT Spot market. */
export function spotCandidate(row: SpotSymbol): boolean {
  return (
    row.quoteAsset === 'USDT' &&
    row.status === 'TRADING' &&
    hasSpotPermission(row as never)
  );
}

/** Futures quote-volume candidates: every current USDT-margined USDT perpetual. */
export function futuresCandidate(row: FuturesContract): boolean {
  return (
    row.contractType === 'PERPETUAL' &&
    row.status === 'TRADING' &&
    row.quoteAsset === 'USDT' &&
    row.marginAsset === 'USDT'
  );
}

/**
 * Validates and sums one market's completed UTC daily klines. Identical
 * duplicate days count once; conflicting duplicates, unfinished, misaligned or
 * out-of-window rows and non-decimal volumes throw. A day missing between the
 * expected first day and the last completed day makes the aggregate
 * incomplete. Spot has no listing date, so its expected first day is its
 * first provided bar; Futures uses the contract's onboardDate.
 */
export function aggregateDaily(
  payload: unknown,
  window: Window,
  listingTime?: number,
) {
  if (!Array.isArray(payload)) throw new Error('INVALID_KLINE_ARRAY');
  if (
    listingTime !== undefined &&
    (!Number.isSafeInteger(listingTime) || listingTime <= 0)
  )
    throw new Error('INVALID_ONBOARD_DATE');
  const unique = new Map<number, Kline>();
  let duplicates = 0;
  for (const raw of payload as unknown[]) {
    if (!Array.isArray(raw) || raw.length !== 12)
      throw new Error('INVALID_KLINE_ROW');
    const row = raw as Kline;
    const open = row[0];
    if (
      !Number.isSafeInteger(open) ||
      open % DAY !== 0 ||
      open < window.start ||
      open >= window.end ||
      row[6] !== open + DAY - 1 ||
      row[6] >= window.end
    )
      throw new Error('INVALID_OR_INCOMPLETE_UTC_DAY');
    if (typeof row[7] !== 'string' || !/^\d+(?:\.\d+)?$/u.test(row[7]))
      throw new Error('INVALID_QUOTE_VOLUME');
    const previous = unique.get(open);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(row))
        throw new Error('CONFLICTING_DUPLICATE_DAY');
      duplicates++;
    } else unique.set(open, row);
  }
  const rows = [...unique.values()].sort((a, b) => a[0] - b[0]);
  const listingDay =
    listingTime === undefined ? undefined : Math.floor(listingTime / DAY) * DAY;
  const firstBar = rows[0]?.[0];
  // Genuine rows before a later-reset onboardDate are retained, never dropped.
  const expectedStart =
    listingDay === undefined
      ? firstBar
      : Math.max(window.start, Math.min(listingDay, firstBar ?? listingDay));
  const missingDays: string[] = [];
  if (expectedStart !== undefined)
    for (let t = expectedStart; t < window.end; t += DAY)
      if (!unique.has(t)) missingDays.push(iso(t));
  const sum = rows.reduce(
    (total, row) => total.plus(row[7]),
    new Prisma.Decimal(0),
  );
  const scale = Math.max(
    0,
    ...rows.map((row) => row[7].split('.')[1]?.length ?? 0),
  );
  const integerSum = rows.reduce((total, row) => {
    const [whole, fraction = ''] = row[7].split('.');
    return total + BigInt(whole + fraction.padEnd(scale, '0'));
  }, 0n);
  const scaled = sum.mul(new Prisma.Decimal(10).pow(scale));
  if (!scaled.isInteger() || scaled.toFixed(0) !== integerSum.toString())
    throw new Error('DECIMAL_PRECISION_MISMATCH');
  return {
    quoteVolumeUsdt: sum.toFixed(scale),
    dailyBars: rows.length,
    firstOpenTime: rows.length ? iso(rows[0][0]) : null,
    lastOpenTime: rows.length ? iso(rows[rows.length - 1][0]) : null,
    missingDays,
    duplicateDays: duplicates,
    historicalRowsBeforeListing:
      listingDay === undefined
        ? 0
        : rows.filter((row) => row[0] < listingDay).length,
    complete:
      missingDays.length === 0 &&
      (rows.length > 0 ||
        (listingDay !== undefined && listingDay >= window.end)),
  };
}

/** Descending exact quote volume; ties by symbol Unicode code point order. */
export function rankByVolume<
  T extends { symbol: string; quoteVolumeUsdt: string },
>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const byVolume = new Prisma.Decimal(b.quoteVolumeUsdt).comparedTo(
      a.quoteVolumeUsdt,
    );
    if (byVolume) return byVolume;
    return a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
  });
}

/** Existing entries stay in catalog order; new picks follow in rank order. */
export function selectFinal<T extends { symbol: string }>(
  existing: readonly string[],
  eligibleRanked: readonly T[],
  target = TARGET,
) {
  const kept = new Set(existing);
  const added = eligibleRanked
    .filter((row) => !kept.has(row.symbol))
    .slice(0, target - existing.length);
  if (existing.length + added.length !== target)
    throw new Error('INSUFFICIENT_ELIGIBLE_CANDIDATES');
  return { added, final: [...existing, ...added.map((row) => row.symbol)] };
}

function tickDecimals(row: { filters?: unknown[] }) {
  const tickSize = readPriceFilterTickSize(row);
  return { tickSize, decimals: parseTickSizeDisplayDecimals(tickSize) };
}

/** Plain-crypto product policy shared by Spot entries and Futures underlyings. */
export function spotPolicyExclusion(
  row: SpotSymbol,
  metadata: AssetMetadata | undefined,
): string | null {
  if (row.symbol !== `${row.baseAsset}USDT`) return 'symbol_identity_mismatch';
  if (!SPOT_SYMBOL.test(row.symbol)) return 'symbol_identity_unsupported';
  const policy = underlyingExclusion(row.baseAsset, metadata);
  if (policy) return policy;
  const { decimals } = tickDecimals(row);
  // Prices are stored as DECIMAL(24,8): a finer tick cannot be represented.
  if (decimals === null || decimals > 8) return 'price_precision_unsupported';
  return null;
}

type Journal = {
  url: string;
  status: number | null;
  usedWeight1m: string | null;
};

async function collect(cache: string, end: number) {
  const redis = process.env.REDIS_URL ?? '';
  if (!/^redis:\/\/127\.0\.0\.1:\d{4,5}(?:\/\d+)?$/u.test(redis))
    throw new Error('RESEARCH_REQUIRES_EXPLICIT_LOOPBACK_REDIS_URL');
  if (process.env.BINANCE_REST_WEIGHT_BUDGET_PER_MINUTE !== undefined)
    throw new Error('RESEARCH_USES_DEFAULT_REST_BUDGET_ONLY');
  await mkdir(cache, { recursive: true });
  const journal = join(cache, 'requests.jsonl');
  const allowed = new Map([
    [
      'api.binance.com',
      ['/api/v3/time', '/api/v3/exchangeInfo', '/api/v3/klines'],
    ],
    [
      'fapi.binance.com',
      ['/fapi/v1/time', '/fapi/v1/exchangeInfo', '/fapi/v1/klines'],
    ],
    ['www.binance.com', ['/bapi/asset/v2/public/asset/asset/get-all-asset']],
  ]);
  const originalFetch = globalThis.fetch;
  let lastNetworkAt = 0;
  let lastStatus = 0;
  globalThis.fetch = async (...params: Parameters<typeof fetch>) => {
    const input = params[0];
    const url = new URL(
      typeof input === 'string' || input instanceof URL ? input : input.url,
    );
    if (
      !(allowed.get(url.hostname) ?? []).includes(url.pathname) ||
      (params[1]?.method ?? 'GET') !== 'GET'
    )
      throw new Error('PUBLIC_GET_ALLOWLIST_VIOLATION');
    // Strictly sequential, >= 1 s between requests of this research.
    await pause(Math.max(0, 1000 - (performance.now() - lastNetworkAt)));
    lastNetworkAt = performance.now();
    lastStatus = 0;
    const record = { url: url.toString(), sentAt: iso(Date.now()) };
    try {
      const response = await originalFetch(...params);
      lastStatus = response.status;
      await appendFile(
        journal,
        JSON.stringify({
          ...record,
          status: response.status,
          usedWeight1m: response.headers.get('x-mbx-used-weight-1m'),
          providerDate: response.headers.get('date'),
        }) + '\n',
      );
      return response;
    } catch {
      await appendFile(
        journal,
        JSON.stringify({ ...record, status: null, transportFailure: true }) +
          '\n',
      );
      throw new Error('PUBLIC_TRANSPORT_FAILURE');
    }
  };
  const http = new ProviderHttpClient();
  async function get<T>(name: string, url: string): Promise<T> {
    const file = join(cache, `${name}.json`);
    try {
      return JSON.parse(await readFile(file, 'utf8')) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await http.getJson<T>(url, {
          provider: 'binance',
          timeoutMs: 30_000,
        });
        await writeFile(file, JSON.stringify(result.json));
        await writeFile(
          join(cache, `${name}.receipt.json`),
          JSON.stringify({
            url,
            receivedAt: result.receivedAt,
            status: result.status,
          }),
        );
        return result.json;
      } catch (error) {
        // Never retry or wait out a provider restriction: stop and report.
        if (
          (error instanceof ProviderHttpError &&
            [
              'PROVIDER_RATE_LIMITED',
              'BINANCE_REST_COORDINATION_UNAVAILABLE',
            ].includes(error.code)) ||
          [403, 418, 429, 451].includes(lastStatus) ||
          attempt === 3
        )
          throw error;
        await pause(1000 * 2 ** attempt);
      }
    }
  }
  const startedAt = iso(Date.now());
  try {
    const spotTime = await get<{ serverTime: number }>(
      'spot-server-time',
      `${SPOT}/api/v3/time`,
    );
    const futuresTime = await get<{ serverTime: number }>(
      'futures-server-time',
      `${FAPI}/fapi/v1/time`,
    );
    if (
      !Number.isSafeInteger(spotTime.serverTime) ||
      !Number.isSafeInteger(futuresTime.serverTime) ||
      Math.min(spotTime.serverTime, futuresTime.serverTime) < end
    )
      throw new Error('REQUESTED_WINDOW_NOT_COMPLETED_ON_BINANCE');
    const spot = await get<{ symbols: SpotSymbol[] }>(
      'spot-exchange-info',
      `${SPOT}/api/v3/exchangeInfo`,
    );
    const futures = await get<{ symbols: FuturesContract[] }>(
      'futures-exchange-info',
      `${FAPI}/fapi/v1/exchangeInfo`,
    );
    await get('asset-metadata', METADATA);
    const spotSymbols = spot.symbols.filter(spotCandidate);
    const futuresSymbols = futures.symbols.filter(futuresCandidate);
    let done = 0;
    for (const row of spotSymbols) {
      const url = new URL(`${SPOT}/api/v3/klines`);
      for (const [key, value] of Object.entries({
        symbol: row.symbol,
        interval: '1d',
        startTime: START,
        endTime: end - 1,
        limit: SPOT_LIMIT,
      }))
        url.searchParams.set(key, String(value));
      await get(
        `spot-klines-${encodeURIComponent(row.symbol)}`,
        url.toString(),
      );
      if (++done % 50 === 0)
        console.log(JSON.stringify({ spot: done, of: spotSymbols.length }));
    }
    done = 0;
    for (const row of futuresSymbols) {
      const url = new URL(`${FAPI}/fapi/v1/klines`);
      for (const [key, value] of Object.entries({
        symbol: row.symbol,
        interval: '1d',
        startTime: START,
        endTime: end - 1,
        limit: FUTURES_LIMIT,
      }))
        url.searchParams.set(key, String(value));
      await get(
        `futures-klines-${encodeURIComponent(row.symbol)}`,
        url.toString(),
      );
      if (++done % 50 === 0)
        console.log(
          JSON.stringify({ futures: done, of: futuresSymbols.length }),
        );
    }
    await get('spot-exchange-info-final', `${SPOT}/api/v3/exchangeInfo`);
    await get('futures-exchange-info-final', `${FAPI}/fapi/v1/exchangeInfo`);
    // Independent re-collection of each market's top three in two disjoint
    // fresh windows (split at 2026-07-01 UTC) cross-checks the stored series.
    const middle = Date.parse('2026-07-01T00:00:00Z');
    const top = (prefix: string, rows: Array<{ symbol: string }>) =>
      Promise.all(
        rows.map(async (row) => {
          const payload = JSON.parse(
            await readFile(
              join(
                cache,
                `${prefix}-klines-${encodeURIComponent(row.symbol)}.json`,
              ),
              'utf8',
            ),
          ) as Kline[];
          return {
            symbol: row.symbol,
            volume: payload.reduce(
              (sum, k) => sum.plus(k[7]),
              new Prisma.Decimal(0),
            ),
          };
        }),
      ).then((sums) =>
        sums
          .sort((a, b) => b.volume.comparedTo(a.volume))
          .slice(0, 3)
          .map((row) => row.symbol),
      );
    for (const [prefix, base, path, limit, symbols] of [
      [
        'spot',
        SPOT,
        '/api/v3/klines',
        SPOT_LIMIT,
        await top('spot', spotSymbols),
      ],
      [
        'futures',
        FAPI,
        '/fapi/v1/klines',
        FUTURES_LIMIT,
        await top('futures', futuresSymbols),
      ],
    ] as const)
      for (const symbol of symbols)
        for (const [index, [from, until]] of [
          [START, middle],
          [middle, end],
        ].entries()) {
          const url = new URL(`${base}${path}`);
          for (const [key, value] of Object.entries({
            symbol,
            interval: '1d',
            startTime: from,
            endTime: until - 1,
            limit,
          }))
            url.searchParams.set(key, String(value));
          await get(
            `${prefix}-crosscheck-${encodeURIComponent(symbol)}-${index}`,
            url.toString(),
          );
        }
    const lines = (await readFile(journal, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Journal);
    await writeFile(
      join(cache, 'collection.json'),
      JSON.stringify(
        {
          startedAt,
          completedAt: iso(Date.now()),
          endExclusive: iso(end),
          spotServerTime: iso(spotTime.serverTime),
          futuresServerTime: iso(futuresTime.serverTime),
          spotCandidates: spotSymbols.length,
          futuresCandidates: futuresSymbols.length,
          httpRequests: lines.length,
          nonSuccess: lines.filter((line) => line.status !== 200),
          maxUsedWeight1m: Math.max(
            0,
            ...lines.map((line) => Number(line.usedWeight1m ?? 0)),
          ),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await writeFile(
      join(cache, 'blocked.json'),
      JSON.stringify(
        {
          status: 'BLOCKED',
          at: iso(Date.now()),
          lastResponseStatus: lastStatus,
          error:
            error instanceof ProviderHttpError
              ? { code: error.code, rateLimit: error.rateLimit }
              : { message: error instanceof Error ? error.message : 'UNKNOWN' },
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    globalThis.fetch = originalFetch;
    await http.onModuleDestroy();
  }
}

type Row = Record<string, unknown> & {
  symbol: string;
  quoteVolumeUsdt: string;
  complete: boolean;
};

async function analyze(cache: string, output: string, end: number) {
  const window = { start: START, end };
  const read = async <T>(name: string) => {
    const raw = await readFile(join(cache, `${name}.json`), 'utf8');
    return { json: JSON.parse(raw) as T, sha256: sha256(raw) };
  };
  const collection = (await read<Record<string, unknown>>('collection')).json;
  const spotInfo = await read<{ symbols: SpotSymbol[] }>('spot-exchange-info');
  const spotFinal = await read<{ symbols: SpotSymbol[] }>(
    'spot-exchange-info-final',
  );
  const futuresInfo = await read<{ symbols: FuturesContract[] }>(
    'futures-exchange-info',
  );
  const futuresFinal = await read<{ symbols: FuturesContract[] }>(
    'futures-exchange-info-final',
  );
  const metadataFile = await read<{ code: string; data: AssetMetadata[] }>(
    'asset-metadata',
  );
  if (
    metadataFile.json.code !== '000000' ||
    !Array.isArray(metadataFile.json.data)
  )
    throw new Error('ASSET_METADATA_UNAVAILABLE');
  const metadata = new Map(
    metadataFile.json.data.map((row) => [row.assetCode, row]),
  );
  if (metadata.size !== metadataFile.json.data.length)
    throw new Error('DUPLICATE_ASSET_METADATA');
  const spotFinalBySymbol = new Map(
    spotFinal.json.symbols.map((row) => [row.symbol, row]),
  );
  const futuresFinalBySymbol = new Map(
    futuresFinal.json.symbols.map((row) => [row.symbol, row]),
  );
  const spotBySymbol = new Map(
    spotInfo.json.symbols.map((row) => [row.symbol, row]),
  );
  if (spotBySymbol.size !== spotInfo.json.symbols.length)
    throw new Error('DUPLICATE_SPOT_SYMBOL');

  // ---------------------------------------------------------------- Spot
  const spotRows: Row[] = [];
  for (const row of spotInfo.json.symbols.filter(spotCandidate)) {
    const klines = await read<unknown>(
      `spot-klines-${encodeURIComponent(row.symbol)}`,
    );
    const totals = aggregateDaily(klines.json, window);
    const { tickSize, decimals } = tickDecimals(row);
    const meta = metadata.get(row.baseAsset);
    const finalRow = spotFinalBySymbol.get(row.symbol);
    const finallyEligible =
      !!finalRow &&
      spotCandidate(finalRow) &&
      finalRow.baseAsset === row.baseAsset;
    const finalTick = finalRow ? tickDecimals(finalRow) : null;
    const exclusion =
      spotPolicyExclusion(row, meta) ??
      (totals.dailyBars === 0
        ? 'no_completed_daily_bar_in_window'
        : !finallyEligible
          ? 'no_longer_eligible_at_final_validation'
          : null);
    spotRows.push({
      symbol: row.symbol,
      baseAsset: row.baseAsset,
      name: meta?.assetName?.trim() || row.baseAsset,
      ...totals,
      tickSize: finalTick?.tickSize ?? tickSize,
      displayPriceDecimals: finalTick?.decimals ?? decimals,
      metadataTags: meta?.tags ?? [],
      existing: EXISTING_SPOT.includes(row.symbol),
      exclusion,
      payloadSha256: klines.sha256,
    });
  }
  const spotIncomplete = spotRows.filter(
    (row) => !row.complete && row.dailyBars !== 0,
  );
  const spotRanked = rankByVolume(spotRows.filter((row) => row.complete)).map(
    (row, index): Row & { binanceRank: number } => ({
      ...row,
      binanceRank: index + 1,
    }),
  );
  const spotEligible = spotRanked
    .filter((row) => !row.exclusion)
    .map((row, index): Row & { binanceRank: number; policyRank: number } => ({
      ...row,
      policyRank: index + 1,
    }));
  const spotExisting = [...EXISTING_SPOT];
  const spotSelection = selectFinal(spotExisting, spotEligible);
  const spotFinalSet = new Set(spotSelection.final);

  // ------------------------------------------------------------- Futures
  const accepted = parseFuturesContracts(futuresInfo.json);
  const acceptedFinal = parseFuturesContracts(futuresFinal.json);
  const futuresRows: Row[] = [];
  for (const row of futuresInfo.json.symbols.filter(futuresCandidate)) {
    const klines = await read<unknown>(
      `futures-klines-${encodeURIComponent(row.symbol)}`,
    );
    const totals = aggregateDaily(klines.json, window, row.onboardDate);
    const { tickSize, decimals } = tickDecimals(row);
    const spotRow = spotBySymbol.get(row.symbol);
    const finalSpot = spotFinalBySymbol.get(row.symbol);
    const exactSpot =
      !!spotRow &&
      spotCandidate(spotRow) &&
      spotRow.baseAsset === row.baseAsset &&
      !!finalSpot &&
      spotCandidate(finalSpot) &&
      finalSpot.baseAsset === row.baseAsset;
    const meta = metadata.get(row.baseAsset);
    const finalContract = futuresFinalBySymbol.get(row.symbol);
    const finalTick = finalContract ? tickDecimals(finalContract) : null;
    const exclusion = !accepted.has(row.symbol)
      ? 'contract_policy_rejected'
      : !acceptedFinal.has(row.symbol)
        ? 'no_longer_eligible_at_final_validation'
        : !exactSpot
          ? 'exact_spot_underlying_unavailable'
          : (spotPolicyExclusion(spotRow, meta) ??
            (decimals === null ||
            decimals > 8 ||
            finalTick?.decimals === null ||
            (finalTick?.decimals ?? 0) > 8
              ? 'price_precision_unsupported'
              : totals.dailyBars === 0
                ? 'no_completed_daily_bar_in_window'
                : null));
    futuresRows.push({
      symbol: row.symbol,
      baseAsset: row.baseAsset,
      underlyingType: row.underlyingType,
      onboardDate: iso(row.onboardDate),
      name: meta?.assetName?.trim() || row.baseAsset,
      ...totals,
      tickSize: finalTick?.tickSize ?? tickSize,
      displayPriceDecimals: finalTick?.decimals ?? decimals,
      existing: EXISTING_FUTURES.includes(row.symbol),
      exactTradingSpot: exactSpot,
      exclusion,
      payloadSha256: klines.sha256,
    });
  }
  const futuresIncomplete = futuresRows.filter((row) => !row.complete);
  const futuresRanked = rankByVolume(
    futuresRows.filter((row) => row.complete),
  ).map((row, index): Row & { binanceRank: number } => ({
    ...row,
    binanceRank: index + 1,
  }));
  const futuresEligible = futuresRanked
    .filter((row) => !row.exclusion)
    .map((row, index): Row & { binanceRank: number; policyRank: number } => ({
      ...row,
      policyRank: index + 1,
    }));
  const futuresSelection = selectFinal([...EXISTING_FUTURES], futuresEligible);
  const futuresOnly = futuresSelection.final.filter(
    (symbol) => !spotFinalSet.has(symbol),
  );

  // ------------------------------------------------- Existing entries
  const existingStatus = (
    symbols: readonly string[],
    ranked: Array<Row & { binanceRank: number }>,
    rows: Row[],
    eligibleRanked: Array<Row & { policyRank: number }>,
  ) =>
    symbols.map((symbol) => {
      const row = rows.find((r) => r.symbol === symbol);
      return {
        symbol,
        found: !!row,
        binanceRank:
          ranked.find((r) => r.symbol === symbol)?.binanceRank ?? null,
        policyRank:
          eligibleRanked.find((r) => r.symbol === symbol)?.policyRank ?? null,
        quoteVolumeUsdt: row?.quoteVolumeUsdt ?? null,
        exclusion: row ? row.exclusion : 'not_a_current_trading_market',
      };
    });
  /** Last selected vs first unselected new candidate, exact difference. */
  const boundary = (
    eligible: Array<Row & { policyRank: number }>,
    existing: readonly string[],
  ) => {
    const fresh = eligible.filter((row) => !existing.includes(row.symbol));
    const last = fresh[TARGET - existing.length - 1];
    const next = fresh[TARGET - existing.length];
    return {
      lastSelected: last && {
        symbol: last.symbol,
        policyRank: last.policyRank,
        quoteVolumeUsdt: last.quoteVolumeUsdt,
      },
      firstNotSelected: next && {
        symbol: next.symbol,
        policyRank: next.policyRank,
        quoteVolumeUsdt: next.quoteVolumeUsdt,
      },
      differenceUsdt:
        last && next
          ? new Prisma.Decimal(last.quoteVolumeUsdt)
              .minus(next.quoteVolumeUsdt)
              .toFixed()
          : null,
    };
  };
  // The top three of each market were re-collected in two disjoint fresh
  // windows: their concatenation must equal the stored series exactly.
  const crossChecks: Array<Record<string, unknown>> = [];
  for (const [prefix, rows] of [
    ['spot', spotRanked],
    ['futures', futuresRanked],
  ] as const)
    for (const row of rows.slice(0, 3)) {
      const pieces: unknown[] = [];
      for (const index of [0, 1])
        pieces.push(
          ...(
            await read<unknown[]>(
              `${prefix}-crosscheck-${encodeURIComponent(row.symbol)}-${index}`,
            )
          ).json,
        );
      const listing =
        prefix === 'futures'
          ? futuresInfo.json.symbols.find((c) => c.symbol === row.symbol)
              ?.onboardDate
          : undefined;
      const again = aggregateDaily(pieces, window, listing);
      const matched =
        again.complete &&
        again.quoteVolumeUsdt === row.quoteVolumeUsdt &&
        sha256(JSON.stringify(pieces)) ===
          sha256(
            JSON.stringify(
              (
                await read<unknown>(
                  `${prefix}-klines-${encodeURIComponent(row.symbol)}`,
                )
              ).json,
            ),
          );
      crossChecks.push({
        market: prefix,
        symbol: row.symbol,
        method: 'two disjoint fresh windows split at 2026-07-01 UTC',
        dailyBars: again.dailyBars,
        quoteVolumeUsdt: again.quoteVolumeUsdt,
        matched,
      });
      if (!matched) throw new Error(`CROSS_CHECK_MISMATCH_${row.symbol}`);
    }
  const total = (rows: Row[]) =>
    rows
      .reduce(
        (sum, row) => sum.plus(row.quoteVolumeUsdt),
        new Prisma.Decimal(0),
      )
      .toFixed();
  const complete =
    spotIncomplete.length === 0 && futuresIncomplete.length === 0;
  const result = {
    status: complete ? 'COMPLETE' : 'PARTIAL',
    label: '2026 YTD (not annualized)',
    window: {
      startInclusive: iso(START),
      endExclusive: iso(end),
      completedUtcDays: (end - START) / DAY,
    },
    calculation:
      'SUM(1d kline[7] quote asset volume, USDT); Prisma Decimal precision 80 + BigInt fixed-point cross-check; ties by symbol code point',
    sources: {
      spotKlines: `${SPOT}/api/v3/klines?interval=1d&limit=${SPOT_LIMIT}`,
      futuresKlines: `${FAPI}/fapi/v1/klines?interval=1d&limit=${FUTURES_LIMIT}`,
      spotExchangeInfo: `${SPOT}/api/v3/exchangeInfo`,
      futuresExchangeInfo: `${FAPI}/fapi/v1/exchangeInfo`,
      assetMetadata: METADATA,
    },
    collection,
    crossChecks,
    hashes: {
      spotExchangeInfo: spotInfo.sha256,
      spotExchangeInfoFinal: spotFinal.sha256,
      futuresExchangeInfo: futuresInfo.sha256,
      futuresExchangeInfoFinal: futuresFinal.sha256,
      assetMetadata: metadataFile.sha256,
      collectorSource: sha256(
        await readFile(resolve(process.argv[1]), 'utf8').catch(() => ''),
      ),
    },
    spot: {
      candidates: spotRows.length,
      ranked: spotRanked.length,
      zeroBar: spotRows
        .filter((row) => row.dailyBars === 0)
        .map((row) => row.symbol),
      incomplete: spotIncomplete,
      totalQuoteVolumeUsdt: total(spotRanked),
      binanceTop100: spotRanked.slice(0, TARGET),
      policyEligible: spotEligible.length,
      existing: existingStatus(
        spotExisting,
        spotRanked,
        spotRows,
        spotEligible,
      ),
      added: spotSelection.added,
      final: spotSelection.final,
      /** Existing Futures-only underlyings that the Spot ranking selected. */
      formerFuturesOnly: spotSelection.added
        .map((row) => row.symbol)
        .filter(
          (symbol) =>
            EXISTING_FUTURES.includes(symbol) && !spotExisting.includes(symbol),
        ),
      boundary: boundary(spotEligible, spotExisting),
      exclusions: spotRanked.filter((row) => row.exclusion),
    },
    futures: {
      candidates: futuresRows.length,
      coinCandidates: futuresRows.filter((row) => row.underlyingType === 'COIN')
        .length,
      ranked: futuresRanked.length,
      incomplete: futuresIncomplete,
      totalQuoteVolumeUsdt: total(futuresRanked),
      binanceTop100: futuresRanked.slice(0, TARGET),
      binanceTop100Coin: futuresRanked
        .filter((row) => row.underlyingType === 'COIN')
        .slice(0, TARGET),
      policyEligible: futuresEligible.length,
      existing: existingStatus(
        EXISTING_FUTURES,
        futuresRanked,
        futuresRows,
        futuresEligible,
      ),
      added: futuresSelection.added,
      final: futuresSelection.final,
      boundary: boundary(futuresEligible, EXISTING_FUTURES),
      futuresOnlyUnderlyings: futuresOnly.map((symbol) => {
        const row = futuresRows.find((r) => r.symbol === symbol)!;
        return { symbol, baseAsset: row.baseAsset, name: row.name };
      }),
      exclusions: futuresRanked.filter((row) => row.exclusion),
    },
  };
  await mkdir(output, { recursive: true });
  const resultJson = JSON.stringify(result, null, 2);
  await writeFile(join(output, 'result.json'), resultJson);
  // Compact, test-facing artifact: the frozen selection only.
  const pick = (row: Row, fields: string[]) =>
    Object.fromEntries(fields.map((field) => [field, row[field]]));
  await writeFile(
    join(output, 'selection.json'),
    JSON.stringify(
      {
        label: result.label,
        window: result.window,
        resultSha256: sha256(resultJson),
        spot: {
          existing: spotExisting,
          added: spotSelection.added.map((row) =>
            pick(row, [
              'symbol',
              'baseAsset',
              'name',
              'tickSize',
              'displayPriceDecimals',
              'quoteVolumeUsdt',
              'policyRank',
              'binanceRank',
            ]),
          ),
          formerFuturesOnly: result.spot.formerFuturesOnly,
          final: spotSelection.final,
        },
        futures: {
          existing: [...EXISTING_FUTURES],
          added: futuresSelection.added.map((row) =>
            pick(row, [
              'symbol',
              'baseAsset',
              'name',
              'tickSize',
              'displayPriceDecimals',
              'quoteVolumeUsdt',
              'policyRank',
              'binanceRank',
            ]),
          ),
          final: futuresSelection.final,
          displayPriceDecimals: Object.fromEntries(
            futuresSelection.final.map((symbol) => [
              symbol,
              futuresRanked.find((row) => row.symbol === symbol)!
                .displayPriceDecimals,
            ]),
          ),
          futuresOnlyUnderlyings: result.futures.futuresOnlyUnderlyings,
        },
      },
      null,
      2,
    ) + '\n',
  );
  const csv = (fields: string[], rows: Array<Record<string, unknown>>) =>
    fields.join(',') +
    '\n' +
    rows
      .map((row) =>
        fields
          .map((field) => {
            const value = row[field];
            if (value === undefined || value === null) return '""';
            return JSON.stringify(
              Array.isArray(value) ? value.join('|') : String(value as string),
            );
          })
          .join(','),
      )
      .join('\n') +
    '\n';
  const spotFields = [
    'binanceRank',
    'policyRank',
    'symbol',
    'baseAsset',
    'name',
    'quoteVolumeUsdt',
    'dailyBars',
    'firstOpenTime',
    'lastOpenTime',
    'tickSize',
    'displayPriceDecimals',
    'existing',
    'exclusion',
    'metadataTags',
    'payloadSha256',
  ];
  const futuresFields = [
    'binanceRank',
    'policyRank',
    'symbol',
    'baseAsset',
    'name',
    'underlyingType',
    'onboardDate',
    'quoteVolumeUsdt',
    'dailyBars',
    'firstOpenTime',
    'lastOpenTime',
    'tickSize',
    'displayPriceDecimals',
    'existing',
    'exactTradingSpot',
    'exclusion',
    'payloadSha256',
  ];
  const withPolicy = <T extends Row>(
    rows: T[],
    eligible: Array<Row & { policyRank: number }>,
  ) =>
    rows.map((row) => ({
      ...row,
      policyRank:
        eligible.find((entry) => entry.symbol === row.symbol)?.policyRank ??
        null,
    }));
  await writeFile(
    join(output, 'spot-all-candidates.csv'),
    csv(spotFields, [
      ...withPolicy(spotRanked, spotEligible),
      ...spotRows.filter((row) => !row.complete),
    ]),
  );
  await writeFile(
    join(output, 'spot-top100-binance.csv'),
    csv(spotFields, withPolicy(spotRanked.slice(0, TARGET), spotEligible)),
  );
  await writeFile(
    join(output, 'spot-final100.csv'),
    csv(
      ['selection', ...spotFields],
      spotSelection.final.map((symbol) => ({
        selection: spotExisting.includes(symbol) ? 'existing' : 'new',
        ...withPolicy(
          spotRanked.filter((row) => row.symbol === symbol),
          spotEligible,
        )[0],
        symbol,
      })),
    ),
  );
  await writeFile(
    join(output, 'futures-all-contracts.csv'),
    csv(futuresFields, [
      ...withPolicy(futuresRanked, futuresEligible),
      ...futuresIncomplete,
    ]),
  );
  await writeFile(
    join(output, 'futures-top100-binance.csv'),
    csv(
      futuresFields,
      withPolicy(futuresRanked.slice(0, TARGET), futuresEligible),
    ),
  );
  await writeFile(
    join(output, 'futures-final100.csv'),
    csv(
      ['selection', 'futuresOnlyUnderlying', ...futuresFields],
      futuresSelection.final.map((symbol) => ({
        selection: EXISTING_FUTURES.includes(symbol) ? 'existing' : 'new',
        futuresOnlyUnderlying: futuresOnly.includes(symbol),
        ...withPolicy(
          futuresRanked.filter((row) => row.symbol === symbol),
          futuresEligible,
        )[0],
        symbol,
      })),
    ),
  );
  console.log(
    JSON.stringify({
      status: result.status,
      window: result.window,
      spot: {
        candidates: result.spot.candidates,
        ranked: result.spot.ranked,
        incomplete: spotIncomplete.map((row) => row.symbol),
        added: spotSelection.added.map((row) => row.symbol),
      },
      futures: {
        candidates: result.futures.candidates,
        ranked: result.futures.ranked,
        incomplete: futuresIncomplete.map((row) => row.symbol),
        added: futuresSelection.added.map((row) => row.symbol),
        futuresOnly,
      },
    }),
  );
  if (!complete) process.exitCode = 2;
}

async function main() {
  const args = process.argv.slice(2);
  const value = (key: string) => {
    const index = args.indexOf(key);
    if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--'))
      throw new Error(`MISSING_${key}`);
    return args[index + 1];
  };
  const end = Date.parse(value('--end'));
  if (!Number.isSafeInteger(end) || end % DAY !== 0 || end <= START)
    throw new Error('END_MUST_BE_A_UTC_MIDNIGHT_AFTER_START');
  const cache = resolve(value('--cache-dir'));
  const output = resolve(value('--output-dir'));
  if (args.includes('--collect')) {
    // The window must end at or before the last completed UTC day.
    if (end > Math.floor(Date.now() / DAY) * DAY)
      throw new Error('END_IS_NOT_A_COMPLETED_UTC_DAY');
    await collect(cache, end);
  }
  await analyze(cache, output, end);
}

if (process.argv[1]?.endsWith('research-binance-crypto-100-2026.ts'))
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 2;
  });
