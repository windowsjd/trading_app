import 'reflect-metadata';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket as WsWebSocket } from 'ws';
import { findPreviousMarketSession } from '../src/orders/market-calendar.policy';
import { usSessionWallTime } from '../src/orders/limit-on-close.policy';
import { KIS_FIXED_ASSET_UNIVERSE } from '../src/providers/kis/kis-fixed-asset-universe';
import {
  TIINGO_DEFAULT_OFFICIAL_SYMBOLS,
  readTiingoConfig,
  TiingoConfigService,
  toTiingoTicker,
} from '../src/providers/tiingo/tiingo.config';
import { tiingoFailureCode } from '../src/providers/tiingo/tiingo.errors';
import { tiingoExchangeMatchesAssetMarket } from '../src/providers/tiingo/tiingo-identity';
import {
  parseTiingoDailyBars,
  parseTiingoIntradayBars,
  parseTiingoMeta,
  parseTiingoWsMessage,
} from '../src/providers/tiingo/tiingo.parser';
import { TiingoRestClient } from '../src/providers/tiingo/tiingo-rest.client';
import { classifyUsEquitySegment } from '../src/providers/tiingo/tiingo-session';
import { loadRuntimeEnv } from './lib/load-runtime-env';

/**
 * Opt-in REAL Tiingo check of the OFFICIAL mode (2026-10-17) for the fixed
 * US universe (100 symbols by default), as the production collector, the US
 * LOC close evidence and the candle sync use Tiingo:
 *
 *   TIINGO_LIVE_SMOKE=1 TIINGO_API_TOKEN=... pnpm smoke:tiingo-official
 *
 * Per symbol: Tiingo's metadata identity (ticker, and the exchange equal to
 * the Asset's NAS/NYS listing), the end-of-day bar of the latest completed New
 * York session (exactly one bar of that date with raw close, volume and
 * adjusted values), that session's regular 5-minute bars (count vs the
 * calendar), and the history depth the charts need: the regular 5m bars of
 * the 96th previous session (the oldest session the 96-session 4h chart is
 * synthesized from) and the end-of-day bar of the 576th previous session (the
 * daily chart). A stock whose Tiingo `startDate` is later than a probed
 * session is reported as listed later, not as missing. When the 96th session
 * has no 5m bars, the first such symbol is bisected once to report how far
 * back Tiingo's intraday history reaches. Then one WebSocket (thresholdLevel
 * 6) for all symbols: per-symbol tick counts and heartbeat spacing.
 *
 * Read-only and memory-only: no database, no file output, REST paced below
 * 40 requests/minute (5 per symbol). It prints counts, dates, booleans and
 * exchange codes — never a price, size, payload or the token. Refused under
 * NODE_ENV=production; without the flag it reports NOT_RUN and exits 0. A
 * check without real data is never PASS.
 */

type Verdict = 'PASS' | 'PARTIAL' | 'FAIL' | 'NO_DATA_OUTSIDE_HOURS';
type SymbolFacts = Record<string, unknown>;
const PACE_MS = 1_600;

