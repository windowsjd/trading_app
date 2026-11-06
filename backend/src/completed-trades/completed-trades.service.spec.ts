jest.mock('../generated/prisma/client', () => {
  const runtime = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');
  return {
    Prisma: {
      Decimal: runtime.Decimal,
      sql: runtime.sqltag,
      empty: runtime.empty,
    },
  };
});
// DI tokens only: the service is constructed by hand below.
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../trading-accounts/trading-account-access.service', () => ({
  TradingAccountAccessService: class {},
}));
jest.mock('../providers/binance/binance-symbol-metadata.service', () => ({
  BinanceSymbolMetadataService: class {},
}));
import { Prisma } from '../generated/prisma/client';
import { CompletedTradesService } from './completed-trades.service';

const D = (value: string) => new Prisma.Decimal(value);

/** One closed Spot holding (buy 1 @ 100, sell 1 @ 110, 0.1% fees). */
function make(resetAt: Date | null) {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const findFirst = jest.fn().mockResolvedValue(resetAt ? { resetAt } : null);
  const tx = {
    generalAccountReset: { findFirst },
    position: {
      findMany: jest.fn().mockResolvedValue([
        {
          assetId: 'asset-1',
          currencyCode: 'USD',
          quantity: D('0'),
          realizedPnl: D('9.79'),
          asset: {
            symbol: 'BTCUSDT',
            name: 'Bitcoin',
            market: 'BINANCE',
            assetType: 'crypto',
          },
        },
      ]),
    },
    futuresPosition: { findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = Prisma.sql(strings, ...values);
        queries.push({ text: query.sql, values: query.values });
        return Promise.resolve(
          ['buy', 'sell'].map((side) => ({
            assetId: 'asset-1',
            side,
            currencyCode: 'USD',
            netAmount: D(side === 'buy' ? '100.1' : '109.89'),
            grossAmount: D(side === 'buy' ? '100' : '110'),
            quantity: D('1'),
            count: 1,
            missingAmount: 0,
            missingGross: 0,
            lastExecutedAt: new Date('2026-11-05T12:00:00.000Z'),
          })),
        );
      },
    ),
  };
  const transaction = jest.fn(
    (run: (client: typeof tx) => Promise<unknown>, options: unknown) => {
      void options;
      return run(tx);
    },
  );
  const access = {
    getOwnedAccountOrThrow: jest
      .fn()
      .mockResolvedValue({ id: 'account-1', mode: 'general' }),
  };
  const symbols = { getDisplayPriceDecimals: jest.fn().mockReturnValue(2) };
  const service = new CompletedTradesService(
    { $transaction: transaction } as never,
    access as never,
    symbols as never,
  );
  return { service, access, transaction, findFirst, queries, symbols };
}

describe('CompletedTradesService (수익 공유)', () => {
  it('requires a signed-in owner', async () => {
    const { service, access } = make(null);
    await expect(service.list(undefined, 'account-1')).rejects.toMatchObject({
      status: 401,
    });
    expect(access.getOwnedAccountOrThrow).not.toHaveBeenCalled();
  });

  it('reads the named, owned account in one repeatable-read snapshot', async () => {
    const { service, access, transaction, symbols } = make(null);
    const result = await service.list('user-1', 'account-1');
    expect(access.getOwnedAccountOrThrow).toHaveBeenCalledWith(
      'user-1',
      'account-1',
    );
    expect(transaction.mock.calls[0][1]).toEqual({
      isolationLevel: 'RepeatableRead',
    });
    expect(symbols.getDisplayPriceDecimals).toHaveBeenCalledWith({
      symbol: 'BTCUSDT',
      name: 'Bitcoin',
      market: 'BINANCE',
      assetType: 'crypto',
    });
    expect(result).toEqual({
      success: true,
      data: {
        tradingAccountId: 'account-1',
        hasMore: false,
        items: [
          expect.objectContaining({
            key: 'spot:asset-1',
            realizedPnl: '9.79000000',
            returnRate: '9.78021978',
            averageBuyPrice: '100.00000000',
            averageSellPrice: '110.00000000',
            displayPriceDecimals: 2,
          }),
        ],
      },
    });
  });

  it('a foreign or missing account is the access policy’s 404, before any read', async () => {
    const { service, access, transaction } = make(null);
    access.getOwnedAccountOrThrow.mockRejectedValueOnce(
      Object.assign(new Error('Trading account not found'), { status: 404 }),
    );
    await expect(service.list('user-1', 'someone-else')).rejects.toMatchObject({
      status: 404,
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('passes the latest general reset as the Spot epoch', async () => {
    const resetAt = new Date('2026-11-02T00:00:00.000Z');
    const { service, findFirst, queries } = make(resetAt);
    await service.list('user-1', 'account-1');
    expect(findFirst).toHaveBeenCalledWith({
      where: { tradingAccountId: 'account-1' },
      orderBy: { sequence: 'desc' },
      select: { resetAt: true },
    });
    const spot = queries.find((query) => query.text.includes('FROM orders'));
    expect(spot?.text).toContain('AND o.executed_at > ');
    expect(spot?.values).toContain(resetAt);
  });
});
