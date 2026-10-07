jest.mock('./futures-performance.service', () => ({
  FuturesPerformanceService: class {},
}));
jest.mock('../portfolio/general-account-performance.service', () => ({
  GeneralAccountPerformanceService: class {},
}));
jest.mock('../trading-accounts/trading-account-access.service', () => ({
  TradingAccountAccessService: class {},
}));
jest.mock('../generated/prisma/client', () => ({
  AssetType: { crypto: 'crypto' },
  CurrencyCode: { USD: 'USD', KRW: 'KRW' },
  Prisma: {
    Decimal: jest.requireActual('@prisma/client/runtime/client').Decimal,
  },
}));
jest.mock('../prisma/prisma.service', () => ({ PrismaService: class {} }));
jest.mock('../ranking/season-write-lock', () => ({
  lockSeasonForWriteOrThrow: jest.fn(),
}));
jest.mock('../seasons/season-trading-lock', () => ({
  lockSeasonTradingContext: jest.fn(),
}));
jest.mock('../trading-accounts/trading-account-financial-integrity', () => ({
  assertAccountFinancialScopeIntegrity: jest.fn(),
}));
import type { ArgumentsHost } from '@nestjs/common';
import {
  adminDiagnosticRequestMiddleware,
  type AdminDiagnostic,
} from '../common/admin-diagnostics';
import { GlobalHttpExceptionFilter } from '../common/global-http-exception.filter';
import {
  assertDiagnosticBaseline,
  assertDiagnosticTriage,
} from '../../scripts/lib/diagnostic-quality';
import {
  FuturesSeasonSettlementService,
  planSeasonFuturesExit,
} from './futures-season-settlement.service';
import { readFuturesFinalPrice } from './futures-price';
import { lockSeasonTradingContext } from '../seasons/season-trading-lock';
import { futuresDecimal as d } from './futures-math';
import { FuturesController } from './futures.controller';
import { FuturesService } from './futures.service';
const endAt = new Date('2026-10-08T00:00:00Z');
async function diagnostic(
  action: () => unknown,
  route = '/api/v1/trading-accounts/account/futures/final-settlement',
) {
  const request = {
    method: 'GET',
    originalUrl: route,
    headers: { 'x-request-id': 'f3-diagnostic' },
    user: { userId: 'user', role: 'admin' },
  };
  let body!: { error: { diagnostic?: AdminDiagnostic } };
  const response = {
    setHeader() {},
    status() {
      return this;
    },
    json(value: typeof body) {
      body = value;
    },
  };
  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as ArgumentsHost;
  let pending!: Promise<void>;
  adminDiagnosticRequestMiddleware(request as never, response as never, () => {
    pending = Promise.resolve()
      .then(action)
      .then(
        () => {
          throw new Error('Expected failure');
        },
        (error) => new GlobalHttpExceptionFilter().catch(error, host),
      );
  });
  await pending;
  return body.error.diagnostic;
}
function fixture() {
  const asset = {
    id: 'asset',
    symbol: 'BTCUSDT',
    market: 'BINANCE',
    assetType: 'crypto',
    currencyCode: 'USD',
    priceCurrency: 'USD',
    settlementCurrency: 'USD',
  };
  const instrument = { id: 'instrument', underlyingAsset: asset };
  const position = {
    id: 'position',
    instrumentId: instrument.id,
    instrument,
    marginMode: 'isolated',
    isolatedMargin: d('1'),
    quantity: d('1'),
  };
  const wallets = [
    ['securities', 'KRW'],
    ['securities', 'USD'],
    ['crypto_spot', 'USD'],
    ['crypto_futures', 'USD'],
  ].map(([walletScope, currencyCode]) => ({
    id: walletScope + currencyCode,
    walletScope,
    currencyCode,
    balanceAmount: d('100'),
    reservedAmount: d('0'),
  }));
  const context = {
    season: { id: 'season', status: 'ended', endAt },
    account: { id: 'account', status: 'active' },
  };
  jest.mocked(lockSeasonTradingContext).mockResolvedValue(context as never);
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ now: new Date(+endAt + 1000) }]),
    $transaction: (f: (tx: unknown) => unknown) => f(tx),
    season: {
      findUniqueOrThrow: jest
        .fn()
        .mockResolvedValue({ ...context.season, tradeFeeRate: d('0.002') }),
    },
    seasonParticipant: {
      findUnique: jest
        .fn()
        .mockResolvedValue({
          id: 'participant',
          seasonId: 'season',
          tradingAccountId: 'account',
        }),
    },
    futuresPosition: {
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([position]),
    },
    futuresInstrument: { findMany: jest.fn().mockResolvedValue([instrument]) },
    futuresSeasonPrice: { findMany: jest.fn().mockResolvedValue([]) },
    futuresSeasonSettlement: { findUnique: jest.fn().mockResolvedValue(null) },
    cashWallet: { findMany: jest.fn().mockResolvedValue(wallets) },
    assetPriceSnapshot: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  return {
    tx,
    asset,
    position,
    wallets,
    context,
    service: new FuturesSeasonSettlementService(tx as never),
  };
}
describe('F3 final settlement diagnostics at existing delivery boundaries', () => {
  it('identifies missing end-boundary Spot evidence', async () => {
    const h = fixture();
    assertDiagnosticTriage(
      await diagnostic(() =>
        readFuturesFinalPrice(h.tx as never, h.asset as never, endAt),
      ),
      'FUTURES_FINAL_PRICE_UNAVAILABLE',
      'backend/src/futures/futures-price.ts#readFuturesFinalPrice',
    );
  });
  it('identifies the final open-lifetime barrier', async () => {
    const h = fixture();
    assertDiagnosticTriage(
      await diagnostic(() => h.service.assertNoOpen('season')),
      'FUTURES_FINAL_SETTLEMENT_REQUIRED',
      'backend/src/futures/futures-season-settlement.service.ts#assertNoOpen',
    );
  });
  it('identifies changed pinned settlement terms', async () => {
    const h = fixture();
    h.tx.futuresSeasonPrice.findMany.mockResolvedValue([
      { instrumentId: 'instrument', endAt: new Date(0) },
    ] as never);
    assertDiagnosticTriage(
      await diagnostic(() => h.service.settleSeason('season')),
      'FUTURES_FINAL_EVIDENCE_INTEGRITY',
      'backend/src/futures/futures-season-settlement.service.ts#preparePrices',
    );
  });
  it('identifies an account outside the Season', async () => {
    const h = fixture();
    h.tx.seasonParticipant.findUnique.mockResolvedValue(null as never);
    assertDiagnosticTriage(
      await diagnostic(() => h.service.settleAccount('season', 'account')),
      'TRADING_ACCOUNT_SCOPE_MISMATCH',
      'backend/src/futures/futures-season-settlement.service.ts#settleAccount',
    );
  });
  it('identifies invalid lifecycle after the locks', async () => {
    const h = fixture();
    h.context.season.status = 'active';
    assertDiagnosticTriage(
      await diagnostic(() => h.service.settleAccount('season', 'account')),
      'FUTURES_FINAL_SETTLEMENT_INTEGRITY',
      'backend/src/futures/futures-season-settlement.service.ts#settleAccount',
    );
  });
  it('identifies a damaged canonical wallet set', async () => {
    const h = fixture();
    h.tx.cashWallet.findMany.mockResolvedValue([]);
    assertDiagnosticTriage(
      await diagnostic(() => h.service.settleAccount('season', 'account')),
      'FINANCIAL_SCOPE_REPAIR_REQUIRED',
      'backend/src/futures/futures-season-settlement.service.ts#settleAccount',
    );
  });
  it('identifies missing pinned price under the account lock', async () => {
    const h = fixture();
    assertDiagnosticTriage(
      await diagnostic(() => h.service.settleAccount('season', 'account')),
      'FUTURES_FINAL_PRICE_UNAVAILABLE',
      'backend/src/futures/futures-season-settlement.service.ts#settleAccount',
    );
  });
  it('identifies underfunded scope budgets', async () => {
    const h = fixture();
    h.wallets[3].balanceAmount = d('0');
    assertDiagnosticTriage(
      await diagnostic(() =>
        planSeasonFuturesExit(
          h.wallets[3] as never,
          [h.position] as never,
          new Map(),
          endAt,
          d('0.002'),
        ),
      ),
      'FUTURES_COLLATERAL_INTEGRITY',
      'backend/src/futures/futures-season-settlement.service.ts#planSeasonFuturesExit',
    );
  });
  it('identifies ineligible pure settlement price input', async () => {
    const h = fixture();
    assertDiagnosticTriage(
      await diagnostic(() =>
        planSeasonFuturesExit(
          h.wallets[3] as never,
          [h.position] as never,
          new Map(),
          endAt,
          d('0.002'),
        ),
      ),
      'FUTURES_FINAL_PRICE_UNAVAILABLE',
      'backend/src/futures/futures-season-settlement.service.ts#planSeasonFuturesExit',
    );
  });
  it('assigns the new read route its observed Futures operation', async () => {
    const service = new FuturesService({} as never, {} as never, {} as never);
    const controller = new FuturesController(service);
    assertDiagnosticBaseline(
      await diagnostic(() => controller.finalSettlement({}, 'account')),
      'backend/src/futures/futures.controller.ts#finalSettlement',
    );
  });
});
