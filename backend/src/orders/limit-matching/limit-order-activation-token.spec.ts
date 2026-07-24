import {
  BINANCE_SPOT_TRADE_ROUTE,
  KIS_DOMESTIC_TRADE_ROUTE,
  findCapabilityByRoute,
  type ProviderTradeCapability,
} from '../../providers/provider-trade-capability';
import {
  evaluateEventOrderEligibility,
  parseActivationToken,
  parseProviderSequence,
  type EvaluatedTradeEvent,
  type LimitOrderActivationToken,
} from './limit-order-activation-token';

const binance = findCapabilityByRoute(BINANCE_SPOT_TRADE_ROUTE);
const kisDomestic = findCapabilityByRoute(KIS_DOMESTIC_TRADE_ROUTE);
if (!binance || !kisDomestic) throw new Error('capability fixtures missing');

const baseToken: LimitOrderActivationToken = {
  provider: 'binance',
  route: BINANCE_SPOT_TRADE_ROUTE,
  generation: 'gen-1',
  epoch: 'epoch-1',
  activationMode: 'provider_sequence',
  providerSequence: '1000',
  providerEventAt: null,
  ingressSeq: '5',
  coverageVersion: 'cov-1',
  streamId: '100-0',
};

const baseEvent: EvaluatedTradeEvent = {
  provider: 'binance',
  route: BINANCE_SPOT_TRADE_ROUTE,
  generation: 'gen-1',
  epoch: 'epoch-1',
  providerSequence: '1001',
  providerEventAt: '2026-07-25T00:00:00.000Z',
};

const evalSeq = (
  token: LimitOrderActivationToken | null,
  event: EvaluatedTradeEvent,
) => evaluateEventOrderEligibility({ token, event, capability: binance });

describe('parseProviderSequence', () => {
  it('accepts non-negative integer strings (incl. very large)', () => {
    expect(parseProviderSequence('0')).toBe(0n);
    expect(parseProviderSequence('123')).toBe(123n);
    expect(parseProviderSequence(' 42 ')).toBe(42n);
    expect(parseProviderSequence('99999999999999999999')).toBe(
      99999999999999999999n,
    );
  });
  it('rejects malformed values', () => {
    for (const v of ['', 'abc', '-1', '1.5', '1e3', '0x10', ' ']) {
      expect(parseProviderSequence(v)).toBeNull();
    }
    expect(parseProviderSequence(null)).toBeNull();
  });
});

describe('parseActivationToken', () => {
  it('round-trips a valid provider_sequence token', () => {
    expect(parseActivationToken(baseToken)).not.toBeNull();
  });
  it('rejects a provider_sequence token with no sequence', () => {
    expect(
      parseActivationToken({ ...baseToken, providerSequence: null }),
    ).toBeNull();
  });
  it('rejects a token missing provenance fields', () => {
    expect(parseActivationToken({ ...baseToken, generation: '' })).toBeNull();
    expect(parseActivationToken({ ...baseToken, epoch: undefined })).toBeNull();
    expect(parseActivationToken(null)).toBeNull();
  });
  it('rejects a time-watermark token with an unparseable timestamp', () => {
    expect(
      parseActivationToken({
        ...baseToken,
        activationMode: 'provider_time_watermark',
        providerSequence: null,
        providerEventAt: 'not-a-date',
      }),
    ).toBeNull();
  });
});

describe('provider_sequence eligibility (activation token, §25.B)', () => {
  it('sequence greater → eligible', () => {
    const r = evalSeq(baseToken, { ...baseEvent, providerSequence: '1001' });
    expect(r.eligible).toBe(true);
    if (r.eligible) expect(r.basis).toBe('provider_sequence');
  });

  it('sequence equal → NOT eligible (boundary is exclusive)', () => {
    const r = evalSeq(baseToken, { ...baseEvent, providerSequence: '1000' });
    expect(r).toEqual({
      eligible: false,
      reason: 'sequence_not_after_activation',
    });
  });

  it('sequence lower → NOT eligible', () => {
    const r = evalSeq(baseToken, { ...baseEvent, providerSequence: '999' });
    expect(r).toEqual({
      eligible: false,
      reason: 'sequence_not_after_activation',
    });
  });

  it('generation mismatch → NOT eligible', () => {
    const r = evalSeq(baseToken, { ...baseEvent, generation: 'gen-2' });
    expect(r).toEqual({ eligible: false, reason: 'generation_mismatch' });
  });

  it('epoch mismatch (old owner) → NOT eligible', () => {
    const r = evalSeq(baseToken, { ...baseEvent, epoch: 'epoch-0' });
    expect(r).toEqual({ eligible: false, reason: 'epoch_mismatch' });
  });

  it('route mismatch → NOT eligible', () => {
    const r = evalSeq(baseToken, {
      ...baseEvent,
      route: 'binance:something-else',
    });
    expect(r).toEqual({ eligible: false, reason: 'route_mismatch' });
  });

  it('missing token (legacy order) → fail-closed', () => {
    const r = evalSeq(null, baseEvent);
    expect(r).toEqual({ eligible: false, reason: 'activation_token_missing' });
  });

  it('malformed token (no sequence on a provider_sequence route) → fail-closed', () => {
    const r = evalSeq({ ...baseToken, providerSequence: null }, baseEvent);
    expect(r).toEqual({
      eligible: false,
      reason: 'activation_token_malformed',
    });
  });

  it('malformed event sequence → fail-closed', () => {
    const r = evalSeq(baseToken, { ...baseEvent, providerSequence: 'NaN' });
    expect(r).toEqual({ eligible: false, reason: 'malformed_sequence' });
    const r2 = evalSeq(baseToken, { ...baseEvent, providerSequence: null });
    expect(r2).toEqual({ eligible: false, reason: 'malformed_sequence' });
  });
});

