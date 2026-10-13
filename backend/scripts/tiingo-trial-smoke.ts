import 'reflect-metadata';
import { WebSocket as WsWebSocket } from 'ws';
import { findPreviousMarketSession } from '../src/orders/market-calendar.policy';
import {
  readTiingoConfig,
  TiingoConfigService,
  toTiingoTicker,
} from '../src/providers/tiingo/tiingo.config';
import { tiingoFailureCode } from '../src/providers/tiingo/tiingo.errors';
import {
  parseTiingoDailyBars,
  parseTiingoIntradayBars,
  parseTiingoMeta,
  parseTiingoSnapshotResponse,
  parseTiingoWsMessage,
  type TiingoWsChannelKind,
} from '../src/providers/tiingo/tiingo.parser';
import { TiingoRestClient } from '../src/providers/tiingo/tiingo-rest.client';
import {
  classifyUsEquitySegment,
  type UsEquitySessionSegment,
} from '../src/providers/tiingo/tiingo-session';
import { loadRuntimeEnv } from './lib/load-runtime-env';

/**
 * Opt-in REAL Tiingo trial check for ONE symbol (default AAPL).
 *
 *   TIINGO_LIVE_SMOKE=1 TIINGO_API_TOKEN=... pnpm smoke:tiingo-trial
 *
 * Read-only and memory-only: no database access, no file output, at most 8
 * REST requests and two short WebSocket sessions. It prints field presence,
 * counts, timestamps and segment coverage — never a price, size, payload or
 * the token — so the output can be pasted into a report without carrying
 * trial market data. Without the flag it reports NOT_RUN and exits 0, and it
 * is refused under NODE_ENV=production. A check without real data is never a
 * PASS: it is FAIL, PARTIAL or NO_DATA_OUTSIDE_HOURS.
 */

type Verdict = 'PASS' | 'PARTIAL' | 'FAIL' | 'NO_DATA_OUTSIDE_HOURS';
type CheckResult = { verdict: Verdict; facts: Record<string, unknown> };

const SNAPSHOT_FIELDS = [
  'tngoLast',
  'lqRefPrice',
  'prevClose',
  'prevDate',
  'open',
  'high',
  'low',
  'volume',
  'lqSpread',
  'lqBidPrice',
  'lqBidSize',
  'lqAskPrice',
  'lqAskSize',
] as const;

