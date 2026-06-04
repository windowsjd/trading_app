import {
  presentLimitPriceSource,
  presentSourceDecision,
} from './source-metadata.presenter';

describe('source metadata presenter', () => {
  it('formats source decisions as public-safe metadata', () => {
    expect(
      presentSourceDecision({
        selectedSourceType: 'provider_api',
        selectedSourceName: 'exchange_rate_api',
        selectedSnapshotId: 'fx-snapshot-1',
        selectedEffectiveAt: new Date('2026-06-03T00:00:00.000Z'),
        selectedCapturedAt: new Date('2026-06-03T00:00:10.000Z'),
        fallbackUsed: false,
        fallbackReason: null,
        rejectedProviderReason: null,
        freshnessAgeSeconds: 12,
      }),
    ).toEqual({
      sourceType: 'provider_api',
      sourceName: 'exchange_rate_api',
      snapshotId: 'fx-snapshot-1',
      effectiveAt: '2026-06-03T00:00:00.000Z',
      capturedAt: '2026-06-03T00:00:10.000Z',
      fallbackUsed: false,
      fallbackReason: null,
      rejectedProviderReason: null,
      freshnessAgeSeconds: 12,
    });
  });

  it('keeps fallback rejection reasons without exposing raw secret-like strings', () => {
    const metadata = presentSourceDecision({
      selectedSourceType: 'admin_manual',
      selectedSourceName: 'access_token=secret-value',
      selectedSnapshotId: 'postgres://user:pass@localhost/db',
      selectedEffectiveAt: new Date('2026-06-03T00:00:00.000Z'),
      selectedCapturedAt: new Date('2026-06-03T00:00:10.000Z'),
      fallbackUsed: true,
      fallbackReason: 'provider_rejected',
      rejectedProviderReason: 'captured_at_stale',
      freshnessAgeSeconds: 301,
    });

    expect(metadata).toMatchObject({
      sourceType: 'admin_manual',
      sourceName: null,
      snapshotId: null,
      fallbackUsed: true,
      fallbackReason: 'provider_rejected',
      rejectedProviderReason: 'captured_at_stale',
      freshnessAgeSeconds: 301,
    });
    expect(JSON.stringify(metadata)).not.toContain('secret-value');
    expect(JSON.stringify(metadata)).not.toContain('postgres://');
  });

  it('represents limit-price quotes without a market snapshot source', () => {
    expect(presentLimitPriceSource()).toEqual({
      sourceType: null,
      sourceName: null,
      snapshotId: null,
      effectiveAt: null,
      capturedAt: null,
      fallbackUsed: false,
      fallbackReason: 'limit_price_provided',
      rejectedProviderReason: null,
      freshnessAgeSeconds: null,
    });
  });
});
