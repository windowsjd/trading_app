import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Every RESTRICT foreign key that points at asset_price_snapshots (design
 * v2.1 §8.3: 9 constraints, 7 tables). The integration test compares this
 * list with the live catalog, so a new reference cannot be missed silently.
 */
export const ASSET_PRICE_SNAPSHOT_REFERENCES = [
  ['orders', 'asset_price_snapshot_id'],
  ['quotes', 'asset_price_snapshot_id'],
  ['futures_executions', 'asset_price_snapshot_id'],
  ['protection_children', 'asset_price_snapshot_id'],
  ['futures_season_prices', 'asset_price_snapshot_id'],
  ['conditional_buy_orders', 'registration_snapshot_id'],
  ['conditional_buy_orders', 'trigger_snapshot_id'],
  ['conditional_sell_orders', 'registration_snapshot_id'],
  ['conditional_sell_orders', 'trigger_snapshot_id'],
] as const;

/** ④ Settlement reads, at or before a Season's end, the newest positive
 * provider rows of an asset across its eligible sources together, 10 per
 * source (20 for KRX and crypto). A row inside that combined window is inside
 * the newest window-size rows of its own source, so keeping that many per
 * source keeps every row the reader can see. A spec ties this to the policy. */
export const SEASON_EVIDENCE_ROWS = 20;
/** ④ reads at most this many of the asset's next rows (all sources) looking
 * for same-source successors. A row with fewer than SEASON_EVIDENCE_ROWS among
 * them is kept, so the rule never keeps fewer rows than the unbounded one; it
 * bounds the probe for a source that stopped writing while another continues
 * (legacy KIS rows of a KRX stock now fed by KOSCOM), whose successors never come. */
export const SEASON_EVIDENCE_SCAN_ROWS = 10_000;
/** ⑦ quotes/orders pin ids within seconds; never race them. */
export const MIN_SNAPSHOT_AGE_DAYS = 2;
const DAY_MS = 24 * 60 * 60_000;

/** Keyset position of a per-asset sweep: the last row a batch examined. */
export type PriceSnapshotRetentionCursor = { effectiveAt: Date; id: string };

export type PriceSnapshotRetentionBatch = {
  deleted: number;
  /** Rows examined, deleted or kept; fewer than the limit = swept to cutoff. */
  scanned: number;
  next: PriceSnapshotRetentionCursor | null;
};

export type PriceSnapshotRetentionScope = {
  /** Audit retention (product decision P6): no default on purpose. */
  retentionDays: number;
  assetId?: string;
  sourceName?: string;
  now?: Date;
};

export type PriceSnapshotRetentionDryRun = {
  cutoff: string;
  youngest: string;
  /** Rows older than the retention cutoff (⑥), before any protection. */
  older: number;
  protectedReferenced: number;
  protectedAdminManual: number;
  protectedTooYoung: number;
  protectedLatest: number;
  protectedSessionLast: number;
  protectedSeasonEvidence: number;
  candidates: number;
  candidatesBySource: { sourceName: string | null; rows: number }[];
};

export class PriceSnapshotRetentionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PriceSnapshotRetentionInputError';
  }
}

/**
 * Reference-aware asset price snapshot retention (design v2.1 §8.5; the
 * 14-day policy of 2026-10-16). A row is a deletion candidate only when ALL
 * hold: ① no FK references it; ② it is not its (asset, source)'s newest
 * row; ③ not the last row of its (asset, source, exchange-local session
 * date) — close evidence and holiday carry-over; ④ not among the
 * SEASON_EVIDENCE_ROWS newest positive rows of its (asset, source) before any
 * Season's end — settlement evidence, kept after settlement too; ⑤ not
 * admin_manual; ⑥ older than the retention; ⑦ created at least 2 days ago.
 * RESTRICT FKs stay the final fence: a reference that appears mid-batch
 * fails the batch, never orphans.
 *
 * ③ and ④ probe the (asset_id, effective_at) index inside bounded ranges (the
 * row's local session date; up to the next season end, at most
 * SEASON_EVIDENCE_SCAN_ROWS rows), so a row costs a bounded number of index
 * reads whatever the table size.
 *
 * `dryRun` is read-only. `deleteBatch` sweeps one asset in effective_at order
 * from a cursor; AssetPriceSnapshotRetentionWorker schedules it (opt-in).
 */
