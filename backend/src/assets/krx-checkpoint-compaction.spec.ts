jest.mock('../generated/prisma/client', () => ({
  PrismaClient: class PrismaClient {},
  Prisma: { DbNull: Symbol('Prisma.DbNull') },
  MarketCandleSyncMode: { repair: 'repair' },
  MarketCandleSyncStatus: {
    pending: 'pending',
    running: 'running',
    completed: 'completed',
    failed: 'failed',
    canceled: 'canceled',
  },
}));

import { krxFiveMinuteBridge } from './krx-candle-collection.policy';
import {
  planCheckpointCompaction,
  type CompactionRow,
} from './krx-checkpoint-compaction';
import { MarketCandleSyncStateRepository } from './market-candle-sync-state.repository';

/**
 * Design v2.1 §4.4 verification: on random checkpoint sets (old running and
 * failed rows, rows on both sides of the obligation start A), compaction
 * leaves the REAL reader results unchanged — the coverage union
 * (`findCandleCoverage`, with the KRX bridge and the A filter) and the
 * blocking status of the newest overlapping row (`findLatestOverlapping`).
 * Only `newestCompletedAt` may move, which KRX freshness does not read.
 */
const MIN = 60_000;
const kst = (local: string) => Date.parse(`${local}+09:00`);
const SPAN_FROM = kst('2026-10-14T09:00:00');
const SPAN_TO = kst('2026-10-16T15:40:00');
const NOW = SPAN_TO;
const CUTOFF = kst('2026-10-16T00:00:00');
const A = kst('2026-10-15T00:00:00');

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type StoredRow = CompactionRow;

/** Prisma delegate subset over in-memory rows (the reader's two queries). */
function delegateOver(rows: () => StoredRow[]) {
  const asDb = (row: StoredRow) => ({
    status: row.status,
    coveredFrom: row.coveredFrom === null ? null : new Date(row.coveredFrom),
    coveredTo: row.coveredTo === null ? null : new Date(row.coveredTo),
    completedAt: row.completedAt === null ? null : new Date(row.completedAt),
    createdAt: new Date(row.createdAt),
  });
  return {
    findMany: jest.fn(
      ({
        where,
        take,
      }: {
        where: {
          coveredFrom: { lt: Date };
          coveredTo: { gt: Date };
          createdAt?: { gte: Date };
        };
        take: number;
      }) =>
        Promise.resolve(
          rows()
            .filter(
              (row) =>
                row.status === 'completed' &&
                row.coverageComplete &&
                row.coveredFrom !== null &&
                row.coveredTo !== null &&
                row.completedAt !== null &&
                row.coveredFrom < where.coveredFrom.lt.getTime() &&
                row.coveredTo > where.coveredTo.gt.getTime() &&
                (!where.createdAt ||
                  row.createdAt >= where.createdAt.gte.getTime()),
            )
            .sort(
              (a, b) =>
                a.coveredFrom! - b.coveredFrom! || b.coveredTo! - a.coveredTo!,
            )
            .slice(0, take)
            .map(asDb),
        ),
    ),
    findFirst: jest.fn(
      ({
        where,
      }: {
        where: { targetFrom: { lt: Date }; targetTo: { gt: Date } };
      }) =>
        Promise.resolve(
          rows()
            .filter(
              (row) =>
                row.targetFrom < where.targetFrom.lt.getTime() &&
                row.targetTo > where.targetTo.gt.getTime(),
            )
            .sort((a, b) => b.createdAt - a.createdAt)
            .map(asDb)[0] ?? null,
        ),
    ),
  };
}

function randomRows(random: () => number, cleanHistory: boolean): StoredRow[] {
  const rows: StoredRow[] = [];
  const count = 5 + Math.floor(random() * 40);
  for (let i = 0; i < count; i++) {
    const from =
      SPAN_FROM +
      Math.floor(random() * ((SPAN_TO - SPAN_FROM) / (5 * MIN))) * 5 * MIN;
    const to = Math.min(SPAN_TO, from + (5 + Math.floor(random() * 120)) * MIN);
    const createdAt = Math.min(NOW, to + Math.floor(random() * 30) * MIN);
    const roll = random();
    // Clean scenarios keep every pre-cutoff run resolved (② lets ③④ run);
    // the others include old failed, canceled and crashed running rows.
    const oldRow = createdAt < CUTOFF;
    const status: StoredRow['status'] =
      roll < 0.6 || (cleanHistory && oldRow)
        ? 'completed'
        : roll < 0.75
          ? 'failed'
          : roll < 0.85
            ? 'canceled'
            : roll < 0.95
              ? 'running'
              : 'completed';
    const complete = status === 'completed' && random() < 0.8;
    rows.push({
      id: `r${i}`,
      status,
      // Audited misses are kept by ③; the readers must not notice either way.
      auditMiss: status === 'completed' && !complete && random() < 0.5,
      coverageComplete: complete,
      targetFrom: from,
      targetTo: to,
      coveredFrom: complete ? from : null,
      coveredTo: complete ? to : null,
      createdAt,
      completedAt: status === 'completed' ? createdAt : null,
    });
  }
  return rows;
}

