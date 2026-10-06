jest.mock('../generated/prisma/client', () => {
  const enums = jest.requireActual<typeof import('../generated/prisma/enums')>(
    '../generated/prisma/enums',
  );
  const { Decimal } = jest.requireActual<{ Decimal: typeof Prisma.Decimal }>(
    '@prisma/client/runtime/client',
  );
  return { ...enums, Prisma: { Decimal }, PrismaClient: class PrismaClient {} };
});

import {
  AssetPriceSourceType,
  AssetType,
  CurrencyCode,
  FxRateSourceType,
  Prisma,
  TradingAccountMode,
} from '../generated/prisma/client';
import { OrdersService } from '../orders/orders.service';
import { PositionsService } from '../positions/positions.service';
import { HomeService } from '../home/home.service';
import { RecordsService } from '../records/records.service';
import { PortfolioValuationService } from './portfolio-valuation.service';
import { calculatePortfolioValuation } from './portfolio-valuation.policy';

function containing(value: Record<string, unknown>): Record<string, unknown> {
  return expect.objectContaining(value) as Record<string, unknown>;
}
function arrayContaining(value: unknown[]): unknown {
  return expect.arrayContaining(value) as unknown;
}

const valuationAt = new Date('2026-07-20T14:00:00Z');
const decimal = (value: string) => new Prisma.Decimal(value);

function holding(
  id: string,
  currencyCode = CurrencyCode.USD,
  assetType = AssetType.crypto,
  quantity = '2',
  localPrice = '100',
  priceKrw: string | null = '130000',
) {
  const position = {
    id: `position-${id}`,
    assetId: id,
    quantity: decimal(quantity),
    averageCost: decimal('80'),
    currencyCode,
    realizedPnl: decimal('0'),
    realizedPnlKrw: decimal('0'),
    currentPriceLocal: decimal('999'),
    currentPriceKrw: decimal('999'),
    marketValueLocal: decimal('999'),
    marketValueKrw: decimal('999'),
    unrealizedPnlLocal: decimal('999'),
    unrealizedPnlKrw: decimal('999'),
    asset: {
      id,
      symbol: id,
      name: id,
      assetType,
      market:
        assetType === AssetType.domestic_stock
          ? 'KRX'
          : assetType === AssetType.us_stock
            ? 'NAS'
            : 'BINANCE',
      currencyCode,
      priceCurrency: currencyCode,
      settlementCurrency: currencyCode,
    },
  };
  const price = {
    id: `price-${id}`,
    assetId: id,
    price: decimal(localPrice),
    priceKrw: priceKrw === null ? null : decimal(priceKrw),
    currencyCode,
    sourceType: AssetPriceSourceType.admin_manual,
    sourceName: 'operator',
    effectiveAt:
      assetType === AssetType.domestic_stock
        ? new Date('2026-07-20T06:30:00Z')
        : valuationAt,
    capturedAt: valuationAt,
    createdAt: valuationAt,
  };
  return { position, price };
}

