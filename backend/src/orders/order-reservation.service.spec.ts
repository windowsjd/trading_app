jest.mock('../generated/prisma/client', () => {
  const { Decimal, sqltag } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');

  return {
    AssetPriceSourceType: {
      official_batch: 'official_batch',
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
    },
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    CurrencyCode: {
      KRW: 'KRW',
      USD: 'USD',
    },
    FxRateSourceType: {
      official_batch: 'official_batch',
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
    },
    OrderSide: {
      buy: 'buy',
      sell: 'sell',
    },
    OrderStatus: {
      submitted: 'submitted',
      executed: 'executed',
      canceled: 'canceled',
      rejected: 'rejected',
    },
    OrderType: {
      market: 'market',
      limit: 'limit',
    },
    ParticipantStatus: {
      registered: 'registered',
      active: 'active',
      finished: 'finished',
      rewarded: 'rewarded',
      excluded: 'excluded',
    },
    Prisma: { Decimal, sql: sqltag },
    PrismaClient: class PrismaClient {},
    QuoteStatus: {
      active: 'active',
      consumed: 'consumed',
      expired: 'expired',
      canceled: 'canceled',
    },
    QuoteType: {
      fx: 'fx',
      order: 'order',
    },
    SeasonRankingType: {
      daily: 'daily',
      final: 'final',
    },
    SeasonStatus: {
      upcoming: 'upcoming',
      active: 'active',
      ended: 'ended',
      settled: 'settled',
    },
    TradingAccountMode: {
      general: 'general',
      season: 'season',
    },
    TradingAccountStatus: {
      active: 'active',
      suspended: 'suspended',
      closed: 'closed',
    },
    SnapshotReason: {
      season_join: 'season_join',
      exchange_executed: 'exchange_executed',
      order_executed: 'order_executed',
      scheduled: 'scheduled',
      settlement: 'settlement',
    },
    WalletTransactionDirection: {
      credit: 'credit',
      debit: 'debit',
    },
    WalletTransactionReferenceType: {
      season_join: 'season_join',
      exchange_transaction: 'exchange_transaction',
      order: 'order',
      manual_adjustment: 'manual_adjustment',
      settlement: 'settlement',
    },
    WalletTransactionType: {
      initial_grant: 'initial_grant',
      exchange_source: 'exchange_source',
      exchange_target: 'exchange_target',
      order_buy: 'order_buy',
      order_sell: 'order_sell',
      fee: 'fee',
      adjustment: 'adjustment',
      settlement: 'settlement',
    },
  };
});

import {
  CurrencyCode,
  OrderSide,
  OrderStatus,
  OrderType,
  Prisma,
  TradingAccountMode,
} from '../generated/prisma/client';
import { OrderReservationService } from './order-reservation.service';
import { LimitOrderCreateService } from './limit-order-create.service';
import { LimitOrderCancelService } from './limit-order-cancel.service';
import {
  captureFinancialFailure,
  expectSafeFinancialDiagnostic,
} from '../../test/support/financial-diagnostics';

