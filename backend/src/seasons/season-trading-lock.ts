import { HttpException, HttpStatus } from '@nestjs/common';
import {
  ParticipantStatus,
  Prisma,
  SeasonStatus,
  TradingAccountMode,
  TradingAccountStatus,
} from '../generated/prisma/client';

/**
 * Authorization locks only; season trades do not take the general TWR fence.
 * Current writers determine this order: ranking/settlement lock Season first;
 * exclusion updates Account before Participant and then cleans up Orders.
 * Take these locks before Order/Wallet/Position, never upgrade them.
 * Executions update participant valuation, so they acquire NO KEY UPDATE
 * up front; registration only needs SHARE. Account/Season always use SHARE.
 * Read clock_timestamp() only after the caller's remaining row locks.
 */
export async function lockSeasonTradingContext(
  tx: Prisma.TransactionClient,
  input: {
    seasonParticipantId: string;
    userId?: string;
    participantWrite?: boolean;
  },
) {
  // This read locates lock targets only. Authorization uses the locked rows.
  const targets = await tx.$queryRaw<
    Array<{ seasonId: string; tradingAccountId: string | null }>
  >`
    SELECT "season_id" AS "seasonId", "trading_account_id" AS "tradingAccountId"
    FROM "season_participants" WHERE "id" = ${input.seasonParticipantId}
  `;
  const target = targets[0];
  if (!target) {
    fail(
      HttpStatus.NOT_FOUND,
      'PARTICIPANT_NOT_FOUND',
      'Season participant was not found.',
    );
  }
  const seasons = await tx.$queryRaw<
    Array<{ id: string; status: SeasonStatus; startAt: Date; endAt: Date }>
  >`
    SELECT "id", "status", "start_at" AS "startAt", "end_at" AS "endAt"
    FROM "seasons" WHERE "id" = ${target.seasonId} FOR SHARE
  `;
  const accounts = await tx.$queryRaw<
    Array<{
      id: string;
      userId: string;
      mode: TradingAccountMode;
      status: TradingAccountStatus;
    }>
  >`
    SELECT "id", "user_id" AS "userId", "mode", "status"
    FROM "trading_accounts" WHERE "id" = ${target.tradingAccountId} FOR SHARE
  `;
  const participants = await tx.$queryRaw<
    Array<{
      id: string;
      userId: string;
      seasonId: string;
      tradingAccountId: string;
      participantStatus: ParticipantStatus;
    }>
  >`
    SELECT "id", "user_id" AS "userId", "season_id" AS "seasonId",
           "trading_account_id" AS "tradingAccountId", "participant_status" AS "participantStatus"
    FROM "season_participants" WHERE "id" = ${input.seasonParticipantId}
    ${input.participantWrite === false ? Prisma.sql`FOR SHARE` : Prisma.sql`FOR NO KEY UPDATE`}
  `;
  const season = seasons[0];
  const account = accounts[0];
  const participant = participants[0];
  if (!participant || (input.userId && participant.userId !== input.userId)) {
    fail(
      HttpStatus.NOT_FOUND,
      'PARTICIPANT_NOT_FOUND',
      'Season participant was not found.',
    );
  }
  if (!season) {
    fail(HttpStatus.CONFLICT, 'SEASON_NOT_ACTIVE', 'Season is not active.');
  }
  if (!participant.tradingAccountId) {
    fail(
      HttpStatus.INTERNAL_SERVER_ERROR,
      'TRADING_ACCOUNT_LINK_INTEGRITY',
      'Participant has no trading account link.',
    );
  }
  if (
    !account ||
    account.mode !== TradingAccountMode.season ||
    account.userId !== participant.userId ||
    participant.tradingAccountId !== account.id ||
    participant.seasonId !== season.id
  ) {
    fail(
      HttpStatus.INTERNAL_SERVER_ERROR,
      'TRADING_ACCOUNT_SCOPE_MISMATCH',
      'Season trading scope changed while acquiring authorization locks.',
    );
  }
  return { season, account, participant };
}

function fail(status: HttpStatus, code: string, message: string): never {
  throw new HttpException({ success: false, error: { code, message } }, status);
}
