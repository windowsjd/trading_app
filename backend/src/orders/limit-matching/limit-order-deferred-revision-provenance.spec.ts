jest.mock('../../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');
  const enums = jest.requireActual<
    typeof import('../../generated/prisma/enums')
  >('../../generated/prisma/enums');
  return {
    ...enums,
    PrismaClient: class PrismaClient {},
    Prisma: { Decimal },
  };
});

import { LimitOrderCandleReconciliationService } from './limit-order-candle-reconciliation.service';
import {
  LimitOrderReconciliationCheckpointRepository,
  type DeferredCandleRow,
  type UpsertDeferredInput,
} from './limit-order-reconciliation-checkpoint.repository';

/**
 * PROVENANCE of a deferred entry's tracked candle revision.
 *
 * `candleIngestSeq` alone cannot say whether the revision was OBSERVED on a
 * candle row or INFERRED by the backfill that introduced the column. A
 * PERMANENT entry carrying an inferred revision blocked that revision from
 * BOTH directions — the forward scan excluded the candle (tracked >= current)
 * and the retry loop skipped the entry (permanent) — so a correction made
 * before the column existed could never be examined.
 *
 * The provenance migration reopens such entries with `revisionState =
 * 'legacy_unknown'` and a NULL revision. These specs pin what the RUNTIME then
 * does with them, in particular that an entry reopened for re-verification can
 * never quietly return to being a trusted `current` entry when the question it
 * was reopened to answer became unanswerable.
 */

const NOW = new Date('2026-07-24T12:00:00.000Z');

type UpsertCall = {
  marketCandleId: string;
  revisionObserved: boolean;
  candleIngestSeq: bigint | null;
  status?: string;
  revisionState?: string;
  errorCode: string | null;
};

function deferredRow(
  overrides: Partial<DeferredCandleRow> = {},
): DeferredCandleRow {
  return {
    marketCandleId: 'candle-1',
    candleIngestSeq: null,
    revisionState: 'legacy_unknown',
    assetId: 'asset-a',
    interval: '5m',
    openTime: new Date('2026-07-24T10:00:00.000Z'),
    closeTime: new Date('2026-07-24T10:05:00.000Z'),
    status: 'deferred',
    firstDeferredAt: new Date('2026-06-01T00:00:00.000Z'),
    lastDeferredAt: new Date('2026-06-01T00:00:00.000Z'),
    attemptCount: 0,
    lastErrorCode: 'LIMIT_ORDER_CANDLE_LEGACY_REVISION_REVIEW',
    nextRetryAt: new Date('2026-07-24T11:59:00.000Z'),
    ...overrides,
  };
}

/** Drives ONLY the deferred-retry stage, with the candle row absent. */
async function retryWithMissingCandle(due: DeferredCandleRow) {
  const previous = { ...process.env };
  Object.assign(process.env, {
    LIMIT_ORDER_AUTO_EXECUTION_ENABLED: 'true',
    LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED: 'true',
  });
  const upserts: UpsertCall[] = [];
  try {
    // Every raw query the stage issues is the candle load, which returns no
    // row: this is the retention-removed case.
    const prisma = { $queryRaw: () => Promise.resolve([]) };
    const checkpoints = {
      findDueDeferred: () => Promise.resolve([due]),
      upsertDeferred: (call: UpsertCall) => {
        upserts.push(call);
        return Promise.resolve();
      },
    };
    const service = new LimitOrderCandleReconciliationService(
      prisma as never,
      undefined as never,
      undefined as never,
      undefined as never,
      checkpoints as never,
    );
    const summary = {
      retriedCandles: 0,
      permanentCandles: 0,
      deferredCandles: 0,
    };
    await (
      service as unknown as {
        runDeferredRetries(
          now: Date,
          orderBatchSize: number,
          summary: unknown,
        ): Promise<void>;
      }
    ).runDeferredRetries(NOW, 10, summary);
    return { upserts, summary };
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  }
}

