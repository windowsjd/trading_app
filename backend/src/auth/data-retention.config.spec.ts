import { dataRetentionConfig } from './data-retention.config';

describe('dataRetentionConfig', () => {
  it('is on with the product retention periods by default', () => {
    expect(dataRetentionConfig({})).toEqual({
      enabled: true,
      sessionDays: 90,
      auditLogDays: 365,
      inquiryDays: 1095,
    });
  });

  it('accepts only exact booleans for the emergency stop', () => {
    expect(
      dataRetentionConfig({ DATA_RETENTION_CLEANUP_ENABLED: 'false' }).enabled,
    ).toBe(false);
    for (const value of ['', 'yes', '0', 'TRUE', ' true'])
      expect(() =>
        dataRetentionConfig({ DATA_RETENTION_CLEANUP_ENABLED: value }),
      ).toThrow('DATA_RETENTION_CLEANUP_ENABLED must be true or false');
  });

  it.each([
    ['AUTH_SESSION_RETENTION_DAYS', 'sessionDays', 30, 365],
    ['OPERATOR_AUDIT_LOG_RETENTION_DAYS', 'auditLogDays', 365, 3650],
    ['INQUIRY_RETENTION_DAYS', 'inquiryDays', 30, 3650],
  ] as const)('bounds %s to %i..%i days', (name, key, min, max) => {
    expect(dataRetentionConfig({ [name]: String(min) })[key]).toBe(min);
    expect(dataRetentionConfig({ [name]: String(max) })[key]).toBe(max);
    for (const value of [String(min - 1), String(max + 1)])
      expect(() => dataRetentionConfig({ [name]: value })).toThrow(
        `${name} must be an integer from ${min} to ${max}`,
      );
  });

  it('refuses an audit log period under the one-year legal minimum', () => {
    expect(() =>
      dataRetentionConfig({ OPERATOR_AUDIT_LOG_RETENTION_DAYS: '364' }),
    ).toThrow('OPERATOR_AUDIT_LOG_RETENTION_DAYS must be an integer from 365');
    expect(
      dataRetentionConfig({ OPERATOR_AUDIT_LOG_RETENTION_DAYS: '730' })
        .auditLogDays,
    ).toBe(730);
  });

  it('parses strict decimal integers only and never echoes the value', () => {
    for (const value of ['', ' 90', '90 ', '90.0', '9e1', '0x5a', '-90', '+90'])
      try {
        dataRetentionConfig({ AUTH_SESSION_RETENTION_DAYS: value });
        throw new Error(`accepted ${JSON.stringify(value)}`);
      } catch (error) {
        expect((error as Error).message).toBe(
          'AUTH_SESSION_RETENTION_DAYS must be an integer from 30 to 365',
        );
      }
  });
});
