export type MarketCalendarMarket = 'KRX' | 'US';

/**
 * One non-standard trading day: a full-day closure, or a session override
 * (early close / delayed open). Times are exchange-local HHmmss.
 */
export type MarketCalendarSchedule = {
  date: string; // YYYY-MM-DD, exchange-local calendar date
  name: string;
  isFullDayClosed: boolean;
  openTimeOverride?: string | null;
  closeTimeOverride?: string | null;
};

export type MarketCalendarDataset = {
  market: MarketCalendarMarket;
  year: number;
  timeZone: string;
  // Primary source this dataset was audited against.
  sourceName: string;
  sourceReference: string;
  // When the dataset was last checked against the source (ISO date).
  verifiedAt: string;
  // Bump on any correction; suffix `-provisional` while the exchange's own
  // official year-end notice is still pending.
  version: string;
  schedules: readonly MarketCalendarSchedule[];
};