describe('deferred candle revision provenance', () => {
  it('parks a reopened legacy entry as a legacy_orphan when its candle is gone', async () => {
    // The entry was reopened to re-verify WHICH revision it covered. With the
    // candle row removed that question is unanswerable, so it must not be
    // promoted back to a trusted `current` entry — the asset stays blocked
    // until an operator settles it.
    const { upserts, summary } = await retryWithMissingCandle(deferredRow());

    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({
      marketCandleId: 'candle-1',
      status: 'permanent',
      revisionState: 'legacy_orphan',
      errorCode: 'LIMIT_ORDER_CANDLE_ROW_MISSING',
    });
    // No revision is invented for it either, and the call carries NO
    // observation claim: the candle is gone, nothing was read.
    expect(upserts[0]?.candleIngestSeq).toBeNull();
    expect(upserts[0]?.revisionObserved).toBe(false);
    expect(summary.permanentCandles).toBe(1);
  });

  it('keeps an already-orphaned legacy entry orphaned', async () => {
    const { upserts } = await retryWithMissingCandle(
      deferredRow({ revisionState: 'legacy_orphan', candleIngestSeq: 9n }),
    );
    expect(upserts[0]).toMatchObject({
      revisionState: 'legacy_orphan',
      revisionObserved: false,
      // The forensic value rides along but is NOT an observation.
      candleIngestSeq: 9n,
    });
  });

  it('leaves a trusted entry provenance alone when its candle is gone', async () => {
    // A `current` entry knows exactly which revision it tracks; the row simply
    // disappeared. Nothing about its provenance changed, so the runtime must
    // not force a state and must not erase the known revision — but it must
    // also not CLAIM a fresh observation for a candle it could not read.
    const { upserts } = await retryWithMissingCandle(
      deferredRow({ revisionState: 'current', candleIngestSeq: 12n }),
    );

    expect(upserts[0]).toMatchObject({
      status: 'permanent',
      revisionState: undefined,
      revisionObserved: false,
      candleIngestSeq: 12n,
    });
  });
});

describe('upsertDeferred provenance guard rails', () => {
  const base = {
    marketCandleId: 'candle-1',
    assetId: 'asset-a',
    interval: '5m',
    openTime: new Date('2026-07-24T10:00:00.000Z'),
    closeTime: new Date('2026-07-24T10:05:00.000Z'),
    now: NOW,
    nextRetryAt: NOW,
    errorCode: null,
    errorMessage: null,
  };

  function repository() {
    const executions: unknown[] = [];
    const prisma = {
      $executeRaw: (...args: unknown[]) => {
        executions.push(args);
        return Promise.resolve(1);
      },
    };
    return {
      executions,
      repo: new LimitOrderReconciliationCheckpointRepository(prisma as never),
    };
  }

  // The compile-time union already rejects these shapes; the casts simulate a
  // caller that bypassed it (plain JS, a stale build), which must hit the
  // runtime wall BEFORE any SQL runs — the same combinations the DB CHECK
  // constraint would reject, but with an error that names the caller.
  it.each([
    [
      'an observed revision with a NULL sequence',
      { revisionObserved: true, candleIngestSeq: null },
    ],
    [
      'an observed revision forcing legacy_unknown',
      {
        revisionObserved: true,
        candleIngestSeq: 5n,
        revisionState: 'legacy_unknown',
      },
    ],
    [
      'an observed revision forcing legacy_orphan',
      {
        revisionObserved: true,
        candleIngestSeq: 5n,
        revisionState: 'legacy_orphan',
      },
    ],
    [
      'an unobserved call forcing current',
      {
        revisionObserved: false,
        candleIngestSeq: null,
        revisionState: 'current',
      },
    ],
    [
      'an unobserved legacy_unknown carrying a revision value',
      {
        revisionObserved: false,
        candleIngestSeq: 5n,
        revisionState: 'legacy_unknown',
      },
    ],
  ])('rejects %s before any SQL runs', async (_label, patch) => {
    const { repo, executions } = repository();
    await expect(
      repo.upsertDeferred({ ...base, ...patch } as UpsertDeferredInput),
    ).rejects.toThrow(/upsertDeferred/);
    expect(executions).toHaveLength(0);
  });

  it.each([
    [
      'an observed concrete revision',
      { revisionObserved: true, candleIngestSeq: 5n },
    ],
    [
      'an unobserved legacy_unknown with no revision',
      { revisionObserved: false, candleIngestSeq: null },
    ],
    [
      'an unobserved legacy_orphan preserving a forensic revision',
      {
        revisionObserved: false,
        candleIngestSeq: 5n,
        revisionState: 'legacy_orphan',
      },
    ],
    [
      'an unobserved legacy_orphan with no revision',
      {
        revisionObserved: false,
        candleIngestSeq: null,
        revisionState: 'legacy_orphan',
      },
    ],
  ])('accepts %s', async (_label, patch) => {
    const { repo, executions } = repository();
    await repo.upsertDeferred({ ...base, ...patch } as UpsertDeferredInput);
    expect(executions).toHaveLength(1);
  });
});
