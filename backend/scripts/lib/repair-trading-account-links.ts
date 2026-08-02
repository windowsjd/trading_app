import {
  ParticipantStatus,
  TradingAccountMode,
  TradingAccountStatus,
  type Prisma,
  type PrismaClient,
} from '../../src/generated/prisma/client';
import {
  ensureSeasonTradingAccountLink,
  previewSeasonTradingAccountLink,
  SeasonTradingAccountLinkIntegrityError,
} from '../../src/seasons/season-trading-account-link';

/**
 * Non-destructive batch repair for the two participant↔account consistency
 * problems left behind by past deploy boundaries:
 *
 *  1. Season participants with tradingAccountId = null (old-version writer
 *     during the TradingAccount foundation deploy).
 *  2. Participants already excluded while their linked season account is
 *     still `active` (participants excluded BEFORE the exclusion→suspended
 *     sync shipped; re-calling the exclude API 409s first, so it can never
 *     correct them).
 *
 * - Dry-run performs the same lookups and integrity validation but writes
 *   nothing.
 * - Apply repairs each participant in its own transaction; a per-participant
 *   failure is reported (id + cause) without stopping the rest.
 * - Never touches wallets, ledgers, orders, positions, exchanges, snapshots,
 *   exclusion reasons/timestamps, ranks, or rewards. Never reverts a closed
 *   account to suspended, never touches general accounts, and never
 *   "corrects" a userId/mode mismatch (fail-closed report instead).
 * - Re-running is idempotent.
 */

export type RepairLinksOutcome = {
  seasonParticipantId: string;
  seasonId: string;
  userId: string;
  tradingAccountId: string;
  action: string;
};

export type RepairLinksFailure = {
  seasonParticipantId: string;
  seasonId: string;
  userId: string;
  code: string;
  message: string;
};

export type ExcludedActiveOutcome = {
  seasonParticipantId: string;
  seasonId: string;
  userId: string;
  tradingAccountId: string;
  action: 'suspended' | 'would-suspend' | 'already-consistent';
};

export type RepairLinksSummary = {
  mode: 'apply' | 'dry-run';
  nullLinkCount: number;
  outcomes: RepairLinksOutcome[];
  excludedActiveMismatchCount: number;
  excludedActiveOutcomes: ExcludedActiveOutcome[];
  failures: RepairLinksFailure[];
  remainingNullLinkCount: number | null;
  remainingExcludedActiveMismatchCount: number | null;
};

type RepairPrismaClient = Pick<PrismaClient, '$transaction'> &
  Pick<Prisma.TransactionClient, 'seasonParticipant' | 'tradingAccount'>;

const NULL_LINK_PARTICIPANT_SELECT = {
  id: true,
  seasonId: true,
  userId: true,
  joinedAt: true,
  participantStatus: true,
  initialCapitalKrw: true,
  tradingAccountId: true,
} as const;

// Excluded participants whose linked SEASON account is still active. Closed
// and suspended accounts, general accounts, and non-excluded participants are
// excluded by the query itself and are never touched.
const EXCLUDED_ACTIVE_MISMATCH_WHERE = {
  participantStatus: ParticipantStatus.excluded,
  tradingAccountId: { not: null },
  tradingAccount: {
    mode: TradingAccountMode.season,
    status: TradingAccountStatus.active,
  },
} satisfies Prisma.SeasonParticipantWhereInput;

