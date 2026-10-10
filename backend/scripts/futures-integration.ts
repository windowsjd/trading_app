import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import { HttpException } from '@nestjs/common';
import {
  Prisma,
  type TradingAccountMode,
  type FuturesDirection,
} from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { TradingAccountAccessService } from '../src/trading-accounts/trading-account-access.service';
import { GeneralAccountsService } from '../src/trading-accounts/general-accounts.service';
import { GeneralAccountPerformanceService } from '../src/portfolio/general-account-performance.service';
import { GeneralExternalFundingService } from '../src/portfolio/general-external-funding.service';
import { PortfolioValuationService } from '../src/portfolio/portfolio-valuation.service';
import { FuturesService } from '../src/futures/futures.service';
import {
  planFuturesExecution,
  futuresDecimal,
} from '../src/futures/futures-math';
import {
  futuresCommandHash,
  parseFuturesCommand,
  type FuturesExecuteBody,
} from '../src/futures/futures-input';
import { settleFuturesCash } from '../src/futures/futures-settlement';
import { conditionalPrice } from '../src/conditional/conditional-price';
import { TradingAccountWalletTransferService } from '../src/wallets/trading-account-wallet-transfer.service';
import { TradingAccountWalletFxTransferService } from '../src/wallets/trading-account-wallet-fx-transfer.service';
import { FxService } from '../src/fx/fx.service';
import { FUTURES_LAST_MAX_CAPTURE_AGE_MS } from '../src/futures/futures-last-price';

if (
  process.env.NODE_ENV !== 'test' ||
  (process.env.FUTURES_DB_INTEGRATION !== '1' &&
    process.env.FUTURES_RISK_DB_INTEGRATION !== '1')
)
  throw new Error('Explicit test DB opt-in is required.');