export class AssetPriceSnapshotRetentionService {
  constructor(private readonly prisma: PrismaService) {}

  async dryRun(
    scope: PriceSnapshotRetentionScope & { statementTimeoutMs?: number },
  ): Promise<PriceSnapshotRetentionDryRun> {
    const timeoutMs = scope.statementTimeoutMs ?? 60_000;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1_000 ||
      timeoutMs > 600_000
    )
      // @diagnosticSurface internal: Operator dry-run guard; the message names only the option.
      throw new PriceSnapshotRetentionInputError(
        'statementTimeoutMs must be an integer between 1000 and 600000.',
      );
    const now = scope.now ?? (await this.databaseNow());
    const { cutoff, youngest } = bounds(scope.retentionDays, now);
    const f = fragments(cutoff, youngest, scope);
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$queryRaw`SELECT set_config('statement_timeout', ${`${timeoutMs}ms`}, true)`;
      const [row] = await tx.$queryRaw<Array<Record<string, number>>>`SELECT
          count(*)::int AS older,
          count(*) FILTER (WHERE referenced)::int AS referenced,
          count(*) FILTER (WHERE admin_manual)::int AS admin_manual,
          count(*) FILTER (WHERE too_young)::int AS too_young,
          count(*) FILTER (WHERE latest)::int AS latest,
          count(*) FILTER (WHERE session_last)::int AS session_last,
          count(*) FILTER (WHERE season_evidence)::int AS season_evidence,
          count(*) FILTER (
            WHERE NOT (referenced OR admin_manual OR too_young OR session_last OR season_evidence)
          )::int AS candidates
        FROM (
          SELECT
            (${f.referenced}) AS referenced,
            (${f.adminManual}) AS admin_manual,
            (${f.tooYoung}) AS too_young,
            (${f.latest}) AS latest,
            (${f.sessionLast}) AS session_last,
            (${f.seasonEvidence}) AS season_evidence
          FROM ${f.from}
          WHERE ${f.older} ${f.scope}
        ) flags`;
      const bySource = await tx.$queryRaw<
        Array<{ source_name: string | null; rows: number }>
      >`SELECT m.source_name, count(*)::int AS rows
        FROM ${f.from}
        WHERE ${f.candidate}
        GROUP BY m.source_name
        ORDER BY rows DESC, m.source_name`;
      return {
        cutoff: cutoff.toISOString(),
        youngest: youngest.toISOString(),
        older: row.older,
        protectedReferenced: row.referenced,
        protectedAdminManual: row.admin_manual,
        protectedTooYoung: row.too_young,
        protectedLatest: row.latest,
        protectedSessionLast: row.session_last,
        protectedSeasonEvidence: row.season_evidence,
        candidates: row.candidates,
        candidatesBySource: bySource.map((entry) => ({
          sourceName: entry.source_name,
          rows: entry.rows,
        })),
      };
    });
  }

  /** One bounded batch of one asset's sweep: examines at most `limit` rows
   * after `after` in (effective_at, id) order, deletes the candidates among
   * them and returns where the next batch continues. The scan is an ordered
   * range of the (asset_id, effective_at) index that stops at the LIMIT;
   * protections run only on those rows, and the DELETE reaches them by
   * primary key. A row kept now is passed by the cursor, never re-read by it. */
  async deleteBatch(
    scope: PriceSnapshotRetentionScope & {
      assetId: string;
      limit: number;
      after?: PriceSnapshotRetentionCursor | null;
    },
  ): Promise<PriceSnapshotRetentionBatch> {
    if (
      !Number.isSafeInteger(scope.limit) ||
      scope.limit < 1 ||
      scope.limit > 10_000
    )
      // @diagnosticSurface internal: Internal batch API guard; the message names only the bound.
      throw new PriceSnapshotRetentionInputError(
        'limit must be an integer between 1 and 10000.',
      );
    const now = scope.now ?? (await this.databaseNow());
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
        const [row] = await tx.$queryRaw<
          Array<{
            deleted: number;
            scanned: number;
            last_at: Date | null;
            last_id: string | null;
          }>
        >(assetPriceSnapshotRetentionBatchSql({ ...scope, now }));
        return {
          deleted: row.deleted,
          scanned: row.scanned,
          next:
            row.last_at && row.last_id
              ? { effectiveAt: row.last_at, id: row.last_id }
              : null,
        };
      },
      { timeout: 10_000 },
    );
  }

  private async databaseNow(): Promise<Date> {
    const [row] = await this.prisma.$queryRaw<
      Array<{ now: Date }>
    >`SELECT clock_timestamp() AS now`;
    return row.now;
  }
}

