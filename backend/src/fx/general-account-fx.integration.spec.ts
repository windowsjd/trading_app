import { spawnSync } from 'node:child_process';

/** PostgreSQL proof of the account-scoped general FX lifecycle. */
const RUN_DB_INTEGRATION = process.env.GENERAL_FX_DB_INTEGRATION === '1';
const itDbIntegration = RUN_DB_INTEGRATION ? it : it.skip;

describe('General account FX DB integration', () => {
  itDbIntegration(
    'executes deterministic KRW/USD FX without season side effects',
    () => {
      const prepare = spawnSync(
        process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        ['run', '--silent', 'test:db:prepare'],
        {
          cwd: process.cwd(),
          env: process.env,
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      if (prepare.status !== 0) {
        throw new Error(
          [
            'General FX DB prepare failed.',
            prepare.stdout,
            prepare.stderr,
          ].join('\n'),
        );
      }

      const result = spawnSync(
        process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        ['tsx', '-e', GENERAL_FX_DB_RUNNER],
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
            'General FX DB runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }
      expect(result.stdout).toContain('general fx db integration ok');
    },
    260_000,
  );
});

const GENERAL_FX_DB_RUNNER = `
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { PrismaService } from './src/prisma/prisma.service';
import { TradingAccountAccessService } from './src/trading-accounts/trading-account-access.service';
import { GeneralAccountsService } from './src/trading-accounts/general-accounts.service';
import { PortfolioValuationService } from './src/portfolio/portfolio-valuation.service';
import { GeneralExternalFundingService } from './src/portfolio/general-external-funding.service';
import { GeneralAccountPerformanceService } from './src/portfolio/general-account-performance.service';
import { FxService } from './src/fx/fx.service';

process.env.GENERAL_FX_FEE_RATE = '0.001000';
const prisma = new PrismaService();
const access = new TradingAccountAccessService(prisma);
const valuation = new PortfolioValuationService(prisma);
const funding = new GeneralExternalFundingService(prisma);
const performance = new GeneralAccountPerformanceService(prisma, valuation, funding);
const generalAccounts = new GeneralAccountsService(prisma, performance);
const fx = new FxService(prisma, undefined, undefined, access, performance);
const ids = { users: [], accounts: [], seasons: [], participants: [], rates: [] };

function codeOf(error) {
  assert.ok(error instanceof HttpException, 'expected HttpException');
  return error.getResponse().error.code;
}
async function expectCode(work, code) {
  try { await work; } catch (error) { assert.equal(codeOf(error), code); return; }
  assert.fail('expected ' + code);
}
async function user(label) {
  const id = randomUUID();
  await prisma.user.create({ data: {
    id, email: 'general-fx-' + label + '-' + id + '@example.com',
    passwordHash: 'integration-only', nickname: 'general-fx-' + label + '-' + id.slice(0, 8),
  }});
  ids.users.push(id); return id;
}
async function general(userId) {
  const result = await generalAccounts.openGeneralAccount(userId);
  ids.accounts.push(result.data.account.id); return result.data.account.id;
}
async function rate(value) {
  const at = new Date(Date.now() - 250);
  const row = await prisma.fxRateSnapshot.create({ data: {
    baseCurrency: 'USD', quoteCurrency: 'KRW', rate: value,
    sourceType: 'provider_api', sourceName: 'korea_exim_exchange_rate',
    effectiveAt: at, capturedAt: at,
  }, select: { id: true } });
  ids.rates.push(row.id); return row.id;
}
async function quote(userId, accountId, fromCurrency, toCurrency, sourceAmount) {
  return fx.quoteForTradingAccount(userId, accountId, { fromCurrency, toCurrency, sourceAmount });
}
async function execute(userId, accountId, quoted, key) {
  return fx.executeForTradingAccount(userId, accountId, {
    quoteId: quoted.data.quoteId, fromCurrency: quoted.data.fromCurrency,
    toCurrency: quoted.data.toCurrency, sourceAmount: quoted.data.sourceAmount,
    idempotencyKey: key,
  });
}
async function pollutionParticipant(userId) {
  const now = new Date();
  const season = await prisma.season.create({ data: {
    name: 'general-fx-pollution-' + randomUUID(), status: 'active',
    startAt: new Date(now.getTime() - 60_000), endAt: new Date(now.getTime() + 86_400_000),
    initialCapitalKrw: '10000000', tradeFeeRate: '0.001', fxFeeRate: '0.001',
  }, select: { id: true }});
  ids.seasons.push(season.id);
  const account = await prisma.tradingAccount.create({ data: {
    userId, mode: 'season', status: 'active', initialCapitalKrw: '10000000', openedAt: now,
  }, select: { id: true }});
  ids.accounts.push(account.id);
  const participant = await prisma.seasonParticipant.create({ data: {
    seasonId: season.id, userId, tradingAccountId: account.id, joinedAt: now,
    participantStatus: 'active', initialCapitalKrw: '10000000',
    totalAssetKrw: '10000000', totalReturnRate: '0', maxDrawdown: '0',
  }, select: { id: true }});
  ids.participants.push(participant.id); return participant.id;
}

async function main() {
 try {
  await prisma.onModuleInit();
  const owner = await user('owner');
  const other = await user('other');
  const account = await general(owner);
  const otherAccount = await general(other);
  const participantCountBeforeCore = await prisma.seasonParticipant.count();
  const rankingCountBeforeCore = await prisma.seasonRanking.count();
  await rate('1400');

  const krwUsd = await quote(owner, account, 'KRW', 'USD', '140000');
  assert.equal(krwUsd.data.feeRate, '0.001000');
  const storedQuote = await prisma.quote.findUniqueOrThrow({ where: { id: krwUsd.data.quoteId } });
  assert.equal(storedQuote.tradingAccountId, account);
  assert.equal(storedQuote.seasonParticipantId, null);
  assert.equal(storedQuote.quotedFeeRate?.toFixed(6), '0.001000');

  await rate('1401');
  process.env.GENERAL_FX_FEE_RATE = '0.002000';
  const key = 'general-fx-pinned-' + randomUUID();
  const first = await execute(owner, account, krwUsd, key);
  process.env.GENERAL_FX_FEE_RATE = '0.001000';
  assert.equal(first.data.feeRate, '0.001000');
  assert.equal(first.data.appliedRate, '1401.00000000');
  const command = await prisma.fxExecuteRequest.findFirstOrThrow({
    where: { tradingAccountId: account, idempotencyKey: key },
  });
  const exchange = await prisma.exchangeTransaction.findUniqueOrThrow({
    where: { id: command.exchangeTransactionId },
  });
  assert.equal(command.seasonParticipantId, null);
  assert.equal(exchange.seasonParticipantId, null);
  assert.equal(exchange.feeRate.toFixed(6), '0.001000');
  assert.equal(
    (await prisma.quote.findUniqueOrThrow({ where: { id: krwUsd.data.quoteId } })).status,
    'consumed',
  );
  assert.equal(first.data.sourceWalletBalanceAfter, '9860000.00000000');
  assert.ok(Number(first.data.targetWalletBalanceAfter) > 0);
  assert.equal(exchange.sourceAmount.toFixed(8), first.data.sourceAmount);
  assert.equal(exchange.netTargetAmount.toFixed(8), first.data.netTargetAmount);
  const ledgers = await prisma.walletTransaction.findMany({
    where: { referenceType: 'exchange_transaction', referenceId: exchange.id },
  });
  assert.equal(ledgers.length, 2);
  assert.ok(ledgers.every((row) => row.tradingAccountId === account && row.seasonParticipantId === null));
  assert.equal(ledgers.filter((row) => row.txType === 'exchange_source' && row.direction === 'debit').length, 1);
  assert.equal(ledgers.filter((row) => row.txType === 'exchange_target' && row.direction === 'credit').length, 1);

  const replay = await execute(owner, account, krwUsd, key);
  assert.deepEqual(replay, first);
  assert.equal(await prisma.exchangeTransaction.count({ where: { tradingAccountId: account } }), 1);
  await expectCode(
    fx.executeForTradingAccount(owner, account, {
      quoteId: krwUsd.data.quoteId, fromCurrency: 'KRW', toCurrency: 'USD',
      sourceAmount: '140001', idempotencyKey: key,
    }),
    'IDEMPOTENCY_CONFLICT',
  );

  const otherQuote = await quote(other, otherAccount, 'KRW', 'USD', '1401');
  const otherResult = await execute(other, otherAccount, otherQuote, key);
  assert.equal(otherResult.success, true);
  await expectCode(quote(other, account, 'KRW', 'USD', '1000'), 'TRADING_ACCOUNT_NOT_FOUND');

  const reverseQuote = await quote(owner, account, 'USD', 'KRW', '10');
  const reverse = await execute(owner, account, reverseQuote, 'general-fx-reverse-' + randomUUID());
  assert.equal(reverse.data.fromCurrency, 'USD');
  assert.equal(reverse.data.feeCurrency, 'KRW');

  const concurrentQuote = await quote(owner, account, 'KRW', 'USD', '1401');
  const concurrentKey = 'general-fx-concurrent-' + randomUUID();
  const [concurrentA, concurrentB] = await Promise.all([
    execute(owner, account, concurrentQuote, concurrentKey),
    execute(owner, account, concurrentQuote, concurrentKey),
  ]);
  assert.deepEqual(concurrentB, concurrentA);
  assert.equal(await prisma.fxExecuteRequest.count({
    where: { tradingAccountId: account, idempotencyKey: concurrentKey },
  }), 1);

  const snapshots = await prisma.equitySnapshot.findMany({
    where: { tradingAccountId: account, snapshotReason: 'exchange_executed' },
    orderBy: { capturedAt: 'asc' },
  });
  assert.equal(snapshots.length, 3);
  assert.ok(snapshots.every((row) => row.seasonParticipantId === null));
  assert.ok(snapshots.every((row) => row.cumulativeExternalFundingKrw?.toFixed(8) === '10000000.00000000'));
  assert.ok(snapshots.every((row) => row.timeWeightedReturnFactor !== null));
  assert.equal(await prisma.seasonParticipant.count(), participantCountBeforeCore);
  assert.equal(await prisma.seasonRanking.count(), rankingCountBeforeCore);

  const krwWallet = await prisma.cashWallet.findUniqueOrThrow({ where: {
    tradingAccountId_currencyCode: { tradingAccountId: account, currencyCode: 'KRW' },
  }});
  await prisma.cashWallet.update({ where: { id: krwWallet.id }, data: { reservedAmount: krwWallet.balanceAmount.sub('1') } });
  await expectCode(quote(owner, account, 'KRW', 'USD', '2'), 'INSUFFICIENT_BALANCE');
  await prisma.cashWallet.update({ where: { id: krwWallet.id }, data: { reservedAmount: '0' } });

  const requote = await quote(owner, account, 'KRW', 'USD', '1401');
  await rate('1420');
  await expectCode(execute(owner, account, requote, 'general-fx-requote-' + randomUUID()), 'RATE_CHANGED_REQUOTE_REQUIRED');

  await rate('1420');
  const staleQuote = await quote(owner, account, 'KRW', 'USD', '1420');
  const staleAt = new Date(Date.now() - 120_000);
  await prisma.fxRateSnapshot.updateMany({
    where: { id: { in: ids.rates } }, data: { capturedAt: staleAt, effectiveAt: staleAt },
  });
  await expectCode(execute(owner, account, staleQuote, 'general-fx-stale-' + randomUUID()), 'PROVIDER_RATE_STALE');
  await rate('1420');

  const nullFeeQuote = await quote(owner, account, 'KRW', 'USD', '1420');
  await prisma.quote.update({ where: { id: nullFeeQuote.data.quoteId }, data: { quotedFeeRate: null } });
  await expectCode(execute(owner, account, nullFeeQuote, 'general-fx-null-fee-' + randomUUID()), 'QUOTE_MISMATCH');
  await prisma.quote.update({ where: { id: nullFeeQuote.data.quoteId }, data: { quotedFeeRate: '0.001000' } });

  await prisma.cashWallet.update({ where: { id: krwWallet.id }, data: { tradingAccountId: null } });
  await expectCode(quote(owner, account, 'KRW', 'USD', '1420'), 'GENERAL_ACCOUNT_INTEGRITY');
  await prisma.cashWallet.update({ where: { id: krwWallet.id }, data: { tradingAccountId: account } });

  const participant = await pollutionParticipant(owner);
  const participantCountBeforePollution = await prisma.seasonParticipant.count();
  const rankingCountBeforePollution = await prisma.seasonRanking.count();
  const usdWallet = await prisma.cashWallet.findUniqueOrThrow({ where: {
    tradingAccountId_currencyCode: { tradingAccountId: account, currencyCode: 'USD' },
  }});
  await prisma.cashWallet.update({ where: { id: usdWallet.id }, data: { seasonParticipantId: participant } });
  await expectCode(quote(owner, account, 'USD', 'KRW', '1'), 'GENERAL_ACCOUNT_INTEGRITY');
  await prisma.cashWallet.update({ where: { id: usdWallet.id }, data: { seasonParticipantId: null } });

  const pollutedQuote = await quote(owner, account, 'KRW', 'USD', '1420');
  await prisma.quote.update({ where: { id: pollutedQuote.data.quoteId }, data: { seasonParticipantId: participant } });
  await expectCode(execute(owner, account, pollutedQuote, 'general-fx-polluted-' + randomUUID()), 'GENERAL_ACCOUNT_INTEGRITY');
  await prisma.quote.update({ where: { id: pollutedQuote.data.quoteId }, data: { seasonParticipantId: null } });

  const foreignQuote = await quote(owner, account, 'KRW', 'USD', '1420');
  await prisma.quote.update({ where: { id: foreignQuote.data.quoteId }, data: { tradingAccountId: otherAccount } });
  await expectCode(execute(owner, account, foreignQuote, 'general-fx-foreign-' + randomUUID()), 'QUOTE_MISMATCH');
  await prisma.quote.update({ where: { id: foreignQuote.data.quoteId }, data: { tradingAccountId: account } });

  await prisma.quote.update({ where: { id: foreignQuote.data.quoteId }, data: { userId: other } });
  await expectCode(fx.getExchangesForTradingAccount(owner, account), 'GENERAL_ACCOUNT_INTEGRITY');
  await prisma.quote.update({ where: { id: foreignQuote.data.quoteId }, data: { userId: owner } });

  const statusQuote = await quote(owner, account, 'KRW', 'USD', '1420');
  await prisma.tradingAccount.update({ where: { id: account }, data: { status: 'suspended' } });
  await expectCode(quote(owner, account, 'KRW', 'USD', '1000'), 'TRADING_ACCOUNT_NOT_ACTIVE');
  await expectCode(execute(owner, account, statusQuote, 'general-fx-suspended-' + randomUUID()), 'TRADING_ACCOUNT_NOT_ACTIVE');
  const history = await fx.getExchangesForTradingAccount(owner, account);
  assert.equal(history.data.exchanges.length, 3);
  assert.deepEqual(await execute(owner, account, krwUsd, key), first);
  await prisma.tradingAccount.update({ where: { id: account }, data: { status: 'closed', closedAt: new Date() } });
  await expectCode(quote(owner, account, 'KRW', 'USD', '1000'), 'TRADING_ACCOUNT_NOT_ACTIVE');
  await expectCode(execute(owner, account, statusQuote, 'general-fx-closed-' + randomUUID()), 'TRADING_ACCOUNT_NOT_ACTIVE');
  assert.equal((await fx.getExchangesForTradingAccount(owner, account)).data.exchanges.length, 3);
  assert.deepEqual(await execute(owner, account, krwUsd, key), first);
  await prisma.tradingAccount.update({ where: { id: account }, data: { status: 'active', closedAt: null } });

  await prisma.exchangeTransaction.update({ where: { id: exchange.id }, data: { seasonParticipantId: participant } });
  await expectCode(fx.getExchangesForTradingAccount(owner, account), 'GENERAL_ACCOUNT_INTEGRITY');
  await prisma.exchangeTransaction.update({ where: { id: exchange.id }, data: { seasonParticipantId: null } });

  assert.equal(await prisma.seasonParticipant.count(), participantCountBeforePollution);
  assert.equal(await prisma.seasonRanking.count(), rankingCountBeforePollution);
  console.log('general fx db integration ok');
 } finally { await cleanup(); await prisma.$disconnect(); }
}

async function cleanup() {
  if (ids.accounts.length) {
    const where = { tradingAccountId: { in: ids.accounts } };
    await prisma.fxExecuteRequest.deleteMany({ where });
    await prisma.walletTransaction.deleteMany({ where });
    await prisma.exchangeTransaction.deleteMany({ where });
    await prisma.equitySnapshot.deleteMany({ where });
    await prisma.dailyPortfolioSnapshot.deleteMany({ where });
    await prisma.quote.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.position.deleteMany({ where });
    await prisma.cashWallet.deleteMany({ where });
    await prisma.seasonParticipant.deleteMany({ where });
    await prisma.tradingAccount.deleteMany({ where: { id: { in: ids.accounts } } });
  }
  if (ids.seasons.length) await prisma.season.deleteMany({ where: { id: { in: ids.seasons } } });
  if (ids.rates.length) await prisma.fxRateSnapshot.deleteMany({ where: { id: { in: ids.rates } } });
  if (ids.users.length) await prisma.user.deleteMany({ where: { id: { in: ids.users } } });
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
`;
