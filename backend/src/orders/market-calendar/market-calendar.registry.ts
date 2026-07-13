import type {
  MarketCalendarDataset,
  MarketCalendarMarket,
  MarketCalendarSchedule,
} from './market-calendar.types';
import { KRX_2026 } from './data/krx-2026';
import { KRX_2027 } from './data/krx-2027';
import { US_2026 } from './data/us-2026';
import { US_2027 } from './data/us-2027';

export class MarketCalendarConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MarketCalendarConfigError';
  }
}

const DATASETS: readonly MarketCalendarDataset[] = [
  KRX_2026,
  KRX_2027,
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
    throw new MarketCalendarConfigError(`Duplicate calendar dataset ${yearKey}.`);
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
    coveredYears: number[];
    missingYears: number[];
    provisionalYears: number[];
  }[];
  complete: boolean;
};

export type MarketCalendarCoverageConfig = {
  requiredFromYear: number;
  requiredThroughYear: number;
};

/**
 * Required year range for readiness. Defaults to the current year through
 * the next year so operators are warned well before a year boundary.
 */
export function readMarketCalendarCoverageConfig(
  env: NodeJS.ProcessEnv = process.env,
  now = new Date(),
): MarketCalendarCoverageConfig {
  const currentYear = now.getUTCFullYear();
  const fromYear = readYear(
    env,
    'MARKET_CALENDAR_REQUIRED_FROM_YEAR',
    currentYear,
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
      if (dataset.version.includes('provisional')) provisionalYears.push(year);
    }
    return { market, coveredYears, missingYears, provisionalYears };
  });
  return {
    requiredFromYear: config.requiredFromYear,
    requiredThroughYear: config.requiredThroughYear,
    markets,
    complete: markets.every((entry) => entry.missingYears.length === 0),
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
