import { createHash } from 'node:crypto';
import { Prisma } from '../generated/prisma/client';
import {
  requireLaunchSeason,
  restoreDevelopmentSeason,
} from './launch-season.operations';

type Tx = Prisma.TransactionClient;
const q = (name: string) => {
  if (!/^[a-z_][a-z0-9_]*$/.test(name))
    throw /* @diagnosticSurface internal: Operator-only cleanup precondition; CLI aborts the transaction and retains its reviewed plan. */ new Error(
      'Unexpected catalog identifier.',
    );
  return Prisma.raw(`"${name}"`);
};
type Scope = { seasonId: string; accounts: string[]; participants: string[] };
type Step = {
  table: string;
  where: (scope: Scope, alias: string) => Prisma.Sql;
};
const column = (alias: string, name: string) =>
  Prisma.sql`${q(alias)}.${q(name)}`;
const account = (table: string): Step => ({
  table,
  where: (s, a) =>
    Prisma.sql`${column(a, 'trading_account_id')} = ANY(${s.accounts}::text[])`,
});
const season = (table: string): Step => ({
  table,
  where: (s, a) => Prisma.sql`${column(a, 'season_id')} = ${s.seasonId}`,
});
const notification = (s: Scope, a: string) =>
  Prisma.sql`(${column(a, 'trading_account_id')} = ANY(${s.accounts}::text[]) OR ${column(a, 'data')}->>'accountId' = ANY(${s.accounts}::text[]) OR ${column(a, 'data')}->>'seasonId' = ${s.seasonId})`;

/** Explicit children-first list, derived from the current schema and account-deletion contract.
 * No user filter, date cutoff, TRUNCATE, generic cascade or shared evidence deletion. */
export const LAUNCH_TEST_CLEANUP_STEPS: Step[] = [
  ...[
    'beginner_quest_acknowledgements',
    'entry_tp_sl_plans',
    'futures_tp_sl_settings',
    'conditional_sell_orders',
    'conditional_buy_orders',
    'futures_conditional_entries',
  ].map(account),
  ...['protection_children', 'protection_legs'].map(
    (table): Step => ({
      table,
      where: (s, a) =>
        Prisma.sql`${column(a, 'group_id')} IN (SELECT id FROM protection_groups WHERE trading_account_id = ANY(${s.accounts}::text[]))`,
    }),
  ),
  ...[
    'protection_groups',
    'protection_commands',
    'limit_on_close_orders',
    'futures_execute_requests',
    'futures_limit_orders',
    'futures_liquidation_closes',
    'futures_liquidations',
    'futures_season_closes',
    'futures_season_settlements',
    'futures_executions',
    'futures_positions',
    'wallet_transfer_execute_requests',
  ].map(account),
  {
    table: 'wallet_transfer_quotes',
    where: (s, a) =>
      Prisma.sql`${column(a, 'quote_id')} IN (SELECT id FROM quotes WHERE trading_account_id = ANY(${s.accounts}::text[]))`,
  },
  ...[
    'wallet_transfers',
    'fx_execute_requests',
    'general_account_resets',
    'ad_reward_claims',
    'wallet_transactions',
    'exchange_transactions',
    'orders',
    'quotes',
    'positions',
    'cash_wallets',
    'equity_snapshots',
    'daily_portfolio_snapshots',
  ].map(account),
  ...[
    'season_rankings',
    'season_rewards',
    'reward_fulfillment_requests',
    'user_badges',
  ].map(season),
  {
    table: 'push_deliveries',
    where: (s, a) =>
      Prisma.sql`${column(a, 'notification_id')} IN (SELECT n.id FROM push_notifications n WHERE ${notification(s, 'n')})`,
  },
  { table: 'push_notifications', where: notification },
  {
    table: 'batch_job_runs',
    where: (s, a) =>
      Prisma.sql`${column(a, 'request_payload_json')}->>'seasonId' = ${s.seasonId}`,
  },
  season('futures_season_prices'),
  season('season_participants'),
  {
    table: 'trading_accounts',
    where: (s, a) =>
      Prisma.sql`${column(a, 'id')} = ANY(${s.accounts}::text[])`,
  },
  {
    table: 'seasons',
    where: (s, a) => Prisma.sql`${column(a, 'id')} = ${s.seasonId}`,
  },
];

export async function lockLaunchTestCleanupQuotes(tx: Tx, seasonId: string) {
  await tx.$queryRaw`SELECT id FROM quotes WHERE trading_account_id IN
    (SELECT trading_account_id FROM season_participants WHERE season_id = ${seasonId}) ORDER BY id FOR UPDATE`;
}

