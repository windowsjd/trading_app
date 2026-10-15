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

/** Settlement reads the newest rows per source before a Season's end. */
export const SEASON_EVIDENCE_ROWS = 10;
/** ⑦ quotes/orders pin ids within seconds; never race them. */
export const MIN_SNAPSHOT_AGE_DAYS = 2;
const DAY_MS = 24 * 60 * 60_000;

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
 * Reference-aware asset price snapshot retention (design v2.1 §8.5,
 * stage 4: preparation only). A row is a deletion candidate only when ALL
 * hold: ① no FK references it; ② it is not its (asset, source)'s newest
 * row; ③ not the last row of its (asset, source, exchange-local session
 * date) — close evidence and holiday carry-over; ④ not among the 10 newest
 * of its (asset, source) before any Season's end — settlement evidence,
 * kept after settlement too; ⑤ not admin_manual; ⑥ older than the audit
 * retention; ⑦ created at least 2 days ago. RESTRICT FKs stay the final
 * fence: a reference that appears mid-batch fails the batch, never orphans.
 *
 * Nothing schedules this. `dryRun` is read-only; `deleteBatch` exists for
 * the local safety tests and a separately approved activation only.
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

  /** Deletes at most `limit` candidates (oldest first); returns the count. */
  async deleteBatch(
    scope: PriceSnapshotRetentionScope & { limit: number },
  ): Promise<number> {
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
    const { cutoff, youngest } = bounds(scope.retentionDays, now);
    const f = fragments(cutoff, youngest, scope);
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
        return tx.$executeRaw`
          WITH candidates AS (
            SELECT m.id FROM ${f.from}
            WHERE ${f.candidate}
            ORDER BY m.effective_at, m.id
            LIMIT ${scope.limit}
            FOR UPDATE OF m SKIP LOCKED
          )
          DELETE FROM asset_price_snapshots d USING candidates c WHERE d.id = c.id`;
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
  const sessionLast = Prisma.sql`NOT EXISTS (
    SELECT 1 FROM asset_price_snapshots n
    WHERE ${sameSource} AND ${newer}
      AND timezone(z.tz, n.effective_at)::date = timezone(z.tz, m.effective_at)::date)`;
  const seasonEvidence = Prisma.sql`EXISTS (
    SELECT 1 FROM seasons s
    WHERE m.effective_at <= s.end_at
      AND (SELECT count(*) FROM (
            SELECT 1 FROM asset_price_snapshots n
            WHERE ${sameSource}
              AND n.effective_at > m.effective_at AND n.effective_at <= s.end_at
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