/** The exact batch statement AssetPriceSnapshotRetentionService.deleteBatch
 * runs, exported so PostgreSQL tests can EXPLAIN the production SQL itself. */
export function assetPriceSnapshotRetentionBatchSql(
  scope: PriceSnapshotRetentionScope & {
    assetId: string;
    limit: number;
    now: Date;
    after?: PriceSnapshotRetentionCursor | null;
  },
) {
  const { cutoff, youngest } = bounds(scope.retentionDays, scope.now);
  const f = fragments(cutoff, youngest, scope);
  const after = scope.after
    ? Prisma.sql`AND (m.effective_at, m.id) > (${scope.after.effectiveAt}::timestamp, ${scope.after.id})`
    : Prisma.empty;
  return Prisma.sql`
    WITH scan AS MATERIALIZED (
      SELECT m.id, m.effective_at FROM asset_price_snapshots m
      WHERE m.asset_id = ${scope.assetId} AND m.effective_at < ${cutoff} ${after}
      ORDER BY m.effective_at, m.id
      LIMIT ${scope.limit}
    ), candidates AS (
      SELECT m.id FROM ${f.from}
      WHERE m.id = ANY (ARRAY(SELECT s.id FROM scan s)) AND ${f.candidate}
      FOR UPDATE OF m SKIP LOCKED
    ), deleted AS (
      -- An array of the locked ids, not a join: the primary key always.
      DELETE FROM asset_price_snapshots d
      WHERE d.id = ANY (ARRAY(SELECT c.id FROM candidates c))
      RETURNING 1
    ), last_row AS (
      SELECT s.effective_at, s.id FROM scan s
      ORDER BY s.effective_at DESC, s.id DESC LIMIT 1
    )
    SELECT (SELECT count(*) FROM deleted)::int AS deleted,
      (SELECT count(*) FROM scan)::int AS scanned,
      (SELECT l.effective_at FROM last_row l) AS last_at,
      (SELECT l.id FROM last_row l) AS last_id`;
}

function bounds(retentionDays: number, now: Date) {
  if (
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < MIN_SNAPSHOT_AGE_DAYS ||
    retentionDays > 3650
  )
    // @diagnosticSurface internal: Operator retention guard; the message names only the option.
    throw new PriceSnapshotRetentionInputError(
      `retentionDays must be an explicit integer between ${MIN_SNAPSHOT_AGE_DAYS} and 3650 (product decision P6).`,
    );
  return {
    cutoff: new Date(now.getTime() - retentionDays * DAY_MS),
    youngest: new Date(now.getTime() - MIN_SNAPSHOT_AGE_DAYS * DAY_MS),
  };
}