export async function repairMissingTradingAccountLinks(
  prisma: RepairPrismaClient,
  options: { apply: boolean },
): Promise<RepairLinksSummary> {
  const failures: RepairLinksFailure[] = [];

  // --- 1) tradingAccountId = null participants -------------------------
  const nullParticipants = await prisma.seasonParticipant.findMany({
    where: { tradingAccountId: null },
    orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
    select: NULL_LINK_PARTICIPANT_SELECT,
  });

  const outcomes: RepairLinksOutcome[] = [];
  for (const participant of nullParticipants) {
    try {
      const result = options.apply
        ? await prisma.$transaction((tx) =>
            ensureSeasonTradingAccountLink(tx, participant),
          )
        : await previewSeasonTradingAccountLink(prisma, participant);

      outcomes.push({
        seasonParticipantId: participant.id,
        seasonId: participant.seasonId,
        userId: participant.userId,
        tradingAccountId: result.tradingAccountId,
        action: result.action,
      });
    } catch (error) {
      failures.push(toFailure(participant, error));
    }
  }

  // --- 2) excluded participant + still-active season account -----------
  const excludedActiveRows = await prisma.seasonParticipant.findMany({
    where: EXCLUDED_ACTIVE_MISMATCH_WHERE,
    orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      seasonId: true,
      userId: true,
      tradingAccountId: true,
      tradingAccount: {
        select: { id: true, userId: true, mode: true, status: true },
      },
    },
  });

  const excludedActiveOutcomes: ExcludedActiveOutcome[] = [];
  for (const row of excludedActiveRows) {
    const account = row.tradingAccount;
    if (!account || row.tradingAccountId === null) {
      continue;
    }

    // Fail-closed: an account owned by a different user is data corruption,
    // not something a status flip may silently "fix".
    if (account.userId !== row.userId) {
      failures.push({
        seasonParticipantId: row.id,
        seasonId: row.seasonId,
        userId: row.userId,
        code: 'TRADING_ACCOUNT_LINK_INTEGRITY',
        message:
          'Excluded participant is linked to an account owned by a different user; not modified.',
      });
      continue;
    }

    if (!options.apply) {
      excludedActiveOutcomes.push({
        seasonParticipantId: row.id,
        seasonId: row.seasonId,
        userId: row.userId,
        tradingAccountId: account.id,
        action: 'would-suspend',
      });
      continue;
    }

    try {
      // Guarded flip: only an account still active is moved to suspended, so
      // a concurrent close/suspend is never reverted or double-applied.
      const updated = await prisma.$transaction((tx) =>
        tx.tradingAccount.updateMany({
          where: { id: account.id, status: TradingAccountStatus.active },
          data: { status: TradingAccountStatus.suspended },
        }),
      );

      excludedActiveOutcomes.push({
        seasonParticipantId: row.id,
        seasonId: row.seasonId,
        userId: row.userId,
        tradingAccountId: account.id,
        action: updated.count === 1 ? 'suspended' : 'already-consistent',
      });
    } catch (error) {
      failures.push(toFailure(row, error));
    }
  }

  // --- post-apply verification -----------------------------------------
  const remainingNullLinkCount = options.apply
    ? await prisma.seasonParticipant.count({
        where: { tradingAccountId: null },
      })
    : null;
  const remainingExcludedActiveMismatchCount = options.apply
    ? await prisma.seasonParticipant.count({
        where: EXCLUDED_ACTIVE_MISMATCH_WHERE,
      })
    : null;

  return {
    mode: options.apply ? 'apply' : 'dry-run',
    nullLinkCount: nullParticipants.length,
    outcomes,
    excludedActiveMismatchCount: excludedActiveRows.length,
    excludedActiveOutcomes,
    failures,
    remainingNullLinkCount,
    remainingExcludedActiveMismatchCount,
  };
}

/**
 * Final exit decision for the CLI. Apply must NOT exit 0 while any
 * inconsistency remains — a later NOT NULL migration relies on this command
 * succeeding with a clean verification, not merely "no thrown errors".
 */
export function resolveRepairLinksExitCode(summary: RepairLinksSummary): {
  exitCode: 0 | 1;
  problems: string[];
} {
  const problems: string[] = [];

  if (summary.failures.length > 0) {
    problems.push(`${summary.failures.length} participant repair(s) failed.`);
  }

  if (summary.mode === 'apply') {
    if (summary.remainingNullLinkCount === null) {
      problems.push('Post-apply null-link verification could not be read.');
    } else if (summary.remainingNullLinkCount > 0) {
      problems.push(
        `${summary.remainingNullLinkCount} participant(s) still have tradingAccountId = null.`,
      );
    }

    if (summary.remainingExcludedActiveMismatchCount === null) {
      problems.push(
        'Post-apply excluded-active verification could not be read.',
      );
    } else if (summary.remainingExcludedActiveMismatchCount > 0) {
      problems.push(
        `${summary.remainingExcludedActiveMismatchCount} excluded participant(s) still have an active season account.`,
      );
    }
  }

  return { exitCode: problems.length > 0 ? 1 : 0, problems };
}

function toFailure(
  row: { id: string; seasonId: string; userId: string },
  error: unknown,
): RepairLinksFailure {
  return {
    seasonParticipantId: row.id,
    seasonId: row.seasonId,
    userId: row.userId,
    code:
      error instanceof SeasonTradingAccountLinkIntegrityError
        ? error.code
        : 'REPAIR_FAILED',
    message: error instanceof Error ? error.message : String(error),
  };
}
