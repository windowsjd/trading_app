// The health service reaches the checkpoint repository, which imports
// PrismaService and therefore the generated client. Jest cannot load the
// generated ESM entry point, so the module is stubbed exactly as the other
// limit-matching unit specs do; nothing here touches a database.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
  Prisma: {},
  OrderSide: { buy: 'buy', sell: 'sell' },
  OrderStatus: { submitted: 'submitted', executed: 'executed' },
  OrderType: { limit: 'limit', market: 'market' },
}));

import { HttpException } from '@nestjs/common';
import {
  LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES,
  LimitOrderCandleReconciliationHealthService,
} from './limit-order-candle-reconciliation-health.service';
import type {
  AssetDeferredBacklog,
  DeferredBacklog,
  ReconciliationCheckpoint,
} from './limit-order-reconciliation-checkpoint.repository';

const NOW = new Date('2026-07-22T10:00:00.000Z');

function checkpoint(
  overrides: Partial<ReconciliationCheckpoint> = {},
): ReconciliationCheckpoint {
  return {
    scope: '5m',
    interval: '5m',
    watermark: {
      openTime: new Date('2026-07-22T09:40:00.000Z'),
      candleId: 'c',
    },
    // The gate reads none of the storage-order position, but the checkpoint
    // shape carries it, so the fixture must be a real checkpoint.
    ingest: {
      watermarkSeq: 10n,
      pendingSeq: 12n,
      pendingObservedAt: NOW,
      lastScannedSeq: 10n,
    },
    lastScannedOpenTime: null,
    lastScannedCloseTime: null,
    lastRunAt: NOW,
    lastSuccessfulRunAt: NOW,
    lastWindowCompletionRunAt: NOW,
    lastWindowCompletionSuccessfulAt: NOW,
    windowCompletionErrorCode: null,
    windowCompletionErrorMessage: null,
    windowCompletionConsecutiveFailures: 0,
    degradedReason: null,
    gapDetectedAt: null,
    gapFromOpenTime: null,
    gapToOpenTime: null,
    reservationMismatchCount: 0,
    lastReservationMismatchAt: null,
    ...overrides,
  };
}

function backlog(overrides: Partial<DeferredBacklog> = {}): DeferredBacklog {
  return {
    openCount: 0,
    permanentCount: 0,
    oldestFirstDeferredAt: null,
    ...overrides,
  };
}

function assetBacklog(
  overrides: Partial<AssetDeferredBacklog> = {},
): AssetDeferredBacklog {
  return {
    deferredCount: 0,
    permanentCount: 0,
    oldestDeferredAt: null,
    oldestPermanentAt: null,
    ...overrides,
  };
}

type WindowCompletionRow = {
  pendingWindowOpenTime: Date | null;
  pendingSince: Date | null;
  lastErrorCode: string | null;
  degradedReason: string | null;
  gapDetectedAt: Date | null;
} | null;

function service(input: {
  checkpoint?: ReconciliationCheckpoint | null;
  backlog?: DeferredBacklog;
  assetBacklogs?: Record<string, AssetDeferredBacklog>;
  windowCompletions?: Record<string, WindowCompletionRow>;
  submittedPathBAssets?: string[];
  env?: NodeJS.ProcessEnv;
}) {
  const previous = { ...process.env };
  Object.assign(process.env, {
    LIMIT_ORDER_AUTO_EXECUTION_ENABLED: 'true',
    LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED: 'true',
    ...input.env,
  });
  try {
    return new LimitOrderCandleReconciliationHealthService({
      find: () =>
        Promise.resolve(
          input.checkpoint === undefined ? checkpoint() : input.checkpoint,
        ),
      readBacklog: () => Promise.resolve(input.backlog ?? backlog()),
      readAssetBacklog: (assetId: string) =>
        Promise.resolve(input.assetBacklogs?.[assetId] ?? assetBacklog()),
      findWindowCompletion: (assetId: string) =>
        Promise.resolve(input.windowCompletions?.[assetId] ?? null),
      hasSubmittedPathBOrder: (assetId: string) =>
        Promise.resolve(
          input.submittedPathBAssets?.includes(assetId) ?? false,
        ),
    } as never);
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  }
}