function fixture(
  holdings = [holding('usd')],
  usdCash = '10',
  mode: TradingAccountMode = TradingAccountMode.season,
) {
  const initialCapitalKrw = decimal('1000000');
  const account = {
    id: 'account',
    userId: 'user',
    mode,
    initialCapitalKrw,
    seasonParticipant:
      mode === TradingAccountMode.season
        ? { id: 'participant', userId: 'user', initialCapitalKrw }
        : null,
    cashWallets: [
      {
        walletScope: 'securities' as const,
        currencyCode: CurrencyCode.KRW,
        balanceAmount: decimal('1000'),
      },
      {
        walletScope: 'securities' as const,
        currencyCode: CurrencyCode.USD,
        balanceAmount: decimal(usdCash),
      },
      { walletScope: 'crypto_spot' as const, currencyCode: CurrencyCode.USD, balanceAmount: decimal('0') },
      { walletScope: 'crypto_futures' as const, currencyCode: CurrencyCode.USD, balanceAmount: decimal('0') },
    ],
    positions: holdings.map((h) => h.position),
  };
  const fx = {
    id: 'valuation-fx',
    baseCurrency: CurrencyCode.USD,
    quoteCurrency: CurrencyCode.KRW,
    rate: decimal('1400'),
    sourceType: FxRateSourceType.admin_manual,
    sourceName: 'operator',
    approvedByUserId: 'operator',
    effectiveAt: valuationAt,
    capturedAt: valuationAt,
    createdAt: valuationAt,
  };
  const db = {
    tradingAccount: { findUnique: jest.fn().mockResolvedValue(account) },
    assetPriceSnapshot: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(({ where }: { where: { assetId: string } }) =>
        Promise.resolve(
          holdings.find((h) => h.price.assetId === where.assetId)?.price ??
            null,
        ),
      ),
    },
    fxRateSnapshot: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(fx),
    },
    position: {
      findMany: jest.fn().mockResolvedValue(account.positions),
      update: jest.fn().mockResolvedValue({ id: 'cache' }),
    },
    equitySnapshot: {
      create: jest.fn().mockResolvedValue({ id: 'equity' }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    seasonParticipant: {
      update: jest.fn().mockResolvedValue({ id: 'participant' }),
    },
  };
  const pv = new PortfolioValuationService(db as never);
  const orders = new OrdersService(db as never);
  const positions = new PositionsService(db as never) as unknown as {
    buildPositionItem: PositionsService['buildPositionItem'];
    buildSummary: PositionsService['buildSummary'];
  };
  const home = new HomeService(db as never, pv) as unknown as {
    buildTopPositions: HomeService['buildTopPositions'];
    createLiveValuationLoader: HomeService['createLiveValuationLoader'];
  };
  const records = new RecordsService(db as never, pv) as unknown as {
    buildProfitAnalysis: RecordsService['buildProfitAnalysis'];
  };
  return {
    account,
    db,
    fx,
    holdings,
    positions,
    home,
    records,
    live: () =>
      pv.calculateTradingAccountValuation(
        'account',
        valuationAt,
        'live_portfolio_valuation',
      ),
    postFill: () =>
      orders.recordOrderExecutedPortfolioSnapshotInTransaction(
        db as never,
        'participant',
        valuationAt,
        'account',
      ),
  };
}

