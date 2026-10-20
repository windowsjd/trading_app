/**
 * General-account reset + ad reward purpose — real PostgreSQL (2026-10-20).
 * Run only against a disposable local test DB (see the guard below).
 *
 * Covers: reset of a fresh account; reset after FX, transfers, a profitable
 * spot round trip, a closed Futures lifetime and ad rewards (balance above and
 * below the target); every blocker; rollback on an injected failure;
 * ownership / mode / status / feature / registry / verification / purpose
 * refusals; command and event idempotency across BOTH purposes; concurrency;
 * performance after the reset (trading, ad reward, daily job, history window);
 * preserved history and opening grant; the read-only audit; and member
 * deletion of reset rows.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { PrismaService } from '../src/prisma/prisma.service';
import { Prisma } from '../src/generated/prisma/client';
import { GeneralAccountsService } from '../src/trading-accounts/general-accounts.service';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { PortfolioValuationError } from '../src/portfolio/portfolio-valuation.policy';
import { GeneralExternalFundingService } from '../src/portfolio/general-external-funding.service';
import { GeneralAccountPerformanceService } from '../src/portfolio/general-account-performance.service';
import { TradingAccountPortfolioService } from '../src/portfolio/trading-account-portfolio.service';
import { OrdersService } from '../src/orders/orders.service';
import { OrderReservationService } from '../src/orders/order-reservation.service';
import { LimitOrderCreateService } from '../src/orders/limit-order-create.service';
import { LimitOrderCancelService } from '../src/orders/limit-order-cancel.service';
import { FxService } from '../src/fx/fx.service';
import { TradingAccountWalletTransferService } from '../src/wallets/trading-account-wallet-transfer.service';
import { SeasonsService } from '../src/seasons/seasons.service';
import { AdRewardService } from '../src/ad-rewards/ad-reward.service';
import {
  AdRewardVerificationRegistry,
  type AdRewardVerifier,
} from '../src/ad-rewards/ad-reward-verifier';
import { GeneralAccountResetService } from '../src/ad-rewards/general-account-reset.service';
import { BatchService } from '../src/batch/batch.service';
import { GeneralDailySnapshotJobService } from '../src/batch/general-daily-snapshot-job.service';
import { auditGeneralAccounts } from './lib/audit-general-accounts';
import { purgeDeletionScope } from '../src/auth/account-deletion.purge';

const target = new URL(process.env.DATABASE_URL ?? 'http://invalid');
const disposableDatabase =
  target.pathname.endsWith('_test') ||
  (process.env.GITHUB_ACTIONS === 'true' && target.pathname === '/trading_app');
if (
  process.env.NODE_ENV !== 'test' ||
  process.env.GENERAL_ACCOUNT_RESET_DB_INTEGRATION !== '1' ||
  !['127.0.0.1', 'localhost'].includes(target.hostname) ||
  !disposableDatabase
) {
  throw new Error(
    'Explicit opt-in and a local disposable test database are required.',
  );
}

process.env.LIMIT_ORDER_ENABLED = 'true';
process.env.GENERAL_TRADE_FEE_RATE = '0.001000';
process.env.GENERAL_FX_FEE_RATE = '0.001000';

const PROVIDER = 'reset-test';
const TEN_MILLION = '10000000.00000000';

const db = new PrismaService();
const access = new TradingAccountAccessService(db);
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
const reservation = new OrderReservationService();
const orders = new OrdersService(
  db,
  undefined,
  new LimitOrderCreateService(db, reservation),
  new LimitOrderCancelService(db, reservation),
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

/** A test-only verifier: the event id is the proof; the purpose is echoed
 * unless the proof says otherwise. Never registered by the app module. */
const fakeVerifier: AdRewardVerifier = {
  provider: PROVIDER,
  verify(request) {
    if (request.proof.startsWith('invalid')) {
      return Promise.resolve({
        ok: false,
        reasonCode: 'FAKE_REJECTED',
        reason: 'test rejection',
      });
    }
    const purpose = request.proof.startsWith('funding-only')
      ? 'funding'
      : request.proof.startsWith('reset-only')
        ? 'account_reset'
        : request.expectedPurpose;
    return Promise.resolve({
      ok: true,
      provider: PROVIDER,
      purpose,
      providerEventId: request.proof,
      occurredAt: new Date(),
      metadata: { source: 'fake' },
    });
  },
};
const registry = new AdRewardVerificationRegistry([fakeVerifier]);
const ads = new AdRewardService(db, access, registry, performance);
const resets = new GeneralAccountResetService(
  db,
  access,
  registry,
  performance,
  valuation,
);

const users: Array<{ id: string; email: string }> = [];
const assets: string[] = [];
const instruments: string[] = [];
const rates: string[] = [];
const seasons: string[] = [];
const batchKey = `account-reset-${randomUUID()}`;

function enableAds(enabled = true) {
  Object.assign(process.env, {
    AD_REWARD_ENABLED: enabled ? 'true' : 'false',
    AD_REWARD_PROVIDER: PROVIDER,
    AD_REWARD_AMOUNT_KRW: '5000000',
    AD_REWARD_DAILY_MAX_COUNT: '50',
    AD_REWARD_DAILY_MAX_AMOUNT_KRW: '250000000',
    AD_REWARD_COOLDOWN_SECONDS: '0',
    AD_REWARD_DAY_TIME_ZONE: 'Asia/Seoul',
  });
}

async function user() {
  const id = randomUUID();
  const email = `${id}@reset.example`;
  await db.user.create({
    data: { id, email, nickname: `reset-${id}`, passwordHash: 'test-only' },
  });
  users.push({ id, email });
  return id;
}

function codeOf(caught: unknown): string {
  assert.equal(caught instanceof HttpException, true, String(caught));
  return (
    (caught as HttpException).getResponse() as { error: { code: string } }
  ).error.code;
}

