import { pushNotificationsConfig } from './push-notifications.config';

describe('pushNotificationsConfig', () => {
  it('is off, sending (not dry run) and 10 s by default', () => {
    const config = pushNotificationsConfig({});
    expect(config.enabled).toBe(false);
    expect(config.dryRun).toBe(false);
    expect(config.intervalMs).toBe(10_000);
    expect(config.accessToken).toBe(null);
    expect(config.sendChunkSize).toBe(100);
    expect(config.receiptChunkSize).toBe(1_000);
  });

  it('accepts only exact booleans', () => {
    expect(
      pushNotificationsConfig({ PUSH_NOTIFICATIONS_ENABLED: 'true' }).enabled,
    ).toBe(true);
    expect(() =>
      pushNotificationsConfig({ PUSH_NOTIFICATIONS_ENABLED: 'yes' }),
    ).toThrow('PUSH_NOTIFICATIONS_ENABLED must be true or false');
    expect(() =>
      pushNotificationsConfig({ PUSH_NOTIFICATIONS_DRY_RUN: '1' }),
    ).toThrow('PUSH_NOTIFICATIONS_DRY_RUN must be true or false');
  });

  it('bounds the interval', () => {
    expect(
      pushNotificationsConfig({ PUSH_NOTIFICATIONS_INTERVAL_MS: '5000' })
        .intervalMs,
    ).toBe(5000);
    for (const value of ['1999', '300001', '10s', '-1'])
      expect(() =>
        pushNotificationsConfig({ PUSH_NOTIFICATIONS_INTERVAL_MS: value }),
      ).toThrow('PUSH_NOTIFICATIONS_INTERVAL_MS');
  });

  it('never echoes the access token in an error', () => {
    let message = '';
    try {
      pushNotificationsConfig({ EXPO_ACCESS_TOKEN: 'abc secret' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe('EXPO_ACCESS_TOKEN must not contain whitespace');
    expect(
      pushNotificationsConfig({ EXPO_ACCESS_TOKEN: 'tok' }).accessToken,
    ).toBe('tok');
  });
});
