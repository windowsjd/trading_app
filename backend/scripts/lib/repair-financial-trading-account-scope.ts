import type { Prisma, PrismaClient } from '../../src/generated/prisma/client';

/**
 * Non-destructive backfill + consistency check for the transitional
 * trading-account scope on the four financial tables (cash_wallets,
 * wallet_transactions, exchange_transactions, fx_execute_requests).
 *
 * Old-version writers running during the deploy boundary create financial
 * rows with tradingAccountId = null. This repair copies the linked
 * participant's account id onto those rows — and does NOTHING else:
 *
 *  - Amount/balance/reservation/fee/status/idempotency values are never
 *    modified; only the null tradingAccountId column is filled.
 *  - A row whose participant has no account link is reported
 *    (MISSING_PARTICIPANT_TRADING_ACCOUNT_LINK) and left untouched —
 *    `trading-accounts:repair-links --apply` must run first.
 *  - A row whose NON-NULL tradingAccountId disagrees with its participant's
 *    link is NEVER overwritten; it is reported as
 *    FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH and fails the run.
 *  - Re-running is idempotent (IS NULL guarded updates only).
 */

const BATCH_SIZE = 500;

export const FINANCIAL_SCOPE_MODELS = [
  'cashWallet',
  'walletTransaction',
  'exchangeTransaction',
  'fxExecuteRequest',
] as const;

export type FinancialScopeModel = (typeof FINANCIAL_SCOPE_MODELS)[number];

const MODEL_TABLES: Record<FinancialScopeModel, string> = {
  cashWallet: 'cash_wallets',
  walletTransaction: 'wallet_transactions',
  exchangeTransaction: 'exchange_transactions',
  fxExecuteRequest: 'fx_execute_requests',
};

export type FinancialScopeModelSummary = {
  nullRowCount: number;
  backfilledCount: number;
  missingParticipantLinkRows: Array<{
    rowId: string;
    seasonParticipantId: string;
  }>;
  mismatchCount: number;
};

export type FinancialScopeFailure = {
  model: FinancialScopeModel | 'verification';
  rowId: string | null;
  code: string;
  message: string;
};

export type FinancialScopeSummary = {
  mode: 'apply' | 'dry-run';
  models: Record<FinancialScopeModel, FinancialScopeModelSummary>;
  walletTransactionWalletMismatchCount: number;
  failures: FinancialScopeFailure[];
  remainingNullCounts: Record<FinancialScopeModel, number> | null;
  remainingMismatchCounts: Record<FinancialScopeModel, number> | null;
};

type RepairPrismaClient = Pick<
  PrismaClient,
  '$transaction' | '$queryRawUnsafe'
> &
  Pick<
    Prisma.TransactionClient,
    | 'cashWallet'
    | 'walletTransaction'
    | 'exchangeTransaction'
    | 'fxExecuteRequest'
  >;

type NullScopeRow = {
  id: string;
  seasonParticipantId: string;
  seasonParticipant: { tradingAccountId: string | null };
};

const NULL_SCOPE_SELECT = {
  id: true,
  seasonParticipantId: true,
  seasonParticipant: { select: { tradingAccountId: true } },
} as const;

export async function repairFinancialTradingAccountScope(
  prisma: RepairPrismaClient,
  options: { apply: boolean },
): Promise<FinancialScopeSummary> {
  const failures: FinancialScopeFailure[] = [];
  const models = {} as Record<FinancialScopeModel, FinancialScopeModelSummary>;

  for (const model of FINANCIAL_SCOPE_MODELS) {
    models[model] = await repairModel(prisma, model, options.apply, failures);
  }

  // Rows whose stored accountId disagrees with the participant link are
  // consistency FAILURES (never auto-corrected) in both modes.
  for (const model of FINANCIAL_SCOPE_MODELS) {
    if (models[model].mismatchCount > 0) {
      failures.push({
        model,
        rowId: null,
        code: 'FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH',
        message: `${models[model].mismatchCount} ${MODEL_TABLES[model]} row(s) have a tradingAccountId that differs from their participant's link; not overwritten.`,
      });
    }
  }

  const walletTransactionWalletMismatchCount =
    await countWalletTransactionWalletMismatch(prisma);
  if (walletTransactionWalletMismatchCount > 0) {
    failures.push({
      model: 'walletTransaction',
      rowId: null,
      code: 'FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH',
      message: `${walletTransactionWalletMismatchCount} wallet_transactions row(s) disagree with their wallet's tradingAccountId; not overwritten.`,
    });
  }

  let remainingNullCounts: Record<FinancialScopeModel, number> | null = null;
  let remainingMismatchCounts: Record<FinancialScopeModel, number> | null =
    null;
  if (options.apply) {
    remainingNullCounts = {} as Record<FinancialScopeModel, number>;
    remainingMismatchCounts = {} as Record<FinancialScopeModel, number>;
    for (const model of FINANCIAL_SCOPE_MODELS) {
      remainingNullCounts[model] = await countNullScope(prisma, model);
      remainingMismatchCounts[model] = await countParticipantMismatch(
        prisma,
        model,
      );
    }
  }

  return {
    mode: options.apply ? 'apply' : 'dry-run',
    models,
    walletTransactionWalletMismatchCount,
    failures,
    remainingNullCounts,
    remainingMismatchCounts,
  };
}

