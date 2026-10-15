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
import { KoscomError } from '../providers/koscom/koscom.config';
import {
  KoscomSessionCloseSource,
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

  it('has no US close source until a provider is selected', async () => {
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
