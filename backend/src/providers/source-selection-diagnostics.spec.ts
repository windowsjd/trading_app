jest.mock('../generated/prisma/client', () => {
  const { Decimal } = jest.requireActual('@prisma/client/runtime/client');

  return {
    AssetPriceSourceType: {
      official_batch: 'official_batch',
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
    },
    AssetType: {
      domestic_stock: 'domestic_stock',
      us_stock: 'us_stock',
      crypto: 'crypto',
    },
    CurrencyCode: {
      KRW: 'KRW',
      USD: 'USD',
    },
    FxRateSourceType: {
      official_batch: 'official_batch',
      provider_api: 'provider_api',
      admin_manual: 'admin_manual',
    },
    Prisma: {
      Decimal,
    },
  };
});

import { Prisma, CurrencyCode, AssetType } from '../generated/prisma/client';
import {
  buildSelectionFailureEvidence,
  describeManualFallback,
} from './source-selection-diagnostics';
import {
  resolveFxProviderEligibility,
  resolveAssetProviderEligibility,
  selectFreshProviderSnapshotBySourcePriority,
  selectMarketAwareAssetPriceSnapshotBySourcePriority,
  PROVIDER_SOURCE_NAMES,
  type ProviderWorkflow,
} from './source-eligibility.policy';
import {
  adminDiagnosticRequestMiddleware,
  buildAdminPartialFailureDiagnostic,
  setAdminDiagnosticContext,
} from '../common/admin-diagnostics';

const now = new Date('2026-07-20T00:10:00Z');
const candidate = (overrides = {}) => ({
  id: 'snapshot-safe',
  sourceType: 'provider_api',
  sourceName: PROVIDER_SOURCE_NAMES.fxUsdKrwKoreaExim as string,
  effectiveAt: new Date(now.getTime() - 1842000),
  capturedAt: new Date(now.getTime() - 1842000),
  rate: new Prisma.Decimal('1379.12345678'),
  price: new Prisma.Decimal('91827.98765432'),
  rawPayload: { apiKey: 'synthetic-provider-key' },
  providerResponseBody: 'synthetic-raw-body',
  ...overrides,
});
const missingManual = describeManualFallback({
  snapshot: null,
  evaluationAt: now,
  queryChecks: ['approved', 'positive_value', 'effective_at_lte_evaluation'],
});
function fxEvidence(
  rows: ReturnType<typeof candidate>[],
  workflow: ProviderWorkflow = 'orders_quote',
) {
  const eligibility = resolveFxProviderEligibility({
    workflow,
    baseCurrency: CurrencyCode.USD,
    quoteCurrency: CurrencyCode.KRW,
  });
  if (!eligibility.eligible) throw new Error('Invalid test workflow');
  const selection = selectFreshProviderSnapshotBySourcePriority({
    candidates: rows,
    expectedSourceNames: eligibility.sourceNames,
    now,
    freshnessThresholdSeconds: eligibility.freshnessThresholdSeconds,
    isPositiveValue: (row) => row.rate.gt(0),
  });
  return buildSelectionFailureEvidence({
    workflow,
    evaluationAt: now,
    eligibility,
    candidates: rows,
    selection,
    isPositiveValue: (row) => row.rate.gt(0),
    manualFallback: missingManual,
  });
}

