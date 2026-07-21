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

  describe('mutation/polling refresh serialization', () => {
    // Deterministic concurrency harness: DB reads are gated on deferred
    // promises (no sleeps, no timers), so interleavings are forced exactly.
    const deferred = <T>() => {
      let resolve!: (value: T) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };

    // Drains microtasks until the mock has been invoked `count` times.
    // Purely microtask-based — never waits on wall-clock time.
    const waitForCalls = async (mock: jest.Mock, count: number) => {
      for (let i = 0; i < 50 && mock.mock.calls.length < count; i += 1) {
        await Promise.resolve();
      }
      expect(mock.mock.calls.length).toBeGreaterThanOrEqual(count);
    };

    it('re-reads the DB for a mutation that lands while a stale polling read is in flight', async () => {
      const { prisma, service } = createService();
      prisma.marketSessionOverride.findMany.mockResolvedValueOnce([]);
      await service.refreshNow('test');

      // A polling refresh starts and its query snapshot predates the
      // operator's commit (it will resolve with the OLD, empty state).
      const stalePoll = deferred<OverrideRow[]>();
      prisma.marketSessionOverride.findMany.mockReturnValueOnce(
        stalePoll.promise as never,
      );
      const pollPromise = service.refreshNow('poll');

      // Operator commits the override and requests an immediate refresh
      // while the stale polling query is still running.
      prisma.marketSessionOverride.findMany.mockResolvedValueOnce([closedRow]);
      const mutationPromise = service.refreshNow('operator_mutation');

      stalePoll.resolve([]);
      await expect(pollPromise).resolves.toBe(true);

      // The mutation did NOT join the stale poll: it triggered one more DB
      // read after the poll finished, and the store ends with the override.
      await expect(mutationPromise).resolves.toBe(true);
      expect(prisma.marketSessionOverride.findMany).toHaveBeenCalledTimes(3);
      expect(
        findActiveMarketSessionOverride('KRX', '2026-07-13'),
      ).toMatchObject({ overrideType: 'closed' });
    });

    it('coalesces overlapping mutations into one follow-up read without missing the final state', async () => {
      const { prisma, service } = createService();
      prisma.marketSessionOverride.findMany.mockResolvedValueOnce([]);
      await service.refreshNow('test');

      const stalePoll = deferred<OverrideRow[]>();
      prisma.marketSessionOverride.findMany.mockReturnValueOnce(
        stalePoll.promise as never,
      );
      const pollPromise = service.refreshNow('poll');

      // Two mutations commit while the poll is in flight. Both share ONE
      // queued follow-up read (no per-caller refresh explosion), and that
      // read starts after both commits, so it sees the final state.
      prisma.marketSessionOverride.findMany.mockResolvedValueOnce([
        closedRow,
        customRow,
      ]);
      const firstMutation = service.refreshNow('operator_mutation');
      const secondMutation = service.refreshNow('operator_mutation');

      stalePoll.resolve([]);
      await expect(pollPromise).resolves.toBe(true);
      await expect(firstMutation).resolves.toBe(true);
      await expect(secondMutation).resolves.toBe(true);
      expect(prisma.marketSessionOverride.findMany).toHaveBeenCalledTimes(3);
      expect(
        findActiveMarketSessionOverride('KRX', '2026-07-13'),
      ).not.toBeNull();
      expect(
        findActiveMarketSessionOverride('US', '2026-07-14'),
      ).not.toBeNull();
    });

    it('starts a fresh read for a mutation that lands after the queued read began', async () => {
      const { prisma, service } = createService();
      prisma.marketSessionOverride.findMany.mockResolvedValueOnce([]);
      await service.refreshNow('test');

      const stalePoll = deferred<OverrideRow[]>();
      prisma.marketSessionOverride.findMany.mockReturnValueOnce(
        stalePoll.promise as never,
      );
      const pollPromise = service.refreshNow('poll');

      const queuedRead = deferred<OverrideRow[]>();
      prisma.marketSessionOverride.findMany.mockReturnValueOnce(
        queuedRead.promise as never,
      );
      const firstMutation = service.refreshNow('operator_mutation');

      stalePoll.resolve([]);
      await expect(pollPromise).resolves.toBe(true);
      // Wait (microtasks only) until the queued follow-up read has started.
      await waitForCalls(prisma.marketSessionOverride.findMany, 3);

      // A second mutation commits AFTER the queued read began: it must not
      // join that read (whose snapshot predates this commit) but get its own.
      prisma.marketSessionOverride.findMany.mockResolvedValueOnce([
        closedRow,
        customRow,
      ]);
      const secondMutation = service.refreshNow('operator_mutation');

      queuedRead.resolve([closedRow]);
      await expect(firstMutation).resolves.toBe(true);
      await expect(secondMutation).resolves.toBe(true);
      expect(prisma.marketSessionOverride.findMany).toHaveBeenCalledTimes(4);
      // The final snapshot includes the second mutation's state.
      expect(
        findActiveMarketSessionOverride('US', '2026-07-14'),
      ).not.toBeNull();
    });

    it('returns false and keeps last-known-good when the post-commit read fails', async () => {
      jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { prisma, service } = createService();
      prisma.marketSessionOverride.findMany.mockResolvedValueOnce([closedRow]);
      await service.refreshNow('test');

      const stalePoll = deferred<OverrideRow[]>();
      prisma.marketSessionOverride.findMany.mockReturnValueOnce(
        stalePoll.promise as never,
      );
      const pollPromise = service.refreshNow('poll');

      prisma.marketSessionOverride.findMany.mockRejectedValueOnce(
        new Error('db down'),
      );
      const mutationPromise = service.refreshNow('operator_mutation');

      stalePoll.resolve([closedRow]);
      await expect(pollPromise).resolves.toBe(true);
      // The mutation's own follow-up read failed → applied is NOT confirmed.
      await expect(mutationPromise).resolves.toBe(false);
      expect(isMarketSessionOverrideStoreReady()).toBe(true);
      expect(
        findActiveMarketSessionOverride('KRX', '2026-07-13'),
      ).not.toBeNull();
    });

    it('notifies listeners exactly once when only the queued read changes content', async () => {
      const { prisma, service } = createService();
      const listener = jest.fn();
      service.onOverridesChanged(listener);
      prisma.marketSessionOverride.findMany.mockResolvedValueOnce([]);
      await service.refreshNow('test');

      const stalePoll = deferred<OverrideRow[]>();
      prisma.marketSessionOverride.findMany.mockReturnValueOnce(
        stalePoll.promise as never,
      );
      const pollPromise = service.refreshNow('poll');
      prisma.marketSessionOverride.findMany.mockResolvedValueOnce([closedRow]);
      const mutationPromise = service.refreshNow('operator_mutation');

      stalePoll.resolve([]);
      await Promise.all([pollPromise, mutationPromise]);
      // The stale poll applied identical content (no notification); only the
      // queued read's real change notified — exactly one invalidation.
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(['KRX']);
    });

    it('does not notify listeners when the queued read applies identical content', async () => {
      const { prisma, service } = createService();
      const listener = jest.fn();
      service.onOverridesChanged(listener);
      prisma.marketSessionOverride.findMany.mockResolvedValueOnce([closedRow]);
      await service.refreshNow('test');

      const stalePoll = deferred<OverrideRow[]>();
      prisma.marketSessionOverride.findMany.mockReturnValueOnce(
        stalePoll.promise as never,
      );
      const pollPromise = service.refreshNow('poll');
      prisma.marketSessionOverride.findMany.mockResolvedValueOnce([closedRow]);
      const mutationPromise = service.refreshNow('operator_mutation');

      stalePoll.resolve([closedRow]);
      await Promise.all([pollPromise, mutationPromise]);
      expect(listener).not.toHaveBeenCalled();
    });
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
