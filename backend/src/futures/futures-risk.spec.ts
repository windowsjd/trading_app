jest.mock('../generated/prisma/client', () => ({
  CurrencyCode: { KRW: 'KRW', USD: 'USD' },
  Prisma: {
    Decimal: jest.requireActual('@prisma/client/runtime/client').Decimal,
  },
}));
import { Prisma } from '../generated/prisma/client';
import { futuresDecimal as d, marginCeil } from './futures-math';
import {
  positionRisk,
  isolatedLiquidationPrice,
  crossRisk,
  assertCrossSafe,
} from './futures-risk';
import { bankruptcySettlement } from './futures-settlement';
import {
  validateFuturesConfig,
  futuresTradingMode,
  assertFuturesOperation,
} from './futures.config';
import { futuresCommandHash, parseFuturesCommand } from './futures-input';
const p = {
  quantity: d('100'),
  averageEntryPrice: d('100'),
  direction: 'long' as 'long' | 'short',
  leverage: 37,
  isolatedMargin: d('270.27027028'),
  marginMode: 'isolated' as const,
};
const modes = ['general', 'season'] as const;
describe('F2 Decimal maintenance and isolated threshold', () => {
  for (const mode of modes)
    for (const direction of ['long', 'short'] as const)
      for (const leverage of [1, 37, 100]) {
        it(`${mode} ${direction} ${leverage}x requirement, buffer and analytic price`, () => {
          const fee = d(mode === 'general' ? '0.001' : '0.002');
          const pos = {
            ...p,
            direction,
            leverage,
            isolatedMargin: marginCeil(d('10000').div(leverage)),
          };
          const risk = positionRisk(pos, d('100'), fee);
          expect(risk.maintenanceMargin.toFixed(8)).toBe('50.00000000');
          expect(risk.estimatedCloseFee.toFixed(8)).toBe(
            mode === 'general' ? '10.00000000' : '20.00000000',
          );
          expect(
            risk.liquidationRequirement.eq(
              risk.maintenanceMargin.add(risk.estimatedCloseFee),
            ),
          ).toBe(true);
          expect(
            risk.liquidationBuffer.eq(
              pos.isolatedMargin.sub(risk.liquidationRequirement),
            ),
          ).toBe(true);
          const price = isolatedLiquidationPrice(pos, fee);
          if (direction === 'long' && leverage === 1) expect(price).toBeNull();
          else {
            const raw =
              direction === 'long'
                ? d('10000')
                    .sub(pos.isolatedMargin)
                    .div(d('100').mul(d('0.995').sub(fee)))
                : d('10000')
                    .add(pos.isolatedMargin)
                    .div(d('100').mul(d('1.005').add(fee)));
            expect(price!.sub(raw).abs().lt('0.00000001')).toBe(true);
            const equityAtRaw = pos.isolatedMargin.add(
              raw
                .sub('100')
                .mul('100')
                .mul(direction === 'long' ? 1 : -1),
            );
            expect(
              equityAtRaw
                .sub(raw.mul('100').mul(d('0.005').add(fee)))
                .abs()
                .lt('1e-50'),
            ).toBe(true);
          }
          // Exact cash-scale fixture: at mark=entry, margin equals requirement.
          const boundary = {
            ...pos,
            isolatedMargin: risk.liquidationRequirement,
          };
          expect(
            positionRisk(boundary, d('100'), fee).liquidationBuffer.eq(0),
          ).toBe(true);
          const above = {
            ...boundary,
            isolatedMargin: boundary.isolatedMargin.add('0.00000001'),
          };
          const below = {
            ...boundary,
            isolatedMargin: boundary.isolatedMargin.sub('0.00000001'),
          };
          expect(
            positionRisk(above, d('100'), fee).liquidationBuffer.gt(0),
          ).toBe(true);
          expect(
            positionRisk(below, d('100'), fee).liquidationBuffer.lt(0),
          ).toBe(true);
        });
      }
  it('rounds margin up and normal fee half up, without changing global Decimal precision', () => {
    const before = Prisma.Decimal.precision;
    const risk = positionRisk(
      { ...p, quantity: d('0.00000001') },
      d('1'),
      d('0.001'),
    );
    expect(risk.maintenanceMargin.toFixed(8)).toBe('0.00000001');
    expect(risk.estimatedCloseFee.toFixed(8)).toBe('0.00000000');
    expect(Prisma.Decimal.precision).toBe(before);
  });
});
describe('Cross shared collateral and explicit bankruptcy', () => {
  it.each(modes)(
    '%s offsets profitable and losing instruments without double allocating Isolated',
    (mode) => {
      const fee = d(mode === 'general' ? '0.001' : '0.002');
      const long = positionRisk(
        { ...p, quantity: d('1'), leverage: 10 },
        d('120'),
        fee,
      );
      const short = positionRisk(
        { ...p, quantity: d('2'), direction: 'short', leverage: 10 },
        d('105'),
        fee,
      );
      const r = crossRisk(
        { balanceAmount: d('100'), reservedAmount: d('5') },
        d('20'),
        [long, short],
      );
      expect(r.crossBaseCollateral.toString()).toBe('75');
      expect(r.crossUnrealizedPnl.toString()).toBe('10');
      expect(r.crossEquity.toString()).toBe('85');
      expect(r.crossInitialMarginRequirement.toString()).toBe('33');
      expect(r.crossFreeCollateral.toString()).toBe('52');
      expect(r.crossMaintenanceRequirement.toString()).toBe(
        mode === 'general' ? '1.98' : '2.31',
      );
      expect(() => assertCrossSafe(r, true)).not.toThrow();
      expect(() =>
        assertCrossSafe({ ...r, crossFreeCollateral: d('-0.00000001') }, true),
      ).toThrow();
      expect(() =>
        assertCrossSafe({ ...r, liquidationBuffer: d('0') }, true),
      ).toThrow();
    },
  );
  it.each([
    ['1', '-25', '0.1', '-1', '24.1'],
    ['20', '-15', '10', '-20', '5'],
    ['20', '10', '2', '8', '0'],
  ])(
    'collateral %s loss %s fee %s has settled cash %s and visible shortfall %s',
    (c, pnl, f, cash, shortfall) => {
      const r = bankruptcySettlement(d(c), d(pnl), d(f));
      expect(r.settledCash.toString()).toBe(cash);
      expect(r.bankruptcyShortfall.toString()).toBe(shortfall);
      expect(r.settledCash.sub(pnl).add(f).eq(r.bankruptcyShortfall)).toBe(
        true,
      );
    },
  );
});
describe('Operational modes, startup safety and F1 replay compatibility', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  it('strictly validates enabled risk/ingestion and keeps default disabled', () => {
    expect(futuresTradingMode({})).toBe('DISABLED');
    expect(futuresTradingMode({ FUTURES_TRADING_ENABLED: 'true' })).toBe(
      'ENABLED',
    );
    for (const flags of [
      {},
      { FUTURES_RISK_ENGINE_ENABLED: 'true' },
      { FUTURES_MARK_INGESTION_ENABLED: 'true' },
    ])
      expect(() =>
        validateFuturesConfig({ FUTURES_TRADING_MODE: 'ENABLED', ...flags }),
      ).toThrow();
    expect(() =>
      validateFuturesConfig({
        FUTURES_TRADING_MODE: 'ENABLED',
        FUTURES_RISK_ENGINE_ENABLED: 'true',
        FUTURES_MARK_INGESTION_ENABLED: 'true',
      }),
    ).not.toThrow();
    expect(() =>
      validateFuturesConfig({ FUTURES_TRADING_MODE: 'REDUCE_ONLY' }),
    ).not.toThrow();
    expect(() =>
      validateFuturesConfig({ FUTURES_TRADING_MODE: 'unknown' }),
    ).toThrow();
  });
  it.each(['ENABLED', 'REDUCE_ONLY', 'DISABLED'])(
    '%s gates only authorized operations',
    (mode) => {
      process.env.FUTURES_TRADING_MODE = mode;
      for (const op of ['open', 'increase', 'reduce', 'close']) {
        const allowed =
          mode === 'ENABLED' ||
          (mode === 'REDUCE_ONLY' && ['reduce', 'close'].includes(op));
        if (allowed) expect(() => assertFuturesOperation(op)).not.toThrow();
        else expect(() => assertFuturesOperation(op)).toThrow();
      }
    },
  );
  it('normalizes omitted/explicit isolated identically, cross hashes differently', () => {
    const b = {
      instrumentId: 'i',
      operation: 'open',
      direction: 'long',
      quantity: '1',
      leverage: 100,
      idempotencyKey: 'k',
    };
    const hash = (marginMode?: string) =>
      futuresCommandHash(
        'a',
        parseFuturesCommand({ ...b, ...(marginMode ? { marginMode } : {}) }),
      );
    expect(hash()).toBe(hash('isolated'));
    expect(hash('cross')).not.toBe(hash());
  });
});
