import {
  AdRewardConfigError,
  readAdRewardConfig,
  resolveAdRewardDayStart,
} from './ad-reward.config';

/**
 * The ad-reward policy values are NOT decided yet, so the contract under test
 * is: disabled by default, and with enabled=true every operational value is
 * required and strictly validated. No product default may ever be invented
 * here.
 */
describe('readAdRewardConfig', () => {
  const validEnv = {
    AD_REWARD_ENABLED: 'true',
    AD_REWARD_PROVIDER: 'test-provider',
    AD_REWARD_AMOUNT_KRW: '50000',
    AD_REWARD_DAILY_MAX_COUNT: '5',
    AD_REWARD_DAILY_MAX_AMOUNT_KRW: '250000',
    AD_REWARD_COOLDOWN_SECONDS: '300',
    AD_REWARD_DAY_TIME_ZONE: 'Asia/Seoul',
  } satisfies NodeJS.ProcessEnv;

  it('defaults to disabled when AD_REWARD_ENABLED is absent', () => {
    expect(readAdRewardConfig({})).toEqual({ enabled: false });
  });

  it('defaults to disabled when AD_REWARD_ENABLED is empty', () => {
    expect(readAdRewardConfig({ AD_REWARD_ENABLED: '  ' })).toEqual({
      enabled: false,
    });
  });

  it('ignores the other variables entirely while disabled', () => {
    expect(
      readAdRewardConfig({
        AD_REWARD_ENABLED: 'false',
        AD_REWARD_AMOUNT_KRW: 'not-a-number',
        AD_REWARD_DAY_TIME_ZONE: 'Nowhere/Nothing',
      }),
    ).toEqual({ enabled: false });
  });

  it('rejects a non-boolean enabled value instead of guessing', () => {
    expect(() => readAdRewardConfig({ AD_REWARD_ENABLED: 'yes' })).toThrow(
      AdRewardConfigError,
    );
  });

  it('reads a fully specified enabled configuration', () => {
    expect(readAdRewardConfig(validEnv)).toEqual({
      enabled: true,
      provider: 'test-provider',
      rewardAmountKrw: '50000.00000000',
      dailyMaxCount: 5,
      dailyMaxAmountKrw: '250000.00000000',
      cooldownSeconds: 300,
      dayTimeZone: 'Asia/Seoul',
    });
  });

  it.each([
    'AD_REWARD_PROVIDER',
    'AD_REWARD_AMOUNT_KRW',
    'AD_REWARD_DAILY_MAX_COUNT',
    'AD_REWARD_DAILY_MAX_AMOUNT_KRW',
    'AD_REWARD_COOLDOWN_SECONDS',
    'AD_REWARD_DAY_TIME_ZONE',
  ])('requires %s when enabled (no product default)', (key) => {
    const env = { ...validEnv } as Record<string, string>;
    delete env[key];
    expect(() => readAdRewardConfig(env)).toThrow(AdRewardConfigError);
  });

  it('rejects a zero or negative reward amount', () => {
    expect(() =>
      readAdRewardConfig({ ...validEnv, AD_REWARD_AMOUNT_KRW: '0' }),
    ).toThrow(AdRewardConfigError);
    expect(() =>
      readAdRewardConfig({ ...validEnv, AD_REWARD_AMOUNT_KRW: '-1' }),
    ).toThrow(AdRewardConfigError);
  });

  it('rejects a non-positive daily count', () => {
    expect(() =>
      readAdRewardConfig({ ...validEnv, AD_REWARD_DAILY_MAX_COUNT: '0' }),
    ).toThrow(AdRewardConfigError);
    expect(() =>
      readAdRewardConfig({ ...validEnv, AD_REWARD_DAILY_MAX_COUNT: '2.5' }),
    ).toThrow(AdRewardConfigError);
  });

  it('rejects a daily amount cap below one reward (nothing could ever pay out)', () => {
    expect(() =>
      readAdRewardConfig({
        ...validEnv,
        AD_REWARD_AMOUNT_KRW: '50000',
        AD_REWARD_DAILY_MAX_AMOUNT_KRW: '49999.99999999',
      }),
    ).toThrow(AdRewardConfigError);
  });

  it('accepts a daily amount cap exactly equal to one reward', () => {
    const config = readAdRewardConfig({
      ...validEnv,
      AD_REWARD_DAILY_MAX_AMOUNT_KRW: '50000',
    });
    expect(config).toMatchObject({ dailyMaxAmountKrw: '50000.00000000' });
  });

  it('accepts a zero cooldown but rejects a negative one', () => {
    expect(
      readAdRewardConfig({ ...validEnv, AD_REWARD_COOLDOWN_SECONDS: '0' }),
    ).toMatchObject({ cooldownSeconds: 0 });
    expect(() =>
      readAdRewardConfig({ ...validEnv, AD_REWARD_COOLDOWN_SECONDS: '-5' }),
    ).toThrow(AdRewardConfigError);
  });

  it('rejects an invalid IANA timezone', () => {
    expect(() =>
      readAdRewardConfig({
        ...validEnv,
        AD_REWARD_DAY_TIME_ZONE: 'Asia/Seoulll',
      }),
    ).toThrow(AdRewardConfigError);
  });

  it('normalizes decimal amounts to scale 8', () => {
    expect(
      readAdRewardConfig({ ...validEnv, AD_REWARD_AMOUNT_KRW: '1234.5' }),
    ).toMatchObject({ rewardAmountKrw: '1234.50000000' });
  });
});

describe('resolveAdRewardDayStart', () => {
  it('uses the CONFIGURED zone, not the server timezone', () => {
    // 2026-08-03T00:30:00Z is 09:30 on 2026-08-03 in Seoul, so the Seoul day
    // starts at 2026-08-02T15:00:00Z while the UTC day starts at midnight UTC.
    const now = new Date('2026-08-03T00:30:00.000Z');
    expect(resolveAdRewardDayStart(now, 'Asia/Seoul').toISOString()).toBe(
      '2026-08-02T15:00:00.000Z',
    );
    expect(resolveAdRewardDayStart(now, 'UTC').toISOString()).toBe(
      '2026-08-03T00:00:00.000Z',
    );
  });

  it('moves to the next day exactly at the zone midnight boundary', () => {
    const beforeMidnight = new Date('2026-08-03T14:59:59.000Z');
    const afterMidnight = new Date('2026-08-03T15:00:00.000Z');
    expect(
      resolveAdRewardDayStart(beforeMidnight, 'Asia/Seoul').toISOString(),
    ).toBe('2026-08-02T15:00:00.000Z');
    expect(
      resolveAdRewardDayStart(afterMidnight, 'Asia/Seoul').toISOString(),
    ).toBe('2026-08-03T15:00:00.000Z');
  });

  it('resolves a DST zone boundary to a real local midnight', () => {
    // New York is UTC-4 in August.
    const now = new Date('2026-08-03T12:00:00.000Z');
    expect(resolveAdRewardDayStart(now, 'America/New_York').toISOString()).toBe(
      '2026-08-03T04:00:00.000Z',
    );
  });
});
