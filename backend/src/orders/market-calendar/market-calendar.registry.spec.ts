import {
  getCalendarDataset,
  getMarketCalendarCoverage,
  hasCalendarYear,
  findCalendarSchedule,
  readMarketCalendarCoverageConfig,
  MarketCalendarConfigError,
} from './market-calendar.registry';

describe('market calendar registry', () => {
  it('covers 2026 and 2027 for both markets with source metadata', () => {
    for (const market of ['KRX', 'US'] as const) {
      for (const year of [2026, 2027]) {
        expect(hasCalendarYear(market, year)).toBe(true);
        const dataset = getCalendarDataset(market, year)!;
        expect(dataset.sourceName.length).toBeGreaterThan(0);
        expect(dataset.sourceReference.length).toBeGreaterThan(0);
        expect(dataset.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
        expect(dataset.version.length).toBeGreaterThan(0);
        expect(dataset.schedules.length).toBeGreaterThan(5);
      }
    }
    expect(hasCalendarYear('KRX', 2025)).toBe(false);
    expect(hasCalendarYear('US', 2028)).toBe(false);
  });

  it('contains no test-holiday placeholder entries', () => {
    for (const market of ['KRX', 'US'] as const) {
      for (const year of [2026, 2027]) {
        for (const schedule of getCalendarDataset(market, year)!.schedules) {
          expect(schedule.name.toLowerCase()).not.toContain('test');
        }
      }
    }
  });

  it('knows official 2026 closures for KRX and US', () => {
    // KRX: Seollal, local-election day, re-designated Constitution Day,
    // year-end closure.
    expect(findCalendarSchedule('KRX', '2026-02-17')?.isFullDayClosed).toBe(true);
    expect(findCalendarSchedule('KRX', '2026-06-03')?.isFullDayClosed).toBe(true);
    expect(findCalendarSchedule('KRX', '2026-07-17')?.isFullDayClosed).toBe(true);
    expect(findCalendarSchedule('KRX', '2026-12-31')?.isFullDayClosed).toBe(true);
    // US: Independence Day observed Friday July 3, Thanksgiving.
    expect(findCalendarSchedule('US', '2026-07-03')?.isFullDayClosed).toBe(true);
    expect(findCalendarSchedule('US', '2026-11-26')?.isFullDayClosed).toBe(true);
    // Ordinary trading days have no entry.
    expect(findCalendarSchedule('KRX', '2026-07-13')).toBeNull();
    expect(findCalendarSchedule('US', '2026-07-13')).toBeNull();
  });

  it('models early closes and delayed opens as session overrides', () => {
    const blackFriday = findCalendarSchedule('US', '2026-11-27')!;
    expect(blackFriday.isFullDayClosed).toBe(false);
    expect(blackFriday.closeTimeOverride).toBe('130000');
    const csat = findCalendarSchedule('KRX', '2026-11-19')!;
    expect(csat.isFullDayClosed).toBe(false);
    expect(csat.openTimeOverride).toBe('100000');
    expect(csat.closeTimeOverride).toBe('163000');
    const openingDay = findCalendarSchedule('KRX', '2026-01-02')!;
    expect(openingDay.openTimeOverride).toBe('100000');
    expect(openingDay.closeTimeOverride ?? null).toBeNull();
  });

  it('reports year coverage against the configured required range', () => {
    const complete = getMarketCalendarCoverage({
      requiredFromYear: 2026,
      requiredThroughYear: 2027,
    });
    expect(complete.complete).toBe(true);
    expect(
      complete.markets.find((entry) => entry.market === 'KRX')
        ?.provisionalYears,
    ).toEqual([2027]);

    const missing = getMarketCalendarCoverage({
      requiredFromYear: 2026,
      requiredThroughYear: 2028,
    });
    expect(missing.complete).toBe(false);
    for (const market of missing.markets) {
      expect(market.missingYears).toEqual([2028]);
    }
  });

  it('reads the required year range from env with sane defaults', () => {
    const now = new Date('2026-07-13T00:00:00Z');
    expect(readMarketCalendarCoverageConfig({}, now)).toEqual({
      requiredFromYear: 2026,
      requiredThroughYear: 2027,
    });
    expect(
      readMarketCalendarCoverageConfig(
        {
          MARKET_CALENDAR_REQUIRED_FROM_YEAR: '2026',
          MARKET_CALENDAR_REQUIRED_THROUGH_YEAR: '2028',
        },
        now,
      ),
    ).toEqual({ requiredFromYear: 2026, requiredThroughYear: 2028 });
    expect(() =>
      readMarketCalendarCoverageConfig(
        {
          MARKET_CALENDAR_REQUIRED_FROM_YEAR: '2028',
          MARKET_CALENDAR_REQUIRED_THROUGH_YEAR: '2026',
        },
        now,
      ),
    ).toThrow(MarketCalendarConfigError);
  });
});
