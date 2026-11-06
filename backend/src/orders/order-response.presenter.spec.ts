jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual<
    typeof import('@prisma/client/runtime/client')
  >('@prisma/client/runtime/client');
  return { Prisma: { Decimal }, PrismaClient: class PrismaClient {} };
});

import { Prisma } from '../generated/prisma/client';
import { formatOrderResponse } from './order-response.presenter';

const at = new Date('2026-11-06T00:00:00.000Z');
const order = (extra: { realizedPnl?: Prisma.Decimal | null } = {}) => ({
  id: 'order-1',
  side: 'sell' as const,
  orderType: 'market' as const,
  status: 'executed' as const,
  quantity: new Prisma.Decimal('2'),
  limitPrice: null,
  executedPrice: new Prisma.Decimal('100'),
  currencyCode: 'KRW' as const,
  grossAmount: new Prisma.Decimal('200'),
  feeAmount: new Prisma.Decimal('0.2'),
  netAmount: new Prisma.Decimal('199.8'),
  assetPriceSnapshotId: null,
  fxRateSnapshotId: null,
  submittedAt: at,
  executedAt: at,
  canceledAt: null,
  rejectedAt: null,
  rejectReason: null,
  createdAt: at,
  updatedAt: at,
  asset: {
    id: 'asset-1',
    symbol: '005930',
    name: '삼성전자',
    market: 'KRX',
    currencyCode: 'KRW' as const,
  },
  ...extra,
});

describe('formatOrderResponse realizedPnl', () => {
  it('omits the key when the call site did not read it (create/execute/cancel responses keep their shape)', () => {
    expect('realizedPnl' in formatOrderResponse(order())).toBe(false);
  });

  it('keeps null (unknown) apart from a recorded exact zero', () => {
    expect(
      formatOrderResponse(order({ realizedPnl: null })).realizedPnl,
    ).toBeNull();
    expect(
      formatOrderResponse(order({ realizedPnl: new Prisma.Decimal(0) }))
        .realizedPnl,
    ).toBe('0.00000000');
  });

  it('presents the stored signed figure at the money scale', () => {
    expect(
      formatOrderResponse(order({ realizedPnl: new Prisma.Decimal('39.8') }))
        .realizedPnl,
    ).toBe('39.80000000');
    expect(
      formatOrderResponse(order({ realizedPnl: new Prisma.Decimal('-20.14') }))
        .realizedPnl,
    ).toBe('-20.14000000');
  });
});
