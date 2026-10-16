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
  PrismaClient: class PrismaClient {},
}));
import { Prisma } from '../generated/prisma/client';
import { KoscomError } from '../providers/koscom/koscom.config';
import { TiingoError } from '../providers/tiingo/tiingo.errors';
import {
  KoscomSessionCloseSource,
  LimitOnCloseEvidenceService,
  SessionCloseSources,
  TiingoSessionCloseSource,
  sessionCloseFailure,
  type SessionCloseTarget,
} from './limit-on-close-evidence.service';
import { sessionDateValue } from './limit-on-close.policy';

const target: SessionCloseTarget = {
  assetId: 'asset-1',
  symbol: '005930',
  assetMarket: 'KRX',
  market: 'KRX',
  sessionDate: sessionDateValue('2026-07-13'),
  sessionCloseAt: new Date('2026-07-13T06:30:00.000Z'),
};
const receivedAt = new Date('2026-07-13T06:55:00.000Z');
const row = {
  trdDd: '20260713',
  opnprc: '70000',
  hgprc: '71000',
  lwprc: '69000',
  trdPrc: '70500',
  accTrdvol: '1000',
  accTrdval: '70500000',
};

function source(result: Record<string, unknown>, at = receivedAt) {
  const get = jest.fn().mockResolvedValue({ result, receivedAt: at });
  const resolve = jest.fn().mockResolvedValue('kospi');
  return {
    get,
    resolve,
    source: new KoscomSessionCloseSource(
      { getConfig: () => ({ apiKey: 'secret-koscom-key' }) } as never,
      { get } as never,
      { resolve } as never,
    ),
  };
}

async function failure(result: Record<string, unknown>, at = receivedAt) {
  try {
    await source(result, at).source.observe(target);
    return null;
  } catch (error) {
    return sessionCloseFailure(error);
  }
}

describe('KOSCOM dated session-close observation', () => {
  it('requests exactly one dated daily history row and returns traceable evidence', async () => {
    const fixture = source({ isuSrtCd: '005930', hisLists: [row] });
    const observation = await fixture.source.observe(target);
    expect(fixture.get).toHaveBeenCalledWith(
      '/v3/market/closed/kospi/005930/history',
      {
        trnsmCycleTpCd: 'D',
        inqStrtDd: '20260713',
        inqEndDd: '20260713',
        reqCnt: '1',
      },
      undefined,
      // LOC evidence is a P2 budget category (design v2.1 §7.2).
      { category: 'loc' },
    );
    expect(observation.closePrice.toFixed()).toBe('70500');
    expect(observation.providerTradingDate).toBe('20260713');
    expect(observation.providerSymbol).toBe('005930');
    expect(observation.sourceName).toBe('koscom_history');
    expect(observation.currencyCode).toBe('KRW');
    expect(observation.observedAt.toISOString()).toBe(receivedAt.toISOString());
    const raw = JSON.stringify(observation.raw);
    expect(raw.includes('rest_session_close_history')).toBe(true);
    expect(raw.includes('secret-koscom-key')).toBe(false);
  });

  it('rejects a different symbol, missing/duplicate rows and another date', async () => {
    expect(await failure({ isuSrtCd: '000660', hisLists: [row] })).toBe(
      'KOSCOM_CLOSE_SYMBOL_MISMATCH',
    );
    expect(await failure({ isuSrtCd: '005930', hisLists: [] })).toBe(
      'KOSCOM_CLOSE_EVIDENCE_MISSING',
    );
    expect(await failure({ isuSrtCd: '005930', hisLists: [row, row] })).toBe(
      'KOSCOM_CLOSE_EVIDENCE_MISSING',
    );
    expect(
      await failure({
        isuSrtCd: '005930',
        hisLists: [{ ...row, trdDd: '20260710' }],
      }),
    ).toBe('KOSCOM_CLOSE_DATE_MISMATCH');
  });

  it('rejects receipts before the session close and sessions without trades', async () => {
    expect(
      await failure(
        { isuSrtCd: '005930', hisLists: [row] },
        new Date('2026-07-13T06:29:59.999Z'),
      ),
    ).toBe('KOSCOM_CLOSE_BEFORE_SESSION_END');
    expect(
      await failure({
        isuSrtCd: '005930',
        hisLists: [{ ...row, accTrdvol: '0' }],
      }),
    ).toBe('KOSCOM_CLOSE_NO_TRADES');
  });

  it('rejects inconsistent OHLC through the existing KOSCOM normalizer', async () => {
    expect(
      await failure({
        isuSrtCd: '005930',
        hisLists: [{ ...row, trdPrc: '72000' }],
      }),
    ).toBe('KOSCOM_INVALID_OHLC');
  });

  it('never answers for a US session (US closes come from Tiingo)', async () => {
    const fixture = source({ isuSrtCd: 'AAPL', hisLists: [row] });
    let code: string | null = null;
    try {
      await fixture.source.observe({ ...target, market: 'US', symbol: 'AAPL' });
    } catch (error) {
      code = sessionCloseFailure(error);
    }
    expect(code).toBe('SESSION_CLOSE_SOURCE_UNAVAILABLE');
    expect(fixture.get).not.toHaveBeenCalled();
  });

  it('keeps fixed provider categories and never echoes unknown errors', () => {
    expect(sessionCloseFailure(new KoscomError('KOSCOM_HTTP_429'))).toBe(
      'KOSCOM_HTTP_429',
    );
    // @diagnosticSurface internal: Test-only unknown failure.
    expect(sessionCloseFailure(new Error('private text'))).toBe(
      'SESSION_CLOSE_OBSERVATION_FAILED',
    );
  });
});

