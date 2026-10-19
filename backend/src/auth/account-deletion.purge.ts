import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma } from '../generated/prisma/client';

/**
 * The database half of a self-service account deletion
 * (docs/account-deletion-contract.md §4–§5). Every function runs inside the
 * ONE deletion transaction, after the caller locked the user row FOR NO KEY
 * UPDATE (KEY SHARE inserters such as FX requests and season joins can still
 * finish; the final DELETE of the user row then waits for them).
 *
 * Nothing here changes a foreign key, adds a cascade or touches another
 * member's financial rows. Each DELETE names its rows explicitly, children
 * before parents, so the RESTRICT foreign keys double as a completeness check:
 * a row this list missed (or one committed concurrently) fails the final
 * DELETE of the account/user and the whole transaction rolls back.
 */

type Tx = Prisma.TransactionClient;

/** Placeholder members own anonymous settled-season results (§5). The
 * reserved `.invalid` TLD can never receive mail, so the address can never
 * be verified, used for signup or reset. */
export const ACCOUNT_DELETION_PLACEHOLDER_EMAIL_DOMAIN =
  'deleted-member.invalid';
/** Not an Argon2 encoding: password verification can never succeed. */
export const ACCOUNT_DELETION_PLACEHOLDER_PASSWORD_HASH = '!account-deleted';
export const ACCOUNT_DELETION_PLACEHOLDER_NICKNAME = '탈퇴한 회원';

export function isAccountDeletionPlaceholderEmail(email: string): boolean {
  return (
    typeof email === 'string' &&
    email
      .toLowerCase()
      .endsWith(`@${ACCOUNT_DELETION_PLACEHOLDER_EMAIL_DOMAIN}`)
  );
}

/** Thrown when the member's account/participant set changed between the
 * unlocked read and the locks; the caller retries the whole transaction. */
export class AccountDeletionScopeChanged extends Error {
  constructor() {
    // @diagnosticSurface internal: AccountDeletionService retries the transaction and maps exhaustion to ACCOUNT_DELETION_FAILED.
    super('Account deletion scope changed while locking.');
    this.name = 'AccountDeletionScopeChanged';
  }
}

export type DeletionParticipant = {
  id: string;
  seasonId: string;
  tradingAccountId: string;
};

export type DeletionScope = {
  accountIds: string[];
  participants: DeletionParticipant[];
  seasonStatus: Map<string, string>;
};

function sameIds(left: string[], right: string[]) {
  return left.length === right.length && left.every((id, i) => id === right[i]);
}

/**
 * Locks in the order every existing writer uses, so the deletion serializes
 * with them instead of deadlocking:
 *   Quote (quote-first trades) → Season FOR SHARE (refresh, settlement and
 *   join hold FOR UPDATE) → TradingAccount → SeasonParticipant → Order (cancel,
 *   LOC release and ended-season cleanup lock Order before Wallet/Position).
 * Accounts and participants are locked FOR UPDATE because they are deleted;
 * no lock is upgraded later.
 */
export async function lockDeletionScope(
  tx: Tx,
  userId: string,
): Promise<DeletionScope> {
  const accounts = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM trading_accounts WHERE user_id = ${userId} ORDER BY id`;
  const accountIds = accounts.map((row) => row.id);
  const participantRows = await tx.$queryRaw<DeletionParticipant[]>`
    SELECT id, season_id AS "seasonId", trading_account_id AS "tradingAccountId"
    FROM season_participants WHERE user_id = ${userId} ORDER BY id`;

  await tx.$queryRaw`
    SELECT id FROM quotes
    WHERE user_id = ${userId} OR trading_account_id = ANY(${accountIds})
    ORDER BY id FOR UPDATE`;

  const seasonIds = [...new Set(participantRows.map((p) => p.seasonId))].sort();
  const seasons = seasonIds.length
    ? await tx.$queryRaw<{ id: string; status: string }[]>`
        SELECT id, status::text AS status FROM seasons
        WHERE id = ANY(${seasonIds}) ORDER BY id FOR SHARE`
    : [];

  const lockedAccounts = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM trading_accounts WHERE user_id = ${userId}
    ORDER BY id FOR UPDATE`;
  const participants = await tx.$queryRaw<DeletionParticipant[]>`
    SELECT id, season_id AS "seasonId", trading_account_id AS "tradingAccountId"
    FROM season_participants WHERE user_id = ${userId}
    ORDER BY id FOR UPDATE`;
  if (
    !sameIds(
      lockedAccounts.map((row) => row.id),
      accountIds,
    ) ||
    !sameIds(
      participants.map((row) => row.id),
      participantRows.map((row) => row.id),
    )
  ) {
    throw new AccountDeletionScopeChanged();
  }

  await tx.$queryRaw`
    SELECT id FROM orders WHERE trading_account_id = ANY(${accountIds})
    ORDER BY id FOR UPDATE`;

  return {
    accountIds,
    participants,
    seasonStatus: new Map(seasons.map((season) => [season.id, season.status])),
  };
}

