import {
  readKisRateLimitConfig,
  DEFAULT_KIS_REAL_REST_MIN_INTERVAL_MS,
  DEFAULT_KIS_VIRTUAL_REST_MIN_INTERVAL_MS,
} from './kis-rate-limit.config';
import { KisRateLimitConfigError } from './kis-rate-limit.types';

describe('KIS rate-limit config', () => {
  it('uses conservative real and virtual defaults', () => {
    expect(readKisRateLimitConfig({}).restMinIntervalMs).toBe(
      DEFAULT_KIS_REAL_REST_MIN_INTERVAL_MS,
    );
    expect(
      readKisRateLimitConfig({ KIS_API_ENVIRONMENT: 'virtual' })
        .restMinIntervalMs,
    ).toBe(DEFAULT_KIS_VIRTUAL_REST_MIN_INTERVAL_MS);
    expect(readKisRateLimitConfig({}).oauthMinIntervalMs).toBe(1000);
  });

  it.each([
    [{ KIS_API_ENVIRONMENT: 'real', KIS_REST_MIN_INTERVAL_MS: '55' }],
    [{ KIS_API_ENVIRONMENT: 'virtual', KIS_REST_MIN_INTERVAL_MS: '999' }],
    [{ KIS_OAUTH_MIN_INTERVAL_MS: '999' }],
    [{ KIS_API_ENVIRONMENT: 'guessed-from-url' }],
  ])('rejects a setting above an official maximum rate', (env) => {
    expect(() => readKisRateLimitConfig(env)).toThrow(KisRateLimitConfigError);
  });

  it('hashes the app key and never exposes the original', () => {
    const config = readKisRateLimitConfig({
      KIS_APP_KEY: 'plain-secret-app-key',
    });
    expect(config.appKeyHash).toHaveLength(16);
    expect(JSON.stringify(config)).not.toContain('plain-secret-app-key');
  });
});
