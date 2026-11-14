jest.mock('../generated/prisma/client', () => ({
  SeasonStatus: {
    upcoming: 'upcoming',
    active: 'active',
    ended: 'ended',
    settled: 'settled',
  },
  Prisma: {},
}));

import {
  describeSeasonSchedule,
  formatKstInstant,
  kstDayOf,
  kstDayStart,
  parseSeasonSettings,
  prepareScheduledSeason,
  resolveSeasonSchedule,
} from './scheduled-season.operations';

const SETTINGS = {
  seasonId: 'sea_2026_s0_20261114',
  name: 'season0',
  initialCapitalKrw: '10000000',
  minTradedInstruments: '5',
  minTurnoverRatio: '3',
  feeSourceSeasonId: 'sea_2026_s0_release',
};
const SCHEDULE = {
  startAt: '2026-11-14T20:00:00+09:00',
  firstDayKst: '2026-11-14',
  lastDayKst: '2026-11-29',
};

describe('regular season schedule (KST operating days, derived exclusive end)', () => {
  it('2026-11-14 ~ 2026-11-29 KST ends at 2026-11-30 00:00 KST = 2026-11-29T15:00:00Z', () => {
    const schedule = resolveSeasonSchedule(SCHEDULE);
    expect(schedule.startAt.toISOString()).toBe('2026-11-14T11:00:00.000Z');
    expect(schedule.endAt.toISOString()).toBe('2026-11-29T15:00:00.000Z');
    const shown = describeSeasonSchedule(schedule);
    expect(shown).toMatchObject({
      timeZone: 'Asia/Seoul',
      operatingDays: 16,
      startAtKst: '2026-11-14T20:00:00.000+09:00',
      endAtKst: '2026-11-30T00:00:00.000+09:00',
      endIsExclusive: true,
      lastTradingInstantKst: '2026-11-29T23:59:59.999+09:00',
      appDisplay: '2026.11.14 ~ 2026.11.29',
    });
  });

  it('a UTC or KST spelling of the same start is the same instant; the KST day decides', () => {
    expect(
      resolveSeasonSchedule({
        ...SCHEDULE,
        startAt: '2026-11-14T11:00:00Z',
      }).startAt.getTime(),
    ).toBe(resolveSeasonSchedule(SCHEDULE).startAt.getTime());
    // 2026-11-14T00:30:00+09:00 is 2026-11-13T15:30Z: still KST 11-14.
    expect(kstDayOf(new Date('2026-11-13T15:30:00Z'))).toBe('2026-11-14');
    expect(kstDayOf(new Date('2026-11-14T14:59:59.999Z'))).toBe('2026-11-14');
    expect(kstDayOf(new Date('2026-11-14T15:00:00Z'))).toBe('2026-11-15');
  });

  it('refuses a start outside the approved first day (never shifts the date by itself)', () => {
    // 2026-11-14T18:00:00Z is 2026-11-15 03:00 KST.
    expect(() =>
      resolveSeasonSchedule({ ...SCHEDULE, startAt: '2026-11-14T18:00:00Z' }),
    ).toThrow(/not on the approved first day 2026-11-14/);
    expect(() =>
      resolveSeasonSchedule({
        ...SCHEDULE,
        startAt: '2026-11-13T23:00:00+09:00',
      }),
    ).toThrow(/approved first day/);
  });

  it('refuses malformed, impossible or reversed days and implausible lengths', () => {
    for (const bad of [
      '2026-11-31',
      '2026-02-29',
      '2026-1-14',
      '20261114',
      '',
      '2026-13-01',
    ])
      expect(() => kstDayStart(bad)).toThrow();
    expect(kstDayStart('2028-02-29').toISOString()).toBe(
      '2028-02-28T15:00:00.000Z',
    );
    expect(() =>
      resolveSeasonSchedule({ ...SCHEDULE, lastDayKst: '2026-11-13' }),
    ).toThrow(/before the first/);
    expect(() =>
      resolveSeasonSchedule({ ...SCHEDULE, lastDayKst: '2027-11-29' }),
    ).toThrow(/not plausible/);
    for (const startAt of [
      '2026-11-14 20:00:00',
      '2026-11-14T20:00:00',
      'tomorrow',
    ])
      expect(() => resolveSeasonSchedule({ ...SCHEDULE, startAt })).toThrow();
  });

  it('a one-day season ends at the next KST midnight', () => {
    const schedule = resolveSeasonSchedule({
      startAt: '2026-12-01T09:00:00+09:00',
      firstDayKst: '2026-12-01',
      lastDayKst: '2026-12-01',
    });
    expect(formatKstInstant(schedule.endAt)).toBe(
      '2026-12-02T00:00:00.000+09:00',
    );
    expect(describeSeasonSchedule(schedule).appDisplay).toBe(
      '2026.12.01 ~ 2026.12.01',
    );
  });
});