async function main() {
  if ((process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production') {
    console.error(
      'tiingo-official-smoke is not allowed under NODE_ENV=production.',
    );
    process.exitCode = 1;
    return;
  }
  if (process.env.TIINGO_LIVE_SMOKE !== '1') {
    console.log(
      'tiingo-official-smoke: NOT_RUN (set TIINGO_LIVE_SMOKE=1 and TIINGO_API_TOKEN to run)',
    );
    return;
  }
  loadRuntimeEnv();
  const requested = (process.env.TIINGO_SMOKE_SYMBOLS ?? '')
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);
  const symbols = requested.length
    ? requested
    : [...TIINGO_DEFAULT_OFFICIAL_SYMBOLS];
  const listing = new Map<string, string>(
    KIS_FIXED_ASSET_UNIVERSE.filter(
      (entry) => entry.assetType === 'us_stock',
    ).map((entry) => [entry.symbol, entry.market]),
  );
  const config = readTiingoConfig({
    ...process.env,
    TIINGO_ENABLED: 'true',
    TIINGO_TRIAL_MODE: 'false',
    TIINGO_ALLOWED_SYMBOLS: symbols.join(','),
    TIINGO_REST_REQUESTS_PER_MINUTE: '40',
    TIINGO_REST_SYMBOL_REQUESTS_PER_MINUTE: '6',
    TIINGO_HTTP_MAX_RETRIES: '0',
  });
  if (!config.enabled) {
    console.log(
      JSON.stringify({
        smoke: 'tiingo-official',
        result: 'FAIL',
        configError: config.configError,
      }),
    );
    process.exitCode = 1;
    return;
  }
  const rest = new TiingoRestClient(new TiingoConfigService(config));
  const now = new Date();
  const asset = { assetType: 'us_stock' as never, market: 'NAS' };
  const session = findPreviousMarketSession(asset, now, 1);
  if (!session) {
    console.log(
      JSON.stringify({
        smoke: 'tiingo-official',
        result: 'FAIL',
        errorCode: 'CALENDAR_UNAVAILABLE',
      }),
    );
    process.exitCode = 1;
    return;
  }
  const expectedBars = Math.round(
    (session.closeTime.getTime() - session.openTime.getTime()) / 300_000,
  );
  // History depth the charts need (frontend chartTimeframes.ts): 96 sessions
  // of 4h (synthesized from stored 5m) and 576 sessions of 1d.
  const depthSession5m = findPreviousMarketSession(asset, now, 96);
  const depthSessionDaily = findPreviousMarketSession(asset, now, 576);
  const perSymbol: Record<string, SymbolFacts> = {};
  const tally = {
    identity: 0,
    eod: 0,
    intraday: 0,
    adjustedDiffers: 0,
    intradayDepth96: 0,
    intradayDepth96ListedLater: 0,
    eodDepth576: 0,
    eodDepth576ListedLater: 0,
  };
  let depthBisectSymbol: string | null = null;
  let intradayHistoryReach: Awaited<
    ReturnType<typeof bisectIntradayReach>
  > | null = null;
  try {
    for (const symbol of symbols) {
      const facts: SymbolFacts = { listing: listing.get(symbol) ?? null };
      perSymbol[symbol] = facts;
      try {
        const meta = parseTiingoMeta((await rest.getMeta(symbol)).json, symbol);
        facts.exchangeCode = meta.exchangeCode;
        facts.startDate = meta.startDate;
        facts.identity = tiingoExchangeMatchesAssetMarket(
          meta.exchangeCode,
          listing.get(symbol) ?? '',
        );
        if (facts.identity) tally.identity += 1;
      } catch (error) {
        facts.identity = false;
        facts.identityError = tiingoFailureCode(error);
      }
      await delay(PACE_MS);
      try {
        const daily = parseTiingoDailyBars(
          (
            await rest.getDailyPrices(symbol, {
              startDate: session.localDate,
              endDate: session.localDate,
            })
          ).json,
        );
        const bar = daily.bars[0];
        const ok =
          daily.invalid === 0 &&
          daily.duplicates === 0 &&
          daily.bars.length === 1 &&
          bar.date === session.localDate &&
          bar.volume !== null &&
          Number(bar.volume) > 0;
        facts.eod = {
          ok,
          bars: daily.bars.length,
          invalid: daily.invalid,
          date: bar?.date ?? null,
          volumePresent: bar ? bar.volume !== null : false,
          adjustedPresent: bar ? bar.adjClose !== null : false,
          adjustedDiffers: bar
            ? bar.adjClose !== null && bar.adjClose !== bar.close
            : false,
        };
        if (ok) tally.eod += 1;
        if (bar && bar.adjClose !== null && bar.adjClose !== bar.close)
          tally.adjustedDiffers += 1;
      } catch (error) {
        facts.eod = { ok: false, errorCode: tiingoFailureCode(error) };
      }
      await delay(PACE_MS);
      try {
        const intraday = parseTiingoIntradayBars(
          (
            await rest.getIntradayPrices(symbol, {
              startDate: session.localDate,
              endDate: session.localDate,
            })
          ).json,
        );
        const regular = intraday.bars.filter(
          (bar) =>
            bar.openTime >= session.openTime &&
            bar.openTime < session.closeTime,
        );
        facts.intraday5m = {
          regularBars: regular.length,
          expected: expectedBars,
          outsideSession: intraday.bars.length - regular.length,
          invalid: intraday.invalid,
        };
        if (regular.length === expectedBars) tally.intraday += 1;
      } catch (error) {
        facts.intraday5m = { errorCode: tiingoFailureCode(error) };
      }
      await delay(PACE_MS);
      const startDate =
        typeof facts.startDate === 'string' ? facts.startDate : null;
      if (depthSession5m) {
        if (startDate !== null && startDate > depthSession5m.localDate) {
          facts.intraday5mDepth96 = { listedLater: true };
          tally.intradayDepth96ListedLater += 1;
        } else {
          const bars = await regularBarsOn(rest, symbol, depthSession5m);
          facts.intraday5mDepth96 = bars;
          if (bars.regularBars === bars.expected) tally.intradayDepth96 += 1;
          else if (bars.regularBars === 0 && depthBisectSymbol === null)
            depthBisectSymbol = symbol;
          await delay(PACE_MS);
        }
      }
      if (depthSessionDaily) {
        if (startDate !== null && startDate > depthSessionDaily.localDate) {
          facts.eodDepth576 = { listedLater: true };
          tally.eodDepth576ListedLater += 1;
        } else {
          try {
            const daily = parseTiingoDailyBars(
              (
                await rest.getDailyPrices(symbol, {
                  startDate: depthSessionDaily.localDate,
                  endDate: depthSessionDaily.localDate,
                })
              ).json,
            );
            const ok =
              daily.bars.length === 1 &&
              daily.bars[0].date === depthSessionDaily.localDate;
            facts.eodDepth576 = { ok, bars: daily.bars.length };
            if (ok) tally.eodDepth576 += 1;
          } catch (error) {
            facts.eodDepth576 = {
              ok: false,
              errorCode: tiingoFailureCode(error),
            };
          }
          await delay(PACE_MS);
        }
      }
    }
    // How far back intraday history reaches, bisected on one symbol only.
    if (depthBisectSymbol !== null)
      intradayHistoryReach = await bisectIntradayReach(
        rest,
        depthBisectSymbol,
        now,
        96,
      );
  } finally {
    rest.onModuleDestroy();
  }
  const seconds = Math.min(
    300,
    Math.max(10, Number(process.env.TIINGO_SMOKE_WS_SECONDS ?? 60) || 60),
  );
  const stream = await checkStream(
    config.wsUrl,
    config.token,
    symbols,
    seconds,
  );
  const verdict = (passed: number): Verdict =>
    passed === symbols.length ? 'PASS' : passed > 0 ? 'PARTIAL' : 'FAIL';
  const earliest = usSessionWallTime(session.localDate, 21 * 60 + 10);
  // Stocks listed after a probed session cannot have it; they are excluded.
  const depthVerdict = (passed: number, listedLater: number): Verdict => {
    const judged = symbols.length - listedLater;
    if (judged === 0) return 'PASS';
    return passed === judged ? 'PASS' : passed > 0 ? 'PARTIAL' : 'FAIL';
  };
  const results = {
    identity: verdict(tally.identity),
    eodLatestSession: verdict(tally.eod),
    intraday5mLatestSession: verdict(tally.intraday),
    intraday5mDepth96Sessions: depthSession5m
      ? depthVerdict(tally.intradayDepth96, tally.intradayDepth96ListedLater)
      : 'FAIL',
    eodDepth576Sessions: depthSessionDaily
      ? depthVerdict(tally.eodDepth576, tally.eodDepth576ListedLater)
      : 'FAIL',
    stream: stream.verdict,
  };
  console.log(
    JSON.stringify(
      {
        smoke: 'tiingo-official',
        ranAt: now.toISOString(),
        marketSegment: classifyUsEquitySegment(now),
        latestCompletedSession: {
          date: session.localDate,
          closeAt: session.closeTime.toISOString(),
          earlyClose: session.earlyClose,
          expectedRegularBars: expectedBars,
          // The US LOC policy observes the close only from 21:10 New York.
          locEvidenceWindowOpen: earliest ? now >= earliest : null,
        },
        symbols: symbols.length,
        historyDepth: {
          intraday5mSession96: depthSession5m?.localDate ?? null,
          dailySession576: depthSessionDaily?.localDate ?? null,
          intradayHistoryReach,
        },
        passed: tally,
        results,
        stream: stream.facts,
        perSymbol,
        restStatus: rest.getStatus(),
      },
      null,
      2,
    ),
  );
  if (Object.values(results).includes('FAIL')) process.exitCode = 1;
}