function applyPlan(
  rows: StoredRow[],
  plan: ReturnType<typeof planCheckpointCompaction>,
) {
  const deleted = new Set(plan.deleteIds);
  return [
    ...rows.filter((row) => !deleted.has(row.id)),
    ...plan.merges.map((merge, i) => ({
      id: `m${i}`,
      firstCreatedAt: merge.firstCreatedAt,
      status: 'completed' as const,
      coverageComplete: true,
      targetFrom: merge.from,
      targetTo: merge.to,
      coveredFrom: merge.from,
      coveredTo: merge.to,
      createdAt: merge.createdAt,
      completedAt: merge.completedAt,
    })),
  ];
}

async function readerResults(rows: StoredRow[], windows: [number, number][]) {
  let current = rows;
  const delegate = delegateOver(() => current);
  const repository = new MarketCandleSyncStateRepository({
    marketCandleSyncState: delegate,
  } as never);
  const bridge = krxFiveMinuteBridge(NOW);
  const out: string[] = [];
  for (const [from, to] of windows) {
    for (const createdAtOrAfter of [new Date(A), undefined]) {
      const coverage = await repository.findCandleCoverage(
        'asset',
        '5m',
        new Date(from),
        new Date(to),
        { bridge, createdAtOrAfter },
      );
      const latest = await repository.findLatestOverlapping(
        'asset',
        '5m',
        new Date(from),
        new Date(to),
      );
      out.push(
        JSON.stringify([
          coverage.startsAtRequestedFrom,
          coverage.contiguousCoveredTo?.getTime() ?? null,
          coverage.hasInteriorGap,
          latest !== null && latest.status !== 'completed',
        ]),
      );
    }
  }
  current = [];
  return out;
}

