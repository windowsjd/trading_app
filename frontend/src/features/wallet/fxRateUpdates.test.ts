import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { subscribeFxRateUpdates } from './fxRateUpdates.ts';
import type { RealtimeSubscriptionEvent } from '../../services/ws/realtimeSocketManager.ts';
import { TEST_IDS } from '../../constants/testIds.ts';

const require = createRequire(import.meta.url);
const {
  createTradingUiHarness,
  elements,
} = require('../../../test/tradingUiHarness.cjs');
const { load } = require('../../../test/ledgerTestHarness.cjs');

function transport() {
  let receive: (event: RealtimeSubscriptionEvent) => void = () => {};
  let subscribed = true;
  return {
    manager: {
      subscribe(spec: unknown, listener: typeof receive) {
        assert.deepEqual(spec, { channel: 'fx_rate', pair: 'USD/KRW' });
        receive = listener;
        return () => {
          subscribed = false;
        };
      },
    },
    signal(type = 'fx_rate_updated') {
      if (subscribed)
        receive({
          kind: 'message',
          payload: { type, channel: 'fx_rate', pair: 'USD/KRW' },
        });
    },
    restored() {
      receive({ kind: 'restored' });
    },
  };
}

describe('FX rate notifications', () => {
  for (const direction of ['KRW', 'USD']) {
    it(`resyncs canonical REST and updates ${direction} preview without clearing input`, async () => {
      const h = createTradingUiHarness('wallet/WalletFxScreen.tsx');
      let tree = h.render();
      if (direction === 'USD') {
        h.control(tree, TEST_IDS.walletFx.directionUsdKrw).props.onPress();
        tree = h.render();
      }
      const amount = direction === 'KRW' ? '900000' : '100';
      h.control(tree, TEST_IDS.walletFx.amountInput).props.onChangeText(amount);
      tree = h.render();
      const before = elements(tree, 'PreviewAmounts')[0].props.rows;
      let canonicalRate = '1350';
      let reads = 0;
      const wire = transport();
      const off = subscribeFxRateUpdates(wire.manager, async () => {
        reads += 1;
        h.rateQuery.data = { ...h.rateQuery.data, rate: canonicalRate };
      });
      wire.signal('subscribed');
      await flush();
      // A raw fallback observation does not get to override canonical selection.
      wire.signal();
      await flush();
      assert.deepEqual(
        elements(h.render(), 'PreviewAmounts')[0].props.rows,
        before,
      );
      canonicalRate = '1400';
      wire.signal();
      await flush();
      tree = h.render();
      const after = elements(tree, 'PreviewAmounts')[0].props.rows;
      assert.notDeepEqual(after, before);
      assert.notEqual(after[0].value, before[0].value);
      assert.notEqual(after[1].value, before[1].value);
      assert.notEqual(after[2].value, before[2].value);
      assert.equal(
        h.control(tree, TEST_IDS.walletFx.amountInput).props.value,
        amount,
      );
      assert.equal(
        h.requests.length,
        0,
        'preview must not create durable quotes or execute',
      );
      assert.equal(reads, 3);
      canonicalRate = '1450';
      wire.restored();
      wire.signal('subscribed');
      await flush();
      assert.equal(reads, 4, 'one REST read on reconnect ACK');
      assert.equal(h.rateQuery.data.rate, '1450');
      off();
      wire.signal();
      await flush();
      assert.equal(reads, 4);
    });
  }

  it('repeats after an in-flight read, coalesces bursts and recovers from a failed read', async () => {
    const wire = transport();
    let finish: () => void = () => {};
    let reads = 0;
    const off = subscribeFxRateUpdates(wire.manager, async () => {
      reads += 1;
      if (reads === 1)
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      if (reads === 2) throw new Error('offline');
    });
    wire.signal('subscribed');
    wire.signal();
    wire.signal();
    assert.equal(reads, 1);
    finish();
    await flush();
    assert.equal(reads, 2);
    wire.signal();
    await flush();
    assert.equal(reads, 3);
    off();
  });

  it('keeps the existing account-switch reset while rates remain account-independent', async () => {
    const h = createTradingUiHarness('wallet/WalletFxScreen.tsx');
    let tree = h.render();
    h.control(tree, TEST_IDS.walletFx.amountInput).props.onChangeText('100000');
    tree = h.render();
    assert.equal(
      h.control(tree, TEST_IDS.walletFx.amountInput).props.value,
      '100000',
    );
    h.account = { ...h.account, id: 'account-2' };
    h.render();
    tree = h.render();
    assert.equal(
      h.control(tree, TEST_IDS.walletFx.amountInput).props.value,
      '',
    );
    const wire = transport();
    const off = subscribeFxRateUpdates(wire.manager, async () => {
      h.rateQuery.data = { ...h.rateQuery.data, rate: '1500' };
    });
    wire.signal();
    await flush();
    tree = h.render();
    assert.equal(
      h.control(tree, TEST_IDS.walletFx.amountInput).props.value,
      '',
    );
    assert.equal(h.requests.length, 0);
    off();
  });

  it('cancels pre-event queries and resyncs on ACK, foreground, and validity expiry', async () => {
    const React = require('react');
    const { act, create } = require('react-test-renderer');
    const {
      QueryClient,
      QueryClientProvider,
      useQuery,
    } = require('@tanstack/react-query');
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    const wire = transport();
    let foreground: (state: string) => void = () => {};
    let foregroundRemoved = false;
    const hook = load(resolve('src/features/wallet/useFxRateUpdates.ts'), {
      'react-native': {
        AppState: {
          addEventListener: (_: string, cb: typeof foreground) => {
            foreground = cb;
            return {
              remove() {
                foregroundRemoved = true;
              },
            };
          },
        },
      },
      '../../constants/env': {
        buildWsUrl: () => 'wss://example.test/api/v1/ws',
      },
      '../../services/ws/sharedRealtimeSocket': {
        getRealtimeSocketManager: () => wire.manager,
      },
    }).useFxRateUpdates;
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const key = ['wallet', 'fx-rate'];
    let reads = 0;
    let initialAborted = false;
    let latest: string | undefined;
    let deadline: string | undefined;
    function Screen() {
      const query = useQuery({
        queryKey: key,
        queryFn: ({ signal }: { signal: AbortSignal }) => {
          reads += 1;
          if (reads === 1)
            return new Promise(() => {
              signal.addEventListener('abort', () => {
                initialAborted = true;
              });
            });
          return Promise.resolve('1400');
        },
      });
      latest = query.data;
      hook(key, deadline);
      return null;
    }
    let renderer: any;
    try {
      await act(async () => {
        renderer = create(
          React.createElement(
            QueryClientProvider,
            { client },
            React.createElement(Screen),
          ),
        );
      });
      assert.equal(reads, 1, 'REST starts before socket connects');
      await act(async () => {
        wire.signal('subscribed');
        await new Promise((r) => setTimeout(r, 10));
      });
      assert.equal(initialAborted, true);
      assert.equal(latest, '1400');
      const afterAck = reads;
      await act(async () => {
        foreground('active');
        await flush();
      });
      assert.equal(reads, afterAck + 1);
      deadline = new Date(Date.now() + 50).toISOString();
      await act(async () => {
        renderer.update(
          React.createElement(
            QueryClientProvider,
            { client },
            React.createElement(Screen),
          ),
        );
      });
      await act(async () => {
        await new Promise((r) => setTimeout(r, 70));
      });
      assert.equal(reads, afterAck + 1, 'wait past whole-second server rounding');
      await act(async () => {
        await new Promise((r) => setTimeout(r, 1050));
      });
      assert.equal(reads, afterAck + 2);
    } finally {
      await act(async () => renderer?.unmount());
      client.clear();
    }
    assert.equal(foregroundRemoved, true);
  });
});
