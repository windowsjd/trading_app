/** QUEST 01 progress against real PostgreSQL. Disposable local test DB only. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { GeneralAccountsService } from '../src/trading-accounts/general-accounts.service';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import { BeginnerQuestsService } from '../src/trading-accounts/beginner-quests.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { GeneralExternalFundingService } from '../src/portfolio/general-external-funding.service';
import { GeneralAccountPerformanceService } from '../src/portfolio/general-account-performance.service';
import { FxService, type FxExecuteSuccessResponse } from '../src/fx/fx.service';
import { TradingAccountWalletTransferService } from '../src/wallets/trading-account-wallet-transfer.service';
import { TradingAccountWalletFxTransferService } from '../src/wallets/trading-account-wallet-fx-transfer.service';
import { SeasonsService } from '../src/seasons/seasons.service';

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
const valuation = new PortfolioValuationService(db);
const performance = new GeneralAccountPerformanceService(
  db,
  valuation,
  new GeneralExternalFundingService(db),
);
const opens = new GeneralAccountsService(db, performance);
const quests = new BeginnerQuestsService(db, access, performance);
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
const composite = new TradingAccountWalletFxTransferService(
  db,
  access,
  fx,
  transfers,
);
const users: string[] = [];
const seasons: string[] = [];
const rates: string[] = [];

async function user() {
  const id = randomUUID();
  await db.user.create({
    data: {
      id,
      email: `${id}@quest.example`,
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
async function freshRate(rate: string) {
  const row = await db.fxRateSnapshot.create({
    data: {
      baseCurrency: 'USD',
      quoteCurrency: 'KRW',
      rate,
      sourceType: 'provider_api',
      sourceName: 'korea_exim_exchange_rate',
      capturedAt: new Date(Date.now() - 1000),
      effectiveAt: new Date(Date.now() - 1000),
    },
  });
  rates.push(row.id);
}
async function progress(userId: string, accountId: string) {
  const response = await quests.getQuestProgress(userId, accountId);
  assert.equal(response.data.tradingAccountId, accountId);
  assert.equal(response.data.quests.length, 1);
  const [quest] = response.data.quests;
  assert.equal(quest.questId, 'common-01-trading-funds');
  assert.equal(quest.totalStepCount, 2);
  return {
    status: quest.status,
    count: quest.completedStepCount,
    fxId: quest.steps[0].referenceId,
    transferId: quest.steps[1].referenceId,
  };
}
async function rowCounts(accountId: string) {
  const where = { tradingAccountId: accountId };
  return Promise.all([
    db.exchangeTransaction.count({ where }),
    db.walletTransfer.count({ where }),
    db.walletTransaction.count({ where }),
    db.fxExecuteRequest.count({ where }),
    db.quote.count({ where }),
    db.equitySnapshot.count({ where }),
  ]);
}
async function wallet(accountId: string, scope: string, currency = 'USD') {
  return db.cashWallet.findFirstOrThrow({
    where: {
      tradingAccountId: accountId,
      walletScope: scope as 'securities',
      currencyCode: currency as 'USD',
    },
  });
}
async function fxKrwToUsd(userId: string, accountId: string, amount: string) {
  const body = { fromCurrency: 'KRW', toCurrency: 'USD', sourceAmount: amount };
  const quote = await fx.quoteForTradingAccount(userId, accountId, body);
  const command = {
    ...body,
    quoteId: quote.data.quoteId,
    idempotencyKey: randomUUID(),
  };
  return {
    command,
    result: (await fx.executeForTradingAccount(
      userId,
      accountId,
      command,
    )) as FxExecuteSuccessResponse,
  };
}
async function usdTransfer(
  userId: string,
  accountId: string,
  from: string,
  to: string,
  amount: string,
  idempotencyKey = randomUUID(),
) {
  return transfers.transfer(userId, accountId, {
    sourceWalletId: (await wallet(accountId, from)).id,
    destinationWalletId: (await wallet(accountId, to)).id,
    amount,
    idempotencyKey,
  });
}
async function compositeKrwToSpot(userId: string, accountId: string) {
  const quote = await composite.quote(userId, accountId, {
    sourceWalletId: (await wallet(accountId, 'securities', 'KRW')).id,
    destinationWalletId: (await wallet(accountId, 'crypto_spot')).id,
    amount: '140000',
  });
  return composite.execute(userId, accountId, {
    quoteId: quote.data.quoteId,
    idempotencyKey: randomUUID(),
  });
}

async function run() {
  await db.$connect();
  process.env.GENERAL_FX_FEE_RATE = '0.001000';
  const owner = await user();
  const beginner = (await opens.openBeginnerAccount(owner)).data.account;
  const general = (await opens.openGeneralAccount(owner)).data.account;
  const season = await db.season.create({
    data: {
      name: `quest-${randomUUID()}`,
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
  const seasonAccount = await db.tradingAccount.findFirstOrThrow({
    where: { userId: owner, mode: 'season' },
  });
  await freshRate('1400');

  // A fresh beginner starts at 0/2 and reading progress writes nothing.
  const fresh = await rowCounts(beginner.id);
  assert.deepEqual(await progress(owner, beginner.id), {
    status: 'not_started',
    count: 0,
    fxId: null,
    transferId: null,
  });
  assert.deepEqual(await rowCounts(beginner.id), fresh);

  // A quote alone, and an execute refused after the rate moved, prove nothing.
  const body = {
    fromCurrency: 'KRW',
    toCurrency: 'USD',
    sourceAmount: '1400000',
  };
  const staleQuote = await fx.quoteForTradingAccount(owner, beginner.id, body);
  assert.equal((await progress(owner, beginner.id)).count, 0);
  await freshRate('1500');
  await rejectsCode(
    fx.executeForTradingAccount(owner, beginner.id, {
      ...body,
      quoteId: staleQuote.data.quoteId,
      idempotencyKey: randomUUID(),
    }),
    'RATE_CHANGED_REQUOTE_REQUIRED',
  );
  assert.equal(
    await db.exchangeTransaction.count({
      where: { tradingAccountId: beginner.id },
    }),
    0,
  );
  assert.equal((await progress(owner, beginner.id)).status, 'not_started');

  // The same user's General and Season practice never counts for Beginner,
  // and those accounts have no quest surface at all.
  for (const other of [general.id, seasonAccount.id]) {
    await fxKrwToUsd(owner, other, '1500000');
    await usdTransfer(owner, other, 'securities', 'crypto_spot', '10');
    await rejectsCode(
      quests.getQuestProgress(owner, other),
      'BEGINNER_QUEST_ACCOUNT_ONLY',
    );
  }
  assert.equal((await progress(owner, beginner.id)).status, 'not_started');

  // Step 1: a committed standalone KRW → USD FX.
  const { command, result } = await fxKrwToUsd(owner, beginner.id, '1500000');
  const afterFx = await progress(owner, beginner.id);
  assert.deepEqual(afterFx, {
    status: 'in_progress',
    count: 1,
    fxId: result.data.exchangeId,
    transferId: null,
  });
  // A lost response is recovered by replaying the same command: one row, same proof.
  const replay = (await fx.executeForTradingAccount(
    owner,
    beginner.id,
    command,
  )) as FxExecuteSuccessResponse;
  assert.equal(replay.data.exchangeId, result.data.exchangeId);
  assert.equal(
    await db.exchangeTransaction.count({
      where: { tradingAccountId: beginner.id },
    }),
    1,
  );
  assert.deepEqual(await progress(owner, beginner.id), afterFx);

  // The wrong destination (Futures) does not complete step 2.
  await usdTransfer(owner, beginner.id, 'securities', 'crypto_futures', '5');
  assert.equal((await progress(owner, beginner.id)).status, 'in_progress');

  // Step 2: Securities USD → Crypto Spot USD, replayed once.
  const transferKey = randomUUID();
  const moved = await usdTransfer(
    owner,
    beginner.id,
    'securities',
    'crypto_spot',
    '10',
    transferKey,
  );
  const done = await progress(owner, beginner.id);
  assert.deepEqual(done, {
    status: 'completed',
    count: 2,
    fxId: result.data.exchangeId,
    transferId: moved.data.transferId,
  });
  const replayed = await usdTransfer(
    owner,
    beginner.id,
    'securities',
    'crypto_spot',
    '10',
    transferKey,
  );
  assert.equal(replayed.data.transferId, moved.data.transferId);
  await usdTransfer(owner, beginner.id, 'crypto_spot', 'securities', '3');
  assert.deepEqual(await progress(owner, beginner.id), done);

  // Ownership and durable progress across repeated reads.
  const stranger = await user();
  await rejectsCode(
    quests.getQuestProgress(stranger, beginner.id),
    'TRADING_ACCOUNT_NOT_FOUND',
  );
  assert.deepEqual(await progress(owner, beginner.id), done);
  const settled = await rowCounts(beginner.id);
  await progress(owner, beginner.id);
  assert.deepEqual(await rowCounts(beginner.id), settled, 'GET never writes');

  // A composite FX+transfer writes BOTH legs yet completes neither step, and
  // a transfer committed before the first standalone FX does not count.
  const second = await user();
  const other = (await opens.openBeginnerAccount(second)).data.account;
  await compositeKrwToSpot(second, other.id);
  assert.equal(
    await db.exchangeTransaction.count({
      where: { tradingAccountId: other.id },
    }),
    1,
  );
  assert.equal(
    await db.walletTransfer.count({ where: { tradingAccountId: other.id } }),
    1,
  );
  assert.equal((await progress(second, other.id)).status, 'not_started');
  await usdTransfer(second, other.id, 'crypto_spot', 'securities', '20');
  await usdTransfer(second, other.id, 'securities', 'crypto_spot', '10');
  assert.equal((await progress(second, other.id)).status, 'not_started');
  const otherFx = await fxKrwToUsd(second, other.id, '150000');
  assert.deepEqual(await progress(second, other.id), {
    status: 'in_progress',
    count: 1,
    fxId: otherFx.result.data.exchangeId,
    transferId: null,
  });
  await compositeKrwToSpot(second, other.id);
  assert.equal((await progress(second, other.id)).status, 'in_progress');
  const otherMove = await usdTransfer(
    second,
    other.id,
    'securities',
    'crypto_spot',
    '1',
  );
  assert.deepEqual(await progress(second, other.id), {
    status: 'completed',
    count: 2,
    fxId: otherFx.result.data.exchangeId,
    transferId: otherMove.data.transferId,
  });
  // Each account sees only its own proof.
  assert.equal(
    (await progress(owner, beginner.id)).transferId,
    moved.data.transferId,
  );
  console.log(
    'beginner quest DB integration passed: derived 0/1/2 progress, quote/failure/composite/order/foreign-mode exclusion, replay, ownership, durable reads and no writes',
  );
}

async function cleanup() {
  const scope = { tradingAccount: { userId: { in: users } } };
  await db.walletTransferExecuteRequest.deleteMany({ where: scope });
  await db.walletTransferQuote.deleteMany({
    where: { quote: { userId: { in: users } } },
  });
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
