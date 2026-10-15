/**
 * Checkpoint compaction planner (design v2.1 §4.4), pure.
 *
 * Allowed operations never change either reader result for any window whose
 * union fits the 2,000-row read bound: the coverage union of
 * `findCandleCoverage` and the status of the newest overlapping row read by
 * `findLatestOverlapping` (the blocking check).
 *
 *  ① delete a failed/canceled row R when a LATER completed row covers R's
 *    target range (R can never be the newest overlapping row again);
 *  ② if any non-completed row created before the cutoff is left, stop here
 *    for this asset/feed (a resumable old run could be revived) and alert;
 *  ③ delete completed rows that prove nothing (coverageComplete=false),
 *    except audited misses: they are the DB evidence of a hold (G4-I
 *    counts an unproven slot without it as concealed), prove nothing and
 *    never block, so they stay until the retention baseline (⑤);
 *  ④ merge overlapping/adjacent proving rows created before the cutoff into
 *    one row: covered = target = the group union, createdAt/completedAt = the
 *    group maxima. Rows on either side of the obligation start A are never
 *    merged together (the reader filters evidence by createdAt ≥ A);
 *  ⑤ delete rows wholly at/before the 5m retention baseline (the data they
 *    describe is gone), regardless of ②.
 */
export type CompactionRow = {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'canceled';
  coverageComplete: boolean;
  targetFrom: number;
  targetTo: number;
  coveredFrom: number | null;
  coveredTo: number | null;
  createdAt: number;
  completedAt: number | null;
  /** A completed audited run that recorded a missing required slot. */
  auditMiss?: boolean;
  /** For an already merged row: its group's earliest createdAt. */
  firstCreatedAt?: number;
};

export type CompactionMerge = {
  memberIds: string[];
  from: number;
  to: number;
  createdAt: number;
  completedAt: number;
  firstCreatedAt: number;
};

export type CompactionPlan = {
  deleteIds: string[];
  merges: CompactionMerge[];
  /** Set when ③/④ were skipped (②): the old unresolved run ids. */
  unresolvedIds: string[];
};

export function planCheckpointCompaction(
  rows: readonly CompactionRow[],
  options: {
    /** Only rows created strictly before this instant are compacted. */
    cutoffMs: number;
    /** Obligation start A; null when none applies (e.g. the 1d feed). */
    obligationStartMs: number | null;
    /** 5m retention baseline; null for feeds without retention. */
    retentionBaselineMs: number | null;
  },
): CompactionPlan {
  const deleted = new Set<string>();
  const old = (row: CompactionRow) => row.createdAt < options.cutoffMs;

  // ⑤ outside the retention window (independent of ②).
  if (options.retentionBaselineMs !== null) {
    const baseline = options.retentionBaselineMs;
    for (const row of rows)
      if (
        row.status !== 'pending' &&
        row.status !== 'running' &&
        row.targetTo <= baseline &&
        (row.coveredTo === null || row.coveredTo <= baseline)
      )
        deleted.add(row.id);
  }
  const live = () => rows.filter((row) => !deleted.has(row.id));

  // ① superseded failures.
  for (const row of live()) {
    if (!old(row) || (row.status !== 'failed' && row.status !== 'canceled'))
      continue;
    const covered = live().some(
      (other) =>
        other.status === 'completed' &&
        other.createdAt > row.createdAt &&
        other.targetFrom <= row.targetFrom &&
        other.targetTo >= row.targetTo,
    );
    if (covered) deleted.add(row.id);
  }

  // ② unresolved old runs block the rest.
  const unresolved = live().filter(
    (row) => old(row) && row.status !== 'completed',
  );
  if (unresolved.length > 0)
    return {
      deleteIds: [...deleted],
      merges: [],
      unresolvedIds: unresolved.map((row) => row.id),
    };

  // ③ completed rows that prove nothing (audited misses are hold evidence).
  for (const row of live())
    if (
      old(row) &&
      row.status === 'completed' &&
      !row.coverageComplete &&
      !row.auditMiss
    )
      deleted.add(row.id);

  // ④ merge proving rows, never across the obligation start.
  const merges: CompactionMerge[] = [];
  const proving = live()
    .filter(
      (row) =>
        old(row) &&
        row.status === 'completed' &&
        row.coverageComplete &&
        row.coveredFrom !== null &&
        row.coveredTo !== null &&
        row.completedAt !== null,
    )
    .sort((a, b) => a.coveredFrom! - b.coveredFrom!);
  const side = (row: CompactionRow) =>
    options.obligationStartMs === null ||
    row.createdAt >= options.obligationStartMs
      ? 'after'
      : 'before';
  for (const group of ['before', 'after'] as const) {
    let current: CompactionRow[] = [];
    let currentTo = -Infinity;
    const flush = () => {
      if (current.length > 1)
        merges.push({
          memberIds: current.map((row) => row.id),
          from: Math.min(...current.map((row) => row.coveredFrom!)),
          to: Math.max(...current.map((row) => row.coveredTo!)),
          createdAt: Math.max(...current.map((row) => row.createdAt)),
          completedAt: Math.max(...current.map((row) => row.completedAt!)),
          // When collection started stays provable after merging (G4-I).
          firstCreatedAt: Math.min(
            ...current.map((row) => row.firstCreatedAt ?? row.createdAt),
          ),
        });
      current = [];
      currentTo = -Infinity;
    };
    for (const row of proving.filter((entry) => side(entry) === group)) {
      if (current.length > 0 && row.coveredFrom! > currentTo) flush();
      current.push(row);
      currentTo = Math.max(currentTo, row.coveredTo!);
    }
    flush();
  }
  for (const merge of merges) for (const id of merge.memberIds) deleted.add(id);
  return { deleteIds: [...deleted], merges, unresolvedIds: [] };
}
