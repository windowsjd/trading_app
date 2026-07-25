import { parseRecoveryArgs } from './recovery-args';

describe('parseRecoveryArgs', () => {
  it('defaults to dry-run with no market bootstrap', () => {
    const parsed = parseRecoveryArgs([]);
    expect(parsed.flags.mode).toBe('dry-run');
    expect(parsed.ensureMarketSnapshots).toBe(false);
    expect(parsed.operatorEmail).toBeUndefined();
  });

  it('parses --apply --ensure-market-snapshots with a spaced operator email', () => {
    const parsed = parseRecoveryArgs([
      '--apply',
      '--ensure-market-snapshots',
      '--operator-email',
      'ops@example.com',
    ]);
    expect(parsed.flags.apply).toBe(true);
    expect(parsed.ensureMarketSnapshots).toBe(true);
    expect(parsed.operatorEmail).toBe('ops@example.com');
  });

  it('supports inline --operator-user-id=<id>', () => {
    const parsed = parseRecoveryArgs(['--apply', '--operator-user-id=usr_1']);
    expect(parsed.operatorUserId).toBe('usr_1');
  });

  it('still rejects --apply and --dry-run together', () => {
    expect(() => parseRecoveryArgs(['--apply', '--dry-run'])).toThrow(
      /cannot be combined/,
    );
  });

  it('still rejects unknown flags after stripping recovery flags', () => {
    expect(() => parseRecoveryArgs(['--apply', '--bogus'])).toThrow(
      /Unknown option/,
    );
  });

  it('errors when an operator flag is missing its value', () => {
    expect(() => parseRecoveryArgs(['--operator-email'])).toThrow(
      /Missing value/,
    );
  });

  it('passes --skip-provider-validation through to the flags', () => {
    expect(
      parseRecoveryArgs(['--apply', '--skip-provider-validation']).flags
        .skipProviderValidation,
    ).toBe(true);
  });
});
