import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { HttpException } from '@nestjs/common';
import {
  Prisma,
  type TradingAccountMode,
} from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import { GeneralAccountsService } from '../src/trading-accounts/general-accounts.service';
import { GeneralAccountPerformanceService } from '../src/portfolio/general-account-performance.service';
import { GeneralExternalFundingService } from '../src/portfolio/general-external-funding.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { FxService, type FxExecuteSuccessResponse } from '../src/fx/fx.service';
import { TradingAccountWalletTransferService } from '../src/wallets/trading-account-wallet-transfer.service';
import { TradingAccountWalletFxTransferService } from '../src/wallets/trading-account-wallet-fx-transfer.service';
import { WalletsService } from '../src/wallets/wallets.service';
import { OrdersService } from '../src/orders/orders.service';
import { OrderReservationService } from '../src/orders/order-reservation.service';
import { LimitOrderCreateService } from '../src/orders/limit-order-create.service';
import { LimitOrderCancelService } from '../src/orders/limit-order-cancel.service';
import type { UsdKrwRefreshService } from '../src/providers/usd-krw-refresh.service';

if (
  process.env.NODE_ENV !== 'test' ||
  process.env.LIMIT_ORDER_RESERVATION_DB_INTEGRATION !== '1'
)
  throw new Error('Explicit test DB opt-in is required.');