/**
 * Operator/admin accountability rows that point at this member. Self-service
 * deletion refuses such members (§3): deleting them would break RESTRICT
 * audit links or leave other members' moderation records pointing nowhere.
 */
export async function hasOperatorFootprint(
  tx: Pick<Tx, '$queryRaw'>,
  userId: string,
): Promise<boolean> {
  const [row] = await tx.$queryRaw<{ found: boolean }[]>`
    SELECT (
      EXISTS (SELECT 1 FROM operator_audit_logs WHERE actor_user_id = ${userId})
      OR EXISTS (SELECT 1 FROM inquiry_answers WHERE answered_by_user_id = ${userId})
      OR EXISTS (
        SELECT 1 FROM reward_fulfillment_requests
        WHERE requested_by_user_id = ${userId}
           OR processed_by_user_id = ${userId}
           OR canceled_by_user_id = ${userId})
      OR EXISTS (
        SELECT 1 FROM important_notices
        WHERE created_by_user_id = ${userId}
           OR published_by_user_id = ${userId}
           OR withdrawn_by_user_id = ${userId})
      OR EXISTS (
        SELECT 1 FROM market_session_overrides
        WHERE created_by_user_id = ${userId} OR updated_by_user_id = ${userId})
      OR EXISTS (SELECT 1 FROM fx_rate_snapshots WHERE approved_by_user_id = ${userId})
      OR EXISTS (
        SELECT 1 FROM season_participants
        WHERE excluded_by_user_id = ${userId}
           OR ranking_hidden_by_user_id = ${userId}
           OR result_corrected_by_user_id = ${userId})
    ) AS found`;
  return row?.found === true;
}

async function createPlaceholderMember(tx: Tx): Promise<string> {
  const id = randomUUID();
  for (let attempt = 0; attempt < 8; attempt++) {
    const suffix = randomBytes(3).toString('hex').toUpperCase();
    const nickname = `${ACCOUNT_DELETION_PLACEHOLDER_NICKNAME} ${suffix}`;
    const taken = await tx.user.findUnique({
      where: { nickname },
      select: { id: true },
    });
    if (taken) continue;
    await tx.user.create({
      data: {
        id,
        email: `ghost-${id}@${ACCOUNT_DELETION_PLACEHOLDER_EMAIL_DOMAIN}`,
        passwordHash: ACCOUNT_DELETION_PLACEHOLDER_PASSWORD_HASH,
        nickname,
        portfolioPublic: false,
        status: 'deleted',
        role: 'user',
      },
      select: { id: true },
    });
    return id;
  }
  throw new AccountDeletionScopeChanged();
}

/**
 * Settled seasons only (§5): a participation that holds a FINAL ranking row
 * is part of other members' confirmed result (their rank, the set size every
 * percentile/tier denominator and the integrity checks read). Its final
 * row(s) move to a fresh anonymous placeholder participation with a new
 * member, account and participant id — nothing links it to the deleted
 * member, and only the confirmed result columns are copied. Daily
 * (provisional) rows, rewards and every trading row are deleted with the
 * rest. Returns how many confirmed results were preserved.
 */
