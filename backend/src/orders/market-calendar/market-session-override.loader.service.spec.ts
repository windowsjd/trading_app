jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
}));

import { Logger } from '@nestjs/common';
import {
  MARKET_SESSION_OVERRIDE_COLD_RETRY_INTERVAL_MS,
  MARKET_SESSION_OVERRIDE_REFRESH_INTERVAL_MS,
  MarketSessionOverrideLoaderService,
} from './market-session-override.loader.service';
import {
  findActiveMarketSessionOverride,
  getMarketSessionOverrideStoreStatus,
  isMarketSessionOverrideStoreReady,
  resetMarketSessionOverrideStoreForTest,
} from './market-session-override.store';

type OverrideRow = {
  market: string;
  localDate: string;
  overrideType: string;
  openTime: string | null;
  closeTime: string | null;
  reason: string;
};

describe('MarketSessionOverrideLoaderService', () => {
  const closedRow: OverrideRow = {
    market: 'KRX',
    localDate: '2026-07-13',
    overrideType: 'closed',
    openTime: null,
    closeTime: null,
    reason: 'emergency closure',
  };
  const customRow: OverrideRow = {
    market: 'US',
    localDate: '2026-07-14',
    overrideType: 'custom',
    openTime: '103000',
    closeTime: '160000',
    reason: 'delayed open',
  };

  const createPrisma = () => ({
    marketSessionOverride: {
      findMany: jest.fn(),
    },
  });

  const createService = () => {
    const prisma = createPrisma();
    const service = new MarketSessionOverrideLoaderService(prisma as never);
    return { prisma, service };
  };

  afterEach(() => {
    resetMarketSessionOverrideStoreForTest();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('loads active overrides at startup and marks the store ready', async () => {
    jest.useFakeTimers();
    const { prisma, service } = createService();
    prisma.marketSessionOverride.findMany.mockResolvedValue([
      closedRow,
      customRow,
    ]);

    await service.onModuleInit();

    expect(prisma.marketSessionOverride.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { isActive: true } }),
    );
    expect(isMarketSessionOverrideStoreReady()).toBe(true);
    expect(findActiveMarketSessionOverride('KRX', '2026-07-13')).toMatchObject({
      overrideType: 'closed',
    });
    expect(findActiveMarketSessionOverride('US', '2026-07-14')).toMatchObject({
      overrideType: 'custom',
      openTime: '103000',
      closeTime: '160000',
    });
    await service.onModuleDestroy();
  });

  it('fails closed on cold-start load failure, then recovers on the retry tick', async () => {
    jest.useFakeTimers();
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const { prisma, service } = createService();
    prisma.marketSessionOverride.findMany
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValue([closedRow]);

    await service.onModuleInit();

    expect(isMarketSessionOverrideStoreReady()).toBe(false);
    expect(getMarketSessionOverrideStoreStatus()).toMatchObject({
      mode: 'required',
      loaded: false,
    });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('market_session_override_cold_start_load_failed'),
    );

    await jest.advanceTimersByTimeAsync(
      MARKET_SESSION_OVERRIDE_COLD_RETRY_INTERVAL_MS,
    );

    expect(isMarketSessionOverrideStoreReady()).toBe(true);
    expect(findActiveMarketSessionOverride('KRX', '2026-07-13')).not.toBeNull();
    await service.onModuleDestroy();
  });

  it('keeps the last-known-good snapshot and warns when a refresh fails', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { prisma, service } = createService();
    prisma.marketSessionOverride.findMany.mockResolvedValueOnce([closedRow]);

    await expect(service.refreshNow('test')).resolves.toBe(true);
    prisma.marketSessionOverride.findMany.mockRejectedValueOnce(
      new Error('transient'),
    );

    await expect(service.refreshNow('poll')).resolves.toBe(false);

    expect(isMarketSessionOverrideStoreReady()).toBe(true);
    expect(findActiveMarketSessionOverride('KRX', '2026-07-13')).not.toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('market_session_override_refresh_failed'),
    );
  });

  it('applies an operator mutation immediately via refreshNow', async () => {
    const { prisma, service } = createService();
    prisma.marketSessionOverride.findMany.mockResolvedValueOnce([]);
    await service.refreshNow('test');
    expect(findActiveMarketSessionOverride('KRX', '2026-07-13')).toBeNull();

    prisma.marketSessionOverride.findMany.mockResolvedValueOnce([closedRow]);
    await service.refreshNow('operator_mutation');
    expect(findActiveMarketSessionOverride('KRX', '2026-07-13')).toMatchObject({
      overrideType: 'closed',
    });
  });

  it('drops deactivated overrides on refresh (inactive rows are never served)', async () => {
    const { prisma, service } = createService();
    prisma.marketSessionOverride.findMany.mockResolvedValueOnce([closedRow]);
    await service.refreshNow('test');
    expect(findActiveMarketSessionOverride('KRX', '2026-07-13')).not.toBeNull();

    // The deactivated row no longer matches the isActive:true query.
    prisma.marketSessionOverride.findMany.mockResolvedValueOnce([]);
    await service.refreshNow('operator_mutation');
    expect(findActiveMarketSessionOverride('KRX', '2026-07-13')).toBeNull();
  });

  it('notifies change listeners with only the affected markets', async () => {
    const { prisma, service } = createService();
    const listener = jest.fn();
    service.onOverridesChanged(listener);

    prisma.marketSessionOverride.findMany.mockResolvedValueOnce([customRow]);
    await service.refreshNow('test');
    // First load has no previous snapshot to diff against.
    expect(listener).not.toHaveBeenCalled();

    prisma.marketSessionOverride.findMany.mockResolvedValueOnce([
      customRow,
      closedRow,
    ]);
    await service.refreshNow('poll');
    expect(listener).toHaveBeenCalledWith(['KRX']);

    // Unchanged content does not notify.
    listener.mockClear();
    prisma.marketSessionOverride.findMany.mockResolvedValueOnce([
      closedRow,
      customRow,
    ]);
    await service.refreshNow('poll');
    expect(listener).not.toHaveBeenCalled();
  });

  it('supports unsubscribe for change listeners', async () => {
    const { prisma, service } = createService();
    const listener = jest.fn();
    const unsubscribe = service.onOverridesChanged(listener);
    prisma.marketSessionOverride.findMany.mockResolvedValueOnce([]);
    await service.refreshNow('test');
    unsubscribe();
    prisma.marketSessionOverride.findMany.mockResolvedValueOnce([closedRow]);
    await service.refreshNow('poll');
    expect(listener).not.toHaveBeenCalled();
  });

  it('skips malformed rows defensively instead of poisoning the snapshot', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const { prisma, service } = createService();
    prisma.marketSessionOverride.findMany.mockResolvedValueOnce([
      closedRow,
      { ...customRow, openTime: null }, // custom without times is invalid
      { ...closedRow, localDate: '2026-7-13', market: 'KRX' }, // bad date
    ]);

    await expect(service.refreshNow('test')).resolves.toBe(true);
    expect(findActiveMarketSessionOverride('KRX', '2026-07-13')).not.toBeNull();
    expect(findActiveMarketSessionOverride('US', '2026-07-14')).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('market_session_override_row_invalid'),
    );
  });

  it('polls on the documented bounded interval after a successful load', async () => {
    jest.useFakeTimers();
    const { prisma, service } = createService();
    prisma.marketSessionOverride.findMany.mockResolvedValue([]);

    await service.onModuleInit();
    expect(prisma.marketSessionOverride.findMany).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(
      MARKET_SESSION_OVERRIDE_REFRESH_INTERVAL_MS - 1,
    );
    expect(prisma.marketSessionOverride.findMany).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1);
    expect(prisma.marketSessionOverride.findMany).toHaveBeenCalledTimes(2);
    await service.onModuleDestroy();
  });
});
