import {
  getCalendarDataset,
  getMarketCalendarCoverage,
  hasCalendarYear,
  findCalendarSchedule,
  readMarketCalendarCoverageConfig,
  MarketCalendarConfigError,
} from './market-calendar.registry';

describe('market calendar registry', () => {
  it('covers 2025 through 2027 for both markets with source metadata', () => {
    for (const market of ['KRX', 'US'] as const) {
      for (const year of [2025, 2026, 2027]) {
        expect(hasCalendarYear(market, year)).toBe(true);
        const dataset = getCalendarDataset(market, year)!;
        expect(dataset.sourceName.length).toBeGreaterThan(0);
        expect(dataset.sourceReference.length).toBeGreaterThan(0);
        expect(dataset.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
        expect(dataset.version.length).toBeGreaterThan(0);
        expect(dataset.schedules.length).toBeGreaterThan(5);
      }
    }
    // KRX 2024 serves the 576-session daily window (provisional until Q14).
    expect(hasCalendarYear('KRX', 2024)).toBe(true);
    expect(getCalendarDataset('KRX', 2024)?.version).toBe('2024.1-provisional');
    expect(hasCalendarYear('KRX', 2023)).toBe(false);
    expect(hasCalendarYear('US', 2024)).toBe(false);
    expect(hasCalendarYear('US', 2028)).toBe(false);
  });

  it('counts the 2024 KRX sessions the 576-session window relies on', () => {
    // 366 days − 104 weekend days = 262 weekdays − 18 closures = 244.
    let sessions = 0;
    for (
      let day = Date.UTC(2024, 0, 1);
      day < Date.UTC(2025, 0, 1);
      day += 86_400_000
    ) {
      const date = new Date(day);
      const weekday = date.getUTCDay();
      if (weekday === 0 || weekday === 6) continue;
      const iso = date.toISOString().slice(0, 10);
      const schedule = findCalendarSchedule('KRX', iso);
      if (!schedule?.isFullDayClosed) sessions += 1;
    }
    expect(sessions).toBe(244);
  });

  it('keeps the fully elapsed 2025 datasets audited, never provisional', () => {
    for (const market of ['KRX', 'US'] as const) {
      expect(getCalendarDataset(market, 2025)!.version).not.toContain(
        'provisional',
      );
    }
  });

  it('contains no test-holiday placeholder entries', () => {
    for (const market of ['KRX', 'US'] as const) {
      for (const year of [2025, 2026, 2027]) {
        for (const schedule of getCalendarDataset(market, year)!.schedules) {
          expect(schedule.name.toLowerCase()).not.toContain('test');
        }
      }
    }
  });

  it('knows official 2025 closures for KRX and US', () => {
    // KRX: temporary holiday before Seollal, presidential-election day,
    // the Chuseok block incl. the substitute holiday, year-end closure.
    expect(findCalendarSchedule('KRX', '2025-01-27')?.isFullDayClosed).toBe(
      true,
    );
    expect(findCalendarSchedule('KRX', '2025-01-29')?.isFullDayClosed).toBe(
      true,
    );
    expect(findCalendarSchedule('KRX', '2025-06-03')?.isFullDayClosed).toBe(
      true,
    );
    expect(findCalendarSchedule('KRX', '2025-10-06')?.isFullDayClosed).toBe(
      true,
    );
    expect(findCalendarSchedule('KRX', '2025-10-08')?.isFullDayClosed).toBe(
      true,
    );
    expect(findCalendarSchedule('KRX', '2025-10-09')?.isFullDayClosed).toBe(
      true,
    );
    expect(findCalendarSchedule('KRX', '2025-12-31')?.isFullDayClosed).toBe(
      true,
    );
    // 2025-10-10 was NOT designated a temporary holiday: regular trading day.
    expect(findCalendarSchedule('KRX', '2025-10-10')).toBeNull();
    // US: National Day of Mourning for President Carter, Independence Day,
    // Thanksgiving.
    expect(findCalendarSchedule('US', '2025-01-09')?.isFullDayClosed).toBe(
      true,
    );
    expect(findCalendarSchedule('US', '2025-07-04')?.isFullDayClosed).toBe(
      true,
    );
    expect(findCalendarSchedule('US', '2025-11-27')?.isFullDayClosed).toBe(
      true,
    );
    // Ordinary trading days have no entry.
    expect(findCalendarSchedule('KRX', '2025-07-07')).toBeNull();
    expect(findCalendarSchedule('US', '2025-07-07')).toBeNull();
  });

  it('models 2025 early closes and delayed opens as session overrides', () => {
    for (const date of ['2025-07-03', '2025-11-28', '2025-12-24']) {
      const earlyClose = findCalendarSchedule('US', date)!;
      expect(earlyClose.isFullDayClosed).toBe(false);
      expect(earlyClose.closeTimeOverride).toBe('130000');
      expect(earlyClose.openTimeOverride ?? null).toBeNull();
    }
    const openingDay = findCalendarSchedule('KRX', '2025-01-02')!;
    expect(openingDay.isFullDayClosed).toBe(false);
    expect(openingDay.openTimeOverride).toBe('100000');
    expect(openingDay.closeTimeOverride ?? null).toBeNull();
    const csat = findCalendarSchedule('KRX', '2025-11-13')!;
    expect(csat.isFullDayClosed).toBe(false);
    expect(csat.openTimeOverride).toBe('100000');
    expect(csat.closeTimeOverride).toBe('163000');
  });

  it('knows official 2026 closures for KRX and US', () => {
    // KRX: Seollal, local-election day, re-designated Constitution Day,
    // year-end closure.
    expect(findCalendarSchedule('KRX', '2026-02-17')?.isFullDayClosed).toBe(
      true,
    );
    expect(findCalendarSchedule('KRX', '2026-06-03')?.isFullDayClosed).toBe(
      true,
    );
    expect(findCalendarSchedule('KRX', '2026-07-17')?.isFullDayClosed).toBe(
      true,
    );
    expect(findCalendarSchedule('KRX', '2026-12-31')?.isFullDayClosed).toBe(
      true,
    );
    // US: Independence Day observed Friday July 3, Thanksgiving.
    expect(findCalendarSchedule('US', '2026-07-03')?.isFullDayClosed).toBe(
      true,
    );
    expect(findCalendarSchedule('US', '2026-11-26')?.isFullDayClosed).toBe(
      true,
    );
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
      requiredFromYear: 2025,
      requiredThroughYear: 2027,
    });
    // Datasets are present for every required year, but KRX 2027 is only
    // provisional: complete (presence) is true while productionReady
    // (audited-only) stays false.
    expect(complete.complete).toBe(true);
    expect(complete.productionReady).toBe(false);
    expect(complete.datasetsPresent).toBe(6);
    const krx = complete.markets.find((entry) => entry.market === 'KRX')!;
    expect(krx.provisionalYears).toEqual([2027]);
    expect(krx.auditedYears).toEqual([2025, 2026]);
    expect(krx.coveredYears).toEqual([2025, 2026, 2027]);
    const us = complete.markets.find((entry) => entry.market === 'US')!;
    expect(us.provisionalYears).toEqual([]);
    expect(us.auditedYears).toEqual([2025, 2026, 2027]);

    const missing = getMarketCalendarCoverage({
      requiredFromYear: 2026,
      requiredThroughYear: 2028,
    });
    expect(missing.complete).toBe(false);
    expect(missing.productionReady).toBe(false);
    for (const market of missing.markets) {
      expect(market.missingYears).toEqual([2028]);
    }

    // A required range starting before the earliest dataset flags the
    // missing PREVIOUS year, which the 365-day lookback depends on. KRX 2024
    // exists for the 576-session daily window but is provisional (Q14).
    const missingPrevious = getMarketCalendarCoverage({
      requiredFromYear: 2024,
      requiredThroughYear: 2026,
    });
    expect(missingPrevious.complete).toBe(false);
    expect(missingPrevious.productionReady).toBe(false);
    const krx2024 = missingPrevious.markets.find((m) => m.market === 'KRX')!;
    expect(krx2024.missingYears).toEqual([]);
    expect(krx2024.provisionalYears).toEqual([2024]);
    const us2024 = missingPrevious.markets.find((m) => m.market === 'US')!;
    expect(us2024.missingYears).toEqual([2024]);

    // With the requirement pinned to the audited year, the provisional KRX
    // 2027 dataset no longer affects the status at all.
    const auditedOnly = getMarketCalendarCoverage({
      requiredFromYear: 2026,
      requiredThroughYear: 2026,
    });
    expect(auditedOnly.complete).toBe(true);
    expect(auditedOnly.productionReady).toBe(true);
    for (const market of auditedOnly.markets) {
      expect(market.provisionalYears).toEqual([]);
      expect(market.missingYears).toEqual([]);
    }
  });

  it('defaults the required range to previous..next year for the 365-day lookback', () => {
    const now = new Date('2026-07-13T00:00:00Z');
    expect(readMarketCalendarCoverageConfig({}, now)).toEqual({
      requiredFromYear: 2025,
      requiredThroughYear: 2027,
    });
    // The default range is complete with the shipped 2025–2027 datasets, so
    // readiness does not report MARKET_CALENDAR_COVERAGE_MISSING today.
    const coverage = getMarketCalendarCoverage(
      readMarketCalendarCoverageConfig({}, now),
    );
    expect(coverage.complete).toBe(true);
  });

  describe('Asia/Seoul current-year boundary', () => {
    it('stays on the Seoul year just before the KST New Year instant', () => {
      // 2026-12-31T14:59:59Z is 2026-12-31 23:59:59 KST — still 2026.
      expect(
        readMarketCalendarCoverageConfig(
          {},
          new Date('2026-12-31T14:59:59.000Z'),
        ),
      ).toEqual({ requiredFromYear: 2025, requiredThroughYear: 2027 });
    });

    it('rolls to the next Seoul year at exactly 15:00 UTC', () => {
      // 2026-12-31T15:00:00Z is 2027-01-01 00:00:00 KST — Seoul year 2027,
      // even though UTC (and any host timezone west of KST) is still 2026.
      expect(
        readMarketCalendarCoverageConfig(
          {},
          new Date('2026-12-31T15:00:00.000Z'),
        ),
      ).toEqual({ requiredFromYear: 2026, requiredThroughYear: 2028 });
      expect(
        readMarketCalendarCoverageConfig(
          {},
          new Date('2026-12-31T15:30:00.000Z'),
        ),
      ).toEqual({ requiredFromYear: 2026, requiredThroughYear: 2028 });
    });

    it('ignores the host timezone (process.env.TZ) completely', () => {
      const originalTz = process.env.TZ;
      const boundary = new Date('2026-12-31T15:00:00.000Z');
      const before = new Date('2026-12-31T14:59:59.000Z');
      try {
        for (const tz of ['UTC', 'America/New_York', 'Pacific/Kiritimati']) {
          process.env.TZ = tz;
          expect(readMarketCalendarCoverageConfig({}, boundary)).toEqual({
            requiredFromYear: 2026,
            requiredThroughYear: 2028,
          });
          expect(readMarketCalendarCoverageConfig({}, before)).toEqual({
            requiredFromYear: 2025,
            requiredThroughYear: 2027,
          });
        }
      } finally {
        if (originalTz === undefined) delete process.env.TZ;
        else process.env.TZ = originalTz;
      }
    });

    it('handles leap-day and ordinary mid-year dates', () => {
      // 2028-02-29 (leap day) 12:00 KST → Seoul year 2028.
      expect(
        readMarketCalendarCoverageConfig(
          {},
          new Date('2028-02-29T03:00:00.000Z'),
        ),
      ).toEqual({ requiredFromYear: 2027, requiredThroughYear: 2029 });
      // Ordinary mid-year date far from any boundary.
      expect(
        readMarketCalendarCoverageConfig(
          {},
          new Date('2026-07-13T00:00:00.000Z'),
        ),
      ).toEqual({ requiredFromYear: 2025, requiredThroughYear: 2027 });
    });

    it('keeps env overrides authoritative across the Seoul boundary', () => {
      expect(
        readMarketCalendarCoverageConfig(
          { MARKET_CALENDAR_REQUIRED_THROUGH_YEAR: '2027' },
          new Date('2026-12-31T15:00:00.000Z'),
        ),
      ).toEqual({ requiredFromYear: 2026, requiredThroughYear: 2027 });
    });
  });

  it('reads the required year range from env, overriding the defaults', () => {
    const now = new Date('2026-07-13T00:00:00Z');
    expect(
      readMarketCalendarCoverageConfig(
        {
          MARKET_CALENDAR_REQUIRED_FROM_YEAR: '2026',
          MARKET_CALENDAR_REQUIRED_THROUGH_YEAR: '2028',
        },
        now,
      ),
    ).toEqual({ requiredFromYear: 2026, requiredThroughYear: 2028 });
    // A single override keeps the other bound at its default.
    expect(
      readMarketCalendarCoverageConfig(
        { MARKET_CALENDAR_REQUIRED_THROUGH_YEAR: '2026' },
        now,
      ),
    ).toEqual({ requiredFromYear: 2025, requiredThroughYear: 2026 });
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