describe('selection failure evidence', () => {
  it('distinguishes first source stale, second missing and a filtered manual miss without raw values', () => {
    const evidence = fxEvidence([candidate()]);
    expect(evidence).toMatchObject({
      workflow: 'orders_quote',
      freshnessThresholdSeconds: 300,
      providerCandidates: [
        {
          sourceName: PROVIDER_SOURCE_NAMES.fxUsdKrwKoreaExim,
          candidateFound: true,
          ageSeconds: 1842,
          positiveValue: true,
          reason: 'captured_at_stale',
        },
        {
          sourceName: PROVIDER_SOURCE_NAMES.fxUsdKrwExchangeRateApi,
          candidateFound: false,
          reason: 'provider_missing',
        },
      ],
      manualFallback: {
        lookupPerformed: true,
        eligibleQueryCandidateFound: false,
        unqueriedCandidates: 'not_observed',
      },
      finalSelectionResult: 'NO_ELIGIBLE_SNAPSHOT',
    });
    expect(JSON.stringify(evidence)).not.toMatch(
      /1379\.12345678|91827\.98765432|synthetic-provider-key|synthetic-raw-body|rawPayload|providerResponseBody/,
    );
  });
  it('preserves every expected missing source, priority and all observed rejection reasons', () => {
    expect(fxEvidence([]).providerCandidates).toHaveLength(2);
    const evidence = fxEvidence([
      candidate(),
      candidate({ id: 'negative', rate: new Prisma.Decimal(0) }),
    ]);
    expect(evidence.providerCandidates[0]).toMatchObject({
      observedCandidateCount: 2,
      rejectedReasons: ['captured_at_stale', 'non_positive_value'],
    });
  });
  it.each([
    [{ sourceName: 'wrong-source' }, 'source_name_mismatch'],
    [{ sourceType: 'official_batch' }, 'source_type_mismatch'],
    [{ rate: new Prisma.Decimal(0) }, 'non_positive_value'],
    [{ effectiveAt: new Date(now.getTime() + 1000) }, 'effective_at_in_future'],
    [{ capturedAt: new Date(now.getTime() + 1000) }, 'captured_at_in_future'],
  ])('preserves the real selector reason for %j', (patch, reason) => {
    const evidence = fxEvidence([candidate(patch)]);
    expect(
      evidence.providerCandidates.find((row) => row.candidateFound),
    ).toMatchObject({ reason });
  });
  it('uses actual workflow overrides, and execute keeps its stricter policy', () => {
    const old = process.env.PROVIDER_FX_RATE_QUOTE_FRESHNESS_SECONDS;
    process.env.PROVIDER_FX_RATE_QUOTE_FRESHNESS_SECONDS = '420';
    try {
      const row = candidate({
        effectiveAt: new Date(now.getTime() - 120000),
        capturedAt: new Date(now.getTime() - 120000),
      });
      expect(fxEvidence([row], 'fx_quote')).toMatchObject({
        freshnessThresholdSeconds: 420,
        providerCandidates: [{ result: 'selected' }, {}],
      });
      expect(fxEvidence([row], 'fx_execute')).toMatchObject({
        freshnessThresholdSeconds: 60,
        providerCandidates: [
          { result: 'not_selected', reason: 'captured_at_stale' },
          {},
        ],
      });
    } finally {
      if (old === undefined)
        delete process.env.PROVIDER_FX_RATE_QUOTE_FRESHNESS_SECONDS;
      else process.env.PROVIDER_FX_RATE_QUOTE_FRESHNESS_SECONDS = old;
    }
  });
  it.each([
    [
      '2026-07-20T00:10:00Z',
      '2026-07-16T06:29:00Z',
      'assets_with_price',
      'effective_at_outside_current_session',
    ],
    [
      '2026-07-17T03:00:00Z',
      '2026-07-15T06:29:00Z',
      'assets_with_price',
      'effective_at_outside_last_completed_session',
    ],
    [
      '2026-07-17T03:00:00Z',
      '2026-07-16T06:29:00Z',
      'orders_quote',
      'market_closed',
    ],
    [
      '2030-07-17T03:00:00Z',
      '2026-07-16T06:29:00Z',
      'assets_with_price',
      'market_calendar_unavailable',
    ],
  ] as const)(
    'keeps market reason %s %s %s',
    (time, effective, workflow, reason) => {
      const evaluationAt = new Date(time);
      const asset = {
        assetType: AssetType.domestic_stock,
        market: 'KRX',
        currencyCode: CurrencyCode.KRW,
      };
      const eligibility = resolveAssetProviderEligibility({ workflow, asset });
      if (!eligibility.eligible) throw new Error('Invalid test asset');
      const row = candidate({
        sourceName: PROVIDER_SOURCE_NAMES.domesticStockKrx,
        effectiveAt: new Date(effective),
      });
      const selection = selectMarketAwareAssetPriceSnapshotBySourcePriority({
        asset,
        workflow,
        candidates: [row],
        expectedSourceNames: eligibility.sourceNames,
        now: evaluationAt,
        freshnessThresholdSeconds: eligibility.freshnessThresholdSeconds,
        isPositiveValue: () => true,
      });
      const evidence = buildSelectionFailureEvidence({
        asset,
        workflow,
        evaluationAt,
        eligibility,
        candidates: [row],
        selection,
        isPositiveValue: () => true,
        manualFallback: missingManual,
      });
      expect(evidence.providerCandidates[0]).toMatchObject({ reason });
      expect(evidence.marketSession).not.toBeNull();
      if (reason.includes('last_completed'))
        expect(evidence.freshnessBasis).toBe('last_completed_session');
    },
  );
  it('reports ineligible workflow without inventing queried candidates', () => {
    const eligibility = resolveFxProviderEligibility({
      workflow: 'orders_create',
      baseCurrency: CurrencyCode.USD,
      quoteCurrency: CurrencyCode.KRW,
    });
    const evidence = buildSelectionFailureEvidence({
      workflow: 'orders_create',
      evaluationAt: now,
      eligibility,
      candidates: [],
      selection: null,
      isPositiveValue: () => false,
      manualFallback: missingManual,
    });
    expect(evidence).toMatchObject({
      eligibilityReason: 'workflow_ineligible',
      expectedSourceNames: [],
      providerCandidates: [],
      freshnessThresholdSeconds: null,
    });
  });
  it.each(['admin', 'user', 'operator', undefined])(
    'keeps local evidence, bounds and role %s at the final diagnostic gate',
    async (role) => {
      let pending!: Promise<unknown[]>;
      adminDiagnosticRequestMiddleware(
        {
          method: 'GET',
          originalUrl: '/api/v1/assets?privateQuery=synthetic-secret',
          headers: {},
          ...(role ? { user: { role } } : {}),
        } as never,
        { setHeader: jest.fn() } as never,
        () => {
          setAdminDiagnosticContext({
            evidence: { shared: 'other-row-secret' },
          });
          pending = Promise.all(
            ['a', 'b'].map(async (id) => {
              await Promise.resolve();
              return buildAdminPartialFailureDiagnostic(
                new Error('FX rate unavailable'),
                'FX_RATE_UNAVAILABLE',
                {
                  entities: { assetId: id },
                  evidence: fxEvidence([candidate({ id: `snapshot-${id}` })]),
                },
              );
            }),
          );
        },
      );
      const result = await pending;
      if (role !== 'admin') {
        expect(result).toEqual([undefined, undefined]);
        return;
      }
      const serialized = JSON.stringify(result);
      expect(serialized).not.toMatch(
        /other-row-secret|privateQuery|synthetic-|1379\.12345678|91827\.98765432|TRUNCATED_DEPTH/,
      );
      result.forEach((item, i) => {
        expect(Buffer.byteLength(JSON.stringify(item))).toBeLessThan(24 * 1024);
        expect(JSON.stringify(item)).not.toContain(
          `snapshot-${i === 0 ? 'b' : 'a'}`,
        );
      });
    },
  );
});
