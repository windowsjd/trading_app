jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');
  return {
    CurrencyCode: { KRW: 'KRW', USD: 'USD' },
    FxRateSourceType: {
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
      official_batch: 'official_batch',
    },
    Prisma: { Decimal },
  };
});

import { FxRateSourceType, Prisma } from '../generated/prisma/client';
import { findUsdKrwProviderSnapshotCandidates } from './fx-rate-snapshot-query';
import { FX_USD_KRW_PROVIDER_SOURCE_PRIORITY } from './source-eligibility.policy';

describe('findUsdKrwProviderSnapshotCandidates', () => {
  const observedAt = new Date('2026-09-10T00:00:00.000Z');
  const snapshot = (id: string, sourceName: string) => ({
    id,
    baseCurrency: 'USD',
    quoteCurrency: 'KRW',
    rate: new Prisma.Decimal('1390'),
    sourceType: FxRateSourceType.provider_api,
    sourceName,
    effectiveAt: observedAt,
    capturedAt: observedAt,
    createdAt: observedAt,
    approvedByUserId: null,
  });

  it('adds a bounded source-specific read when a global page is starved by one provider', async () => {
    const eximRows = Array.from({ length: 10 }, (_, index) =>
      snapshot(`exim-${index}`, 'korea_exim_exchange_rate'),
    );
    const exchangeRateRow = snapshot('fallback-1', 'exchange_rate_api');
    const findMany = jest
      .fn()
      .mockResolvedValueOnce(eximRows)
      .mockResolvedValueOnce([exchangeRateRow]);

    const candidates = await findUsdKrwProviderSnapshotCandidates(
      { fxRateSnapshot: { findMany } } as never,
      {
        sourceNames: FX_USD_KRW_PROVIDER_SOURCE_PRIORITY,
        take: 10,
      },
    );

    expect(candidates).toContainEqual(exchangeRateRow);
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ sourceName: 'exchange_rate_api' }),
        take: 10,
      }),
    );
  });

  it('keeps the common path to one query when both provider sources are present', async () => {
    const findMany = jest.fn().mockResolvedValueOnce([
      snapshot('exim-1', 'korea_exim_exchange_rate'),
      snapshot('fallback-1', 'exchange_rate_api'),
    ]);

    await findUsdKrwProviderSnapshotCandidates(
      { fxRateSnapshot: { findMany } } as never,
      {
        sourceNames: FX_USD_KRW_PROVIDER_SOURCE_PRIORITY,
        take: 10,
      },
    );

    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