export async function lockLaunchTestCleanupAccounts(tx: Tx, seasonId: string) {
  await tx.$queryRaw`SELECT a.id FROM trading_accounts a JOIN season_participants p ON p.trading_account_id = a.id
    WHERE p.season_id = ${seasonId} ORDER BY a.id FOR UPDATE OF a`;
  await tx.$queryRaw`SELECT id FROM season_participants WHERE season_id = ${seasonId} ORDER BY id FOR UPDATE`;
  // Outbox has JSON/account references without financial FKs. Workers must be
  // stopped first; these locks close the final DB insertion race.
  await tx.$executeRaw`LOCK TABLE push_notifications, push_deliveries IN SHARE ROW EXCLUSIVE MODE`;
}

export async function planLaunchTestCleanup(
  tx: Tx,
  seasonId: string,
  now: Date,
) {
  const target = await requireLaunchSeason(tx, seasonId);
  if (
    target.launchKind !== 'test' ||
    !target.launchActivatedAt ||
    !target.suspendedAt ||
    target.launchArmed
  )
    throw /* @diagnosticSurface internal: Operator-only cleanup precondition; CLI aborts the transaction and retains its reviewed plan. */ new Error(
      'Only a stopped, activated test season can be cleaned.',
    );
  const participants = await tx.seasonParticipant.findMany({
    where: { seasonId },
    include: { tradingAccount: true },
    orderBy: { id: 'asc' },
  });
  for (const p of participants) {
    if (
      !target.launchTestUserIds.includes(p.userId) ||
      p.tradingAccount.mode !== 'season' ||
      p.tradingAccount.userId !== p.userId
    )
      throw /* @diagnosticSurface internal: Operator-only cleanup precondition; CLI aborts the transaction and retains its reviewed plan. */ new Error(
        'Participant/account scope disagrees with the test allowlist.',
      );
  }
  const scope: Scope = {
    seasonId,
    accounts: participants.map((p) => p.tradingAccountId).sort(),
    participants: participants.map((p) => p.id).sort(),
  };
  const [locks] = await tx.$queryRaw<
    { count: bigint }[]
  >`SELECT count(*) AS count FROM ops_job_locks
    WHERE released_at IS NULL AND expires_at > clock_timestamp() `;
  if (Number(locks.count))
    throw /* @diagnosticSurface internal: Operator-only cleanup precondition; CLI aborts the transaction and retains its reviewed plan. */ new Error(
      'A financial/push worker still holds an Ops lease. Stop and drain workers before cleanup.',
    );
  const [notificationConflicts] = await tx.$queryRaw<
    { count: bigint }[]
  >`SELECT count(*) AS count
    FROM push_notifications n WHERE ${notification(scope, 'n')} AND (
      (n.trading_account_id IS NOT NULL AND NOT (n.trading_account_id = ANY(${scope.accounts}::text[])))
      OR (n.data->>'accountId' IS NOT NULL AND NOT (n.data->>'accountId' = ANY(${scope.accounts}::text[])))
      OR (n.data->>'seasonId' IS NOT NULL AND n.data->>'seasonId' <> ${seasonId})
      OR NOT (n.user_id = ANY(${target.launchTestUserIds}::text[])))`;
  if (Number(notificationConflicts.count))
    throw /* @diagnosticSurface internal: Operator-only cleanup precondition; CLI aborts the transaction and retains its reviewed plan. */ new Error(
      'Notification scope crosses the target season; cleanup is blocked.',
    );
  const [effects] = await tx.$queryRaw<{ count: bigint }[]>`SELECT (
    (SELECT count(*) FROM push_notifications n WHERE ${notification(scope, 'n')} AND (sent_at IS NOT NULL OR claimed_until IS NOT NULL OR status::text IN ('sending','sent')))
    + (SELECT count(*) FROM push_deliveries d JOIN push_notifications n ON n.id=d.notification_id WHERE ${notification(scope, 'n')})
    + (SELECT count(*) FROM reward_fulfillment_requests WHERE season_id=${seasonId} AND (status::text IN ('processing','fulfilled') OR processing_started_at IS NOT NULL OR fulfilled_at IS NOT NULL))
    + (SELECT count(*) FROM batch_job_runs WHERE request_payload_json->>'seasonId'=${seasonId} AND status::text IN ('pending','running'))
  ) AS count`;
  if (Number(effects.count))
    throw /* @diagnosticSurface internal: Operator-only cleanup precondition; CLI aborts the transaction and retains its reviewed plan. */ new Error(
      'External delivery, claimed notification, or unfinished work requires investigation; cleanup is blocked.',
    );
  // Validates ownership/configuration and ability to restore without writing.
  await restoreDevelopmentSeason(tx, seasonId, now, false);

  const foreignRewardLinks =
    (await tx.seasonReward.count({
      where: {
        seasonId,
        fulfillmentRequest: { is: { seasonId: { not: seasonId } } },
      },
    })) +
    (await tx.rewardFulfillmentRequest.count({
      where: {
        seasonId,
        seasonReward: { is: { seasonId: { not: seasonId } } },
      },
    }));
  if (foreignRewardLinks)
    throw /* @diagnosticSurface internal: Cleanup cannot detach another season's reward links. */ new Error(
      'Reward links cross the test season; cleanup is blocked.',
    );
  const detachedRewardLinks = {
    rewards: await tx.seasonReward.count({
      where: { seasonId, fulfillmentRequestId: { not: null } },
    }),
    requests: await tx.rewardFulfillmentRequest.count({
      where: { seasonId, seasonRewardId: { not: null } },
    }),
  };

  const tables: Record<string, { count: number; digest: string }> = {};
  for (const step of LAUNCH_TEST_CLEANUP_STEPS) {
    const [size] = await tx.$queryRaw<{ count: bigint }[]>(
      Prisma.sql`SELECT count(*) AS count FROM ${q(step.table)} t WHERE ${step.where(scope, 't')}`,
    );
    if (Number(size.count) > 10000)
      throw /* @diagnosticSurface internal: Operator-only cleanup precondition; CLI aborts the transaction and retains its reviewed plan. */ new Error(
        `Test cleanup is intentionally bounded: ${step.table} exceeds 10000 rows.`,
      );
    const [row] = await tx.$queryRaw<
      { count: bigint; digest: string }[]
    >(Prisma.sql`
      SELECT count(*) AS count, md5(coalesce(string_agg(row_to_json(t)::text, '|' ORDER BY row_to_json(t)::text), '')) AS digest
      FROM ${q(step.table)} t WHERE ${step.where(scope, 't')}`);
    if (Number(row.count) > 10000)
      throw /* @diagnosticSurface internal: Operator-only cleanup precondition; CLI aborts the transaction and retains its reviewed plan. */ new Error(
        `Test cleanup is intentionally bounded: ${step.table} exceeds 10000 rows.`,
      );
    tables[step.table] = { count: Number(row.count), digest: row.digest };
  }
  // Forbidden even if corruption placed one in a season account.
  if (
    tables.general_account_resets.count ||
    tables.ad_reward_claims.count ||
    tables.beginner_quest_acknowledgements.count
  )
    throw /* @diagnosticSurface internal: Operator-only cleanup precondition; CLI aborts the transaction and retains its reviewed plan. */ new Error(
      'General/beginner data found in a test season; refuse deletion.',
    );

  const fks = await tx.$queryRaw<
    Array<{
      name: string;
      child: string;
      parent: string;
      deleteAction: string;
      childColumns: string[];
      parentColumns: string[];
    }>
  >`
    SELECT c.conname AS name, ch.relname AS child, pa.relname AS parent, c.confdeltype::text AS "deleteAction",
      array_agg(ca.attname::text ORDER BY k.ord) AS "childColumns", array_agg(aa.attname::text ORDER BY k.ord) AS "parentColumns"
    FROM pg_constraint c JOIN pg_class ch ON ch.oid=c.conrelid JOIN pg_namespace ns ON ns.oid=ch.relnamespace
    JOIN pg_class pa ON pa.oid=c.confrelid JOIN pg_namespace ps ON ps.oid=pa.relnamespace
    CROSS JOIN LATERAL unnest(c.conkey,c.confkey) WITH ORDINALITY AS k(ci,pi,ord)
    JOIN pg_attribute ca ON ca.attrelid=ch.oid AND ca.attnum=k.ci
    JOIN pg_attribute aa ON aa.attrelid=pa.oid AND aa.attnum=k.pi
    WHERE c.contype='f' AND ns.nspname='public' AND ps.nspname='public' AND pa.relname = ANY(${LAUNCH_TEST_CLEANUP_STEPS.map((s) => s.table)}::text[])
    GROUP BY c.conname,ch.relname,pa.relname,c.confdeltype ORDER BY c.conname`;
  for (const fk of fks) {
    const parent = LAUNCH_TEST_CLEANUP_STEPS.find(
      (s) => s.table === fk.parent,
    )!;
    const child = LAUNCH_TEST_CLEANUP_STEPS.find((s) => s.table === fk.child);
    // The two nullable reward pointers form the only current FK cycle.
    // Both are explicitly detached inside the approved target transaction.
    const rewardCycle =
      fk.deleteAction === 'n' &&
      ((fk.name === 'season_rewards_fulfillment_request_id_fkey' &&
        fk.child === 'season_rewards' &&
        fk.parent === 'reward_fulfillment_requests') ||
        (fk.name === 'reward_fulfillment_requests_season_reward_id_fkey' &&
          fk.child === 'reward_fulfillment_requests' &&
          fk.parent === 'season_rewards'));
    if (
      !rewardCycle &&
      child &&
      child.table !== parent.table &&
      LAUNCH_TEST_CLEANUP_STEPS.indexOf(child) >
        LAUNCH_TEST_CLEANUP_STEPS.indexOf(parent)
    ) {
      throw /* @diagnosticSurface internal: Cleanup refuses catalog drift before deleting or relying on FK side effects. */ new Error(
        `Cleanup order conflicts with ${fk.name}; review the schema before applying.`,
      );
    }
    const joins = fk.childColumns.map(
      (col, i) =>
        Prisma.sql`${column('c', col)} = ${column('p', fk.parentColumns[i])}`,
    );
    const [outside] = await tx.$queryRaw<{ count: bigint }[]>(Prisma.sql`
      SELECT count(*) AS count FROM ${q(fk.child)} c JOIN ${q(fk.parent)} p ON ${Prisma.join(joins, ' AND ')}
      WHERE ${parent.where(scope, 'p')} AND NOT coalesce((${child ? child.where(scope, 'c') : Prisma.sql`false`}), false)`);
    if (Number(outside.count))
      throw /* @diagnosticSurface internal: Operator-only cleanup precondition; CLI aborts the transaction and retains its reviewed plan. */ new Error(
        `Out-of-scope reference ${fk.name}; cleanup is blocked.`,
      );
  }
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ scope, tables, detachedRewardLinks, fks }))
    .digest('hex');
  return {
    scope,
    tables,
    detachedRewardLinks,
    fingerprint,
    retained: [
      'users',
      'shared market/FX/candle evidence',
      'shared Ops runs and operator audit history',
    ],
  };
}