// ---------------------------------------------------------------------------
// US (2026-10-17): Tiingo end-of-day RAW close.

const usTarget: SessionCloseTarget = {
  assetId: 'asset-us',
  symbol: 'AAPL',
  assetMarket: 'NAS',
  market: 'US',
  sessionDate: sessionDateValue('2026-10-16'),
  // 16:00 EDT.
  sessionCloseAt: new Date('2026-10-16T20:00:00.000Z'),
};
// 21:15 EDT.
const usReceivedAt = new Date('2026-10-17T01:15:00.000Z');
const meta = { ticker: 'aapl', name: 'Apple Inc', exchangeCode: 'NASDAQ' };
const bar = {
  date: '2026-10-16T00:00:00.000Z',
  open: 174.2,
  high: 176.9,
  low: 173.8,
  close: 175.5,
  volume: 51234567,
  // Adjusted values differ on purpose: they are never evidence.
  adjOpen: 172.9,
  adjHigh: 175.6,
  adjLow: 172.5,
  adjClose: 174.21,
  adjVolume: 51234567,
  divCash: 0,
  splitFactor: 1,
};

function tiingo(
  daily: unknown,
  options: {
    at?: Date;
    meta?: Record<string, unknown>;
    config?: Record<string, unknown>;
  } = {},
) {
  const getDailyPrices = jest
    .fn()
    .mockResolvedValue({ json: daily, receivedAt: options.at ?? usReceivedAt });
  const getMeta = jest.fn().mockResolvedValue({
    json: options.meta ?? meta,
    receivedAt: usReceivedAt,
  });
  return {
    getDailyPrices,
    getMeta,
    source: new TiingoSessionCloseSource(
      {
        getConfig: () => ({
          enabled: true,
          trialMode: false,
          token: 'secret-tiingo-token',
          ...options.config,
        }),
      } as never,
      { getDailyPrices, getMeta } as never,
    ),
  };
}

async function usFailure(
  daily: unknown,
  options: Parameters<typeof tiingo>[1] = {},
) {
  try {
    await tiingo(daily, options).source.observe(usTarget);
    return null;
  } catch (error) {
    return sessionCloseFailure(error);
  }
}