describe('regular season settings', () => {
  it('accepts the season0 settings and keeps them as written', () => {
    expect(parseSeasonSettings(SETTINGS)).toEqual({
      id: 'sea_2026_s0_20261114',
      name: 'season0',
      initialCapitalKrw: '10000000',
      finalRankingMinTradedInstruments: 5,
      finalRankingMinTurnoverRatio: '3',
      feeSourceSeasonId: 'sea_2026_s0_release',
    });
  });

  it.each([
    [{ seasonId: 'sea_2026_s1' }, /development season/],
    [{ seasonId: 'a' }, /season ID/],
    [{ seasonId: 'bad id' }, /season ID/],
    [{ name: '' }, /season name/],
    [{ name: ' season0' }, /season name/],
    [{ name: 'x'.repeat(41) }, /season name/],
    [{ initialCapitalKrw: '0' }, /initial-capital-krw/],
    [{ initialCapitalKrw: '-1' }, /initial-capital-krw/],
    [{ initialCapitalKrw: '1e7' }, /initial-capital-krw/],
    [{ minTradedInstruments: '0' }, /min-traded-instruments/],
    [{ minTradedInstruments: '2.5' }, /min-traded-instruments/],
    [{ minTurnoverRatio: '0' }, /min-turnover-ratio/],
    [{ minTurnoverRatio: '3.00001' }, /min-turnover-ratio/],
    [{ feeSourceSeasonId: ' ' }, /fee-source-season-id/],
  ])('refuses %o', (change, message) => {
    expect(() => parseSeasonSettings({ ...SETTINGS, ...change })).toThrow(
      message,
    );
  });
});

describe('prepareScheduledSeason (database guards, mocked client)', () => {
  const now = new Date('2026-11-14T07:00:00Z');
  function client(over: Record<string, unknown> = {}) {
    const created: unknown[] = [];
    const tx = {
      season: {
        findUnique: jest.fn(async ({ where }: { where: { id: string } }) =>
          where.id === 'sea_2026_s0_release'
            ? {
                id: where.id,
                name: 'season0',
                status: 'settled',
                tradeFeeRate: { toFixed: () => '0.001000' },
                fxFeeRate: { toFixed: () => '0.001000' },
              }
            : null,
        ),
        findFirst: jest.fn(async () => null),
        create: jest.fn(async ({ data }: { data: unknown }) => {
          created.push(data);
          return data;
        }),
      },
      operatorAuditLog: { findFirst: jest.fn(async () => null) },
      ...over,
    };
    return { tx: tx as never, created, raw: tx };
  }

  it('a dry run returns the regular season it would create and writes nothing', async () => {
    const { tx, created } = client();
    const plan = await prepareScheduledSeason(
      tx,
      { ...SETTINGS, ...SCHEDULE },
      now,
      false,
    );
    expect(created).toHaveLength(0);
    expect(plan.season).toMatchObject({
      id: 'sea_2026_s0_20261114',
      name: 'season0',
      status: 'upcoming',
      initialCapitalKrw: '10000000',
      finalRankingMinTradedInstruments: 5,
      finalRankingMinTurnoverRatio: '3',
    });
    expect((plan.season as { startAt: Date }).startAt.toISOString()).toBe(
      '2026-11-14T11:00:00.000Z',
    );
    expect((plan.season as { endAt: Date }).endAt.toISOString()).toBe(
      '2026-11-29T15:00:00.000Z',
    );
    expect(plan).toMatchObject({
      launchKind: null,
      displayBadge: null,
      feeSource: { tradeFeeRate: '0.001000', fxFeeRate: '0.001000' },
    });
    expect('launchKind' in (plan.season as object)).toBe(false);
  });

  it('never backdates: a start at or before the database clock is refused', async () => {
    const { tx, created } = client();
    await expect(
      prepareScheduledSeason(
        tx,
        { ...SETTINGS, ...SCHEDULE, startAt: '2026-11-14T16:00:00+09:00' },
        now,
      ),
    ).rejects.toThrow(/never backdated/);
    expect(created).toHaveLength(0);
  });

  it('refuses an existing or previously used ID, a missing fee source, an armed launch and an overlap', async () => {
    const existing = client();
    existing.raw.season.findUnique.mockImplementation(
      async () => ({ id: 'x' }) as never,
    );
    await expect(
      prepareScheduledSeason(existing.tx, { ...SETTINGS, ...SCHEDULE }, now),
    ).rejects.toThrow(/already exists/);

    const used = client({
      operatorAuditLog: { findFirst: jest.fn(async () => ({ id: 'audit' })) },
    });
    await expect(
      prepareScheduledSeason(used.tx, { ...SETTINGS, ...SCHEDULE }, now),
    ).rejects.toThrow(/already been used/);

    const noSource = client();
    await expect(
      prepareScheduledSeason(
        noSource.tx,
        { ...SETTINGS, ...SCHEDULE, feeSourceSeasonId: 'missing' },
        now,
      ),
    ).rejects.toThrow(/fee source/);

    const armed = client();
    armed.raw.season.findFirst.mockImplementationOnce(
      async () => ({ id: 'launch-x' }) as never,
    );
    await expect(
      prepareScheduledSeason(armed.tx, { ...SETTINGS, ...SCHEDULE }, now),
    ).rejects.toThrow(/armed/);

    const overlap = client();
    overlap.raw.season.findFirst
      .mockImplementationOnce(async () => null)
      .mockImplementationOnce(async () => ({ id: 'other' }) as never);
    await expect(
      prepareScheduledSeason(overlap.tx, { ...SETTINGS, ...SCHEDULE }, now),
    ).rejects.toThrow(/conflicts with other/);
    const [, overlapQuery] = overlap.raw.season.findFirst.mock
      .calls as unknown as [unknown, [{ where: Record<string, unknown> }]];
    expect(overlapQuery[0].where).toMatchObject({
      id: { not: 'sea_2026_s0_20261114' },
      suspendedAt: null,
      status: { in: ['upcoming', 'active'] },
      startAt: { lt: new Date('2026-11-29T15:00:00.000Z') },
      endAt: { gt: new Date('2026-11-14T11:00:00.000Z') },
    });
    for (const c of [existing, used, noSource, armed, overlap])
      expect(c.created).toHaveLength(0);
  });
});
