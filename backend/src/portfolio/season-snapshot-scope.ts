import { HttpException, HttpStatus } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';

/**
 * Season-only snapshot scoping (작업 7).
 *
 * Season snapshot writers resolve their canonical account through the
 * participant. Readers identify season rows through
 * TradingAccount -> SeasonParticipant, never a duplicated snapshot column.
 */

/**
 * Resolves the participant's verified trading account for a snapshot write
 * and fails closed if the season-domain link is damaged.
 */
export async function requireParticipantTradingAccountIdForSnapshot(
  client: Pick<Prisma.TransactionClient, 'seasonParticipant'>,
  seasonParticipantId: string,
): Promise<string> {
  const participant = await client.seasonParticipant.findUnique({
    where: { id: seasonParticipantId },
    select: { tradingAccountId: true },
  });

  if (!participant?.tradingAccountId) {
    throw new HttpException(
      {
        success: false,
        error: {
          code: 'TRADING_ACCOUNT_LINK_INTEGRITY',
          message:
            'Season participant has no trading account link; run trading-accounts:repair-links before writing performance snapshots.',
        },
      },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  return participant.tradingAccountId;
}