describe('Tiingo dated US session-close observation', () => {
  it('requests the exact New York trading date and keeps the RAW close (never adjClose)', async () => {
    const fixture = tiingo([bar]);
    const observation = await fixture.source.observe(usTarget);
    expect(fixture.getDailyPrices).toHaveBeenCalledWith('AAPL', {
      startDate: '2026-10-16',
      endDate: '2026-10-16',
    });
    expect(fixture.getMeta).toHaveBeenCalledWith('AAPL');
    expect(observation.closePrice.toFixed()).toBe('175.5');
    expect(observation.closePrice.eq(new Prisma.Decimal('174.21'))).toBe(false);
    expect(observation.provider).toBe('tiingo');
    expect(observation.sourceName).toBe('tiingo_eod');
    expect(observation.providerSymbol).toBe('AAPL');
    expect(observation.providerTradingDate).toBe('20261016');
    expect(observation.currencyCode).toBe('USD');
    expect(observation.observedAt.toISOString()).toBe(
      usReceivedAt.toISOString(),
    );
    const raw = JSON.stringify(observation.raw);
    expect(raw.includes('rest_eod_session_close')).toBe(true);
    expect(raw.includes('raw_close')).toBe(true);
    expect(raw.includes('secret-tiingo-token')).toBe(false);
  });

  it('rejects another date (previous or next session), missing rows and duplicates', async () => {
    expect(
      await usFailure([{ ...bar, date: '2026-10-17T00:00:00.000Z' }]),
    ).toBe('TIINGO_CLOSE_DATE_MISMATCH');
    expect(
      await usFailure([{ ...bar, date: '2026-10-15T00:00:00.000Z' }]),
    ).toBe('TIINGO_CLOSE_DATE_MISMATCH');
    expect(await usFailure([])).toBe('TIINGO_CLOSE_EVIDENCE_MISSING');
    expect(
      await usFailure([bar, { ...bar, date: '2026-10-17T00:00:00.000Z' }]),
    ).toBe('TIINGO_CLOSE_EVIDENCE_MISSING');
    expect(await usFailure([bar, bar])).toBe('TIINGO_CLOSE_INVALID_BAR');
  });

  it("rejects another ticker or exchange in Tiingo's own metadata", async () => {
    expect(await usFailure([bar], { meta: { ...meta, ticker: 'msft' } })).toBe(
      'TIINGO_SYMBOL_MISMATCH',
    );
    expect(
      await usFailure([bar], { meta: { ...meta, exchangeCode: 'NYSE' } }),
    ).toBe('TIINGO_CLOSE_EXCHANGE_MISMATCH');
  });

  it('rejects receipts before the close, inconsistent OHLC and sessions without trades', async () => {
    expect(
      await usFailure([bar], { at: new Date('2026-10-16T19:59:59.999Z') }),
    ).toBe('TIINGO_CLOSE_BEFORE_SESSION_END');
    expect(await usFailure([{ ...bar, close: 177 }])).toBe(
      'TIINGO_CLOSE_INVALID_BAR',
    );
    expect(await usFailure([{ ...bar, close: 0 }])).toBe(
      'TIINGO_CLOSE_INVALID_BAR',
    );
    expect(await usFailure([{ ...bar, volume: 0 }])).toBe(
      'TIINGO_CLOSE_NO_TRADES',
    );
  });

  it('is never evidence in trial mode, when disabled, or for a KRX session', async () => {
    const trial = tiingo([bar], { config: { trialMode: true } });
    let code: string | null = null;
    try {
      await trial.source.observe(usTarget);
    } catch (error) {
      code = sessionCloseFailure(error);
    }
    expect(code).toBe('TIINGO_CLOSE_SOURCE_DISABLED');
    expect(trial.getDailyPrices).not.toHaveBeenCalled();
    expect(await usFailure([bar], { config: { enabled: false } })).toBe(
      'TIINGO_CLOSE_SOURCE_DISABLED',
    );
    const krx = tiingo([bar]);
    code = null;
    try {
      await krx.source.observe(target);
    } catch (error) {
      code = sessionCloseFailure(error);
    }
    expect(code).toBe('SESSION_CLOSE_SOURCE_UNAVAILABLE');
    expect(krx.getDailyPrices).not.toHaveBeenCalled();
  });

  it('keeps fixed Tiingo transport categories', () => {
    expect(sessionCloseFailure(new TiingoError('TIINGO_RATE_LIMITED'))).toBe(
      'TIINGO_RATE_LIMITED',
    );
  });

  it('routes each market to its own provider', async () => {
    const koscom = { observe: jest.fn().mockResolvedValue('krx') };
    const tiingoSource = { observe: jest.fn().mockResolvedValue('us') };
    const sources = new SessionCloseSources(
      koscom as never,
      tiingoSource as never,
    );
    expect(await sources.observe(target)).toBe('krx');
    expect(await sources.observe(usTarget)).toBe('us');
    expect(koscom.observe).toHaveBeenCalledTimes(1);
    expect(tiingoSource.observe).toHaveBeenCalledTimes(1);
  });

  it("never records another provider's close for a market (no KOSCOM/Tiingo mixing)", async () => {
    const transaction = jest.fn();
    const evidence = new LimitOnCloseEvidenceService({
      $transaction: transaction,
    } as never);
    const observation = await tiingo([bar]).source.observe(usTarget);
    let code: string | null = null;
    try {
      await evidence.recordObservation(
        usTarget,
        { ...observation, provider: 'koscom' },
        300_000,
      );
    } catch (error) {
      code = sessionCloseFailure(error);
    }
    expect(code).toBe('SESSION_CLOSE_IDENTITY_MISMATCH');
    // A KRX target never accepts a Tiingo close either: here everything but
    // the provider matches the KRX target (symbol, date, currency).
    const krxShaped = {
      ...observation,
      providerSymbol: '005930',
      providerTradingDate: '20260713',
      currencyCode: 'KRW' as never,
    };
    code = null;
    try {
      await evidence.recordObservation(target, krxShaped, 300_000);
    } catch (error) {
      code = sessionCloseFailure(error);
    }
    expect(code).toBe('SESSION_CLOSE_IDENTITY_MISMATCH');
    expect(transaction).not.toHaveBeenCalled();
    // Control: the same close from KOSCOM passes the identity check (only
    // the provider made the difference above).
    await evidence
      .recordObservation(target, { ...krxShaped, provider: 'koscom' }, 300_000)
      .catch(() => undefined);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
