// The service reaches the checkpoint repository, which imports PrismaService
// and therefore the generated client. Jest cannot load the generated ESM entry
// point, so the module is stubbed exactly as the other limit-matching unit
// specs do; nothing here touches a database.
jest.mock('../../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');
  // The enum module is plain TypeScript and loads fine; only the client entry
  // point is ESM that Jest cannot resolve. Re-exporting the REAL enums keeps
  // this stub from drifting as the schema grows.
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
import type { AssetRetentionGap } from './limit-order-reconciliation-checkpoint.repository';

/**
 * BLAST RADIUS of a retention finding.
 *
 * The detector used to write every finding to the single shared
 * reconciliation checkpoint, whose gap flag fails new limit quotes/creates for
 * EVERY asset. Two of its three signals name exactly one asset — a deferred
 * queue entry whose candle row disappeared, and an unscanned matchable candle
 * older than the retention horizon — so one asset's data loss stopped every
 * other asset's new orders. These specs pin the classification:
 *
 *   asset-scoped  -> that asset's completion checkpoint, that asset blocked
 *   global        -> only the shared scan watermark falling behind retention
 */

const NOW = new Date('2026-07-24T12:00:00.000Z');
const RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;
/** Comfortably inside the retained range. */
const RECENT = new Date(NOW.getTime() - 2 * DAY_MS);
/** Comfortably past the retention horizon. */
const ANCIENT = new Date(NOW.getTime() - 90 * DAY_MS);

type OrphanRow = {
  assetId: string;
  interval: string;
  marketCandleId: string;
  openTime: Date;
  candleIngestSeq: bigint | null;
  totalAssets: number;
};

type UnscannedRow = {
  id: string;
  assetId: string;
  interval: string;
  openTime: Date;
  ingestSeq: bigint;
};