const d = (value: string) => new Prisma.Decimal(value);
const wallet = (overrides: Record<string, unknown> = {}) => ({
  walletScope: 'securities' as const,
  id: 'wallet-1',
  tradingAccountId: 'account-1',
  currencyCode: CurrencyCode.KRW,
  balanceAmount: d('1000'),
  reservedAmount: d('400'),
  ...overrides,
});
const position = (overrides: Record<string, unknown> = {}) => ({
  id: 'position-1',
  tradingAccountId: 'account-1',
  assetId: 'asset-1',
  currencyCode: CurrencyCode.KRW,
  quantity: d('10'),
  reservedQuantity: d('4'),
  ...overrides,
});
const tx = () => ({
  cashWallet: { findUnique: jest.fn() },
  position: { findUnique: jest.fn() },
  order: {
    create: jest.fn(),
    findUnique: jest.fn(),
    updateMany: jest.fn(),
    update: jest.fn(),
  },
  quote: { updateMany: jest.fn() },
  $executeRaw: jest.fn(),
  $queryRaw: jest.fn(),
  $transaction: jest.fn(),
});
const cashInput = {
  tradingAccountId: 'account-1',
  currencyCode: CurrencyCode.KRW,
  amount: '700.00000000',
};
const cashReleaseInput = {
  ...cashInput,
  walletId: 'wallet-1',
  amount: '400.00000000',
};
const quote = {
  id: 'quote-1',
  limitPrice: d('100'),
  quotedFeeRate: d('0.001'),
  quotedGrossAmount: d('200'),
  quotedFeeAmount: d('0.2'),
  quotedReservedAmount: d('200.2'),
  quotedNetAmount: d('199.8'),
  asset: {
    id: 'asset-1',
    currencyCode: CurrencyCode.KRW,
    settlementCurrency: CurrencyCode.KRW,
  },
};
const createInput = {
  quote,
  tradingAccountId: 'account-1',
  quantity: d('2'),
  idempotency: { idempotencyKey: 'command-1', requestHash: 'hash' },
  submittedAt: new Date('2026-05-07T00:30:00Z'),
};
const order = (
  side = OrderSide.buy,
  overrides: Record<string, unknown> = {},
) => ({
  id: 'order-1',
  tradingAccountId: 'account-1',
  tradingAccount: {
    id: 'account-1',
    mode: TradingAccountMode.general,
    seasonParticipant: null,
  },
  assetId: 'asset-1',
  side,
  status: OrderStatus.submitted,
  orderType: OrderType.limit,
  currencyCode: CurrencyCode.KRW,
  reservedAmount: side === OrderSide.buy ? d('400') : null,
  reservedQuantity: side === OrderSide.sell ? d('4') : null,
  ...overrides,
});
const cancelInput = {
  userId: 'user-1',
  orderId: 'order-1',
  canceledAt: new Date('2026-05-07T00:31:00Z'),
};
function cancelFixture(
  side = OrderSide.buy,
  overrides: Record<string, unknown> = {},
) {
  const db = tx();
  db.$transaction.mockImplementation((callback) => callback(db));
  db.$queryRaw.mockResolvedValue([{ id: 'order-1' }]);
  db.order.findUnique.mockResolvedValueOnce(order(side, overrides));
  return {
    db,
    service: new LimitOrderCancelService(
      db as never,
      new OrderReservationService(),
    ),
  };
}

