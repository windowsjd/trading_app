jest.mock('../generated/prisma/client', () => ({
  SeasonStatus: {
    upcoming: 'upcoming',
    active: 'active',
    ended: 'ended',
    settled: 'settled',
  },
}));

import { SeasonStatus } from '../generated/prisma/client';
import {
  assertSeasonExchangeable,
  assertSeasonJoinable,
  assertSeasonTradable,
  getEffectiveSeasonMode,
  isSeasonCurrentlyActive,
  SeasonLifecycleError,
  type SeasonLifecycleSeason,
} from './season-lifecycle.policy';

describe('season lifecycle policy', () => {
  const startAt = new Date('2026-06-01T00:00:00.000Z');
  const endAt = new Date('2026-06-14T14:59:00.000Z');
  const within = new Date('2026-06-02T00:00:00.000Z');
  const beforeStart = new Date('2026-05-31T23:59:59.999Z');
  const atEnd = new Date('2026-06-14T14:59:00.000Z');

  const season = (
    status: SeasonStatus,
    overrides: Partial<SeasonLifecycleSeason> = {},
  ): SeasonLifecycleSeason => ({
    status,
    startAt,
    endAt,
    ...overrides,
  });

  it('treats active status within start/end as currently active', () => {
    expect(isSeasonCurrentlyActive(season(SeasonStatus.active), within)).toBe(
      true,
    );
    expect(getEffectiveSeasonMode(season(SeasonStatus.active), within)).toBe(
      'active',
    );
    expect(() =>
      assertSeasonJoinable(season(SeasonStatus.active), within),
    ).not.toThrow();
    expect(() =>
      assertSeasonTradable(season(SeasonStatus.active), within),
    ).not.toThrow();
    expect(() =>
      assertSeasonExchangeable(season(SeasonStatus.active), within),
    ).not.toThrow();
  });

  it('blocks active status before startAt', () => {
    expect(isSeasonCurrentlyActive(season(SeasonStatus.active), beforeStart)).toBe(
      false,
    );
    expect(getEffectiveSeasonMode(season(SeasonStatus.active), beforeStart)).toBe(
      'upcoming',
    );
    expect(() =>
      assertSeasonJoinable(season(SeasonStatus.active), beforeStart),
    ).toThrow(
      expect.objectContaining<Partial<SeasonLifecycleError>>({
        code: 'SEASON_NOT_STARTED',
      }),
    );
  });

  it('blocks active status at and after endAt', () => {
    expect(isSeasonCurrentlyActive(season(SeasonStatus.active), atEnd)).toBe(
      false,
    );
    expect(getEffectiveSeasonMode(season(SeasonStatus.active), atEnd)).toBe(
      'ended',
    );
    expect(() =>
      assertSeasonTradable(season(SeasonStatus.active), atEnd),
    ).toThrow(
      expect.objectContaining<Partial<SeasonLifecycleError>>({
        code: 'SEASON_ENDED',
      }),
    );
  });

  it.each([
    [SeasonStatus.upcoming, 'upcoming'],
    [SeasonStatus.ended, 'ended'],
    [SeasonStatus.settled, 'settled'],
  ] as const)('blocks %s status', (status, mode) => {
    expect(getEffectiveSeasonMode(season(status), within)).toBe(mode);
    expect(() => assertSeasonExchangeable(season(status), within)).toThrow(
      expect.objectContaining<Partial<SeasonLifecycleError>>({
        code: 'SEASON_NOT_ACTIVE',
      }),
    );
  });
});