function detect(input: {
  watermarkOpenTime: Date;
  orphans?: OrphanRow[];
  unscanned?: UnscannedRow[];
  assetGapBatchSize?: number;
  /**
   * Overrides the sticky-gap verdict recordAssetGap would return.
   * 'already_exists' simulates a CONCURRENT runner having recorded the asset
   * between the candidate query and the write — the asset becomes durably
   * gapped either way (later queries exclude it), it just is not THIS
   * sweep's new finding and must not consume budget.
   */
  recordOutcome?: (assetId: string) => 'inserted' | 'already_exists';
}) {
  const previous = { ...process.env };
  Object.assign(process.env, {
    LIMIT_ORDER_AUTO_EXECUTION_ENABLED: 'true',
    LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED: 'true',
    MARKET_CANDLE_5M_RETENTION_DAYS: String(RETENTION_DAYS),
    ...(input.assetGapBatchSize
      ? {
          LIMIT_ORDER_CANDLE_ASSET_GAP_BATCH_SIZE: String(
            input.assetGapBatchSize,
          ),
        }
      : {}),
  });

  const globalGaps: Array<{ reason: string }> = [];
  const assetGaps: AssetRetentionGap[] = [];
  /**
   * Durable sticky-gap state, exactly what the real queries' NOT EXISTS on
   * `gap_detected_at` sees: every asset recordAssetGap has touched (inserted
   * here, or raced by the simulated concurrent runner) is excluded from every
   * later candidate query — including the next sweep's, which is what makes
   * multi-sweep progression observable in a unit harness.
   */
  const gappedAssets = new Set<string>();

  try {
    const prisma = {
      // The detector issues exactly one raw query of its own (the orphan
      // probe); the unscanned probe goes through the private helper below and
      // is stubbed there, so this dispatcher stays a single honest branch.
      // The probe's parameters are honored the way the SQL would: the
      // excluded-asset array and the LIMIT (the only array / only number
      // among the bindings), plus the durable sticky-gap exclusion above.
      $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
        const sql = strings.join(' ');
        if (sql.includes('limit_order_deferred_candles')) {
          const exclude = (values.find(Array.isArray) as string[]) ?? [];
          const limit =
            (values.find((value) => typeof value === 'number') as number) ??
            Number.MAX_SAFE_INTEGER;
          const candidates = (input.orphans ?? []).filter(
            (row) =>
              !exclude.includes(row.assetId) && !gappedAssets.has(row.assetId),
          );
          return Promise.resolve(
            candidates
              .slice(0, limit)
              .map((row) => ({ ...row, totalAssets: candidates.length })),
          );
        }
        throw new Error(`unexpected query: ${sql}`);
      },
    };
    const checkpoints = {
      recordGap: (gap: { reason: string }) => {
        globalGaps.push(gap);
        return Promise.resolve();
      },
      recordAssetGap: (gap: AssetRetentionGap) => {
        assetGaps.push(gap);
        const outcome =
          input.recordOutcome?.(gap.assetId) ??
          (gappedAssets.has(gap.assetId)
            ? ('already_exists' as const)
            : ('inserted' as const));
        gappedAssets.add(gap.assetId);
        return Promise.resolve(outcome);
      },
    };
    // Only the datasource and the checkpoint repository participate in gap
    // detection; the candidate/execution/boundary collaborators belong to the
    // sweep stages this spec deliberately does not drive.
    const service = new LimitOrderCandleReconciliationService(
      prisma as never,
      undefined as never,
      undefined as never,
      undefined as never,
      checkpoints as never,
    );
    const internals = service as unknown as {
      detectRetentionGap(
        watermark: { openTime: Date; candleId: string | null } | null,
        ingestWatermark: bigint,
        now: Date,
      ): Promise<{
        global: { reason: string } | null;
        assetGaps: Array<{ assetId: string; reason: string }>;
      }>;
      findOldestUnscannedMatchableCandles(
        ingestWatermark: bigint,
        to: Date,
        retentionHorizon: Date,
        excludeAssetIds: string[],
        limit: number,
      ): Promise<UnscannedRow[]>;
    };
    const unscannedExclusions: string[][] = [];
    const unscannedLimits: number[] = [];
    internals.findOldestUnscannedMatchableCandles = (
      _watermark,
      _to,
      _horizon,
      excludeAssetIds,
      limit,
    ) => {
      unscannedExclusions.push([...excludeAssetIds]);
      unscannedLimits.push(limit);
      return Promise.resolve(
        (input.unscanned ?? [])
          .filter(
            (row) =>
              !excludeAssetIds.includes(row.assetId) &&
              !gappedAssets.has(row.assetId),
          )
          .slice(0, limit),
      );
    };

    return {
      globalGaps,
      assetGaps,
      gappedAssets,
      unscannedExclusions,
      unscannedLimits,
      run: () =>
        internals.detectRetentionGap(
          { openTime: input.watermarkOpenTime, candleId: 'w' },
          10n,
          NOW,
        ),
    };
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key];
    }
    Object.assign(process.env, previous);
  }
}

function orphan(overrides: Partial<OrphanRow> = {}): OrphanRow {
  return {
    assetId: 'asset-a',
    interval: '5m',
    marketCandleId: 'candle-a',
    openTime: RECENT,
    candleIngestSeq: 7n,
    totalAssets: 1,
    ...overrides,
  };
}

function unscanned(overrides: Partial<UnscannedRow> = {}): UnscannedRow {
  return {
    id: 'candle-u',
    assetId: 'asset-a',
    interval: '5m',
    openTime: ANCIENT,
    ingestSeq: 42n,
    ...overrides,
  };
}

