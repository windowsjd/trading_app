jest.mock('../generated/prisma/client', () => ({
  Prisma: {
    Decimal: jest.requireActual<typeof import('@prisma/client/runtime/client')>(
      '@prisma/client/runtime/client',
    ).Decimal,
    PrismaClientKnownRequestError: class PrismaClientKnownRequestError {},
  },
  AssetType: {
    domestic_stock: 'domestic_stock',
    us_stock: 'us_stock',
    crypto: 'crypto',
  },
  OrderSide: { buy: 'buy', sell: 'sell' },
  CurrencyCode: { KRW: 'KRW', USD: 'USD' },
}));
import { HttpException } from '@nestjs/common';
import { AssetType, OrderSide, Prisma } from '../generated/prisma/client';
import {
  applyMarketSessionOverrideSnapshot,
  markMarketSessionOverrideStoreRequired,
  resetMarketSessionOverrideStoreForTest,
} from './market-calendar/market-session-override.store';
import {
  decideLimitOnClose,
  limitOnCloseDeadlinePassed,
  nextCloseEvidenceTransition,
  resolveBoundLimitOnCloseSession,
  resolveLimitOnCloseRegistration,
  sessionDateText,
  sessionDateValue,
} from './limit-on-close.policy';
import type { LimitOnCloseConfig } from './limit-on-close.config';

const d = (value: string) => new Prisma.Decimal(value);
const krx = { assetType: AssetType.domestic_stock, market: 'KRX' };
const config: LimitOnCloseConfig = {
  enabled: true,
  sellEnabled: false,
  evidenceMinDelayMs: 1_200_000,
  evidenceConfirmMs: 300_000,
  evidenceDeadlineMs: 10_800_000,
};
// 2026-07-13 is a regular KRX Monday: 09:00–15:30 KST = 00:00–06:30 UTC.
const midday = new Date('2026-07-13T03:00:00.000Z');
const close = new Date('2026-07-13T06:30:00.000Z');

function errorCode(work: () => unknown): string | null {
  try {
    work();
    return null;
  } catch (error) {
    if (!(error instanceof HttpException)) return 'NOT_HTTP';
    const body = error.getResponse() as { error?: { code?: string } };
    return body.error?.code ?? 'NO_CODE';
  }
}

function seed(
  entries: Array<{
    localDate: string;
    overrideType: 'closed' | 'custom';
    openTime?: string;
    closeTime?: string;
  }>,
) {
  applyMarketSessionOverrideSnapshot(
    entries.map((entry) => ({
      market: 'KRX' as const,
      localDate: entry.localDate,
      overrideType: entry.overrideType,
      openTime: entry.openTime ?? null,
      closeTime: entry.closeTime ?? null,
      reason: 'test override',
    })),
    new Date('2026-07-01T00:00:00.000Z'),
  );
}

afterEach(() => resetMarketSessionOverrideStoreForTest());

describe('LOC price decision (shared buy/sell rule)', () => {
  it('BUY fills when the final close is below or equal to the limit', () => {
    expect(decideLimitOnClose(OrderSide.buy, d('100'), d('99.5'))).toBe('fill');
    expect(decideLimitOnClose(OrderSide.buy, d('100'), d('100'))).toBe('fill');
    expect(decideLimitOnClose(OrderSide.buy, d('100'), d('100.00000001'))).toBe(
      'not_reached',
    );
  });

  it('SELL (future reuse) fills when the final close is above or equal to the limit', () => {
    expect(decideLimitOnClose(OrderSide.sell, d('100'), d('101'))).toBe('fill');
    expect(decideLimitOnClose(OrderSide.sell, d('100'), d('100'))).toBe('fill');
    expect(decideLimitOnClose(OrderSide.sell, d('100'), d('99.99'))).toBe(
      'not_reached',
    );
  });

  it('never fills on a non-positive or non-finite close', () => {
    expect(decideLimitOnClose(OrderSide.buy, d('100'), d('0'))).toBe(
      'not_reached',
    );
    expect(decideLimitOnClose(OrderSide.buy, d('100'), d('NaN'))).toBe(
      'not_reached',
    );
  });
});