/**
 * Exit decision for the CLI (§ deployment order): after --apply, ANY
 * remaining null scope, any scope mismatch, or any per-row failure must
 * fail the command; the NOT NULL migration relies on a clean exit 0.
 */
export function resolveFinancialScopeExitCode(summary: FinancialScopeSummary): {
  exitCode: 0 | 1;
  problems: string[];
} {
  const problems: string[] = [];

  if (summary.failures.length > 0) {
    problems.push(
      `${summary.failures.length} consistency failure(s) reported.`,
    );
  }

  if (summary.mode === 'apply') {
    if (!summary.remainingNullCounts || !summary.remainingMismatchCounts) {
      problems.push('Post-apply verification could not be read.');
    } else {
      for (const model of FINANCIAL_SCOPE_MODELS) {
        const nulls = summary.remainingNullCounts[model];
        if (nulls > 0) {
          problems.push(
            `${nulls} ${MODEL_TABLES[model]} row(s) still have tradingAccountId = null.`,
          );
        }
        const mismatches = summary.remainingMismatchCounts[model];
        if (mismatches > 0) {
          problems.push(
            `${mismatches} ${MODEL_TABLES[model]} row(s) still mismatch their participant's account.`,
          );
        }
      }
    }
  }

  return { exitCode: problems.length > 0 ? 1 : 0, problems };
}

async function repairModel(
  prisma: RepairPrismaClient,
  model: FinancialScopeModel,
  apply: boolean,
  failures: FinancialScopeFailure[],
): Promise<FinancialScopeModelSummary> {
  const delegate = prisma[model] as unknown as {
    findMany: (args: unknown) => Promise<NullScopeRow[]>;
    updateMany: (args: unknown) => Promise<{ count: number }>;
  };

  const missingParticipantLinkRows: FinancialScopeModelSummary['missingParticipantLinkRows'] =
    [];
  let nullRowCount = 0;
  let backfilledCount = 0;
  let cursorId: string | null = null;

  // Cursor pagination (id asc) so unresolvable rows (missing participant
  // link) can never make the loop spin in place.
  for (;;) {
    const rows: NullScopeRow[] = await delegate.findMany({
      where: { tradingAccountId: null },
      orderBy: { id: 'asc' },
      take: BATCH_SIZE,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      select: NULL_SCOPE_SELECT,
    });

    if (rows.length === 0) {
      break;
    }
    cursorId = rows[rows.length - 1].id;
    nullRowCount += rows.length;

    // Group rows by their participant's account id so each batch update is
    // a single guarded UPDATE per target account.
    const byAccount = new Map<string, string[]>();
    for (const row of rows) {
      const accountId = row.seasonParticipant.tradingAccountId;
      if (!accountId) {
        missingParticipantLinkRows.push({
          rowId: row.id,
          seasonParticipantId: row.seasonParticipantId,
        });
        continue;
      }
      const ids = byAccount.get(accountId) ?? [];
      ids.push(row.id);
      byAccount.set(accountId, ids);
    }

    if (!apply) {
      for (const ids of byAccount.values()) {
        backfilledCount += ids.length;
      }
      continue;
    }

    for (const [accountId, ids] of byAccount) {
      try {
        // Guarded fill: only still-null rows are touched; amounts and every
        // other column stay byte-identical.
        const updated = await delegate.updateMany({
          where: { id: { in: ids }, tradingAccountId: null },
          data: { tradingAccountId: accountId },
        });
        backfilledCount += updated.count;
      } catch (error) {
        failures.push({
          model,
          rowId: ids[0] ?? null,
          code: 'FINANCIAL_SCOPE_BACKFILL_FAILED',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (rows.length < BATCH_SIZE) {
      break;
    }
  }

  return {
    nullRowCount,
    backfilledCount,
    missingParticipantLinkRows,
    mismatchCount: await countParticipantMismatch(prisma, model),
  };
}

async function countNullScope(
  prisma: RepairPrismaClient,
  model: FinancialScopeModel,
): Promise<number> {
  const delegate = prisma[model] as unknown as {
    count: (args: unknown) => Promise<number>;
  };
  return delegate.count({ where: { tradingAccountId: null } });
}

async function countParticipantMismatch(
  prisma: RepairPrismaClient,
  model: FinancialScopeModel,
): Promise<number> {
  const table = MODEL_TABLES[model];
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "${table}" t
     JOIN "season_participants" sp ON sp."id" = t."season_participant_id"
     WHERE t."trading_account_id" IS NOT NULL
       AND sp."trading_account_id" IS DISTINCT FROM t."trading_account_id"`,
  )) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

async function countWalletTransactionWalletMismatch(
  prisma: RepairPrismaClient,
): Promise<number> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM "wallet_transactions" t
     JOIN "cash_wallets" w ON w."id" = t."wallet_id"
     WHERE t."trading_account_id" IS NOT NULL
       AND w."trading_account_id" IS NOT NULL
       AND t."trading_account_id" <> w."trading_account_id"`,
  )) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}
