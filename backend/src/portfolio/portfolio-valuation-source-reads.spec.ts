jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<{ Decimal: typeof Prisma.Decimal }>(
    '@prisma/client/runtime/client',
  );
  return {
    AssetPriceSourceType: {
      admin_manual: 'admin_manual',
      provider_api: 'provider_api',
    },
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    CurrencyCode: { KRW: 'KRW', USD: 'USD' },
    FxRateSourceType: {
      admin_manual: 'admin_manual',
      provider_api: 'provider_api',
    },
    Prisma: { Decimal },
    PrismaClient: class PrismaClient {},
    TradingAccountMode: { general: 'general', season: 'season' },
  };
});

import {
  AssetPriceSourceType,
  AssetType,
  CurrencyCode,
  FxRateSourceType,
  Prisma,
  TradingAccountMode,
} from '../generated/prisma/client';
import { PortfolioValuationError } from './portfolio-valuation.policy';
import {
  PortfolioValuationService,
  type PortfolioValuationSourceReads,
} from './portfolio-valuation.service';

const valuationAt = new Date('2026-06-03T00:00:00.000Z');
const observedAt = new Date('2026-06-02T23:59:30.000Z');

function account(id: string) {
  return {
    id,
    userId: `user-${id}`,
    mode: TradingAccountMode.season,
    initialCapitalKrw: new Prisma.Decimal('1000000'),
    seasonParticipant: {
      id: `participant-${id}`,
      userId: `user-${id}`,
      initialCapitalKrw: new Prisma.Decimal('1000000'),
    },
    cashWallets: [
      {
        currencyCode: CurrencyCode.KRW,
        balanceAmount: new Prisma.Decimal('900000'),
      },
      {
        currencyCode: CurrencyCode.USD,
        balanceAmount: new Prisma.Decimal('2'),
      },
    ],
    positions: [
      {
        assetId: 'asset-1',
        quantity: new Prisma.Decimal('2'),
        averageCost: new Prisma.Decimal('80'),
        currencyCode: CurrencyCode.USD,
        realizedPnl: new Prisma.Decimal('0'),
        realizedPnlKrw: new Prisma.Decimal('0'),
        asset: {
          id: 'asset-1',
          assetType: AssetType.crypto,
          market: 'BINANCE',
          currencyCode: CurrencyCode.USD,
          priceCurrency: CurrencyCode.USD,
        },
      },
    ],
  };
}

function price(
  sourceName = 'binance_spot_ws_ticker',
  value = '110',
  time = observedAt,
) {
  return {
    id: `price-${sourceName}-${value}`,
    assetId: 'asset-1',
    price: new Prisma.Decimal(value),
    priceKrw: null,
    currencyCode: CurrencyCode.USD,
    sourceType: AssetPriceSourceType.provider_api,
    sourceName,
    effectiveAt: time,
    capturedAt: time,
    createdAt: time,
  };
}

function fx(sourceName = 'korea_exim_exchange_rate', value = '1490') {
  return {
    id: `fx-${sourceName}-${value}`,
    baseCurrency: CurrencyCode.USD,
    quoteCurrency: CurrencyCode.KRW,
    rate: new Prisma.Decimal(value),
    sourceType: FxRateSourceType.provider_api,
    sourceName,
    effectiveAt: observedAt,
    capturedAt: observedAt,
    createdAt: observedAt,
    approvedByUserId: null as string | null,
  };
}

function setup() {
  const prisma = {
    tradingAccount: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(account(where.id)),
      ),
    },
    assetPriceSnapshot: {
      findMany: jest.fn(() =>
        Promise.resolve([
          price('binance_public_rest_24hr_ticker', '100'),
          price(),
        ]),
      ),
      findFirst: jest
        .fn<Promise<ReturnType<typeof price> | null>, [unknown]>()
        .mockResolvedValue(null),
    },
    fxRateSnapshot: {
      findMany: jest.fn(() =>
        Promise.resolve([fx('exchange_rate_api', '1500'), fx()]),
      ),
      findFirst: jest
        .fn<Promise<ReturnType<typeof fx> | null>, [unknown]>()
        .mockResolvedValue(null),
    },
  };
  const service = new PortfolioValuationService(prisma as never);
  const reads = (): PortfolioValuationSourceReads => ({
    client: prisma as never,
    valuationAtMs: valuationAt.getTime(),
    workflow: 'live_portfolio_valuation',
    assetPrices: new Map(),
  });
  const calculate = (id: string, sourceReads?: PortfolioValuationSourceReads) =>
    service.calculateTradingAccountValuation(
      id,
      valuationAt,
      'live_portfolio_valuation',
      prisma as never,
      sourceReads,
    );
  return { prisma, service, reads, calculate };
}