describe('KRX checkpoint compaction (property)', () => {
  it('keeps every reader result on 300 random checkpoint sets', async () => {
    const random = prng(20261015);
    let merged = 0;
    let skipped = 0;
    for (let scenario = 0; scenario < 300; scenario++) {
      const rows = randomRows(random, scenario % 2 === 0);
      const windows: [number, number][] = Array.from({ length: 12 }, () => {
        const from = SPAN_FROM + Math.floor(random() * (SPAN_TO - SPAN_FROM));
        const to = Math.min(
          NOW,
          from + Math.floor(random() * (SPAN_TO - from)) + MIN,
        );
        return [from, Math.max(to, from + MIN)];
      });
      const plan = planCheckpointCompaction(rows, {
        cutoffMs: CUTOFF,
        obligationStartMs: A,
        retentionBaselineMs: null,
      });
      merged += plan.merges.length;
      if (plan.unresolvedIds.length > 0) skipped += 1;
      const before = await readerResults(rows, windows);
      const after = await readerResults(applyPlan(rows, plan), windows);
      expect(after.join('\n') === before.join('\n')).toBe(true);
    }
    // The generator really exercises both branches.
    expect(merged > 50).toBe(true);
    expect(skipped > 10).toBe(true);
  });

  it('skips merging while an old unresolved run exists, but still drops superseded failures', () => {
    const rows: StoredRow[] = [
      {
        id: 'old-running',
        status: 'running',
        coverageComplete: false,
        targetFrom: kst('2026-10-15T09:00:00'),
        targetTo: kst('2026-10-15T10:00:00'),
        coveredFrom: null,
        coveredTo: null,
        createdAt: kst('2026-10-15T10:00:00'),
        completedAt: null,
      },
      {
        id: 'failed',
        status: 'failed',
        coverageComplete: false,
        targetFrom: kst('2026-10-15T11:00:00'),
        targetTo: kst('2026-10-15T11:30:00'),
        coveredFrom: null,
        coveredTo: null,
        createdAt: kst('2026-10-15T11:30:00'),
        completedAt: null,
      },
      {
        id: 'cover',
        status: 'completed',
        coverageComplete: true,
        targetFrom: kst('2026-10-15T11:00:00'),
        targetTo: kst('2026-10-15T12:00:00'),
        coveredFrom: kst('2026-10-15T11:00:00'),
        coveredTo: kst('2026-10-15T12:00:00'),
        createdAt: kst('2026-10-15T12:00:00'),
        completedAt: kst('2026-10-15T12:00:00'),
      },
      {
        id: 'next',
        status: 'completed',
        coverageComplete: true,
        targetFrom: kst('2026-10-15T12:00:00'),
        targetTo: kst('2026-10-15T13:00:00'),
        coveredFrom: kst('2026-10-15T12:00:00'),
        coveredTo: kst('2026-10-15T13:00:00'),
        createdAt: kst('2026-10-15T13:00:00'),
        completedAt: kst('2026-10-15T13:00:00'),
      },
    ];
    const plan = planCheckpointCompaction(rows, {
      cutoffMs: CUTOFF,
      obligationStartMs: A,
      retentionBaselineMs: null,
    });
    expect(plan.unresolvedIds).toEqual(['old-running']);
    expect(plan.deleteIds).toEqual(['failed']);
    expect(plan.merges.length).toBe(0);
  });

  it('keeps audited misses (hold evidence) until the retention baseline, unlike other non-proving rows', () => {
    const row = (id: string, auditMiss: boolean): StoredRow => ({
      id,
      status: 'completed',
      coverageComplete: false,
      targetFrom: kst('2026-10-15T10:00:00'),
      targetTo: kst('2026-10-15T10:30:00'),
      coveredFrom: null,
      coveredTo: null,
      createdAt: kst('2026-10-15T10:31:10'),
      completedAt: kst('2026-10-15T10:31:10'),
      auditMiss,
    });
    const rows = [row('audit-miss', true), row('legacy', false)];
    const plan = planCheckpointCompaction(rows, {
      cutoffMs: CUTOFF,
      obligationStartMs: A,
      retentionBaselineMs: null,
    });
    expect(plan.deleteIds).toEqual(['legacy']);
    const expired = planCheckpointCompaction(rows, {
      cutoffMs: CUTOFF,
      obligationStartMs: A,
      retentionBaselineMs: kst('2026-10-15T11:00:00'),
    });
    expect([...expired.deleteIds].sort()).toEqual(['audit-miss', 'legacy']);
  });

  it('never merges across the obligation start A and drops only rows wholly before the retention baseline', () => {
    const proving = (
      id: string,
      from: string,
      to: string,
      created: string,
    ): StoredRow => ({
      id,
      status: 'completed',
      coverageComplete: true,
      targetFrom: kst(from),
      targetTo: kst(to),
      coveredFrom: kst(from),
      coveredTo: kst(to),
      createdAt: kst(created),
      completedAt: kst(created),
    });
    const rows = [
      proving(
        'pre-a',
        '2026-10-14T09:00:00',
        '2026-10-14T12:00:00',
        '2026-10-14T12:00:00',
      ),
      proving(
        'pre-b',
        '2026-10-14T12:00:00',
        '2026-10-14T15:31:00',
        '2026-10-14T15:31:00',
      ),
      proving(
        'post-a',
        '2026-10-15T09:00:00',
        '2026-10-15T12:00:00',
        '2026-10-15T12:00:00',
      ),
      proving(
        'post-b',
        '2026-10-15T12:00:00',
        '2026-10-15T15:31:00',
        '2026-10-15T15:31:00',
      ),
      proving(
        'straddle',
        '2026-10-14T15:00:00',
        '2026-10-15T09:30:00',
        '2026-10-15T09:30:00',
      ),
    ];
    const plan = planCheckpointCompaction(rows, {
      cutoffMs: CUTOFF,
      obligationStartMs: A,
      retentionBaselineMs: null,
    });
    const groups = plan.merges
      .map((merge) => merge.memberIds.sort().join('+'))
      .sort();
    expect(groups).toEqual(['post-a+post-b+straddle', 'pre-a+pre-b']);
    const retained = planCheckpointCompaction(rows, {
      cutoffMs: CUTOFF,
      obligationStartMs: A,
      retentionBaselineMs: kst('2026-10-14T15:31:00'),
    });
    expect(retained.deleteIds.includes('pre-b')).toBe(true);
    expect(retained.deleteIds.includes('pre-a')).toBe(true);
    expect(
      retained.merges.some((merge) => merge.memberIds.includes('pre-b')),
    ).toBe(false);
  });
});