/** Regular-session 5m bar count of one session (vs the calendar's slots). */
async function regularBarsOn(
  rest: TiingoRestClient,
  symbol: string,
  session: { localDate: string; openTime: Date; closeTime: Date },
): Promise<{
  date: string;
  regularBars: number;
  expected: number;
  errorCode?: string;
}> {
  const expected = Math.round(
    (session.closeTime.getTime() - session.openTime.getTime()) / 300_000,
  );
  try {
    const intraday = parseTiingoIntradayBars(
      (
        await rest.getIntradayPrices(symbol, {
          startDate: session.localDate,
          endDate: session.localDate,
        })
      ).json,
    );
    return {
      date: session.localDate,
      regularBars: intraday.bars.filter(
        (bar) =>
          bar.openTime >= session.openTime && bar.openTime < session.closeTime,
      ).length,
      expected,
    };
  } catch (error) {
    return {
      date: session.localDate,
      regularBars: 0,
      expected,
      errorCode: tiingoFailureCode(error),
    };
  }
}

/**
 * The oldest of the previous `maxBack` sessions that still has a full set of
 * regular 5m bars for `symbol`, assuming history is contiguous from some
 * date on (at most ⌈log2(maxBack)⌉ + 1 requests, paced).
 */
async function bisectIntradayReach(
  rest: TiingoRestClient,
  symbol: string,
  now: Date,
  maxBack: number,
): Promise<{
  symbol: string;
  oldestFullSessionsBack: number;
  oldestFullSessionDate: string | null;
  requests: number;
}> {
  const asset = { assetType: 'us_stock' as never, market: 'NAS' };
  let requests = 0;
  const full = async (back: number) => {
    const session = findPreviousMarketSession(asset, now, back);
    if (!session) return false;
    requests += 1;
    await delay(PACE_MS);
    const bars = await regularBarsOn(rest, symbol, session);
    return bars.regularBars === bars.expected;
  };
  // Invariant: `low` sessions back is full (0 = none proven), `high` is not.
  let low = 0;
  let high = maxBack;
  if (await full(1)) low = 1;
  else
    return {
      symbol,
      oldestFullSessionsBack: 0,
      oldestFullSessionDate: null,
      requests,
    };
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (await full(mid)) low = mid;
    else high = mid;
  }
  return {
    symbol,
    oldestFullSessionsBack: low,
    oldestFullSessionDate:
      findPreviousMarketSession(asset, now, low)?.localDate ?? null,
    requests,
  };
}