describe('OrderReservationService cash failure evidence', () => {
  it.each([
    ['disappeared', null, 'wallet_not_found', 'INSUFFICIENT_AVAILABLE_BALANCE'],
    [
      'available shortfall',
      wallet(),
      'insufficient_available',
      'INSUFFICIENT_AVAILABLE_BALANCE',
    ],
    [
      'concurrency',
      wallet({ reservedAmount: d('0') }),
      'conflict',
      'ORDER_RESERVATION_CONFLICT',
    ],
    [
      'null scope',
      wallet({ tradingAccountId: null }),
      'null_scope',
      'FINANCIAL_SCOPE_REPAIR_REQUIRED',
    ],
    [
      'foreign scope',
      wallet({ tradingAccountId: 'foreign-account' }),
      'account_scope_mismatch',
      'FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH',
    ],
    [
      'currency',
      wallet({ currencyCode: CurrencyCode.USD }),
      'currency_mismatch',
      'FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH',
    ],
  ])(
    'reserve preserves %s with one failure read and no retry',
    async (_label, row, reason, code) => {
      const db = tx();
      db.cashWallet.findUnique
        .mockResolvedValueOnce(wallet())
        .mockResolvedValueOnce(row);
      db.$executeRaw.mockResolvedValueOnce(0);
      const { error, diagnostic } = await captureFinancialFailure(() =>
        new OrderReservationService().reserveForLimitBuy(
          db as never,
          cashInput,
        ),
      );
      expect(error.getResponse()).toMatchObject({ error: { code } });
      expect(diagnostic).toMatchObject({
        failureStage: 'wallet_reservation',
        evidence: {
          financialGuard: { failureReason: reason, mutationAffected: 0 },
        },
      });
      expect(db.cashWallet.findUnique).toHaveBeenCalledTimes(2);
      expect(db.$executeRaw).toHaveBeenCalledTimes(1);
      expectSafeFinancialDiagnostic(diagnostic);
    },
  );
  it.each([
    ['missing', null, 'wallet_not_found', 'ORDER_RESERVATION_INCONSISTENT'],
    [
      'reserved shortage',
      wallet({ reservedAmount: d('399') }),
      'insufficient_reserved',
      'ORDER_RESERVATION_INCONSISTENT',
    ],
    ['concurrency', wallet(), 'conflict', 'ORDER_RESERVATION_CONFLICT'],
    [
      'scope mismatch',
      wallet({ tradingAccountId: 'foreign-account' }),
      'account_scope_mismatch',
      'FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH',
    ],
  ])('release preserves %s', async (_label, row, reason, code) => {
    const db = tx();
    db.cashWallet.findUnique.mockResolvedValueOnce(row);
    db.$executeRaw.mockResolvedValueOnce(0);
    const { error, diagnostic } = await captureFinancialFailure(() =>
      new OrderReservationService().releaseLimitBuyReservation(
        db as never,
        cashReleaseInput,
      ),
    );
    expect(error.getResponse()).toMatchObject({ error: { code } });
    expect(diagnostic).toMatchObject({
      failureStage: 'wallet_reservation_release',
      evidence: { financialGuard: { failureReason: reason } },
    });
    expect(db.cashWallet.findUnique).toHaveBeenCalledTimes(1);
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    expectSafeFinancialDiagnostic(diagnostic);
  });
  it.each(['admin', 'user', 'operator'])(
    'reserve evidence is admin-only (%s)',
    async (role) => {
      const db = tx();
      db.cashWallet.findUnique.mockResolvedValue(wallet());
      db.$executeRaw.mockResolvedValue(0);
      const { diagnostic } = await captureFinancialFailure(
        () =>
          new OrderReservationService().reserveForLimitBuy(
            db as never,
            cashInput,
          ),
        role,
      );
      if (role === 'admin') expectSafeFinancialDiagnostic(diagnostic);
      else expect(diagnostic).toBeUndefined();
    },
  );
  it('missing wallet fails before mutation', async () => {
    const db = tx();
    db.cashWallet.findUnique.mockResolvedValue(null);
    const { diagnostic } = await captureFinancialFailure(() =>
      new OrderReservationService().reserveForLimitBuy(db as never, cashInput),
    );
    expect(diagnostic?.evidence?.financialGuard).toMatchObject({
      walletFound: false,
      failureReason: 'wallet_not_found',
    });
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });
  it('successful reserve/release has the original read/write count and order', async () => {
    const db = tx();
    db.cashWallet.findUnique.mockResolvedValue(wallet());
    db.$executeRaw.mockResolvedValue(1);
    const service = new OrderReservationService();
    await expect(
      service.reserveForLimitBuy(db as never, cashInput),
    ).resolves.toEqual({ walletId: 'wallet-1' });
    await expect(
      service.releaseLimitBuyReservation(db as never, cashReleaseInput),
    ).resolves.toBeUndefined();
    expect(db.cashWallet.findUnique).toHaveBeenCalledTimes(1);
    expect(db.$executeRaw).toHaveBeenCalledTimes(2);
    expect(db.cashWallet.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
      db.$executeRaw.mock.invocationCallOrder[0],
    );
  });
});