export async function preserveSettledFinalResults(
  tx: Tx,
  scope: DeletionScope,
): Promise<number> {
  let preserved = 0;
  for (const participant of scope.participants) {
    if (scope.seasonStatus.get(participant.seasonId) !== 'settled') continue;
    const finalRows = await tx.seasonRanking.count({
      where: { seasonParticipantId: participant.id, rankType: 'final' },
    });
    if (finalRows === 0) continue;
    const original = await tx.seasonParticipant.findUniqueOrThrow({
      where: { id: participant.id },
    });
    const account = await tx.tradingAccount.findUniqueOrThrow({
      where: { id: original.tradingAccountId },
      select: {
        status: true,
        initialCapitalKrw: true,
        openedAt: true,
        closedAt: true,
      },
    });
    const placeholderId = await createPlaceholderMember(tx);
    const placeholderAccount = await tx.tradingAccount.create({
      data: {
        userId: placeholderId,
        mode: 'season',
        status: account.status,
        initialCapitalKrw: account.initialCapitalKrw,
        openedAt: account.openedAt,
        closedAt: account.closedAt,
      },
      select: { id: true },
    });
    const placeholderParticipant = await tx.seasonParticipant.create({
      data: {
        seasonId: original.seasonId,
        userId: placeholderId,
        tradingAccountId: placeholderAccount.id,
        joinedAt: original.joinedAt,
        participantStatus: original.participantStatus,
        initialCapitalKrw: original.initialCapitalKrw,
        totalAssetKrw: original.totalAssetKrw,
        totalReturnRate: original.totalReturnRate,
        maxDrawdown: original.maxDrawdown,
        totalFillCount: original.totalFillCount,
        currentRank: original.currentRank,
        finalRank: original.finalRank,
        finalTier: original.finalTier,
        rewardGrantedAt: original.rewardGrantedAt,
        // Operator moderation of the result itself (visibility, a corrected
        // rank) is part of the confirmed set; exclusion can never coexist
        // with a final row.
        rankingHiddenAt: original.rankingHiddenAt,
        rankingHiddenReason: original.rankingHiddenReason,
        rankingHiddenByUserId: original.rankingHiddenByUserId,
        resultCorrectedAt: original.resultCorrectedAt,
        resultCorrectedReason: original.resultCorrectedReason,
        resultCorrectedByUserId: original.resultCorrectedByUserId,
        finalQualified: original.finalQualified,
        finalTradedInstrumentCount: original.finalTradedInstrumentCount,
        finalRecognizedTurnoverKrw: original.finalRecognizedTurnoverKrw,
      },
      select: { id: true },
    });
    await tx.seasonRanking.updateMany({
      where: { seasonParticipantId: participant.id, rankType: 'final' },
      data: {
        seasonParticipantId: placeholderParticipant.id,
        tradingAccountId: placeholderAccount.id,
      },
    });
    preserved++;
  }
  return preserved;
}

/**
 * Deletes every row owned by the member, children before parents, and
 * returns per-table counts (no ids). Shared market data (prices, candles,
 * evidence, FX snapshots, season final prices) is never touched.
 */
