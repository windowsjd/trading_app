/** Small, service-level PostgreSQL probe; never targets an application server. */
import {
  practiceFoundation,
  practiceMarkets,
  practiceOrder,
  practiceServices,
} from './lib/beginner-quest-practice';
import {
  db,
  fixture,
  cleanup,
  fxEvidence,
  fxEvidenceIds,
  spotPrice,
  type Scenario,
} from './futures-integration';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { HttpException } from '@nestjs/common';
import { assertBeginnerLearningAccess } from '../src/trading-accounts/beginner-learning-policy';

const target = new URL(process.env.DATABASE_URL ?? 'http://invalid');
if (
  process.env.NODE_ENV !== 'test' ||
  process.env.BEGINNER_PERMISSION_PROFILE !== '1' ||
  !['localhost', '127.0.0.1'].includes(target.hostname) ||
  !target.pathname.endsWith('_test')
)
  throw new Error('Disposable local test database opt-in required');

process.env.LIMIT_ORDER_ENABLED = 'true';
process.env.CONDITIONAL_ORDERS_ENABLED = 'true';
process.env.LEGACY_OCO_REGISTRATION_ENABLED = 'true';
const samples = 20;
const app = practiceServices(db);

async function locked(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    assert.equal(error.getStatus(), 403);
    assert.equal(
      (error.getResponse() as { error: { code: string } }).error.code,
      'BEGINNER_FEATURE_LOCKED',
    );
    return;
  }
  assert.fail('Expected BEGINNER_FEATURE_LOCKED');
}

/** Server statement totals, including transaction SQL; exclude the sampler. */
async function sqlTotals() {
  const [row] = await db.$queryRaw<Array<{ calls: bigint; evidence: bigint }>>`
    SELECT COALESCE(sum(calls), 0)::bigint AS calls,
      COALESCE(sum(calls) FILTER (WHERE query ~
        '(exchange_transactions|wallet_transfers|wallet_transactions|beginner_quest_acknowledgements|protection_groups|conditional_sell_orders|futures_executions)'), 0)::bigint AS evidence
    FROM pg_stat_statements
    WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
      AND query NOT LIKE '%pg_stat_statements%'`;
  return row;
}

async function measure(
  name: string,
  work: () => Promise<unknown>,
  concurrency = 1,
) {
  const before = await sqlTotals();
  const elapsed: number[] = [];
  for (let start = 0; start < samples; start += concurrency) {
    await Promise.all(
      Array.from(
        { length: Math.min(concurrency, samples - start) },
        async () => {
          const at = performance.now();
          await work();
          elapsed.push(performance.now() - at);
        },
      ),
    );
  }
  const after = await sqlTotals();
  elapsed.sort((a, b) => a - b);
  return {
    name,
    samples,
    concurrency,
    p50Ms: +elapsed[Math.ceil(samples * 0.5) - 1].toFixed(2),
    p95Ms: +elapsed[Math.ceil(samples * 0.95) - 1].toFixed(2),
    maxMs: +elapsed[samples - 1].toFixed(2),
    sqlPerRequest: Number(after.calls - before.calls) / samples,
    evidenceSqlPerRequest: Number(after.evidence - before.evidence) / samples,
  };
}

/** Exact financial and quest state before/after refused or read-only work. */
async function fingerprint(accountId: string) {
  const where = { tradingAccountId: accountId };
  const state = await Promise.all([
    db.cashWallet.findMany({ where, orderBy: { id: 'asc' } }),
    db.position.findMany({ where, orderBy: { id: 'asc' } }),
    db.order.findMany({ where, orderBy: { id: 'asc' } }),
    db.walletTransaction.findMany({ where, orderBy: { id: 'asc' } }),
    db.futuresPosition.findMany({ where, orderBy: { id: 'asc' } }),
    db.beginnerQuestAcknowledgement.findMany({
      where,
      orderBy: { stepId: 'asc' },
    }),
    db.quote.count({ where }),
    db.futuresExecuteRequest.count({ where }),
  ]);
  return createHash('sha256').update(JSON.stringify(state)).digest('hex');
}