describe('refresh-scoped portfolio source reads', () => {
  it('preserves valuation and source priority while sharing in-flight price and FX reads', async () => {
    const { prisma, reads, calculate } = setup();
    const expected = [await calculate('a'), await calculate('b')];
    expect(prisma.assetPriceSnapshot.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.fxRateSnapshot.findMany).toHaveBeenCalledTimes(2);
    prisma.assetPriceSnapshot.findMany.mockClear();
    prisma.fxRateSnapshot.findMany.mockClear();
    prisma.tradingAccount.findUnique.mockClear();

    const context = reads();
    expect(
      await Promise.all([calculate('a', context), calculate('b', context)]),
    ).toEqual(expected);
    expect(prisma.assetPriceSnapshot.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.fxRateSnapshot.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.tradingAccount.findUnique).toHaveBeenCalledTimes(2);
    expect(expected[0]).toMatchObject({
      totalAssetKrw: '1230780.00000000',
      assetPriceSourceDecisions: [
        { sourceDecision: { selectedSourceName: 'binance_spot_ws_ticker' } },
      ],
      fxRateSourceDecision: { selectedSourceName: 'korea_exim_exchange_rate' },
    });
  });

  it('reads holdings again and gives each new refresh fresh source observations', async () => {
    const { prisma, reads, calculate } = setup();
    const context = reads();
    const first = await calculate('a', context);
    prisma.assetPriceSnapshot.findMany.mockResolvedValue([
      price('binance_spot_ws_ticker', '120'),
    ]);
    prisma.fxRateSnapshot.findMany.mockResolvedValue([
      fx('exchange_rate_api', '1500'),
      fx('korea_exim_exchange_rate', '1600'),
    ]);
    const changedAccount = account('a');
    changedAccount.cashWallets[0].balanceAmount = new Prisma.Decimal('800000');
    prisma.tradingAccount.findUnique.mockResolvedValue(changedAccount);

    const sameCalculation = await calculate('a', context);
    expect(
      new Prisma.Decimal(sameCalculation.totalAssetKrw).add(100000).toFixed(8),
    ).toBe(first.totalAssetKrw);
    const nextCalculation = await calculate('a', reads());
    expect(nextCalculation.totalAssetKrw).toBe('1187200.00000000');
    expect(prisma.tradingAccount.findUnique).toHaveBeenCalledTimes(3);
    expect(prisma.assetPriceSnapshot.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.fxRateSnapshot.findMany).toHaveBeenCalledTimes(2);
  });

  it.each(['time', 'workflow', 'client'] as const)(
    'does not reuse selections for another %s',
    async (scope) => {
      const { prisma, service, reads, calculate } = setup();
      const context = reads();
      await calculate('a', context);
      const other = setup();
      await service.calculateTradingAccountValuation(
        'b',
        scope === 'time' ? new Date(valuationAt.getTime() + 1000) : valuationAt,
        scope === 'workflow'
          ? 'home_live_valuation'
          : 'live_portfolio_valuation',
        (scope === 'client' ? other.prisma : prisma) as never,
        context,
      );
      expect(prisma.assetPriceSnapshot.findMany).toHaveBeenCalledTimes(
        scope === 'client' ? 1 : 2,
      );
      expect(prisma.fxRateSnapshot.findMany).toHaveBeenCalledTimes(
        scope === 'client' ? 1 : 2,
      );
      if (scope === 'client') {
        expect(other.prisma.assetPriceSnapshot.findMany).toHaveBeenCalledTimes(
          1,
        );
        expect(other.prisma.fxRateSnapshot.findMany).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('does not reuse a price for changed asset metadata', async () => {
    const { prisma, reads, calculate } = setup();
    const context = reads();
    await calculate('a', context);
    const usAccount = account('b');
    Object.assign(usAccount.positions[0].asset, {
      assetType: AssetType.us_stock,
      market: 'NAS',
    });
    prisma.tradingAccount.findUnique.mockResolvedValue(usAccount);
    prisma.assetPriceSnapshot.findMany.mockResolvedValue([
      price(
        'kis_us_delayed_trade',
        '130',
        new Date('2026-06-02T19:59:30.000Z'),
      ),
    ]);
    const actual = await calculate('b', context);
    expect(prisma.assetPriceSnapshot.findMany).toHaveBeenCalledTimes(2);
    expect(
      actual.assetPriceSourceDecisions[0].sourceDecision.selectedSourceName,
    ).toBe('kis_us_delayed_trade');
    expect(actual.usStockValueKrw).toBe('387400.00000000');
  });

  it('preserves the closed-market session price and manual fallback decisions', async () => {
    const { prisma, reads, calculate } = setup();
    const usAccount = account('a');
    Object.assign(usAccount.positions[0].asset, {
      assetType: AssetType.us_stock,
      market: 'NAS',
    });
    prisma.tradingAccount.findUnique.mockResolvedValue(usAccount);
    const rejected = price(
      'kis_us_delayed_trade',
      '120',
      new Date('2026-06-01T19:59:30.000Z'),
    );
    prisma.assetPriceSnapshot.findMany.mockResolvedValue([rejected]);
    prisma.assetPriceSnapshot.findFirst.mockResolvedValue({
      ...price('operator-price', '110', new Date('2026-06-02T19:59:30.000Z')),
      sourceType: AssetPriceSourceType.admin_manual,
    });
    prisma.fxRateSnapshot.findMany.mockResolvedValue([]);
    prisma.fxRateSnapshot.findFirst.mockResolvedValue({
      ...fx('operator-fx'),
      sourceType: FxRateSourceType.admin_manual,
      approvedByUserId: 'operator-1',
    });
    const expected = await calculate('a');
    const context = reads();
    expect(await calculate('a', context)).toEqual(expected);
    expect(await calculate('a', context)).toEqual(expected);
    expect(prisma.assetPriceSnapshot.findFirst).toHaveBeenCalledTimes(2);
    expect(prisma.fxRateSnapshot.findFirst).toHaveBeenCalledTimes(2);
    expect(expected.sourceSummary).toMatchObject({
      adminManualUsed: true,
      fallbackUsed: true,
    });
    expect(
      prisma.assetPriceSnapshot.findFirst.mock.calls.at(-1)?.[0],
    ).toMatchObject({
      where: {
        effectiveAt: {
          gte: new Date('2026-06-02T13:30:00.000Z'),
          lte: new Date('2026-06-02T20:00:00.000Z'),
        },
      },
    });
  });

  it.each(['price', 'fx'] as const)(
    'preserves missing %s failure evidence instead of substituting a source',
    async (missing) => {
      const { prisma, reads, calculate } = setup();
      if (missing === 'price')
        prisma.assetPriceSnapshot.findMany.mockResolvedValue([]);
      else prisma.fxRateSnapshot.findMany.mockResolvedValue([]);
      const failure = async (context?: PortfolioValuationSourceReads) => {
        try {
          await calculate('a', context);
          throw new Error('Expected valuation to fail');
        } catch (error) {
          expect(error).toBeInstanceOf(PortfolioValuationError);
          const valuationError = error as PortfolioValuationError;
          return {
            code: valuationError.code,
            message: valuationError.message,
            diagnosticContext: valuationError.diagnosticContext,
          };
        }
      };
      const expected = await failure();
      const context = reads();
      expect(await failure(context)).toEqual(expected);
      expect(await failure(context)).toEqual(expected);
      expect(expected.code).toBe(
        missing === 'price' ? 'ASSET_PRICE_UNAVAILABLE' : 'FX_RATE_UNAVAILABLE',
      );
      expect(
        missing === 'price'
          ? prisma.assetPriceSnapshot.findFirst
          : prisma.fxRateSnapshot.findFirst,
      ).toHaveBeenCalledTimes(2);
    },
  );

  it('continues to validate canonical account scope on every valuation', async () => {
    const { prisma, reads, calculate } = setup();
    const context = reads();
    await calculate('a', context);
    const corrupted = account('a');
    corrupted.seasonParticipant.userId = 'another-user';
    prisma.tradingAccount.findUnique.mockResolvedValue(corrupted);
    await expect(calculate('a', context)).rejects.toMatchObject({
      code: 'TRADING_ACCOUNT_SCOPE_MISMATCH',
    });
    expect(prisma.tradingAccount.findUnique).toHaveBeenCalledTimes(2);
  });
});