export async function applyLaunchTestCleanup(
  tx: Tx,
  plan: Awaited<ReturnType<typeof planLaunchTestCleanup>>,
  now: Date,
) {
  // Restore uses the stopped test's ownership token, then the test is removed
  // in this same transaction. A later FK/count failure rolls restoration back too.
  await restoreDevelopmentSeason(tx, plan.scope.seasonId, now);
  const seasonId = plan.scope.seasonId;
  const detachedRewardLinks = {
    rewards:
      await tx.$executeRaw`UPDATE season_rewards SET fulfillment_request_id = NULL WHERE season_id = ${seasonId} AND fulfillment_request_id IS NOT NULL`,
    requests:
      await tx.$executeRaw`UPDATE reward_fulfillment_requests SET season_reward_id = NULL WHERE season_id = ${seasonId} AND season_reward_id IS NOT NULL`,
  };
  if (
    detachedRewardLinks.rewards !== plan.detachedRewardLinks.rewards ||
    detachedRewardLinks.requests !== plan.detachedRewardLinks.requests
  ) {
    throw /* @diagnosticSurface internal: Any changed reward cycle rolls the cleanup transaction back. */ new Error(
      'Reward link count changed; transaction rolled back.',
    );
  }
  const deleted: Record<string, number> = {};
  for (const step of LAUNCH_TEST_CLEANUP_STEPS) {
    const count = await tx.$executeRaw(
      Prisma.sql`DELETE FROM ${q(step.table)} t WHERE ${step.where(plan.scope, 't')}`,
    );
    if (count !== plan.tables[step.table].count)
      throw /* @diagnosticSurface internal: Operator-only cleanup precondition; CLI aborts the transaction and retains its reviewed plan. */ new Error(
        `Delete count changed for ${step.table}; transaction rolled back.`,
      );
    deleted[step.table] = count;
  }
  // Direct account/season predicates remain meaningful after parent deletion.
  for (const step of LAUNCH_TEST_CLEANUP_STEPS.filter(
    (s) =>
      ![
        'wallet_transfer_quotes',
        'protection_children',
        'protection_legs',
        'push_deliveries',
      ].includes(s.table),
  )) {
    const [left] = await tx.$queryRaw<{ count: bigint }[]>(
      Prisma.sql`SELECT count(*) AS count FROM ${q(step.table)} t WHERE ${step.where(plan.scope, 't')}`,
    );
    if (Number(left.count))
      throw /* @diagnosticSurface internal: Operator-only cleanup precondition; CLI aborts the transaction and retains its reviewed plan. */ new Error(
        `Residual test data in ${step.table}; transaction rolled back.`,
      );
  }
  return { deleted, detachedRewardLinks };
}
