import { spawnSync } from 'node:child_process';

/**
 * Opt-in PostgreSQL integration tests for the general-account + ad-reward
 * foundation (작업 6).
 *
 * Financial atomicity, partial-unique idempotency, and concurrency CANNOT be
 * established with mocks, so these run against a real migrated database:
 * general-account provisioning (create / replay / concurrent open / mid-
 * transaction rollback / damaged-account fail-closed), account-scoped
 * wallet + ledger reads for a general account, and the whole ad-reward path
 * (disabled, no provider adapter, verification failure, grant atomicity,
 * duplicate event replay, cross-account reuse, daily count/amount races,
 * cooldown, and permanent rejection).
 *
 * Runs only with TRADING_ACCOUNT_DB_INTEGRATION=1 against the migrated dev DB
 * (prepare = `prisma migrate deploy` only; never reset/drop/seed).
 */
const RUN_DB_INTEGRATION = process.env.TRADING_ACCOUNT_DB_INTEGRATION === '1';
const itDbIntegration = RUN_DB_INTEGRATION ? it : it.skip;

describe('General account + ad reward DB integration', () => {
  itDbIntegration(
    'verifies provisioning atomicity, idempotency, reads, and ad-reward grants against PostgreSQL',
    () => {
      runDbIntegrationPrepare();

      const result = spawnSync(
        getPnpmCommand(),
        ['tsx', '-e', GENERAL_ACCOUNT_DB_RUNNER],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 240_000,
        },
      );

      if (result.status !== 0) {
        throw new Error(
          [
            'General account DB integration runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }

      expect(result.stdout).toContain('general account db integration ok');
    },
    260_000,
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
        'General account DB integration prepare failed.',
        'The opt-in test applies existing Prisma migrations with `prisma migrate deploy` only; it does not reset, drop, or seed the database.',
        'stdout:',
        result.stdout,
        'stderr:',
        result.stderr,
      ].join('\n'),
    );
  }
}

const GENERAL_ACCOUNT_DB_RUNNER = `
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { PrismaService } from './src/prisma/prisma.service';
import { GeneralAccountsService } from './src/trading-accounts/general-accounts.service';
import { TradingAccountAccessService } from './src/trading-accounts/trading-account-access.service';
import { WalletsService } from './src/wallets/wallets.service';
import { AdRewardService } from './src/ad-rewards/ad-reward.service';
import { AdRewardVerificationRegistry } from './src/ad-rewards/ad-reward-verifier';

const prisma = new PrismaService();
const access = new TradingAccountAccessService(prisma);
const generalAccounts = new GeneralAccountsService(prisma);
const wallets = new WalletsService(prisma, access);

const REWARD = '50000.00000000';
const createdUserIds = [];

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
      email: 'general-db-' + id + '@example.com',
      passwordHash: 'x',
      nickname: 'general-db-' + id,
    },
  });
  createdUserIds.push(id);
  return id;
}

/** Deterministic test-only verifier. Production registers NOTHING. */
function fakeVerifier(provider) {
  return {
    provider,
    async verify(request) {
      if (request.proof.startsWith('invalid')) {
        return { ok: false, reasonCode: 'FAKE_REJECTED', reason: 'test rejection' };
      }
      return {
        ok: true,
        provider,
        // The EVENT ID comes from the verifier, never the client body.
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
    new AdRewardVerificationRegistry(providers),
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
  for (const key of Object.keys(config)) {
    process.env[key] = config[key];
  }
}

function disableAdRewards() {
  process.env.AD_REWARD_ENABLED = 'false';
}

async function readGeneralShape(accountId) {
  const [account, walletRows, ledgerRows] = await Promise.all([
    prisma.tradingAccount.findUnique({ where: { id: accountId } }),
    prisma.cashWallet.findMany({
      where: { tradingAccountId: accountId },
      orderBy: { currencyCode: 'asc' },
    }),
    prisma.walletTransaction.findMany({
      where: { tradingAccountId: accountId },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  return { account, wallets: walletRows, ledger: ledgerRows };
}

// --------------------------------------------------------------- scenarios

async function verifyFirstOpenIsAtomicAndComplete() {
  const userId = await createUser();
  const response = await generalAccounts.openGeneralAccount(userId);

  assert.equal(response.data.created, true);
  assert.equal(response.data.account.mode, 'general');
  assert.equal(response.data.account.status, 'active');
  assert.equal(response.data.account.initialCapitalKrw, '10000000.00000000');
  assert.equal(response.data.account.season, null);

  const accountId = response.data.account.id;
  const shape = await readGeneralShape(accountId);

  assert.equal(shape.wallets.length, 2);
  const krw = shape.wallets.find((w) => w.currencyCode === 'KRW');
  const usd = shape.wallets.find((w) => w.currencyCode === 'USD');
  assert.equal(krw.balanceAmount.toFixed(8), '10000000.00000000');
  assert.equal(krw.reservedAmount.toFixed(8), '0.00000000');
  assert.equal(usd.balanceAmount.toFixed(8), '0.00000000');
  assert.equal(krw.seasonParticipantId, null);
  assert.equal(usd.seasonParticipantId, null);
  assert.equal(krw.tradingAccountId, accountId);
  assert.equal(usd.tradingAccountId, accountId);

  assert.equal(shape.ledger.length, 1);
  const grant = shape.ledger[0];
  assert.equal(grant.seasonParticipantId, null);
  assert.equal(grant.tradingAccountId, accountId);
  assert.equal(grant.walletId, krw.id);
  assert.equal(grant.txType, 'initial_grant');
  assert.equal(grant.referenceType, 'general_account_open');
  assert.equal(grant.referenceId, accountId);
  assert.equal(grant.amount.toFixed(8), '10000000.00000000');
  assert.equal(grant.balanceAfter.toFixed(8), '10000000.00000000');

  // No SeasonParticipant is ever created for a general account.
  const participants = await prisma.seasonParticipant.count({ where: { userId } });
  assert.equal(participants, 0);

  return { userId, accountId };
}

async function verifyReopenIsIdempotent(userId, accountId) {
  const before = await readGeneralShape(accountId);
  const replay = await generalAccounts.openGeneralAccount(userId);

  assert.equal(replay.data.created, false);
  assert.equal(replay.data.account.id, accountId);

  const after = await readGeneralShape(accountId);
  assert.equal(after.wallets.length, before.wallets.length);
  assert.equal(after.ledger.length, before.ledger.length);
  assert.equal(
    after.wallets.find((w) => w.currencyCode === 'KRW').balanceAmount.toFixed(8),
    before.wallets.find((w) => w.currencyCode === 'KRW').balanceAmount.toFixed(8),
  );
  const accountCount = await prisma.tradingAccount.count({
    where: { userId, mode: 'general' },
  });
  assert.equal(accountCount, 1);
}

async function verifyConcurrentOpenCreatesExactlyOne() {
  const userId = await createUser();
  const results = await Promise.all([
    generalAccounts.openGeneralAccount(userId),
    generalAccounts.openGeneralAccount(userId),
    generalAccounts.openGeneralAccount(userId),
  ]);

  const accountIds = new Set(results.map((r) => r.data.account.id));
  assert.equal(accountIds.size, 1, 'concurrent opens must converge on one account');
  assert.equal(
    results.filter((r) => r.data.created).length,
    1,
    'exactly one call may report created=true',
  );

  const accountId = [...accountIds][0];
  const shape = await readGeneralShape(accountId);
  assert.equal(
    await prisma.tradingAccount.count({ where: { userId, mode: 'general' } }),
    1,
  );
  assert.equal(shape.wallets.filter((w) => w.currencyCode === 'KRW').length, 1);
  assert.equal(shape.wallets.filter((w) => w.currencyCode === 'USD').length, 1);
  assert.equal(
    shape.ledger.filter((l) => l.referenceType === 'general_account_open').length,
    1,
  );
  assert.equal(
    shape.wallets.find((w) => w.currencyCode === 'KRW').balanceAmount.toFixed(8),
    '10000000.00000000',
  );
  return { userId, accountId };
}

/**
 * Wraps the transaction client so ONE delegate method fails mid-way. Used to
 * prove the open transaction is all-or-nothing without corrupting the DB.
 */
function failingPrisma(delegateName, methodName) {
  const originalTransaction = prisma.$transaction.bind(prisma);

  const wrapTx = (tx) =>
    new Proxy(tx, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== delegateName) return value;
        return new Proxy(value, {
          get(delegate, method) {
            if (method === methodName) {
              return () => Promise.reject(new Error('injected failure'));
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

async function verifyMidTransactionFailureRollsEverythingBack(delegateName, methodName) {
  const userId = await createUser();
  const service = new GeneralAccountsService(failingPrisma(delegateName, methodName));

  let threw = false;
  try {
    await service.openGeneralAccount(userId);
  } catch {
    threw = true;
  }
  assert.equal(threw, true, 'the injected failure must propagate');

  assert.equal(
    await prisma.tradingAccount.count({ where: { userId, mode: 'general' } }),
    0,
    delegateName + '.' + methodName + ' failure must roll the account back',
  );
  assert.equal(
    await prisma.cashWallet.count({ where: { tradingAccount: { userId } } }),
    0,
    'wallets must roll back with the account',
  );
  assert.equal(
    await prisma.walletTransaction.count({
      where: { tradingAccount: { userId } },
    }),
    0,
    'the initial grant must roll back with the account',
  );

  // The user can still open the account afterwards; nothing is half-created.
  const retry = await generalAccounts.openGeneralAccount(userId);
  assert.equal(retry.data.created, true);
  return retry.data.account.id;
}

async function verifyDamagedAccountFailsClosed() {
  const userId = await createUser();
  const opened = await generalAccounts.openGeneralAccount(userId);
  const accountId = opened.data.account.id;

  // Simulate corruption: the USD wallet disappears.
  const usd = await prisma.cashWallet.findFirst({
    where: { tradingAccountId: accountId, currencyCode: 'USD' },
  });
  await prisma.cashWallet.delete({ where: { id: usd.id } });

  await expectCode(
    generalAccounts.openGeneralAccount(userId),
    'GENERAL_ACCOUNT_INTEGRITY',
  );

  // NOTHING was re-granted or recreated.
  const shape = await readGeneralShape(accountId);
  assert.equal(shape.wallets.length, 1);
  assert.equal(shape.ledger.length, 1);
  assert.equal(
    shape.wallets[0].balanceAmount.toFixed(8),
    '10000000.00000000',
  );

  // Restore so later scenarios can reuse nothing from this account.
  await prisma.cashWallet.create({
    data: {
      seasonParticipantId: null,
      tradingAccountId: accountId,
      currencyCode: 'USD',
      balanceAmount: '0',
      reservedAmount: '0',
    },
  });
}

async function verifySuspendedAndClosedAreNotReopened() {
  for (const status of ['suspended', 'closed']) {
    const userId = await createUser();
    const opened = await generalAccounts.openGeneralAccount(userId);
    const accountId = opened.data.account.id;
    await prisma.tradingAccount.update({
      where: { id: accountId },
      data: { status },
    });

    const replay = await generalAccounts.openGeneralAccount(userId);
    assert.equal(replay.data.created, false);
    assert.equal(replay.data.account.id, accountId);
    assert.equal(
      replay.data.account.status,
      status,
      status + ' account must NOT be auto-reactivated',
    );
    assert.equal(
      await prisma.tradingAccount.count({ where: { userId, mode: 'general' } }),
      1,
    );
    assert.equal(
      await prisma.walletTransaction.count({
        where: { tradingAccountId: accountId, referenceType: 'general_account_open' },
      }),
      1,
      'no second grant for a ' + status + ' account',
    );
  }
}

async function verifyPartialUniqueRejectsASecondGrantRow(accountId) {
  let rejected = false;
  try {
    const krw = await prisma.cashWallet.findFirst({
      where: { tradingAccountId: accountId, currencyCode: 'KRW' },
    });
    await prisma.walletTransaction.create({
      data: {
        seasonParticipantId: null,
        tradingAccountId: accountId,
        walletId: krw.id,
        currencyCode: 'KRW',
        direction: 'credit',
        txType: 'initial_grant',
        referenceType: 'general_account_open',
        referenceId: accountId,
        amount: '10000000',
        balanceAfter: '20000000',
        occurredAt: new Date(),
      },
    });
  } catch (error) {
    rejected = true;
  }
  assert.equal(
    rejected,
    true,
    'the general_account_open partial unique must reject a second grant row',
  );
}

async function verifyAccountScopedReadsForGeneralAccount(userId, accountId) {
  const walletView = await wallets.getWalletsForTradingAccount(userId, accountId);
  assert.equal(walletView.data.tradingAccountId, accountId);
  const krw = walletView.data.wallets.find((w) => w.currencyCode === 'KRW');
  const usd = walletView.data.wallets.find((w) => w.currencyCode === 'USD');
  assert.equal(krw.balanceAmount, '10000000.00000000');
  assert.equal(krw.availableAmount, '10000000.00000000');
  assert.equal(usd.balanceAmount, '0.00000000');

  const ledgerView = await wallets.getWalletTransactionsForTradingAccount(
    userId,
    accountId,
  );
  const grants = ledgerView.data.transactions.filter(
    (t) => t.referenceType === 'general_account_open',
  );
  assert.equal(grants.length, 1);
  assert.equal(grants[0].txType, 'initial_grant');
  assert.equal(grants[0].amount, '10000000.00000000');
  assert.equal(grants[0].referenceId, accountId);
}

async function verifyGeneralReadFailsClosedOnSeasonLinkBleed() {
  const userId = await createUser();
  const opened = await generalAccounts.openGeneralAccount(userId);
  const accountId = opened.data.account.id;

  // Manufacture the corruption a general read must never present as normal.
  const season = await prisma.season.create({
    data: {
      name: 'general-integrity-' + randomUUID(),
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
      userId,
      joinedAt: new Date(),
      participantStatus: 'active',
      initialCapitalKrw: '10000000',
      totalAssetKrw: '10000000',
      totalReturnRate: '0',
      maxDrawdown: '0',
    },
  });
  const krw = await prisma.cashWallet.findFirst({
    where: { tradingAccountId: accountId, currencyCode: 'KRW' },
  });
  await prisma.cashWallet.update({
    where: { id: krw.id },
    data: { seasonParticipantId: participant.id },
  });

  await expectCode(
    wallets.getWalletsForTradingAccount(userId, accountId),
    'GENERAL_ACCOUNT_INTEGRITY',
  );
  await expectCode(
    wallets.getWalletTransactionsForTradingAccount(userId, accountId),
    'GENERAL_ACCOUNT_INTEGRITY',
  );

  await prisma.cashWallet.update({
    where: { id: krw.id },
    data: { seasonParticipantId: null },
  });
  await prisma.seasonParticipant.delete({ where: { id: participant.id } });
  await prisma.season.delete({ where: { id: season.id } });
}

// ------------------------------------------------------------- ad rewards

async function verifyAdRewardDisabledAndProviderGates(userId, accountId) {
  disableAdRewards();
  await expectCode(
    adRewardService([fakeVerifier('test-provider')]).claim(userId, accountId, {
      provider: 'test-provider',
      proof: randomUUID(),
    }),
    'AD_REWARD_DISABLED',
  );

  enableAdRewards();
  // Registry EMPTY = production wiring: an ad completion is never trusted.
  await expectCode(
    adRewardService([]).claim(userId, accountId, {
      provider: 'test-provider',
      proof: randomUUID(),
    }),
    'AD_REWARD_PROVIDER_UNAVAILABLE',
  );

  assert.equal(await prisma.adRewardClaim.count({ where: { userId } }), 0);
}

async function verifyVerificationFailureWritesNothing(userId, accountId) {
  enableAdRewards();
  const before = await readGeneralShape(accountId);

  await expectCode(
    adRewardService([fakeVerifier('test-provider')]).claim(userId, accountId, {
      provider: 'test-provider',
      proof: 'invalid-' + randomUUID(),
    }),
    'AD_REWARD_VERIFICATION_FAILED',
  );

  const after = await readGeneralShape(accountId);
  assert.equal(await prisma.adRewardClaim.count({ where: { userId } }), 0);
  assert.equal(after.ledger.length, before.ledger.length);
  assert.equal(
    after.wallets.find((w) => w.currencyCode === 'KRW').balanceAmount.toFixed(8),
    before.wallets.find((w) => w.currencyCode === 'KRW').balanceAmount.toFixed(8),
  );
}

async function verifyGrantIsAtomicAndLedgered(userId, accountId) {
  enableAdRewards();
  const service = adRewardService([fakeVerifier('test-provider')]);
  const before = await readGeneralShape(accountId);
  const beforeKrw = before.wallets.find((w) => w.currencyCode === 'KRW').balanceAmount;
  const eventId = 'event-' + randomUUID();

  const response = await service.claim(userId, accountId, {
    provider: 'test-provider',
    proof: eventId,
  });
  assert.equal(response.data.granted, true);
  assert.equal(response.data.duplicate, false);

  const claim = await prisma.adRewardClaim.findUnique({
    where: {
      provider_providerEventId: {
        provider: 'test-provider',
        providerEventId: eventId,
      },
    },
  });
  assert.equal(claim.status, 'granted');
  assert.equal(claim.userId, userId);
  assert.equal(claim.tradingAccountId, accountId);
  assert.equal(claim.rewardAmountKrw.toFixed(8), REWARD);
  assert.ok(claim.walletTransactionId, 'granted claim must link its ledger row');
  assert.ok(claim.grantedAt);
  // Only the one-way fingerprint is stored; never the proof itself.
  assert.equal(claim.verificationFingerprint.length, 64);
  assert.notEqual(claim.verificationFingerprint, eventId);
  assert.ok(!JSON.stringify(claim.verificationMetadataJson).includes(eventId));

  const ledger = await prisma.walletTransaction.findUnique({
    where: { id: claim.walletTransactionId },
  });
  assert.equal(ledger.txType, 'ad_reward');
  assert.equal(ledger.referenceType, 'ad_reward_claim');
  assert.equal(ledger.referenceId, claim.id);
  assert.equal(ledger.seasonParticipantId, null);
  assert.equal(ledger.tradingAccountId, accountId);
  assert.equal(ledger.currencyCode, 'KRW');
  assert.equal(ledger.direction, 'credit');
  assert.equal(ledger.amount.toFixed(8), REWARD);

  const after = await readGeneralShape(accountId);
  const afterKrw = after.wallets.find((w) => w.currencyCode === 'KRW').balanceAmount;
  assert.equal(afterKrw.toFixed(8), beforeKrw.add(REWARD).toFixed(8));
  assert.equal(ledger.balanceAfter.toFixed(8), afterKrw.toFixed(8));
  // USD is never credited and initialCapitalKrw never moves.
  assert.equal(
    after.wallets.find((w) => w.currencyCode === 'USD').balanceAmount.toFixed(8),
    before.wallets.find((w) => w.currencyCode === 'USD').balanceAmount.toFixed(8),
  );
  assert.equal(after.account.initialCapitalKrw.toFixed(8), '10000000.00000000');
  assert.equal(
    after.wallets.find((w) => w.currencyCode === 'KRW').reservedAmount.toFixed(8),
    '0.00000000',
  );

  return eventId;
}

async function verifyDuplicateEventReplays(userId, accountId, eventId) {
  const service = adRewardService([fakeVerifier('test-provider')]);
  const before = await readGeneralShape(accountId);

  const replay = await service.claim(userId, accountId, {
    provider: 'test-provider',
    proof: eventId,
  });
  assert.equal(replay.data.granted, false);
  assert.equal(replay.data.duplicate, true);

  const after = await readGeneralShape(accountId);
  assert.equal(
    after.wallets.find((w) => w.currencyCode === 'KRW').balanceAmount.toFixed(8),
    before.wallets.find((w) => w.currencyCode === 'KRW').balanceAmount.toFixed(8),
    'a replay must not credit again',
  );
  assert.equal(after.ledger.length, before.ledger.length, 'no extra ledger row');
  assert.equal(
    await prisma.adRewardClaim.count({
      where: { provider: 'test-provider', providerEventId: eventId },
    }),
    1,
  );
}

async function verifyEventCannotBeReusedByAnotherAccount(eventId) {
  const otherUserId = await createUser();
  const other = await generalAccounts.openGeneralAccount(otherUserId);
  const otherAccountId = other.data.account.id;
  const before = await readGeneralShape(otherAccountId);

  await expectCode(
    adRewardService([fakeVerifier('test-provider')]).claim(
      otherUserId,
      otherAccountId,
      { provider: 'test-provider', proof: eventId },
    ),
    'AD_REWARD_EVENT_ALREADY_USED',
  );

  const after = await readGeneralShape(otherAccountId);
  assert.equal(
    after.wallets.find((w) => w.currencyCode === 'KRW').balanceAmount.toFixed(8),
    before.wallets.find((w) => w.currencyCode === 'KRW').balanceAmount.toFixed(8),
  );
  assert.equal(after.ledger.length, before.ledger.length);
  return { otherUserId, otherAccountId };
}

async function verifyConcurrentSameEventGrantsOnce() {
  const userId = await createUser();
  const accountId = (await generalAccounts.openGeneralAccount(userId)).data.account.id;
  enableAdRewards();
  const service = adRewardService([fakeVerifier('test-provider')]);
  const eventId = 'race-' + randomUUID();

  const results = await Promise.allSettled([
    service.claim(userId, accountId, { provider: 'test-provider', proof: eventId }),
    service.claim(userId, accountId, { provider: 'test-provider', proof: eventId }),
    service.claim(userId, accountId, { provider: 'test-provider', proof: eventId }),
  ]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  assert.equal(fulfilled.length, 3, 'same-event retries must all resolve, not 500');
  assert.equal(
    fulfilled.filter((r) => r.value.data.granted).length,
    1,
    'exactly one call may report a fresh grant',
  );

  assert.equal(
    await prisma.adRewardClaim.count({
      where: { provider: 'test-provider', providerEventId: eventId },
    }),
    1,
    'one claim row per provider event',
  );
  const shape = await readGeneralShape(accountId);
  const adLedger = shape.ledger.filter((l) => l.txType === 'ad_reward');
  assert.equal(adLedger.length, 1, 'one ad_reward ledger row');
  assert.equal(
    shape.wallets.find((w) => w.currencyCode === 'KRW').balanceAmount.toFixed(8),
    '10050000.00000000',
    'credited exactly once',
  );
  return { userId, accountId };
}

async function verifyDailyCountRaceCannotOverpay() {
  const userId = await createUser();
  const accountId = (await generalAccounts.openGeneralAccount(userId)).data.account.id;
  enableAdRewards({ AD_REWARD_DAILY_MAX_COUNT: '1' });
  const service = adRewardService([fakeVerifier('test-provider')]);

  const results = await Promise.allSettled([
    service.claim(userId, accountId, { provider: 'test-provider', proof: 'count-a-' + randomUUID() }),
    service.claim(userId, accountId, { provider: 'test-provider', proof: 'count-b-' + randomUUID() }),
    service.claim(userId, accountId, { provider: 'test-provider', proof: 'count-c-' + randomUUID() }),
  ]);

  const granted = results.filter((r) => r.status === 'fulfilled');
  assert.equal(granted.length, 1, 'the daily count cap must hold under concurrency');
  for (const rejection of results.filter((r) => r.status === 'rejected')) {
    assert.equal(errorCode(rejection.reason), 'AD_REWARD_DAILY_COUNT_LIMIT');
  }

  const shape = await readGeneralShape(accountId);
  assert.equal(
    shape.ledger.filter((l) => l.txType === 'ad_reward').length,
    1,
  );
  assert.equal(
    shape.wallets.find((w) => w.currencyCode === 'KRW').balanceAmount.toFixed(8),
    '10050000.00000000',
  );
  assert.equal(
    await prisma.adRewardClaim.count({
      where: { tradingAccountId: accountId, status: 'rejected' },
    }),
    2,
    'refused-but-verified events are recorded as rejected claims',
  );
  const rejectedClaims = await prisma.adRewardClaim.findMany({
    where: { tradingAccountId: accountId, status: 'rejected' },
  });
  for (const claim of rejectedClaims) {
    assert.equal(claim.walletTransactionId, null);
    assert.equal(claim.failureCode, 'AD_REWARD_DAILY_COUNT_LIMIT');
    assert.ok(claim.rejectedAt);
  }
  return { userId, accountId, rejectedEventId: rejectedClaims[0].providerEventId };
}

async function verifyRejectedEventIsNeverPaidLater(userId, accountId, rejectedEventId) {
  // Raise the cap so the ONLY thing keeping this event unpaid is its
  // permanent rejection.
  enableAdRewards({ AD_REWARD_DAILY_MAX_COUNT: '10' });
  const service = adRewardService([fakeVerifier('test-provider')]);
  const before = await readGeneralShape(accountId);

  await expectCode(
    service.claim(userId, accountId, {
      provider: 'test-provider',
      proof: rejectedEventId,
    }),
    'AD_REWARD_DAILY_COUNT_LIMIT',
  );

  const after = await readGeneralShape(accountId);
  assert.equal(
    after.wallets.find((w) => w.currencyCode === 'KRW').balanceAmount.toFixed(8),
    before.wallets.find((w) => w.currencyCode === 'KRW').balanceAmount.toFixed(8),
  );
  assert.equal(after.ledger.length, before.ledger.length);
  const claim = await prisma.adRewardClaim.findUnique({
    where: {
      provider_providerEventId: {
        provider: 'test-provider',
        providerEventId: rejectedEventId,
      },
    },
  });
  assert.equal(claim.status, 'rejected');
  assert.equal(claim.walletTransactionId, null);
}

async function verifyDailyAmountRaceCannotOverpay() {
  const userId = await createUser();
  const accountId = (await generalAccounts.openGeneralAccount(userId)).data.account.id;
  enableAdRewards({
    AD_REWARD_DAILY_MAX_COUNT: '100',
    AD_REWARD_DAILY_MAX_AMOUNT_KRW: REWARD,
  });
  const service = adRewardService([fakeVerifier('test-provider')]);

  const results = await Promise.allSettled([
    service.claim(userId, accountId, { provider: 'test-provider', proof: 'amount-a-' + randomUUID() }),
    service.claim(userId, accountId, { provider: 'test-provider', proof: 'amount-b-' + randomUUID() }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  for (const rejection of results.filter((r) => r.status === 'rejected')) {
    assert.equal(errorCode(rejection.reason), 'AD_REWARD_DAILY_AMOUNT_LIMIT');
  }
  const shape = await readGeneralShape(accountId);
  assert.equal(
    shape.wallets.find((w) => w.currencyCode === 'KRW').balanceAmount.toFixed(8),
    '10050000.00000000',
  );
}

async function verifyCooldownBlocksAndThenAllows() {
  const userId = await createUser();
  const accountId = (await generalAccounts.openGeneralAccount(userId)).data.account.id;
  enableAdRewards({ AD_REWARD_COOLDOWN_SECONDS: '3600' });
  const service = adRewardService([fakeVerifier('test-provider')]);

  await service.claim(userId, accountId, {
    provider: 'test-provider',
    proof: 'cooldown-1-' + randomUUID(),
  });
  await expectCode(
    service.claim(userId, accountId, {
      provider: 'test-provider',
      proof: 'cooldown-2-' + randomUUID(),
    }),
    'AD_REWARD_COOLDOWN_ACTIVE',
  );

  const eligibility = await service.getEligibility(userId, accountId);
  assert.equal(eligibility.data.eligible, false);
  assert.equal(eligibility.data.reason, 'AD_REWARD_COOLDOWN_ACTIVE');
  assert.ok(eligibility.data.nextEligibleAt);

  // Age the grant past the cooldown; a NEW event is then payable.
  await prisma.adRewardClaim.updateMany({
    where: { tradingAccountId: accountId, status: 'granted' },
    data: { grantedAt: new Date(Date.now() - 7200000) },
  });
  const after = await service.claim(userId, accountId, {
    provider: 'test-provider',
    proof: 'cooldown-3-' + randomUUID(),
  });
  assert.equal(after.data.granted, true);
  const shape = await readGeneralShape(accountId);
  assert.equal(
    shape.ledger.filter((l) => l.txType === 'ad_reward').length,
    2,
  );
}

async function verifySeasonAccountsAndForeignAccountsAreRefused(userId, accountId) {
  enableAdRewards();
  const service = adRewardService([fakeVerifier('test-provider')]);

  // Another user's general accountId is the SAME 404 as an unknown one.
  const strangerId = await createUser();
  await expectCode(
    service.getEligibility(strangerId, accountId),
    'TRADING_ACCOUNT_NOT_FOUND',
  );
  await expectCode(
    service.listClaims(strangerId, accountId),
    'TRADING_ACCOUNT_NOT_FOUND',
  );
  await expectCode(
    service.claim(strangerId, accountId, { provider: 'test-provider', proof: randomUUID() }),
    'TRADING_ACCOUNT_NOT_FOUND',
  );
  await expectCode(
    service.getEligibility(userId, randomUUID()),
    'TRADING_ACCOUNT_NOT_FOUND',
  );

  // A SEASON account is never eligible for ad rewards.
  const seasonUserId = await createUser();
  const seasonAccount = await prisma.tradingAccount.create({
    data: {
      userId: seasonUserId,
      mode: 'season',
      status: 'active',
      initialCapitalKrw: '10000000',
      openedAt: new Date(),
    },
  });
  const season = await prisma.season.create({
    data: {
      name: 'ad-season-' + randomUUID(),
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
      userId: seasonUserId,
      joinedAt: new Date(),
      participantStatus: 'active',
      initialCapitalKrw: '10000000',
      totalAssetKrw: '10000000',
      totalReturnRate: '0',
      maxDrawdown: '0',
      tradingAccountId: seasonAccount.id,
    },
  });

  for (const call of [
    () => service.getEligibility(seasonUserId, seasonAccount.id),
    () => service.listClaims(seasonUserId, seasonAccount.id),
    () =>
      service.claim(seasonUserId, seasonAccount.id, {
        provider: 'test-provider',
        proof: randomUUID(),
      }),
  ]) {
    await expectCode(call(), 'AD_REWARD_GENERAL_ACCOUNT_ONLY');
  }
  assert.equal(
    await prisma.adRewardClaim.count({ where: { tradingAccountId: seasonAccount.id } }),
    0,
  );

  await prisma.seasonParticipant.delete({ where: { id: participant.id } });
  await prisma.tradingAccount.delete({ where: { id: seasonAccount.id } });
  await prisma.season.delete({ where: { id: season.id } });
}

async function verifySuspendedAndClosedClaimRules() {
  const userId = await createUser();
  const accountId = (await generalAccounts.openGeneralAccount(userId)).data.account.id;
  enableAdRewards();
  const service = adRewardService([fakeVerifier('test-provider')]);
  await service.claim(userId, accountId, {
    provider: 'test-provider',
    proof: 'history-' + randomUUID(),
  });

  for (const status of ['suspended', 'closed']) {
    await prisma.tradingAccount.update({ where: { id: accountId }, data: { status } });

    await expectCode(
      service.claim(userId, accountId, { provider: 'test-provider', proof: randomUUID() }),
      'TRADING_ACCOUNT_NOT_ACTIVE',
    );

    // History and eligibility stay READABLE for the owner.
    const eligibility = await service.getEligibility(userId, accountId);
    assert.equal(eligibility.data.eligible, false);
    assert.equal(eligibility.data.reason, 'TRADING_ACCOUNT_NOT_ACTIVE');

    const claims = await service.listClaims(userId, accountId);
    assert.equal(claims.data.claims.length, 1);
    const view = claims.data.claims[0];
    assert.equal(view.status, 'granted');
    assert.equal(view.rewardAmountKrw, REWARD);
    // Secrets never leave the server.
    assert.equal('providerEventId' in view, false);
    assert.equal('verificationFingerprint' in view, false);
    assert.equal('verificationMetadataJson' in view, false);
    assert.ok(claims.data.pagination);
  }
}

async function verifyEligibilityIsAdvisoryOnly(userId, accountId) {
  enableAdRewards();
  const service = adRewardService([fakeVerifier('test-provider')]);
  const before = await readGeneralShape(accountId);
  const beforeClaims = await prisma.adRewardClaim.count({
    where: { tradingAccountId: accountId },
  });

  const eligibility = await service.getEligibility(userId, accountId);
  assert.equal(eligibility.data.enabled, true);
  assert.equal(eligibility.data.provider, 'test-provider');
  assert.equal(eligibility.data.rewardAmountKrw, REWARD);

  const after = await readGeneralShape(accountId);
  assert.equal(after.ledger.length, before.ledger.length);
  assert.equal(
    await prisma.adRewardClaim.count({ where: { tradingAccountId: accountId } }),
    beforeClaims,
    'GET eligibility must not create a claim',
  );
  assert.equal(
    after.wallets.find((w) => w.currencyCode === 'KRW').balanceAmount.toFixed(8),
    before.wallets.find((w) => w.currencyCode === 'KRW').balanceAmount.toFixed(8),
  );
}

async function cleanup() {
  for (const userId of createdUserIds) {
    await prisma.adRewardClaim.deleteMany({ where: { userId } });
    const accounts = await prisma.tradingAccount.findMany({
      where: { userId },
      select: { id: true },
    });
    const accountIds = accounts.map((a) => a.id);
    if (accountIds.length > 0) {
      await prisma.walletTransaction.deleteMany({
        where: { tradingAccountId: { in: accountIds } },
      });
      await prisma.cashWallet.deleteMany({
        where: { tradingAccountId: { in: accountIds } },
      });
      await prisma.seasonParticipant.deleteMany({ where: { userId } });
      await prisma.tradingAccount.deleteMany({ where: { userId } });
    }
    await prisma.user.deleteMany({ where: { id: userId } });
  }
}

async function main() {
  try {
    const first = await verifyFirstOpenIsAtomicAndComplete();
    await verifyReopenIsIdempotent(first.userId, first.accountId);
    await verifyPartialUniqueRejectsASecondGrantRow(first.accountId);
    await verifyAccountScopedReadsForGeneralAccount(first.userId, first.accountId);

    await verifyConcurrentOpenCreatesExactlyOne();
    await verifyMidTransactionFailureRollsEverythingBack('cashWallet', 'create');
    await verifyMidTransactionFailureRollsEverythingBack('walletTransaction', 'create');
    await verifyDamagedAccountFailsClosed();
    await verifySuspendedAndClosedAreNotReopened();
    await verifyGeneralReadFailsClosedOnSeasonLinkBleed();

    await verifyAdRewardDisabledAndProviderGates(first.userId, first.accountId);
    await verifyVerificationFailureWritesNothing(first.userId, first.accountId);
    await verifyEligibilityIsAdvisoryOnly(first.userId, first.accountId);
    const eventId = await verifyGrantIsAtomicAndLedgered(first.userId, first.accountId);
    await verifyDuplicateEventReplays(first.userId, first.accountId, eventId);
    await verifyEventCannotBeReusedByAnotherAccount(eventId);
    await verifyConcurrentSameEventGrantsOnce();
    const countRace = await verifyDailyCountRaceCannotOverpay();
    await verifyRejectedEventIsNeverPaidLater(
      countRace.userId,
      countRace.accountId,
      countRace.rejectedEventId,
    );
    await verifyDailyAmountRaceCannotOverpay();
    await verifyCooldownBlocksAndThenAllows();
    await verifySeasonAccountsAndForeignAccountsAreRefused(first.userId, first.accountId);
    await verifySuspendedAndClosedClaimRules();

    console.log('general account db integration ok');
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
