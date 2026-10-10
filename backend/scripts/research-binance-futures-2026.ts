/** One-off public-data research. No DB, env-file loader, orders or provisioning. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Prisma } from '../src/generated/prisma/client';
import { ProviderHttpClient } from '../src/providers/provider-http.client';
import { ProviderHttpError } from '../src/providers/provider.types';
import { parseFuturesContracts } from '../src/futures/futures-instrument-coverage';
import { BINANCE_FIXED_ASSET_UNIVERSE } from '../src/providers/binance/binance-fixed-asset-universe';
import { hasSpotPermission } from '../src/providers/binance/binance-exchange-info.validation';

export const START = Date.parse('2026-01-01T00:00:00Z');
export const END = Date.parse('2026-10-10T00:00:00Z');
const DAY = 86400000;
const LIMIT = 499;
Prisma.Decimal.set({ precision: 80 });
type Contract = {
  symbol: string;
  pair: string;
  baseAsset: string;
  contractType: string;
  status: string;
  quoteAsset: string;
  marginAsset: string;
  underlyingType: string;
  onboardDate: number;
};
type ExchangeInfo = { symbols: Contract[]; rateLimits: unknown[] };
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
const date = (ms: number) => new Date(ms).toISOString();
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
type AssetMetadata = {
  assetCode: string;
  tags?: string[];
  isLegalMoney?: boolean;
  etf?: boolean;
};

/** Same plain-crypto exclusions as the existing frozen Spot universe research. */
export function underlyingExclusion(base: string, metadata?: AssetMetadata) {
  if (!metadata) return 'asset_metadata_missing';
  const tags = new Set(metadata.tags ?? []);
  if (tags.has('stablecoin') || base === 'USTC') return 'stablecoin';
  if (metadata.isLegalMoney) return 'fiat';
  if (['WBTC', 'WBETH', 'BNSOL'].includes(base))
    return 'wrapped_or_staked_representation';
  if (tags.has('tCommodities')) return 'commodity_pegged_representation';
  if (tags.has('bStocks')) return 'tokenized_stock_or_etf';
  if (metadata.etf) return 'leveraged_or_derivative_token';
  return null;
}

export function basicEligible(row: Contract) {
  return (
    row.contractType === 'PERPETUAL' &&
    row.status === 'TRADING' &&
    row.quoteAsset === 'USDT' &&
    row.marginAsset === 'USDT'
  );
}