async function profile(s: Scenario, stage: 'foundation' | 'complete') {
  const account = { id: s.accountId, mode: 'beginner' };
  const before = await fingerprint(s.accountId);
  const progress = await app.quests.getQuestProgress(s.userId, s.accountId);
  assert.equal(
    progress.data.learningPermissions.allTrading,
    stage === 'complete',
  );
  const read = async () => {
    const p = await app.quests.getQuestProgress(s.userId, s.accountId);
    assert.deepEqual(
      p.data.learningPermissions,
      progress.data.learningPermissions,
    );
  };
  const results = [
    await measure(`${stage}:questProgress`, read),
    await measure(`${stage}:questProgress`, read, 4),
    await measure(`${stage}:policyAllowed`, () =>
      assertBeginnerLearningAccess(db, account, 'krStockMarketBuy'),
    ),
    await measure(
      `${stage}:policyAllTrading`,
      () => {
        const request = assertBeginnerLearningAccess(db, account, 'allTrading');
        return stage === 'complete' ? request : locked(request);
      },
      4,
    ),
  ];
  if (stage === 'foundation') {
    results.push(
      await measure(
        'foundation:refusedMarketBuy',
        () =>
          locked(
            practiceOrder(app, s.userId, s.accountId, {
              assetId: s.instruments[0].asset.id,
              side: 'buy',
              orderType: 'market',
              amount: '2',
            }),
          ),
        4,
      ),
    );
  }
  assert.equal(
    await fingerprint(s.accountId),
    before,
    'reads, checks and concurrent refusals must leave all financial/quest rows unchanged',
  );
  return results;
}

async function main() {
  await db.$connect();
  // Fail before fixtures if the test cluster has no statement instrumentation.
  await sqlTotals();
  const s = await fixture('beginner', '10000', true);
  const general = await fixture('general');
  const results: Awaited<ReturnType<typeof measure>>[] = [];
  try {
    const fresh = async () => {
      await fxEvidence();
      await spotPrice(s, '100', 0, 2000);
      await spotPrice(general, '100', 0, 2000);
    };
    await fresh();
    await practiceFoundation(
      db,
      s.userId,
      s.accountId,
      s.instruments[0].asset.id,
      async () => {
        await fresh();
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
    );
    results.push(...(await profile(s, 'foundation')));
    await fresh();
    await practiceMarkets(db, s.userId, s.accountId);
    results.push(...(await profile(s, 'complete')));
    results.push(
      await measure(
        'general:policyAllTrading',
        () =>
          assertBeginnerLearningAccess(
            db,
            { id: general.accountId, mode: 'general' },
            'allTrading',
          ),
        4,
      ),
    );
    for (const [name, scenario] of [
      ['general', general],
      ['complete', s],
    ] as const) {
      await fresh();
      const before = await db.order.count({
        where: { tradingAccountId: scenario.accountId },
      });
      results.push(
        await measure(
          `${name}:marketBuyQuoteAndExecute`,
          () =>
            practiceOrder(app, scenario.userId, scenario.accountId, {
              assetId: scenario.instruments[0].asset.id,
              side: 'buy',
              orderType: 'market',
              amount: '2',
            }),
          4,
        ),
      );
      assert.equal(
        await db.order.count({
          where: { tradingAccountId: scenario.accountId },
        }),
        before + samples,
      );
    }
    const report = {
      samples,
      maxConcurrency: 4,
      scope: 'local service calls, not HTTP or production capacity',
      results,
    };
    if (process.env.BEGINNER_PROFILE_OUTPUT)
      writeFileSync(
        process.env.BEGINNER_PROFILE_OUTPUT,
        JSON.stringify(report, null, 2),
      );
    console.log(JSON.stringify(report, null, 2));
  } finally {
    for (const scenario of [s, general]) {
      const where = { tradingAccountId: scenario.accountId };
      await db.beginnerQuestAcknowledgement.deleteMany({ where });
      await db.protectionChild.deleteMany({ where: { group: where } });
      await db.protectionLeg.deleteMany({ where: { group: where } });
      await db.protectionGroup.deleteMany({ where });
      await db.protectionCommand.deleteMany({ where });
      await db.walletTransaction.deleteMany({ where });
      await db.order.deleteMany({ where });
      await db.position.deleteMany({ where });
      await db.dailyPortfolioSnapshot.deleteMany({ where });
      await cleanup(scenario);
    }
    await db.fxRateSnapshot.deleteMany({
      where: { id: { in: fxEvidenceIds } },
    });
  }
}
main()
  .then(() => console.log('beginner permission profile passed'))
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
