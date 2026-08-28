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
  resume: boolean;
};

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
        if (!Number.isSafeInteger(days) || days < 1 || days > 365) {
          throw new Error('--days must be an integer between 1 and 365.');
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

  if (args.targets.length === 0) args.targets.push('5m');
  if (args.report && (args.targets.length !== 1 || args.targets[0] !== '5m')) {
    throw new Error('--report only supports the 5m baseline.');
  }
  return args;
}
