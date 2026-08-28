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

  it('rejects unsupported feeds and non-5m reports', () => {
    expect(() => parseCandleBaselineArgs(['--target', '15m'])).toThrow(
      '--target must be 5m, 1d, or 1w.',
    );
    expect(() =>
      parseCandleBaselineArgs(['--report', '--target', '1d']),
    ).toThrow('--report only supports the 5m baseline.');
  });
});
