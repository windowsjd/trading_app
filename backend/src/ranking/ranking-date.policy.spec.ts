import {
  formatKstRankingDate,
  RANKING_DATE_TIME_ZONE,
  toKstRankingDate,
} from './ranking-date.policy';

describe('ranking date policy (Korea business date)', () => {
  it('is fixed to Asia/Seoul', () => {
    expect(RANKING_DATE_TIME_ZONE).toBe('Asia/Seoul');
  });

  it.each([
    ['2026-10-13T14:59:59.000Z', '2026-10-13'],
    ['2026-10-13T15:00:00.000Z', '2026-10-14'],
    ['2026-10-13T23:59:59.000Z', '2026-10-14'],
    ['2026-10-14T00:00:00.000Z', '2026-10-14'],
    ['2026-10-14T14:59:59.000Z', '2026-10-14'],
    ['2026-10-14T15:00:00.000Z', '2026-10-15'],
    // Month, year and leap-day rollovers happen at KST midnight too.
    ['2026-10-31T14:59:59.999Z', '2026-10-31'],
    ['2026-10-31T15:00:00.000Z', '2026-11-01'],
    ['2026-12-31T14:59:59.999Z', '2026-12-31'],
    ['2026-12-31T15:00:00.000Z', '2027-01-01'],
    ['2028-02-28T15:00:00.000Z', '2028-02-29'],
    ['2028-02-29T15:00:00.000Z', '2028-03-01'],
  ])('dates %s as %s', (instant, expected) => {
    const at = new Date(instant);

    expect(formatKstRankingDate(at)).toBe(expected);
    // The @db.Date encoding of that same calendar date.
    expect(toKstRankingDate(at).toISOString()).toBe(
      `${expected}T00:00:00.000Z`,
    );
    // Deriving the key never moves the instant itself.
    expect(at.toISOString()).toBe(instant);
  });

  it('changes the date at KST midnight and not at UTC midnight', () => {
    const beforeKstMidnight = formatKstRankingDate(
      new Date('2026-10-13T14:59:59.999Z'),
    );
    const atKstMidnight = formatKstRankingDate(
      new Date('2026-10-13T15:00:00.000Z'),
    );
    const beforeUtcMidnight = formatKstRankingDate(
      new Date('2026-10-13T23:59:59.999Z'),
    );
    const atUtcMidnight = formatKstRankingDate(
      new Date('2026-10-14T00:00:00.000Z'),
    );

    expect(beforeKstMidnight === atKstMidnight).toBe(false);
    expect(beforeUtcMidnight).toBe(atUtcMidnight);
  });

  it('does not follow SCHEDULER_TIMEZONE', () => {
    const previous = process.env.SCHEDULER_TIMEZONE;
    process.env.SCHEDULER_TIMEZONE = 'UTC';
    try {
      expect(formatKstRankingDate(new Date('2026-10-13T16:00:00.000Z'))).toBe(
        '2026-10-14',
      );
    } finally {
      if (previous === undefined) delete process.env.SCHEDULER_TIMEZONE;
      else process.env.SCHEDULER_TIMEZONE = previous;
    }
  });
});