export async function purgeDeletionScope(
  tx: Tx,
  input: { userId: string; email: string; scope: DeletionScope },
): Promise<Record<string, number>> {
  const user = input.userId;
  const accounts = input.scope.accountIds;
  const participants = input.scope.participants.map((p) => p.id);
  const friendSourcePrefix = `friend:${user}:`;
  const steps: Array<[string, Prisma.Sql]> = [
    // Intents and plans reference orders, positions and executions.
    [
      'beginner_quest_acknowledgements',
      Prisma.sql`DELETE FROM beginner_quest_acknowledgements WHERE trading_account_id = ANY(${accounts})`,
    ],
    [
      'entry_tp_sl_plans',
      Prisma.sql`DELETE FROM entry_tp_sl_plans WHERE trading_account_id = ANY(${accounts})`,
    ],
    [
      'futures_tp_sl_settings',
      Prisma.sql`DELETE FROM futures_tp_sl_settings WHERE trading_account_id = ANY(${accounts})`,
    ],
    [
      'conditional_sell_orders',
      Prisma.sql`DELETE FROM conditional_sell_orders WHERE trading_account_id = ANY(${accounts})`,
    ],
    [
      'conditional_buy_orders',
      Prisma.sql`DELETE FROM conditional_buy_orders WHERE trading_account_id = ANY(${accounts})`,
    ],
    [
      'futures_conditional_entries',
      Prisma.sql`DELETE FROM futures_conditional_entries WHERE trading_account_id = ANY(${accounts})`,
    ],
    [
      'protection_children',
      Prisma.sql`DELETE FROM protection_children WHERE group_id IN (SELECT id FROM protection_groups WHERE trading_account_id = ANY(${accounts}))`,
    ],
    [
      'protection_legs',
      Prisma.sql`DELETE FROM protection_legs WHERE group_id IN (SELECT id FROM protection_groups WHERE trading_account_id = ANY(${accounts}))`,
    ],
    [
      'protection_groups',
      Prisma.sql`DELETE FROM protection_groups WHERE trading_account_id = ANY(${accounts})`,
    ],
    [
      'protection_commands',
      Prisma.sql`DELETE FROM protection_commands WHERE trading_account_id = ANY(${accounts})`,
    ],
    [
      'limit_on_close_orders',
      Prisma.sql`DELETE FROM limit_on_close_orders WHERE trading_account_id = ANY(${accounts})`,
    ],
    // Futures: requests and entries reference executions; executions,
    // liquidation and season closes reference positions.
    [
      'futures_execute_requests',
      Prisma.sql`DELETE FROM futures_execute_requests WHERE trading_account_id = ANY(${accounts})`,
    ],
    [
      'futures_limit_orders',
      Prisma.sql`DELETE FROM futures_limit_orders WHERE trading_account_id = ANY(${accounts})`,
    ],
    [
      'futures_liquidation_closes',
      Prisma.sql`DELETE FROM futures_liquidation_closes WHERE trading_account_id = ANY(${accounts})`,
    ],
    [
      'futures_liquidations',
      Prisma.sql`DELETE FROM futures_liquidations WHERE trading_account_id = ANY(${accounts})`,
    ],
    [
      'futures_season_closes',
      Prisma.sql`DELETE FROM futures_season_closes WHERE trading_account_id = ANY(${accounts})`,
    ],
    [
      'futures_season_settlements',
      Prisma.sql`DELETE FROM futures_season_settlements WHERE trading_account_id = ANY(${accounts})`,
    ],
    [
      'futures_executions',
      Prisma.sql`DELETE FROM futures_executions WHERE trading_account_id = ANY(${accounts})`,
    ],
    [
      'futures_positions',
      Prisma.sql`DELETE FROM futures_positions WHERE trading_account_id = ANY(${accounts})`,
    ],
    // Cash: composite commands, transfer routes and ledger reference wallets.
    [
      'wallet_transfer_execute_requests',
      Prisma.sql`DELETE FROM wallet_transfer_execute_requests WHERE trading_account_id = ANY(${accounts})`,
    ],
    [
      'wallet_transfer_quotes',
      Prisma.sql`DELETE FROM wallet_transfer_quotes WHERE quote_id IN (SELECT id FROM quotes WHERE user_id = ${user} OR trading_account_id = ANY(${accounts}))`,
    ],
    [
      'wallet_transfers',
      Prisma.sql`DELETE FROM wallet_transfers WHERE trading_account_id = ANY(${accounts})`,
    ],
    [
      'fx_execute_requests',
      Prisma.sql`DELETE FROM fx_execute_requests WHERE user_id = ${user} OR trading_account_id = ANY(${accounts})`,
    ],
    [
      // A reset references the ad claim it consumed (2026-10-20).
      'general_account_resets',
      Prisma.sql`DELETE FROM general_account_resets WHERE user_id = ${user} OR trading_account_id = ANY(${accounts})`,
    ],
    [
      'ad_reward_claims',
      Prisma.sql`DELETE FROM ad_reward_claims WHERE user_id = ${user} OR trading_account_id = ANY(${accounts})`,
    ],
    [
      'wallet_transactions',
      Prisma.sql`DELETE FROM wallet_transactions WHERE trading_account_id = ANY(${accounts})`,
    ],
    [
      'exchange_transactions',
      Prisma.sql`DELETE FROM exchange_transactions WHERE trading_account_id = ANY(${accounts})`,
    ],
    [
      'orders',
      Prisma.sql`DELETE FROM orders WHERE trading_account_id = ANY(${accounts})`,
    ],
    [
      'quotes',
      Prisma.sql`DELETE FROM quotes WHERE user_id = ${user} OR trading_account_id = ANY(${accounts})`,
    ],
    [
      'positions',
      Prisma.sql`DELETE FROM positions WHERE trading_account_id = ANY(${accounts})`,
    ],
    [
      'cash_wallets',
      Prisma.sql`DELETE FROM cash_wallets WHERE trading_account_id = ANY(${accounts})`,
    ],
    [
      'equity_snapshots',
      Prisma.sql`DELETE FROM equity_snapshots WHERE trading_account_id = ANY(${accounts})`,
    ],
    [
      'daily_portfolio_snapshots',
      Prisma.sql`DELETE FROM daily_portfolio_snapshots WHERE trading_account_id = ANY(${accounts})`,
    ],
    // Season state. Preserved final rows already point at a placeholder.
    [
      'season_rankings',
      Prisma.sql`DELETE FROM season_rankings WHERE season_participant_id = ANY(${participants}) OR trading_account_id = ANY(${accounts})`,
    ],
    [
      'reward_fulfillment_requests',
      Prisma.sql`DELETE FROM reward_fulfillment_requests WHERE user_id = ${user} OR season_participant_id = ANY(${participants})`,
    ],
    [
      'season_rewards',
      Prisma.sql`DELETE FROM season_rewards WHERE user_id = ${user} OR season_participant_id = ANY(${participants})`,
    ],
    [
      'season_participants',
      Prisma.sql`DELETE FROM season_participants WHERE user_id = ${user}`,
    ],
    [
      'trading_accounts',
      Prisma.sql`DELETE FROM trading_accounts WHERE user_id = ${user}`,
    ],
    // Member and social data.
    [
      'user_badges',
      Prisma.sql`DELETE FROM user_badges WHERE user_id = ${user}`,
    ],
    // Other members' friend-request pushes carry this member's nickname
    // and id (source_key friend:<requester>:<friendship>).
    [
      'push_notifications',
      Prisma.sql`DELETE FROM push_notifications WHERE user_id = ${user} OR trading_account_id = ANY(${accounts}) OR (type = 'friend_request' AND starts_with(source_key, ${friendSourcePrefix}))`,
    ],
    [
      'friendships',
      Prisma.sql`DELETE FROM friendships WHERE low_user_id = ${user} OR high_user_id = ${user}`,
    ],
    [
      'inquiry_answers',
      Prisma.sql`DELETE FROM inquiry_answers WHERE inquiry_id IN (SELECT id FROM inquiries WHERE user_id = ${user})`,
    ],
    ['inquiries', Prisma.sql`DELETE FROM inquiries WHERE user_id = ${user}`],
    [
      'push_devices',
      Prisma.sql`DELETE FROM push_devices WHERE user_id = ${user}`,
    ],
    [
      'notification_preferences',
      Prisma.sql`DELETE FROM notification_preferences WHERE user_id = ${user}`,
    ],
    [
      'refresh_token_sessions',
      Prisma.sql`DELETE FROM refresh_token_sessions WHERE user_id = ${user}`,
    ],
    [
      'email_auth_challenges',
      Prisma.sql`DELETE FROM email_auth_challenges WHERE email = ${input.email} OR target_user_id = ${user}`,
    ],
    // Last: RESTRICT keys prove nothing above was missed.
    ['users', Prisma.sql`DELETE FROM users WHERE id = ${user}`],
  ];
  const counts: Record<string, number> = {};
  for (const [table, statement] of steps) {
    counts[table] = await tx.$executeRaw(statement);
  }
  return counts;
}
