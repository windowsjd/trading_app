import type { MarketCandleFeed } from '../../src/assets/market-candle-sync.types';
import type {
  AssetType,
  MarketCandleSyncMode,
} from '../../src/generated/prisma/client';

const DEFAULT_BASELINE_DAYS = 35;

export type CandleBaselineArgs = {
  report: boolean;
  apply: boolean;
  mode: MarketCandleSyncMode;
  days: number;
  targets: MarketCandleFeed[];
  assetTypes: AssetType[];
  assetIds: string[];
  maxAssets?: number;
  /** Repair only: an explicit [from, to) instead of the last `days` days. */
  from?: Date;
  to?: Date;
  resume: boolean;
  /** Only with explicit --asset-id: backfill named assets before activation. */
  includeInactive: boolean;
};

// The KRX 576-session daily chart spans up to 868 calendar days.
const MAX_BASELINE_DAYS = 900;

export function parseCandleBaselineArgs(argv: string[]): CandleBaselineArgs {
  const args: CandleBaselineArgs = {
    report: false,
    apply: false,
    mode: 'initial' as MarketCandleSyncMode,
    days: DEFAULT_BASELINE_DAYS,
    targets: [],
    assetTypes: [],
    assetIds: [],
    resume: true,
    includeInactive: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case '--report':
        args.report = true;
        break;
      case '--apply':
        args.apply = true;
        break;
      case '--dry-run':
        args.apply = false;
        break;
      case '--no-resume':
        args.resume = false;
        break;
      case '--include-inactive':
        args.includeInactive = true;
        break;
      case '--mode':
        if (
          value !== 'initial' &&
          value !== 'incremental' &&
          value !== 'repair'
        ) {
          throw new Error('--mode must be initial, incremental, or repair.');
        }
        args.mode = value as MarketCandleSyncMode;
        index += 1;
        break;
      case '--days': {
        const days = Number(value);
        if (
          !Number.isSafeInteger(days) ||
          days < 1 ||
          days > MAX_BASELINE_DAYS
        ) {
          throw new Error(
            `--days must be an integer between 1 and ${MAX_BASELINE_DAYS}.`,
          );
        }
        args.days = days;
        index += 1;
        break;
      }
      case '--target':
        if (value !== '5m' && value !== '1d' && value !== '1w') {
          throw new Error('--target must be 5m, 1d, or 1w.');
        }
        args.targets.push(value);
        index += 1;
        break;
      case '--asset-type':
        if (
          value !== 'domestic_stock' &&
          value !== 'us_stock' &&
          value !== 'crypto'
        ) {
          throw new Error(
            '--asset-type must be domestic_stock, us_stock, or crypto.',
          );
        }
        args.assetTypes.push(value as AssetType);
        index += 1;
        break;
      case '--asset-id':
        if (!value) throw new Error('--asset-id requires a value.');
        args.assetIds.push(value);
        index += 1;
        break;
      case '--from':
      case '--to': {
        // An offset is required so the window cannot depend on the host TZ.
        const at = new Date(value ?? '');
        if (
          !/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})$/.test(value ?? '') ||
          !Number.isFinite(at.getTime())
        ) {
          throw new Error(
            `${flag} must be an ISO date-time with an offset, e.g. 2026-10-16T00:00:00+09:00.`,
          );
        }
        if (flag === '--from') args.from = at;
        else args.to = at;
        index += 1;
        break;
      }
      case '--max-assets': {
        const max = Number(value);
        if (!Number.isSafeInteger(max) || max < 1) {
          throw new Error('--max-assets must be a positive integer.');
        }
        args.maxAssets = max;
        index += 1;
        break;
      }
      default:
        if (flag.startsWith('--')) throw new Error(`Unknown flag ${flag}.`);
    }
  }

  if (args.includeInactive && args.assetIds.length === 0) {
    throw new Error('--include-inactive requires explicit --asset-id values.');
  }
  if (args.from || args.to) {
    if (args.mode !== 'repair' || !args.from || !args.to) {
      throw new Error('--from/--to require --mode repair and both bounds.');
    }
    if (args.from >= args.to) throw new Error('--from must be before --to.');
  }
  if (args.targets.length === 0) args.targets.push('5m');
  if (args.report && (args.targets.length !== 1 || args.targets[0] !== '5m')) {
    throw new Error('--report only supports the 5m baseline.');
  }
  return args;
}