process.env.GENERAL_FX_FEE_RATE = '0.001000';
process.env.GENERAL_TRADE_FEE_RATE = '0.001000';
process.env.LIMIT_ORDER_ENABLED = 'true';
const prisma = new PrismaService();
function services(db: PrismaService, refresh?: UsdKrwRefreshService) {
  const access = new TradingAccountAccessService(db);
  const valuation = new PortfolioValuationService(db);
  const performance = new GeneralAccountPerformanceService(
    db,
    valuation,
    new GeneralExternalFundingService(db),
  );
  const transfers = new TradingAccountWalletTransferService(
    db,
    access,
    performance,
  );
  const fx = new FxService(
    db,
    refresh,
    undefined,
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
  return {
    access,
    valuation,
    performance,
    transfers,
    fx,
    orders,
    composite: new TradingAccountWalletFxTransferService(
      db,
      access,
      fx,
      transfers,
    ),
    general: new GeneralAccountsService(db, performance),
    wallets: new WalletsService(db, access),
  };
}
const app = services(prisma);
const d = (v: string) => new Prisma.Decimal(v);
const dbNow = async () =>
  (
    await prisma.$queryRaw<
      Array<{ now: Date }>
    >`SELECT clock_timestamp() AS now`
  )[0].now;
async function evidence(
  rate = '1400',
  sourceName = 'korea_exim_exchange_rate',
) {
  const now = await dbNow();
  return prisma.fxRateSnapshot.create({
    data: {
      baseCurrency: 'USD',
      quoteCurrency: 'KRW',
      rate,
      sourceType: 'provider_api',
      sourceName,
      // DB and application clocks may differ slightly. Completed evidence is
      // fresh for both selectors without weakening production freshness gates.
      capturedAt: new Date(now.getTime() - 1000),
      effectiveAt: new Date(now.getTime() - 1000),
    },
  });
}
async function fixture(mode: TradingAccountMode) {
  const now = await dbNow();
  const user = await prisma.user.create({
    data: {
      email: `wallet-fx-${randomUUID()}@example.com`,
      nickname: randomUUID().slice(0, 16),
      passwordHash: 'test-only',
    },
  });
  const season =
    mode === 'season'
      ? await prisma.season.create({
          data: {
            name: `wallet-fx-${randomUUID()}`,
            status: 'active',
            startAt: new Date(now.getTime() - 86400000),
            endAt: new Date(now.getTime() + 86400000),
            initialCapitalKrw: '10000000',
            tradeFeeRate: '0.001',
            fxFeeRate: '0.001',
          },
        })
      : null;
  const accountId = season
    ? (
        await prisma.tradingAccount.create({
          data: {
            userId: user.id,
            mode,
            initialCapitalKrw: '10000000',
            openedAt: now,
          },
        })
      ).id
    : (
        await (mode === 'beginner'
          ? app.general.openBeginnerAccount(user.id)
          : app.general.openGeneralAccount(user.id))
      ).data.account.id;
  if (season) {
    await prisma.seasonParticipant.create({
      data: {
        userId: user.id,
        seasonId: season.id,
        tradingAccountId: accountId,
        participantStatus: 'active',
        joinedAt: now,
        initialCapitalKrw: '10000000',
        totalAssetKrw: '10000000',
        totalReturnRate: '0',
        maxDrawdown: '0',
      },
    });
    await prisma.cashWallet.createMany({
      data: [
        {
          tradingAccountId: accountId,
          walletScope: 'securities',
          currencyCode: 'KRW',
          balanceAmount: '10000000',
        },
        ...(['securities', 'crypto_spot', 'crypto_futures'] as const).map(
          (walletScope) => ({
            tradingAccountId: accountId,
            walletScope,
            currencyCode: 'USD' as const,
            balanceAmount: '0',
          }),
        ),
      ],
    });
  }
  await prisma.cashWallet.updateMany({
    where: {
      tradingAccountId: accountId,
      walletScope: 'securities',
      currencyCode: 'USD',
    },
    data: { balanceAmount: '100', reservedAmount: '100' },
  });
  await prisma.cashWallet.updateMany({
    where: { tradingAccountId: accountId, walletScope: 'crypto_spot' },
    data: { balanceAmount: '500', reservedAmount: '50' },
  });
  await prisma.cashWallet.updateMany({
    where: { tradingAccountId: accountId, walletScope: 'crypto_futures' },
    data: { balanceAmount: '500' },
  });
  const asset = await prisma.asset.create({
    data: {
      symbol: randomUUID(),
      name: 'Composite integration',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
  });
  await prisma.assetPriceSnapshot.create({
    data: {
      assetId: asset.id,
      price: '100',
      currencyCode: 'USD',
      sourceType: 'provider_api',
      sourceName: 'binance_spot_ws_ticker',
      capturedAt: now,
      effectiveAt: now,
    },
  });
  return { mode, userId: user.id, accountId, season, asset };
}
type Scenario = Awaited<ReturnType<typeof fixture>>;
async function cash(
  s: Scenario,
  scope: 'securities' | 'crypto_spot' | 'crypto_futures',
  currencyCode: 'KRW' | 'USD' = 'USD',
) {
  return prisma.cashWallet.findUniqueOrThrow({
    where: {
      tradingAccountId_walletScope_currencyCode: {
        tradingAccountId: s.accountId,
        walletScope: scope,
        currencyCode,
      },
    },
  });
}
async function quote(
  s: Scenario,
  crypto: 'crypto_spot' | 'crypto_futures',
  reverse = false,
  amount = reverse ? '100.12345678' : '140000.12345678',
) {
  const krw = await cash(s, 'securities', 'KRW');
  const usd = await cash(s, crypto);
  return app.composite.quote(s.userId, s.accountId, {
    sourceWalletId: reverse ? usd.id : krw.id,
    destinationWalletId: reverse ? krw.id : usd.id,
    amount,
  });
}
async function state(s: Scenario) {
  const where = { tradingAccountId: s.accountId };
  return {
    wallets: (
      await prisma.cashWallet.findMany({ where, orderBy: { id: 'asc' } })
    ).map((w) => ({
      id: w.id,
      balance: w.balanceAmount.toFixed(8),
      reserved: w.reservedAmount.toFixed(8),
    })),
    ledger: await prisma.walletTransaction.count({ where }),
    exchange: await prisma.exchangeTransaction.count({ where }),
    transfer: await prisma.walletTransfer.count({ where }),
    command: await prisma.walletTransferExecuteRequest.count({ where }),
    fxCommand: await prisma.fxExecuteRequest.count({ where }),
    snapshots: await prisma.equitySnapshot.count({ where }),
    participant: (
      await prisma.seasonParticipant.findUnique({
        where: { tradingAccountId: s.accountId },
      })
    )?.totalAssetKrw.toFixed(8),
  };
}
async function reject(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof HttpException, String(error));
    assert.equal(
      (error.getResponse() as { error: { code: string } }).error.code,
      code,
    );
    return true;
  });
}
async function cleanup(s: Scenario) {
  const where = { tradingAccountId: s.accountId };
  await prisma.walletTransferExecuteRequest.deleteMany({ where });
  await prisma.walletTransferQuote.deleteMany({ where: { quote: where } });
  await prisma.walletTransaction.deleteMany({ where });
  await prisma.walletTransfer.deleteMany({ where });
  await prisma.fxExecuteRequest.deleteMany({ where });
  await prisma.exchangeTransaction.deleteMany({ where });
  await prisma.order.deleteMany({ where });
  await prisma.quote.deleteMany({ where });
  await prisma.position.deleteMany({ where });
  await prisma.equitySnapshot.deleteMany({ where });
  await prisma.seasonRanking.deleteMany({ where });
  await prisma.cashWallet.deleteMany({ where });
  await prisma.seasonParticipant.deleteMany({ where });
  await prisma.tradingAccount.delete({ where: { id: s.accountId } });
  if (s.season) await prisma.season.delete({ where: { id: s.season.id } });
  await prisma.assetPriceSnapshot.deleteMany({
    where: { assetId: s.asset.id },
  });
  await prisma.asset.delete({ where: { id: s.asset.id } });
  await prisma.user.delete({ where: { id: s.userId } });
}

