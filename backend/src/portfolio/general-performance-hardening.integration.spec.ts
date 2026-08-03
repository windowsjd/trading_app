import { spawnSync } from 'node:child_process';

/**
 * Opt-in PostgreSQL integration tests for 작업 6·7 보완.
 *
 * None of what is checked here can be established with mocks: before/after
 * ordering under real UUID generation and real transaction timestamps, the
 * ledger-vs-snapshot continuity invariant, every ad-reward replay path
 * (including two genuine unique-constraint races), and the general daily
 * snapshot job's per-account atomicity, idempotency, and concurrent-run
 * behaviour.
 *
 * Runs only with TRADING_ACCOUNT_DB_INTEGRATION=1 against the migrated dev DB
 * (prepare = `prisma migrate deploy` only; never reset/drop/seed).
 */
const RUN_DB_INTEGRATION = process.env.TRADING_ACCOUNT_DB_INTEGRATION === '1';
const itDbIntegration = RUN_DB_INTEGRATION ? it : it.skip;

describe('General performance + ad replay hardening DB integration', () => {
  itDbIntegration(
    'verifies boundary ordering, funding continuity, replay integrity, and the general daily snapshot job against PostgreSQL',
    () => {
      runDbIntegrationPrepare();

      const result = spawnSync(getPnpmCommand(), ['tsx', '-e', RUNNER], {
        cwd: process.cwd(),
        env: process.env,
        encoding: 'utf8',
        timeout: 300_000,
      });

      if (result.status !== 0) {
        throw new Error(
          [
            'General performance hardening DB integration runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }

      expect(result.stdout).toContain('general performance hardening ok');
    },
    320_000,
  );
});

function getPnpmCommand() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function runDbIntegrationPrepare() {
  const result = spawnSync(
    getPnpmCommand(),
    ['run', '--silent', 'test:db:prepare'],
    {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
      timeout: 60_000,
    },
  );

  if (result.status !== 0) {
    throw new Error(
      [
        'General performance hardening DB integration prepare failed.',
        'The opt-in test applies existing Prisma migrations with `prisma migrate deploy` only; it does not reset, drop, or seed the database.',
        'stdout:',
        result.stdout,
        'stderr:',
        result.stderr,
      ].join('\n'),
    );
  }
}

const RUNNER = `
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { PrismaService } from './src/prisma/prisma.service';
import { GeneralAccountsService } from './src/trading-accounts/general-accounts.service';
import { TradingAccountAccessService } from './src/trading-accounts/trading-account-access.service';
import { AdRewardService } from './src/ad-rewards/ad-reward.service';
import { AdRewardVerificationRegistry } from './src/ad-rewards/ad-reward-verifier';
import { PortfolioValuationService } from './src/portfolio/portfolio-valuation.service';
import { GeneralExternalFundingService } from './src/portfolio/general-external-funding.service';
import { GeneralAccountPerformanceService } from './src/portfolio/general-account-performance.service';
import { TradingAccountPortfolioService } from './src/portfolio/trading-account-portfolio.service';
import { BatchService } from './src/batch/batch.service';
import { GeneralDailySnapshotJobService } from './src/batch/general-daily-snapshot-job.service';

const prisma = new PrismaService();
const access = new TradingAccountAccessService(prisma);
const valuation = new PortfolioValuationService(prisma);
const externalFunding = new GeneralExternalFundingService(prisma);
const performance = new GeneralAccountPerformanceService(
  prisma,
  valuation,
  externalFunding,
);
const generalAccounts = new GeneralAccountsService(prisma, performance);
const portfolio = new TradingAccountPortfolioService(
  prisma,
  access,
  performance,
  valuation,
);
const batch = new BatchService(prisma);
const dailyJob = new GeneralDailySnapshotJobService(batch, prisma, performance);

const REWARD = '50000.00000000';
const RUN_TAG = randomUUID();
const createdUserIds = [];
const createdJobKeys = [];

// Fixed UUIDs so the before/after regression is deterministic in BOTH id
// directions instead of depending on what randomUUID() happens to produce.
// Each scenario takes its own two-hex-digit tag so the ids stay globally
// unique while their relative order stays fixed: low < high, always.
function fixedIds(tag) {
  // Unique per RUN as well as per scenario, so a run that dies before cleanup
  // cannot poison the next one — while the low/high order stays fixed, which
  // is the only property the regression actually depends on.
  const suffix = (tag + RUN_TAG.replace(/-/g, '')).slice(0, 12);
  return {
    low: '00000000-0000-4000-8000-' + suffix,
    high: 'ffffffff-ffff-4fff-bfff-' + suffix,
  };
}

function errorCode(error) {
  assert.ok(error instanceof HttpException, 'expected HttpException, got ' + String(error));
  return error.getResponse().error.code;
}

async function expectCode(promise, code) {
  try {
    await promise;
  } catch (error) {
    assert.equal(errorCode(error), code);
    return error;
  }
  throw new Error('expected rejection with ' + code);
}

async function createUser() {
  const id = randomUUID();
  await prisma.user.create({
    data: {
      id,
      email: 'perf-hardening-' + id + '@example.com',
      passwordHash: 'x',
      nickname: 'perf-hardening-' + id,
    },
  });
  createdUserIds.push(id);
  return id;
}

function fakeVerifier(provider) {
  return {
    provider,
    async verify(request) {
      return {
        ok: true,
        provider,
        providerEventId: request.proof,
        occurredAt: new Date(),
        metadata: { source: 'fake' },
      };
    },
  };
}

function adRewardService(providers) {
  return new AdRewardService(
    prisma,
    access,
    new AdRewardVerificationRegistry(providers ?? [fakeVerifier('test-provider')]),
    performance,
  );
}

function claimBody(proof, overrides) {
  return Object.assign(
    { provider: 'test-provider', proof, idempotencyKey: 'key-' + randomUUID() },
    overrides || {},
  );
}

function enableAdRewards(overrides) {
  const config = Object.assign(
    {
      AD_REWARD_ENABLED: 'true',
      AD_REWARD_PROVIDER: 'test-provider',
      AD_REWARD_AMOUNT_KRW: REWARD,
      AD_REWARD_DAILY_MAX_COUNT: '10',
      AD_REWARD_DAILY_MAX_AMOUNT_KRW: '1000000',
      AD_REWARD_COOLDOWN_SECONDS: '0',
      AD_REWARD_DAY_TIME_ZONE: 'UTC',
    },
    overrides || {},
  );
  for (const key of Object.keys(config)) process.env[key] = config[key];
}

async function openAccount() {
  const userId = await createUser();
  const opened = await generalAccounts.openGeneralAccount(userId);
  return { userId, accountId: opened.data.account.id };
}

async function grantReward(userId, accountId, body) {
  enableAdRewards();
  const request = body ?? claimBody('event-' + randomUUID());
  const response = await adRewardService().claim(userId, accountId, request);
  assert.equal(response.data.granted, true, 'setup grant must succeed');
  return { request, response };
}

function boundaryRows(accountId) {
  return prisma.equitySnapshot.findMany({
    where: {
      tradingAccountId: accountId,
      snapshotReason: { in: ['external_funding_before', 'external_funding_after'] },
    },
  });
}

async function krwBalance(accountId) {
  const wallet = await prisma.cashWallet.findFirst({
    where: { tradingAccountId: accountId, currencyCode: 'KRW' },
  });
  return wallet.balanceAmount.toFixed(8);
}

/**
 * Rewrites a committed boundary pair so the two rows share capturedAt AND
 * createdAt and carry the requested id order. This is the exact state the
 * payout transaction produces; pinning the ids makes the regression
 * reproducible rather than a coin flip.
 */
async function forceBoundaryIds(accountId, beforeId, afterId) {
  const rows = await boundaryRows(accountId);
  assert.equal(rows.length, 2, 'expected exactly one boundary pair');
  const before = rows.find((r) => r.snapshotReason === 'external_funding_before');
  const after = rows.find((r) => r.snapshotReason === 'external_funding_after');
  const sharedCapturedAt = before.capturedAt;
  const sharedCreatedAt = before.createdAt;

  await prisma.equitySnapshot.update({
    where: { id: before.id },
    data: { id: beforeId, capturedAt: sharedCapturedAt, createdAt: sharedCreatedAt },
  });
  await prisma.equitySnapshot.update({
    where: { id: after.id },
    data: { id: afterId, capturedAt: sharedCapturedAt, createdAt: sharedCreatedAt },
  });
}

// ------------------------------------------------- 1. before/after ordering

async function verifyBoundaryOrderIsUuidIndependent(beforeId, afterId, label) {

  const { userId, accountId } = await openAccount();
  await grantReward(userId, accountId);
  await forceBoundaryIds(accountId, beforeId, afterId);

  const latest = await performance.findLatestPerformanceSnapshot(accountId);
  assert.equal(
    latest.snapshotReason,
    'external_funding_after',
    label + ': latest state must be the after row',
  );

  // GENERAL_PERFORMANCE_INTEGRITY must NOT fire on a perfectly committed pair.
  const view = await portfolio.getPortfolio(userId, accountId);
  assert.equal(view.success, true, label + ': portfolio must succeed');
  assert.equal(view.data.state, 'available');
  assert.equal(view.data.summary.returnRate, '0.00000000');
  assert.equal(view.data.summary.totalAssetKrw, '10050000.00000000');
  assert.equal(view.data.summary.cumulativeExternalFundingKrw, '10050000.00000000');
  assert.equal(view.data.summary.investmentPnlKrw, '0.00000000');

  const equity = await portfolio.getEquity(userId, accountId, { range: 'all' });
  const reasons = equity.data.points.map((p) => p.snapshotReason);
  const beforeIndex = reasons.indexOf('external_funding_before');
  const afterIndex = reasons.indexOf('external_funding_after');
  assert.ok(beforeIndex >= 0 && afterIndex >= 0, label + ': both rows must appear');
  assert.ok(
    beforeIndex < afterIndex,
    label + ': history must read before → after, got ' + reasons.join(','),
  );

  // The NEXT payout must still work, i.e. the advance continued from the after row.
  const second = await grantReward(userId, accountId);
  assert.equal(second.response.data.granted, true);
  const afterSecond = await portfolio.getPortfolio(userId, accountId);
  assert.equal(afterSecond.data.summary.totalAssetKrw, '10100000.00000000');
  assert.equal(
    afterSecond.data.summary.returnRate,
    '0.00000000',
    label + ': two ad rewards must not create investment return',
  );
  return { userId, accountId };
}

// -------------------------------------------- 2. external funding continuity

async function verifyMissingAfterBoundaryStopsAdvance() {
  const { userId, accountId } = await openAccount();
  await grantReward(userId, accountId);

  const rows = await boundaryRows(accountId);
  const after = rows.find((r) => r.snapshotReason === 'external_funding_after');
  await prisma.equitySnapshot.delete({ where: { id: after.id } });

  // The ledger and the wallet still hold the reward; the performance state
  // does not. Nothing may be advanced from here.
  await expectCode(portfolio.getPortfolio(userId, accountId), 'GENERAL_PERFORMANCE_INTEGRITY');
  await expectCode(portfolio.getEquity(userId, accountId, { range: '7d' }), 'GENERAL_PERFORMANCE_INTEGRITY');
  await expectCode(
    adRewardService().claim(userId, accountId, claimBody('post-damage-' + randomUUID())),
    'GENERAL_PERFORMANCE_INTEGRITY',
  );
  return { userId, accountId };
}

async function verifyMissingBeforeBoundaryFailsReplay() {
  const { userId, accountId } = await openAccount();
  const granted = await grantReward(userId, accountId);

  const rows = await boundaryRows(accountId);
  const before = rows.find((r) => r.snapshotReason === 'external_funding_before');
  await prisma.equitySnapshot.delete({ where: { id: before.id } });

  // Continuity still holds (the after row matches the ledger), so the portfolio
  // reads fine — but the claim's boundary pair is incomplete, so a replay must
  // NOT confirm it.
  const view = await portfolio.getPortfolio(userId, accountId);
  assert.equal(view.data.state, 'available');
  await expectCode(
    adRewardService().claim(userId, accountId, granted.request),
    'AD_REWARD_CLAIM_INTEGRITY',
  );
}

async function verifyDamagedBoundaryFieldsFailReplay() {
  const cases = [
    ['amount', (after) => ({ externalFundingAmountKrw: '1' })],
    ['factor', (after) => ({ timeWeightedReturnFactor: '1.5' })],
    ['investment pnl', (after) => ({ investmentPnlKrw: '50000' })],
    ['after total', (after) => ({ totalAssetKrw: '99999999' })],
  ];

  for (const [label, patch] of cases) {
    const { userId, accountId } = await openAccount();
    const granted = await grantReward(userId, accountId);
    const rows = await boundaryRows(accountId);
    const after = rows.find((r) => r.snapshotReason === 'external_funding_after');

    await prisma.equitySnapshot.update({ where: { id: after.id }, data: patch(after) });
    await expectCode(
      adRewardService().claim(userId, accountId, granted.request),
      'AD_REWARD_CLAIM_INTEGRITY',
    );
  }
}

async function verifyBoundaryOnAnotherAccountFailsReplay() {
  const { userId, accountId } = await openAccount();
  const other = await openAccount();
  const granted = await grantReward(userId, accountId);
  const rows = await boundaryRows(accountId);
  const after = rows.find((r) => r.snapshotReason === 'external_funding_after');

  await prisma.equitySnapshot.update({
    where: { id: after.id },
    data: { tradingAccountId: other.accountId },
  });

  // The replay's boundary check owns this one: the pair still resolves by
  // reference id, but one half is scoped to another account.
  await expectCode(
    adRewardService().claim(userId, accountId, granted.request),
    'AD_REWARD_CLAIM_INTEGRITY',
  );
  // The account's OWN performance state is now short an 'after' row, so an
  // ordinary advance must refuse too.
  await expectCode(
    portfolio.getPortfolio(userId, accountId),
    'GENERAL_PERFORMANCE_INTEGRITY',
  );

  await prisma.equitySnapshot.update({
    where: { id: after.id },
    data: { tradingAccountId: accountId },
  });
}

async function verifyUnkeyedLegacyClaimWithBaselineStaysHealthy() {
  const { userId, accountId } = await openAccount();
  const granted = await grantReward(userId, accountId);

  // Recreate a PRE-작업 7 account: an unkeyed granted claim, no boundary rows,
  // and an explicit verified performance_baseline — exactly what
  // "backfill-general-performance --apply" produces.
  const rows = await boundaryRows(accountId);
  await prisma.equitySnapshot.deleteMany({
    where: { id: { in: rows.map((r) => r.id) } },
  });
  await prisma.equitySnapshot.deleteMany({
    where: { tradingAccountId: accountId, snapshotReason: 'general_account_open' },
  });
  const claim = await prisma.adRewardClaim.findFirst({
    where: { tradingAccountId: accountId, status: 'granted' },
  });
  await prisma.adRewardClaim.update({
    where: { id: claim.id },
    data: { idempotencyKey: null, requestHash: null, responsePayloadJson: null },
  });
  await prisma.equitySnapshot.create({
    data: {
      seasonParticipantId: null,
      tradingAccountId: accountId,
      totalAssetKrw: '10050000',
      returnRate: '0',
      krwCash: '10050000',
      usdCashKrw: '0',
      domesticStockValueKrw: '0',
      usStockValueKrw: '0',
      cryptoValueKrw: '0',
      snapshotReason: 'performance_baseline',
      cumulativeExternalFundingKrw: '10050000',
      investmentPnlKrw: '0',
      timeWeightedReturnFactor: '1',
      capturedAt: new Date(),
    },
  });

  const view = await portfolio.getPortfolio(userId, accountId);
  assert.equal(view.data.state, 'available');
  assert.equal(view.data.summary.returnRate, '0.00000000');
  assert.equal(view.data.summary.cumulativeExternalFundingKrw, '10050000.00000000');

  // Replaying the same AD EVENT under a new command key must still answer
  // duplicate: no boundary pair is expected or fabricated for a legacy claim.
  const replay = await adRewardService().claim(
    userId,
    accountId,
    claimBody(granted.request.proof),
  );
  assert.equal(replay.data.duplicate, true);
  assert.equal(replay.data.walletBalanceAfter, '10050000.00000000');
}

// --------------------------------------------------------- 3. replay paths

async function verifyCommandKeyReplay() {
  const { userId, accountId } = await openAccount();
  const granted = await grantReward(userId, accountId);
  const before = await krwBalance(accountId);

  const replay = await adRewardService().claim(userId, accountId, granted.request);
  assert.equal(replay.data.granted, false);
  assert.equal(replay.data.duplicate, true);
  assert.equal(replay.data.walletBalanceAfter, before);
  assert.notEqual(replay.data.walletBalanceAfter, null);
  assert.equal(await krwBalance(accountId), before);

  // Same key, DIFFERENT request.
  await expectCode(
    adRewardService().claim(
      userId,
      accountId,
      claimBody('different-proof-' + randomUUID(), {
        idempotencyKey: granted.request.idempotencyKey,
      }),
    ),
    'AD_REWARD_IDEMPOTENCY_CONFLICT',
  );

  // Same provider event, DIFFERENT key: the other idempotency axis.
  const otherKey = await adRewardService().claim(
    userId,
    accountId,
    claimBody(granted.request.proof),
  );
  assert.equal(otherKey.data.duplicate, true);
  assert.equal(otherKey.data.walletBalanceAfter, before);
  assert.equal(await krwBalance(accountId), before);

  return { userId, accountId, request: granted.request };
}

async function verifyConcurrentCommandKeyRace() {
  const { userId, accountId } = await openAccount();
  enableAdRewards();
  const body = claimBody('race-key-' + randomUUID());
  const service = adRewardService();

  const results = await Promise.allSettled([
    service.claim(userId, accountId, body),
    service.claim(userId, accountId, body),
    service.claim(userId, accountId, body),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  assert.equal(fulfilled.length, 3, 'identical commands must all resolve');
  assert.equal(fulfilled.filter((r) => r.value.data.granted).length, 1);
  for (const r of fulfilled) {
    assert.notEqual(r.value.data.walletBalanceAfter, null);
  }
  assert.equal(await krwBalance(accountId), '10050000.00000000');
  assert.equal(
    await prisma.adRewardClaim.count({ where: { tradingAccountId: accountId } }),
    1,
  );
  assert.equal((await boundaryRows(accountId)).length, 2);
}

async function verifyConcurrentProviderEventRace() {
  const { userId, accountId } = await openAccount();
  enableAdRewards();
  const proof = 'race-event-' + randomUUID();
  const service = adRewardService();

  const results = await Promise.allSettled([
    service.claim(userId, accountId, claimBody(proof)),
    service.claim(userId, accountId, claimBody(proof)),
    service.claim(userId, accountId, claimBody(proof)),
  ]);
  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  assert.equal(fulfilled.length, 3, 'same-event retries must all resolve');
  assert.equal(fulfilled.filter((r) => r.value.data.granted).length, 1);
  for (const r of fulfilled) {
    assert.notEqual(
      r.value.data.walletBalanceAfter,
      null,
      'no replay path may answer with a null balance',
    );
  }
  assert.equal(await krwBalance(accountId), '10050000.00000000');
  assert.equal(
    await prisma.walletTransaction.count({
      where: { tradingAccountId: accountId, txType: 'ad_reward' },
    }),
    1,
  );
}

async function verifyDamagedGrantedClaimsNeverReplayAsSuccess() {
  // Each case damages ONE thing and asserts the replay refuses rather than
  // answering duplicate: true.
  const cases = [
    [
      'ledger link missing',
      async (accountId, claim) =>
        prisma.adRewardClaim.update({
          where: { id: claim.id },
          data: { walletTransactionId: null },
        }),
    ],
    [
      'ledger amount mismatch',
      async (accountId, claim) =>
        prisma.walletTransaction.update({
          where: { id: claim.walletTransactionId },
          data: { amount: '1' },
        }),
    ],
    [
      'ledger on another account',
      async (accountId, claim, otherAccountId) =>
        prisma.walletTransaction.update({
          where: { id: claim.walletTransactionId },
          data: { tradingAccountId: otherAccountId },
        }),
    ],
    [
      'ledger on the USD wallet',
      async (accountId, claim) => {
        const usd = await prisma.cashWallet.findFirst({
          where: { tradingAccountId: accountId, currencyCode: 'USD' },
        });
        return prisma.walletTransaction.update({
          where: { id: claim.walletTransactionId },
          data: { walletId: usd.id },
        });
      },
    ],
    [
      'ledger referenceId mismatch',
      async (accountId, claim) =>
        prisma.walletTransaction.update({
          where: { id: claim.walletTransactionId },
          data: { referenceId: randomUUID() },
        }),
    ],
    [
      'boundary pair missing',
      async (accountId) => {
        const rows = await boundaryRows(accountId);
        return prisma.equitySnapshot.deleteMany({
          where: { id: { in: rows.map((r) => r.id) } },
        });
      },
    ],
  ];

  const other = await openAccount();
  for (const [label, damage] of cases) {
    const { userId, accountId } = await openAccount();
    const granted = await grantReward(userId, accountId);
    const claim = await prisma.adRewardClaim.findFirst({
      where: { tradingAccountId: accountId },
    });
    await damage(accountId, claim, other.accountId);

    const balanceBefore = await krwBalance(accountId);
    let refused = false;
    try {
      await adRewardService().claim(userId, accountId, granted.request);
    } catch (error) {
      refused = true;
      const code = errorCode(error);
      assert.ok(
        ['AD_REWARD_CLAIM_INTEGRITY', 'GENERAL_ACCOUNT_INTEGRITY', 'GENERAL_PERFORMANCE_INTEGRITY'].includes(code),
        label + ': unexpected code ' + code,
      );
    }
    assert.equal(refused, true, label + ': a damaged claim must not replay as success');
    assert.equal(await krwBalance(accountId), balanceBefore, label + ': no re-credit');
  }
}

async function verifyRejectedClaimWithLedgerFailsReplay() {
  const { userId, accountId } = await openAccount();
  enableAdRewards({ AD_REWARD_DAILY_MAX_COUNT: '1' });
  const service = adRewardService();
  await service.claim(userId, accountId, claimBody('reject-setup-' + randomUUID()));
  const refusedBody = claimBody('reject-target-' + randomUUID());
  await expectCode(
    service.claim(userId, accountId, refusedBody),
    'AD_REWARD_DAILY_COUNT_LIMIT',
  );

  // A refusal replays as the SAME refusal while it is clean...
  await expectCode(
    service.claim(userId, accountId, refusedBody),
    'AD_REWARD_DAILY_COUNT_LIMIT',
  );

  // ...but a rejected claim that somehow points at a ledger row is damage.
  const rejected = await prisma.adRewardClaim.findFirst({
    where: { tradingAccountId: accountId, status: 'rejected' },
  });
  const grantedLedger = await prisma.walletTransaction.findFirst({
    where: { tradingAccountId: accountId, txType: 'ad_reward' },
  });
  const grantedClaim = await prisma.adRewardClaim.findFirst({
    where: { tradingAccountId: accountId, status: 'granted' },
  });
  await prisma.adRewardClaim.update({
    where: { id: grantedClaim.id },
    data: { walletTransactionId: null },
  });
  await prisma.adRewardClaim.update({
    where: { id: rejected.id },
    data: { walletTransactionId: grantedLedger.id },
  });

  await expectCode(
    service.claim(userId, accountId, refusedBody),
    'AD_REWARD_CLAIM_INTEGRITY',
  );

  // Restore the link so cleanup can delete cleanly.
  await prisma.adRewardClaim.update({
    where: { id: rejected.id },
    data: { walletTransactionId: null },
  });
}

async function verifyNonTerminalStatusesNeverReplay() {
  for (const status of ['pending', 'verified', 'failed']) {
    const { userId, accountId } = await openAccount();
    const granted = await grantReward(userId, accountId);
    const claim = await prisma.adRewardClaim.findFirst({
      where: { tradingAccountId: accountId },
    });
    await prisma.adRewardClaim.update({
      where: { id: claim.id },
      data: { status },
    });

    await expectCode(
      adRewardService().claim(userId, accountId, granted.request),
      'AD_REWARD_CLAIM_INTEGRITY',
    );

    await prisma.adRewardClaim.update({
      where: { id: claim.id },
      data: { status: 'granted' },
    });
  }
}

/**
 * A COMMITTED command owes its caller the first result even after the account
 * was suspended/closed, the feature was switched off, or the adapter was
 * removed. None of those re-run the verifier or move money.
 */
async function verifyCommittedCommandSurvivesStateAndConfigChanges() {
  for (const status of ['suspended', 'closed']) {
    const { userId, accountId } = await openAccount();
    const granted = await grantReward(userId, accountId);
    const balance = await krwBalance(accountId);
    await prisma.tradingAccount.update({
      where: { id: accountId },
      data: { status, closedAt: status === 'closed' ? new Date() : null },
    });

    const replay = await adRewardService().claim(userId, accountId, granted.request);
    assert.equal(replay.data.duplicate, true);
    assert.equal(replay.data.walletBalanceAfter, balance);

    // A NEW command is still refused.
    await expectCode(
      adRewardService().claim(userId, accountId, claimBody('new-' + randomUUID())),
      'TRADING_ACCOUNT_NOT_ACTIVE',
    );
  }

  const disabled = await openAccount();
  const disabledGrant = await grantReward(disabled.userId, disabled.accountId);
  const disabledBalance = await krwBalance(disabled.accountId);
  process.env.AD_REWARD_ENABLED = 'false';
  const disabledReplay = await adRewardService().claim(
    disabled.userId,
    disabled.accountId,
    disabledGrant.request,
  );
  assert.equal(disabledReplay.data.duplicate, true);
  assert.equal(disabledReplay.data.walletBalanceAfter, disabledBalance);
  enableAdRewards();

  const removed = await openAccount();
  const removedGrant = await grantReward(removed.userId, removed.accountId);
  const removedBalance = await krwBalance(removed.accountId);
  // Registry EMPTY = today's production wiring.
  const noProvider = adRewardService([]);
  const removedReplay = await noProvider.claim(
    removed.userId,
    removed.accountId,
    removedGrant.request,
  );
  assert.equal(removedReplay.data.duplicate, true);
  assert.equal(removedReplay.data.walletBalanceAfter, removedBalance);
}

// ---------------------------------------------------------- 4. eligibility

async function verifyEligibilityChecksStructureBeforeConfig() {
  // disabled + healthy account → the normal advisory answer.
  const healthy = await openAccount();
  process.env.AD_REWARD_ENABLED = 'false';
  const disabled = await adRewardService().getEligibility(healthy.userId, healthy.accountId);
  assert.equal(disabled.success, true);
  assert.equal(disabled.data.enabled, false);
  assert.equal(disabled.data.eligible, false);
  assert.equal(disabled.data.reason, 'AD_REWARD_DISABLED');

  // disabled + USD wallet gone → damage wins over configuration.
  const damaged = await openAccount();
  const usd = await prisma.cashWallet.findFirst({
    where: { tradingAccountId: damaged.accountId, currencyCode: 'USD' },
  });
  await prisma.cashWallet.delete({ where: { id: usd.id } });
  await expectCode(
    adRewardService().getEligibility(damaged.userId, damaged.accountId),
    'GENERAL_ACCOUNT_INTEGRITY',
  );
  await prisma.cashWallet.create({
    data: {
      seasonParticipantId: null,
      tradingAccountId: damaged.accountId,
      currencyCode: 'USD',
      balanceAmount: '0',
      reservedAmount: '0',
    },
  });

  // no provider adapter + initial grant gone → still 500.
  enableAdRewards();
  const noGrant = await openAccount();
  await prisma.walletTransaction.deleteMany({
    where: { tradingAccountId: noGrant.accountId, referenceType: 'general_account_open' },
  });
  await expectCode(
    adRewardService([]).getEligibility(noGrant.userId, noGrant.accountId),
    'GENERAL_ACCOUNT_INTEGRITY',
  );

  // suspended + wallet scope damaged → still 500.
  const suspended = await openAccount();
  await prisma.tradingAccount.update({
    where: { id: suspended.accountId },
    data: { status: 'suspended' },
  });
  const season = await prisma.season.create({
    data: {
      name: 'eligibility-' + randomUUID(),
      status: 'active',
      startAt: new Date(Date.now() - 86400000),
      endAt: new Date(Date.now() + 86400000),
      initialCapitalKrw: '10000000',
      tradeFeeRate: '0.0015',
      fxFeeRate: '0.001',
    },
  });
  const participant = await prisma.seasonParticipant.create({
    data: {
      seasonId: season.id,
      userId: suspended.userId,
      joinedAt: new Date(),
      participantStatus: 'active',
      initialCapitalKrw: '10000000',
      totalAssetKrw: '10000000',
      totalReturnRate: '0',
      maxDrawdown: '0',
    },
  });
  const krw = await prisma.cashWallet.findFirst({
    where: { tradingAccountId: suspended.accountId, currencyCode: 'KRW' },
  });
  await prisma.cashWallet.update({
    where: { id: krw.id },
    data: { seasonParticipantId: participant.id },
  });
  await expectCode(
    adRewardService().getEligibility(suspended.userId, suspended.accountId),
    'GENERAL_ACCOUNT_INTEGRITY',
  );
  await prisma.cashWallet.update({
    where: { id: krw.id },
    data: { seasonParticipantId: null },
  });
  await prisma.seasonParticipant.delete({ where: { id: participant.id } });
  await prisma.season.delete({ where: { id: season.id } });

  // closed + healthy → the existing status-based answer, unchanged.
  const closed = await openAccount();
  await prisma.tradingAccount.update({
    where: { id: closed.accountId },
    data: { status: 'closed', closedAt: new Date() },
  });
  const closedView = await adRewardService().getEligibility(closed.userId, closed.accountId);
  assert.equal(closedView.data.eligible, false);
  assert.equal(closedView.data.reason, 'TRADING_ACCOUNT_NOT_ACTIVE');

  // active + healthy → limits and cooldown still computed as before.
  const active = await openAccount();
  const activeView = await adRewardService().getEligibility(active.userId, active.accountId);
  assert.equal(activeView.data.eligible, true);
  assert.equal(activeView.data.rewardAmountKrw, REWARD);
  assert.equal(activeView.data.remainingCountToday, 10);
  assert.equal(activeView.data.grantedCountToday, 0);
}

// ------------------------------------------------ 5. general daily snapshot

function jobKey(label) {
  const key = 'general-daily-' + label + '-' + RUN_TAG;
  createdJobKeys.push(key);
  return key;
}

async function runDailyJob(snapshotDate, options) {
  const response = await dailyJob.run({
    snapshotDate,
    dryRun: options?.dryRun === true,
    idempotencyKey: jobKey(options?.label ?? randomUUID()),
    requestedBy: 'integration',
  });
  return response.data.run.resultPayloadJson;
}

function accountRow(result, accountId) {
  return (result.errors ?? []).find((e) => e.tradingAccountId === accountId) ?? null;
}

async function verifyDailySnapshotJob() {
  const activeAcc = await openAccount();
  await grantReward(activeAcc.userId, activeAcc.accountId);
  const suspendedAcc = await openAccount();
  await prisma.tradingAccount.update({
    where: { id: suspendedAcc.accountId },
    data: { status: 'suspended' },
  });
  const closedAcc = await openAccount();
  await prisma.tradingAccount.update({
    where: { id: closedAcc.accountId },
    data: { status: 'closed', closedAt: new Date() },
  });

  // A Sunday: a general cash account's daily snapshot does not depend on any
  // market being open.
  const snapshotDate = '2026-08-02';

  const dry = await runDailyJob(snapshotDate, { dryRun: true, label: 'dry' });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.createdSnapshotIds.length, 0);
  assert.ok(dry.accounts.wouldCreate >= 2);
  assert.ok(dry.accounts.excludedClosed >= 1);
  assert.equal(
    await prisma.dailyPortfolioSnapshot.count({
      where: { tradingAccountId: activeAcc.accountId },
    }),
    0,
    'dry run must write nothing',
  );

  const first = await runDailyJob(snapshotDate, { label: 'first' });
  assert.equal(first.dryRun, false);
  assert.ok(first.accounts.created >= 2);

  const daily = await prisma.dailyPortfolioSnapshot.findUnique({
    where: {
      tradingAccountId_snapshotDate: {
        tradingAccountId: activeAcc.accountId,
        snapshotDate: new Date(snapshotDate + 'T00:00:00.000Z'),
      },
    },
  });
  assert.ok(daily, 'active general account must get a daily row');
  assert.equal(daily.seasonParticipantId, null);
  assert.equal(daily.totalAssetKrw.toFixed(8), '10050000.00000000');
  assert.equal(daily.returnRate.toFixed(8), '0.00000000');
  assert.equal(daily.cumulativeExternalFundingKrw.toFixed(8), '10050000.00000000');
  assert.equal(daily.investmentPnlKrw.toFixed(8), '0.00000000');
  assert.equal(daily.timeWeightedReturnFactor.toFixed(8), '1.00000000');
  assert.equal(daily.krwCash.toFixed(8), '10050000.00000000');
  assert.equal(daily.usdCashKrw.toFixed(8), '0.00000000');
  assert.equal(daily.assetValueKrw.toFixed(8), '0.00000000');
  assert.ok(daily.capturedAt);

  const scheduled = await prisma.equitySnapshot.findMany({
    where: { tradingAccountId: activeAcc.accountId, snapshotReason: 'scheduled' },
  });
  assert.equal(scheduled.length, 1, 'exactly one scheduled equity snapshot');
  assert.equal(scheduled[0].seasonParticipantId, null);
  assert.equal(scheduled[0].totalAssetKrw.toFixed(8), '10050000.00000000');
  assert.equal(scheduled[0].cumulativeExternalFundingKrw.toFixed(8), '10050000.00000000');
  assert.equal(scheduled[0].timeWeightedReturnFactor.toFixed(8), '1.00000000');
  assert.equal(scheduled[0].externalFundingReferenceId, null);

  // suspended: included. closed: excluded, and NOTHING was written for it.
  assert.equal(
    await prisma.dailyPortfolioSnapshot.count({
      where: { tradingAccountId: suspendedAcc.accountId },
    }),
    1,
  );
  assert.equal(
    await prisma.dailyPortfolioSnapshot.count({
      where: { tradingAccountId: closedAcc.accountId },
    }),
    0,
  );
  assert.equal(
    await prisma.equitySnapshot.count({
      where: { tradingAccountId: closedAcc.accountId, snapshotReason: 'scheduled' },
    }),
    0,
  );

  // Re-run for the same date: idempotent, no second equity row either.
  const second = await runDailyJob(snapshotDate, { label: 'second' });
  assert.ok(second.accounts.existing >= 2);
  assert.equal(second.accounts.created, 0);
  assert.equal(
    await prisma.equitySnapshot.count({
      where: { tradingAccountId: activeAcc.accountId, snapshotReason: 'scheduled' },
    }),
    1,
    're-running must not add a scheduled equity snapshot',
  );

  // The 7d equity API now prefers the daily row.
  const equity = await portfolio.getEquity(activeAcc.userId, activeAcc.accountId, {
    range: '7d',
  });
  assert.equal(equity.data.returnRateMethod, 'time_weighted');
  assert.ok(equity.data.points.length >= 1);
  assert.equal(equity.data.points[equity.data.points.length - 1].returnRate, '0.00000000');

  return { activeAcc, suspendedAcc, closedAcc };
}

async function verifyConcurrentDailyJobLeavesOneRowPair() {
  const acc = await openAccount();
  const snapshotDate = '2026-08-09';

  const results = await Promise.allSettled([
    runDailyJob(snapshotDate, { label: 'race-a' }),
    runDailyJob(snapshotDate, { label: 'race-b' }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);

  assert.equal(
    await prisma.dailyPortfolioSnapshot.count({
      where: {
        tradingAccountId: acc.accountId,
        snapshotDate: new Date(snapshotDate + 'T00:00:00.000Z'),
      },
    }),
    1,
    'exactly one daily row survives a concurrent run',
  );
  assert.equal(
    await prisma.equitySnapshot.count({
      where: { tradingAccountId: acc.accountId, snapshotReason: 'scheduled' },
    }),
    1,
    'the losing transaction must not leave its scheduled equity snapshot behind',
  );
}

/**
 * Injects a failure into DailyPortfolioSnapshot.create so the transaction
 * aborts AFTER the EquitySnapshot insert. Both must disappear.
 */
function failingDailyPrisma() {
  const originalTransaction = prisma.$transaction.bind(prisma);
  const wrapTx = (tx) =>
    new Proxy(tx, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== 'dailyPortfolioSnapshot') return value;
        return new Proxy(value, {
          get(delegate, method) {
            if (method === 'create') {
              return () => Promise.reject(new Error('injected daily failure'));
            }
            const inner = Reflect.get(delegate, method);
            return typeof inner === 'function' ? inner.bind(delegate) : inner;
          },
        });
      },
    });

  return new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop === '$transaction') {
        return (fn, options) => originalTransaction((tx) => fn(wrapTx(tx)), options);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

async function verifyDailyFailureRollsBackTheEquitySnapshot() {
  const acc = await openAccount();
  const snapshotDate = '2026-08-16';
  const job = new GeneralDailySnapshotJobService(
    batch,
    failingDailyPrisma(),
    performance,
  );

  const response = await job.run({
    snapshotDate,
    idempotencyKey: jobKey('rollback'),
    requestedBy: 'integration',
  });
  const result = response.data.run.resultPayloadJson;
  assert.ok(result.accounts.failed >= 1, 'the injected failure must be recorded');

  assert.equal(
    await prisma.equitySnapshot.count({
      where: { tradingAccountId: acc.accountId, snapshotReason: 'scheduled' },
    }),
    0,
    'the EquitySnapshot must roll back with the failed daily insert',
  );
  assert.equal(
    await prisma.dailyPortfolioSnapshot.count({
      where: { tradingAccountId: acc.accountId },
    }),
    0,
  );
}

async function verifyDamagedAccountsAreReportedNotSnapshotted() {
  // (a) no performance origin
  const noOrigin = await openAccount();
  await prisma.equitySnapshot.deleteMany({
    where: { tradingAccountId: noOrigin.accountId },
  });
  // (b) ledger ahead of the latest snapshot
  const discontinuous = await openAccount();
  await grantReward(discontinuous.userId, discontinuous.accountId);
  const rows = await boundaryRows(discontinuous.accountId);
  const after = rows.find((r) => r.snapshotReason === 'external_funding_after');
  await prisma.equitySnapshot.delete({ where: { id: after.id } });
  // (c) a healthy account with an adversarial boundary id order
  const ordered = await openAccount();
  await grantReward(ordered.userId, ordered.accountId);
  const orderedIds = fixedIds('a3');
  await forceBoundaryIds(ordered.accountId, orderedIds.high, orderedIds.low);

  const snapshotDate = '2026-08-23';
  const result = await runDailyJob(snapshotDate, { label: 'damaged' });

  const noOriginError = accountRow(result, noOrigin.accountId);
  assert.ok(noOriginError, 'missing origin must be reported');
  assert.equal(noOriginError.code, 'GENERAL_PERFORMANCE_NOT_INITIALIZED');

  const discontinuousError = accountRow(result, discontinuous.accountId);
  assert.ok(discontinuousError, 'funding discontinuity must be reported');
  assert.equal(discontinuousError.code, 'GENERAL_PERFORMANCE_INTEGRITY');

  assert.ok(result.accounts.integrityFailed >= 2);
  for (const damaged of [noOrigin.accountId, discontinuous.accountId]) {
    assert.equal(
      await prisma.dailyPortfolioSnapshot.count({
        where: { tradingAccountId: damaged },
      }),
      0,
      'a damaged account must not get a partial snapshot',
    );
  }

  // The healthy-but-adversarially-ordered account IS snapshotted, at 0% TWR.
  const orderedDaily = await prisma.dailyPortfolioSnapshot.findFirst({
    where: { tradingAccountId: ordered.accountId },
  });
  assert.ok(orderedDaily, 'UUID order must not block a healthy account');
  assert.equal(orderedDaily.returnRate.toFixed(8), '0.00000000');
  assert.equal(orderedDaily.totalAssetKrw.toFixed(8), '10050000.00000000');
}

async function verifySeasonDailyRowsAreUntouched() {
  // A season daily row for the same date must survive the general job
  // unchanged — the general writer never touches participant-scoped rows.
  const userId = await createUser();
  const season = await prisma.season.create({
    data: {
      name: 'general-job-isolation-' + randomUUID(),
      status: 'active',
      startAt: new Date(Date.now() - 86400000),
      endAt: new Date(Date.now() + 86400000),
      initialCapitalKrw: '10000000',
      tradeFeeRate: '0.0015',
      fxFeeRate: '0.001',
    },
  });
  const seasonAccount = await prisma.tradingAccount.create({
    data: {
      userId,
      mode: 'season',
      status: 'active',
      initialCapitalKrw: '10000000',
      openedAt: new Date(),
    },
  });
  const participant = await prisma.seasonParticipant.create({
    data: {
      seasonId: season.id,
      userId,
      joinedAt: new Date(),
      participantStatus: 'active',
      initialCapitalKrw: '10000000',
      totalAssetKrw: '10000000',
      totalReturnRate: '0',
      maxDrawdown: '0',
      tradingAccountId: seasonAccount.id,
    },
  });
  const snapshotDate = new Date('2026-08-30T00:00:00.000Z');
  const seasonDaily = await prisma.dailyPortfolioSnapshot.create({
    data: {
      seasonParticipantId: participant.id,
      tradingAccountId: seasonAccount.id,
      snapshotDate,
      totalAssetKrw: '11000000',
      returnRate: '10',
      krwCash: '11000000',
      usdCashKrw: '0',
      assetValueKrw: '0',
      realizedPnlKrw: '0',
      unrealizedPnlKrw: '0',
      capturedAt: new Date(),
    },
  });

  await runDailyJob('2026-08-30', { label: 'season-isolation' });

  const reread = await prisma.dailyPortfolioSnapshot.findUnique({
    where: { id: seasonDaily.id },
  });
  assert.equal(reread.totalAssetKrw.toFixed(8), '11000000.00000000');
  assert.equal(reread.returnRate.toFixed(8), '10.00000000');
  assert.equal(reread.seasonParticipantId, participant.id);
  assert.equal(reread.cumulativeExternalFundingKrw, null);
  assert.equal(
    await prisma.dailyPortfolioSnapshot.count({
      where: { tradingAccountId: seasonAccount.id },
    }),
    1,
    'the general job must not add a row for a season account',
  );

  await prisma.dailyPortfolioSnapshot.deleteMany({
    where: { tradingAccountId: seasonAccount.id },
  });
  await prisma.seasonParticipant.delete({ where: { id: participant.id } });
  await prisma.tradingAccount.delete({ where: { id: seasonAccount.id } });
  await prisma.season.delete({ where: { id: season.id } });
}

// ------------------------------------------------------------------ runner

async function cleanup() {
  if (createdJobKeys.length > 0) {
    await prisma.batchJobRun.deleteMany({
      where: { idempotencyKey: { in: createdJobKeys } },
    });
  }

  // Two passes across ALL test users, not one pass per user: some scenarios
  // deliberately relink a ledger row to another test account, so a per-user
  // delete would hit ad_reward_claims_wallet_transaction_id_fkey.
  const accounts = await prisma.tradingAccount.findMany({
    where: { userId: { in: createdUserIds } },
    select: { id: true },
  });
  const accountIds = accounts.map((a) => a.id);

  await prisma.adRewardClaim.updateMany({
    where: { userId: { in: createdUserIds } },
    data: { walletTransactionId: null },
  });
  await prisma.adRewardClaim.deleteMany({
    where: { userId: { in: createdUserIds } },
  });

  if (accountIds.length > 0) {
    await prisma.equitySnapshot.deleteMany({
      where: { tradingAccountId: { in: accountIds } },
    });
    await prisma.dailyPortfolioSnapshot.deleteMany({
      where: { tradingAccountId: { in: accountIds } },
    });
    await prisma.walletTransaction.deleteMany({
      where: { tradingAccountId: { in: accountIds } },
    });
    await prisma.cashWallet.deleteMany({
      where: { tradingAccountId: { in: accountIds } },
    });
  }
  await prisma.seasonParticipant.deleteMany({
    where: { userId: { in: createdUserIds } },
  });
  await prisma.tradingAccount.deleteMany({
    where: { userId: { in: createdUserIds } },
  });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
}

async function main() {
  try {
    const first = fixedIds('a1');
    await verifyBoundaryOrderIsUuidIndependent(first.high, first.low, 'before > after');
    const second = fixedIds('a2');
    await verifyBoundaryOrderIsUuidIndependent(second.low, second.high, 'after > before');

    await verifyMissingAfterBoundaryStopsAdvance();
    await verifyMissingBeforeBoundaryFailsReplay();
    await verifyDamagedBoundaryFieldsFailReplay();
    await verifyBoundaryOnAnotherAccountFailsReplay();
    await verifyUnkeyedLegacyClaimWithBaselineStaysHealthy();

    await verifyCommandKeyReplay();
    await verifyConcurrentCommandKeyRace();
    await verifyConcurrentProviderEventRace();
    await verifyDamagedGrantedClaimsNeverReplayAsSuccess();
    await verifyRejectedClaimWithLedgerFailsReplay();
    await verifyNonTerminalStatusesNeverReplay();
    await verifyCommittedCommandSurvivesStateAndConfigChanges();

    await verifyEligibilityChecksStructureBeforeConfig();

    await verifyDailySnapshotJob();
    await verifyConcurrentDailyJobLeavesOneRowPair();
    await verifyDailyFailureRollsBackTheEquitySnapshot();
    await verifyDamagedAccountsAreReportedNotSnapshotted();
    await verifySeasonDailyRowsAreUntouched();

    console.log('general performance hardening ok');
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