describe('path-B retention gap classification', () => {
  it('records nothing when the sweep has no watermark yet', async () => {
    const harness = detect({ watermarkOpenTime: RECENT });
    harness.run();
    const verdict = await harness.run();
    expect(verdict.global).toBeNull();
    expect(verdict.assetGaps).toEqual([]);
    expect(harness.globalGaps).toEqual([]);
    expect(harness.assetGaps).toEqual([]);
  });

  it('keeps the shared watermark falling behind retention GLOBAL', async () => {
    // The market-time watermark is one position shared by every asset. When
    // retention has passed it, the removed rows cannot be attributed to any
    // single asset, so this stays a system-wide alarm.
    const harness = detect({ watermarkOpenTime: ANCIENT });
    const verdict = await harness.run();

    expect(verdict.global).toEqual({
      reason: 'candle_retention_passed_watermark',
    });
    expect(harness.globalGaps).toHaveLength(1);
    expect(harness.assetGaps).toEqual([]);
  });

  it('does not spend per-asset probes once the shared position is gapped', async () => {
    // A global gap already blocks every asset; enumerating per-asset findings
    // underneath it would only add write load an operator cannot act on.
    const harness = detect({
      watermarkOpenTime: ANCIENT,
      orphans: [orphan()],
      unscanned: [unscanned()],
    });
    await harness.run();
    expect(harness.assetGaps).toEqual([]);
  });

  it('records a deferred entry whose candle row vanished against ITS asset', async () => {
    const harness = detect({
      watermarkOpenTime: RECENT,
      orphans: [orphan()],
    });
    const verdict = await harness.run();

    expect(verdict.global).toBeNull();
    expect(harness.globalGaps).toEqual([]);
    expect(harness.assetGaps).toEqual([
      {
        assetId: 'asset-a',
        interval: '5m',
        detectedAt: NOW,
        fromOpenTime: RECENT,
        toOpenTime: RECENT,
        reason: 'deferred_candle_retention_removed',
        marketCandleId: 'candle-a',
        candleIngestSeq: 7n,
      },
    ]);
    expect(verdict.assetGaps).toEqual([
      { assetId: 'asset-a', reason: 'deferred_candle_retention_removed' },
    ]);
  });

  it('records an unscanned matchable candle past the horizon against ITS asset', async () => {
    const harness = detect({
      watermarkOpenTime: RECENT,
      unscanned: [unscanned()],
    });
    const verdict = await harness.run();

    expect(verdict.global).toBeNull();
    expect(harness.globalGaps).toEqual([]);
    expect(harness.assetGaps).toEqual([
      {
        assetId: 'asset-a',
        interval: '5m',
        detectedAt: NOW,
        fromOpenTime: ANCIENT,
        toOpenTime: new Date(NOW.getTime() - RETENTION_DAYS * DAY_MS),
        reason: 'candle_retention_passed_unscanned_candle',
        marketCandleId: 'candle-u',
        candleIngestSeq: 42n,
      },
    ]);
  });

  it('reports EVERY affected asset, not just the oldest one', async () => {
    // The old detector returned a single global LIMIT 1 row, so asset B's loss
    // was invisible while asset A's was outstanding — and asset B kept
    // accepting orders whose safety net was already blind.
    const harness = detect({
      watermarkOpenTime: RECENT,
      orphans: [
        orphan({
          assetId: 'asset-a',
          marketCandleId: 'candle-a',
          totalAssets: 2,
        }),
        orphan({
          assetId: 'asset-b',
          marketCandleId: 'candle-b',
          totalAssets: 2,
        }),
      ],
      unscanned: [
        unscanned({ assetId: 'asset-c', id: 'candle-c' }),
        unscanned({ assetId: 'asset-d', id: 'candle-d' }),
      ],
    });
    await harness.run();

    expect(harness.assetGaps.map((gap) => gap.assetId)).toEqual([
      'asset-a',
      'asset-b',
      'asset-c',
      'asset-d',
    ]);
    expect(harness.globalGaps).toEqual([]);
  });

  it('carries a NULL tracked revision through to the gap record', async () => {
    // An entry the provenance migration reset has no revision to report; the
    // gap must still be recorded rather than skipped.
    const harness = detect({
      watermarkOpenTime: RECENT,
      orphans: [orphan({ candleIngestSeq: null })],
    });
    await harness.run();
    expect(harness.assetGaps[0]?.candleIngestSeq).toBeNull();
  });

  it('never turns a per-asset finding into a global one', async () => {
    const harness = detect({
      watermarkOpenTime: RECENT,
      orphans: [orphan({ assetId: 'asset-a' })],
      unscanned: [unscanned({ assetId: 'asset-b', id: 'candle-b' })],
    });
    const verdict = await harness.run();
    expect(verdict.global).toBeNull();
    expect(harness.globalGaps).toHaveLength(0);
    expect(harness.assetGaps).toHaveLength(2);
  });

  it('counts only gaps THIS sweep actually recorded, not raced re-sightings', async () => {
    // recordAssetGap is sticky and first-detection-wins; when a concurrent
    // runner recorded the same asset between the probe and the write, this
    // sweep's call is a no-op and must not inflate assetGapsDetected — the
    // summary means "new findings", and batch-progression accounting depends
    // on it being exact.
    const harness = detect({
      watermarkOpenTime: RECENT,
      orphans: [
        orphan({ assetId: 'asset-a', totalAssets: 2 }),
        orphan({
          assetId: 'asset-b',
          marketCandleId: 'candle-b',
          totalAssets: 2,
        }),
      ],
      recordOutcome: (assetId) =>
        assetId === 'asset-b' ? 'already_exists' : 'inserted',
    });
    const verdict = await harness.run();

    expect(verdict.assetGaps).toEqual([
      { assetId: 'asset-a', reason: 'deferred_candle_retention_removed' },
    ]);
    // The write was still ATTEMPTED for both (sticky no-op is harmless); only
    // the verdict — and through it the summary count — is filtered.
    expect(harness.assetGaps.map((gap) => gap.assetId)).toEqual([
      'asset-a',
      'asset-b',
    ]);
  });

  it('excludes assets the orphan pass just gapped from the unscanned probe', async () => {
    // Both probes can name the same asset in one sweep (its deferred entry
    // lost its candle AND it has another unscanned old window). The sticky
    // gap the orphan pass just wrote is invisible to the unscanned query's
    // own already-gapped exclusion (same-sweep write), so the service passes
    // the set explicitly — one asset must not consume two batch slots, and
    // the first gap evidence must not be raced by a second finding.
    const harness = detect({
      watermarkOpenTime: RECENT,
      orphans: [orphan({ assetId: 'asset-a' })],
      unscanned: [
        unscanned({ assetId: 'asset-a', id: 'candle-a2' }),
        unscanned({ assetId: 'asset-b', id: 'candle-b' }),
      ],
    });
    const verdict = await harness.run();

    expect(harness.unscannedExclusions[0]).toEqual(['asset-a']);
    expect(verdict.assetGaps).toEqual([
      { assetId: 'asset-a', reason: 'deferred_candle_retention_removed' },
      {
        assetId: 'asset-b',
        reason: 'candle_retention_passed_unscanned_candle',
      },
    ]);
  });

  // -------------------------------------------------------------------------
  // SWEEP-WIDE write budget: `assetGapBatchSize` bounds the NEW gaps one
  // sweep records IN TOTAL across both probes, not per probe.
  // -------------------------------------------------------------------------

  it('bounds the new gaps of one sweep by the budget across BOTH probes', async () => {
    // 2 orphans + 3 unscanned with a budget of 2: per-probe limits would
    // record 4 in the first sweep (2 + 2). The shared budget records exactly
    // 2 per sweep and still reaches every asset in finite sweeps.
    const harness = detect({
      watermarkOpenTime: RECENT,
      assetGapBatchSize: 2,
      orphans: [
        orphan({ assetId: 'asset-a', marketCandleId: 'candle-a' }),
        orphan({ assetId: 'asset-b', marketCandleId: 'candle-b' }),
      ],
      unscanned: [
        unscanned({ assetId: 'asset-c', id: 'candle-c' }),
        unscanned({ assetId: 'asset-d', id: 'candle-d' }),
        unscanned({ assetId: 'asset-e', id: 'candle-e' }),
      ],
    });

    const sweeps: string[][] = [];
    for (let index = 0; index < 4; index += 1) {
      const verdict = await harness.run();
      expect(verdict.assetGaps.length).toBeLessThanOrEqual(2);
      sweeps.push(verdict.assetGaps.map((gap) => gap.assetId));
    }
    expect(sweeps).toEqual([
      ['asset-a', 'asset-b'], // orphans exhaust the budget...
      ['asset-c', 'asset-d'], // ...so unscanned waits for the next sweep
      ['asset-e'],
      [],
    ]);
    // Sweep 1 exhausted the budget on orphans, so the unscanned probe was not
    // even queried that sweep.
    expect(harness.unscannedLimits.length).toBeGreaterThan(0);
    expect(Math.min(...harness.unscannedLimits)).toBeGreaterThan(0);
  });

  it('does not query the unscanned probe once orphans exhausted the budget', async () => {
    const harness = detect({
      watermarkOpenTime: RECENT,
      assetGapBatchSize: 2,
      orphans: [
        orphan({ assetId: 'asset-a', marketCandleId: 'candle-a' }),
        orphan({ assetId: 'asset-b', marketCandleId: 'candle-b' }),
      ],
      unscanned: [unscanned({ assetId: 'asset-c', id: 'candle-c' })],
    });
    const verdict = await harness.run();
    expect(verdict.assetGaps.map((gap) => gap.assetId)).toEqual([
      'asset-a',
      'asset-b',
    ]);
    expect(harness.unscannedExclusions).toEqual([]);
  });

  it('hands the full budget to the unscanned probe when no orphan exists', async () => {
    const harness = detect({
      watermarkOpenTime: RECENT,
      assetGapBatchSize: 2,
      unscanned: [
        unscanned({ assetId: 'asset-c', id: 'candle-c' }),
        unscanned({ assetId: 'asset-d', id: 'candle-d' }),
        unscanned({ assetId: 'asset-e', id: 'candle-e' }),
      ],
    });
    const verdict = await harness.run();
    expect(verdict.assetGaps.map((gap) => gap.assetId)).toEqual([
      'asset-c',
      'asset-d',
    ]);
    expect(harness.unscannedLimits[0]).toBe(2);
  });

  it('does not let a raced already_exists consume budget', async () => {
    // Concurrent runner recorded asset-a between the query and the write: the
    // no-op frees its slot, the orphan probe re-queries, and the remaining
    // budget still funds the unscanned probe. Total NEW gaps stay within the
    // budget and the race costs nothing.
    const harness = detect({
      watermarkOpenTime: RECENT,
      assetGapBatchSize: 2,
      orphans: [
        orphan({ assetId: 'asset-a', marketCandleId: 'candle-a' }),
        orphan({ assetId: 'asset-b', marketCandleId: 'candle-b' }),
      ],
      unscanned: [unscanned({ assetId: 'asset-c', id: 'candle-c' })],
      recordOutcome: (assetId) =>
        assetId === 'asset-a' ? 'already_exists' : 'inserted',
    });
    const verdict = await harness.run();
    expect(verdict.assetGaps).toEqual([
      { assetId: 'asset-b', reason: 'deferred_candle_retention_removed' },
      {
        assetId: 'asset-c',
        reason: 'candle_retention_passed_unscanned_candle',
      },
    ]);
    // Both orphan attempts happened; only the inserted one counted.
    expect(
      harness.assetGaps.filter(
        (gap) => gap.reason === 'deferred_candle_retention_removed',
      ),
    ).toHaveLength(2);
  });

  it('spends one budget slot for an asset both probes expose', async () => {
    const harness = detect({
      watermarkOpenTime: RECENT,
      assetGapBatchSize: 2,
      orphans: [orphan({ assetId: 'asset-a', marketCandleId: 'candle-a' })],
      unscanned: [unscanned({ assetId: 'asset-a', id: 'candle-a2' })],
    });
    const verdict = await harness.run();
    // One sticky gap, one slot, the orphan evidence wins (it ran first).
    expect(verdict.assetGaps).toEqual([
      { assetId: 'asset-a', reason: 'deferred_candle_retention_removed' },
    ]);
    expect(
      harness.assetGaps.filter((gap) => gap.assetId === 'asset-a'),
    ).toHaveLength(1);
  });
});