describe('LOC evidence deadline bounds the fill', () => {
  it('permits a fill strictly before the deadline only', () => {
    const deadline = new Date('2026-07-10T09:30:00.000Z');
    const at = (ms: number) => new Date(deadline.getTime() + ms);
    expect(limitOnCloseDeadlinePassed(at(-1), deadline)).toBe(false);
    expect(limitOnCloseDeadlinePassed(at(0), deadline)).toBe(true);
    expect(limitOnCloseDeadlinePassed(at(1), deadline)).toBe(true);
  });
});

describe('LOC registration session rules', () => {
  it('binds an open KRX regular session and its evidence deadline', () => {
    const result = resolveLimitOnCloseRegistration({
      asset: krx,
      now: midday,
      seasonEndAt: null,
      config,
    });
    expect(result.market).toBe('KRX');
    expect(result.session.localDate).toBe('2026-07-13');
    expect(result.session.closeTime.toISOString()).toBe(close.toISOString());
    expect(sessionDateText(result.sessionDate)).toBe('2026-07-13');
    expect(result.evidenceDeadlineAt.toISOString()).toBe(
      '2026-07-13T09:30:00.000Z',
    );
  });

  it('accepts only strictly before the close (close instant is excluded)', () => {
    const justBefore = new Date(close.getTime() - 1);
    expect(
      errorCode(() =>
        resolveLimitOnCloseRegistration({
          asset: krx,
          now: justBefore,
          seasonEndAt: null,
          config,
        }),
      ),
    ).toBeNull();
    expect(
      errorCode(() =>
        resolveLimitOnCloseRegistration({
          asset: krx,
          now: close,
          seasonEndAt: null,
          config,
        }),
      ),
    ).toBe('LOC_SESSION_NOT_OPEN');
  });

  it('rejects weekends, operator closures and outside-session times', () => {
    for (const now of [
      new Date('2026-07-11T03:00:00.000Z'), // Saturday
      new Date('2026-07-12T23:59:00.000Z'), // 08:59 KST Monday
      new Date('2026-07-13T07:00:00.000Z'), // after close
    ])
      expect(
        errorCode(() =>
          resolveLimitOnCloseRegistration({
            asset: krx,
            now,
            seasonEndAt: null,
            config,
          }),
        ),
      ).toBe('LOC_SESSION_NOT_OPEN');
    seed([{ localDate: '2026-07-13', overrideType: 'closed' }]);
    expect(
      errorCode(() =>
        resolveLimitOnCloseRegistration({
          asset: krx,
          now: midday,
          seasonEndAt: null,
          config,
        }),
      ),
    ).toBe('LOC_SESSION_NOT_OPEN');
  });

  it('uses an early-close override as the bound close', () => {
    seed([
      {
        localDate: '2026-07-13',
        overrideType: 'custom',
        openTime: '09:00:00',
        closeTime: '13:00:00',
      },
    ]);
    const result = resolveLimitOnCloseRegistration({
      asset: krx,
      now: midday,
      seasonEndAt: null,
      config,
    });
    expect(result.session.closeTime.toISOString()).toBe(
      '2026-07-13T04:00:00.000Z',
    );
    expect(result.session.earlyClose).toBe(true);
    expect(
      errorCode(() =>
        resolveLimitOnCloseRegistration({
          asset: krx,
          now: new Date('2026-07-13T04:30:00.000Z'),
          seasonEndAt: null,
          config,
        }),
      ),
    ).toBe('LOC_SESSION_NOT_OPEN');
  });

  it('fails closed while the calendar is unavailable', () => {
    markMarketSessionOverrideStoreRequired();
    expect(
      errorCode(() =>
        resolveLimitOnCloseRegistration({
          asset: krx,
          now: midday,
          seasonEndAt: null,
          config,
        }),
      ),
    ).toBe('MARKET_CALENDAR_UNAVAILABLE');
  });

  it('keeps US stocks and crypto unsupported', () => {
    for (const asset of [
      { assetType: AssetType.us_stock, market: 'NAS' },
      { assetType: AssetType.crypto, market: 'BINANCE' },
    ])
      expect(
        errorCode(() =>
          resolveLimitOnCloseRegistration({
            asset,
            now: new Date('2026-07-13T15:00:00.000Z'),
            seasonEndAt: null,
            config,
          }),
        ),
      ).toBe('LOC_MARKET_NOT_SUPPORTED');
  });

  it('rejects a session that closes at or after the Season end', () => {
    expect(
      errorCode(() =>
        resolveLimitOnCloseRegistration({
          asset: krx,
          now: midday,
          seasonEndAt: close,
          config,
        }),
      ),
    ).toBe('LOC_SESSION_AFTER_SEASON_END');
    expect(
      errorCode(() =>
        resolveLimitOnCloseRegistration({
          asset: krx,
          now: midday,
          seasonEndAt: new Date(close.getTime() + 1),
          config,
        }),
      ),
    ).toBeNull();
  });
});

