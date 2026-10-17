import {
  KRX_COLLECTION_COHORTS,
  KrxCentralCandlesConfigError,
  readKrxCentralCandlesConfig,
  resolveKrxObligationStart,
  type KrxCollectionCohort,
} from './krx-central-candles.config';
import {
  EXPANSION_2026_10_17,
  FIRST_PHASE_UNIVERSE,
} from '../providers/kis/kis-fixed-asset-universe';

const FIRST: KrxCollectionCohort = {
  id: 'cohort-1',
  obligationStart: '2026-11-01T15:00:00.000Z', // 2026-11-02 00:00 KST
  symbols: ['005930', '000660'],
};
const SECOND: KrxCollectionCohort = {
  id: 'cohort-2',
  obligationStart: '2026-11-15T15:00:00.000Z',
  symbols: ['035420'],
};

describe('central KRX candle switch and cohorts', () => {
  it('is off by default and boots without any cohort', () => {
    const config = readKrxCentralCandlesConfig({});
    expect(config.enabled).toBe(false);
    expect(config.tickDelayMs).toBe(70_000);
    expect(config.weeklySyncEnabled).toBe(true);
  });

  it('pins the deployed cohort registry: an obligation start is never edited', () => {
    // Changing a deployed cohort must be visible in review: update this list
    // only by APPENDING the new cohort (design v2.1 §5.6).
    expect(
      KRX_COLLECTION_COHORTS.map((cohort) => [
        cohort.id,
        cohort.obligationStart,
        cohort.symbols.length,
      ]),
    ).toEqual([
      ['krx-first-phase-15-2026-10-19', '2026-10-18T15:00:00.000Z', 15],
      ['krx-expansion-55-2026-10-19', '2026-10-18T15:00:00.000Z', 55],
    ]);
    // 2026-10-19 00:00 KST: a Monday KRX session date.
    expect(
      new Date(KRX_COLLECTION_COHORTS[0].obligationStart).toLocaleDateString(
        'en-CA',
        { timeZone: 'Asia/Seoul' },
      ),
    ).toBe('2026-10-19');
  });

  it('registers every domestic stock of the fixed universe in exactly one cohort', () => {
    const domestic = (list: typeof FIRST_PHASE_UNIVERSE) =>
      list
        .filter((entry) => entry.assetType === 'domestic_stock')
        .map((entry) => entry.symbol);
    expect([...KRX_COLLECTION_COHORTS[0].symbols]).toEqual(
      domestic(FIRST_PHASE_UNIVERSE),
    );
    expect([...KRX_COLLECTION_COHORTS[1].symbols]).toEqual(
      domestic(EXPANSION_2026_10_17),
    );
    const all = KRX_COLLECTION_COHORTS.flatMap((cohort) => cohort.symbols);
    expect(new Set(all).size).toBe(70);
    // The registry passes the boot validation with the switch on.
    expect(
      readKrxCentralCandlesConfig({ KOSCOM_CENTRAL_CANDLES_ENABLED: 'true' })
        .cohorts,
    ).toBe(KRX_COLLECTION_COHORTS);
  });

  it('refuses to boot when enabled without a cohort or with a short 5m retention', () => {
    expect(() =>
      readKrxCentralCandlesConfig(
        { KOSCOM_CENTRAL_CANDLES_ENABLED: 'true' },
        [],
      ),
    ).toThrow(KrxCentralCandlesConfigError);
    expect(() =>
      readKrxCentralCandlesConfig(
        {
          KOSCOM_CENTRAL_CANDLES_ENABLED: 'true',
          MARKET_CANDLE_5M_RETENTION_DAYS: '35',
        },
        [FIRST],
      ),
    ).toThrow('MARKET_CANDLE_5M_RETENTION_DAYS >= 45');
    expect(
      readKrxCentralCandlesConfig({ KOSCOM_CENTRAL_CANDLES_ENABLED: 'true' }, [
        FIRST,
      ]).enabled,
    ).toBe(true);
  });

  it.each([
    [[{ ...FIRST, obligationStart: '2026-11-02T00:00:00.000Z' }]],
    [[SECOND, FIRST]],
    [[FIRST, { ...SECOND, id: 'cohort-1' }]],
    [[{ ...FIRST, symbols: ['005930', '005930'] }]],
    [[{ ...FIRST, symbols: ['5930'] }]],
  ])('rejects a malformed cohort registry %#', (cohorts) => {
    expect(() => readKrxCentralCandlesConfig({}, cohorts)).toThrow(
      KrxCentralCandlesConfigError,
    );
  });

  it('resolves A from the latest listing cohort, and unlisted symbols fail closed to the first', () => {
    const reactivated = {
      ...SECOND,
      id: 'cohort-3',
      obligationStart: '2026-12-01T15:00:00.000Z',
      symbols: ['000660'],
    };
    const config = readKrxCentralCandlesConfig({}, [
      FIRST,
      SECOND,
      reactivated,
    ]);
    expect(resolveKrxObligationStart(config, '035420')?.toISOString()).toBe(
      SECOND.obligationStart,
    );
    // Re-activated symbol: the later cohort's A (no duty while inactive).
    expect(resolveKrxObligationStart(config, '000660')?.toISOString()).toBe(
      reactivated.obligationStart,
    );
    // Not registered → the earliest A: more defects visible, never fewer.
    expect(resolveKrxObligationStart(config, '999999')?.toISOString()).toBe(
      FIRST.obligationStart,
    );
    expect(
      resolveKrxObligationStart(readKrxCentralCandlesConfig({}, []), '005930'),
    ).toBeNull();
  });
});