async function parity(
  mode: TradingAccountMode,
  crypto: 'crypto_spot' | 'crypto_futures',
  reverse: boolean,
) {
  const [a, b] = await Promise.all([fixture(mode), fixture(mode)]);
  try {
    await evidence();
    const q = await quote(b, crypto, reverse);
    const before = await state(b);
    const usdA = await cash(a, 'securities');
    const cryptoA = await cash(a, crypto);
    if (reverse)
      await app.transfers.transfer(a.userId, a.accountId, {
        sourceWalletId: cryptoA.id,
        destinationWalletId: usdA.id,
        amount: q.data.sourceAmount,
        idempotencyKey: randomUUID(),
      });
    const fxQuote = await app.fx.quoteForTradingAccount(a.userId, a.accountId, {
      fromCurrency: q.data.fromCurrency,
      toCurrency: q.data.toCurrency,
      sourceAmount: q.data.sourceAmount,
    });
    assert.equal(fxQuote.data.netTargetAmount, q.data.netTargetAmount);
    assert.equal(fxQuote.data.feeAmount, q.data.feeAmount);
    const standalone = (await app.fx.executeForTradingAccount(
      a.userId,
      a.accountId,
      {
        quoteId: fxQuote.data.quoteId,
        fromCurrency: q.data.fromCurrency,
        toCurrency: q.data.toCurrency,
        sourceAmount: q.data.sourceAmount,
        idempotencyKey: randomUUID(),
      },
    )) as FxExecuteSuccessResponse;
    if (!reverse)
      await app.transfers.transfer(a.userId, a.accountId, {
        sourceWalletId: usdA.id,
        destinationWalletId: cryptoA.id,
        amount: standalone.data.netTargetAmount,
        idempotencyKey: randomUUID(),
      });
    const command = { quoteId: q.data.quoteId, idempotencyKey: randomUUID() };
    const result = await app.composite.execute(b.userId, b.accountId, command);
    assert.equal(result.data.fx.feeAmount, standalone.data.feeAmount);
    assert.equal(result.data.fx.appliedRate, standalone.data.appliedRate);
    assert.equal(result.data.receivedAmount, standalone.data.netTargetAmount);
    const balances = async (s: Scenario) =>
      (
        await prisma.cashWallet.findMany({
          where: { tradingAccountId: s.accountId },
          orderBy: [{ walletScope: 'asc' }, { currencyCode: 'asc' }],
        })
      ).map((w) => [
        w.walletScope,
        w.currencyCode,
        w.balanceAmount.toFixed(8),
        w.reservedAmount.toFixed(8),
      ]);
    assert.deepEqual(await balances(a), await balances(b));
    assert.equal(
      (await cash(b, 'securities')).balanceAmount.toFixed(8),
      '100.00000000',
    );
    assert.equal(
      (await cash(b, 'securities')).reservedAmount.toFixed(8),
      '100.00000000',
    );
    const now = await dbNow();
    const valuations = await Promise.all(
      [a, b].map((s) =>
        app.valuation.calculateTradingAccountValuation(
          s.accountId,
          now,
          'live_portfolio_valuation',
        ),
      ),
    );
    for (const field of [
      'totalAssetKrw',
      'krwCash',
      'usdCashKrw',
      'returnRate',
    ] as const)
      assert.equal(valuations[0][field], valuations[1][field], field);
    const snapshot = async (s: Scenario) =>
      prisma.equitySnapshot.findFirstOrThrow({
        where: {
          tradingAccountId: s.accountId,
          snapshotReason: 'exchange_executed',
        },
      });
    const [sa, sb] = await Promise.all([snapshot(a), snapshot(b)]);
    for (const field of [
      'totalAssetKrw',
      'krwCash',
      'usdCashKrw',
      'returnRate',
      'investmentPnlKrw',
      'timeWeightedReturnFactor',
      'cumulativeExternalFundingKrw',
    ] as const)
      assert.equal(sa[field]?.toString(), sb[field]?.toString(), field);
    assert.equal(sb.externalFundingAmountKrw?.toFixed(8) ?? null, null);
    const parent = await prisma.walletTransferExecuteRequest.findUniqueOrThrow({
      where: { id: result.data.commandId },
      include: {
        quote: { include: { quote: true } },
        walletTransfer: true,
        exchangeTransaction: { include: { fxExecuteRequests: true } },
      },
    });
    assert.equal(parent.quote.quoteId, q.data.quoteId);
    assert.equal(parent.quote.quote.quotedFeeRate?.toFixed(6), '0.001000');
    assert.equal(parent.quote.quote.status, 'consumed');
    assert.equal(parent.exchangeTransaction.fxExecuteRequests.length, 1);
    assert.equal(
      parent.exchangeTransaction.fxExecuteRequests[0].status,
      'succeeded',
    );
    assert.equal(
      parent.walletTransfer.amount.toFixed(8),
      reverse ? q.data.sourceAmount : result.data.receivedAmount,
    );
    const legs = await prisma.walletTransaction.findMany({
      where: {
        tradingAccountId: b.accountId,
        referenceId: {
          in: [result.data.transferId, result.data.fx.exchangeId],
        },
      },
    });
    assert.equal(legs.length, 4);
    const routing = (await cash(b, 'securities')).id;
    const routedCredit = legs.find(
      (l) => l.walletId === routing && l.direction === 'credit',
    )!;
    const routedDebit = legs.find(
      (l) => l.walletId === routing && l.direction === 'debit',
    )!;
    assert.equal(routedCredit.amount.toFixed(8), routedDebit.amount.toFixed(8));
    assert.equal(
      routedCredit.balanceAfter.toFixed(8),
      d('100').add(parent.walletTransfer.amount).toFixed(8),
    );
    assert.equal(routedDebit.balanceAfter.toFixed(8), '100.00000000');
    assert.equal(
      (
        await app.wallets.getWalletTransactionsForTradingAccount(
          b.userId,
          b.accountId,
          {},
        )
      ).data.transactions.filter(
        (l) =>
          l.referenceId === result.data.transferId ||
          l.referenceId === result.data.fx.exchangeId,
      ).length,
      4,
    );
    assert.deepEqual(
      await app.composite.execute(b.userId, b.accountId, command),
      result,
    );
    const after = await state(b);
    assert.equal(after.ledger - before.ledger, 4);
    assert.equal(after.command, 1);
    assert.equal(after.fxCommand, 1);
    assert.equal(after.transfer, 1);
    const another = await quote(b, crypto, reverse, reverse ? '1' : '1400');
    await reject(
      app.composite.execute(b.userId, b.accountId, {
        ...command,
        quoteId: another.data.quoteId,
      }),
      'WALLET_TRANSFER_IDEMPOTENCY_CONFLICT',
    );
    await prisma.tradingAccount.update({
      where: { id: b.accountId },
      data: { status: 'suspended' },
    });
    if (b.season) {
      await prisma.season.update({
        where: { id: b.season.id },
        data: { status: 'ended' },
      });
      await prisma.seasonParticipant.update({
        where: { tradingAccountId: b.accountId },
        data: { participantStatus: 'excluded' },
      });
    }
    assert.deepEqual(
      await app.composite.execute(b.userId, b.accountId, command),
      result,
    );
    console.log(
      `PASS parity/evidence/reservation/replay ${mode} ${crypto} ${reverse ? 'USD→KRW' : 'KRW→USD'}`,
    );
  } finally {
    await cleanup(a);
    await cleanup(b);
  }
}

