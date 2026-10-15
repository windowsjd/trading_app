import { parseCandleBaselineArgs } from './candle-baseline-args';

describe('candle baseline operator arguments', () => {
  it('keeps the existing 5m-only default', () => {
    expect(parseCandleBaselineArgs([]).targets).toEqual(['5m']);
  });

  it('accepts only the explicitly repeated persisted feed targets', () => {
    const args = parseCandleBaselineArgs([
      '--dry-run',
      '--days',
      '365',
      '--target',
      '1d',
      '--target',
      '1w',
      '--asset-id',
      'samsung-asset-id',
      '--asset-id',
      'kia-asset-id',
    ]);

    expect(args).toMatchObject({
      apply: false,
      days: 365,
      targets: ['1d', '1w'],
      assetIds: ['samsung-asset-id', 'kia-asset-id'],
    });
  });

  it('allows the KRX 576-session daily backfill window and nothing wider', () => {
    expect(
      parseCandleBaselineArgs(['--days', '875', '--target', '1d']).days,
    ).toBe(875);
    expect(() => parseCandleBaselineArgs(['--days', '901'])).toThrow(
      '--days must be an integer between 1 and 900.',
    );
  });

  it('includes inactive assets only for explicitly named assets (pre-activation backfill)', () => {
    expect(parseCandleBaselineArgs([]).includeInactive).toBe(false);
    expect(
      parseCandleBaselineArgs([
        '--include-inactive',
        '--asset-id',
        'next-cohort-asset',
      ]).includeInactive,
    ).toBe(true);
    expect(() => parseCandleBaselineArgs(['--include-inactive'])).toThrow(
      '--include-inactive requires explicit --asset-id values.',
    );
  });

  it('rejects unsupported feeds and non-5m reports', () => {
    expect(() => parseCandleBaselineArgs(['--target', '15m'])).toThrow(
      '--target must be 5m, 1d, or 1w.',
    );
    expect(() =>
      parseCandleBaselineArgs(['--report', '--target', '1d']),
    ).toThrow('--report only supports the 5m baseline.');
  });
});