function fragments(
  cutoff: Date,
  youngest: Date,
  scope: PriceSnapshotRetentionScope,
) {
  const sameSource = Prisma.sql`n.asset_id = m.asset_id
    AND n.source_type = m.source_type
    AND n.source_name IS NOT DISTINCT FROM m.source_name`;
  const newer = Prisma.sql`(n.effective_at, n.captured_at, n.id) > (m.effective_at, m.captured_at, m.id)`;
  const referenced = Prisma.join(
    ASSET_PRICE_SNAPSHOT_REFERENCES.map(
      ([table, column]) =>
        Prisma.sql`EXISTS (SELECT 1 FROM ${Prisma.raw(`"${table}"`)} r WHERE r.${Prisma.raw(`"${column}"`)} = m.id)`,
    ),
    ' OR ',
  );
  const latest = Prisma.sql`NOT EXISTS (
    SELECT 1 FROM asset_price_snapshots n WHERE ${sameSource} AND ${newer})`;
  // The exchange-local trading date: New York for US stocks, Seoul otherwise.
  // effective_at is a naive UTC timestamp, so it is read AS UTC first and only
  // then turned into the exchange's wall clock (DST follows the zone). A bare
  // timezone(zone, naive) would treat the UTC value as zone-local time and its
  // ::date would follow the session TimeZone.
  const localDate = (alias: 'm' | 'n') =>
    Prisma.sql`timezone(z.tz, timezone('UTC', ${Prisma.raw(alias)}.effective_at))::date`;
  // The next exchange-local midnight after m, as naive UTC: the end of m's
  // session date, so ③ reads only the rest of that date in the index.
  const dateEnd = Prisma.sql`timezone('UTC', timezone(z.tz, (${localDate('m')} + 1)::timestamp))`;
  const sessionLast = Prisma.sql`NOT EXISTS (
    SELECT 1 FROM asset_price_snapshots n
    WHERE n.asset_id = m.asset_id
      AND n.effective_at >= m.effective_at AND n.effective_at < ${dateEnd}
      AND ${sameSource} AND ${newer}
      AND ${localDate('n')} = ${localDate('m')})`;
  // ④ The earliest Season end at or after m decides: fewer same-source rows
  // up to it means fewer up to every later end. The inner LIMIT bounds how far
  // the index range is read; the outer one stops at the 10th successor.
  const nextSeasonEnd = Prisma.sql`(SELECT min(s.end_at) FROM seasons s WHERE s.end_at >= m.effective_at)`;
  const seasonEvidence = Prisma.sql`(${nextSeasonEnd} IS NOT NULL
    AND (SELECT count(*) FROM (
          SELECT 1 FROM (
            SELECT n.source_type, n.source_name, n.price FROM asset_price_snapshots n
            WHERE n.asset_id = m.asset_id
              AND n.effective_at > m.effective_at
              AND n.effective_at <= ${nextSeasonEnd}
            ORDER BY n.effective_at
            LIMIT ${SEASON_EVIDENCE_SCAN_ROWS}) n
          WHERE n.source_type = m.source_type
            AND n.source_name IS NOT DISTINCT FROM m.source_name
            AND n.price > 0
          LIMIT ${SEASON_EVIDENCE_ROWS}) newer_rows) < ${SEASON_EVIDENCE_ROWS})`;
  const adminManual = Prisma.sql`m.source_type = 'admin_manual'`;
  const tooYoung = Prisma.sql`(m.created_at >= ${youngest} OR m.captured_at >= ${youngest})`;
  const older = Prisma.sql`m.effective_at < ${cutoff} AND m.captured_at < ${cutoff}`;
  const scopeSql = Prisma.sql`${
    scope.assetId ? Prisma.sql`AND m.asset_id = ${scope.assetId}` : Prisma.empty
  } ${
    scope.sourceName
      ? Prisma.sql`AND m.source_name = ${scope.sourceName}`
      : Prisma.empty
  }`;
  const from = Prisma.sql`asset_price_snapshots m
    JOIN assets a ON a.id = m.asset_id
    CROSS JOIN LATERAL (
      SELECT CASE WHEN a.asset_type = 'us_stock'
        THEN 'America/New_York' ELSE 'Asia/Seoul' END AS tz) z`;
  // ② is implied by ③ (a newer row in the same session is a newer row).
  const candidate = Prisma.sql`${older} ${scopeSql}
    AND NOT (${adminManual}) AND NOT ${tooYoung}
    AND NOT (${referenced}) AND NOT ${sessionLast} AND NOT ${seasonEvidence}`;
  return {
    from,
    older,
    scope: scopeSql,
    referenced,
    latest,
    sessionLast,
    seasonEvidence,
    adminManual,
    tooYoung,
    candidate,
  };
}
