import type { PrismaClient } from '../../src/generated/prisma/client';

/**
 * Non-destructive backfill of the transitional trading-account scope on the
 * SNAPSHOT tables (작업 7). Companion to — and deliberately separate from —
 * repair-links (participant ↔ account), repair-financial-scope (the four
 * financial tables), and repair-trading-scope (orders/positions/quotes).
 *
 * During a rolling deploy an old-version writer can still create an
 * EquitySnapshot or DailyPortfolioSnapshot with tradingAccountId = null. This
 * repair copies the linked participant's account id onto those rows and does
 * NOTHING else:
 *
 *  - No amount, return rate, captured time, snapshot date, or reason is ever
 *    modified; only the null tradingAccountId column is filled.
 *  - A row whose participant has no account link is reported
 *    (MISSING_PARTICIPANT_TRADING_ACCOUNT_LINK) and left untouched — run
 *    `trading-accounts:repair-links --apply` first.
 *  - A row whose NON-NULL account id disagrees with its participant link is
 *    NEVER overwritten; it is reported as TRADING_ACCOUNT_SCOPE_MISMATCH.
 *  - GENERAL snapshots (no participant) can never be attributed by this
 *    repair: there is nothing to copy from. A general row missing its account
 *    id is reported as GENERAL_SNAPSHOT_SCOPE_UNRECONSTRUCTABLE and never
 *    guessed, and a general row that somehow carries a participant link is
 *    reported as GENERAL_SNAPSHOT_HAS_PARTICIPANT.
 *  - Re-running is idempotent (IS NULL guarded updates only).
 */

const BATCH_SIZE = 500;

export const SNAPSHOT_SCOPE_MODELS = [
  'equitySnapshot',
  'dailyPortfolioSnapshot',
] as const;

export type SnapshotScopeModel = (typeof SNAPSHOT_SCOPE_MODELS)[number];

export type SnapshotScopeFailure = {
  model: SnapshotScopeModel | null;
  rowId: string | null;
  code: string;
  message: string;
};

export type SnapshotScopeModelSummary = {
  nullRowCount: number;
  backfilledCount: number;
  missingParticipantLinkRows: Array<{
    rowId: string;
    seasonParticipantId: string;
  }>;
  generalRowsWithoutAccount: number;
  generalRowsWithParticipant: number;
  mismatchCount: number;
};

export type SnapshotScopeSummary = {
  apply: boolean;
  models: Record<SnapshotScopeModel, SnapshotScopeModelSummary>;
  failures: SnapshotScopeFailure[];
  remainingNullCounts?: Record<SnapshotScopeModel, number>;
  remainingMismatchCounts?: Record<SnapshotScopeModel, number>;
};

type Delegate = {
  findMany: (args: unknown) => Promise<
    Array<{
      id: string;
      seasonParticipantId: string | null;
      tradingAccountId: string | null;
    }>
  >;
  count: (args: unknown) => Promise<number>;
  updateMany: (args: unknown) => Promise<{ count: number }>;
};

function delegateOf(prisma: PrismaClient, model: SnapshotScopeModel): Delegate {
  return prisma[model] as unknown as Delegate;
}