describe('Limit quote safe availability evidence', () => {
  it.each([
    ['missing', null, false, 'wallet_not_found'],
    [
      'reserved shortage',
      wallet({ reservedAmount: d('900') }),
      true,
      'insufficient_available',
    ],
    [
      'total shortage',
      wallet({ balanceAmount: d('100'), reservedAmount: d('0') }),
      false,
      'insufficient_available',
    ],
  ])('BUY preview %s', async (_label, row, total, reason) => {
    const db = tx();
    db.cashWallet.findUnique.mockResolvedValue(row);
    db.position.findUnique.mockResolvedValue(null);
    const service = new LimitOrderCreateService(
      db as never,
      new OrderReservationService(),
    );
    const { diagnostic } = await captureFinancialFailure(() =>
      service.buildLimitBuyQuotePreview({
        tradingAccountId: 'account-1',
        assetId: 'asset-1',
        currencyCode: CurrencyCode.KRW,
        limitPrice: d('100'),
        quantity: d('2'),
        tradeFeeRate: d('0.001'),
      }),
    );
    expect(diagnostic?.evidence?.financialGuard).toMatchObject({
      failureReason: reason,
    });
    if (row)
      expect(diagnostic?.evidence?.financialGuard).toMatchObject({
        balanceSufficient: total,
      });
    expect(db.cashWallet.findUnique).toHaveBeenCalledTimes(1);
    expect(db.position.findUnique).toHaveBeenCalledTimes(1);
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expectSafeFinancialDiagnostic(diagnostic);
  });
  it.each([
    ['missing', null, 'position_not_found'],
    [
      'total shortage',
      position({ quantity: d('1'), reservedQuantity: d('0') }),
      'insufficient_quantity',
    ],
    [
      'reserved shortage',
      position({ reservedQuantity: d('9') }),
      'insufficient_available_quantity',
    ],
    [
      'scope',
      position({ tradingAccountId: 'foreign-account' }),
      'account_scope_mismatch',
    ],
  ])('SELL preview %s', async (_label, row, reason) => {
    const db = tx();
    db.cashWallet.findUnique.mockResolvedValue(wallet());
    db.position.findUnique.mockResolvedValue(row);
    const service = new LimitOrderCreateService(
      db as never,
      new OrderReservationService(),
    );
    const { diagnostic } = await captureFinancialFailure(() =>
      service.buildLimitSellQuotePreview({
        tradingAccountId: 'account-1',
        assetId: 'asset-1',
        currencyCode: CurrencyCode.KRW,
        limitPrice: d('100'),
        quantity: d('2'),
        tradeFeeRate: d('0.001'),
      }),
    );
    expect(diagnostic?.evidence?.financialGuard).toMatchObject({
      failureReason: reason,
    });
    expectSafeFinancialDiagnostic(diagnostic);
    expect(db.position.findUnique).toHaveBeenCalledTimes(1);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('Limit SELL reservation classification', () => {
  it.each([
    ['missing', null, 'position_not_found'],
    ['total shortage', position({ quantity: d('1') }), 'insufficient_quantity'],
    [
      'reserved shortage',
      position({ reservedQuantity: d('9') }),
      'insufficient_available_quantity',
    ],
    ['concurrency', position(), 'conflict'],
    [
      'account scope',
      position({ tradingAccountId: 'foreign-account' }),
      'account_scope_mismatch',
    ],
    ['asset scope', position({ assetId: 'foreign-asset' }), 'asset_mismatch'],
    [
      'currency',
      position({ currencyCode: CurrencyCode.USD }),
      'currency_mismatch',
    ],
  ])(
    'failed reserve identifies %s; public code stays INSUFFICIENT_QUANTITY',
    async (_label, row, reason) => {
      const db = tx();
      db.position.findUnique
        .mockResolvedValueOnce(position())
        .mockResolvedValueOnce(row);
      db.$executeRaw.mockResolvedValueOnce(0);
      const { error, diagnostic } = await captureFinancialFailure(() =>
        new LimitOrderCreateService(
          db as never,
          new OrderReservationService(),
        ).createSubmittedLimitSellInTransaction(db as never, createInput),
      );
      expect(error.getResponse()).toMatchObject({
        error: { code: 'INSUFFICIENT_QUANTITY' },
      });
      expect(diagnostic).toMatchObject({
        failureStage: 'position_reservation',
        evidence: {
          financialGuard: {
            failureReason: reason,
            mutationAffected: 0,
            observation: 'failure_read',
          },
        },
      });
      expect(db.position.findUnique).toHaveBeenCalledTimes(2);
      expect(db.position.findUnique).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: { id: 'position-1' } }),
      );
      expect(db.$executeRaw).toHaveBeenCalledTimes(1);
      expect(db.order.create).not.toHaveBeenCalled();
      expectSafeFinancialDiagnostic(diagnostic);
    },
  );
  it.each([
    ['missing', null, 'position_not_found', 'INSUFFICIENT_QUANTITY'],
    [
      'currency',
      position({ currencyCode: CurrencyCode.USD }),
      'currency_mismatch',
      'INSUFFICIENT_QUANTITY',
    ],
    [
      'scope',
      position({ tradingAccountId: 'foreign-account' }),
      'account_scope_mismatch',
      'TRADING_ACCOUNT_SCOPE_MISMATCH',
    ],
  ])(
    'initial %s retains its public contract',
    async (_label, row, reason, code) => {
      const db = tx();
      db.position.findUnique.mockResolvedValue(row);
      const { error, diagnostic } = await captureFinancialFailure(() =>
        new LimitOrderCreateService(
          db as never,
          new OrderReservationService(),
        ).createSubmittedLimitSellInTransaction(db as never, createInput),
      );
      expect(error.getResponse()).toMatchObject({ error: { code } });
      expect(diagnostic?.evidence?.financialGuard).toMatchObject({
        failureReason: reason,
      });
      expect(db.$executeRaw).not.toHaveBeenCalled();
      expectSafeFinancialDiagnostic(diagnostic);
    },
  );
});

describe('Reservation basis predicate evidence', () => {
  it.each([
    ['BUY', { quotedFeeRate: null }, { feeRatePresent: false }],
    ['BUY', { quotedFeeRate: d('1.1') }, { feeRateInRange: false }],
    ['BUY', { quotedGrossAmount: d('201') }, { grossMatched: false }],
    ['BUY', { quotedFeeAmount: d('0.3') }, { feeMatched: false }],
    ['BUY', { quotedReservedAmount: d('201') }, { reservedMatched: false }],
    ['SELL', { quotedFeeRate: null }, { feeRatePresent: false }],
    ['SELL', { quotedFeeRate: d('1.1') }, { feeRateInRange: false }],
    ['SELL', { quotedGrossAmount: d('201') }, { grossMatched: false }],
    ['SELL', { quotedFeeAmount: d('0.3') }, { feeMatched: false }],
    ['SELL', { quotedNetAmount: d('198') }, { netMatched: false }],
  ])(
    '%s basis rejects %j before mutation',
    async (side, overrides, predicates) => {
      const db = tx();
      const service = new LimitOrderCreateService(
        db as never,
        new OrderReservationService(),
      );
      const input = { ...createInput, quote: { ...quote, ...overrides } };
      const { error, diagnostic } = await captureFinancialFailure(() =>
        side === 'BUY'
          ? service.createSubmittedLimitBuyInTransaction(
              db as never,
              input as never,
            )
          : service.createSubmittedLimitSellInTransaction(
              db as never,
              input as never,
            ),
      );
      expect(error.getResponse()).toMatchObject({
        error: { code: 'QUOTE_RESERVATION_BASIS_INVALID' },
      });
      expect(diagnostic?.failureStage).toBe('quote_reservation_basis');
      expect(
        side === 'BUY'
          ? (diagnostic?.evidence?.financialGuard as { predicates: unknown })
              .predicates
          : diagnostic?.evidence?.financialGuard,
      ).toMatchObject(predicates);
      expect(db.$executeRaw).not.toHaveBeenCalled();
      expect(db.cashWallet.findUnique).not.toHaveBeenCalled();
      expect(db.position.findUnique).not.toHaveBeenCalled();
      expectSafeFinancialDiagnostic(diagnostic);
    },
  );
});

describe('Cancel/release guard evidence', () => {
  it.each([OrderSide.buy, OrderSide.sell])(
    'missing order reservation (%s) stops before row lookup/mutation',
    async (side) => {
      const { db, service } = cancelFixture(side, {
        reservedAmount: null,
        reservedQuantity: null,
      });
      const { error, diagnostic } = await captureFinancialFailure(() =>
        service.cancelOwnedLimitBuyOrder(cancelInput),
      );
      expect(error.getResponse()).toMatchObject({
        error: { code: 'ORDER_RESERVATION_INCONSISTENT' },
      });
      expect(diagnostic?.evidence?.financialGuard).toMatchObject({
        reservationPresent: false,
        failureReason: 'order_reservation_missing_or_non_positive',
      });
      expect(db.cashWallet.findUnique).not.toHaveBeenCalled();
      expect(db.position.findUnique).not.toHaveBeenCalled();
      expect(db.$executeRaw).not.toHaveBeenCalled();
      expectSafeFinancialDiagnostic(diagnostic);
    },
  );
  it.each([
    ['missing', null, 'wallet_not_found', 'ORDER_RESERVATION_INCONSISTENT'],
    [
      'reserved shortfall',
      wallet({ reservedAmount: d('399') }),
      'insufficient_reserved',
      'ORDER_RESERVATION_INCONSISTENT',
    ],
    ['concurrency', wallet(), 'conflict', 'ORDER_RESERVATION_CONFLICT'],
    [
      'scope',
      wallet({ tradingAccountId: 'foreign-account' }),
      'account_scope_mismatch',
      'FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH',
    ],
  ])(
    'BUY cancel identifies %s and does not finalize',
    async (_label, row, reason, code) => {
      const { db, service } = cancelFixture();
      db.cashWallet.findUnique
        .mockResolvedValueOnce(wallet())
        .mockResolvedValueOnce(row);
      db.$executeRaw.mockResolvedValueOnce(0);
      const { error, diagnostic } = await captureFinancialFailure(() =>
        service.cancelOwnedLimitBuyOrder(cancelInput),
      );
      expect(error.getResponse()).toMatchObject({ error: { code } });
      expect(diagnostic?.evidence?.financialGuard).toMatchObject({
        failureReason: reason,
      });
      expect(db.cashWallet.findUnique).toHaveBeenCalledTimes(2);
      expect(db.$executeRaw).toHaveBeenCalledTimes(1);
      expect(db.order.updateMany).not.toHaveBeenCalled();
      expectSafeFinancialDiagnostic(diagnostic);
    },
  );
  it.each([
    ['missing', null, 'position_not_found'],
    [
      'reserved shortfall',
      position({ reservedQuantity: d('3') }),
      'insufficient_reserved_quantity',
    ],
    ['concurrency', position(), 'conflict'],
    [
      'scope',
      position({ tradingAccountId: 'foreign-account' }),
      'account_scope_mismatch',
    ],
    ['asset', position({ assetId: 'foreign-asset' }), 'asset_mismatch'],
  ])(
    'SELL cancel identifies %s; public code stays reservation inconsistency',
    async (_label, row, reason) => {
      const { db, service } = cancelFixture(OrderSide.sell);
      db.position.findUnique
        .mockResolvedValueOnce(position())
        .mockResolvedValueOnce(row);
      db.$executeRaw.mockResolvedValueOnce(0);
      const { error, diagnostic } = await captureFinancialFailure(() =>
        service.cancelOwnedLimitBuyOrder(cancelInput),
      );
      expect(error.getResponse()).toMatchObject({
        error: { code: 'ORDER_RESERVATION_INCONSISTENT' },
      });
      expect(diagnostic?.evidence?.financialGuard).toMatchObject({
        failureReason: reason,
      });
      expect(db.position.findUnique).toHaveBeenCalledTimes(2);
      expect(db.$executeRaw).toHaveBeenCalledTimes(1);
      expect(db.order.updateMany).not.toHaveBeenCalled();
      expectSafeFinancialDiagnostic(diagnostic);
    },
  );
  it.each(['user', 'operator'])(
    'SELL reservation diagnosis is hidden from %s',
    async (role) => {
      const db = tx();
      db.position.findUnique.mockResolvedValue(
        position({ reservedQuantity: d('9') }),
      );
      db.$executeRaw.mockResolvedValue(0);
      const { diagnostic } = await captureFinancialFailure(
        () =>
          new LimitOrderCreateService(
            db as never,
            new OrderReservationService(),
          ).createSubmittedLimitSellInTransaction(db as never, createInput),
        role,
      );
      expect(diagnostic).toBeUndefined();
    },
  );
});

function payload(
  side = OrderSide.buy,
  overrides: Record<string, unknown> = {},
) {
  return {
    ...order(side),
    quoteId: 'quote-1',
    quantity: d('2'),
    limitPrice: d('100'),
    executedPrice: null,
    grossAmount: null,
    feeAmount: null,
    netAmount: null,
    assetPriceSnapshotId: null,
    fxRateSnapshotId: null,
    reservationReleasedAt: null,
    cancelReason: null,
    submittedAt: createInput.submittedAt,
    executedAt: null,
    canceledAt: null,
    rejectedAt: null,
    rejectReason: null,
    createdAt: createInput.submittedAt,
    updatedAt: createInput.submittedAt,
    asset: {
      id: 'asset-1',
      symbol: 'ASSET',
      name: 'Asset',
      market: 'KRX',
      currencyCode: CurrencyCode.KRW,
    },
    ...overrides,
  };
}
describe('Create/cancel successful I/O and boundary failures', () => {
  it.each([OrderSide.buy, OrderSide.sell])(
    'successful %s create keeps mutation/read counts and transaction sequence',
    async (side) => {
      const db = tx();
      db.cashWallet.findUnique.mockResolvedValue(wallet());
      db.position.findUnique.mockResolvedValue(position());
      db.$executeRaw.mockResolvedValue(1);
      db.order.create.mockResolvedValue({ id: 'order-1' });
      db.quote.updateMany.mockResolvedValue({ count: 1 });
      db.order.findUnique.mockResolvedValue(payload(side));
      db.order.update.mockResolvedValue({ id: 'order-1' });
      const service = new LimitOrderCreateService(
        db as never,
        new OrderReservationService(),
      );
      const response =
        side === OrderSide.buy
          ? await service.createSubmittedLimitBuyInTransaction(
              db as never,
              createInput,
            )
          : await service.createSubmittedLimitSellInTransaction(
              db as never,
              createInput,
            );
      expect(response.data.execution.state).toBe('submitted');
      expect(db.cashWallet.findUnique).toHaveBeenCalledTimes(
        side === OrderSide.buy ? 1 : 0,
      );
      expect(db.position.findUnique).toHaveBeenCalledTimes(
        side === OrderSide.sell ? 1 : 0,
      );
      expect(db.$executeRaw).toHaveBeenCalledTimes(1);
      expect(db.order.create).toHaveBeenCalledTimes(1);
      expect(db.quote.updateMany).toHaveBeenCalledTimes(1);
      expect(db.order.findUnique).toHaveBeenCalledTimes(1);
      expect(db.order.update).toHaveBeenCalledTimes(1);
      const calls = [
        db.$executeRaw,
        db.order.create,
        db.quote.updateMany,
        db.order.findUnique,
        db.order.update,
      ].map((fn) => fn.mock.invocationCallOrder[0]);
      expect(calls).toEqual([...calls].sort((a, b) => a - b));
      expect(db.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining(
            side === OrderSide.buy
              ? {
                  reservedAmount: '200.20000000',
                  reservationFeeRate: '0.001000',
                }
              : {
                  reservedQuantity: '2.000000',
                  reservationFeeRate: '0.001000',
                },
          ),
        }),
      );
    },
  );
  it.each([OrderSide.buy, OrderSide.sell])(
    'successful %s cancel performs exactly one release without failure read',
    async (side) => {
      const { db, service } = cancelFixture(side);
      db.cashWallet.findUnique.mockResolvedValue(wallet());
      db.position.findUnique.mockResolvedValue(position());
      db.$executeRaw.mockResolvedValue(1);
      db.order.updateMany.mockResolvedValue({ count: 1 });
      db.order.findUnique.mockResolvedValueOnce(
        payload(side, {
          status: OrderStatus.canceled,
          canceledAt: cancelInput.canceledAt,
          reservationReleasedAt: cancelInput.canceledAt,
        }),
      );
      const response = await service.cancelOwnedLimitBuyOrder(cancelInput);
      expect(response.data.execution.alreadyCanceled).toBe(false);
      expect(db.cashWallet.findUnique).toHaveBeenCalledTimes(
        side === OrderSide.buy ? 1 : 0,
      );
      expect(db.position.findUnique).toHaveBeenCalledTimes(
        side === OrderSide.sell ? 1 : 0,
      );
      expect(db.$executeRaw).toHaveBeenCalledTimes(1);
      expect(db.order.findUnique).toHaveBeenCalledTimes(2);
      expect(db.order.updateMany).toHaveBeenCalledTimes(1);
      expect(db.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
        db.order.updateMany.mock.invocationCallOrder[0],
      );
      expect(db.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            reservationReleasedAt: cancelInput.canceledAt,
            status: OrderStatus.canceled,
          }),
        }),
      );
    },
  );
  it.each([OrderSide.buy, OrderSide.sell])(
    'quote consume guard for %s remains bounded and rolls the create back',
    async (side) => {
      const db = tx();
      db.cashWallet.findUnique.mockResolvedValue(wallet());
      db.position.findUnique.mockResolvedValue(position());
      db.$executeRaw.mockResolvedValue(1);
      db.order.create.mockResolvedValue({ id: 'order-1' });
      db.quote.updateMany.mockResolvedValue({ count: 0 });
      const service = new LimitOrderCreateService(
        db as never,
        new OrderReservationService(),
      );
      const { error, diagnostic } = await captureFinancialFailure(() =>
        side === OrderSide.buy
          ? service.createSubmittedLimitBuyInTransaction(
              db as never,
              createInput,
            )
          : service.createSubmittedLimitSellInTransaction(
              db as never,
              createInput,
            ),
      );
      expect(error.getResponse()).toMatchObject({
        error: { code: 'QUOTE_NOT_ACTIVE' },
      });
      expect(diagnostic).toMatchObject({
        failureStage: 'quote_consume',
        evidence: {
          financialGuard: {
            failureReason: 'quote_consume_guard_rejected',
            mutationAffected: 0,
          },
        },
      });
      expect(db.order.findUnique).not.toHaveBeenCalled();
      expect(db.$executeRaw).toHaveBeenCalledTimes(1);
      expectSafeFinancialDiagnostic(diagnostic);
    },
  );
  it.each([OrderSide.buy, OrderSide.sell])(
    'read-back failure for %s does not retry reservation',
    async (side) => {
      const db = tx();
      db.cashWallet.findUnique.mockResolvedValue(wallet());
      db.position.findUnique.mockResolvedValue(position());
      db.$executeRaw.mockResolvedValue(1);
      db.order.create.mockResolvedValue({ id: 'order-1' });
      db.quote.updateMany.mockResolvedValue({ count: 1 });
      db.order.findUnique.mockResolvedValue(null);
      const service = new LimitOrderCreateService(
        db as never,
        new OrderReservationService(),
      );
      const { error, diagnostic } = await captureFinancialFailure(() =>
        side === OrderSide.buy
          ? service.createSubmittedLimitBuyInTransaction(
              db as never,
              createInput,
            )
          : service.createSubmittedLimitSellInTransaction(
              db as never,
              createInput,
            ),
      );
      expect(error.getResponse()).toMatchObject({
        error: { code: 'ORDER_RESERVATION_CONFLICT' },
      });
      expect(diagnostic?.evidence?.financialGuard).toMatchObject({
        failureReason: 'order_read_back_failed',
      });
      expect(db.order.update).not.toHaveBeenCalled();
      expect(db.$executeRaw).toHaveBeenCalledTimes(1);
      expectSafeFinancialDiagnostic(diagnostic);
    },
  );
  it('cancel finalization rejection is distinct from a release guard', async () => {
    const { db, service } = cancelFixture(OrderSide.sell);
    db.position.findUnique.mockResolvedValue(position());
    db.$executeRaw.mockResolvedValue(1);
    db.order.updateMany.mockResolvedValue({ count: 0 });
    const { error, diagnostic } = await captureFinancialFailure(() =>
      service.cancelOwnedLimitBuyOrder(cancelInput),
    );
    expect(error.getResponse()).toMatchObject({
      error: { code: 'ORDER_CANCEL_CONFLICT' },
    });
    expect(diagnostic).toMatchObject({
      failureStage: 'cancel_order_finalization',
      evidence: {
        financialGuard: {
          failureReason: 'order_cancel_guard_rejected',
          mutationAffected: 0,
        },
      },
    });
    expect(db.position.findUnique).toHaveBeenCalledTimes(1);
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    expectSafeFinancialDiagnostic(diagnostic);
  });
});

describe('Cancel initial target lookup', () => {
  it.each([
    [OrderSide.buy, null, 'wallet_not_found'],
    [OrderSide.sell, null, 'position_not_found'],
    [
      OrderSide.sell,
      position({ tradingAccountId: 'foreign-account' }),
      'account_scope_mismatch',
    ],
  ])(
    '%s cancel classifies missing/mis-scoped target before release',
    async (side, row, reason) => {
      const { db, service } = cancelFixture(side);
      db.cashWallet.findUnique.mockResolvedValue(row);
      db.position.findUnique.mockResolvedValue(row);
      const { error, diagnostic } = await captureFinancialFailure(() =>
        service.cancelOwnedLimitBuyOrder(cancelInput),
      );
      expect(error.getResponse()).toMatchObject({
        error: { code: 'ORDER_RESERVATION_INCONSISTENT' },
      });
      expect(diagnostic?.evidence?.financialGuard).toMatchObject({
        failureReason: reason,
      });
      expect(db.$executeRaw).not.toHaveBeenCalled();
      expect(db.order.updateMany).not.toHaveBeenCalled();
      expectSafeFinancialDiagnostic(diagnostic);
    },
  );
});
