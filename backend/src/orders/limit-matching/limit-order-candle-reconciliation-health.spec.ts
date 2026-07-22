// The health service reaches the checkpoint repository, which imports
// PrismaService and therefore the generated client. Jest cannot load the
// generated ESM entry point, so the module is stubbed exactly as the other
// limit-matching unit specs do; nothing here touches a database.
jest.mock('../../generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
  Prisma: {},
}));

import { HttpException } from '@nestjs/common';
import {
  LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES,
  LimitOrderCandleReconciliationHealthService,
} from './limit-order-candle-reconciliation-health.service';
import type {
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

function service(input: {
  checkpoint?: ReconciliationCheckpoint | null;
  backlog?: DeferredBacklog;
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

  it('fails closed when the deferred backlog exceeds its limit', async () => {
    const failure = await service({
      backlog: backlog({ openCount: 999 }),
      env: {
        LIMIT_ORDER_CANDLE_RECONCILIATION_MAX_DEFERRED_BACKLOG: '10',
      },
    }).evaluate(NOW);
    expect(failure?.code).toBe(
      LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.backlogExceeded,
    );
  });

  it('fails closed when a candle is parked as permanently unprocessable', async () => {
    const failure = await service({
      backlog: backlog({ permanentCount: 1 }),
    }).evaluate(NOW);
    expect(failure?.code).toBe(
      LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.backlogExceeded,
    );
  });

  it('fails closed when the oldest deferral is too old', async () => {
    const failure = await service({
      backlog: backlog({
        openCount: 1,
        oldestFirstDeferredAt: new Date(NOW.getTime() - 86_400_000),
      }),
    }).evaluate(NOW);
    expect(failure?.code).toBe(
      LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.backlogExceeded,
    );
  });

  it('fails closed on repeated reservation mismatches', async () => {
    const failure = await service({
      checkpoint: checkpoint({ reservationMismatchCount: 5 }),
    }).evaluate(NOW);
    expect(failure?.code).toBe(
      LIMIT_ORDER_CANDLE_RECONCILIATION_ERROR_CODES.reservationMismatch,
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