async function main() {
  if ((process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production') {
    console.error(
      'tiingo-trial-smoke is not allowed under NODE_ENV=production.',
    );
    process.exitCode = 1;
    return;
  }
  if (process.env.TIINGO_LIVE_SMOKE !== '1') {
    console.log(
      'tiingo-trial-smoke: NOT_RUN (set TIINGO_LIVE_SMOKE=1 and TIINGO_API_TOKEN to run)',
    );
    return;
  }
  loadRuntimeEnv();
  const symbol = (process.env.TIINGO_SMOKE_SYMBOL ?? 'AAPL')
    .trim()
    .toUpperCase();
  const config = readTiingoConfig({
    ...process.env,
    TIINGO_ENABLED: 'true',
    TIINGO_ALLOWED_SYMBOLS: symbol,
    TIINGO_REST_REQUESTS_PER_MINUTE: '8',
    TIINGO_HTTP_MAX_RETRIES: '0',
  });
  if (!config.enabled) {
    console.log(
      JSON.stringify({
        smoke: 'tiingo-trial',
        result: 'FAIL',
        configError: config.configError,
      }),
    );
    process.exitCode = 1;
    return;
  }
  const rest = new TiingoRestClient(new TiingoConfigService(config));
  const now = new Date();
  const results: Record<string, CheckResult> = {};
  try {
    results.meta = await checkMeta(rest, symbol);
    results.snapshot = await checkSnapshot(rest, symbol, now);
    results.intraday5m = await checkIntraday(rest, symbol, now);
    results.coverage96 = await checkCoverage(rest, symbol, now);
    results.daily = await checkDaily(rest, symbol, now);
    const seconds = Math.min(
      120,
      Math.max(5, Number(process.env.TIINGO_SMOKE_WS_SECONDS ?? 30) || 30),
    );
    results.wsReference = await checkStream(
      config.wsUrl,
      config.token,
      symbol,
      'reference',
      seconds,
    );
    results.wsLiquidity = await checkStream(
      config.wsUrl,
      config.token,
      symbol,
      'liquidity',
      seconds,
    );
  } finally {
    rest.onModuleDestroy();
  }
  const failed = Object.values(results).some(
    (result) => result.verdict === 'FAIL',
  );
  console.log(
    JSON.stringify(
      {
        smoke: 'tiingo-trial',
        symbol,
        ranAt: now.toISOString(),
        marketSegment: classifyUsEquitySegment(now),
        restStatus: {
          ...rest.getStatus(),
          // Counts only; the status already excludes the token and URLs.
        },
        results,
      },
      null,
      2,
    ),
  );
  if (failed) process.exitCode = 1;
}

async function checkMeta(
  rest: TiingoRestClient,
  symbol: string,
): Promise<CheckResult> {
  try {
    const meta = parseTiingoMeta((await rest.getMeta(symbol)).json, symbol);
    return {
      verdict: 'PASS',
      facts: {
        exchangeCode: meta.exchangeCode,
        startDate: meta.startDate,
        endDate: meta.endDate,
      },
    };
  } catch (error) {
    return { verdict: 'FAIL', facts: { errorCode: tiingoFailureCode(error) } };
  }
}

async function checkSnapshot(
  rest: TiingoRestClient,
  symbol: string,
  now: Date,
): Promise<CheckResult> {
  try {
    const result = await rest.getSnapshot(symbol);
    const rows = Array.isArray(result.json) ? result.json : [result.json];
    const row = rows.find(
      (candidate): candidate is Record<string, unknown> =>
        typeof candidate === 'object' &&
        candidate !== null &&
        String((candidate as Record<string, unknown>).ticker).toUpperCase() ===
          symbol,
    );
    const parsed = parseTiingoSnapshotResponse(result.json, symbol);
    const presence = Object.fromEntries(
      SNAPSHOT_FIELDS.map((field) => [
        field,
        row && row[field] !== null && row[field] !== undefined
          ? 'present'
          : 'null',
      ]),
    );
    const effectiveAt = new Date(parsed.timestamp.epochMs);
    return {
      verdict: parsed.referencePrice ? 'PASS' : 'PARTIAL',
      facts: {
        fieldPresence: presence,
        providerTimestamp: parsed.timestamp.iso,
        timestampSegment: classifyUsEquitySegment(effectiveAt),
        ageSeconds: Math.round((now.getTime() - effectiveAt.getTime()) / 1000),
        invalidFieldCount: parsed.invalidFieldCount,
        unknownFields: row
          ? Object.keys(row).filter(
              (key) =>
                key !== 'ticker' &&
                key !== 'timestamp' &&
                !(SNAPSHOT_FIELDS as readonly string[]).includes(key),
            )
          : [],
      },
    };
  } catch (error) {
    return { verdict: 'FAIL', facts: { errorCode: tiingoFailureCode(error) } };
  }
}

async function checkIntraday(
  rest: TiingoRestClient,
  symbol: string,
  now: Date,
): Promise<CheckResult> {
  const asset = { assetType: 'us_stock' as never, market: 'NAS' };
  const previous = findPreviousMarketSession(asset, now, 1);
  if (!previous)
    return { verdict: 'FAIL', facts: { errorCode: 'CALENDAR_UNAVAILABLE' } };
  try {
    const regular = parseTiingoIntradayBars(
      (
        await rest.getIntradayPrices(symbol, {
          startDate: previous.localDate,
          endDate: previous.localDate,
        })
      ).json,
    );
    const extended = parseTiingoIntradayBars(
      (
        await rest.getIntradayPrices(symbol, {
          startDate: previous.localDate,
          endDate: previous.localDate,
          afterHours: true,
        })
      ).json,
    );
    const bySegment = (bars: { openTime: Date }[]) => {
      const counts: Partial<Record<UsEquitySessionSegment, number>> = {};
      for (const bar of bars) {
        const segment = classifyUsEquitySegment(bar.openTime);
        counts[segment] = (counts[segment] ?? 0) + 1;
      }
      return counts;
    };
    const expected = Math.round(
      (previous.closeTime.getTime() - previous.openTime.getTime()) / 300_000,
    );
    const inSession = regular.bars.filter(
      (bar) =>
        bar.openTime >= previous.openTime && bar.openTime < previous.closeTime,
    );
    return {
      verdict:
        inSession.length === expected
          ? 'PASS'
          : inSession.length > 0
            ? 'PARTIAL'
            : 'FAIL',
      facts: {
        sessionDate: previous.localDate,
        expectedRegularBars: expected,
        regularBars: inSession.length,
        volumePresent: regular.bars.filter((bar) => bar.volume !== null).length,
        invalidBars: regular.invalid,
        afterHoursFalseBySegment: bySegment(regular.bars),
        afterHoursTrueBySegment: bySegment(extended.bars),
        firstBarAt: regular.bars[0]?.openTime.toISOString() ?? null,
        lastBarAt: regular.bars.at(-1)?.openTime.toISOString() ?? null,
      },
    };
  } catch (error) {
    return { verdict: 'FAIL', facts: { errorCode: tiingoFailureCode(error) } };
  }
}

/** Does 5m history reach 30 and 96 sessions back? One date each. */
async function checkCoverage(
  rest: TiingoRestClient,
  symbol: string,
  now: Date,
): Promise<CheckResult> {
  const asset = { assetType: 'us_stock' as never, market: 'NAS' };
  const facts: Record<string, unknown> = {};
  let reached = 0;
  for (const back of [30, 96]) {
    const session = findPreviousMarketSession(asset, now, back);
    if (!session) continue;
    try {
      const parsed = parseTiingoIntradayBars(
        (
          await rest.getIntradayPrices(symbol, {
            startDate: session.localDate,
            endDate: session.localDate,
          })
        ).json,
      );
      facts[`sessionsBack${back}`] = {
        date: session.localDate,
        bars: parsed.bars.length,
      };
      if (parsed.bars.length > 0) reached += 1;
    } catch (error) {
      facts[`sessionsBack${back}`] = {
        date: session.localDate,
        errorCode: tiingoFailureCode(error),
      };
    }
  }
  return {
    verdict: reached === 2 ? 'PASS' : reached === 1 ? 'PARTIAL' : 'FAIL',
    facts,
  };
}

async function checkDaily(
  rest: TiingoRestClient,
  symbol: string,
  now: Date,
): Promise<CheckResult> {
  const start = new Date(now.getTime() - 14 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  try {
    const parsed = parseTiingoDailyBars(
      (
        await rest.getDailyPrices(symbol, {
          startDate: start,
          endDate: now.toISOString().slice(0, 10),
        })
      ).json,
    );
    return {
      verdict: parsed.bars.length > 0 ? 'PASS' : 'FAIL',
      facts: {
        bars: parsed.bars.length,
        invalid: parsed.invalid,
        adjustedPresent: parsed.bars.filter((bar) => bar.adjClose !== null)
          .length,
        firstDate: parsed.bars[0]?.date ?? null,
        lastDate: parsed.bars.at(-1)?.date ?? null,
      },
    };
  } catch (error) {
    return { verdict: 'FAIL', facts: { errorCode: tiingoFailureCode(error) } };
  }
}

function checkStream(
  url: string,
  token: string,
  symbol: string,
  channel: TiingoWsChannelKind,
  seconds: number,
): Promise<CheckResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const counts = {
      frames: 0,
      subscribed: 0,
      heartbeats: 0,
      data: 0,
      foreign: 0,
      errors: 0,
      invalid: 0,
    };
    const nullFieldCounts: Record<string, number> = {};
    const segments: Partial<Record<UsEquitySessionSegment, number>> = {};
    let firstDataMs: number | null = null;
    let errorCode: number | null = null;
    let closeCode: number | null = null;
    const socket = new WsWebSocket(url, { handshakeTimeout: 10_000 });
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close(1000, 'smoke finished');
      } catch {
        // Already closed.
      }
      const segment = classifyUsEquitySegment(new Date());
      const verdict: Verdict =
        counts.data > 0
          ? 'PASS'
          : counts.errors > 0 || counts.subscribed === 0
            ? 'FAIL'
            : segment === 'overnight' || segment === 'non_trading_day'
              ? 'NO_DATA_OUTSIDE_HOURS'
              : 'FAIL';
      resolve({
        verdict,
        facts: {
          thresholdLevel: channel === 'reference' ? 6 : 4,
          listenSeconds: seconds,
          ...counts,
          errorResponseCode: errorCode,
          closeCode,
          firstDataAfterMs: firstDataMs,
          dataPerMinute:
            counts.data > 0
              ? Math.round(
                  (counts.data / ((Date.now() - startedAt) / 60_000)) * 10,
                ) / 10
              : 0,
          dataTimestampSegments: segments,
          nullLiquidityFields: nullFieldCounts,
        },
      });
    };
    const timer = setTimeout(finish, seconds * 1000);
    socket.on('open', () => {
      socket.send(
        JSON.stringify({
          eventName: 'subscribe',
          authorization: token,
          eventData: {
            thresholdLevel: channel === 'reference' ? 6 : 4,
            tickers: [toTiingoTicker(symbol)],
          },
        }),
      );
    });
    socket.on('message', (data: Buffer) => {
      counts.frames += 1;
      const message = parseTiingoWsMessage(data.toString('utf8'), channel);
      if (message.kind === 'subscribed') counts.subscribed += 1;
      else if (message.kind === 'heartbeat') counts.heartbeats += 1;
      else if (message.kind === 'error') {
        counts.errors += 1;
        errorCode = message.responseCode;
      } else if (message.kind === 'reference' || message.kind === 'liquidity') {
        if (message.symbol !== symbol) {
          counts.foreign += 1;
          return;
        }
        counts.data += 1;
        firstDataMs ??= Date.now() - startedAt;
        const segment = classifyUsEquitySegment(
          new Date(message.timestamp.epochMs),
        );
        segments[segment] = (segments[segment] ?? 0) + 1;
        if (message.kind === 'liquidity')
          for (const [field, value] of Object.entries(message.liquidity))
            if (value === null)
              nullFieldCounts[field] = (nullFieldCounts[field] ?? 0) + 1;
      } else counts.invalid += 1;
    });
    socket.on('close', (code: number) => {
      closeCode = code;
      if (Date.now() - startedAt < seconds * 1000) finish();
    });
    socket.on('error', () => {
      counts.errors += 1;
    });
  });
}

void main().catch(() => {
  console.error('tiingo-trial-smoke: FAILED (unexpected error)');
  process.exitCode = 1;
});
