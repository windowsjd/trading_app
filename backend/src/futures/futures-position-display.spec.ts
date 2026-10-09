jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');
  return { Prisma: { Decimal } };
});
import { Prisma } from '../generated/prisma/client';
import {
  presentFuturesPerformance,
  readFuturesHoldingSummaries,
} from './futures-position-display';
import { planFuturesExecution, futuresDecimal as d } from './futures-math';
import { positionRisk } from './futures-risk';

const row = (
  mode: 'cross' | 'isolated',
  direction: 'long' | 'short' = 'long',
) => ({
  id: 'position',
  direction,
  marginMode: mode,
  leverage: 3,
  quantity: d('2'),
  entryNotional: d('200.1234567891234567'),
  averageEntryPrice: d('100.06172839'),
  isolatedMargin: d('66.70781893'),
  realizedPnl: d('0'),
});
describe('read-only Futures performance projection', () => {
  it.each(['cross', 'isolated'] as const)(
    '%s uses entry basis rather than pooled collateral or Mark requirement',
    (mode) => {
      const p = row(mode);
      const risk = positionRisk(p, d('120'), d('0.001'));
      const result = presentFuturesPerformance(p, risk);
      expect(result.markNotional).toBe('240.00000000');
      expect(result.initialMargin).toBe('66.70781893');
      expect(result.initialMargin).not.toBe(risk.initialRequirement.toFixed(8));
      expect(result.roi).toBe(
        d(risk.unrealizedPnl).div(result.initialMargin).mul(100).toFixed(8),
      );
    },
  );
  it.each(['cross', 'isolated'] as const)(
    '%s retains the exact basis after Increase and Reduce despite rounded average price',
    (mode) => {
      const p = row(mode);
      const command = {
        positionId: p.id,
        instrumentId: 'instrument',
        direction: p.direction,
        marginMode: mode,
        leverage: p.leverage,
        quantity: '0.12345678',
        idempotencyKey: 'key',
      };
      const increased = {
        ...p,
        ...planFuturesExecution(
          { ...command, operation: 'increase' },
          p,
          d('99.12345678'),
          d('0.001'),
        ),
      };
      const reduced = {
        ...increased,
        ...planFuturesExecution(
          { ...command, operation: 'reduce', quantity: '0.33333333' },
          increased,
          d('110'),
          d('0.001'),
        ),
      };
      const result = presentFuturesPerformance(
        reduced,
        positionRisk(reduced, d('125'), d('0.001')),
      );
      const basis =
        mode === 'isolated'
          ? reduced.isolatedMargin
          : d(reduced.entryNotional)
              .div(reduced.leverage)
              .toDecimalPlaces(8, Prisma.Decimal.ROUND_CEIL);
      expect(result.initialMargin).toBe(basis.toFixed(8));
      expect(result.roi).toBe(
        d(positionRisk(reduced, d('125'), d('0.001')).unrealizedPnl)
          .div(basis)
          .mul(100)
          .toFixed(8),
      );
      expect(
        reduced.entryNotional.eq(
          reduced.quantity.mul(reduced.averageEntryPrice),
        ),
      ).toBe(false);
    },
  );
  it.each(['long', 'short'] as const)(
    '%s preserves canonical positive/negative/zero PnL',
    (direction) => {
      const p = {
        ...row('cross', direction),
        entryNotional: d('200'),
        averageEntryPrice: d('100'),
      };
      for (const mark of ['90', '100', '110']) {
        const risk = positionRisk(p, d(mark), d('0.001'));
        const result = presentFuturesPerformance(p, risk);
        expect(result.roi).toBe(
          d(risk.unrealizedPnl).div(result.initialMargin).mul(100).toFixed(8),
        );
      }
    },
  );
  it('keeps position facts when no fresh Mark is available without exposing margin or private fields', async () => {
    const now = new Date();
    const p = {
      ...row('cross'),
      tradingAccountId: 'account',
      instrument: {
        id: 'instrument',
        underlyingAssetId: 'btc',
        underlyingAsset: { name: 'Bitcoin', symbol: 'BTCUSDT' },
      },
    };
    const tx = {
      futuresPosition: { findMany: jest.fn().mockResolvedValue([p]) },
      futuresMarkSnapshot: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const result = await readFuturesHoldingSummaries(
      tx as never,
      'account',
      now,
    );
    expect(result.positions[0]).toMatchObject({
      name: 'Bitcoin',
      direction: 'long',
      marginMode: 'cross',
      leverage: 3,
      markNotional: null,
      markUnrealizedPnl: null,
      roi: null,
      markEvidence: null,
    });
    expect(tx.futuresPosition.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tradingAccountId: 'account', status: 'open' },
      }),
    );
    expect(JSON.stringify(result)).not.toMatch(
      /tradingAccountId|initialMargin|isolatedMargin|wallet|liquidation|averageEntryPrice|quantity/,
    );
  });
});