process.env.GENERAL_TRADE_FEE_RATE = '0.001000';
process.env.FUTURES_TRADING_ENABLED = 'true';
process.env.BEGINNER_MODE_ENABLED = 'true';
const db = new PrismaService();
const d = futuresDecimal;
let checks = 0;
const fxEvidenceIds: string[] = [];
function services(prisma: PrismaService) {
  const access = new TradingAccountAccessService(prisma);
  const valuation = new PortfolioValuationService(prisma);
  const performance = new GeneralAccountPerformanceService(
    prisma,
    valuation,
    new GeneralExternalFundingService(prisma),
  );
  const transfer = new TradingAccountWalletTransferService(
    prisma,
    access,
    performance,
  );
  const fx = new FxService(
    prisma,
    undefined,
    undefined,
    access,
    performance,
    valuation,
  );
  return {
    futures: new FuturesService(prisma, access, performance),
    general: new GeneralAccountsService(prisma, performance),
    transfer,
    composite: new TradingAccountWalletFxTransferService(
      prisma,
      access,
      fx,
      transfer,
    ),
  };
}
const app = services(db);
const now = async () =>
  (
    await db.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`
  )[0].now;
async function fixture(mode: TradingAccountMode, cash = '10000') {
  const clock = await now();
  const user = await db.user.create({
    data: {
      email: `f1-${randomUUID()}@example.com`,
      nickname: randomUUID().slice(0, 16),
      passwordHash: 'test-only',
    },
  });
  const season =
    mode === 'season'
      ? await db.season.create({
          data: {
            name: `f1-${randomUUID()}`,
            status: 'active',
            startAt: new Date(clock.getTime() - 86400000),
            endAt: new Date(clock.getTime() + 86400000),
            initialCapitalKrw: '10000000',
            tradeFeeRate: '0.002',
            fxFeeRate: '0.001',
          },
        })
      : null;
  const accountId = season
    ? (
        await db.tradingAccount.create({
          data: {
            userId: user.id,
            mode,
            initialCapitalKrw: '10000000',
            openedAt: clock,
          },
        })
      ).id
    : (
        await (mode === 'beginner'
          ? app.general.openBeginnerAccount(user.id)
          : app.general.openGeneralAccount(user.id))
      ).data.account.id;
  if (season) {
    await db.seasonParticipant.create({
      data: {
        userId: user.id,
        seasonId: season.id,
        tradingAccountId: accountId,
        participantStatus: 'active',
        joinedAt: clock,
        initialCapitalKrw: '10000000',
        totalAssetKrw: '10000000',
        totalReturnRate: '0',
        maxDrawdown: '0',
      },
    });
    await db.cashWallet.createMany({
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
  const wallets = await db.cashWallet.findMany({
    where: { tradingAccountId: accountId },
  });
  const futuresWallet = wallets.find(
    (w) => w.walletScope === 'crypto_futures',
  )!;
  const spotWallet = wallets.find((w) => w.walletScope === 'crypto_spot')!;
  const krwWallet = wallets.find((w) => w.currencyCode === 'KRW')!;
  await db.cashWallet.update({
    where: { id: futuresWallet.id },
    data: { balanceAmount: cash },
  });
  await db.cashWallet.update({
    where: { id: spotWallet.id },
    data: { balanceAmount: '1000' },
  });
  const instruments = [] as Array<Awaited<ReturnType<typeof newInstrument>>>;
  for (let i = 0; i < 2; i++) instruments.push(await newInstrument());
  const s = {
    mode,
    userId: user.id,
    accountId,
    season,
    futuresWalletId: futuresWallet.id,
    spotWalletId: spotWallet.id,
    krwWalletId: krwWallet.id,
    instruments,
  };
  await price(s);
  return s;
}
async function newInstrument() {
  const asset = await db.asset.create({
    data: {
      symbol: `F1${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}USDT`,
      name: 'F1 fixture',
      market: 'BINANCE',
      assetType: 'crypto',
      currencyCode: 'USD',
      priceCurrency: 'USD',
      settlementCurrency: 'USD',
    },
  });
  const instrument = await db.futuresInstrument.create({
    data: {
      underlyingAssetId: asset.id,
      markVerifiedAt: await now(),
      markContractJson: {
        symbol: asset.symbol,
        pair: asset.symbol,
        baseAsset: asset.symbol.slice(0, -4),
        contractType: 'PERPETUAL',
        status: 'TRADING',
        quoteAsset: 'USDT',
        marginAsset: 'USDT',
        underlyingType: 'COIN',
      },
    },
  });
  return { asset, instrument };
}
type Scenario = Awaited<ReturnType<typeof fixture>>;
/** Futures Last observation: the execution/trigger/final price under test.
 * ageMs is the trade age (effectiveAt); receiptAgeMs the receipt (capturedAt). */
async function price(
  s: Scenario,
  value = '100',
  index = 0,
  ageMs = 1000,
  source:
    | 'binance_usdm_agg_trade_ws'
    | 'binance_usdm_ticker_price_rest' = 'binance_usdm_agg_trade_ws',
  receiptAgeMs = ageMs,
) {
  const clock = await now();
  // One receipt per instrument/source/ms; an equal-ms caller moves 1ms older.
  for (let shift = 0; ; shift++) {
    const captured = clock.getTime() - receiptAgeMs - shift;
    try {
      return await db.futuresLastPriceSnapshot.create({
        data: {
          instrumentId: s.instruments[index].instrument.id,
          symbol: s.instruments[index].asset.symbol,
          price: value,
          source,
          effectiveAt: new Date(Math.min(clock.getTime() - ageMs, captured)),
          capturedAt: new Date(captured),
        },
      });
    } catch (error) {
      if (
        shift >= 5 ||
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== 'P2002'
      )
        throw error;
    }
  }
}
/** Canonical Spot evidence of the same underlying (Spot domain only). */
async function spotPrice(s: Scenario, value = '100', index = 0, ageMs = 1000) {
  const clock = await now();
  return db.assetPriceSnapshot.create({
    data: {
      assetId: s.instruments[index].asset.id,
      price: value,
      currencyCode: 'USD',
      sourceType: 'provider_api',
      sourceName: 'binance_spot_ws_ticker',
      effectiveAt: new Date(clock.getTime() - ageMs),
      capturedAt: new Date(clock.getTime() - ageMs),
    },
  });
}
/** The newest known trade, as the Futures Last selector orders it. */
async function latestLast(s: Scenario, index = 0) {
  return db.futuresLastPriceSnapshot.findFirst({
    where: { instrumentId: s.instruments[index].instrument.id },
    orderBy: [{ effectiveAt: 'desc' }, { capturedAt: 'desc' }, { id: 'desc' }],
  });
}
/** Wait on the authoritative DB clock, never a JS timer assumption. */
async function untilDb(at: number) {
  const started = Date.now();
  while ((await now()).getTime() < at) {
    assert.ok(Date.now() - started < 15000, 'DB clock did not advance');
    await delay(25);
  }
}
async function fxEvidence() {
  const clock = await now();
  const snapshot = await db.fxRateSnapshot.create({
    data: {
      baseCurrency: 'USD',
      quoteCurrency: 'KRW',
      rate: '1400',
      sourceType: 'provider_api',
      sourceName: 'korea_exim_exchange_rate',
      effectiveAt: new Date(clock.getTime() - 1000),
      capturedAt: new Date(clock.getTime() - 1000),
    },
  });
  fxEvidenceIds.push(snapshot.id);
  return snapshot;
}
function openBody(s: Scenario, patch: FuturesExecuteBody = {}) {
  return {
    instrumentId: s.instruments[0].instrument.id,
    operation: 'open',
    direction: 'long',
    quantity: '1',
    leverage: 37,
    idempotencyKey: randomUUID(),
    ...patch,
  };
}
const execute = async (
  s: Scenario,
  body: FuturesExecuteBody,
  service = app.futures,
) => {
  // F1 exercises Futures Last execution. F2 risk evidence is independently kept
  // healthy at the planned entry basis; adverse/stale marks are covered by F2.
  if (['open', 'increase'].includes(String(body.operation))) {
    const index = s.instruments.findIndex(
      (r) => r.instrument.id === body.instrumentId,
    );
    const row = index >= 0 ? s.instruments[index] : undefined;
    const price = row && (await latestLast(s, index));
    if (row && price) {
      const current = await db.futuresPosition.findFirst({
        where: {
          tradingAccountId: s.accountId,
          instrumentId: row.instrument.id,
          status: 'open',
        },
      });
      let mark = price.price;
      try {
        mark = planFuturesExecution(
          parseFuturesCommand(body),
          current,
          price.price,
          d('0.001'),
        ).averageEntryPrice;
      } catch {
        /* Invalid command still reaches the product guard. */
      }
      const clock = await now();
      await db.futuresMarkSnapshot.createMany({
        data: [
          {
            instrumentId: row.instrument.id,
            symbol: row.asset.symbol,
            source: 'binance_usdm_mark_ws',
            price: mark,
            effectiveAt: clock,
            capturedAt: clock,
          },
        ],
        skipDuplicates: true,
      });
    }
  }
  return service.execute(s.userId, s.accountId, body);
};
async function positionBody(
  s: Scenario,
  operation: 'increase' | 'reduce' | 'close',
  patch: FuturesExecuteBody = {},
) {
  const p = await db.futuresPosition.findFirstOrThrow({
    where: {
      tradingAccountId: s.accountId,
      instrumentId: s.instruments[0].instrument.id,
      status: 'open',
    },
  });
  return {
    ...openBody(s),
    operation,
    positionId: p.id,
    direction: p.direction,
    leverage: p.leverage,
    ...patch,
  };
}
function code(error: unknown): string {
  return error instanceof HttpException
    ? (error.getResponse() as { error: { code: string } }).error.code
    : String(error);
}
async function reject(work: Promise<unknown>, expected: string) {
  await assert.rejects(work, (error: unknown) => {
    assert.equal(code(error), expected);
    return true;
  });
  checks++;
}
async function state(s: Scenario) {
  const where = { tradingAccountId: s.accountId };
  return JSON.parse(
    JSON.stringify({
      wallets: await db.cashWallet.findMany({ where, orderBy: { id: 'asc' } }),
      positions: await db.futuresPosition.findMany({
        where,
        orderBy: { id: 'asc' },
      }),
      executions: await db.futuresExecution.findMany({
        where,
        orderBy: { id: 'asc' },
      }),
      liquidations: await db.futuresLiquidation.findMany({
        where,
        orderBy: { id: 'asc' },
      }),
      liquidationCloses: await db.futuresLiquidationClose.findMany({
        where,
        orderBy: { id: 'asc' },
      }),
      commands: await db.futuresExecuteRequest.findMany({
        where,
        orderBy: { id: 'asc' },
      }),
      ledger: await db.walletTransaction.findMany({
        where,
        orderBy: { id: 'asc' },
      }),
      snapshots: await db.equitySnapshot.count({ where }),
      transfers: await db.walletTransfer.count({ where }),
      fx: await db.exchangeTransaction.count({ where }),
      fxCommands: await db.walletTransferExecuteRequest.count({ where }),
    }),
  ) as unknown;
}
async function invariant(s: Scenario) {
  const wallet = await db.cashWallet.findUniqueOrThrow({
    where: { id: s.futuresWalletId },
  });
  const open = await db.futuresPosition.findMany({
    where: { tradingAccountId: s.accountId, status: 'open' },
  });
  const margin = open.reduce((sum, p) => sum.add(p.isolatedMargin), d('0'));
  assert.ok(d(wallet.balanceAmount).sub(wallet.reservedAmount).gte(margin));
  assert.ok(wallet.balanceAmount.gte(0));
  assert.equal(wallet.reservedAmount.toFixed(8), '0.00000000');
  assert.equal(new Set(open.map((p) => p.instrumentId)).size, open.length);
  const commands = await db.futuresExecuteRequest.findMany({
    where: { tradingAccountId: s.accountId },
  });
  const executions = await db.futuresExecution.findMany({
    where: { tradingAccountId: s.accountId },
  });
  assert.equal(commands.length, executions.length);
  for (const e of executions) {
    const rows = await db.walletTransaction.findMany({
      where: { referenceType: 'futures_execution', referenceId: e.id },
    });
    assert.equal(rows.filter((r) => r.txType === 'fee').length, 1);
    assert.equal(
      rows.find((r) => r.txType === 'fee')!.amount.toFixed(8),
      e.feeAmount.toFixed(8),
    );
    assert.equal(
      rows.filter((r) => r.txType === 'futures_pnl').length,
      e.realizedPnl.eq(0) ? 0 : 1,
    );
    assert.ok(
      rows.every(
        (r) =>
          r.tradingAccountId === s.accountId &&
          r.walletId === s.futuresWalletId &&
          r.currencyCode === 'USD',
      ),
    );
    assert.equal(
      e.feeRate.toFixed(6),
      s.mode !== 'season' ? '0.001000' : '0.002000',
    );
    assert.ok(
      e.priceCapturedAt <= e.executedAt && e.priceEffectiveAt <= e.executedAt,
    );
  }
}
async function cleanup(s: Scenario) {
  const where = { tradingAccountId: s.accountId };
  await db.futuresLimitOrder.deleteMany({ where });
  await db.futuresExecuteRequest.deleteMany({ where });
  await db.walletTransaction.deleteMany({ where });
  await db.futuresExecution.deleteMany({ where });
  await db.futuresLiquidationClose.deleteMany({ where });
  await db.futuresLiquidation.deleteMany({ where });
  await db.futuresPosition.deleteMany({ where });
  await db.walletTransferExecuteRequest.deleteMany({ where });
  await db.walletTransferQuote.deleteMany({ where: { quote: where } });
  await db.walletTransfer.deleteMany({ where });
  await db.fxExecuteRequest.deleteMany({ where });
  await db.exchangeTransaction.deleteMany({ where });
  await db.quote.deleteMany({ where });
  await db.equitySnapshot.deleteMany({ where });
  await db.cashWallet.deleteMany({ where });
  await db.seasonParticipant.deleteMany({ where });
  await db.tradingAccount.delete({ where: { id: s.accountId } });
  if (s.season) await db.season.delete({ where: { id: s.season.id } });
  for (const row of s.instruments) {
    await db.futuresMarkSnapshot.deleteMany({
      where: { instrumentId: row.instrument.id },
    });
    await db.futuresLastPriceSnapshot.deleteMany({
      where: { instrumentId: row.instrument.id },
    });
    await db.futuresInstrument.delete({ where: { id: row.instrument.id } });
    await db.assetPriceSnapshot.deleteMany({
      where: { assetId: row.asset.id },
    });
    await db.asset.delete({ where: { id: row.asset.id } });
  }
  await db.user.delete({ where: { id: s.userId } });
}

async function lifecycle(
  mode: TradingAccountMode,
  direction: FuturesDirection,
) {
  const s = await fixture(mode);
  try {
    await fxEvidence();
    const snapshots = await db.equitySnapshot.count({
      where: { tradingAccountId: s.accountId },
    });
    const body = openBody(s, { direction, idempotencyKey: 'lifetime-key' });
    const opened = await execute(s, body);
    assert.equal(opened.data.position.direction, direction);
    assert.equal(opened.data.position.quantity, '1.00000000');
    assert.equal(opened.data.position.leverage, 37);
    assert.equal(opened.data.position.isolatedMargin, '2.70270271');
    assert.equal(
      opened.data.collateral.balanceAmount,
      mode !== 'season' ? '9999.90000000' : '9999.80000000',
    );
    await reject(
      execute(
        s,
        openBody(s, { direction: direction === 'long' ? 'short' : 'long' }),
      ),
      'FUTURES_POSITION_ALREADY_OPEN',
    );
    await reject(
      execute(s, await positionBody(s, 'increase', { leverage: 50 })),
      'FUTURES_LEVERAGE_MISMATCH',
    );
    await reject(
      execute(s, await positionBody(s, 'reduce', { quantity: '2' })),
      'INVALID_FUTURES_REDUCE_QUANTITY',
    );
    await reject(
      execute(
        s,
        await positionBody(s, 'reduce', {
          direction: direction === 'long' ? 'short' : 'long',
        }),
      ),
      'FUTURES_ONE_WAY_VIOLATION',
    );
    await price(s, '120');
    const increased = await execute(s, await positionBody(s, 'increase'));
    assert.equal(increased.data.position.averageEntryPrice, '110.00000000');
    assert.equal(increased.data.position.quantity, '2.00000000');
    assert.equal(increased.data.position.isolatedMargin, '5.94594595');
    await price(s, direction === 'long' ? '120' : '100');
    const partial = await execute(
      s,
      await positionBody(s, 'reduce', { quantity: '0.5' }),
    );
    assert.equal(partial.data.position.quantity, '1.50000000');
    assert.equal(partial.data.position.averageEntryPrice, '110.00000000');
    assert.equal(partial.data.position.isolatedMargin, '4.45945947');
    assert.equal(partial.data.execution.operation, 'reduce');
    assert.equal(partial.data.execution.realizedPnl, '5.00000000');
    assert.equal(partial.data.position.realizedPnl, '5.00000000');
    const risk = await app.futures.positions(s.userId, s.accountId);
    assert.equal(risk.data.positions[0].unrealizedPnl, '15.00000000');
    await price(s, direction === 'long' ? '90' : '130');
    // Manual loss cannot spend free cash beyond this lifetime's allocation.
    const beforeUnsafeClose = await state(s);
    await reject(
      execute(s, await positionBody(s, 'close', { quantity: '1.5' })),
      'FUTURES_LIQUIDATION_REQUIRED',
    );
    assert.deepEqual(await state(s), beforeUnsafeClose);
    await price(s, direction === 'long' ? '108' : '112');
    const closed = await execute(
      s,
      await positionBody(s, 'close', { quantity: '1.5' }),
    );
    assert.equal(closed.data.execution.realizedPnl, '-3.00000000');
    assert.equal(closed.data.execution.operation, 'close');
    assert.equal(closed.data.position.status, 'closed');
    assert.equal(closed.data.position.isolatedMargin, '0.00000000');
    assert.equal(closed.data.position.realizedPnl, '2.00000000');
    const executions = await db.futuresExecution.findMany({
      where: { tradingAccountId: s.accountId },
    });
    const fees = executions.reduce((sum, e) => sum.add(e.feeAmount), d('0'));
    assert.equal(
      closed.data.collateral.balanceAmount,
      d('10002').sub(fees).toFixed(8),
    );
    for (const e of executions) {
      // Every new execution is Futures Last evidence; none references Spot.
      assert.equal(e.assetPriceSnapshotId, null);
      const evidence = await db.futuresLastPriceSnapshot.findUniqueOrThrow({
        where: { id: e.lastPriceSnapshotId! },
      });
      assert.equal(evidence.instrumentId, s.instruments[0].instrument.id);
      assert.equal(e.executionPrice.toFixed(8), evidence.price.toFixed(8));
      assert.equal(e.priceSourceType, 'provider_api');
      assert.equal(e.priceSourceName, evidence.source);
      assert.equal(
        e.priceEffectiveAt.getTime(),
        evidence.effectiveAt.getTime(),
      );
      assert.equal(e.priceCapturedAt.getTime(), evidence.capturedAt.getTime());
    }
    await price(s);
    const reopened = await execute(
      s,
      openBody(s, {
        direction: direction === 'long' ? 'short' : 'long',
        leverage: 50,
      }),
    );
    assert.notEqual(reopened.data.position.id, opened.data.position.id);
    assert.equal(reopened.data.position.leverage, 50);
    assert.equal(reopened.data.position.realizedPnl, '0.00000000');
    const history = await app.futures.executions(s.userId, s.accountId, {
      limit: '2',
      offset: '0',
    });
    assert.equal(history.data.pagination.total, 5);
    assert.equal(history.data.executions.length, 2);
    assert.equal(history.data.pagination.nextOffset, 2);
    assert.equal(
      await db.position.count({ where: { tradingAccountId: s.accountId } }),
      0,
    );
    assert.equal(
      await db.order.count({ where: { tradingAccountId: s.accountId } }),
      0,
    );
    assert.equal(
      await db.equitySnapshot.count({
        where: { tradingAccountId: s.accountId },
      }),
      snapshots + 5,
    );
    process.env.FUTURES_TRADING_ENABLED = 'false';
    await db.tradingAccount.update({
      where: { id: s.accountId },
      data: { status: 'suspended' },
    });
    await db.futuresLastPriceSnapshot.deleteMany({
      where: { instrumentId: s.instruments[1].instrument.id },
    });
    assert.deepEqual(
      await execute(s, { ...body, quantity: '1.00000000' }),
      opened,
    );
    await reject(
      execute(s, { ...body, quantity: '2' }),
      'FUTURES_IDEMPOTENCY_CONFLICT',
    );
    await reject(
      app.futures.positions(randomUUID(), s.accountId),
      'TRADING_ACCOUNT_NOT_FOUND',
    );
    await invariant(s);
    checks++;
    console.log(
      `PASS ${mode}/${direction} complete lifetime, average, fee/PnL, history and committed replay`,
    );
  } finally {
    process.env.FUTURES_TRADING_ENABLED = 'true';
    await cleanup(s);
  }
}

async function marginAndFlags(mode: TradingAccountMode) {
  const s = await fixture(mode, '1000');
  try {
    delete process.env.FUTURES_TRADING_ENABLED;
    await reject(execute(s, openBody(s)), 'FUTURES_TRADING_DISABLED');
    assert.equal(
      (await app.futures.positions(s.userId, s.accountId)).data.positions
        .length,
      0,
    );
    assert.equal(
      (
        await app.futures.instruments(s.userId, s.accountId)
      ).data.instruments.filter((i) => i.id === s.instruments[0].instrument.id)
        .length,
      1,
    );
    process.env.FUTURES_TRADING_ENABLED = 'true';
    for (const leverage of [1, 2, 7, 37, 50, 68, 99, 100]) {
      await price(s);
      const opened = await execute(s, openBody(s, { leverage }));
      assert.ok(
        d(opened.data.position.isolatedMargin).gte(d('100').div(leverage)),
      );
      assert.ok(
        d(opened.data.position.isolatedMargin)
          .sub(d('100').div(leverage))
          .lt('0.00000001'),
      );
      assert.equal(
        opened.data.execution.feeAmount,
        mode !== 'season' ? '0.10000000' : '0.20000000',
      );
      await execute(s, await positionBody(s, 'close'));
      checks++;
    }
    for (const leverage of [0, -1, 101, 1.5, 99.9, NaN, Infinity, '37', 'bad'])
      await reject(
        execute(s, openBody(s, { leverage })),
        'INVALID_FUTURES_LEVERAGE',
      );
    const balance = (
      await db.cashWallet.findUniqueOrThrow({
        where: { id: s.futuresWalletId },
      })
    ).balanceAmount;
    // Cash equal to 100x margin is insufficient when executed-notional fee is due.
    await db.cashWallet.update({
      where: { id: s.futuresWalletId },
      data: { balanceAmount: '1' },
    });
    await reject(
      execute(s, openBody(s, { leverage: 100 })),
      'INSUFFICIENT_FUTURES_FREE_COLLATERAL',
    );
    await db.cashWallet.update({
      where: { id: s.futuresWalletId },
      data: { balanceAmount: '0.00000001' },
    });
    await reject(
      execute(s, openBody(s, { leverage: 100, quantity: '0.00000001' })),
      'FUTURES_MAINTENANCE_UNSAFE',
    );
    // F2 rounds maintenance up: allocate two cash quanta to remain above it.
    await db.cashWallet.update({
      where: { id: s.futuresWalletId },
      data: { balanceAmount: '0.00000002' },
    });
    await execute(s, openBody(s, { leverage: 50, quantity: '0.00000001' }));
    assert.equal(
      (await app.futures.positions(s.userId, s.accountId)).data.collateral
        .freeCollateral,
      '0.00000000',
    );
    await reject(
      app.transfer.transfer(s.userId, s.accountId, {
        sourceWalletId: s.futuresWalletId,
        destinationWalletId: s.spotWalletId,
        amount: '0.00000001',
        idempotencyKey: randomUUID(),
      }),
      'INSUFFICIENT_FUTURES_FREE_COLLATERAL',
    );
    await execute(
      s,
      await positionBody(s, 'close', { quantity: '0.00000001' }),
    );
    await db.cashWallet.update({
      where: { id: s.futuresWalletId },
      data: { balanceAmount: balance },
    });
    await execute(s, openBody(s, { quantity: '8', leverage: 1 }));
    const transfer = (amount: string) =>
      app.transfer.transfer(s.userId, s.accountId, {
        sourceWalletId: s.futuresWalletId,
        destinationWalletId: s.spotWalletId,
        amount,
        idempotencyKey: randomUUID(),
      });
    await reject(transfer('500'), 'INSUFFICIENT_FUTURES_FREE_COLLATERAL');
    await transfer('100');
    await fxEvidence();
    const q = await app.composite.quote(s.userId, s.accountId, {
      sourceWalletId: s.futuresWalletId,
      destinationWalletId: s.krwWalletId,
      amount: '500',
    });
    const before = await state(s);
    await reject(
      app.composite.execute(s.userId, s.accountId, {
        quoteId: q.data.quoteId,
        idempotencyKey: randomUUID(),
      }),
      'INSUFFICIENT_FUTURES_FREE_COLLATERAL',
    );
    assert.deepEqual(await state(s), before);
    const small = await app.composite.quote(s.userId, s.accountId, {
      sourceWalletId: s.futuresWalletId,
      destinationWalletId: s.krwWalletId,
      amount: '50',
    });
    await app.composite.execute(s.userId, s.accountId, {
      quoteId: small.data.quoteId,
      idempotencyKey: randomUUID(),
    });
    process.env.FUTURES_TRADING_ENABLED = 'false';
    for (const operation of ['increase', 'reduce', 'close'] as const)
      await reject(
        execute(
          s,
          await positionBody(s, operation, {
            quantity: operation === 'close' ? '8' : '1',
          }),
        ),
        'FUTURES_TRADING_DISABLED',
      );
    await app.transfer.transfer(s.userId, s.accountId, {
      sourceWalletId: s.spotWalletId,
      destinationWalletId: s.futuresWalletId,
      amount: '100',
      idempotencyKey: randomUUID(),
    });
    await invariant(s);
    checks++;
    console.log(
      `PASS ${mode} leverage/margin/fee boundaries, flag and both outgoing/incoming transfer routes`,
    );
  } finally {
    process.env.FUTURES_TRADING_ENABLED = 'true';
    await cleanup(s);
  }
}

async function lossAndEvidence(
  mode: TradingAccountMode,
  direction: FuturesDirection,
) {
  const s = await fixture(mode, '2');
  try {
    await execute(s, openBody(s, { leverage: 100, direction }));
    await price(s, direction === 'long' ? '1' : '1000');
    const before = await state(s);
    await reject(
      execute(s, await positionBody(s, 'close')),
      'FUTURES_LIQUIDATION_REQUIRED',
    );
    assert.deepEqual(await state(s), before);
    assert.equal(
      await db.futuresPosition.count({
        where: { tradingAccountId: s.accountId, status: 'open' },
      }),
      1,
    );
    await invariant(s);
    checks++;
    console.log(
      `PASS ${mode}/${direction} extreme loss full rollback, no clamp/delete/negative wallet`,
    );
  } finally {
    await cleanup(s);
  }
}

async function evidenceAndLifecycle(mode: TradingAccountMode) {
  const s = await fixture(mode);
  try {
    const body = openBody(s);
    const before = await state(s);
    await db.futuresLastPriceSnapshot.deleteMany({
      where: { instrumentId: s.instruments[0].instrument.id },
    });
    await reject(execute(s, body), 'FUTURES_PRICE_UNAVAILABLE');
    // Another instrument's fresh trade or the same underlying's fresh Spot
    // price cannot fund this execution: no cross-product fallback.
    await price(s, '100', 1);
    await spotPrice(s, '100');
    await reject(execute(s, body), 'FUTURES_PRICE_UNAVAILABLE');
    await price(s, '100', 0, 12000);
    await reject(execute(s, body), 'FUTURES_PRICE_STALE');
    // A fresh receipt reporting an OLDER trade never replaces a newer stale one.
    await price(s, '95', 0, 13000, 'binance_usdm_ticker_price_rest', 500);
    await reject(execute(s, body), 'FUTURES_PRICE_STALE');
    assert.deepEqual(await state(s), before);
    // A quiet market: REST re-confirms the same last trade with a fresh receipt.
    // The receipt is near the 10s limit so plain elapsed time makes it stale.
    const fresh = await price(
      s,
      '100',
      0,
      12000,
      'binance_usdm_ticker_price_rest',
      8500,
    );
    const quietFill = await execute(s, body);
    assert.equal(quietFill.data.execution.executionPrice, '100.00000000');
    assert.equal(
      quietFill.data.execution.priceEvidence.lastPriceSnapshotId,
      fresh.id,
    );
    assert.equal(
      quietFill.data.execution.priceEvidence.priceBasis,
      'futures_last',
    );
    assert.equal(
      quietFill.data.execution.priceEvidence.sourceName,
      'binance_usdm_ticker_price_rest',
    );
    await untilDb(
      fresh.capturedAt.getTime() + FUTURES_LAST_MAX_CAPTURE_AGE_MS + 1,
    );
    const staleRead = (await app.futures.positions(s.userId, s.accountId)).data
      .positions[0];
    assert.equal(staleRead.unrealizedPnl, null);
    assert.equal(staleRead.referencePrice, null);
    assert.equal(staleRead.referencePriceEvidence, null);
    assert.equal(
      (
        await db.futuresExecution.findUniqueOrThrow({
          where: {
            id: (
              await db.futuresExecuteRequest.findFirstOrThrow({
                where: { tradingAccountId: s.accountId },
              })
            ).executionId,
          },
        })
      ).priceCapturedAt.getTime(),
      fresh.capturedAt.getTime(),
    );
    await price(s);
    await db.tradingAccount.update({
      where: { id: s.accountId },
      data: { status: 'closed', closedAt: await now() },
    });
    await reject(
      execute(s, await positionBody(s, 'increase')),
      'TRADING_ACCOUNT_NOT_ACTIVE',
    );
    await db.tradingAccount.update({
      where: { id: s.accountId },
      data: { status: 'active', closedAt: null },
    });
    if (s.season) {
      await db.seasonParticipant.update({
        where: { tradingAccountId: s.accountId },
        data: { participantStatus: 'excluded' },
      });
      await reject(
        execute(s, await positionBody(s, 'reduce')),
        'PARTICIPANT_EXCLUDED',
      );
      await db.seasonParticipant.update({
        where: { tradingAccountId: s.accountId },
        data: { participantStatus: 'active' },
      });
      await db.season.update({
        where: { id: s.season.id },
        data: { endAt: new Date((await now()).getTime() - 1) },
      });
      await reject(execute(s, await positionBody(s, 'close')), 'SEASON_ENDED');
      assert.deepEqual(
        await execute(s, body),
        (
          await db.futuresExecuteRequest.findFirstOrThrow({
            where: { tradingAccountId: s.accountId },
          })
        ).responsePayloadJson,
      );
    }
    checks++;
    console.log(
      `PASS ${mode} DB price identity/staleness and account/season lifecycle`,
    );
  } finally {
    await cleanup(s);
  }
}

async function accountIsolation() {
  const general = await fixture('general');
  const season = await fixture('season');
  try {
    const body = openBody(general, {
      idempotencyKey: 'shared-key',
      leverage: 7,
    });
    const a = await execute(general, body);
    const b = await execute(season, { ...body, direction: 'short' });
    assert.notEqual(a.data.commandId, b.data.commandId);
    assert.notEqual(a.data.position.id, b.data.position.id);
    assert.equal(a.data.execution.feeAmount, '0.10000000');
    assert.equal(b.data.execution.feeAmount, '0.20000000');
    assert.deepEqual(await execute(general, body), a);
    assert.deepEqual(await execute(season, { ...body, direction: 'short' }), b);
    assert.equal(
      (await app.futures.positions(general.userId, general.accountId)).data
        .positions[0].direction,
      'long',
    );
    assert.equal(
      (await app.futures.positions(season.userId, season.accountId)).data
        .positions[0].direction,
      'short',
    );
    for (const read of [
      () => app.futures.instruments(general.userId, season.accountId),
      () => app.futures.executions(general.userId, season.accountId),
      () => execute({ ...season, userId: general.userId }, body),
    ])
      await reject(read(), 'TRADING_ACCOUNT_NOT_FOUND');
    await invariant(general);
    await invariant(season);
    checks++;
    console.log(
      'PASS General/Season same instrument and key keep positions, wallets, history, fees and ownership isolated',
    );
  } finally {
    await cleanup(season);
    await cleanup(general);
  }
}

async function remainingMarginLoss(
  mode: TradingAccountMode,
  direction: FuturesDirection,
) {
  const s = await fixture(mode, '50');
  try {
    await execute(s, openBody(s, { quantity: '0.8', leverage: 2, direction }));
    await price(s, direction === 'long' ? '1' : '180');
    const body = await positionBody(s, 'reduce', { quantity: '0.4' });
    const before = await state(s);
    // Cash after loss would remain positive, but would not cover remaining margin.
    await reject(execute(s, body), 'FUTURES_LIQUIDATION_REQUIRED');
    assert.deepEqual(await state(s), before);
    await invariant(s);
    checks++;
    console.log(
      `PASS ${mode}/${direction} partial loss cannot spend remaining isolated margin`,
    );
  } finally {
    await cleanup(s);
  }
}

function faultyDb(point: string, occurrence = 1) {
  return new Proxy(db, {
    get(target, key) {
      if (key === '$transaction')
        return async (
          work: (tx: Prisma.TransactionClient) => Promise<unknown>,
        ) =>
          target.$transaction(async (tx) => {
            let debits = 0;
            let matches = 0;
            const proxy = new Proxy(tx, {
              get(client, prop) {
                const value = Reflect.get(client, prop);
                if (prop === '$executeRaw')
                  return async (...args: unknown[]) => {
                    const result = await value.apply(client, args);
                    if (point === `debit-${++debits}`) throw new Error(point);
                    return result;
                  };
                if (
                  [
                    'cashWallet',
                    'futuresPosition',
                    'futuresExecution',
                    'walletTransaction',
                    'futuresExecuteRequest',
                    'futuresLimitOrder',
                    'futuresSeasonSettlement',
                    'futuresSeasonClose',
                    'equitySnapshot',
                    'protectionGroup',
                    'protectionLeg',
                    'protectionChild',
                    'protectionCommand',
                    'order',
                    'position',
                    'quote',
                  ].includes(String(prop))
                )
                  return new Proxy(value, {
                    get(delegate, method) {
                      const fn = Reflect.get(delegate, method);
                      if (typeof fn !== 'function') return fn;
                      return async (...args: unknown[]) => {
                        const result = await fn.apply(delegate, args);
                        if (
                          point === `${String(prop)}.${String(method)}` &&
                          ++matches === occurrence
                        )
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
async function rollback(mode: TradingAccountMode) {
  const s = await fixture(mode);
  try {
    for (const point of [
      'debit-1',
      'futuresPosition.create',
      'futuresExecution.create',
      'walletTransaction.createMany',
      'futuresExecuteRequest.create',
    ]) {
      await price(s);
      const before = await state(s);
      await assert.rejects(
        execute(s, openBody(s), services(faultyDb(point)).futures),
        (error: unknown) => String(error).includes(point),
      );
      assert.deepEqual(await state(s), before);
      checks++;
    }
    await execute(s, openBody(s, { leverage: 1 }));
    for (const value of ['110', '90']) {
      for (const point of [
        value === '110' ? 'cashWallet.updateMany' : 'debit-2',
        'debit-1',
        'futuresPosition.update',
        'futuresExecution.create',
        'walletTransaction.createMany',
        'futuresExecuteRequest.create',
      ]) {
        await price(s, value);
        const before = await state(s);
        const body = await positionBody(s, 'reduce', { quantity: '0.5' });
        await assert.rejects(
          execute(s, body, services(faultyDb(point)).futures),
          (error: unknown) => String(error).includes(point),
        );
        assert.deepEqual(await state(s), before);
        checks++;
      }
    }
    await invariant(s);
    console.log(
      `PASS ${mode} 17 fault points after actual cash/position/evidence/ledger/command writes`,
    );
  } finally {
    await cleanup(s);
  }
}

async function races(mode: TradingAccountMode) {
  for (const kind of [
    'duplicate',
    'same-open',
    'increase',
    'increase-reduce',
    'reduce-close',
    'different-instruments',
    'transfer',
    'fx-transfer',
  ] as const) {
    const s = await fixture(mode, '1000');
    try {
      const initial = openBody(s, { leverage: 1 });
      let tasks: Array<Promise<unknown>>;
      if (kind === 'duplicate')
        tasks = [execute(s, initial), execute(s, initial)];
      else if (kind === 'same-open')
        tasks = [
          execute(s, initial),
          execute(s, { ...initial, idempotencyKey: randomUUID() }),
        ];
      else if (['increase', 'increase-reduce', 'reduce-close'].includes(kind)) {
        await execute(s, initial);
        const p = await positionBody(s, 'increase', { quantity: '0.5' });
        if (kind === 'increase')
          tasks = [
            execute(s, p),
            execute(s, { ...p, idempotencyKey: randomUUID() }),
          ];
        else if (kind === 'increase-reduce')
          tasks = [
            execute(s, p),
            execute(s, {
              ...p,
              operation: 'reduce',
              idempotencyKey: randomUUID(),
            }),
          ];
        else
          tasks = [
            execute(s, { ...p, operation: 'reduce', quantity: '0.4' }),
            execute(s, {
              ...p,
              operation: 'close',
              quantity: '1',
              idempotencyKey: randomUUID(),
            }),
          ];
      } else if (kind === 'different-instruments') {
        await price(s, '100', 1);
        tasks = [
          execute(s, { ...initial, quantity: '8' }),
          execute(
            s,
            openBody(s, {
              instrumentId: s.instruments[1].instrument.id,
              quantity: '8',
              leverage: 1,
            }),
          ),
        ];
      } else if (kind === 'transfer') {
        tasks = [
          execute(s, { ...initial, quantity: '8' }),
          app.transfer.transfer(s.userId, s.accountId, {
            sourceWalletId: s.futuresWalletId,
            destinationWalletId: s.spotWalletId,
            amount: '500',
            idempotencyKey: randomUUID(),
          }),
        ];
      } else {
        await fxEvidence();
        const quote = await app.composite.quote(s.userId, s.accountId, {
          sourceWalletId: s.futuresWalletId,
          destinationWalletId: s.krwWalletId,
          amount: '500',
        });
        tasks = [
          execute(s, { ...initial, quantity: '8' }),
          app.composite.execute(s.userId, s.accountId, {
            quoteId: quote.data.quoteId,
            idempotencyKey: randomUUID(),
          }),
        ];
      }
      const result = await Promise.allSettled(tasks);
      const success = result.filter((row) => row.status === 'fulfilled').length;
      assert.equal(
        success,
        ['duplicate', 'increase', 'increase-reduce'].includes(kind) ? 2 : 1,
        JSON.stringify({
          kind,
          outcomes: result.map((r) =>
            r.status === 'rejected'
              ? { code: code(r.reason), message: String(r.reason) }
              : 'fulfilled',
          ),
        }),
      );
      if (kind === 'duplicate')
        assert.deepEqual(
          (result[0] as PromiseFulfilledResult<unknown>).value,
          (result[1] as PromiseFulfilledResult<unknown>).value,
        );
      for (const row of result)
        if (row.status === 'rejected')
          assert.ok(
            [
              'FUTURES_POSITION_ALREADY_OPEN',
              'FUTURES_POSITION_NOT_FOUND',
              'INVALID_FUTURES_REDUCE_QUANTITY',
              'INSUFFICIENT_FUTURES_FREE_COLLATERAL',
            ].includes(code(row.reason)),
            code(row.reason),
          );
      const positions = await db.futuresPosition.findMany({
        where: { tradingAccountId: s.accountId, status: 'open' },
      });
      if (kind === 'increase')
        assert.equal(positions[0].quantity.toFixed(8), '2.00000000');
      if (kind === 'increase-reduce')
        assert.equal(positions[0].quantity.toFixed(8), '1.00000000');
      if (kind === 'duplicate' || kind === 'same-open')
        assert.equal(
          await db.futuresExecution.count({
            where: { tradingAccountId: s.accountId },
          }),
          1,
        );
      await invariant(s);
      checks++;
      console.log(
        `PASS ${mode} concurrent ${kind}, no duplicate fee/execution or collateral allocation`,
      );
    } finally {
      await cleanup(s);
    }
  }
}

async function walletWait(
  mode: TradingAccountMode,
  boundary: 'price' | 'season' | 'flag',
) {
  const s = await fixture(mode);
  const blocker = new Client({ connectionString: process.env.DATABASE_URL });
  let pending: Promise<unknown> | undefined;
  try {
    await blocker.connect();
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT id FROM cash_wallets WHERE id = $1 FOR UPDATE',
      [s.futuresWalletId],
    );
    if (boundary === 'price') {
      await db.futuresLastPriceSnapshot.deleteMany({
        where: { instrumentId: s.instruments[0].instrument.id },
      });
      await price(s, '100', 0, 9000);
    }
    if (boundary === 'season')
      await db.season.update({
        where: { id: s.season!.id },
        data: { endAt: new Date((await now()).getTime() + 1500) },
      });
    const before = await state(s);
    pending = execute(s, openBody(s));
    // Attach a rejection handler while the command is waiting.
    void pending.catch(() => undefined);
    const deadline = Date.now() + 4000;
    while (true) {
      await blocker.query('SELECT pg_stat_clear_snapshot()');
      const waiting = await blocker.query(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock' AND query LIKE '%crypto_futures%' AND query LIKE '%FOR UPDATE%'",
      );
      if (waiting.rows[0].n > 0) break;
      assert.ok(Date.now() < deadline, 'Futures wallet wait barrier timed out');
      await delay(10);
    }
    if (boundary === 'flag') process.env.FUTURES_TRADING_ENABLED = 'false';
    else {
      // Wait for the authoritative DB boundary, not a JS timer assumption.
      const boundaryAt =
        boundary === 'season'
          ? (await db.season.findUniqueOrThrow({ where: { id: s.season!.id } }))
              .endAt
          : new Date((await latestLast(s))!.capturedAt.getTime() + 11001);
      const started = Date.now();
      while (
        (await blocker.query('SELECT clock_timestamp() AS now')).rows[0].now <
        boundaryAt
      ) {
        assert.ok(Date.now() - started < 10000, 'DB boundary did not advance');
        await delay(25);
      }
    }
    await blocker.query('COMMIT');
    await reject(
      pending,
      boundary === 'price'
        ? 'FUTURES_PRICE_STALE'
        : boundary === 'season'
          ? 'SEASON_ENDED'
          : 'FUTURES_TRADING_DISABLED',
    );
    assert.deepEqual(await state(s), before);
    checks++;
    console.log(
      `PASS ${mode} post-wallet-lock ${boundary} boundary rejects with no financial writes`,
    );
  } finally {
    process.env.FUTURES_TRADING_ENABLED = 'true';
    await blocker.query('ROLLBACK').catch(() => undefined);
    if (pending) await pending.catch(() => undefined);
    await blocker.end();
    await cleanup(s);
  }
}

/** Commits a lifetime exactly as the pre-Futures-Last service did: Spot
 * evidence FK/source, real cash/fee ledger primitive and the old response shape. */
async function legacySpotOpen(
  s: Scenario,
  index: number,
  body: FuturesExecuteBody,
) {
  const spot = await spotPrice(s, '100', index);
  const command = parseFuturesCommand(body);
  return db.$transaction(async (tx) => {
    const executeNow = (
      await tx.$queryRaw<
        Array<{ now: Date }>
      >`SELECT clock_timestamp() AS "now"`
    )[0].now;
    await tx.$queryRaw`SELECT id FROM cash_wallets WHERE id = ${s.futuresWalletId} FOR UPDATE`;
    const wallet = await tx.cashWallet.findUniqueOrThrow({
      where: { id: s.futuresWalletId },
    });
    const feeRate = d('0.001');
    const plan = planFuturesExecution(command, null, spot.price, feeRate);
    const executionId = randomUUID();
    const commandId = randomUUID();
    const { ledger } = await settleFuturesCash(
      tx,
      wallet,
      'futures_execution',
      executionId,
      plan.realizedPnl,
      plan.feeAmount,
      executeNow,
    );
    const position = await tx.futuresPosition.create({
      data: {
        tradingAccountId: s.accountId,
        instrumentId: command.instrumentId,
        direction: command.direction,
        marginMode: command.marginMode,
        quantity: plan.quantity.toFixed(8),
        averageEntryPrice: plan.averageEntryPrice.toFixed(8),
        entryNotional: plan.entryNotional.toFixed(16),
        leverage: command.leverage,
        isolatedMargin: plan.isolatedMargin.toFixed(8),
        realizedPnl: plan.cumulativeRealizedPnl.toFixed(8),
        status: plan.status,
        createdAt: executeNow,
        updatedAt: executeNow,
      },
    });
    const execution = await tx.futuresExecution.create({
      data: {
        id: executionId,
        tradingAccountId: s.accountId,
        instrumentId: command.instrumentId,
        positionId: position.id,
        operation: 'open',
        direction: command.direction,
        marginMode: command.marginMode,
        quantity: command.quantity,
        leverage: command.leverage,
        executionPrice: spot.price,
        assetPriceSnapshotId: spot.id,
        priceSourceType: spot.sourceType,
        priceSourceName: spot.sourceName!,
        priceEffectiveAt: spot.effectiveAt,
        priceCapturedAt: spot.capturedAt,
        notional: plan.notional.toFixed(8),
        feeRate,
        feeAmount: plan.feeAmount.toFixed(8),
        realizedPnl: plan.realizedPnl.toFixed(8),
        positionQuantityAfter: position.quantity,
        averageEntryPriceAfter: position.averageEntryPrice,
        isolatedMarginAfter: position.isolatedMargin,
        executedAt: executeNow,
        createdAt: executeNow,
      },
    });
    await tx.walletTransaction.createMany({ data: ledger });
    // The response shape stored before Futures Last (no lastPriceSnapshotId/priceBasis).
    const payload = {
      success: true,
      data: {
        tradingAccountId: s.accountId,
        commandId,
        execution: {
          id: execution.id,
          executionPrice: execution.executionPrice.toFixed(8),
          priceEvidence: {
            assetPriceSnapshotId: spot.id,
            sourceType: spot.sourceType,
            sourceName: spot.sourceName,
            effectiveAt: spot.effectiveAt.toISOString(),
            capturedAt: spot.capturedAt.toISOString(),
          },
        },
        position: { id: position.id, quantity: position.quantity.toFixed(8) },
      },
    };
    await tx.futuresExecuteRequest.create({
      data: {
        id: commandId,
        tradingAccountId: s.accountId,
        executionId,
        idempotencyKey: command.idempotencyKey,
        requestHash: futuresCommandHash(s.accountId, command),
        responsePayloadJson: payload,
        executedAt: executeNow,
        createdAt: executeNow,
      },
    });
    return { spot, position, execution, payload };
  });
}

/** One underlying, three domains: Spot keeps Spot, Futures uses Futures Last,
 * risk keeps Mark. Spot-era history and replays survive the price switch. */
async function legacyAndIsolation(mode: TradingAccountMode) {
  const s = await fixture(mode);
  try {
    const legacyBody = openBody(s, {
      instrumentId: s.instruments[1].instrument.id,
      leverage: 10,
      idempotencyKey: 'spot-era-open',
    });
    const legacy = await legacySpotOpen(s, 1, legacyBody);
    const legacyRow = JSON.stringify(
      await db.futuresExecution.findUniqueOrThrow({
        where: { id: legacy.execution.id },
      }),
    );
    // Committed replay returns the stored Spot-era payload, needing no price.
    await db.futuresLastPriceSnapshot.deleteMany({
      where: { instrumentId: s.instruments[1].instrument.id },
    });
    assert.deepEqual(await execute(s, legacyBody), legacy.payload);
    const history = await app.futures.executions(s.userId, s.accountId);
    const shown = history.data.executions.find(
      (e) => e.id === legacy.execution.id,
    )!;
    assert.deepEqual(shown.priceEvidence, {
      assetPriceSnapshotId: legacy.spot.id,
      lastPriceSnapshotId: null,
      priceBasis: 'spot_last',
      sourceType: 'provider_api',
      sourceName: 'binance_spot_ws_ticker',
      effectiveAt: legacy.spot.effectiveAt.toISOString(),
      capturedAt: legacy.spot.capturedAt.toISOString(),
    });
    // A new exit of that Spot-era lifetime needs Futures Last: fresh Spot of
    // the same underlying is never a fallback.
    await spotPrice(s, '120', 1);
    const close = {
      ...legacyBody,
      operation: 'close',
      positionId: legacy.position.id,
      idempotencyKey: randomUUID(),
    };
    await reject(execute(s, close), 'FUTURES_PRICE_UNAVAILABLE');
    await price(s, '110', 1);
    const closed = await execute(s, close);
    assert.equal(closed.data.execution.executionPrice, '110.00000000');
    assert.equal(closed.data.execution.realizedPnl, '10.00000000');
    assert.equal(
      closed.data.execution.priceEvidence.priceBasis,
      'futures_last',
    );
    assert.equal(
      closed.data.execution.priceEvidence.assetPriceSnapshotId,
      null,
    );
    assert.equal(
      JSON.stringify(
        await db.futuresExecution.findUniqueOrThrow({
          where: { id: legacy.execution.id },
        }),
      ),
      legacyRow,
    );
    // Same underlying, three different prices and three separate selectors.
    await spotPrice(s, '100');
    await price(s, '105');
    const opened = await execute(s, openBody(s, { leverage: 10 }));
    assert.equal(opened.data.execution.executionPrice, '105.00000000');
    const asset = s.instruments[0].asset;
    const clock = await now();
    await db.futuresMarkSnapshot.create({
      data: {
        instrumentId: s.instruments[0].instrument.id,
        symbol: asset.symbol,
        source: 'binance_usdm_mark_ws',
        price: '90',
        effectiveAt: clock,
        capturedAt: clock,
      },
    });
    // Many newer Futures observations never crowd Spot selection out.
    for (let i = 0; i < 15; i++) await price(s, '106', 0, 500 - i * 10);
    const at = await now();
    const spotSelected = await conditionalPrice(db, asset, 'spot', at);
    const futuresSelected = await conditionalPrice(db, asset, 'futures', at);
    assert.equal(spotSelected?.kind, 'spot');
    assert.equal(spotSelected?.price.toFixed(8), '100.00000000');
    assert.equal(futuresSelected?.kind, 'futures_last');
    assert.equal(futuresSelected?.price.toFixed(8), '106.00000000');
    const read = (
      await app.futures.positions(s.userId, s.accountId)
    ).data.positions.find(
      (p) => p.instrumentId === s.instruments[0].instrument.id,
    )!;
    assert.equal(read.referencePrice, '106.00000000');
    assert.equal(read.markPrice, '90.00000000');
    assert.equal(read.referencePriceEvidence?.priceBasis, 'futures_last');
    await invariant(s);
    checks++;
    console.log(
      `PASS ${mode} Spot-era execution/replay preserved; Spot, Futures Last and Mark stay isolated`,
    );
  } finally {
    await cleanup(s);
  }
}

async function databaseConstraints() {
  const s = await fixture('general');
  try {
    const base = {
      tradingAccountId: s.accountId,
      instrumentId: s.instruments[0].instrument.id,
      direction: 'long' as const,
      quantity: '1',
      averageEntryPrice: '100',
      entryNotional: '100',
      isolatedMargin: '1',
      leverage: 100,
    };
    for (const patch of [
      { leverage: 0 },
      { leverage: 101 },
      { leverage: -1 },
      { quantity: '0' },
      { isolatedMargin: '-1' },
      { averageEntryPrice: 'NaN' },
      { status: 'closed' as const },
      { direction: 'bad' as never },
    ]) {
      await assert.rejects(
        db.futuresPosition.create({ data: { ...base, ...patch } }),
      );
      checks++;
    }
    await assert.rejects(
      db.$executeRaw`INSERT INTO futures_positions (id, trading_account_id, instrument_id, direction, quantity, average_entry_price, entry_notional, leverage, isolated_margin, updated_at) VALUES (${randomUUID()}, ${s.accountId}, ${base.instrumentId}, 'long', 1, 100, 100, ${'1.5'}::integer, 1, clock_timestamp())`,
    );
    const opened = await execute(s, openBody(s));
    await assert.rejects(
      db.futuresPosition.create({ data: { ...base, direction: 'short' } }),
    );
    await assert.rejects(
      db.futuresPosition.update({
        where: { id: opened.data.position.id },
        data: { leverage: 50 },
      }),
    );
    await assert.rejects(
      db.futuresInstrument.update({
        where: { id: base.instrumentId },
        data: { underlyingAssetId: s.instruments[1].asset.id },
      }),
    );
    await assert.rejects(
      db.futuresInstrument.create({
        data: {
          underlyingAssetId: s.instruments[1].asset.id,
          settlementCurrency: 'KRW',
        },
      }),
    );
    const e = await db.futuresExecution.findUniqueOrThrow({
      where: { id: opened.data.execution.id },
    });
    const { id: _id, ...data } = e;
    const wrong = await price(s, '100', 1);
    const spot = await spotPrice(s, '100');
    const own = await db.futuresLastPriceSnapshot.findUniqueOrThrow({
      where: { id: e.lastPriceSnapshotId! },
    });
    const other = await price(s, '101');
    for (const patch of [
      { lastPriceSnapshotId: wrong.id }, // another instrument
      { lastPriceSnapshotId: other.id }, // copied price/time differ
      { assetPriceSnapshotId: spot.id }, // both evidence kinds
      { lastPriceSnapshotId: null, assetPriceSnapshotId: null }, // neither
      { priceSourceName: 'binance_spot_ws_ticker' }, // Spot name on Last FK
      { priceSourceName: 'binance_usdm_mark_ws' }, // Mark is never a fill price
      { lastPriceSnapshotId: null, assetPriceSnapshotId: spot.id }, // Spot FK, Futures name
    ]) {
      await assert.rejects(
        db.futuresExecution.create({ data: { ...data, ...patch } }),
      );
      checks++;
    }
    // Legacy Spot evidence (pre-Futures-Last rows / rolling deploy) stays valid.
    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.futuresExecution.create({
          data: {
            ...data,
            lastPriceSnapshotId: null,
            assetPriceSnapshotId: spot.id,
            priceSourceName: spot.sourceName!,
            executionPrice: spot.price,
            priceEffectiveAt: spot.effectiveAt,
            priceCapturedAt: spot.capturedAt,
          },
        });
        throw new Error('legacy-spot-row-accepted');
      }),
      /legacy-spot-row-accepted/,
    );
    // Evidence rows are immutable and identity-bound.
    await assert.rejects(
      db.futuresLastPriceSnapshot.update({
        where: { id: own.id },
        data: { price: '999' },
      }),
    );
    for (const patch of [
      { symbol: s.instruments[1].asset.symbol },
      { symbol: 'BTCUSD_PERP' },
      { currencyCode: 'KRW' as const },
      { providerProduct: 'binance_spot' },
      { price: '0' },
      { effectiveAt: new Date(+own.capturedAt + 8) }, // trade after receipt
    ]) {
      await assert.rejects(
        db.futuresLastPriceSnapshot.create({
          data: {
            instrumentId: own.instrumentId,
            symbol: own.symbol,
            source: own.source,
            price: own.price,
            effectiveAt: own.effectiveAt,
            capturedAt: new Date(+own.capturedAt + 7),
            ...patch,
          },
        }),
      );
      checks++;
    }
    // Referenced evidence cannot be deleted.
    await assert.rejects(
      db.futuresLastPriceSnapshot.delete({ where: { id: own.id } }),
    );
    await invariant(s);
    checks++;
    console.log(
      'PASS direct PostgreSQL structural writes reject invalid leverage/quantity/direction/state, hedge, identity and wrong evidence',
    );
  } finally {
    await cleanup(s);
  }
}

async function main() {
  await db.$connect();
  await databaseConstraints();
  await legacyAndIsolation('general');
  await accountIsolation();
  for (const mode of ['general', 'season', 'beginner'] as const) {
    for (const direction of ['long', 'short'] as const) {
      await lifecycle(mode, direction);
      await lossAndEvidence(mode, direction);
      await remainingMarginLoss(mode, direction);
    }
    await marginAndFlags(mode);
    await evidenceAndLifecycle(mode);
    await rollback(mode);
    await races(mode);
    await walletWait(mode, 'price');
    await walletWait(mode, 'flag');
  }
  await walletWait('season', 'season');
  console.log(
    `futures F1 db integration ok (${checks} financial/guard/race/rollback checks)`,
  );
}
export {
  fxEvidenceIds,
  db,
  app,
  services,
  faultyDb,
  now,
  fixture,
  newInstrument,
  price,
  spotPrice,
  latestLast,
  untilDb,
  fxEvidence,
  openBody,
  positionBody,
  reject,
  state,
  invariant,
  cleanup,
  code,
};
export type { Scenario };
if (process.argv[1]?.endsWith('futures-integration.ts'))
  main()
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await db.fxRateSnapshot.deleteMany({
        where: { id: { in: fxEvidenceIds } },
      });
      await db.$disconnect();
    });
