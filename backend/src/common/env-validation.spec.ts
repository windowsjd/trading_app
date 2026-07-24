import { validateEnv } from './env-validation';

const DATABASE_URL = 'postgresql://user:pw@localhost:5432/db?schema=public';
const REDIS_URL = 'redis://localhost:6379';

/** Everything off: the documented production default. */
const BASE = { DATABASE_URL, REDIS_URL } as Record<string, unknown>;

describe('validateEnv limit-order flags', () => {
  it('accepts a deployment with the limit-order flag absent', () => {
    // The default posture: flag off, nothing required.
    expect(() => validateEnv({ ...BASE })).not.toThrow();
    expect(() => validateEnv({})).not.toThrow();
  });

  it('rejects a typo in LIMIT_ORDER_ENABLED instead of reading it as off', () => {
    // Silently disabling a flag the operator believed they had set is exactly
    // the failure this guards against.
    for (const value of ['yes', 'enabled', 'tru', '', 'off']) {
      expect(() =>
        validateEnv({ ...BASE, LIMIT_ORDER_ENABLED: value }),
      ).toThrow();
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

  it('registration does not require Redis: the flag alone never demands infrastructure', () => {
    // Limit-order registration completes against PostgreSQL alone; enabling
    // the feature without REDIS_URL must boot.
    expect(() =>
      validateEnv({ DATABASE_URL, LIMIT_ORDER_ENABLED: 'true' }),
    ).not.toThrow();
  });
});
