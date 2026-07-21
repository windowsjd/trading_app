import { getZonedParts } from '../../providers/kis/candles/kis-candle-time';
import type {
  MarketCalendarDataset,
  MarketCalendarMarket,
  MarketCalendarSchedule,
} from './market-calendar.types';
import { KRX_2025 } from './data/krx-2025';
import { KRX_2026 } from './data/krx-2026';
import { KRX_2027 } from './data/krx-2027';
import { US_2025 } from './data/us-2025';
import { US_2026 } from './data/us-2026';
import { US_2027 } from './data/us-2027';

export class MarketCalendarConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketCalendarConfigError';
  }
}

const DATASETS: readonly MarketCalendarDataset[] = [
  KRX_2025,
  KRX_2026,
  KRX_2027,
  US_2025,
  US_2026,
  US_2027,
];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const TIME_PATTERN = /^\d{6}$/u;

// Validate datasets once at module load: a malformed calendar is a
// configuration error and must fail fast, never silently pass a bad date
// through the trading-session policy.
for (const dataset of DATASETS) {
  for (const schedule of dataset.schedules) {
    if (!DATE_PATTERN.test(schedule.date)) {
      throw new MarketCalendarConfigError(
        `Calendar ${dataset.market} ${dataset.year}: invalid date ${schedule.date}.`,
      );
    }
    if (Number(schedule.date.slice(0, 4)) !== dataset.year) {
      throw new MarketCalendarConfigError(
        `Calendar ${dataset.market} ${dataset.year}: ${schedule.date} is outside the dataset year.`,
      );
    }
    for (const override of [
      schedule.openTimeOverride,
      schedule.closeTimeOverride,
    ]) {
      if (override != null && !TIME_PATTERN.test(override)) {
        throw new MarketCalendarConfigError(
          `Calendar ${dataset.market} ${dataset.year}: invalid time override on ${schedule.date}.`,
        );
      }
    }
    if (
      schedule.isFullDayClosed &&
      (schedule.openTimeOverride || schedule.closeTimeOverride)
    ) {
      throw new MarketCalendarConfigError(
        `Calendar ${dataset.market} ${dataset.year}: ${schedule.date} mixes full closure with session overrides.`,
      );
    }
  }
}

const byMarketDate = new Map<string, MarketCalendarSchedule>();
const datasetByMarketYear = new Map<string, MarketCalendarDataset>();
for (const dataset of DATASETS) {
  const yearKey = `${dataset.market}:${dataset.year}`;
  if (datasetByMarketYear.has(yearKey)) {
    throw new MarketCalendarConfigError(
      `Duplicate calendar dataset ${yearKey}.`,
    );
  }
  datasetByMarketYear.set(yearKey, dataset);
  for (const schedule of dataset.schedules) {
    const key = `${dataset.market}:${schedule.date}`;
    if (byMarketDate.has(key)) {
      throw new MarketCalendarConfigError(`Duplicate calendar entry ${key}.`);
    }
    byMarketDate.set(key, schedule);
  }
}

/** Returns the schedule entry (closure or session override) for a date. */
export function findCalendarSchedule(
  market: MarketCalendarMarket,
  date: string, // YYYY-MM-DD
): MarketCalendarSchedule | null {
  return byMarketDate.get(`${market}:${date}`) ?? null;
}

/**
 * Whether a calendar dataset exists for the market/year. Dates in uncovered
 * years must NOT be assumed to be regular trading days.
 */
export function hasCalendarYear(
  market: MarketCalendarMarket,
  year: number,
): boolean {
  return datasetByMarketYear.has(`${market}:${year}`);
}

export function getCalendarDataset(
  market: MarketCalendarMarket,
  year: number,
): MarketCalendarDataset | null {
  return datasetByMarketYear.get(`${market}:${year}`) ?? null;
}

export function listCalendarDatasets(): readonly MarketCalendarDataset[] {
  return DATASETS;
}