// Faults are injected into real Prisma transaction calls, never product hooks.
function faultyDb(point: string): PrismaService {
  return new Proxy(prisma, {
    get(target, key) {
      if (key === '$transaction')
        return async (
          work: (tx: Prisma.TransactionClient) => Promise<unknown>,
        ) =>
          target.$transaction(async (tx) => {
            let debit = 0,
              credit = 0;
            const proxy = new Proxy(tx, {
              get(client, prop) {
                const value = Reflect.get(client, prop);
                if (prop === '$executeRaw')
                  return async (...args: unknown[]) => {
                    const result = await value.apply(client, args);
                    if (point === `debit-${++debit}`) throw new Error(point);
                    return result;
                  };
                if (
                  [
                    'cashWallet',
                    'exchangeTransaction',
                    'walletTransfer',
                    'walletTransaction',
                    'walletTransferExecuteRequest',
                    'equitySnapshot',
                    'fxExecuteRequest',
                  ].includes(String(prop))
                )
                  return new Proxy(value, {
                    get(delegate, method) {
                      const fn = Reflect.get(delegate, method);
                      if (typeof fn !== 'function') return fn;
                      return async (...args: unknown[]) => {
                        if (
                          prop === 'cashWallet' &&
                          method === 'updateMany' &&
                          point === 'destination-credit'
                        )
                          throw new Error(point);
                        const result = await fn.apply(delegate, args);
                        if (
                          prop === 'cashWallet' &&
                          method === 'updateMany' &&
                          point === `credit-${++credit}`
                        )
                          throw new Error(point);
                        if (point === `${String(prop)}.${String(method)}`)
                          throw new Error(point);
                        return result;
                      };
                    },
                  });
                return typeof value === 'function' ? value.bind(client) : value;
              },
            });
            return work(proxy);
          });
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
async function rollback(mode: TradingAccountMode, reverse: boolean) {
  const s = await fixture(mode);
  try {
    await evidence();
    const q = await quote(s, 'crypto_spot', reverse);
    const body = { quoteId: q.data.quoteId, idempotencyKey: randomUUID() };
    const before = await state(s);
    for (const point of [
      'debit-1',
      'debit-2',
      'credit-1',
      'credit-2',
      'destination-credit',
      'exchangeTransaction.create',
      'walletTransfer.create',
      'walletTransaction.create',
      'walletTransaction.createMany',
      'fxExecuteRequest.create',
      'fxExecuteRequest.update',
      'equitySnapshot.create',
      'walletTransferExecuteRequest.create',
    ]) {
      await assert.rejects(
        services(faultyDb(point)).composite.execute(
          s.userId,
          s.accountId,
          body,
        ),
        new RegExp(point.replace('.', '\\.')),
      );
      assert.deepEqual(await state(s), before, point);
      assert.equal(
        (await prisma.quote.findUniqueOrThrow({ where: { id: body.quoteId! } }))
          .status,
        'active',
        point,
      );
    }
    await app.composite.execute(s.userId, s.accountId, body);
    console.log(
      `PASS 13 rollback fault points ${mode} ${reverse ? 'reverse' : 'forward'}`,
    );
  } finally {
    await cleanup(s);
  }
}

async function policies(mode: TradingAccountMode) {
  const s = await fixture(mode);
  const other = await fixture(mode);
  try {
    await evidence();
    const q = await quote(s, 'crypto_spot');
    const before = await state(s);
    await reject(
      app.fx.executeForTradingAccount(s.userId, s.accountId, {
        ...q.data,
        quoteId: q.data.quoteId,
        sourceAmount: q.data.sourceAmount,
        idempotencyKey: randomUUID(),
      }),
      'QUOTE_MISMATCH',
    );
    await reject(
      app.composite.execute(s.userId, other.accountId, {
        quoteId: q.data.quoteId,
        idempotencyKey: randomUUID(),
      }),
      'TRADING_ACCOUNT_NOT_FOUND',
    );
    const [krw, usd, spot] = await Promise.all([
      cash(s, 'securities', 'KRW'),
      cash(s, 'securities'),
      cash(s, 'crypto_spot'),
    ]);
    for (const [from, to] of [
      [krw, usd],
      [usd, krw],
      [usd, spot],
      [spot, spot],
    ])
      await reject(
        app.composite.quote(s.userId, s.accountId, {
          sourceWalletId: from.id,
          destinationWalletId: to.id,
          amount: '1',
        }),
        'WALLET_TRANSFER_ROUTE_UNSUPPORTED',
      );
    await reject(
      app.composite.quote(s.userId, s.accountId, {
        sourceWalletId: (await cash(other, 'crypto_spot')).id,
        destinationWalletId: krw.id,
        amount: '1',
      }),
      'WALLET_TRANSFER_WALLET_NOT_FOUND',
    );
    await evidence('1401');
    if (mode !== 'season') process.env.GENERAL_FX_FEE_RATE = '0.020000';
    else
      await prisma.season.update({
        where: { id: s.season!.id },
        data: { fxFeeRate: '0.02' },
      });
    const result = await app.composite.execute(s.userId, s.accountId, {
      quoteId: q.data.quoteId,
      idempotencyKey: randomUUID(),
    });
    assert.equal(result.data.fx.appliedRate, '1401.00000000');
    assert.equal(result.data.fx.feeRate, '0.001000');
    assert.equal(
      result.data.receivedAmount,
      d(q.data.sourceAmount).div('1401').mul('0.999').toFixed(8),
    );
    process.env.GENERAL_FX_FEE_RATE = '0.001000';
    if (s.season)
      await prisma.season.update({
        where: { id: s.season.id },
        data: { fxFeeRate: '0.001' },
      });
    const bound = await quote(s, 'crypto_futures');
    const preFailure = await state(s);
    await evidence('1500');
    await reject(
      app.composite.execute(s.userId, s.accountId, {
        quoteId: bound.data.quoteId,
        idempotencyKey: randomUUID(),
      }),
      'RATE_CHANGED_REQUOTE_REQUIRED',
    );
    assert.deepEqual(await state(s), preFailure);
    await evidence();
    const expired = await quote(s, 'crypto_spot', true);
    await prisma.quote.update({
      where: { id: expired.data.quoteId! },
      data: { expiresAt: new Date(0) },
    });
    await reject(
      app.composite.execute(s.userId, s.accountId, {
        quoteId: expired.data.quoteId,
        idempotencyKey: randomUUID(),
      }),
      'QUOTE_EXPIRED',
    );
    assert.deepEqual(await state(s), preFailure);
    await prisma.cashWallet.update({
      where: { id: spot.id },
      data: { reservedAmount: (await cash(s, 'crypto_spot')).balanceAmount },
    });
    await reject(quote(s, 'crypto_spot', true, '1'), 'INSUFFICIENT_BALANCE');
    await prisma.cashWallet.update({
      where: { id: spot.id },
      data: { reservedAmount: '50' },
    });
    const noCash = await quote(s, 'crypto_spot', true, '400');
    await prisma.cashWallet.update({
      where: { id: spot.id },
      data: { reservedAmount: '450' },
    });
    const reserved = await state(s);
    await reject(
      app.composite.execute(s.userId, s.accountId, {
        quoteId: noCash.data.quoteId,
        idempotencyKey: randomUUID(),
      }),
      'INSUFFICIENT_AVAILABLE_BALANCE',
    );
    assert.deepEqual(await state(s), reserved);
    const krwBalance = (await cash(s, 'securities', 'KRW')).balanceAmount;
    await prisma.cashWallet.update({
      where: { id: krw.id },
      data: { reservedAmount: krwBalance },
    });
    await reject(
      quote(s, 'crypto_futures', false, '1'),
      'INSUFFICIENT_BALANCE',
    );
    await prisma.cashWallet.update({
      where: { id: krw.id },
      data: { reservedAmount: '0' },
    });
    const krwNoCash = await quote(s, 'crypto_futures', false, '1400');
    await prisma.cashWallet.update({
      where: { id: krw.id },
      data: { reservedAmount: krwBalance },
    });
    const krwReserved = await state(s);
    await reject(
      app.composite.execute(s.userId, s.accountId, {
        quoteId: krwNoCash.data.quoteId,
        idempotencyKey: randomUUID(),
      }),
      'INSUFFICIENT_BALANCE',
    );
    assert.deepEqual(await state(s), krwReserved);
    assert.equal(before.command, 0);
    console.log(
      `PASS quote isolation/routes/expiry/repricing/maxChangeBps/pinned fee/source reservation ${mode}`,
    );
  } finally {
    process.env.GENERAL_FX_FEE_RATE = '0.001000';
    await cleanup(s);
    await cleanup(other);
  }
}

async function concurrency(mode: TradingAccountMode) {
  for (const race of [
    'replay',
    'distinct',
    'opposite',
    'same-currency',
    'standalone-fx',
    'limit',
    'market',
  ] as const) {
    const s = await fixture(mode);
    try {
      await evidence();
      const reverse = ['same-currency', 'limit', 'market'].includes(race);
      const q = await quote(
        s,
        'crypto_spot',
        reverse,
        race === 'standalone-fx' ? '6000000' : reverse ? '100' : '14000',
      );
      const body = { quoteId: q.data.quoteId, idempotencyKey: randomUUID() };
      let second: () => Promise<unknown>;
      if (race === 'replay')
        second = () => app.composite.execute(s.userId, s.accountId, body);
      else if (race === 'distinct' || race === 'opposite') {
        const q2 = await quote(
          s,
          race === 'distinct' ? 'crypto_futures' : 'crypto_spot',
          race === 'opposite',
          race === 'opposite' ? '50' : '14000',
        );
        second = () =>
          app.composite.execute(s.userId, s.accountId, {
            quoteId: q2.data.quoteId,
            idempotencyKey: randomUUID(),
          });
      } else if (race === 'same-currency') {
        const spot = await cash(s, 'crypto_spot');
        const futures = await cash(s, 'crypto_futures');
        second = () =>
          app.transfers.transfer(s.userId, s.accountId, {
            sourceWalletId: spot.id,
            destinationWalletId: futures.id,
            amount: '400',
            idempotencyKey: randomUUID(),
          });
      } else if (race === 'standalone-fx') {
        const fq = await app.fx.quoteForTradingAccount(s.userId, s.accountId, {
          fromCurrency: 'KRW',
          toCurrency: 'USD',
          sourceAmount: '6000000',
        });
        second = () =>
          app.fx.executeForTradingAccount(s.userId, s.accountId, {
            quoteId: fq.data.quoteId,
            fromCurrency: 'KRW',
            toCurrency: 'USD',
            sourceAmount: '6000000',
            idempotencyKey: randomUUID(),
          });
      } else {
        const order = {
          assetId: s.asset.id,
          side: 'buy',
          orderType: race === 'limit' ? 'limit' : 'market',
          amount: '400',
          ...(race === 'limit' ? { limitPrice: '100' } : {}),
        };
        const oq = await app.orders.quoteOrderForTradingAccount(
          s.userId,
          s.accountId,
          order,
        );
        second = () =>
          app.orders.createOrderForTradingAccount(s.userId, s.accountId, {
            ...order,
            quoteId: oq.data.quoteId,
            idempotencyKey: randomUUID(),
          });
      }
      const outcomes = await Promise.allSettled([
        app.composite.execute(s.userId, s.accountId, body),
        second(),
      ]);
      const successful = outcomes.filter((o) => o.status === 'fulfilled');
      assert.equal(
        successful.length,
        ['replay', 'distinct', 'opposite'].includes(race) ? 2 : 1,
        JSON.stringify(outcomes),
      );
      for (const o of outcomes)
        if (o.status === 'rejected') {
          assert.ok(o.reason instanceof HttpException, String(o.reason));
          assert.match(
            (o.reason.getResponse() as { error: { code: string } }).error.code,
            /INSUFFICIENT/,
          );
        }
      if (race === 'replay') {
        assert.deepEqual(
          (outcomes[0] as PromiseFulfilledResult<unknown>).value,
          (outcomes[1] as PromiseFulfilledResult<unknown>).value,
        );
        assert.equal((await state(s)).command, 1);
        assert.equal((await state(s)).fxCommand, 1);
        assert.equal((await state(s)).transfer, 1);
      }
      for (const w of await prisma.cashWallet.findMany({
        where: { tradingAccountId: s.accountId },
      }))
        assert.ok(
          w.balanceAmount.gte(w.reservedAmount) && w.reservedAmount.gte(0),
        );
      console.log(`PASS concurrent ${mode} ${race}`);
    } finally {
      await cleanup(s);
    }
  }
}

async function waitUntil(check: () => Promise<boolean>, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'Database lock barrier timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function postLockBoundary(
  mode: TradingAccountMode,
  boundary: 'quote' | 'season' | 'provider',
) {
  const s = await fixture(mode);
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await evidence();
    const q = await quote(s, 'crypto_spot', true);
    const deadline = new Date((await dbNow()).getTime() + 1800);
    if (boundary === 'quote')
      await prisma.quote.update({
        where: { id: q.data.quoteId! },
        data: { expiresAt: deadline },
      });
    if (boundary === 'season')
      await prisma.season.update({
        where: { id: s.season!.id },
        data: { endAt: deadline },
      });
    const before = await state(s);
    await db.query('BEGIN');
    await db.query('SELECT id FROM cash_wallets WHERE id = $1 FOR UPDATE', [
      q.data.sourceWalletId,
    ]);
    const pid = (await db.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    let refreshCalls = 0;
    const refresh = {
      prepare: async () => {
        refreshCalls++;
        throw new Error('Provider network must stay outside money locks');
      },
    } as unknown as UsdKrwRefreshService;
    const command = { quoteId: q.data.quoteId, idempotencyKey: randomUUID() };
    pending = services(prisma, refresh).composite.execute(
      s.userId,
      s.accountId,
      command,
    );
    void pending.catch(() => {});
    await waitUntil(async () => {
      // pg_stat_activity snapshots are cached inside the lock-holder's BEGIN.
      await db.query('SELECT pg_stat_clear_snapshot()');
      return (
        (
          await db.query(
            `SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%FROM "cash_wallets"%' AND $1 = ANY(pg_blocking_pids(pid))`,
            [pid],
          )
        ).rowCount! > 0
      );
    });
    if (boundary === 'provider')
      await prisma.fxRateSnapshot.updateMany({
        data: { capturedAt: new Date(0), effectiveAt: new Date(0) },
      });
    else await waitUntil(async () => (await dbNow()) > deadline);
    await db.query('COMMIT');
    await reject(
      pending,
      boundary === 'quote'
        ? 'QUOTE_EXPIRED'
        : boundary === 'season'
          ? 'SEASON_ENDED'
          : 'PROVIDER_RATE_STALE',
    );
    assert.equal(refreshCalls, 0);
    assert.deepEqual(await state(s), before);
    console.log(
      `PASS post-wallet-lock ${boundary} ${mode}: DB clock/evidence rejects and rolls back`,
    );
  } finally {
    await db.query('ROLLBACK');
    await pending?.catch(() => {});
    await db.end();
    await cleanup(s);
  }
}

async function committedReplayAcrossDeadline() {
  const s = await fixture('season');
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  const barrier = Math.floor(Math.random() * 1000000000) + 1;
  const functionName = `wallet_fx_barrier_${barrier}`;
  const pending: Promise<unknown>[] = [];
  try {
    await evidence();
    const q = await quote(s, 'crypto_futures');
    const deadline = new Date((await dbNow()).getTime() + 2200);
    await prisma.season.update({
      where: { id: s.season!.id },
      data: { endAt: deadline },
    });
    await db.query('SELECT pg_advisory_lock($1)', [barrier]);
    await db.query(
      `CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.trading_account_id = '${s.accountId}' THEN PERFORM pg_advisory_xact_lock(${barrier}); END IF; RETURN NEW; END; $$`,
    );
    await db.query(
      `CREATE TRIGGER "${functionName}" BEFORE INSERT ON wallet_transfer_execute_requests FOR EACH ROW EXECUTE FUNCTION "${functionName}"()`,
    );
    const command = { quoteId: q.data.quoteId, idempotencyKey: randomUUID() };
    const start = () => {
      const p = app.composite.execute(s.userId, s.accountId, command);
      void p.catch(() => {});
      pending.push(p);
      return p;
    };
    const first = start();
    await waitUntil(
      async () =>
        (
          await db.query(
            "SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = $1 AND NOT granted",
            [barrier],
          )
        ).rowCount === 1,
    );
    const second = start();
    await waitUntil(
      async () =>
        (
          await db.query(
            `SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%FROM "quotes"%' AND pg_blocking_pids(pid) && ARRAY(SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND objid = $1 AND NOT granted)`,
            [barrier],
          )
        ).rowCount! > 0,
    );
    await waitUntil(async () => (await dbNow()) > deadline);
    await db.query('SELECT pg_advisory_unlock($1)', [barrier]);
    assert.deepEqual(await second, await first);
    assert.equal((await state(s)).command, 1);
    assert.equal((await state(s)).fxCommand, 1);
    assert.equal((await state(s)).transfer, 1);
    console.log(
      'PASS committed Season composite replay across a locked deadline',
    );
  } finally {
    await db.query('SELECT pg_advisory_unlock($1)', [barrier]);
    await Promise.allSettled(pending);
    await db.query(
      `DROP TRIGGER IF EXISTS "${functionName}" ON wallet_transfer_execute_requests`,
    );
    await db.query(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    await db.end();
    await cleanup(s);
  }
}

async function providerPolicies() {
  const s = await fixture('general');
  const old = await prisma.fxRateSnapshot.findMany();
  try {
    await evidence();
    const q = await quote(s, 'crypto_spot');
    const before = await state(s);
    await prisma.fxRateSnapshot.updateMany({
      data: { capturedAt: new Date(0), effectiveAt: new Date(0) },
    });
    const body = { quoteId: q.data.quoteId, idempotencyKey: randomUUID() };
    await reject(
      app.composite.execute(s.userId, s.accountId, body),
      'PROVIDER_RATE_STALE',
    );
    assert.deepEqual(await state(s), before);
    // Refresh must happen before transaction starts; DB-only selector must not
    // call it again, even when evidence expires during a wallet lock wait.
    let inTransaction = false,
      refreshCalls = 0;
    const guarded = new Proxy(prisma, {
      get(target, key) {
        if (key === '$transaction')
          return async (
            fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
          ) =>
            target.$transaction(async (tx) => {
              inTransaction = true;
              try {
                return await fn(tx);
              } finally {
                inTransaction = false;
              }
            });
        const v = Reflect.get(target, key);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const refresh = {
      prepare: async () => {
        assert.equal(inTransaction, false);
        refreshCalls++;
        await evidence();
        return {};
      },
    } as unknown as UsdKrwRefreshService;
    await services(guarded, refresh).composite.execute(
      s.userId,
      s.accountId,
      body,
    );
    assert.equal(refreshCalls, 1);
    const actual = await prisma.walletTransferExecuteRequest.findFirstOrThrow({
      where: { tradingAccountId: s.accountId },
    });
    await services(guarded, refresh).composite.execute(
      s.userId,
      s.accountId,
      body,
    );
    assert.equal(refreshCalls, 1);
    assert.equal(actual.idempotencyKey, body.idempotencyKey);
    const rate = await evidence('1400');
    const future = await evidence('1404', 'exchange_rate_api');
    const priority = await quote(s, 'crypto_futures');
    assert.equal(priority.data.appliedRate, '1400.00000000');
    await prisma.fxRateSnapshot.updateMany({
      data: { capturedAt: new Date(0), effectiveAt: new Date(0) },
    });
    await prisma.fxRateSnapshot.update({
      where: { id: rate.id },
      data: {
        capturedAt: await dbNow(),
        effectiveAt: await dbNow(),
        sourceName: 'unknown-provider',
      },
    });
    await reject(
      app.composite.execute(s.userId, s.accountId, {
        quoteId: priority.data.quoteId,
        idempotencyKey: randomUUID(),
      }),
      'PROVIDER_RATE_STALE',
    );
    await prisma.fxRateSnapshot.delete({ where: { id: future.id } });
    console.log(
      'PASS provider stale/source priority/eligibility/network outside locks/replay without provider',
    );
  } finally {
    await cleanup(s);
    for (const row of old)
      await prisma.fxRateSnapshot.update({
        where: { id: row.id },
        data: { capturedAt: row.capturedAt, effectiveAt: row.effectiveAt },
      });
  }
}

async function main() {
  await prisma.$connect();
  const originalRates = await prisma.fxRateSnapshot.findMany();
  const ratesBefore = originalRates.map((r) => r.id);
  try {
    for (const mode of ['general', 'season', 'beginner'] as const) {
      for (const crypto of ['crypto_spot', 'crypto_futures'] as const)
        for (const reverse of [false, true])
          await parity(mode, crypto, reverse);
      for (const reverse of [false, true]) await rollback(mode, reverse);
      await policies(mode);
      await concurrency(mode);
    }
    for (const mode of ['general', 'season', 'beginner'] as const)
      await postLockBoundary(mode, 'quote');
    await postLockBoundary('season', 'season');
    await postLockBoundary('general', 'provider');
    await committedReplayAcrossDeadline();
    await providerPolicies();
    console.log('wallet FX transfer db integration ok');
  } finally {
    for (const row of originalRates)
      await prisma.fxRateSnapshot.update({
        where: { id: row.id },
        data: { capturedAt: row.capturedAt, effectiveAt: row.effectiveAt },
      });
    await prisma.fxRateSnapshot.deleteMany({
      where: { id: { notIn: ratesBefore } },
    });
    await prisma.$disconnect();
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