export function aggregate(contract: Contract, payload: unknown) {
  if (!Number.isSafeInteger(contract.onboardDate) || contract.onboardDate <= 0)
    throw new Error('INVALID_ONBOARD_DATE');
  if (!Array.isArray(payload)) throw new Error('INVALID_KLINE_ARRAY');
  const unique = new Map<number, Kline>();
  let duplicates = 0;
  for (const raw of payload) {
    if (!Array.isArray(raw) || raw.length !== 12)
      throw new Error('INVALID_KLINE_ROW');
    const row = raw as Kline;
    const [open] = row;
    if (
      !Number.isSafeInteger(open) ||
      open % DAY !== 0 ||
      open < START ||
      open >= END ||
      row[6] !== open + DAY - 1 ||
      row[6] >= END
    )
      throw new Error('INVALID_OR_INCOMPLETE_UTC_DAY');
    if (typeof row[7] !== 'string' || !/^\d+(?:\.\d+)?$/.test(row[7]))
      throw new Error('INVALID_QUOTE_VOLUME');
    if (unique.has(open)) {
      if (JSON.stringify(unique.get(open)) !== JSON.stringify(row))
        throw new Error('CONFLICTING_DUPLICATE_DAY');
      duplicates++;
    } else unique.set(open, row);
  }
  const rows = [...unique.values()].sort((a, b) => a[0] - b[0]);
  const listingDay = Math.floor(contract.onboardDate / DAY) * DAY;
  // Retain genuine historical rows even if Binance later reset onboardDate.
  const expectedStart = Math.max(
    START,
    Math.min(listingDay, rows[0]?.[0] ?? listingDay),
  );
  const missingDays: string[] = [];
  for (let t = expectedStart; t < END; t += DAY)
    if (!unique.has(t)) missingDays.push(date(t));
  const sum = rows.reduce(
    (value, row) => value.plus(row[7]),
    new Prisma.Decimal(0),
  );
  // Independent fixed-point integer check catches Decimal rounding, not just float errors.
  const scale = Math.max(
    0,
    ...rows.map((row) => row[7].split('.')[1]?.length ?? 0),
  );
  const integerSum = rows.reduce((value, row) => {
    const [whole, fraction = ''] = row[7].split('.');
    return value + BigInt(whole + fraction.padEnd(scale, '0'));
  }, 0n);
  const decimalScaled = sum.mul(new Prisma.Decimal(10).pow(scale));
  if (
    !decimalScaled.isInteger() ||
    decimalScaled.toFixed(0) !== integerSum.toString()
  )
    throw new Error('DECIMAL_PRECISION_MISMATCH');
  return {
    quoteVolumeUsdt: sum.toFixed(scale),
    dailyBars: rows.length,
    firstOpenTime: rows.length ? date(rows[0][0]) : null,
    lastOpenTime: rows.length ? date(rows[rows.length - 1][0]) : null,
    expectedDays: Math.max(0, (END - expectedStart) / DAY),
    preListingDays: Math.max(0, (Math.min(END, listingDay) - START) / DAY),
    missingDays,
    duplicateDays: duplicates,
    historicalRowsBeforeOnboardDate: rows.filter((row) => row[0] < listingDay)
      .length,
    complete:
      missingDays.length === 0 && (rows.length > 0 || listingDay >= END),
    decimalIntegerCrossCheck: true,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const replay = args.includes('--replay');
  const verify = args.includes('--verify');
  const getArg = (key: string, fallback: string) => {
    const i = args.indexOf(key);
    if (i >= 0 && !args[i + 1]) throw new Error(`MISSING_${key}`);
    return i >= 0 ? args[i + 1] : fallback;
  };
  const cache = resolve(
    getArg('--cache-dir', '/tmp/binance-futures-2026-research/cache'),
  );
  const output = resolve(
    getArg('--output-dir', '/tmp/binance-futures-2026-research/result'),
  );
  const known = args.filter(
    (v, i) =>
      v === '--replay' ||
      v === '--verify' ||
      v === '--cache-dir' ||
      v === '--output-dir' ||
      (i > 0 && ['--cache-dir', '--output-dir'].includes(args[i - 1])),
  );
  if (known.length !== args.length) throw new Error('UNKNOWN_ARGUMENT');
  if (!replay && process.env.REDIS_URL !== 'redis://127.0.0.1:56611')
    throw new Error('RESEARCH_REQUIRES_DEDICATED_LOOPBACK_REDIS_56611');
  await mkdir(cache, { recursive: true });
  await mkdir(output, { recursive: true });
  const journal = join(cache, 'requests.jsonl');
  const originalFetch = globalThis.fetch;
  let lastNetworkAt = 0;
  let lastStatus = 0;
  globalThis.fetch = async (...params: Parameters<typeof fetch>) => {
    const input = params[0];
    const url = new URL(
      typeof input === 'string' || input instanceof URL ? input : input.url,
    );
    if (
      !['fapi.binance.com', 'api.binance.com', 'www.binance.com'].includes(
        url.hostname,
      ) ||
      ![
        '/fapi/v1/exchangeInfo',
        '/fapi/v1/klines',
        '/fapi/v1/time',
        '/api/v3/exchangeInfo',
        '/bapi/asset/v2/public/asset/asset/get-all-asset',
      ].includes(url.pathname) ||
      (params[1]?.method ?? 'GET') !== 'GET'
    )
      throw new Error('PUBLIC_GET_ALLOWLIST_VIOLATION');
    await pause(Math.max(0, 1000 - (performance.now() - lastNetworkAt)));
    lastNetworkAt = performance.now();
    lastStatus = 0;
    const record = { url: url.toString(), sentAt: date(Date.now()) };
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
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || replay)
        throw error;
    }
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const result = await http.getJson<T>(url, {
          provider: 'binance',
          timeoutMs: 15000,
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
        if (
          error instanceof ProviderHttpError &&
          [
            'PROVIDER_RATE_LIMITED',
            'BINANCE_REST_COORDINATION_UNAVAILABLE',
          ].includes(error.code)
        )
          throw error;
        if ([403, 418, 429, 451].includes(lastStatus) || attempt === 3)
          throw error;
        await pause(1000 * 2 ** attempt);
      }
    }
    throw new Error('RETRY_EXHAUSTED');
  }
  try {
    const startedAt = date(Date.now());
    const time = await get<{ serverTime: number }>(
      'server-time',
      'https://fapi.binance.com/fapi/v1/time',
    );
    if (!Number.isSafeInteger(time.serverTime) || time.serverTime < END)
      throw new Error('REQUESTED_WINDOW_NOT_COMPLETED_ON_BINANCE');
    const exchange = await get<ExchangeInfo>(
      'exchange-info',
      'https://fapi.binance.com/fapi/v1/exchangeInfo',
    );
    const candidates = exchange.symbols
      .filter(basicEligible)
      .sort((a, b) => (a.symbol < b.symbol ? -1 : 1));
    if (new Set(candidates.map((row) => row.symbol)).size !== candidates.length)
      throw new Error('DUPLICATE_EXCHANGE_SYMBOL');
    const accepted = parseFuturesContracts(exchange);
    const existing = new Set(
      BINANCE_FIXED_ASSET_UNIVERSE.map((row) => row.symbol),
    );
    const spot = await get<{
      symbols: Array<{
        symbol: string;
        baseAsset: string;
        quoteAsset: string;
        status: string;
        isSpotTradingAllowed?: boolean;
      }>;
    }>('spot-exchange-info', 'https://api.binance.com/api/v3/exchangeInfo');
    const spotContracts = new Map(spot.symbols.map((row) => [row.symbol, row]));
    if (spotContracts.size !== spot.symbols.length)
      throw new Error('DUPLICATE_SPOT_SYMBOL');
    const assetMetadata = await get<{ code: string; data: AssetMetadata[] }>(
      'asset-metadata',
      'https://www.binance.com/bapi/asset/v2/public/asset/asset/get-all-asset',
    );
    if (assetMetadata.code !== '000000' || !Array.isArray(assetMetadata.data))
      throw new Error('ASSET_METADATA_UNAVAILABLE');
    const metadataByBase = new Map(
      assetMetadata.data.map((row) => [row.assetCode, row]),
    );
    if (metadataByBase.size !== assetMetadata.data.length)
      throw new Error('DUPLICATE_ASSET_METADATA');
    const results: Array<
      Record<string, unknown> & {
        symbol: string;
        complete: boolean;
        quoteVolumeUsdt?: string;
      }
    > = [];
    const rawLines: string[] = [];
    for (const contract of candidates) {
      const url = new URL('https://fapi.binance.com/fapi/v1/klines');
      for (const [k, v] of Object.entries({
        symbol: contract.symbol,
        interval: '1d',
        startTime: START,
        endTime: END - 1,
        limit: LIMIT,
      }))
        url.searchParams.set(k, String(v));
      const exactSpot = spotContracts.get(contract.symbol);
      const identity = accepted.has(contract.symbol);
      const spotExact =
        !!exactSpot &&
        exactSpot.baseAsset === contract.baseAsset &&
        exactSpot.quoteAsset === 'USDT' &&
        exactSpot.status === 'TRADING' &&
        hasSpotPermission(exactSpot);
      const baseline = {
        symbol: contract.symbol,
        baseAsset: contract.baseAsset,
        pair: contract.pair,
        status: contract.status,
        underlyingType: contract.underlyingType,
        onboardDate: date(contract.onboardDate),
        contractPolicyAccepted: identity,
        existingRepositoryUnderlying: existing.has(contract.symbol),
        exactTradingSpot: spotExact,
        newUnderlyingRequired: !existing.has(contract.symbol),
        underlyingPolicyExclusion: underlyingExclusion(
          contract.baseAsset,
          metadataByBase.get(contract.baseAsset),
        ),
        registrationClass: !identity
          ? 'contract_policy_rejected'
          : !spotExact
            ? 'exact_spot_underlying_unavailable'
            : underlyingExclusion(
                  contract.baseAsset,
                  metadataByBase.get(contract.baseAsset),
                )
              ? 'underlying_policy_rejected'
              : existing.has(contract.symbol)
                ? 'existing_underlying_candidate'
                : 'new_underlying_required',
      };
      try {
        const payload = await get<unknown>(
          `klines-${encodeURIComponent(contract.symbol)}`,
          url.toString(),
        );
        rawLines.push(JSON.stringify({ symbol: contract.symbol, payload }));
        const totals = aggregate(contract, payload);
        results.push({
          ...baseline,
          ...totals,
          payloadSha256: hash(JSON.stringify(payload)),
        });
      } catch (error) {
        if (
          (error instanceof ProviderHttpError &&
            [
              'PROVIDER_RATE_LIMITED',
              'BINANCE_REST_COORDINATION_UNAVAILABLE',
            ].includes(error.code)) ||
          [403, 418, 429, 451].includes(lastStatus)
        )
          throw error;
        results.push({
          ...baseline,
          complete: false,
          error:
            error instanceof ProviderHttpError
              ? error.code
              : error instanceof Error
                ? error.message
                : 'UNKNOWN_COLLECTION_FAILURE',
        });
      }
      if (results.length % 25 === 0 || results.length === candidates.length)
        console.log(
          JSON.stringify({
            progress: results.length,
            candidates: candidates.length,
            incomplete: results.filter((row) => !row.complete).length,
          }),
        );
    }
    const finalExchange = await get<ExchangeInfo>(
      'exchange-info-final',
      'https://fapi.binance.com/fapi/v1/exchangeInfo',
    );
    const initialSignature = JSON.stringify(
      candidates.map((row) => [
        row.symbol,
        row.baseAsset,
        row.pair,
        row.underlyingType,
        row.onboardDate,
      ]),
    );
    const finalSignature = JSON.stringify(
      finalExchange.symbols
        .filter(basicEligible)
        .sort((a, b) => (a.symbol < b.symbol ? -1 : 1))
        .map((row) => [
          row.symbol,
          row.baseAsset,
          row.pair,
          row.underlyingType,
          row.onboardDate,
        ]),
    );
    const universeUnchanged = initialSignature === finalSignature;
    const incomplete = results.filter((row) => !row.complete);
    const rankingComplete = universeUnchanged && incomplete.length === 0;
    const ranked = results
      .filter((row) => row.complete)
      .sort((a, b) => {
        const n = new Prisma.Decimal(b.quoteVolumeUsdt!).comparedTo(
          a.quoteVolumeUsdt!,
        );
        return n || (a.symbol < b.symbol ? -1 : 1);
      })
      .map(
        (
          row,
          i,
        ): Record<string, unknown> & {
          symbol: string;
          complete: boolean;
          quoteVolumeUsdt?: string;
        } => ({
          ...row,
          observedRank: i + 1,
          rank: rankingComplete ? i + 1 : null,
        }),
      );
    const total = ranked.reduce(
      (sum, row) => sum.plus(row.quoteVolumeUsdt!),
      new Prisma.Decimal(0),
    );
    const top = rankingComplete ? ranked.slice(0, 25) : [];
    const coinRanking = ranked.filter((row) => row.underlyingType === 'COIN');
    const policyRanking = ranked.filter((row) => row.contractPolicyAccepted);
    const policyTotal = policyRanking.reduce(
      (sum, row) => sum.plus(row.quoteVolumeUsdt!),
      new Prisma.Decimal(0),
    );
    const coinTotal = coinRanking.reduce(
      (sum, row) => sum.plus(row.quoteVolumeUsdt!),
      new Prisma.Decimal(0),
    );
    const liveCrossChecks: Array<Record<string, unknown>> = [];
    if (verify && rankingComplete) {
      const middle = Date.parse('2026-07-01T00:00:00Z');
      for (const row of top.slice(0, 3)) {
        const pieces: Kline[] = [];
        for (const [index, [from, until]] of [
          [START, middle],
          [middle, END],
        ].entries()) {
          const url = new URL('https://fapi.binance.com/fapi/v1/klines');
          for (const [key, value] of Object.entries({
            symbol: row.symbol,
            interval: '1d',
            startTime: from,
            endTime: until - 1,
            limit: LIMIT,
          }))
            url.searchParams.set(key, String(value));
          const payload = await get<unknown>(
            `verification-${encodeURIComponent(row.symbol)}-${index}`,
            url.toString(),
          );
          if (!Array.isArray(payload))
            throw new Error('VERIFICATION_INVALID_PAYLOAD');
          pieces.push(...(payload as Kline[]));
        }
        const contract = candidates.find(
          (contract) => contract.symbol === row.symbol,
        )!;
        const independent = aggregate(contract, pieces);
        const matched =
          independent.complete &&
          independent.quoteVolumeUsdt === row.quoteVolumeUsdt &&
          hash(JSON.stringify(pieces)) === row.payloadSha256;
        liveCrossChecks.push({
          symbol: row.symbol,
          method: 'Two disjoint fresh API windows split at 2026-07-01 UTC',
          matched,
          dailyBars: independent.dailyBars,
          quoteVolumeUsdt: independent.quoteVolumeUsdt,
          payloadSha256: hash(JSON.stringify(pieces)),
        });
        if (!matched)
          throw new Error(`LIVE_CROSS_CHECK_MISMATCH_${row.symbol}`);
      }
    }
    const registration = rankingComplete
      ? ranked
          .filter(
            (row) => row.registrationClass === 'existing_underlying_candidate',
          )
          .slice(0, 25)
      : [];
    const conditional = rankingComplete
      ? ranked
          .filter(
            (row) =>
              row.contractPolicyAccepted &&
              row.exactTradingSpot &&
              !row.underlyingPolicyExclusion,
          )
          .slice(0, 25)
      : [];
    const requestLines = (await readFile(journal, 'utf8'))
      .trim()
      .split('\n')
      .filter(Boolean);
    const probe = JSON.parse(
      await readFile(join(cache, 'initial-probe.json'), 'utf8').catch(
        () => '{"requests":0}',
      ),
    ) as { requests: number };
    const result = {
      status: rankingComplete ? 'COMPLETE' : 'PARTIAL',
      startedAt,
      completedAt: date(Date.now()),
      replay,
      window: {
        startInclusive: date(START),
        endExclusive: date(END),
        days: (END - START) / DAY,
      },
      calculation:
        'SUM(1d kline[7]) in USDT using Prisma Decimal precision 80; all sums independently checked with BigInt fixed-point arithmetic',
      liveCrossChecks,
      allExchangeContracts: exchange.symbols.length,
      candidateContracts: candidates.length,
      coinContracts: candidates.filter((row) => row.underlyingType === 'COIN')
        .length,
      nonCoinContracts: candidates
        .filter((row) => row.underlyingType !== 'COIN')
        .map((row) => row.symbol),
      completeContracts: ranked.length,
      incompleteContracts: incomplete.length,
      universeUnchanged,
      collectorHttpRequests: requestLines.length,
      initialProbeHttpRequests: probe.requests,
      totalHttpRequests: requestLines.length + probe.requests,
      responseFailures: requestLines
        .map((s) => JSON.parse(s) as { status: number | null })
        .filter((row) => row.status !== 200),
      actualDataStart: ranked
        .map((row) => row.firstOpenTime as string)
        .filter(Boolean)
        .sort()[0],
      actualDataEnd: ranked
        .map((row) => row.lastOpenTime as string)
        .filter(Boolean)
        .sort()
        .at(-1),
      totalQuoteVolumeUsdt: rankingComplete ? total.toFixed() : null,
      top25SharePercent: rankingComplete
        ? top
            .reduce(
              (sum, row) => sum.plus(row.quoteVolumeUsdt!),
              new Prisma.Decimal(0),
            )
            .div(total)
            .mul(100)
            .toFixed(12)
        : null,
      top25: top,
      top25Crypto: rankingComplete ? coinRanking.slice(0, 25) : [],
      cryptoTotalQuoteVolumeUsdt: rankingComplete ? coinTotal.toFixed() : null,
      cryptoTop25SharePercent: rankingComplete
        ? coinRanking
            .slice(0, 25)
            .reduce(
              (sum, row) => sum.plus(row.quoteVolumeUsdt!),
              new Prisma.Decimal(0),
            )
            .div(coinTotal)
            .mul(100)
            .toFixed(12)
        : null,
      strictContractPolicyTop25: rankingComplete
        ? ranked.filter((row) => row.contractPolicyAccepted).slice(0, 25)
        : [],
      strictContractPolicyEligibleCount: policyRanking.length,
      strictContractPolicyTotalQuoteVolumeUsdt: rankingComplete
        ? policyTotal.toFixed()
        : null,
      strictContractPolicyTop25SharePercent: rankingComplete
        ? policyRanking
            .slice(0, 25)
            .reduce(
              (sum, row) => sum.plus(row.quoteVolumeUsdt!),
              new Prisma.Decimal(0),
            )
            .div(policyTotal)
            .mul(100)
            .toFixed(12)
        : null,
      existingUnderlyingTop25: registration,
      conditionalNewUnderlyingTop25: conditional,
      ranking: ranked,
      incomplete,
      existingUnderlyingExclusions: BINANCE_FIXED_ASSET_UNIVERSE.filter(
        (row) => !accepted.has(row.symbol),
      ).map((row) => ({
        symbol: row.symbol,
        reason: !/^[A-Z0-9]+USDT$/.test(row.symbol)
          ? 'symbol_identity_unsupported'
          : exchange.symbols.some(
                (contract) =>
                  contract.symbol.endsWith(row.symbol) &&
                  contract.symbol !== row.symbol,
              )
            ? 'only_multiplier_or_different_symbol_contract'
            : 'no_policy_accepted_exact_contract',
      })),
      exchangeInfoSha256: hash(JSON.stringify(exchange)),
      finalExchangeInfoSha256: hash(JSON.stringify(finalExchange)),
      spotExchangeInfoSha256: hash(JSON.stringify(spot)),
      assetMetadataSha256: hash(JSON.stringify(assetMetadata)),
      collectorSourceSha256: hash(
        await readFile(resolve(process.argv[1]), 'utf8'),
      ),
      databaseVerification:
        'NOT_RUN: repository fixed universe is not proof of current production DB state',
    };
    await writeFile(
      join(output, 'result.json'),
      JSON.stringify(result, null, 2),
    );
    const fields = [
      'rank',
      'selectionRank',
      'symbol',
      'quoteVolumeUsdt',
      'dailyBars',
      'onboardDate',
      'status',
      'underlyingType',
      'contractPolicyAccepted',
      'existingRepositoryUnderlying',
      'exactTradingSpot',
      'newUnderlyingRequired',
      'registrationClass',
      'underlyingPolicyExclusion',
      'complete',
    ];
    const csv = (rows: Array<Record<string, unknown>>) =>
      fields.join(',') +
      '\n' +
      rows
        .map((row, index) =>
          fields
            .map((field) => {
              const value =
                field === 'selectionRank' && rankingComplete
                  ? index + 1
                  : row[field];
              if (value === undefined || value === null) return '""';
              if (!['string', 'number', 'boolean'].includes(typeof value))
                throw new Error('CSV_REQUIRES_SCALAR');
              return JSON.stringify(String(value as string | number | boolean));
            })
            .join(','),
        )
        .join('\n') +
      '\n';
    await writeFile(
      join(output, 'all-contracts.csv'),
      csv([...ranked, ...incomplete]),
    );
    await writeFile(join(output, 'top25-binance.csv'), csv(top));
    await writeFile(
      join(output, 'top25-crypto.csv'),
      csv(rankingComplete ? coinRanking.slice(0, 25) : []),
    );
    await writeFile(
      join(output, 'top25-existing-underlying.csv'),
      csv(registration),
    );
    await writeFile(
      join(output, 'top25-conditional-new-underlying.csv'),
      csv(conditional),
    );
    await writeFile(
      join(output, 'klines.ndjson.gz'),
      gzipSync(rawLines.join('\n') + '\n'),
    );
    await writeFile(
      join(output, 'exchange-info.json'),
      JSON.stringify(exchange),
    );
    await writeFile(
      join(output, 'exchange-info-final.json'),
      JSON.stringify(finalExchange),
    );
    await writeFile(
      join(output, 'spot-exchange-info.json'),
      JSON.stringify(spot),
    );
    await writeFile(
      join(output, 'asset-metadata.json'),
      JSON.stringify(assetMetadata),
    );
    await writeFile(
      join(output, 'requests.jsonl'),
      requestLines.join('\n') + '\n',
    );
    console.log(
      JSON.stringify({
        status: result.status,
        candidates: result.candidateContracts,
        complete: result.completeContracts,
        incomplete: result.incompleteContracts,
        requests: result.totalHttpRequests,
        top25: top.map((row) => row.symbol),
        existingUnderlyingCount: registration.length,
      }),
    );
    if (!rankingComplete) process.exitCode = 2;
  } catch (error) {
    const failure = {
      status: 'BLOCKED',
      at: date(Date.now()),
      lastResponseStatus: lastStatus,
      error:
        error instanceof ProviderHttpError
          ? {
              code: error.code,
              message: error.message,
              rateLimit: error.rateLimit,
            }
          : {
              message:
                error instanceof Error ? error.message : 'UNKNOWN_FAILURE',
            },
      cache,
      finalRanking: 'NOT_ESTABLISHED',
    };
    await writeFile(
      join(output, 'blocked.json'),
      JSON.stringify(failure, null, 2),
    );
    console.log(JSON.stringify(failure));
    process.exitCode = 2;
  } finally {
    globalThis.fetch = originalFetch;
    await http.onModuleDestroy();
  }
}

if (process.argv[1]?.endsWith('research-binance-futures-2026.ts')) void main();
