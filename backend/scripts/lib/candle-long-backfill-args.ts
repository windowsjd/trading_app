import type { LongCandleMarket } from '../../src/assets/market-candle-long-sync.service';

export type CandleLongBackfillArgs = {
  markets: LongCandleMarket[];
  apply: boolean;
  days: number;
  sessions: number;
  assetIds: string[];
  instrumentIds: string[];
  includeInactiveFutures: boolean;
  krxMaxCalls: number;
  krxMinRemainingDaily: number;
  krxMinCallIntervalMs: number;
  allowDuringKrxSession: boolean;
  fetchMissingDaily: boolean;
};

const MARKETS: readonly LongCandleMarket[] = ['spot', 'krx', 'us', 'futures'];

/**
 * Operator flags for `candle:long-backfill`. Dry-run is the default; at least
 * one --market is required so a KOSCOM-budget run is never implicit.
 */
export function parseCandleLongBackfillArgs(
  argv: readonly string[],
): CandleLongBackfillArgs {
  const args: CandleLongBackfillArgs = {
    markets: [],
    apply: false,
    days: 96,
    sessions: 97,
    assetIds: [],
    instrumentIds: [],
    includeInactiveFutures: false,
    krxMaxCalls: 1500,
    krxMinRemainingDaily: 20_000,
    krxMinCallIntervalMs: 1000,
    allowDuringKrxSession: false,
    fetchMissingDaily: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    const takeInteger = (min: number, max: number) => {
      if (value === undefined || !/^\d+$/u.test(value)) {
        throw new Error(`${flag} requires an integer from ${min} to ${max}.`);
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
        throw new Error(`${flag} requires an integer from ${min} to ${max}.`);
      }
      index += 1;
      return parsed;
    };
    const takeText = () => {
      if (
        value === undefined ||
        value.startsWith('--') ||
        value.trim() === ''
      ) {
        throw new Error(`${flag} requires a value.`);
      }
      index += 1;
      return value.trim();
    };
    switch (flag) {
      case '--market': {
        const market = takeText() as LongCandleMarket;
        if (!MARKETS.includes(market)) {
          throw new Error('--market must be spot, krx, us, or futures.');
        }
        if (!args.markets.includes(market)) args.markets.push(market);
        break;
      }
      case '--apply':
        args.apply = true;
        break;
      case '--dry-run':
        args.apply = false;
        break;
      case '--days':
        args.days = takeInteger(1, 180);
        break;
      case '--sessions':
        args.sessions = takeInteger(1, 125);
        break;
      case '--asset-id':
        args.assetIds.push(takeText());
        break;
      case '--instrument-id':
        args.instrumentIds.push(takeText());
        break;
      case '--include-inactive-futures':
        args.includeInactiveFutures = true;
        break;
      case '--max-calls':
        args.krxMaxCalls = takeInteger(1, 20_000);
        break;
      case '--min-remaining-daily':
        args.krxMinRemainingDaily = takeInteger(0, 50_000);
        break;
      case '--min-call-interval-ms':
        args.krxMinCallIntervalMs = takeInteger(200, 60_000);
        break;
      case '--allow-during-krx-session':
        args.allowDuringKrxSession = true;
        break;
      case '--no-fetch-missing-daily':
        args.fetchMissingDaily = false;
        break;
      default:
        throw new Error(`Unknown flag: ${flag}`);
    }
  }
  if (args.markets.length === 0) {
    throw new Error('Specify at least one --market spot|krx|us|futures.');
  }
  if (args.includeInactiveFutures && args.instrumentIds.length === 0) {
    throw new Error('--include-inactive-futures requires --instrument-id.');
  }
  return args;
}