async function rejectsCode(work: Promise<unknown>, code: string) {
  await assert.rejects(work, (caught: unknown) => {
    assert.equal(codeOf(caught), code);
    return true;
  });
}

const money = (value: Prisma.Decimal | string | number) =>
  new Prisma.Decimal(value).toFixed(8);

async function wallets(accountId: string) {
  const rows = await db.cashWallet.findMany({
    where: { tradingAccountId: accountId },
    select: {
      id: true,
      walletScope: true,
      currencyCode: true,
      balanceAmount: true,
      reservedAmount: true,
    },
  });
  const pick = (scope: string, currency: string) =>
    rows.find((w) => w.walletScope === scope && w.currencyCode === currency)!;
  return {
    krw: pick('securities', 'KRW'),
    usd: pick('securities', 'USD'),
    spot: pick('crypto_spot', 'USD'),
    futures: pick('crypto_futures', 'USD'),
  };
}

async function rowCounts(accountId: string) {
  const [claims, resetRows, ledger, snapshots] = await Promise.all([
    db.adRewardClaim.count({ where: { tradingAccountId: accountId } }),
    db.generalAccountReset.count({ where: { tradingAccountId: accountId } }),
    db.walletTransaction.count({ where: { tradingAccountId: accountId } }),
    db.equitySnapshot.count({ where: { tradingAccountId: accountId } }),
  ]);
  return { claims, resetRows, ledger, snapshots };
}

/** Every order and ledger row of the account as written, for "kept as it was". */
async function pastHistory(accountId: string) {
  const [orderRows, ledgerRows] = await Promise.all([
    db.order.findMany({
      where: { tradingAccountId: accountId },
      orderBy: { id: 'asc' },
    }),
    db.walletTransaction.findMany({
      where: { tradingAccountId: accountId },
      orderBy: { id: 'asc' },
    }),
  ]);
  return JSON.stringify({ orderRows, ledgerRows });
}

async function summary(userId: string, accountId: string) {
  const read = await portfolio.getPortfolio(userId, accountId);
  assert.ok(read.data.summary, 'portfolio summary is available');
  return read.data.summary as typeof read.data.summary & {
    performanceEpoch: { sequence: number; startedAt: string };
  };
}

async function freshRate() {
  const at = new Date(Date.now() - 1_000);
  const row = await db.fxRateSnapshot.create({
    data: {
      baseCurrency: 'USD',
      quoteCurrency: 'KRW',
      rate: '1400',
      sourceType: 'provider_api',
      sourceName: 'exchange_rate_api',
      capturedAt: at,
      effectiveAt: at,
    },
    select: { id: true },
  });
  rates.push(row.id);
}

async function price(assetId: string, value: string) {
  const at = new Date();
  await db.assetPriceSnapshot.create({
    data: {
      assetId,
      price: value,
      currencyCode: 'USD',
      sourceType: 'provider_api',
      sourceName: 'binance_public_rest_24hr_ticker',
      effectiveAt: at,
      capturedAt: at,
    },
  });
}

async function cryptoAsset() {
  const asset = await db.asset.create({
    data: {
      symbol: `RS${randomUUID().replace(/-/gu, '').slice(0, 14).toUpperCase()}`,
      name: 'account-reset-integration',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
      isActive: true,
    },
    select: { id: true },
  });
  assets.push(asset.id);
  return asset.id;
}

async function exchange(userId: string, accountId: string, krw: string) {
  const body = { fromCurrency: 'KRW', toCurrency: 'USD', sourceAmount: krw };
  const quote = await fx.quoteForTradingAccount(userId, accountId, body);
  await fx.executeForTradingAccount(userId, accountId, {
    ...body,
    quoteId: quote.data.quoteId,
    idempotencyKey: randomUUID(),
  });
}

async function transfer(
  userId: string,
  accountId: string,
  sourceWalletId: string,
  destinationWalletId: string,
  amount: string,
) {
  await transfers.transfer(userId, accountId, {
    sourceWalletId,
    destinationWalletId,
    amount,
    idempotencyKey: randomUUID(),
  });
}

async function marketOrder(
  userId: string,
  accountId: string,
  assetId: string,
  side: 'buy' | 'sell',
  size: string,
) {
  const request =
    side === 'buy'
      ? { assetId, side, orderType: 'market', amount: size }
      : { assetId, side, orderType: 'market', quantity: size };
  const quote = await orders.quoteOrderForTradingAccount(
    userId,
    accountId,
    request,
  );
  return orders.createOrderForTradingAccount(userId, accountId, {
    ...request,
    quoteId: quote.data.quoteId,
    idempotencyKey: randomUUID(),
  });
}

async function eligibility(userId: string, accountId: string) {
  return (await resets.getEligibility(userId, accountId)).data;
}