describe('same-evidence financial valuation parity', () => {
  it('includes all scope cash in both live and post-fill snapshot valuation', async () => {
    const f = fixture();
    f.account.cashWallets[1].balanceAmount = decimal('1000');
    f.account.cashWallets[2].balanceAmount = decimal('500');
    f.account.cashWallets[3].balanceAmount = decimal('200');
    const live = await f.live();
    expect(live).toMatchObject({
      totalAssetKrw: '2661000.00000000',
      usdCashKrw: '2380000.00000000',
      assetValueKrw: '280000.00000000',
      unrealizedPnlKrw: '56000.00000000',
    });
    await f.postFill();
    expect(f.db.equitySnapshot.create.mock.calls[0]).toEqual([
      containing({ data: containing({
        totalAssetKrw: live.totalAssetKrw,
        usdCashKrw: live.usdCashKrw,
        cryptoValueKrw: live.cryptoValueKrw,
        returnRate: live.returnRate,
      }) }),
    ]);
    // Each independent workflow resolves one FX, shared by its cash and positions.
    expect(f.db.fxRateSnapshot.findFirst).toHaveBeenCalledTimes(2);
  });

  it.each(['130000', null, '999999'])(
    'ignores stored priceKrw=%s across Portfolio/Orders/Positions/Home/Records',
    async (priceKrw) => {
      const f = fixture([
        holding(
          'usd',
          CurrencyCode.USD,
          AssetType.us_stock,
          '2',
          '100',
          priceKrw,
        ),
      ]);
      const live = await f.live();
      await f.postFill();
      expect(live).toMatchObject({
        totalAssetKrw: '295000.00000000',
        usdCashKrw: '14000.00000000',
        assetValueKrw: '280000.00000000',
        unrealizedPnlKrw: '56000.00000000',
      });
      expect(f.db.equitySnapshot.create.mock.calls[0]).toEqual([
        containing({
          data: containing({
            totalAssetKrw: live.totalAssetKrw,
            returnRate: live.returnRate,
            usdCashKrw: live.usdCashKrw,
            usStockValueKrw: live.usStockValueKrw,
          }),
        }),
      ]);
      expect(f.db.position.update.mock.calls[0]).toEqual([
        containing({
          data: containing({
            currentPriceKrw: '140000.00000000',
            marketValueKrw: '280000.00000000',
            unrealizedPnlKrw: live.unrealizedPnlKrw,
          }),
        }),
      ]);
      const selection = {
        state: 'available' as const,
        rate: f.fx.rate,
        sourceDecision: live.fxRateSourceDecision!,
      };
      const item = await f.positions.buildPositionItem(
        f.account.positions[0],
        valuationAt,
        selection,
      );
      expect(item.valuation.payload).toMatchObject({
        state: 'available',
        positionValueKrw: '280000.00000000',
        unrealizedPnlKrw: '56000.00000000',
      });
      const top = await f.home.buildTopPositions('account', [], valuationAt);
      expect(top).toMatchObject({
        state: 'available',
        items: [
          containing({
            positionValueKrw: '280000.00000000',
            unrealizedPnlKrw: '56000.00000000',
            fxRateSource: containing({
              snapshotId: 'valuation-fx',
            }),
          }),
        ],
      });
      expect(
        await f.home.createLiveValuationLoader('account', valuationAt)(),
      ).toMatchObject({ totalAssetKrw: live.totalAssetKrw });
      expect(
        await f.records.buildProfitAnalysis('account', valuationAt),
      ).toMatchObject({ totalUnrealizedPnlKrw: live.unrealizedPnlKrw });
    },
  );

  it('sums raw fractional values, independent of rounded position caches', async () => {
    const f = fixture(
      [
        holding(
          'fraction-a',
          CurrencyCode.USD,
          AssetType.crypto,
          '0.00000004',
          '0.33333333',
          null,
        ),
        holding(
          'fraction-b',
          CurrencyCode.USD,
          AssetType.crypto,
          '0.00000004',
          '0.33333333',
          null,
        ),
      ],
      '0.00000001',
    );
    f.fx.rate = decimal('0.98765432');
    const live = await f.live();
    await f.postFill();
    expect(live.assetValueKrw).toBe('0.00000003');
    expect(live.totalAssetKrw).toBe('1000.00000004');
    expect(f.db.equitySnapshot.create.mock.calls[0]).toEqual([
      containing({
        data: containing({
          totalAssetKrw: live.totalAssetKrw,
          returnRate: live.returnRate,
        }),
      }),
    ]);
    const cacheData = f.db.position.update.mock.calls as unknown as Array<
      [{ data: { marketValueKrw: string; unrealizedPnlKrw: string } }]
    >;
    const cacheSum = cacheData.reduce(
      (sum, [call]) => sum.add(call.data.marketValueKrw),
      decimal('0'),
    );
    expect(cacheSum.toFixed(8)).toBe('0.00000002');
    expect(cacheSum.toFixed(8)).not.toBe(live.assetValueKrw);
    const selection = {
      state: 'available' as const,
      rate: f.fx.rate,
      sourceDecision: live.fxRateSourceDecision!,
    };
    const items = await Promise.all(
      f.account.positions.map((p) =>
        f.positions.buildPositionItem(p, valuationAt, selection),
      ),
    );
    expect(f.positions.buildSummary(items).totalPositionValueKrw).toBe(
      live.assetValueKrw,
    );
    const pnl = await f.records.buildProfitAnalysis('account', valuationAt);
    expect(pnl.totalUnrealizedPnlKrw).toBe(live.unrealizedPnlKrw);
    expect(
      await f.home.buildTopPositions('account', [], valuationAt),
    ).toMatchObject({
      state: 'available',
      items: arrayContaining([containing({ positionValueKrw: '0.00000001' })]),
    });
  });

  it.each([TradingAccountMode.season, TradingAccountMode.general])(
    'values a mixed %s account with one FX and unchanged KRW arithmetic',
    async (mode) => {
      const f = fixture(
        [
          holding(
            'krx',
            CurrencyCode.KRW,
            AssetType.domestic_stock,
            '2',
            '100',
            null,
          ),
          holding('us', CurrencyCode.USD, AssetType.us_stock),
          holding('crypto'),
        ],
        '10',
        mode,
      );
      const live = await f.live();
      expect(live).toMatchObject({
        totalAssetKrw: '575200.00000000',
        domesticStockValueKrw: '200.00000000',
        usStockValueKrw: '280000.00000000',
        cryptoValueKrw: '280000.00000000',
      });
      expect(f.db.fxRateSnapshot.findFirst).toHaveBeenCalledTimes(1);
      if (mode === TradingAccountMode.season) {
        await f.postFill();
        expect(f.db.equitySnapshot.create.mock.calls[0]).toEqual([
          containing({
            data: containing({
              totalAssetKrw: live.totalAssetKrw,
            }),
          }),
        ]);
      }
    },
  );

  it.each([
    { holdings: [] },
    {
      holdings: [
        holding(
          'krx',
          CurrencyCode.KRW,
          AssetType.domestic_stock,
          '2',
          '100',
          null,
        ),
      ],
    },
  ])('does not need FX for KRW-only holdings', async ({ holdings }) => {
    const f = fixture(holdings, '0');
    await f.live();
    await f.postFill();
    expect(f.db.fxRateSnapshot.findFirst).not.toHaveBeenCalled();
  });

  it('requires the selected FX even with zero USD cash and stored KRW asset price', async () => {
    const f = fixture([holding('usd')], '0');
    f.db.fxRateSnapshot.findFirst.mockResolvedValue(null);
    await expect(f.live()).rejects.toMatchObject({
      code: 'FX_RATE_UNAVAILABLE',
    });
    await expect(f.postFill()).rejects.toHaveProperty('status', 503);
    expect(f.db.equitySnapshot.create).not.toHaveBeenCalled();
  });

  it.each([
    'missing-wallet',
    'duplicate-wallet',
    'negative-cash',
    'negative-quantity',
    'position-currency',
    'price-settlement',
    'initial-capital',
    'capital-link',
    'owner',
  ] as const)(
    'fails closed in both portfolio and Orders for %s',
    async (damage) => {
      const f = fixture();
      switch (damage) {
        case 'missing-wallet':
          f.account.cashWallets.pop();
          break;
        case 'duplicate-wallet':
          f.account.cashWallets.push(f.account.cashWallets[0]);
          break;
        case 'negative-cash':
          f.account.cashWallets[0].balanceAmount = decimal('-1');
          break;
        case 'negative-quantity':
          f.account.positions[0].quantity = decimal('-1');
          break;
        case 'position-currency':
          f.account.positions[0].currencyCode = CurrencyCode.KRW;
          break;
        case 'price-settlement':
          f.account.positions[0].asset.settlementCurrency = CurrencyCode.KRW;
          break;
        case 'initial-capital':
          f.account.initialCapitalKrw = decimal('0');
          f.account.seasonParticipant!.initialCapitalKrw = decimal('0');
          break;
        case 'capital-link':
          f.account.seasonParticipant!.initialCapitalKrw = decimal('999');
          break;
        case 'owner':
          f.account.seasonParticipant!.userId = 'foreign';
          break;
      }
      await expect(f.live()).rejects.toBeDefined();
      await expect(f.postFill()).rejects.toBeDefined();
      expect(f.db.equitySnapshot.create).not.toHaveBeenCalled();
      expect(f.db.position.update).not.toHaveBeenCalled();
    },
  );

  it('uses cutoff FX for settlement USD assets and cash with stored KRW mismatch', () => {
    const f = fixture();
    const cutoff = new Date('2026-07-18T00:00:00Z');
    const result = calculatePortfolioValuation({
      seasonParticipantId: 'participant',
      initialCapitalKrw: f.account.initialCapitalKrw,
      cashWallets: f.account.cashWallets,
      positions: f.holdings.map(({ position, price }) => ({
        ...position,
        assetType: position.asset.assetType,
        latestPriceSnapshot: { ...price, effectiveAt: cutoff },
      })),
      usdKrwSnapshot: { ...f.fx, effectiveAt: cutoff },
      valuationAt: new Date('2026-07-19T00:00:00Z'),
      sourceEligibilityWorkflow: 'season_settlement',
      enforceAdminManualFxFreshness: false,
    });
    expect(result.totalAssetKrw).toBe('295000.00000000');
    expect(result.usdCashKrw).toBe('14000.00000000');
    expect(result.assetValueKrw).toBe('280000.00000000');
  });
});
