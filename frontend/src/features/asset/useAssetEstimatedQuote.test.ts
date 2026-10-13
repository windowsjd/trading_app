import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import * as policy from './estimatedQuote.ts';
import type { RealtimeSubscriptionEvent } from '../../services/ws/realtimeSocketManager.ts';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act } = require('../../../test/interactionTestHarness.cjs');

function setup(initialProps: Record<string, unknown> = { assetId: 'aapl' }) {
  const h = interactionHarness();
  const subscriptions: Array<{
    spec: { channel: string; assetId: string };
    listener: (event: RealtimeSubscriptionEvent) => void;
    released: boolean;
  }> = [];
  h.native.AppState = {
    currentState: 'active',
    addEventListener: () => ({ remove: () => {} }),
  };
  const { useStaleRecheck } = h.load('src/features/asset/useStaleRecheck.ts', {
    './assetTickerPolicy': { STALE_RECHECK_INTERVAL_MS: 5000 },
  });
  const { useAssetEstimatedQuote } = h.load('src/features/asset/useAssetEstimatedQuote.ts', {
    './estimatedQuote': policy,
    './useStaleRecheck': { useStaleRecheck },
    '../../services/ws/sharedRealtimeSocket': {
      getRealtimeSocketManager: () => ({
        subscribe: (
          spec: { channel: string; assetId: string },
          listener: (event: RealtimeSubscriptionEvent) => void,
        ) => {
          const entry = { spec, listener, released: false };
          subscriptions.push(entry);
          return () => {
            entry.released = true;
          };
        },
      }),
    },
  });
  let result: any;
  const Probe = (props: any) => {
    result = useAssetEstimatedQuote({ wsUrl: 'wss://app/api/v1/ws', ...props });
    return null;
  };
  const renderer = h.render(React.createElement(Probe, initialProps));
  return {
    subscriptions,
    result: () => result,
    emit: (event: RealtimeSubscriptionEvent, index = subscriptions.length - 1) =>
      act(() => subscriptions[index].listener(event)),
    update: (props: any) => act(() => renderer.update(React.createElement(Probe, props))),
    unmount: () => act(() => renderer.unmount()),
  };
}

const estimate = (capturedAt: string, bid = '247.45') => ({
  kind: 'message' as const,
  payload: {
    type: 'asset_estimated_quote',
    assetId: 'aapl',
    kind: 'estimated_liquidity',
    provider: 'tiingo',
    priceCurrency: 'USD',
    quantityUnit: 'share',
    bid: { price: bid, size: '300' },
    ask: { price: '247.55', size: null },
    spread: '0.0004',
    referencePrice: '247.5',
    effectiveAt: capturedAt,
    capturedAt,
  },
});
const ack = (assetId = 'aapl'): RealtimeSubscriptionEvent => ({
  kind: 'message',
  payload: { type: 'subscribed', channel: 'asset_estimated_quote', assetId },
});

describe('useAssetEstimatedQuote', () => {
  it('subscribes the separate channel, accepts estimates and releases on unmount', () => {
    const h = setup();
    assert.deepEqual(h.subscriptions[0].spec, {
      channel: 'asset_estimated_quote',
      assetId: 'aapl',
    });
    assert.equal(h.result().supported, false, 'nothing is shown before the server accepts');
    h.emit({ kind: 'status', status: 'connected' });
    h.emit(ack());
    assert.equal(h.result().supported, true);
    assert.match(h.result().statusMessage, /불러오는 중/);
    h.emit(estimate(new Date().toISOString()));
    assert.equal(h.result().latestEstimate.bid.price, '247.45');
    assert.equal(h.result().latestEstimate.ask.size, null);
    assert.equal(h.result().statusMessage, null);
    h.unmount();
    assert.equal(h.subscriptions[0].released, true);
  });

  it('treats UNSUPPORTED_ASSET as "no estimate source" rather than an error to show', () => {
    const h = setup();
    h.emit({
      kind: 'message',
      payload: {
        type: 'subscription_error',
        channel: 'asset_estimated_quote',
        assetId: 'aapl',
        code: 'UNSUPPORTED_ASSET',
      },
    });
    assert.equal(h.result().unsupported, true);
    assert.equal(h.result().supported, false);
  });

  it('rejects older, foreign and malformed estimates', () => {
    const h = setup();
    h.emit(ack());
    h.emit(estimate('2026-10-13T14:30:05.000Z', '247.46'));
    h.emit(estimate('2026-10-13T14:30:01.000Z', '247.40'));
    assert.equal(h.result().latestEstimate.bid.price, '247.46');
    assert.equal(h.result().runtime.lastRejectionReason, 'older_estimate');
    h.emit({ kind: 'message', payload: { ...estimate('2026-10-13T14:30:09.000Z').payload, assetId: 'msft' } });
    h.emit({ kind: 'message', payload: { ...estimate('2026-10-13T14:30:09.000Z').payload, bid: { price: '999', size: '1' } } });
    assert.equal(h.result().latestEstimate.bid.price, '247.46');
    assert.equal(h.result().runtime.lastRejectionReason, 'invalid_estimate');
  });

  it('reports a missing estimate after the wait and a stale one by receipt age', (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1_000_000 });
    const h = setup();
    h.emit({ kind: 'status', status: 'connected' });
    h.emit(ack());
    act(() => t.mock.timers.tick(policy.ESTIMATED_QUOTE_FIRST_SNAPSHOT_TIMEOUT_MS + 1_000));
    assert.equal(h.result().isUnavailable, true);
    assert.match(h.result().statusMessage, /추정 호가가 없습니다/);
    h.emit(estimate(new Date(Date.now()).toISOString()));
    assert.equal(h.result().isUnavailable, false);
    act(() => t.mock.timers.tick(policy.ESTIMATED_QUOTE_STALE_MS + 1_000));
    assert.equal(h.result().isStale, true);
    assert.match(h.result().statusMessage, /지연/);
  });

  it('switches assets without showing the previous estimate', () => {
    const h = setup();
    h.emit(ack());
    h.emit(estimate(new Date().toISOString()));
    h.update({ assetId: 'msft' });
    assert.equal(h.result().latestEstimate, null);
    assert.equal(h.subscriptions[0].released, true);
    assert.equal(h.subscriptions.at(-1)?.spec.assetId, 'msft');
  });

  it('does not subscribe while disabled', () => {
    const h = setup({ assetId: 'aapl', enabled: false });
    assert.equal(h.subscriptions.length, 0);
    assert.equal(h.result().connectionState, 'disconnected');
  });
});
