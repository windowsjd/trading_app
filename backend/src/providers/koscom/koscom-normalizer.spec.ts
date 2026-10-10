jest.mock('../../generated/prisma/client', () => ({
  Prisma: {
    Decimal: jest.requireActual<{
      Decimal: typeof import('@prisma/client/runtime/client').Decimal;
    }>('@prisma/client/runtime/client').Decimal,
  },
  CurrencyCode: { KRW: 'KRW', USD: 'USD' },
}));
import {
  koscomClock,
  koscomTime,
  normalizeKoscomPrice,
  normalizeKoscomOrderbook,
} from './koscom-normalizer';
import {
  resolveAssetProviderEligibility,
  selectMarketAwareAssetPriceSnapshotBySourcePriority,
} from '../source-eligibility.policy';

const now = new Date('2026-09-30T01:00:01Z');
const row = {
  isuSrtCd: '005930',
  trdPrc: '70000',
  cmpprevddTpCd: '5',
  cmpprevddPrc: '-1000',
  trdTm: 10000000,
  accTrdvol: '12',
  accTrdval: '1234567890123456789012',
};
describe('KOSCOM normalization', () => {
  it.each([9100000, '09100000', '9100000'])(
    'normalizes omitted clock zeroes: %s',
    (value) => {
      expect(koscomClock(value)).toBe('09100000');
      expect(koscomTime('20260930', value).toISOString()).toBe(
        '2026-09-30T00:10:00.000Z',
      );
    },
  );
  it.each(['31000000', '61000000', '0', '09600000', '-1', 'invalid'])(
    'rejects market signals and invalid clocks: %s',
    (value) => {
      expect(() => koscomClock(value)).toThrow('KOSCOM_INVALID_TIME');
    },
  );
  it.each([
    ['1', '1000'],
    ['2', '1000'],
    ['3', '0'],
    ['4', '-1000'],
    ['5', '-1000'],
    ['6', '1000'],
    ['7', '1000'],
    ['8', '-1000'],
    ['9', '-1000'],
  ])('signs change code %s correctly', (code, expected) => {
    const parsed = normalizeKoscomPrice(
      {
        ...row,
        cmpprevddTpCd: code,
        cmpprevddPrc: code === '3' ? '0' : '1000',
      },
      now,
    );
    expect(parsed.change).toBe(`${expected}.00000000`);
    expect(parsed.amount).toBe('1234567890123456789012');
  });
  it('computes percentage from previous close and preserves receipt time', () => {
    const parsed = normalizeKoscomPrice(row, now);
    expect(parsed.changeRate).toBe('-1.40845070');
    expect(parsed.receivedAt > parsed.effectiveAt).toBe(true);
  });
  it.each([
    { trdPrc: '0' },
    { trdPrc: 'NaN' },
    { trdTm: 11000000 },
    { trdTm: 9300000 },
    { trdDd: '20260929' },
    { cmpprevddTpCd: 'x' },
  ])('rejects invalid/stale/future prices %p', (overrides) => {
    expect(() => normalizeKoscomPrice({ ...row, ...overrides }, now)).toThrow(
      /^KOSCOM_/,
    );
  });
  it('maps 10 levels and totals without substituting quantities or sorting corrupted depth', () => {
    const book: Record<string, string> = {
      askordTotRqty: '9999',
      bidordTotRqty: '8888',
    };
    for (let i = 1; i <= 10; i++)
      Object.assign(book, {
        [`askStep${i}BstordPrc`]: String(70000 + i * 100),
        [`bidStep${i}BstordPrc`]: String(70000 - i * 100),
        [`askStep${i}BstordRqty`]: String(i),
        [`bidStep${i}BstordRqty`]: String(i + 20),
      });
    const parsed = normalizeKoscomOrderbook(book);
    expect(parsed.asks.length).toBe(10);
    expect(parsed.bids.length).toBe(10);
    expect(parsed.bids[0].quantity).toBe('21.00000000');
    expect(parsed.askTotal).toBe('9999.00000000');
    delete book.bidStep1BstordRqty;
    expect(() => normalizeKoscomOrderbook(book)).toThrow(
      'KOSCOM_INVALID_DECIMAL',
    );
  });
  it('selects only KOSCOM for live orders and blocks old exchange timestamps', () => {
    const asset = {
      assetType: 'domestic_stock' as const,
      market: 'KRX',
      currencyCode: 'KRW' as const,
    };
    const eligibility = resolveAssetProviderEligibility({
      workflow: 'orders_execute',
      asset,
    });
    expect(eligibility.eligible).toBe(true);
    if (!eligibility.eligible) throw new Error('Expected eligibility');
    expect(eligibility.sourceNames).toEqual(['koscom_krx_realtime_price']);
    for (const [sourceName, time] of [
      ['kis_krx_realtime_trade', '2026-09-30T01:00:00Z'],
      ['koscom_krx_realtime_price', '2026-09-30T00:59:00Z'],
    ]) {
      const result = selectMarketAwareAssetPriceSnapshotBySourcePriority({
        asset,
        workflow: 'orders_execute',
        expectedSourceNames: eligibility.sourceNames,
        now,
        freshnessThresholdSeconds: 10,
        isPositiveValue: () => true,
        candidates: [
          {
            id: 'a',
            sourceType: 'provider_api',
            sourceName,
            capturedAt: now,
            effectiveAt: new Date(time),
          },
        ],
      });
      expect(result.state).toBe('not_selected');
    }
    const historic = resolveAssetProviderEligibility({
      workflow: 'season_settlement',
      asset,
    });
    expect(
      historic.eligible &&
        historic.sourceNames.includes('kis_krx_realtime_trade'),
    ).toBe(true);
  });
});