async function run() {
  await db.$connect();
  enableAds();
  await freshRate();

  // ================================================================ 1
  // A fresh account: nothing moves, a new epoch still opens.
  const ownerA = await user();
  const accountA = (await opens.openGeneralAccount(ownerA)).data.account.id;
  const fresh = await eligibility(ownerA, accountA);
  assert.equal(fresh.enabled, true);
  assert.equal(fresh.eligible, true);
  assert.deepEqual(fresh.blockers, []);
  assert.equal(fresh.targetKrwBalance, TEN_MILLION);
  assert.equal(fresh.resetCount, 0);

  const keyA = randomUUID();
  const resetA = await resets.reset(ownerA, accountA, {
    provider: PROVIDER,
    proof: 'evt-a1',
    idempotencyKey: keyA,
  });
  assert.equal(resetA.data.reset, true);
  assert.equal(resetA.data.duplicate, false);
  assert.equal(resetA.data.sequence, 1);
  assert.equal(resetA.data.totalAssetKrw, TEN_MILLION);
  assert.deepEqual(
    resetA.data.wallets.map((w) => w.balanceAmount),
    [TEN_MILLION, '0.00000000', '0.00000000', '0.00000000'],
  );
  assert.equal(
    await db.walletTransaction.count({
      where: { tradingAccountId: accountA, txType: 'account_reset' },
    }),
    0,
    'an account already at its targets moves nothing',
  );
  const claimA = await db.adRewardClaim.findUniqueOrThrow({
    where: { id: resetA.data.claimId },
  });
  assert.equal(claimA.purpose, 'account_reset');
  assert.equal(claimA.status, 'granted');
  assert.equal(claimA.rewardAmountKrw.toString(), '0');
  assert.equal(claimA.walletTransactionId, null);
  const afterA = await summary(ownerA, accountA);
  assert.equal(afterA.totalAssetKrw, TEN_MILLION);
  assert.equal(afterA.investmentPnlKrw, '0.00000000');
  assert.equal(afterA.returnRate, '0.00000000');
  assert.equal(afterA.cumulativeExternalFundingKrw, TEN_MILLION);
  assert.equal(afterA.performanceEpoch.sequence, 1);
  assert.equal(afterA.performanceEpoch.startedAt, resetA.data.resetAt);

  // Command replay, conflicting key, same event under another key, and the
  // same event offered as a top-up: one event redeems ONE command.
  const countsA = await rowCounts(accountA);
  const replayA = await resets.reset(ownerA, accountA, {
    provider: PROVIDER,
    proof: 'evt-a1',
    idempotencyKey: keyA,
  });
  assert.equal(replayA.data.reset, false);
  assert.equal(replayA.data.duplicate, true);
  assert.equal(replayA.data.resetId, resetA.data.resetId);
  await rejectsCode(
    resets.reset(ownerA, accountA, {
      provider: PROVIDER,
      proof: 'evt-a1-other',
      idempotencyKey: keyA,
    }),
    'AD_REWARD_IDEMPOTENCY_CONFLICT',
  );
  const sameEvent = await resets.reset(ownerA, accountA, {
    provider: PROVIDER,
    proof: 'evt-a1',
    idempotencyKey: randomUUID(),
  });
  assert.equal(sameEvent.data.duplicate, true);
  assert.equal(sameEvent.data.resetId, resetA.data.resetId);
  await rejectsCode(
    ads.claim(ownerA, accountA, {
      provider: PROVIDER,
      proof: 'evt-a1',
      idempotencyKey: randomUUID(),
    }),
    'AD_REWARD_EVENT_ALREADY_USED',
  );
  await rejectsCode(
    ads.claim(ownerA, accountA, {
      provider: PROVIDER,
      proof: 'evt-a1-claim',
      idempotencyKey: keyA,
    }),
    'AD_REWARD_IDEMPOTENCY_CONFLICT',
  );
  assert.deepEqual(await rowCounts(accountA), countsA);
  // A funding event that redeemed a top-up never resets either.
  const topUpA = await ads.claim(ownerA, accountA, {
    provider: PROVIDER,
    proof: 'evt-a-topup',
    idempotencyKey: randomUUID(),
  });
  assert.equal(topUpA.data.granted, true);
  await rejectsCode(
    resets.reset(ownerA, accountA, {
      provider: PROVIDER,
      proof: 'evt-a-topup',
      idempotencyKey: randomUUID(),
    }),
    'AD_REWARD_EVENT_ALREADY_USED',
  );
  // The top-up's daily usage is unaffected by resets.
  const usageA = (await ads.getEligibility(ownerA, accountA)).data;
  assert.equal(usageA.grantedCountToday, 1);
  const claimListA = (await ads.listClaims(ownerA, accountA)).data.claims;
  assert.deepEqual(claimListA.map((c) => c.purpose).sort(), [
    'account_reset',
    'funding',
  ]);

  // ================================================================ 2
  // A used account: ad reward, FX, transfers, a profitable spot round trip,
  // a closed Futures lifetime — then every blocker, a rollback, the reset.
  const ownerB = await user();
  const accountB = (await opens.openGeneralAccount(ownerB)).data.account.id;
  const grantBefore = await db.walletTransaction.findFirstOrThrow({
    where: { tradingAccountId: accountB, txType: 'initial_grant' },
  });
  await ads.claim(ownerB, accountB, {
    provider: PROVIDER,
    proof: 'evt-b-topup-1',
    idempotencyKey: randomUUID(),
  });
  assert.equal(
    (await summary(ownerB, accountB)).cumulativeExternalFundingKrw,
    money('15000000'),
  );
  await exchange(ownerB, accountB, '1400000');
  let w = await wallets(accountB);
  await transfer(ownerB, accountB, w.usd.id, w.spot.id, '500');
  await transfer(ownerB, accountB, w.usd.id, w.futures.id, '100');

  const asset = await cryptoAsset();
  await price(asset, '100');
  await marketOrder(ownerB, accountB, asset, 'buy', '200');
  const held = await db.position.findFirstOrThrow({
    where: { tradingAccountId: accountB, assetId: asset },
  });
  assert.equal(held.quantity.gt(0), true);

  let blockers = await eligibility(ownerB, accountB);
  assert.equal(blockers.eligible, false);
  assert.equal(blockers.reason, 'GENERAL_ACCOUNT_RESET_BLOCKED');
  assert.deepEqual(blockers.blockers, ['SPOT_HOLDINGS']);
  await rejectsCode(
    resets.reset(ownerB, accountB, {
      provider: PROVIDER,
      proof: 'evt-b-blocked-1',
      idempotencyKey: randomUUID(),
    }),
    'GENERAL_ACCOUNT_RESET_BLOCKED',
  );

  await price(asset, '110');
  await marketOrder(ownerB, accountB, asset, 'sell', held.quantity.toFixed(8));
  const closedPosition = await db.position.findFirstOrThrow({
    where: { tradingAccountId: accountB, assetId: asset },
  });
  assert.equal(closedPosition.quantity.isZero(), true);
  assert.equal(
    closedPosition.realizedPnl.gt(0),
    true,
    'a profitable round trip',
  );
  assert.equal(
    new Prisma.Decimal((await summary(ownerB, accountB)).realizedPnlKrw).gt(0),
    true,
  );

  // A limit BUY reserves cash: open order + reserved funds.
  const limitRequest = {
    assetId: asset,
    side: 'buy',
    orderType: 'limit',
    amount: '50',
    limitPrice: '50',
  };
  const limitQuote = await orders.quoteOrderForTradingAccount(
    ownerB,
    accountB,
    limitRequest,
  );
  const limitOrder = await orders.createOrderForTradingAccount(
    ownerB,
    accountB,
    {
      ...limitRequest,
      quoteId: limitQuote.data.quoteId,
      idempotencyKey: randomUUID(),
    },
  );
  blockers = await eligibility(ownerB, accountB);
  assert.deepEqual(blockers.blockers, ['OPEN_ORDERS', 'RESERVED_FUNDS']);
  await orders.cancelOrderForTradingAccount(
    ownerB,
    accountB,
    (limitOrder as { data: { order: { orderId: string } } }).data.order.orderId,
  );

  // A watching conditional BUY.
  const conditional = await db.conditionalBuyOrder.create({
    data: {
      tradingAccountId: accountB,
      assetId: asset,
      triggerCondition: 'at_or_below',
      triggerPrice: '90',
      executionType: 'market',
      amount: '10',
      currencyCode: 'USD',
      idempotencyKey: randomUUID(),
      requestHash: 'fixture',
    },
    select: { id: true },
  });
  blockers = await eligibility(ownerB, accountB);
  assert.deepEqual(blockers.blockers, ['ACTIVE_CONDITIONAL_ORDERS']);
  await db.conditionalBuyOrder.update({
    where: { id: conditional.id },
    data: { status: 'canceled', endedAt: new Date() },
  });

  // An open Futures position, then its closed lifetime (history stays).
  const instrument = await db.futuresInstrument.create({
    data: { underlyingAssetId: asset },
    select: { id: true },
  });
  instruments.push(instrument.id);
  const futuresPosition = await db.futuresPosition.create({
    data: {
      tradingAccountId: accountB,
      instrumentId: instrument.id,
      direction: 'long',
      quantity: '1',
      averageEntryPrice: '100',
      entryNotional: '100',
      leverage: 1,
      isolatedMargin: '100',
    },
    select: { id: true },
  });
  blockers = await eligibility(ownerB, accountB);
  assert.deepEqual(blockers.blockers, ['FUTURES_POSITIONS']);
  await db.futuresPosition.update({
    where: { id: futuresPosition.id },
    data: {
      status: 'closed',
      quantity: '0',
      isolatedMargin: '0',
      entryNotional: '0',
      closedAt: new Date(),
      realizedPnl: '7',
    },
  });
  blockers = await eligibility(ownerB, accountB);
  assert.equal(blockers.eligible, true);
  assert.deepEqual(blockers.blockers, []);

  // Rollback: a failure on the last write leaves NOTHING behind.
  w = await wallets(accountB);
  assert.equal(
    w.krw.balanceAmount.gt(TEN_MILLION),
    true,
    'balance above target',
  );
  const beforeFailure = await rowCounts(accountB);
  const failing = new GeneralAccountResetService(
    failOnSnapshotCreate(),
    access,
    registry,
    performance,
    valuation,
  );
  await assert.rejects(
    failing.reset(ownerB, accountB, {
      provider: PROVIDER,
      proof: 'evt-b-failed',
      idempotencyKey: randomUUID(),
    }),
    /injected reset failure/,
  );
  assert.deepEqual(await rowCounts(accountB), beforeFailure);
  const unchanged = await wallets(accountB);
  for (const key of ['krw', 'usd', 'spot', 'futures'] as const) {
    assert.equal(
      unchanged[key].balanceAmount.toString(),
      w[key].balanceAmount.toString(),
    );
  }
  assert.equal(
    (
      await db.position.findFirstOrThrow({ where: { id: closedPosition.id } })
    ).realizedPnl.toString(),
    closedPosition.realizedPnl.toString(),
  );

  // The ended epoch cannot be valued (USD cash, no current rate): refused
  // BEFORE the ad is verified — eligibility says so, the proof never reaches
  // the provider, and the completion stays unused.
  assert.equal(
    w.usd.balanceAmount.add(w.spot.balanceAmount).gt(0),
    true,
    'USD cash held',
  );
  let unvaluedVerifies = 0;
  const unvalued = new GeneralAccountResetService(
    db,
    access,
    new AdRewardVerificationRegistry([
      {
        provider: PROVIDER,
        verify(request) {
          unvaluedVerifies += 1;
          return fakeVerifier.verify(request);
        },
      },
    ]),
    performance,
    {
      calculateTradingAccountValuation: () =>
        Promise.reject(
          new PortfolioValuationError('FX_RATE_STALE', 'stale rate (test)'),
        ),
    } as unknown as PortfolioValuationService,
  );
  const unvaluedEligibility = await unvalued.getEligibility(ownerB, accountB);
  assert.equal(unvaluedEligibility.data.eligible, false);
  assert.equal(
    unvaluedEligibility.data.reason,
    'GENERAL_ACCOUNT_RESET_UNAVAILABLE',
  );
  assert.deepEqual(unvaluedEligibility.data.blockers, []);
  await rejectsCode(
    unvalued.reset(ownerB, accountB, {
      provider: PROVIDER,
      proof: 'evt-b-unvalued',
      idempotencyKey: randomUUID(),
    }),
    'GENERAL_ACCOUNT_RESET_UNAVAILABLE',
  );
  assert.equal(unvaluedVerifies, 0, 'no verification spent');
  assert.equal(
    await db.adRewardClaim.count({
      where: { providerEventId: 'evt-b-unvalued' },
    }),
    0,
  );
  assert.deepEqual(await rowCounts(accountB), beforeFailure);

  // The reset.
  const before = await summary(ownerB, accountB);
  const ordersBefore = await db.order.count({
    where: { tradingAccountId: accountB },
  });
  const ledgerBefore = await db.walletTransaction.count({
    where: { tradingAccountId: accountB },
  });
  const historyBeforeReset = await pastHistory(accountB);
  const resetB = await resets.reset(ownerB, accountB, {
    provider: PROVIDER,
    proof: 'evt-b-reset-1',
    idempotencyKey: randomUUID(),
  });
  assert.equal(resetB.data.sequence, 1);
  const resetRowB = await db.generalAccountReset.findUniqueOrThrow({
    where: { id: resetB.data.resetId },
  });
  assert.equal(
    resetRowB.closingExternalFundingKrw.toFixed(8),
    money('15000000'),
  );
  assert.equal(
    resetRowB.closingTotalAssetKrw.toFixed(8),
    before.totalAssetKrw,
    'the ended epoch is valued at the reset',
  );
  assert.equal(
    resetRowB.closingInvestmentPnlKrw.toFixed(8),
    money(new Prisma.Decimal(before.totalAssetKrw).sub('15000000')),
  );
  assert.equal(
    resetRowB.lifetimeExternalFundingKrw.toFixed(8),
    money('15000000'),
  );
  const rebased = resetRowB.positionsRebasedJson as Array<{
    positionId: string;
    realizedPnl: string;
    realizedPnlKrw: string;
  }>;
  assert.deepEqual(
    rebased.map((p) => [p.positionId, p.realizedPnl, p.realizedPnlKrw]),
    [
      [
        closedPosition.id,
        closedPosition.realizedPnl.toFixed(8),
        closedPosition.realizedPnlKrw.toFixed(8),
      ],
    ],
  );
  // The ended epoch's realized PnL, as the portfolio showed it just before
  // the reset, is exactly what the reset row keeps.
  assert.equal(
    money(
      rebased.reduce(
        (sum, p) => sum.add(p.realizedPnlKrw),
        new Prisma.Decimal(0),
      ),
    ),
    before.realizedPnlKrw,
  );

  const afterReset = await wallets(accountB);
  assert.equal(afterReset.krw.balanceAmount.toFixed(8), TEN_MILLION);
  for (const key of ['usd', 'spot', 'futures'] as const) {
    assert.equal(afterReset[key].balanceAmount.toFixed(8), '0.00000000');
    assert.equal(afterReset[key].reservedAmount.toFixed(8), '0.00000000');
  }
  const resetLedger = await db.walletTransaction.findMany({
    where: {
      referenceType: 'general_account_reset',
      referenceId: resetRowB.id,
    },
    orderBy: { walletId: 'asc' },
  });
  assert.equal(resetLedger.length, 4, 'every wallet moved: one row each');
  for (const row of resetLedger) {
    const wallet = [w.krw, w.usd, w.spot, w.futures].find(
      (x) => x.id === row.walletId,
    )!;
    const targetAmount = wallet === w.krw ? TEN_MILLION : '0';
    assert.equal(row.txType, 'account_reset');
    assert.equal(row.tradingAccountId, accountB);
    assert.equal(row.balanceAfter.toFixed(8), money(targetAmount));
    assert.equal(
      row.amount.toFixed(8),
      money(wallet.balanceAmount.sub(targetAmount).abs()),
    );
    assert.equal(
      row.direction,
      wallet.balanceAmount.gt(targetAmount) ? 'debit' : 'credit',
    );
    assert.equal(row.occurredAt.toISOString(), resetB.data.resetAt);
  }
  assert.equal(
    (
      await db.position.findFirstOrThrow({ where: { id: closedPosition.id } })
    ).realizedPnl.toFixed(8),
    '0.00000000',
  );
  const afterB = await summary(ownerB, accountB);
  assert.equal(afterB.totalAssetKrw, TEN_MILLION);
  assert.equal(afterB.investmentPnlKrw, '0.00000000');
  assert.equal(afterB.returnRate, '0.00000000');
  assert.equal(afterB.cumulativeExternalFundingKrw, TEN_MILLION);
  assert.equal(afterB.initialFundingKrw, TEN_MILLION);
  assert.equal(afterB.cumulativeAdRewardKrw, '0.00000000');
  assert.equal(afterB.realizedPnlKrw, '0.00000000');
  // History and the opening grant are kept as they were.
  assert.equal(
    await db.order.count({ where: { tradingAccountId: accountB } }),
    ordersBefore,
  );
  assert.equal(
    await db.walletTransaction.count({ where: { tradingAccountId: accountB } }),
    ledgerBefore + 4,
  );
  const grantAfter = await db.walletTransaction.findFirstOrThrow({
    where: { tradingAccountId: accountB, txType: 'initial_grant' },
  });
  assert.deepEqual(grantAfter, grantBefore);
  assert.equal(
    (
      await db.futuresPosition.findFirstOrThrow({
        where: { id: futuresPosition.id },
      })
    ).status,
    'closed',
  );
  // The chart is the new epoch only, starting at its origin.
  const history = await portfolio.getEquity(ownerB, accountB, { range: 'all' });
  const points = history.data.points;
  assert.equal(points[0].time, resetB.data.resetAt);
  assert.equal(points[0].snapshotReason, 'general_account_reset');
  assert.equal(
    points.every((p) => Date.parse(p.time) >= Date.parse(resetB.data.resetAt)),
    true,
  );

  // Trading after the reset: performance against the new principal.
  await freshRate();
  await exchange(ownerB, accountB, '1400000');
  const traded = await summary(ownerB, accountB);
  const tradedPnl = new Prisma.Decimal(traded.investmentPnlKrw ?? 'NaN');
  assert.equal(tradedPnl.lt(0), true, 'the FX fee is the only result');
  assert.equal(traded.cumulativeExternalFundingKrw, TEN_MILLION);
  assert.equal(
    traded.returnRate,
    tradedPnl.div(TEN_MILLION).mul(100).toDecimalPlaces(8).toFixed(8),
  );
  // An ad reward after the reset grows the NEW principal only.
  await ads.claim(ownerB, accountB, {
    provider: PROVIDER,
    proof: 'evt-b-topup-2',
    idempotencyKey: randomUUID(),
  });
  const rewarded = await summary(ownerB, accountB);
  assert.equal(rewarded.cumulativeExternalFundingKrw, money('15000000'));
  assert.equal(rewarded.cumulativeAdRewardKrw, money('5000000'));
  assert.equal(rewarded.investmentPnlKrw, traded.investmentPnlKrw);
  // The daily job continues the new epoch.
  await new GeneralDailySnapshotJobService(
    new BatchService(db),
    db,
    performance,
  ).run({
    snapshotDate: new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Seoul',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date()),
    idempotencyKey: batchKey,
    dryRun: false,
  });
  const daily = await portfolio.getEquity(ownerB, accountB, {
    range: '30d',
    granularity: 'daily',
  });
  assert.equal(daily.data.points.length >= 1, true);
  assert.equal(
    daily.data.points.at(-1)?.cumulativeExternalFundingKrw,
    money('15000000'),
  );
  // Realized PnL across the reset: a round trip on the SAME asset reuses the
  // position row the reset re-based, so the row carries this epoch's result
  // only — a loss here, while the ended epoch's gain stays on the reset row.
  await freshRate();
  w = await wallets(accountB);
  await transfer(ownerB, accountB, w.usd.id, w.spot.id, '300');
  await price(asset, '120');
  await marketOrder(ownerB, accountB, asset, 'buy', '240');
  const reopened = await db.position.findUniqueOrThrow({
    where: { id: closedPosition.id },
  });
  assert.equal(reopened.quantity.gt(0), true, 'the same row holds again');
  assert.equal(reopened.realizedPnl.toFixed(8), '0.00000000');
  assert.equal(reopened.realizedPnlKrw.toFixed(8), '0.00000000');
  await price(asset, '100');
  await marketOrder(
    ownerB,
    accountB,
    asset,
    'sell',
    reopened.quantity.toFixed(8),
  );
  const epochSell = await db.order.findFirstOrThrow({
    where: {
      tradingAccountId: accountB,
      assetId: asset,
      side: 'sell',
      status: 'executed',
      submittedAt: { gt: new Date(resetB.data.resetAt) },
    },
  });
  const epochRate = await db.fxRateSnapshot.findUniqueOrThrow({
    where: { id: epochSell.fxRateSnapshotId! },
  });
  const halfUp = (value: Prisma.Decimal) =>
    value.toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP);
  const epochRealized = halfUp(
    epochSell.netAmount!.sub(
      halfUp(reopened.averageCost.mul(reopened.quantity)),
    ),
  );
  const epochRealizedKrw = halfUp(epochRealized.mul(epochRate.rate));
  const reclosed = await db.position.findUniqueOrThrow({
    where: { id: closedPosition.id },
  });
  assert.equal(reclosed.quantity.isZero(), true);
  assert.equal(epochRealized.lt(0), true, 'a losing round trip');
  assert.equal(closedPosition.realizedPnl.gt(0), true, 'after a winning one');
  assert.equal(reclosed.realizedPnl.toFixed(8), money(epochRealized));
  assert.equal(reclosed.realizedPnlKrw.toFixed(8), money(epochRealizedKrw));
  const traded2 = await summary(ownerB, accountB);
  assert.equal(traded2.realizedPnlKrw, money(epochRealizedKrw));
  assert.equal(traded2.performanceEpoch.sequence, 1);
  // The ended epoch's record is untouched by the new epoch's trading.
  assert.deepEqual(
    (
      await db.generalAccountReset.findUniqueOrThrow({
        where: { id: resetRowB.id },
      })
    ).positionsRebasedJson,
    resetRowB.positionsRebasedJson,
  );
  // A second reset from a balance BELOW the target (credit) opens epoch 2.
  await exchange(ownerB, accountB, '5000000');
  w = await wallets(accountB);
  assert.equal(
    w.krw.balanceAmount.lt(TEN_MILLION),
    true,
    'balance below target',
  );
  await transfer(ownerB, accountB, w.usd.id, w.spot.id, '100');
  const beforeSecond = await summary(ownerB, accountB);
  const second = await resets.reset(ownerB, accountB, {
    provider: PROVIDER,
    proof: 'evt-b-reset-2',
    idempotencyKey: randomUUID(),
  });
  assert.equal(second.data.sequence, 2);
  const secondRow = await db.generalAccountReset.findUniqueOrThrow({
    where: { id: second.data.resetId },
  });
  assert.equal(
    secondRow.lifetimeExternalFundingKrw.toFixed(8),
    money('20000000'),
  );
  const krwCredit = await db.walletTransaction.findFirstOrThrow({
    where: {
      referenceType: 'general_account_reset',
      referenceId: secondRow.id,
      walletId: w.krw.id,
    },
  });
  assert.equal(krwCredit.direction, 'credit');
  assert.equal(
    krwCredit.amount.toFixed(8),
    money(new Prisma.Decimal(TEN_MILLION).sub(w.krw.balanceAmount)),
  );
  const afterSecond = await summary(ownerB, accountB);
  assert.equal(afterSecond.totalAssetKrw, TEN_MILLION);
  assert.equal(afterSecond.returnRate, '0.00000000');
  assert.equal(afterSecond.performanceEpoch.sequence, 2);
  // The second reset closes epoch 1 alone: its row keeps epoch 1's realized
  // PnL (never epoch 0's again) and epoch 1's closing figures as the
  // portfolio showed them; epoch 2 starts at 0.
  assert.deepEqual(
    (
      secondRow.positionsRebasedJson as Array<{
        positionId: string;
        realizedPnl: string;
        realizedPnlKrw: string;
      }>
    ).map((p) => [p.positionId, p.realizedPnl, p.realizedPnlKrw]),
    [[closedPosition.id, money(epochRealized), money(epochRealizedKrw)]],
  );
  assert.equal(
    secondRow.closingTotalAssetKrw.toFixed(8),
    beforeSecond.totalAssetKrw,
  );
  assert.equal(
    secondRow.closingExternalFundingKrw.toFixed(8),
    beforeSecond.cumulativeExternalFundingKrw,
  );
  assert.equal(
    secondRow.closingInvestmentPnlKrw.toFixed(8),
    beforeSecond.investmentPnlKrw,
  );
  assert.equal(afterSecond.realizedPnlKrw, '0.00000000');
  assert.equal(
    (
      await db.position.findUniqueOrThrow({ where: { id: closedPosition.id } })
    ).realizedPnl.toFixed(8),
    '0.00000000',
  );
  // Past results are kept as written: the first reset's record, the closed
  // Futures lifetime, and every order and ledger row from before the first
  // reset (compared as text, row by row, by id).
  assert.deepEqual(
    (
      await db.generalAccountReset.findUniqueOrThrow({
        where: { id: resetRowB.id },
      })
    ).positionsRebasedJson,
    resetRowB.positionsRebasedJson,
  );
  assert.equal(
    (
      await db.futuresPosition.findUniqueOrThrow({
        where: { id: futuresPosition.id },
      })
    ).realizedPnl.toFixed(8),
    money('7'),
  );
  const historyThen = JSON.parse(historyBeforeReset) as {
    orderRows: Array<{ id: string }>;
    ledgerRows: Array<{ id: string }>;
  };
  const historyNow = JSON.parse(
    await pastHistory(accountB),
  ) as typeof historyThen;
  for (const table of ['orderRows', 'ledgerRows'] as const) {
    const then = new Set(historyThen[table].map((row) => row.id));
    const kept = historyNow[table].filter((row) => then.has(row.id));
    assert.equal(
      JSON.stringify(kept) === JSON.stringify(historyThen[table]),
      true,
      `pre-reset ${table} are unchanged`,
    );
  }

  // ================================================================ 3
  // Ownership, mode, status, feature switch, registry, verification, purpose.
  const stranger = await user();
  await rejectsCode(
    resets.getEligibility(stranger, accountA),
    'TRADING_ACCOUNT_NOT_FOUND',
  );
  await rejectsCode(
    resets.reset(stranger, accountA, {
      provider: PROVIDER,
      proof: 'evt-stranger',
      idempotencyKey: randomUUID(),
    }),
    'TRADING_ACCOUNT_NOT_FOUND',
  );
  const beginner = (await opens.openBeginnerAccount(ownerA)).data.account.id;
  await rejectsCode(
    resets.getEligibility(ownerA, beginner),
    'AD_REWARD_GENERAL_ACCOUNT_ONLY',
  );
  await rejectsCode(
    resets.reset(ownerA, beginner, {
      provider: PROVIDER,
      proof: 'evt-beginner',
      idempotencyKey: randomUUID(),
    }),
    'AD_REWARD_GENERAL_ACCOUNT_ONLY',
  );
  const season = await db.season.create({
    data: {
      name: batchKey,
      status: 'active',
      startAt: new Date(Date.now() - 86_400_000),
      endAt: new Date(Date.now() + 86_400_000),
      initialCapitalKrw: '10000000',
      tradeFeeRate: '0.001',
      fxFeeRate: '0.001',
    },
  });
  seasons.push(season.id);
  await new SeasonsService(db).joinSeason(season.id, ownerA);
  const seasonAccount = await db.tradingAccount.findFirstOrThrow({
    where: { userId: ownerA, mode: 'season' },
  });
  await rejectsCode(
    resets.reset(ownerA, seasonAccount.id, {
      provider: PROVIDER,
      proof: 'evt-season',
      idempotencyKey: randomUUID(),
    }),
    'AD_REWARD_GENERAL_ACCOUNT_ONLY',
  );

  const countsBeforeRefusals = await rowCounts(accountA);
  await db.tradingAccount.update({
    where: { id: accountA },
    data: { status: 'suspended' },
  });
  assert.equal(
    (await eligibility(ownerA, accountA)).reason,
    'TRADING_ACCOUNT_NOT_ACTIVE',
  );
  await rejectsCode(
    resets.reset(ownerA, accountA, {
      provider: PROVIDER,
      proof: 'evt-suspended',
      idempotencyKey: randomUUID(),
    }),
    'TRADING_ACCOUNT_NOT_ACTIVE',
  );
  // A committed reset still answers its retry.
  assert.equal(
    (
      await resets.reset(ownerA, accountA, {
        provider: PROVIDER,
        proof: 'evt-a1',
        idempotencyKey: keyA,
      })
    ).data.resetId,
    resetA.data.resetId,
  );
  await db.tradingAccount.update({
    where: { id: accountA },
    data: { status: 'active' },
  });
  enableAds(false);
  assert.equal(
    (await eligibility(ownerA, accountA)).reason,
    'AD_REWARD_DISABLED',
  );
  await rejectsCode(
    resets.reset(ownerA, accountA, {
      provider: PROVIDER,
      proof: 'evt-disabled',
      idempotencyKey: randomUUID(),
    }),
    'AD_REWARD_DISABLED',
  );
  enableAds();
  // Production wiring: an EMPTY registry never accepts a completion.
  const unwired = new GeneralAccountResetService(
    db,
    access,
    new AdRewardVerificationRegistry([]),
    performance,
    valuation,
  );
  assert.equal(
    (await unwired.getEligibility(ownerA, accountA)).data.reason,
    'AD_REWARD_PROVIDER_UNAVAILABLE',
  );
  await rejectsCode(
    unwired.reset(ownerA, accountA, {
      provider: PROVIDER,
      proof: 'evt-unwired',
      idempotencyKey: randomUUID(),
    }),
    'AD_REWARD_PROVIDER_UNAVAILABLE',
  );
  await rejectsCode(
    resets.reset(ownerA, accountA, {
      provider: PROVIDER,
      proof: 'invalid-proof',
      idempotencyKey: randomUUID(),
    }),
    'AD_REWARD_VERIFICATION_FAILED',
  );
  await rejectsCode(
    resets.reset(ownerA, accountA, {
      provider: PROVIDER,
      proof: 'funding-only-proof',
      idempotencyKey: randomUUID(),
    }),
    'AD_REWARD_VERIFICATION_FAILED',
  );
  await rejectsCode(
    ads.claim(ownerA, accountA, {
      provider: PROVIDER,
      proof: 'reset-only-proof',
      idempotencyKey: randomUUID(),
    }),
    'AD_REWARD_VERIFICATION_FAILED',
  );
  assert.deepEqual(await rowCounts(accountA), countsBeforeRefusals);

  // ================================================================ 4
  // Concurrency: one key → one reset; several events → serialized resets;
  // a top-up racing a reset lands on exactly one side of it.
  const ownerC = await user();
  const accountC = (await opens.openGeneralAccount(ownerC)).data.account.id;
  const keyC = randomUUID();
  const sameKey = await Promise.all(
    Array.from({ length: 6 }, () =>
      resets.reset(ownerC, accountC, {
        provider: PROVIDER,
        proof: 'evt-c-same',
        idempotencyKey: keyC,
      }),
    ),
  );
  assert.equal(new Set(sameKey.map((r) => r.data.resetId)).size, 1);
  assert.equal(sameKey.filter((r) => r.data.reset).length, 1);
  const many = await Promise.all(
    ['evt-c-1', 'evt-c-2', 'evt-c-3'].map((proof) =>
      resets.reset(ownerC, accountC, {
        provider: PROVIDER,
        proof,
        idempotencyKey: randomUUID(),
      }),
    ),
  );
  assert.deepEqual(many.map((r) => r.data.sequence).sort(), [2, 3, 4]);
  const [raceClaim, raceReset] = await Promise.all([
    ads.claim(ownerC, accountC, {
      provider: PROVIDER,
      proof: 'evt-c-topup',
      idempotencyKey: randomUUID(),
    }),
    resets.reset(ownerC, accountC, {
      provider: PROVIDER,
      proof: 'evt-c-reset',
      idempotencyKey: randomUUID(),
    }),
  ]);
  assert.equal(raceClaim.data.granted, true);
  // The account lock orders them; the reset records which side it saw.
  const raceResetRow = await db.generalAccountReset.findUniqueOrThrow({
    where: { id: raceReset.data.resetId },
  });
  const claimFirst = raceResetRow.lifetimeExternalFundingKrw.equals(15_000_000);
  const raced = await summary(ownerC, accountC);
  assert.equal(
    raced.cumulativeExternalFundingKrw,
    claimFirst ? TEN_MILLION : money('15000000'),
  );
  assert.equal(raced.totalAssetKrw, raced.cumulativeExternalFundingKrw);
  assert.equal(raced.returnRate, '0.00000000');

  // ================================================================ 5
  // The read-only audit agrees with all of the above.
  const audit = await auditGeneralAccounts(db);
  assert.deepEqual(
    audit.findings.map((f) => `${f.code}: ${f.detail}`),
    [],
  );

  console.log(
    'general account reset DB integration passed: fresh/used/repeated resets, blockers, rollback, ledger and epoch, history, realized PnL across epochs, purposes, idempotency, refusals, concurrency, daily job, audit',
  );
}

