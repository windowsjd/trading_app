jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    CurrencyCode: {
      KRW: 'KRW',
      USD: 'USD',
    },
    FxRateSourceType: {
      official_batch: 'official_batch',
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
    },
    Prisma: {
      Decimal,
    },
  };
});

import {
  CurrencyCode,
  FxRateSourceType,
  Prisma,
} from '../generated/prisma/client';
import {
  compareFxSnapshotsForExecute,
  isAllowedExecuteSourceType,
  isFutureSnapshot,
  isFxSnapshotStale,
  selectEligibleFxSnapshotForExecute,
} from './fx-execute-snapshot-policy';

describe('fx execute snapshot policy', () => {
  const executeNow = new Date('2026-05-01T00:01:00.000Z');

  const snapshot = (
    id: string,
    overrides: Partial<{
      baseCurrency: CurrencyCode;
      quoteCurrency: CurrencyCode;
      sourceType: FxRateSourceType;
      rate: string | Prisma.Decimal;
      effectiveAt: Date;
      capturedAt: Date;
      createdAt: Date;
    }> = {},
  ) => ({
    id,
    baseCurrency: CurrencyCode.USD,
    quoteCurrency: CurrencyCode.KRW,
    sourceType: FxRateSourceType.admin_manual,
    rate: '1350.00000000',
    effectiveAt: new Date('2026-05-01T00:00:30.000Z'),
    capturedAt: new Date('2026-05-01T00:00:31.000Z'),
    createdAt: new Date('2026-05-01T00:00:32.000Z'),
    ...overrides,
  });

  it('allows only admin_manual as the near-term execute sourceType', () => {
    expect(isAllowedExecuteSourceType(FxRateSourceType.admin_manual)).toBe(true);
    expect(isAllowedExecuteSourceType(FxRateSourceType.provider_api)).toBe(false);
    expect(isAllowedExecuteSourceType(FxRateSourceType.official_batch)).toBe(
      false,
    );
  });

  it('detects future snapshots separately from stale snapshots', () => {
    const futureEffectiveAt = new Date('2026-05-01T00:01:00.001Z');

    expect(isFutureSnapshot(futureEffectiveAt, executeNow)).toBe(true);
    expect(isFxSnapshotStale(futureEffectiveAt, executeNow)).toBe(false);
  });

  it('applies the accepted 60 second freshness boundary', () => {
    expect(
      isFxSnapshotStale(new Date('2026-04-30T23:59:59.999Z'), executeNow),
    ).toBe(true);
    expect(
      isFxSnapshotStale(new Date('2026-05-01T00:00:00.000Z'), executeNow),
    ).toBe(false);
    expect(
      isFxSnapshotStale(new Date('2026-05-01T00:00:00.001Z'), executeNow),
    ).toBe(false);
  });

  it('selects the latest eligible snapshot by effectiveAt desc', () => {
    const older = snapshot('older', {
      effectiveAt: new Date('2026-05-01T00:00:10.000Z'),
    });
    const latest = snapshot('latest', {
      effectiveAt: new Date('2026-05-01T00:00:50.000Z'),
    });

    expect(selectEligibleFxSnapshotForExecute([older, latest], executeNow)).toBe(
      latest,
    );
  });

  it('tie-breaks by capturedAt desc and then createdAt desc', () => {
    const first = snapshot('first', {
      effectiveAt: new Date('2026-05-01T00:00:30.000Z'),
      capturedAt: new Date('2026-05-01T00:00:30.000Z'),
      createdAt: new Date('2026-05-01T00:00:59.000Z'),
    });
    const second = snapshot('second', {
      effectiveAt: new Date('2026-05-01T00:00:30.000Z'),
      capturedAt: new Date('2026-05-01T00:00:31.000Z'),
      createdAt: new Date('2026-05-01T00:00:00.000Z'),
    });
    const third = snapshot('third', {
      effectiveAt: new Date('2026-05-01T00:00:30.000Z'),
      capturedAt: new Date('2026-05-01T00:00:31.000Z'),
      createdAt: new Date('2026-05-01T00:00:59.000Z'),
    });

    expect(
      [first, second, third].toSorted(compareFxSnapshotsForExecute),
    ).toEqual([third, second, first]);
    expect(
      selectEligibleFxSnapshotForExecute([first, second, third], executeNow),
    ).toBe(third);
  });

  it('ignores future effectiveAt snapshots', () => {
    const future = snapshot('future', {
      effectiveAt: new Date('2026-05-01T00:01:01.000Z'),
    });
    const eligible = snapshot('eligible');

    expect(
      selectEligibleFxSnapshotForExecute([future, eligible], executeNow),
    ).toBe(eligible);
  });

  it('ignores disallowed sourceTypes', () => {
    const provider = snapshot('provider', {
      sourceType: FxRateSourceType.provider_api,
    });
    const official = snapshot('official', {
      sourceType: FxRateSourceType.official_batch,
    });

    expect(
      selectEligibleFxSnapshotForExecute([provider, official], executeNow),
    ).toBeNull();
  });

  it('returns null when no eligible snapshot exists', () => {
    expect(selectEligibleFxSnapshotForExecute([], executeNow)).toBeNull();
  });

  it('requires positive rates', () => {
    const zero = snapshot('zero', { rate: '0' });
    const negative = snapshot('negative', { rate: '-1' });
    const invalid = snapshot('invalid', { rate: 'not-a-rate' });
    const positive = snapshot('positive', {
      rate: new Prisma.Decimal('1350.00000000'),
    });

    expect(
      selectEligibleFxSnapshotForExecute(
        [zero, negative, invalid, positive],
        executeNow,
      ),
    ).toBe(positive);
  });

  it('keeps USD/KRW as the only eligible appliedRate source pair', () => {
    const krwUsd = snapshot('krw-usd', {
      baseCurrency: CurrencyCode.KRW,
      quoteCurrency: CurrencyCode.USD,
    });
    const usdKrw = snapshot('usd-krw');

    expect(
      selectEligibleFxSnapshotForExecute([krwUsd, usdKrw], executeNow),
    ).toBe(usdKrw);
  });
});
