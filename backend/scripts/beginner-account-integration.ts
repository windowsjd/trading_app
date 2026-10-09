/** Real PostgreSQL invariants. Run only against a disposable local test DB. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { GeneralAccountsService } from '../src/trading-accounts/general-accounts.service';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import { TradingAccountsService } from '../src/trading-accounts/trading-accounts.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { GeneralExternalFundingService } from '../src/portfolio/general-external-funding.service';
import { GeneralAccountPerformanceService } from '../src/portfolio/general-account-performance.service';
import { TradingAccountPortfolioService } from '../src/portfolio/trading-account-portfolio.service';
import { WalletsService } from '../src/wallets/wallets.service';
import { OrdersService } from '../src/orders/orders.service';
import { FxService } from '../src/fx/fx.service';
import { TradingAccountWalletTransferService } from '../src/wallets/trading-account-wallet-transfer.service';
import { SeasonsService } from '../src/seasons/seasons.service';
import { AdRewardService } from '../src/ad-rewards/ad-reward.service';
import { AdRewardVerificationRegistry } from '../src/ad-rewards/ad-reward-verifier';
import { BatchService } from '../src/batch/batch.service';
import { GeneralDailySnapshotJobService } from '../src/batch/general-daily-snapshot-job.service';
import { SeasonSettlementJobService } from '../src/batch/season-settlement-job.service';
import { RankingRefreshService } from '../src/ranking/ranking-refresh.service';
import { Prisma } from '../src/generated/prisma/client';

const target = new URL(process.env.DATABASE_URL ?? 'http://invalid');
const disposableDatabase =
  target.pathname.endsWith('_test') ||
  (process.env.GITHUB_ACTIONS === 'true' && target.pathname === '/trading_app');
if (
  process.env.NODE_ENV !== 'test' ||
  process.env.BEGINNER_ACCOUNT_DB_INTEGRATION !== '1' ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  !disposableDatabase
) {
  throw new Error(
    'Explicit opt-in and a local disposable test database are required.',
  );
}
const db = new PrismaService();
const access = new TradingAccountAccessService(db);
const accounts = new TradingAccountsService(access);
const valuation = new PortfolioValuationService(db);
const funding = new GeneralExternalFundingService(db);
const performance = new GeneralAccountPerformanceService(
  db,
  valuation,
  funding,
);
const opens = new GeneralAccountsService(db, performance);
const portfolio = new TradingAccountPortfolioService(
  db,
  access,
  performance,
  valuation,
);
const wallets = new WalletsService(db, access);
const orders = new OrdersService(
  db,
  undefined,
  undefined,
  undefined,
  access,
  performance,
);
const fx = new FxService(
  db,
  undefined,
  undefined,
  access,
  performance,
  valuation,
);
const transfers = new TradingAccountWalletTransferService(
  db,
  access,
  performance,
);
const users: string[] = [];
const seasons: string[] = [];
const rates: string[] = [];
const batchKey = `beginner-${randomUUID()}`;

async function user() {
  const id = randomUUID();
  await db.user.create({
    data: {
      id,
      email: `${id}@beginner.example`,
      nickname: id,
      passwordHash: 'test-only',
    },
  });
  users.push(id);
  return id;
}
async function rejectsCode(work: Promise<unknown>, code: string) {
  await assert.rejects(work, (error: unknown) => {
    assert.equal(error instanceof HttpException, true);
    assert.equal(
      ((error as HttpException).getResponse() as { error: { code: string } })
        .error.code,
      code,
    );
    return true;
  });
}
async function counts(userId: string) {
  const where = { tradingAccount: { userId } };
  return Promise.all([
    db.tradingAccount.count({ where: { userId } }),
    db.cashWallet.count({ where }),
    db.walletTransaction.count({ where }),
    db.equitySnapshot.count({ where }),
  ]);
}

function failCreationAt(delegateName: string, failCall: number): PrismaService {
  let calls = 0;
  return new Proxy(db, {
    get(target, key, receiver) {
      if (key !== '$transaction') return Reflect.get(target, key, receiver);
      return (run: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        db.$transaction((tx) =>
          run(
            new Proxy(tx, {
              get(target, key, receiver) {
                const delegate = Reflect.get(target, key, receiver);
                if (key !== delegateName) return delegate;
                return new Proxy(delegate, {
                  get(target, key, receiver) {
                    const method = Reflect.get(target, key, receiver);
                    if (key !== 'create')
                      return typeof method === 'function'
                        ? method.bind(target)
                        : method;
                    return (...args: unknown[]) => {
                      if (++calls === failCall)
                        throw new Error('injected beginner creation failure');
                      return method.apply(target, args);
                    };
                  },
                });
              },
            }),
          ),
        );
    },
  });
}

async function run() {
  await db.$connect();
  const owner = await user();
  delete process.env.BEGINNER_MODE_ENABLED;
  await rejectsCode(opens.openBeginnerAccount(owner), 'BEGINNER_MODE_DISABLED');
  process.env.BEGINNER_MODE_ENABLED = 'true';
  process.env.NODE_ENV = 'production';
  await rejectsCode(opens.openBeginnerAccount(owner), 'BEGINNER_MODE_DISABLED');
  process.env.NODE_ENV = 'test';
  assert.equal(
    (await accounts.listTradingAccounts(owner)).data.accounts.length,
    0,
  );
  assert.deepEqual(await counts(owner), [0, 0, 0, 0]);

  const opened = await Promise.all(
    Array.from({ length: 8 }, () => opens.openBeginnerAccount(owner)),
  );
  const beginner = opened[0].data.account;
  assert.equal(new Set(opened.map((row) => row.data.account.id)).size, 1);
  assert.equal(opened.filter((row) => row.data.created).length, 1);
  assert.equal(beginner.mode, 'beginner');
  assert.equal(opened[0].data.wallets.length, 4);
  assert.deepEqual(await counts(owner), [1, 4, 1, 1]);
  const initial = await portfolio.getPortfolio(owner, beginner.id);
  assert.equal(initial.data.summary?.totalAssetKrw, '10000000.00000000');
  assert.equal(initial.data.summary?.investmentPnlKrw, '0.00000000');
  assert.equal(initial.data.summary?.returnRate, '0.00000000');
  assert.equal(initial.data.summary?.returnRateMethod, 'time_weighted');
  assert.equal(
    initial.data.summary?.cumulativeExternalFundingKrw,
    '10000000.00000000',
  );
  const origin = await db.equitySnapshot.findFirstOrThrow({
    where: { tradingAccountId: beginner.id },
  });
  assert.equal(origin.timeWeightedReturnFactor?.toString(), '1');
  assert.equal(origin.externalFundingAmountKrw?.toString(), '10000000');
  const grant = await db.walletTransaction.findFirstOrThrow({
    where: { tradingAccountId: beginner.id },
  });
  assert.equal(grant.txType, 'initial_grant');
  assert.equal(grant.direction, 'credit');
  assert.equal(grant.amount.toString(), '10000000');
  assert.equal(grant.referenceId, beginner.id);
  await assert.rejects(
    db.tradingAccount.create({
      data: {
        userId: owner,
        mode: 'beginner',
        initialCapitalKrw: '10000000',
        openedAt: new Date(),
      },
    }),
    { code: 'P2002' },
  );
  const { id: _grantId, ...duplicateGrant } = grant;
  await assert.rejects(db.walletTransaction.create({ data: duplicateGrant }), {
    code: 'P2002',
  });
  assert.equal((await opens.openBeginnerAccount(owner)).data.created, false);
  await accounts.listTradingAccounts(owner);
  await accounts.getTradingAccount(owner, beginner.id);
  await wallets.getWalletsForTradingAccount(owner, beginner.id);
  await orders.getOrdersForTradingAccount(owner, beginner.id);
  await fx.getExchangesForTradingAccount(owner, beginner.id);
  await portfolio.getEquity(owner, beginner.id, { granularity: 'daily' });
  assert.deepEqual(
    await counts(owner),
    [1, 4, 1, 1],
    'GETs and replay never create financial rows',
  );

  for (const [delegate, count] of [
    ['cashWallet', 1],
    ['cashWallet', 4],
    ['walletTransaction', 1],
    ['equitySnapshot', 1],
  ] as const) {
    const id = await user();
    const faulty = new GeneralAccountsService(
      failCreationAt(delegate, count),
      performance,
    );
    await assert.rejects(
      faulty.openBeginnerAccount(id),
      /injected beginner creation failure/,
    );
    assert.deepEqual(await counts(id), [0, 0, 0, 0]);
  }
  const stranger = await user();
  for (const read of [
    () => accounts.getTradingAccount(stranger, beginner.id),
    () => portfolio.getPortfolio(stranger, beginner.id),
    () => wallets.getWalletsForTradingAccount(stranger, beginner.id),
    () => orders.getOrdersForTradingAccount(stranger, beginner.id),
    () =>
      fx.quoteForTradingAccount(stranger, beginner.id, {
        fromCurrency: 'KRW',
        toCurrency: 'USD',
        sourceAmount: '1000',
      }),
  ])
    await rejectsCode(read(), 'TRADING_ACCOUNT_NOT_FOUND');

  const general = (await opens.openGeneralAccount(owner)).data.account;
  const season = await db.season.create({
    data: {
      name: batchKey,
      status: 'active',
      startAt: new Date(Date.now() - 86400000),
      endAt: new Date(Date.now() + 86400000),
      initialCapitalKrw: '10000000',
      tradeFeeRate: '0.001',
      fxFeeRate: '0.001',
    },
  });
  seasons.push(season.id);
  await new SeasonsService(db).joinSeason(season.id, owner);
  const list = await accounts.listTradingAccounts(owner);
  assert.deepEqual(list.data.accounts.map((a) => a.mode).sort(), [
    'beginner',
    'general',
    'season',
  ]);
  assert.equal(list.data.beginnerModeEnabled, true);
  const seasonAccount = list.data.accounts.find((a) => a.mode === 'season')!;
  const snapshotsBefore = await db.equitySnapshot.count({
    where: { tradingAccountId: seasonAccount.id },
  });
  const rate = await db.fxRateSnapshot.create({
    data: {
      baseCurrency: 'USD',
      quoteCurrency: 'KRW',
      rate: '1400',
      sourceType: 'provider_api',
      sourceName: 'korea_exim_exchange_rate',
      capturedAt: new Date(Date.now() - 1000),
      effectiveAt: new Date(Date.now() - 1000),
    },
  });
  rates.push(rate.id);
  process.env.GENERAL_FX_FEE_RATE = '0.001000';
  const body = {
    fromCurrency: 'KRW',
    toCurrency: 'USD',
    sourceAmount: '1400000',
  };
  const quote = await fx.quoteForTradingAccount(owner, beginner.id, body);
  const command = {
    ...body,
    quoteId: quote.data.quoteId,
    idempotencyKey: randomUUID(),
  };
  await fx.executeForTradingAccount(owner, beginner.id, command);
  const afterFx = await portfolio.getPortfolio(owner, beginner.id);
  assert.equal(afterFx.data.summary?.totalAssetKrw, '9998600.00000000');
  assert.equal(afterFx.data.summary?.investmentPnlKrw, '-1400.00000000');
  assert.equal(afterFx.data.summary?.returnRate, '-0.01400000');
  const ownUsd = await db.cashWallet.findFirstOrThrow({
    where: {
      tradingAccountId: beginner.id,
      walletScope: 'securities',
      currencyCode: 'USD',
    },
  });
  const ownSpot = await db.cashWallet.findFirstOrThrow({
    where: { tradingAccountId: beginner.id, walletScope: 'crypto_spot' },
  });
  for (const other of [general, seasonAccount]) {
    const otherUsd = await db.cashWallet.findFirstOrThrow({
      where: {
        tradingAccountId: other.id,
        walletScope: 'securities',
        currencyCode: 'USD',
      },
    });
    await rejectsCode(
      transfers.transfer(owner, beginner.id, {
        sourceWalletId: ownUsd.id,
        destinationWalletId: otherUsd.id,
        amount: '10',
        idempotencyKey: randomUUID(),
      }),
      'WALLET_TRANSFER_WALLET_NOT_FOUND',
    );
    await rejectsCode(
      transfers.transfer(owner, other.id, {
        sourceWalletId: otherUsd.id,
        destinationWalletId: ownUsd.id,
        amount: '10',
        idempotencyKey: randomUUID(),
      }),
      'WALLET_TRANSFER_WALLET_NOT_FOUND',
    );
  }
  await transfers.transfer(owner, beginner.id, {
    sourceWalletId: ownUsd.id,
    destinationWalletId: ownSpot.id,
    amount: '10',
    idempotencyKey: randomUUID(),
  });
  const afterTransfer = await portfolio.getPortfolio(owner, beginner.id);
  assert.equal(
    afterTransfer.data.summary?.totalAssetKrw,
    afterFx.data.summary?.totalAssetKrw,
  );
  assert.equal(
    afterTransfer.data.summary?.returnRate,
    afterFx.data.summary?.returnRate,
  );
  assert.equal(
    (await portfolio.getPortfolio(owner, general.id)).data.summary
      ?.totalAssetKrw,
    '10000000.00000000',
  );
  assert.equal(
    (await portfolio.getPortfolio(owner, seasonAccount.id)).data.summary
      ?.totalAssetKrw,
    '10000000.00000000',
  );
  assert.equal(
    await db.equitySnapshot.count({
      where: { tradingAccountId: seasonAccount.id },
    }),
    snapshotsBefore,
  );
  const ad = new AdRewardService(
    db,
    access,
    new AdRewardVerificationRegistry(),
    performance,
  );
  await rejectsCode(
    ad.getEligibility(owner, beginner.id),
    'AD_REWARD_GENERAL_ACCOUNT_ONLY',
  );
  assert.equal(
    await db.adRewardClaim.count({ where: { tradingAccountId: beginner.id } }),
    0,
  );
  assert.equal(
    await db.seasonParticipant.count({
      where: { tradingAccountId: beginner.id },
    }),
    0,
  );
  assert.equal(
    await db.seasonRanking.count({ where: { tradingAccountId: beginner.id } }),
    0,
  );

  const daily = new GeneralDailySnapshotJobService(
    new BatchService(db),
    db,
    performance,
  );
  await daily.run({
    snapshotDate: new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date()),
    idempotencyKey: batchKey,
    dryRun: false,
  });
  const dailyRow = await db.dailyPortfolioSnapshot.findFirstOrThrow({
    where: { tradingAccountId: beginner.id },
  });
  assert.equal(
    dailyRow.returnRate.toFixed(8),
    afterTransfer.data.summary?.returnRate,
  );
  assert.equal(dailyRow.cumulativeExternalFundingKrw?.toString(), '10000000');
  assert.equal(
    (await portfolio.getEquity(owner, beginner.id, { granularity: 'daily' }))
      .data.points.length,
    1,
  );

  // An actual season refresh and settlement must touch only its own account.
  await new RankingRefreshService(db, valuation).refreshCurrentRankingForSeason(
    season.id,
  );
  assert.equal(
    await db.seasonRanking.count({ where: { tradingAccountId: beginner.id } }),
    0,
  );
  await db.season.update({
    where: { id: season.id },
    data: { status: 'ended', endAt: new Date() },
  });
  await new SeasonSettlementJobService(new BatchService(db), db, valuation).run(
    {
      seasonId: season.id,
      settlementDate: new Date().toLocaleDateString('en-CA', {
        timeZone: 'Asia/Seoul',
      }),
      idempotencyKey: `${batchKey}-settlement`,
    },
  );
  assert.equal(
    (await db.season.findUniqueOrThrow({ where: { id: season.id } })).status,
    'settled',
  );
  assert.equal(
    await db.seasonRanking.count({
      where: { seasonId: season.id, rankType: 'final' },
    }),
    1,
  );
  assert.equal(
    await db.seasonRanking.count({ where: { tradingAccountId: beginner.id } }),
    0,
  );
  assert.equal(
    (await db.tradingAccount.findUniqueOrThrow({ where: { id: beginner.id } }))
      .status,
    'active',
  );
  assert.equal(
    (await portfolio.getPortfolio(owner, beginner.id)).data.summary?.returnRate,
    afterTransfer.data.summary?.returnRate,
  );

  delete process.env.BEGINNER_MODE_ENABLED;
  const hidden = await accounts.listTradingAccounts(owner);
  assert.equal(hidden.data.beginnerModeEnabled, false);
  assert.equal(
    hidden.data.accounts.some((a) => a.mode === 'beginner'),
    false,
  );
  await rejectsCode(
    fx.quoteForTradingAccount(owner, beginner.id, body),
    'BEGINNER_MODE_DISABLED',
  );
  await fx.executeForTradingAccount(owner, beginner.id, command); // committed replay survives disable
  process.env.BEGINNER_MODE_ENABLED = 'true';
  await db.tradingAccount.update({
    where: { id: beginner.id },
    data: { status: 'closed', closedAt: new Date() },
  });
  assert.equal((await opens.openBeginnerAccount(owner)).data.created, false);
  assert.equal(
    await db.walletTransaction.count({
      where: { tradingAccountId: beginner.id, txType: 'initial_grant' },
    }),
    1,
  );
  await db.equitySnapshot.delete({ where: { id: origin.id } });
  await assert.rejects(opens.openBeginnerAccount(owner));
  assert.equal(
    await db.equitySnapshot.count({
      where: {
        tradingAccountId: beginner.id,
        snapshotReason: 'general_account_open',
      },
    }),
    0,
    'damaged origins are never repaired by POST',
  );
  console.log(
    'beginner account DB integration passed: opt-in, concurrent open, unique grants, rollback, ownership, three-mode isolation, TWR, daily history, replay and no repair',
  );
}

async function cleanup() {
  const scope = { tradingAccount: { userId: { in: users } } };
  await db.seasonRanking.deleteMany({ where: scope });
  await db.walletTransfer.deleteMany({ where: scope });
  await db.fxExecuteRequest.deleteMany({ where: { userId: { in: users } } });
  await db.walletTransaction.deleteMany({ where: scope });
  await db.exchangeTransaction.deleteMany({ where: scope });
  await db.quote.deleteMany({ where: { userId: { in: users } } });
  await db.dailyPortfolioSnapshot.deleteMany({ where: scope });
  await db.equitySnapshot.deleteMany({ where: scope });
  await db.cashWallet.deleteMany({ where: scope });
  await db.seasonParticipant.deleteMany({ where: { userId: { in: users } } });
  await db.tradingAccount.deleteMany({ where: { userId: { in: users } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
  await db.season.deleteMany({ where: { id: { in: seasons } } });
  await db.fxRateSnapshot.deleteMany({ where: { id: { in: rates } } });
  await db.batchJobRun.deleteMany({
    where: { idempotencyKey: { in: [batchKey, `${batchKey}-settlement`] } },
  });
}
run()
  .finally(async () => {
    try {
      await cleanup();
    } finally {
      await db.$disconnect();
    }
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
