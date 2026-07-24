import {
  BINANCE_SPOT_TRADE_ROUTE,
  KIS_DOMESTIC_TRADE_ROUTE,
  KIS_OVERSEAS_DELAYED_TRADE_ROUTE,
  ProviderTradeCapabilityError,
  ProviderTradeCapabilityRegistry,
  allCapabilities,
  decideNewLimitOrderRoute,
  findCapabilityByRoute,
  findCapabilityBySourceName,
  findCapabilityForAssetType,
  tradeRouteKeyForAssetType,
  validateCapability,
  type ProviderTradeCapability,
} from './provider-trade-capability';

const validBase: ProviderTradeCapability = {
  provider: 'binance',
  route: 'binance:spot-trade',
  sourceName: 'binance_spot_ws_trade',
  supportsAuthoritativeEventId: true,
  supportsMonotonicSequence: true,
  supportsAuthoritativeEventTime: false,
  supportsDocumentedFinality: false,
  supportsReplay: false,
  supportsBoundedDeliveryLag: false,
  maxDocumentedDeliveryLagMs: null,
  pathAExecutionAllowed: true,
  pathBRequired: true,
  activationMode: 'provider_sequence',
};

describe('provider trade capability matrix', () => {
  describe('matrix integrity', () => {
    it('every declared route passes structural validation', () => {
      for (const capability of allCapabilities()) {
        expect(() => validateCapability(capability)).not.toThrow();
      }
    });

    it('route keys are unique and provider-prefixed', () => {
      const routes = allCapabilities().map((c) => c.route);
      expect(new Set(routes).size).toBe(routes.length);
      for (const c of allCapabilities()) {
        expect(c.route.startsWith(`${c.provider}:`)).toBe(true);
      }
    });

    it('every Path-A route keeps Path B as a required safety net', () => {
      for (const c of allCapabilities()) {
        if (c.pathAExecutionAllowed) expect(c.pathBRequired).toBe(true);
      }
    });
  });

  describe('authoritative-sequence route (Binance) → Path A allowed', () => {
    const binance = findCapabilityByRoute(BINANCE_SPOT_TRADE_ROUTE);

    it('is declared with an authoritative id and monotonic sequence', () => {
      expect(binance).not.toBeNull();
      expect(binance?.supportsAuthoritativeEventId).toBe(true);
      expect(binance?.supportsMonotonicSequence).toBe(true);
      expect(binance?.activationMode).toBe('provider_sequence');
      expect(binance?.pathAExecutionAllowed).toBe(true);
    });

    it('decides new orders as allowed and NOT Path-B-only', () => {
      const decision = decideNewLimitOrderRoute(binance);
      expect(decision.allowed).toBe(true);
      if (decision.allowed) {
        expect(decision.pathAExecutionAllowed).toBe(true);
        expect(decision.pathBOnly).toBe(false);
      }
    });
  });

  describe('synthetic-identity route (KIS domestic) → Path A forbidden', () => {
    const kis = findCapabilityByRoute(KIS_DOMESTIC_TRADE_ROUTE);

    it('never claims an authoritative id or monotonic sequence', () => {
      expect(kis).not.toBeNull();
      expect(kis?.supportsAuthoritativeEventId).toBe(false);
      expect(kis?.supportsMonotonicSequence).toBe(false);
      expect(kis?.pathAExecutionAllowed).toBe(false);
      expect(kis?.activationMode).toBe('path_b_only');
    });

    it('decides new orders as allowed but Path-B-only', () => {
      const decision = decideNewLimitOrderRoute(kis);
      expect(decision.allowed).toBe(true);
      if (decision.allowed) {
        expect(decision.pathAExecutionAllowed).toBe(false);
        expect(decision.pathBOnly).toBe(true);
      }
    });
  });

  describe('KIS US delayed route is never real-time Path A', () => {
    const kisUs = findCapabilityByRoute(KIS_OVERSEAS_DELAYED_TRADE_ROUTE);
    it('is Path-B-only with no authority claims', () => {
      expect(kisUs?.pathAExecutionAllowed).toBe(false);
      expect(kisUs?.supportsAuthoritativeEventTime).toBe(false);
      expect(kisUs?.activationMode).toBe('path_b_only');
      expect(kisUs?.sourceName).toBe('kis_us_delayed_trade');
    });
  });

  describe('missing capability → fail-closed', () => {
    it('unknown route resolves to null', () => {
      expect(findCapabilityByRoute('binance:futures-nope')).toBeNull();
      expect(findCapabilityBySourceName('made_up_source')).toBeNull();
    });

    it('null capability blocks new orders (fail-closed)', () => {
      const decision = decideNewLimitOrderRoute(null);
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) {
        expect(decision.code).toBe(
          'LIMIT_ORDER_PROVIDER_CAPABILITY_UNSUPPORTED',
        );
      }
    });

    it('an explicitly unsupported route blocks new orders', () => {
      const unsupported: ProviderTradeCapability = {
        ...validBase,
        route: 'binance:unsupported',
        pathAExecutionAllowed: false,
        activationMode: 'unsupported',
      };
      const decision = decideNewLimitOrderRoute(unsupported);
      expect(decision.allowed).toBe(false);
    });
  });

  describe('asset-type routing', () => {
    it('crypto → Binance authoritative route', () => {
      expect(tradeRouteKeyForAssetType('crypto')).toBe(
        BINANCE_SPOT_TRADE_ROUTE,
      );
      expect(findCapabilityForAssetType('crypto')?.pathAExecutionAllowed).toBe(
        true,
      );
    });
    it('domestic_stock → KIS domestic (Path B only)', () => {
      expect(tradeRouteKeyForAssetType('domestic_stock')).toBe(
        KIS_DOMESTIC_TRADE_ROUTE,
      );
      expect(
        findCapabilityForAssetType('domestic_stock')?.pathAExecutionAllowed,
      ).toBe(false);
    });
    it('us_stock → KIS overseas delayed (Path B only)', () => {
      expect(tradeRouteKeyForAssetType('us_stock')).toBe(
        KIS_OVERSEAS_DELAYED_TRADE_ROUTE,
      );
      expect(
        findCapabilityForAssetType('us_stock')?.pathAExecutionAllowed,
      ).toBe(false);
    });
  });

  describe('validateCapability rejects internally inconsistent rows', () => {
    it('Path A allowed with a non-authoritative activation mode', () => {
      expect(() =>
        validateCapability({
          ...validBase,
          activationMode: 'path_b_only',
        }),
      ).toThrow(ProviderTradeCapabilityError);
    });

    it('provider_sequence without a monotonic sequence', () => {
      expect(() =>
        validateCapability({
          ...validBase,
          supportsMonotonicSequence: false,
        }),
      ).toThrow(ProviderTradeCapabilityError);
    });

    it('provider_time_watermark without authoritative time + finality', () => {
      expect(() =>
        validateCapability({
          ...validBase,
          activationMode: 'provider_time_watermark',
          supportsAuthoritativeEventTime: false,
        }),
      ).toThrow(ProviderTradeCapabilityError);
    });

    it('path_b_only that also allows Path A', () => {
      expect(() =>
        validateCapability({
          ...validBase,
          route: 'kis:domestic-trade',
          provider: 'kis',
          activationMode: 'path_b_only',
          pathAExecutionAllowed: true,
        }),
      ).toThrow(ProviderTradeCapabilityError);
    });

    it('bounded-delivery-lag flag disagreeing with the documented number', () => {
      expect(() =>
        validateCapability({
          ...validBase,
          supportsBoundedDeliveryLag: true,
          maxDocumentedDeliveryLagMs: null,
        }),
      ).toThrow(ProviderTradeCapabilityError);
    });

    it('route not prefixed by its provider', () => {
      expect(() =>
        validateCapability({ ...validBase, route: 'nope:spot-trade' }),
      ).toThrow(ProviderTradeCapabilityError);
    });
  });

  describe('registry wrapper', () => {
    const registry = new ProviderTradeCapabilityRegistry();
    it('delegates to the static matrix', () => {
      expect(registry.forRoute(BINANCE_SPOT_TRADE_ROUTE)?.provider).toBe(
        'binance',
      );
      expect(registry.forAssetType('crypto')?.route).toBe(
        BINANCE_SPOT_TRADE_ROUTE,
      );
      expect(registry.decideForAssetType('domestic_stock').allowed).toBe(true);
      expect(registry.all().length).toBe(allCapabilities().length);
    });
  });
});
