import {
  isKoscomPollingOwnedByLiveSupervisor,
  koscomConfigWarnings,
  readKoscomConfig,
} from './koscom.config';

describe('KOSCOM collection switches', () => {
  it('keeps every collection behaviour production runs today by default', () => {
    const config = readKoscomConfig({});
    expect(config.orderbookCollectionEnabled).toBe(true);
    expect(config.pollIntervalMs).toBe(3000);
    expect(config.pollLogEnabled).toBe(false);
    // Observation only: counters and the per-minute cycle summary.
    expect(config.callMetricsEnabled).toBe(true);
    expect(config.cycleMetricsEnabled).toBe(true);
  });

  it('turns each switch on or off explicitly', () => {
    const config = readKoscomConfig({
      KOSCOM_ORDERBOOK_COLLECTION_ENABLED: 'false',
      KOSCOM_CALL_METRICS_ENABLED: '0',
      KOSCOM_CYCLE_METRICS_ENABLED: 'FALSE',
      KOSCOM_POLL_LOG_ENABLED: '1',
    });
    expect(config.orderbookCollectionEnabled).toBe(false);
    expect(config.callMetricsEnabled).toBe(false);
    expect(config.cycleMetricsEnabled).toBe(false);
    expect(config.pollLogEnabled).toBe(true);
  });
});

describe('KOSCOM budget governor settings (3c)', () => {
  it('only observes by default, against the provider pool of design §7.1', () => {
    const config = readKoscomConfig({});
    expect(config.budgetEnforcementEnabled).toBe(false);
    expect(config.priceLaneEnabled).toBe(false);
    expect(config.budgetDailyLimit).toBe(50000);
    expect(config.budgetMonthlyLimit).toBe(1000000);
  });

  it('enables enforcement and the lane explicitly and reports an ignored limit', () => {
    const config = readKoscomConfig({
      KOSCOM_BUDGET_ENFORCEMENT_ENABLED: 'true',
      KOSCOM_PRICE_PRIORITY_LANE_ENABLED: '1',
      KOSCOM_BUDGET_DAILY_LIMIT: '40000',
    });
    expect(config.budgetEnforcementEnabled).toBe(true);
    expect(config.priceLaneEnabled).toBe(true);
    expect(config.budgetDailyLimit).toBe(40000);
    expect(koscomConfigWarnings({ KOSCOM_BUDGET_DAILY_LIMIT: '500' })).toEqual([
      {
        setting: 'KOSCOM_BUDGET_DAILY_LIMIT',
        reason: 'out_of_range',
        fallback: 50000,
      },
    ]);
  });
});

describe('KOSCOM setting warnings (F16)', () => {
  it('reports a set but ignored value once with its fallback, never the raw value', () => {
    const warnings = koscomConfigWarnings({
      KOSCOM_POLL_INTERVAL_MS: '777',
      KOSCOM_HTTP_TIMEOUT_MS: 'fast',
      KOSCOM_ORDERBOOK_COLLECTION_ENABLED: 'off',
      KOSCOM_MAX_CONCURRENCY: '3',
    });
    expect(warnings).toEqual([
      {
        setting: 'KOSCOM_POLL_INTERVAL_MS',
        reason: 'out_of_range',
        fallback: 3000,
      },
      { setting: 'KOSCOM_HTTP_TIMEOUT_MS', reason: 'invalid', fallback: 5000 },
      {
        setting: 'KOSCOM_ORDERBOOK_COLLECTION_ENABLED',
        reason: 'invalid',
        fallback: true,
      },
    ]);
    const serialized = JSON.stringify(warnings);
    expect(serialized.includes('777') || serialized.includes('fast')).toBe(
      false,
    );
    // The value itself still falls back exactly as before.
    expect(
      readKoscomConfig({ KOSCOM_POLL_INTERVAL_MS: '777' }).pollIntervalMs,
    ).toBe(3000);
  });

  it('is silent for unset, blank and in-range values', () => {
    expect(
      koscomConfigWarnings({
        KOSCOM_POLL_INTERVAL_MS: '',
        KOSCOM_HTTP_TIMEOUT_MS: '2500',
        KOSCOM_POLL_LOG_ENABLED: 'true',
      }),
    ).toEqual([]);
  });
});

describe('KOSCOM price loop ownership (2d)', () => {
  const enabled = {
    KOSCOM_API_KEY: 'k',
    PROVIDER_INGESTION_ENABLED: 'true',
    KOSCOM_POLLING_ENABLED: 'true',
  };
  it('is the live supervisor only in legacy mode', () => {
    expect(
      isKoscomPollingOwnedByLiveSupervisor(readKoscomConfig(enabled)),
    ).toBe(true);
    expect(
      isKoscomPollingOwnedByLiveSupervisor(
        readKoscomConfig({ ...enabled, KOSCOM_PRICE_SLOT_ENABLED: 'true' }),
      ),
    ).toBe(false);
    expect(
      isKoscomPollingOwnedByLiveSupervisor(
        readKoscomConfig({ ...enabled, KOSCOM_POLLING_ENABLED: 'false' }),
      ),
    ).toBe(false);
  });
});
