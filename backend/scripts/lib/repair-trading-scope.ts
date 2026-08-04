import type { Prisma, PrismaClient } from '../../src/generated/prisma/client';

/**
 * Non-destructive backfill + consistency check for the transitional
 * trading-account scope on the trading tables (orders, positions, quotes).
 * Companion to repair-trading-account-links (participant ↔ account link)
 * and repair-financial-trading-account-scope (the four financial tables).
 *
 * Old-version writers running during the deploy boundary create trading
 * rows with tradingAccountId = null. This repair copies the linked
 * participant's account id onto those rows — and does NOTHING else:
 *
 *  - Order status/amounts/prices/reservations, position quantities/average
 *    costs/PnL, and quote statuses/hashes/amounts are never modified; only
 *    the null tradingAccountId column is filled.
 *  - A row whose participant has no account link is reported
 *    (MISSING_PARTICIPANT_TRADING_ACCOUNT_LINK) and left untouched —
 *    `trading-accounts:repair-links --apply` must run first.
 *  - A row whose NON-NULL tradingAccountId disagrees with its participant's
 *    link is NEVER overwritten; it is reported as
 *    TRADING_ACCOUNT_SCOPE_MISMATCH and fails the run.
 *  - Order ↔ linked-quote disagreements (account or participant) are
 *    reported (ORDER_QUOTE_ACCOUNT_SCOPE_MISMATCH) and never auto-adjusted.
 *  - Quotes with NO participant at all cannot be attributed to any account
 *    and are never guessed; order/fx quotes are trading data, so their
 *    existence is reported as QUOTE_PARTICIPANT_SCOPE_MISSING.
 *  - Re-running is idempotent (IS NULL guarded updates only).
 */

const BATCH_SIZE = 500;

export const TRADING_SCOPE_MODELS = ['order', 'position', 'quote'] as const;

export type TradingScopeModel = (typeof TRADING_SCOPE_MODELS)[number];

const MODEL_TABLES: Record<TradingScopeModel, string> = {
  order: 'orders',
  position: 'positions',
  quote: 'quotes',
};

export type TradingScopeModelSummary = {
  nullRowCount: number;
  backfilledCount: number;
  missingParticipantLinkRows: Array<{
    rowId: string;
    seasonParticipantId: string;
  }>;
  mismatchCount: number;
};

export type TradingScopeFailure = {
  model: TradingScopeModel | 'order-quote' | 'verification';
  rowId: string | null;
  code: string;
  message: string;
};

export type TradingScopeSummary = {
  mode: 'apply' | 'dry-run';
  models: Record<TradingScopeModel, TradingScopeModelSummary>;
  orderQuoteAccountMismatchCount: number;
  orderQuoteParticipantMismatchCount: number;
  quotesWithoutParticipantCount: number;
  failures: TradingScopeFailure[];
  remainingNullCounts: Record<TradingScopeModel, number> | null;
  remainingMismatchCounts: Record<TradingScopeModel, number> | null;
};

type RepairPrismaClient = Pick<PrismaClient, '$queryRawUnsafe'> &
  Pick<Prisma.TransactionClient, 'order' | 'position' | 'quote'>;

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