export type MarketCalendarCoverageStatus = {
  requiredFromYear: number;
  requiredThroughYear: number;
  markets: {
    market: MarketCalendarMarket;
    // Years with a dataset present — audited OR provisional.
    coveredYears: number[];
    // Years verified against the exchange's official/final notice.
    auditedYears: number[];
    // Dataset present but NOT yet verified against the official exchange
    // notice (version carries a `-provisional` suffix), e.g. KRX 2027 until
    // the KRX year-end notice is published.
    provisionalYears: number[];
    missingYears: number[];
  }[];
  // Total datasets present across markets for the required range.
  datasetsPresent: number;
  // Every required year has a dataset (audited or provisional). Kept with
  // its original meaning for compatibility — presence only, NOT audit level.
  complete: boolean;
  // Every required year has an AUDITED dataset: no missing years and no
  // provisional years. Only this level treats the calendar as final.
  productionReady: boolean;
};

export type MarketCalendarCoverageConfig = {
  requiredFromYear: number;
  requiredThroughYear: number;
};

/**
 * Required year range for readiness. Defaults to the previous year through
 * the next year: the previous year is required because the 1d/1w candle
 * sync's 365-day lookback (and year-boundary previous-session anchors)
 * reach into it, and the next year so operators are warned well before a
 * year boundary. Explicit env values override either bound.
 *
 * "Current year" is always the Asia/Seoul calendar year — never the host
 * OS timezone or process.env.TZ, and not UTC (which lags Seoul by 9 hours
 * across every New Year boundary).
 */
export function readMarketCalendarCoverageConfig(
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): MarketCalendarCoverageConfig {
  const currentYear = getZonedParts(now, 'Asia/Seoul').year;
  const fromYear = readYear(
    env,
    'MARKET_CALENDAR_REQUIRED_FROM_YEAR',
    currentYear - 1,
  );
  const throughYear = readYear(
    env,
    'MARKET_CALENDAR_REQUIRED_THROUGH_YEAR',
    currentYear + 1,
  );
  if (fromYear > throughYear) {
    throw new MarketCalendarConfigError(
      'MARKET_CALENDAR_REQUIRED_FROM_YEAR must not exceed MARKET_CALENDAR_REQUIRED_THROUGH_YEAR.',
    );
  }
  return { requiredFromYear: fromYear, requiredThroughYear: throughYear };
}

export function getMarketCalendarCoverage(
  config: MarketCalendarCoverageConfig,
): MarketCalendarCoverageStatus {
  const markets = (['KRX', 'US'] as const).map((market) => {
    const coveredYears: number[] = [];
    const auditedYears: number[] = [];
    const missingYears: number[] = [];
    const provisionalYears: number[] = [];
    for (
      let year = config.requiredFromYear;
      year <= config.requiredThroughYear;
      year += 1
    ) {
      const dataset = getCalendarDataset(market, year);
      if (!dataset) {
        missingYears.push(year);
        continue;
      }
      coveredYears.push(year);
      if (dataset.version.includes('provisional')) {
        provisionalYears.push(year);
      } else {
        auditedYears.push(year);
      }
    }
    return {
      market,
      coveredYears,
      auditedYears,
      missingYears,
      provisionalYears,
    };
  });
  return {
    requiredFromYear: config.requiredFromYear,
    requiredThroughYear: config.requiredThroughYear,
    markets,
    datasetsPresent: markets.reduce(
      (total, entry) => total + entry.coveredYears.length,
      0,
    ),
    complete: markets.every((entry) => entry.missingYears.length === 0),
    productionReady: markets.every(
      (entry) =>
        entry.missingYears.length === 0 && entry.provisionalYears.length === 0,
    ),
  };
}

function readYear(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const text = env[name]?.trim();
  if (!text) return fallback;
  if (!/^\d{4}$/u.test(text)) {
    throw new MarketCalendarConfigError(`${name} must be a 4-digit year.`);
  }
  return Number(text);
}