export async function repairSnapshotScope(
  prisma: PrismaClient,
  options: { apply: boolean },
): Promise<SnapshotScopeSummary> {
  const summary: SnapshotScopeSummary = {
    apply: options.apply,
    models: {
      equitySnapshot: emptyModelSummary(),
      dailyPortfolioSnapshot: emptyModelSummary(),
    },
    failures: [],
  };

  for (const model of SNAPSHOT_SCOPE_MODELS) {
    const delegate = delegateOf(prisma, model);
    const modelSummary = summary.models[model];

    // ---- rows with a participant but no account id ----
    let cursor: string | undefined;
    for (;;) {
      const rows = await delegate.findMany({
        where: {
          tradingAccountId: null,
          seasonParticipantId: { not: null },
        },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          seasonParticipantId: true,
          tradingAccountId: true,
        },
      });
      if (rows.length === 0) break;
      cursor = rows[rows.length - 1].id;
      modelSummary.nullRowCount += rows.length;

      const participantIds = [
        ...new Set(rows.map((row) => row.seasonParticipantId!)),
      ];
      const participants = await prisma.seasonParticipant.findMany({
        where: { id: { in: participantIds } },
        select: { id: true, tradingAccountId: true },
      });
      const linkById = new Map(
        participants.map((p) => [p.id, p.tradingAccountId]),
      );

      for (const row of rows) {
        const accountId = linkById.get(row.seasonParticipantId!);
        if (!accountId) {
          modelSummary.missingParticipantLinkRows.push({
            rowId: row.id,
            seasonParticipantId: row.seasonParticipantId!,
          });
          summary.failures.push({
            model,
            rowId: row.id,
            code: 'MISSING_PARTICIPANT_TRADING_ACCOUNT_LINK',
            message:
              'Participant has no trading account link; run trading-accounts:repair-links --apply first.',
          });
          continue;
        }

        if (!options.apply) {
          modelSummary.backfilledCount += 1;
          continue;
        }

        // IS NULL guarded: a concurrent writer that already set the scope wins
        // and this update becomes a no-op rather than an overwrite.
        const updated = await delegate.updateMany({
          where: { id: row.id, tradingAccountId: null },
          data: { tradingAccountId: accountId },
        });
        modelSummary.backfilledCount += updated.count;
      }

      if (rows.length < BATCH_SIZE) break;
    }

    // ---- non-null mismatches (reported, NEVER corrected) ----
    modelSummary.mismatchCount = await countMismatches(prisma, model);
    if (modelSummary.mismatchCount > 0) {
      summary.failures.push({
        model,
        rowId: null,
        code: 'TRADING_ACCOUNT_SCOPE_MISMATCH',
        message: `${modelSummary.mismatchCount} row(s) disagree with their participant's account link; investigate manually (never auto-corrected).`,
      });
    }

    // ---- general rows: nothing to copy from, so nothing is guessed ----
    modelSummary.generalRowsWithoutAccount = await delegate.count({
      where: { seasonParticipantId: null, tradingAccountId: null },
    });
    if (modelSummary.generalRowsWithoutAccount > 0) {
      summary.failures.push({
        model,
        rowId: null,
        code: 'GENERAL_SNAPSHOT_SCOPE_UNRECONSTRUCTABLE',
        message: `${modelSummary.generalRowsWithoutAccount} snapshot(s) have neither a participant nor an account; the owning account cannot be derived and is never guessed.`,
      });
    }
  }

  // A general snapshot must never carry a participant link.
  for (const model of SNAPSHOT_SCOPE_MODELS) {
    const delegate = delegateOf(prisma, model);
    const count = await delegate.count({
      where: {
        seasonParticipantId: { not: null },
        tradingAccount: { mode: 'general' },
      },
    });
    summary.models[model].generalRowsWithParticipant = count;
    if (count > 0) {
      summary.failures.push({
        model,
        rowId: null,
        code: 'GENERAL_SNAPSHOT_HAS_PARTICIPANT',
        message: `${count} general-account snapshot(s) carry a season participant link; investigate manually.`,
      });
    }
  }

  if (options.apply) {
    summary.remainingNullCounts = {
      equitySnapshot: await delegateOf(prisma, 'equitySnapshot').count({
        where: { tradingAccountId: null, seasonParticipantId: { not: null } },
      }),
      dailyPortfolioSnapshot: await delegateOf(
        prisma,
        'dailyPortfolioSnapshot',
      ).count({
        where: { tradingAccountId: null, seasonParticipantId: { not: null } },
      }),
    };
    summary.remainingMismatchCounts = {
      equitySnapshot: await countMismatches(prisma, 'equitySnapshot'),
      dailyPortfolioSnapshot: await countMismatches(
        prisma,
        'dailyPortfolioSnapshot',
      ),
    };
  }

  return summary;
}

async function countMismatches(
  prisma: PrismaClient,
  model: SnapshotScopeModel,
): Promise<number> {
  const table =
    model === 'equitySnapshot'
      ? 'equity_snapshots'
      : 'daily_portfolio_snapshots';
  const rows =
    model === 'equitySnapshot'
      ? await prisma.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n
          FROM "equity_snapshots" s
          JOIN "season_participants" sp ON sp."id" = s."season_participant_id"
          WHERE s."trading_account_id" IS NOT NULL
            AND sp."trading_account_id" IS NOT NULL
            AND s."trading_account_id" <> sp."trading_account_id"
        `
      : await prisma.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n
          FROM "daily_portfolio_snapshots" s
          JOIN "season_participants" sp ON sp."id" = s."season_participant_id"
          WHERE s."trading_account_id" IS NOT NULL
            AND sp."trading_account_id" IS NOT NULL
            AND s."trading_account_id" <> sp."trading_account_id"
        `;
  void table;
  return Number(rows[0]?.n ?? 0);
}

function emptyModelSummary(): SnapshotScopeModelSummary {
  return {
    nullRowCount: 0,
    backfilledCount: 0,
    missingParticipantLinkRows: [],
    generalRowsWithoutAccount: 0,
    generalRowsWithParticipant: 0,
    mismatchCount: 0,
  };
}

/** Non-zero while anything is unresolved, so `--apply` cannot look clean. */
export function resolveSnapshotScopeExitCode(
  summary: SnapshotScopeSummary,
): number {
  if (summary.failures.length > 0) return 1;
  if (!summary.apply) return 0;

  const remainingNull = Object.values(summary.remainingNullCounts ?? {});
  const remainingMismatch = Object.values(
    summary.remainingMismatchCounts ?? {},
  );

  return remainingNull.some((n) => n > 0) ||
    remainingMismatch.some((n) => n > 0)
    ? 1
    : 0;
}