describe('delayed-event defense (§25.C)', () => {
  it('a trade that occurred BEFORE the order (seq ≤ activation) never fills, regardless of arrival', () => {
    // The pre-submission trade carries a lower authoritative sequence even
    // though (in the real world) it is DELIVERED after the order was created.
    const delayed = { ...baseEvent, providerSequence: '1000' };
    expect(evalSeq(baseToken, delayed).eligible).toBe(false);
  });

  it('a trade that occurred AFTER the order (seq > activation) fills', () => {
    const fresh = { ...baseEvent, providerSequence: '1001' };
    expect(evalSeq(baseToken, fresh).eligible).toBe(true);
  });

  it('same provider timestamp, sequence decides ordering', () => {
    const ts = '2026-07-25T00:00:00.000Z';
    const before = {
      ...baseEvent,
      providerEventAt: ts,
      providerSequence: '1000',
    };
    const after = {
      ...baseEvent,
      providerEventAt: ts,
      providerSequence: '1001',
    };
    expect(evalSeq(baseToken, before).eligible).toBe(false);
    expect(evalSeq(baseToken, after).eligible).toBe(true);
  });

  it('provider time present but sequence absent on a sequence route → fail-closed', () => {
    const r = evalSeq(baseToken, {
      ...baseEvent,
      providerSequence: null,
      providerEventAt: '2026-07-25T00:10:00.000Z',
    });
    expect(r.eligible).toBe(false);
  });
});

describe('capability gating', () => {
  it('a Path-B-only route (KIS domestic) never fills on Path A', () => {
    const kisToken: LimitOrderActivationToken = {
      ...baseToken,
      provider: 'kis',
      route: KIS_DOMESTIC_TRADE_ROUTE,
      activationMode: 'path_b_only',
      providerSequence: null,
    };
    const kisEvent: EvaluatedTradeEvent = {
      provider: 'kis',
      route: KIS_DOMESTIC_TRADE_ROUTE,
      generation: 'gen-1',
      epoch: 'epoch-1',
      providerSequence: '1001',
      providerEventAt: '2026-07-25T00:00:00.000Z',
    };
    const r = evaluateEventOrderEligibility({
      token: kisToken,
      event: kisEvent,
      capability: kisDomestic,
    });
    expect(r).toEqual({ eligible: false, reason: 'route_not_path_a' });
  });

  it('a null capability fails closed', () => {
    const r = evaluateEventOrderEligibility({
      token: baseToken,
      event: baseEvent,
      capability: null,
    });
    expect(r).toEqual({ eligible: false, reason: 'route_not_path_a' });
  });
});

describe('provider_time_watermark (hypothetical authoritative-time route)', () => {
  const watermarkCap: ProviderTradeCapability = {
    provider: 'binance',
    route: 'binance:hypothetical-tw',
    sourceName: 'hypothetical',
    supportsAuthoritativeEventId: true,
    supportsMonotonicSequence: false,
    supportsAuthoritativeEventTime: true,
    supportsDocumentedFinality: true,
    supportsReplay: false,
    supportsBoundedDeliveryLag: false,
    maxDocumentedDeliveryLagMs: null,
    pathAExecutionAllowed: true,
    pathBRequired: true,
    activationMode: 'provider_time_watermark',
  };
  const twToken: LimitOrderActivationToken = {
    provider: 'binance',
    route: 'binance:hypothetical-tw',
    generation: 'gen-1',
    epoch: 'epoch-1',
    activationMode: 'provider_time_watermark',
    providerSequence: null,
    providerEventAt: '2026-07-25T00:00:00.000Z',
    ingressSeq: null,
    coverageVersion: null,
    streamId: null,
  };
  const twEvent = (at: string): EvaluatedTradeEvent => ({
    provider: 'binance',
    route: 'binance:hypothetical-tw',
    generation: 'gen-1',
    epoch: 'epoch-1',
    providerSequence: null,
    providerEventAt: at,
  });

  it('event time strictly after watermark → eligible', () => {
    const r = evaluateEventOrderEligibility({
      token: twToken,
      event: twEvent('2026-07-25T00:00:00.001Z'),
      capability: watermarkCap,
    });
    expect(r.eligible).toBe(true);
    if (r.eligible) expect(r.basis).toBe('provider_time_watermark');
  });

  it('event time equal/before watermark → not eligible', () => {
    expect(
      evaluateEventOrderEligibility({
        token: twToken,
        event: twEvent('2026-07-25T00:00:00.000Z'),
        capability: watermarkCap,
      }).eligible,
    ).toBe(false);
    expect(
      evaluateEventOrderEligibility({
        token: twToken,
        event: twEvent('2026-07-24T23:59:59.000Z'),
        capability: watermarkCap,
      }).eligible,
    ).toBe(false);
  });

  it('watermark mode without documented authority fails closed', () => {
    const r = evaluateEventOrderEligibility({
      token: twToken,
      event: twEvent('2026-07-25T01:00:00.000Z'),
      capability: { ...watermarkCap, supportsDocumentedFinality: false },
    });
    expect(r).toEqual({
      eligible: false,
      reason: 'time_watermark_unsupported',
    });
  });

  it('malformed event time fails closed', () => {
    const r = evaluateEventOrderEligibility({
      token: twToken,
      event: twEvent('nonsense'),
      capability: watermarkCap,
    });
    expect(r).toEqual({ eligible: false, reason: 'malformed_event_time' });
  });
});
