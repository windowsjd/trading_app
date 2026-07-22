jest.mock('../generated/prisma/client', () => ({
  OpsJobName: {
    provider_fx_ingest: 'provider_fx_ingest',
    provider_binance_ingest: 'provider_binance_ingest',
    provider_kis_ingest: 'provider_kis_ingest',
    daily_portfolio_snapshot: 'daily_portfolio_snapshot',
    season_ranking_generation: 'season_ranking_generation',
    season_lifecycle_transition: 'season_lifecycle_transition',
    season_settlement: 'season_settlement',
    reward_marker: 'reward_marker',
    market_candle_retention: 'market_candle_retention',
    market_candle_sync: 'market_candle_sync',
    market_candle_reconciliation: 'market_candle_reconciliation',
    limit_order_matcher: 'limit_order_matcher',
    limit_order_candle_reconciliation: 'limit_order_candle_reconciliation',
  },
}));

import { validateEnv } from './env-validation';

const DATABASE_URL = 'postgresql://user:pw@localhost:5432/db?schema=public';
const REDIS_URL = 'redis://localhost:6379';

/** Everything off: the documented production default. */
const BASE = { DATABASE_URL, REDIS_URL } as Record<string, unknown>;

function expectError(config: Record<string, unknown>, fragment: string): void {
  try {
    validateEnv(config);
    throw new Error(`Expected validateEnv to reject: ${fragment}`);
  } catch (error) {
    expect((error as Error).message).toContain(fragment);
  }
}

describe('validateEnv limit-order flags', () => {
  it('accepts a deployment with every limit-order flag absent', () => {
    // The default posture: all three flags off, nothing required.
    expect(() => validateEnv({ ...BASE })).not.toThrow();
    expect(() => validateEnv({})).not.toThrow();
  });

  it.each([
    'LIMIT_ORDER_ENABLED',
    'LIMIT_ORDER_AUTO_EXECUTION_ENABLED',
    'LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED',
    'LIMIT_ORDER_SHARED_READINESS_ENABLED',
  ])('rejects a typo in %s instead of reading it as off', (name) => {
    // Silently disabling a flag the operator believed they had set is exactly
    // the failure this guards against.
    for (const value of ['yes', 'enabled', 'tru', '', 'off']) {
      expect(() => validateEnv({ ...BASE, [name]: value })).toThrow();
    }
  });

  it.each(['true', 'false', '1', '0', ' TRUE ', 'False'])(
    'accepts the boolean spelling %s',
    (value) => {
      expect(() =>
        validateEnv({ ...BASE, LIMIT_ORDER_ENABLED: value }),
      ).not.toThrow();
    },
  );

  it('requires Redis for path A', () => {
    expectError(
      { DATABASE_URL, LIMIT_ORDER_AUTO_EXECUTION_ENABLED: 'true' },
      'requires REDIS_URL',
    );
  });

  it('requires a database URL for the path-A boundary pool', () => {
    expectError(
      { REDIS_URL, LIMIT_ORDER_AUTO_EXECUTION_ENABLED: 'true' },
      'match-boundary connection pool',
    );
  });

  it('requires path A for path B', () => {
    expectError(
      {
        ...BASE,
        LIMIT_ORDER_AUTO_EXECUTION_ENABLED: 'false',
        LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED: 'true',
      },
      'requires LIMIT_ORDER_AUTO_EXECUTION_ENABLED=true',
    );
  });

  it('requires path A for shared readiness', () => {
    expectError(
      {
        ...BASE,
        LIMIT_ORDER_AUTO_EXECUTION_ENABLED: 'false',
        LIMIT_ORDER_SHARED_READINESS_ENABLED: 'true',
      },
      'LIMIT_ORDER_SHARED_READINESS_ENABLED=true requires LIMIT_ORDER_AUTO_EXECUTION_ENABLED=true',
    );
  });

  it('requires Redis for shared readiness', () => {
    expectError(
      {
        DATABASE_URL,
        LIMIT_ORDER_AUTO_EXECUTION_ENABLED: 'true',
        LIMIT_ORDER_SHARED_READINESS_ENABLED: 'true',
      },
      'LIMIT_ORDER_SHARED_READINESS_ENABLED=true requires REDIS_URL',
    );
  });

  it('accepts the full path A + path B + shared readiness combination', () => {
    expect(() =>
      validateEnv({
        ...BASE,
        LIMIT_ORDER_ENABLED: 'true',
        LIMIT_ORDER_AUTO_EXECUTION_ENABLED: 'true',
        LIMIT_ORDER_CANDLE_RECONCILIATION_ENABLED: 'true',
        LIMIT_ORDER_SHARED_READINESS_ENABLED: 'true',
      }),
    ).not.toThrow();
  });

  it('rejects a shared-readiness TTL that cannot outlive two heartbeats', () => {
    // A TTL at or below the publish cadence would expire the record between
    // heartbeats and make a healthy owner look absent.
    expectError(
      {
        ...BASE,
        LIMIT_ORDER_AUTO_EXECUTION_ENABLED: 'true',
        LIMIT_ORDER_SHARED_READINESS_ENABLED: 'true',
        LIMIT_ORDER_SHARED_READINESS_TTL_SECONDS: '5',
        LIMIT_ORDER_SHARED_READINESS_PUBLISH_INTERVAL_MS: '5000',
      },
      'must exceed twice',
    );
  });

  it('rejects a Binance stream cap outside the connection limit', () => {
    expectError(
      { ...BASE, CANDLE_LIVE_MAX_PROVIDER_STREAMS_PER_SHARD: '2048' },
      'CANDLE_LIVE_MAX_PROVIDER_STREAMS_PER_SHARD',
    );
    expectError(
      { ...BASE, CANDLE_LIVE_MAX_PROVIDER_STREAMS_PER_SHARD: '0' },
      'CANDLE_LIVE_MAX_PROVIDER_STREAMS_PER_SHARD',
    );
  });

  it('accepts the 1024-stream boundary value', () => {
    expect(() =>
      validateEnv({
        ...BASE,
        CANDLE_LIVE_MAX_PROVIDER_STREAMS_PER_SHARD: '1024',
      }),
    ).not.toThrow();
  });

  it('reports every violation at once rather than only the first', () => {
    try {
      validateEnv({
        LIMIT_ORDER_ENABLED: 'nope',
        LIMIT_ORDER_AUTO_EXECUTION_ENABLED: 'true',
      });
      throw new Error('expected a rejection');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('LIMIT_ORDER_ENABLED');
      expect(message).toContain('REDIS_URL');
    }
  });
});
