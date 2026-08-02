import type { Prisma, PrismaClient } from '../../src/generated/prisma/client';
import {
  ensureSeasonTradingAccountLink,
  previewSeasonTradingAccountLink,
  SeasonTradingAccountLinkIntegrityError,
} from '../../src/seasons/season-trading-account-link';

/**
 * Non-destructive batch repair for season participants left with
 * tradingAccountId = null by an old-version writer during the
 * TradingAccount deploy boundary.
 *
 * - Dry-run performs the same lookups and integrity validation but writes
 *   nothing.
 * - Apply repairs each participant in its own transaction via the shared
 *   ensureSeasonTradingAccountLink rules (deterministic account id; wallets,
 *   ledgers, orders, positions, and snapshots untouched; general accounts
 *   never created).
 * - Already-linked participants are never modified; re-running is idempotent.
 * - A per-participant failure is reported (id + cause) without stopping the
 *   remaining repairs.
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

export type RepairLinksSummary = {
  mode: 'apply' | 'dry-run';
  nullLinkCount: number;
  outcomes: RepairLinksOutcome[];
  failures: RepairLinksFailure[];
  remainingNullLinkCount: number | null;
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

export async function repairMissingTradingAccountLinks(
  prisma: RepairPrismaClient,
  options: { apply: boolean },
): Promise<RepairLinksSummary> {
  const participants = await prisma.seasonParticipant.findMany({
    where: { tradingAccountId: null },
    orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
    select: NULL_LINK_PARTICIPANT_SELECT,
  });

  const outcomes: RepairLinksOutcome[] = [];
  const failures: RepairLinksFailure[] = [];

  for (const participant of participants) {
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
      failures.push({
        seasonParticipantId: participant.id,
        seasonId: participant.seasonId,
        userId: participant.userId,
        code:
          error instanceof SeasonTradingAccountLinkIntegrityError
            ? error.code
            : 'REPAIR_FAILED',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Post-apply verification: how many null links remain (should be exactly
  // the failed count plus any rows created concurrently after the scan).
  const remainingNullLinkCount = options.apply
    ? await prisma.seasonParticipant.count({
        where: { tradingAccountId: null },
      })
    : null;

  return {
    mode: options.apply ? 'apply' : 'dry-run',
    nullLinkCount: participants.length,
    outcomes,
    failures,
    remainingNullLinkCount,
  };
}