function checkStream(
  url: string,
  token: string,
  symbols: string[],
  seconds: number,
): Promise<{ verdict: Verdict; facts: Record<string, unknown> }> {
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
    const ticks = new Map<string, number>();
    const heartbeatAt: number[] = [];
    let errorCode: number | null = null;
    let closeCode: number | null = null;
    const wanted = new Set(symbols);
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
      const covered = [...ticks.keys()].length;
      const verdict: Verdict =
        counts.errors > 0 || counts.subscribed === 0
          ? 'FAIL'
          : covered === symbols.length
            ? 'PASS'
            : covered > 0
              ? 'PARTIAL'
              : segment === 'regular'
                ? 'FAIL'
                : 'NO_DATA_OUTSIDE_HOURS';
      const gaps = heartbeatAt
        .slice(1)
        .map((at, index) => Math.round((at - heartbeatAt[index]) / 1000));
      resolve({
        verdict,
        facts: {
          thresholdLevel: 6,
          listenSeconds: seconds,
          ...counts,
          symbolsWithTicks: covered,
          symbolsWithoutTicks: symbols.filter((symbol) => !ticks.has(symbol)),
          heartbeatGapsSeconds: gaps,
          errorResponseCode: errorCode,
          closeCode,
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
            thresholdLevel: 6,
            tickers: symbols.map((symbol) => toTiingoTicker(symbol)),
          },
        }),
      );
    });
    socket.on('message', (data: Buffer) => {
      counts.frames += 1;
      const message = parseTiingoWsMessage(data.toString('utf8'), 'reference');
      if (message.kind === 'subscribed') counts.subscribed += 1;
      else if (message.kind === 'heartbeat') {
        counts.heartbeats += 1;
        heartbeatAt.push(Date.now());
      } else if (message.kind === 'error') {
        counts.errors += 1;
        errorCode = message.responseCode;
      } else if (message.kind === 'reference') {
        if (!wanted.has(message.symbol)) {
          counts.foreign += 1;
          return;
        }
        counts.data += 1;
        ticks.set(message.symbol, (ticks.get(message.symbol) ?? 0) + 1);
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
  console.error('tiingo-official-smoke: FAILED (unexpected error)');
  process.exitCode = 1;
});
