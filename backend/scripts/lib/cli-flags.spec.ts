import { parseApplyDryRunFlags } from './cli-flags';

describe('parseApplyDryRunFlags', () => {
  it('defaults to dry-run when neither flag is given (never writes by default)', () => {
    const parsed = parseApplyDryRunFlags([]);
    expect(parsed.mode).toBe('dry-run');
    expect(parsed.apply).toBe(false);
    expect(parsed.dryRun).toBe(false);
  });

  it('treats --apply as write mode', () => {
    expect(parseApplyDryRunFlags(['--apply']).mode).toBe('apply');
  });

  it('treats explicit --dry-run as dry-run', () => {
    const parsed = parseApplyDryRunFlags(['--dry-run']);
    expect(parsed.mode).toBe('dry-run');
    expect(parsed.dryRun).toBe(true);
  });

  it('rejects --apply and --dry-run together as a validation error', () => {
    expect(() => parseApplyDryRunFlags(['--apply', '--dry-run'])).toThrow(
      /cannot be combined/,
    );
  });

  it('rejects unknown flags (typo protection)', () => {
    expect(() => parseApplyDryRunFlags(['--aply'])).toThrow(/Unknown option/);
  });

  it('only accepts --skip-provider-validation when explicitly allowed', () => {
    expect(() => parseApplyDryRunFlags(['--skip-provider-validation'])).toThrow(
      /Unknown option/,
    );

    const parsed = parseApplyDryRunFlags(['--skip-provider-validation'], {
      allowSkipProviderValidation: true,
    });
    expect(parsed.skipProviderValidation).toBe(true);
  });
});