export async function repairTradingScope(
  prisma: RepairPrismaClient,
  options: { apply: boolean },
): Promise<TradingScopeSummary> {
  const failures: TradingScopeFailure[] = [];
  const models = {} as Record<TradingScopeModel, TradingScopeModelSummary>;

  for (const model of TRADING_SCOPE_MODELS) {
    models[model] = await repairModel(prisma, model, options.apply, failures);
  }

  // Rows whose stored accountId disagrees with the participant link are
  // consistency FAILURES (never auto-corrected) in both modes.
  for (const model of TRADING_SCOPE_MODELS) {
    if (models[model].mismatchCount > 0) {
      failures.push({
        model,
        rowId: null,
        code: 'TRADING_ACCOUNT_SCOPE_MISMATCH',
        message: `${models[model].mismatchCount} ${MODEL_TABLES[model]} row(s) have a tradingAccountId that differs from their participant's link; not overwritten.`,
      });
    }
  }

  const orderQuoteAccountMismatchCount =
    await countOrderQuoteAccountMismatch(prisma);
  if (orderQuoteAccountMismatchCount > 0) {
    failures.push({
      model: 'order-quote',
      rowId: null,
      code: 'ORDER_QUOTE_ACCOUNT_SCOPE_MISMATCH',
      message: `${orderQuoteAccountMismatchCount} order(s) disagree with their linked quote's tradingAccountId; not overwritten.`,
    });
  }

  const orderQuoteParticipantMismatchCount =
    await countOrderQuoteParticipantMismatch(prisma);
  if (orderQuoteParticipantMismatchCount > 0) {
    failures.push({
      model: 'order-quote',
      rowId: null,
      code: 'ORDER_QUOTE_ACCOUNT_SCOPE_MISMATCH',
      message: `${orderQuoteParticipantMismatchCount} order(s) disagree with their linked quote's seasonParticipantId; not overwritten.`,
    });
  }

  // Order/FX quotes with no participant cannot be scoped to any account and
  // are never guessed. Both quote types are trading/exchange data, so any
  // such row is an integrity report, not a normal state.
  const quotesWithoutParticipantCount =
    await countQuotesWithoutParticipant(prisma);
  if (quotesWithoutParticipantCount > 0) {
    failures.push({
      model: 'quote',
      rowId: null,
      code: 'QUOTE_PARTICIPANT_SCOPE_MISSING',
      message: `${quotesWithoutParticipantCount} quote row(s) have no seasonParticipantId; their account scope cannot be derived and was not guessed.`,
    });
  }

  let remainingNullCounts: Record<TradingScopeModel, number> | null = null;
  let remainingMismatchCounts: Record<TradingScopeModel, number> | null = null;
  if (options.apply) {
    remainingNullCounts = {} as Record<TradingScopeModel, number>;
    remainingMismatchCounts = {} as Record<TradingScopeModel, number>;
    for (const model of TRADING_SCOPE_MODELS) {
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
    orderQuoteAccountMismatchCount,
    orderQuoteParticipantMismatchCount,
    quotesWithoutParticipantCount,
    failures,
    remainingNullCounts,
    remainingMismatchCounts,
  };
}

/**
 * Exit decision for the CLI (§ deployment order): after --apply, ANY
 * remaining null scope (orders/positions/participant-linked quotes), any
 * scope mismatch, any order↔quote disagreement, or any per-row failure must
 * fail the command; the NOT NULL tightening relies on a clean exit 0.
 */
export function resolveTradingScopeExitCode(summary: TradingScopeSummary): {
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
      for (const model of TRADING_SCOPE_MODELS) {
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
  model: TradingScopeModel,
  apply: boolean,
  failures: TradingScopeFailure[],
): Promise<TradingScopeModelSummary> {
  const delegate = prisma[model] as unknown as {
    findMany: (args: unknown) => Promise<NullScopeRow[]>;
    updateMany: (args: unknown) => Promise<{ count: number }>;
  };

  const missingParticipantLinkRows: TradingScopeModelSummary['missingParticipantLinkRows'] =
    [];
  let nullRowCount = 0;
  let backfilledCount = 0;
  let cursorId: string | null = null;

  // Quotes: only participant-linked rows are candidates; rows with a null
  // participant are counted/reported separately and never touched here.
  const nullScopeWhere =
    model === 'quote'
      ? { tradingAccountId: null, seasonParticipantId: { not: null } }
      : { tradingAccountId: null };

  // Cursor pagination (id asc) so unresolvable rows (missing participant
  // link) can never make the loop spin in place.
  for (;;) {
    const rows: NullScopeRow[] = await delegate.findMany({
      where: nullScopeWhere,
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
        // Guarded fill: only still-null rows are touched; statuses,
        // amounts, quantities, hashes, and every other column stay
        // byte-identical.
        const updated = await delegate.updateMany({
          where: { id: { in: ids }, tradingAccountId: null },
          data: { tradingAccountId: accountId },
        });
        backfilledCount += updated.count;
      } catch (error) {
        failures.push({
          model,
          rowId: ids[0] ?? null,
          code: 'TRADING_SCOPE_BACKFILL_FAILED',
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
  model: TradingScopeModel,
): Promise<number> {
  const delegate = prisma[model] as unknown as {
    count: (args: unknown) => Promise<number>;
  };
  return delegate.count({
    where:
      model === 'quote'
        ? { tradingAccountId: null, seasonParticipantId: { not: null } }
        : { tradingAccountId: null },
  });
}

async function countParticipantMismatch(
  prisma: RepairPrismaClient,
  model: TradingScopeModel,
): Promise<number> {
  const table = MODEL_TABLES[model];
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM "${table}" t
     JOIN "season_participants" sp ON sp."id" = t."season_participant_id"
     WHERE t."trading_account_id" IS NOT NULL
       AND sp."trading_account_id" IS DISTINCT FROM t."trading_account_id"`,
  );
  return rows[0]?.n ?? 0;
}

async function countOrderQuoteAccountMismatch(
  prisma: RepairPrismaClient,
): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM "orders" o
     JOIN "quotes" q ON q."id" = o."quote_id"
     WHERE o."trading_account_id" IS NOT NULL
       AND q."trading_account_id" IS NOT NULL
       AND o."trading_account_id" <> q."trading_account_id"`,
  );
  return rows[0]?.n ?? 0;
}

async function countOrderQuoteParticipantMismatch(
  prisma: RepairPrismaClient,
): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM "orders" o
     JOIN "quotes" q ON q."id" = o."quote_id"
     WHERE q."season_participant_id" IS NOT NULL
       AND o."season_participant_id" <> q."season_participant_id"`,
  );
  return rows[0]?.n ?? 0;
}

async function countQuotesWithoutParticipant(
  prisma: RepairPrismaClient,
): Promise<number> {
  return prisma.quote.count({ where: { seasonParticipantId: null } });
}