describe('LOC settlement-time session binding', () => {
  const date = sessionDateValue('2026-07-13');

  it('returns the current-calendar session that contains the submission', () => {
    const session = resolveBoundLimitOnCloseSession(krx, midday, date);
    expect(session?.closeTime.toISOString()).toBe(close.toISOString());
    expect(
      resolveBoundLimitOnCloseSession(
        krx,
        midday,
        sessionDateValue('2026-07-14'),
      ) === null,
    ).toBe(true);
  });

  it('invalidates the order when a later override removes or ends the session first', () => {
    seed([{ localDate: '2026-07-13', overrideType: 'closed' }]);
    expect(resolveBoundLimitOnCloseSession(krx, midday, date) === null).toBe(
      true,
    );
    seed([
      {
        localDate: '2026-07-13',
        overrideType: 'custom',
        openTime: '09:00:00',
        closeTime: '11:00:00',
      },
    ]);
    expect(resolveBoundLimitOnCloseSession(krx, midday, date) === null).toBe(
      true,
    );
    seed([
      {
        localDate: '2026-07-13',
        overrideType: 'custom',
        openTime: '09:00:00',
        closeTime: '13:00:00',
      },
    ]);
    expect(
      resolveBoundLimitOnCloseSession(
        krx,
        midday,
        date,
      )?.closeTime.toISOString(),
    ).toBe('2026-07-13T04:00:00.000Z');
  });
});

describe('close evidence finality transitions', () => {
  const first = new Date('2026-07-13T06:50:00.000Z');
  const observing = {
    status: 'observing' as const,
    closePrice: d('70000'),
    firstObservedAt: first,
    lastObservedAt: first,
  };
  const at = (ms: number) => new Date(first.getTime() + ms);

  it('creates on the first observation', () => {
    expect(
      nextCloseEvidenceTransition(
        null,
        { closePrice: d('70000'), observedAt: first },
        300_000,
      ),
    ).toBe('create');
  });

  it('finalizes only an identical value observed at least the confirmation interval later', () => {
    expect(
      nextCloseEvidenceTransition(
        observing,
        { closePrice: d('70000'), observedAt: at(299_999) },
        300_000,
      ),
    ).toBe('extend');
    expect(
      nextCloseEvidenceTransition(
        observing,
        { closePrice: d('70000.00000000'), observedAt: at(300_000) },
        300_000,
      ),
    ).toBe('finalize');
  });

  it('restarts confirmation when the provider value changes', () => {
    expect(
      nextCloseEvidenceTransition(
        observing,
        { closePrice: d('70100'), observedAt: at(600_000) },
        300_000,
      ),
    ).toBe('replace');
  });

  it('ignores stale observations and never changes final evidence', () => {
    expect(
      nextCloseEvidenceTransition(
        observing,
        { closePrice: d('70000'), observedAt: first },
        300_000,
      ),
    ).toBe('ignore');
    expect(
      nextCloseEvidenceTransition(
        { ...observing, status: 'final' },
        { closePrice: d('71000'), observedAt: at(900_000) },
        300_000,
      ),
    ).toBe('ignore');
  });
});