/** A PrismaService whose transactions fail at the epoch-origin write. */
function failOnSnapshotCreate(): PrismaService {
  const read = (target: object, key: string | symbol, receiver: unknown) =>
    Reflect.get(target, key, receiver) as unknown;
  return new Proxy(db, {
    get(targetDb, key, receiver): unknown {
      if (key !== '$transaction') return read(targetDb, key, receiver);
      return (work: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        db.$transaction((tx) =>
          work(
            new Proxy(tx, {
              get(txTarget, txKey, txReceiver): unknown {
                const delegate = read(txTarget, txKey, txReceiver);
                if (txKey !== 'equitySnapshot') return delegate;
                return new Proxy(delegate as object, {
                  get(dTarget, dKey, dReceiver): unknown {
                    const method = read(dTarget, dKey, dReceiver);
                    if (dKey !== 'create') {
                      return typeof method === 'function'
                        ? (method as (...args: unknown[]) => unknown).bind(
                            dTarget,
                          )
                        : method;
                    }
                    return () => {
                      throw new Error('injected reset failure');
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

async function cleanup() {
  for (const member of users) {
    const accountIds = (
      await db.tradingAccount.findMany({
        where: { userId: member.id },
        select: { id: true },
      })
    ).map((row) => row.id);
    const participants = await db.seasonParticipant.findMany({
      where: { userId: member.id },
      select: { id: true, seasonId: true, tradingAccountId: true },
    });
    await db.$transaction((tx) =>
      purgeDeletionScope(tx, {
        userId: member.id,
        email: member.email,
        scope: {
          accountIds,
          participants: participants.map((p) => ({
            id: p.id,
            seasonId: p.seasonId,
            tradingAccountId: p.tradingAccountId ?? '',
          })),
          seasonStatus: new Map(),
        },
      }),
    );
  }
  await db.futuresInstrument.deleteMany({ where: { id: { in: instruments } } });
  await db.assetPriceSnapshot.deleteMany({
    where: { assetId: { in: assets } },
  });
  await db.asset.deleteMany({ where: { id: { in: assets } } });
  await db.fxRateSnapshot.deleteMany({ where: { id: { in: rates } } });
  await db.season.deleteMany({ where: { id: { in: seasons } } });
  await db.batchJobRun.deleteMany({ where: { idempotencyKey: batchKey } });
}

run()
  .finally(async () => {
    try {
      await cleanup();
    } finally {
      await db.$disconnect();
    }
  })
  .catch((failure: unknown) => {
    console.error(failure);
    process.exitCode = 1;
  });