describe('LimitOrderCandleReconciliationHealthService', () => {
  it('is inert when path B is disabled', async () => {
    const health = service({
      checkpoint: null,
      env: { LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED: 'false' },
    });
    // A deployment that never enabled the safety net must not have its limit
    // orders blocked by the safety net's own health.
    expect(await health.evaluate(NOW)).toBeNull();
    await expect(health.assertAvailable(NOW)).resolves.toBeUndefined();
  });

  it('passes on a healthy checkpoint with no backlog', async () => {
    expect(await service({}).evaluate(NOW)).toBeNull();
  });

  it('treats a quiet market as healthy', async () => {
    // Nothing scanned, nothing matched, no deferral: a market with no eligible
    // candle is NOT a failure.
    const health = service({
      checkpoint: checkpoint({
        lastScannedOpenTime: null,
        lastScannedCloseTime: null,
      }),
      backlog: backlog(),
    });
    expect(await health.evaluate(NOW)).toBeNull();
  });

  it('fails closed when no checkpoint was ever established', async () => {
    const failure = await service({ checkpoint: null }).evaluate(NOW);
    expect(failure?.code).toBe(
      LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.unavailable,
    );
  });

  it('fails closed on a detected retention gap', async () => {
    const failure = await service({
      checkpoint: checkpoint({
        gapDetectedAt: NOW,
        degradedReason: 'candle_retention_passed_watermark',
      }),
    }).evaluate(NOW);
    expect(failure?.code).toBe(
      LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.gapDetected,
    );
  });

  it('fails closed on a stale sweep', async () => {
    const failure = await service({
      checkpoint: checkpoint({
        lastSuccessfulRunAt: new Date(NOW.getTime() - 86_400_000),
      }),
    }).evaluate(NOW);
    expect(failure?.code).toBe(
      LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.stale,
    );
  });

  // -------------------------------------------------------------------------
  // Window-completion heartbeat, separate from the row scan
  // -------------------------------------------------------------------------

  it('fails closed when the completion pass never succeeded, even with a healthy row scan', async () => {
    // THE hidden-failure case: row scan fine, completion never succeeded.
    const failure = await service({
      checkpoint: checkpoint({
        lastWindowCompletionRunAt: NOW,
        lastWindowCompletionSuccessfulAt: null,
        windowCompletionErrorCode: 'LIMIT_ORDER_WINDOW_COMPLETION_FAILED',
        windowCompletionConsecutiveFailures: 3,
      }),
    }).evaluate(NOW);
    expect(failure?.code).toBe(
      LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.completionUnavailable,
    );
  });

  it('fails closed when the completion heartbeat is stale while the row scan is fresh', async () => {
    const failure = await service({
      checkpoint: checkpoint({
        lastSuccessfulRunAt: NOW,
        lastWindowCompletionSuccessfulAt: new Date(
          NOW.getTime() - 86_400_000,
        ),
        windowCompletionErrorCode: 'LIMIT_ORDER_WINDOW_COMPLETION_FAILED',
        windowCompletionConsecutiveFailures: 12,
      }),
    }).evaluate(NOW);
    expect(failure?.code).toBe(
      LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.completionStale,
    );
  });

  it('recovers once the completion pass succeeds again', async () => {
    const health = service({
      checkpoint: checkpoint({
        lastWindowCompletionSuccessfulAt: NOW,
        windowCompletionErrorCode: null,
        windowCompletionConsecutiveFailures: 0,
      }),
    });
    expect(await health.evaluate(NOW)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Global gate = emergency tier only
  // -------------------------------------------------------------------------

  it('fails every asset closed when the TOTAL backlog exceeds the emergency limit', async () => {
    const failure = await service({
      backlog: backlog({ openCount: 999 }),
      env: {
        LIMIT_ORDER_CANDLE_RECONCILIATION_MAX_DEFERRED_BACKLOG: '10',
        LIMIT_ORDER_CANDLE_MAX_ASSET_DEFERRED_BACKLOG: '5',
      },
    }).evaluate(NOW);
    expect(failure?.code).toBe(
      LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.backlogExceeded,
    );
  });

  it('does NOT fail globally on a single permanent entry — that is asset-scoped', async () => {
    expect(
      await service({
        backlog: backlog({ permanentCount: 1 }),
      }).evaluate(NOW),
    ).toBeNull();
  });

  it('does NOT fail globally on one old deferral — that is asset-scoped', async () => {
    expect(
      await service({
        backlog: backlog({
          openCount: 1,
          oldestFirstDeferredAt: new Date(NOW.getTime() - 86_400_000),
        }),
      }).evaluate(NOW),
    ).toBeNull();
  });

  it('fails closed on repeated reservation mismatches', async () => {
    const failure = await service({
      checkpoint: checkpoint({ reservationMismatchCount: 5 }),
    }).evaluate(NOW);
    expect(failure?.code).toBe(
      LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.reservationMismatch,
    );
  });

  // -------------------------------------------------------------------------
  // Asset-scoped isolation
  // -------------------------------------------------------------------------

  it('blocks only the asset with a permanent entry; a healthy sibling passes', async () => {
    const health = service({
      assetBacklogs: {
        'asset-a': assetBacklog({
          permanentCount: 1,
          oldestPermanentAt: new Date(NOW.getTime() - 3_600_000),
        }),
      },
    });
    const failureA = await health.evaluate(NOW, 'asset-a');
    expect(failureA?.code).toBe(
      LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.assetPermanentFailure,
    );
    expect(await health.evaluate(NOW, 'asset-b')).toBeNull();
  });

  it('blocks only the asset whose deferred backlog exceeds its limit', async () => {
    const health = service({
      assetBacklogs: {
        'asset-a': assetBacklog({ deferredCount: 99 }),
      },
      env: { LIMIT_ORDER_CANDLE_MAX_ASSET_DEFERRED_BACKLOG: '10' },
    });
    const failureA = await health.evaluate(NOW, 'asset-a');
    expect(failureA?.code).toBe(
      LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.assetBacklogExceeded,
    );
    expect(await health.evaluate(NOW, 'asset-b')).toBeNull();
  });

  it('blocks only the asset whose oldest deferral aged past the limit', async () => {
    const health = service({
      assetBacklogs: {
        'asset-a': assetBacklog({
          deferredCount: 1,
          oldestDeferredAt: new Date(NOW.getTime() - 86_400_000),
        }),
      },
    });
    const failureA = await health.evaluate(NOW, 'asset-a');
    expect(failureA?.code).toBe(
      LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.assetBacklogExceeded,
    );
    expect(await health.evaluate(NOW, 'asset-b')).toBeNull();
  });

  it('fails an asset with a submitted path-B order but no completion checkpoint', async () => {
    const health = service({
      submittedPathBAssets: ['asset-a'],
    });
    const failure = await health.evaluate(NOW, 'asset-a');
    expect(failure?.code).toBe(
      LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.completionUnavailable,
    );
  });

  it('passes an asset with no orders and no completion checkpoint', async () => {
    expect(await service({}).evaluate(NOW, 'asset-fresh')).toBeNull();
  });

  it('a global failure blocks every asset', async () => {
    const health = service({
      checkpoint: checkpoint({
        lastSuccessfulRunAt: new Date(NOW.getTime() - 86_400_000),
      }),
    });
    expect((await health.evaluate(NOW, 'asset-a'))?.code).toBe(
      LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.stale,
    );
    expect((await health.evaluate(NOW, 'asset-b'))?.code).toBe(
      LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.stale,
    );
  });

  it('uses codes distinct from the path-A matcher gate', async () => {
    // An operator must be able to tell "live fills stopped" from "the safety
    // net under live fills stopped" without reading logs.
    const codes = Object.values(LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES);
    for (const code of codes) {
      expect(code.startsWith('LIMIT_ORDER_CANDLE_')).toBe(true);
      expect(code).not.toBe('LIMIT_ORDER_MATCHER_UNAVAILABLE');
      expect(code).not.toBe('LIMIT_ORDER_MATCHER_DEGRADED');
      expect(code).not.toBe('LIMIT_ORDER_MATCHER_LAG_EXCEEDED');
    }
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('raises a 503 API envelope, not a bare error', async () => {
    const health = service({ checkpoint: null });
    await expect(health.assertAvailable(NOW)).rejects.toBeInstanceOf(
      HttpException,
    );
    try {
      await health.assertAvailable(NOW);
    } catch (error) {
      const response = (error as HttpException).getResponse() as {
        success: boolean;
        error: { code: string; message: string };
      };
      expect((error as HttpException).getStatus()).toBe(503);
      expect(response.success).toBe(false);
      expect(response.error.code).toBe(
        LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.unavailable,
      );
      expect(typeof response.error.message).toBe('string');
    }
  });
});
