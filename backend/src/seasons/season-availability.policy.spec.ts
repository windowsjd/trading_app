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
  isSeasonSuspended,
  LAUNCH_DURATION_MS,
  publicSeasonWhere,
  seasonDisplayBadge,
} from './season-availability.policy';
import {
  assertSeasonTradable,
  isSeasonCurrentlyActive,
} from './season-lifecycle.policy';
import {
  parseLaunchStart,
  seasonDatabaseNow,
} from './launch-season.operations';

describe('launch season availability and exact date policy', () => {
  const now = new Date('2026-10-21T00:00:00Z');
  it('the explicit metadata chooses beta, independent of name or ID', () => {
    expect(seasonDisplayBadge({ launchKind: 'test' })).toBe('beta');
    expect(seasonDisplayBadge({ launchKind: 'release' })).toBe('beta');
    expect(seasonDisplayBadge({ launchKind: null })).toBeNull();
    expect(seasonDisplayBadge({})).toBeNull();
  });
  it('suspension and the exact armed cutoff fence the season without changing its lifecycle', () => {
    const s = {
      status: 'active' as const,
      startAt: new Date('2000-01-01Z'),
      endAt: new Date('2099-12-31Z'),
      tradingCutoffAt: now,
    };
    expect(isSeasonCurrentlyActive(s, new Date(+now - 1))).toBe(true);
    expect(isSeasonCurrentlyActive(s, now)).toBe(false);
    expect(() => assertSeasonTradable(s, now)).toThrow('not available');
    expect(isSeasonSuspended({ suspendedAt: now }, new Date(+now - 1))).toBe(
      true,
    );
    expect(s.status).toBe('active');
    expect(publicSeasonWhere(now).suspendedAt).toBeNull();
  });
  it('refuses a non-UTC database session before launch administration', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ now, timezone: 'Asia/Seoul' }]),
    };
    await expect(seasonDatabaseNow(tx as never)).rejects.toThrow(
      'UTC database session',
    );
    tx.$queryRaw.mockResolvedValue([{ now, timezone: 'UTC' }]);
    expect((await seasonDatabaseNow(tx as never)).getTime()).toBe(+now);
  });
  it('KST is converted to UTC and twenty-one days are exactly 504 hours', () => {
    const start = parseLaunchStart('2027-01-01T09:00:00+09:00');
    expect(start.toISOString()).toBe('2027-01-01T00:00:00.000Z');
    expect(new Date(+start + LAUNCH_DURATION_MS).toISOString()).toBe(
      '2027-01-22T00:00:00.000Z',
    );
    for (const bad of [
      '2026-02-30T00:00:00Z',
      '2026-01-01T24:00:00Z',
      '2026-01-01T00:00:00',
      'invalid',
    ])
      expect(() => parseLaunchStart(bad)).toThrow();
  });
});
