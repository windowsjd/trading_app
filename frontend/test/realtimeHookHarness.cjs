// Real shared manager + hook lifecycle, only native hosts and the transport are fake.
const { interactionHarness, React, act } = require('./interactionTestHarness.cjs');
const { RealtimeSocketManager } = require('../src/services/ws/realtimeSocketManager.ts');
const tickerPolicy = require('../src/features/asset/assetTickerPolicy.ts');

async function realtimeHookHarness(name, props = {}) {
  const h = interactionHarness();
  h.native.AppState = { currentState: 'active', addEventListener: () => ({ remove() {} }) };
  const sockets = [];
  const manager = new RealtimeSocketManager('wss://test/api/v1/ws', {
    getToken: async () => 'private-token', reconnectDelaysMs: [1000, 2000],
    createSocket: () => {
      const socket = { onopen: null, onclose: null, onmessage: null, onerror: null,
        frames: [], closed: 0, send(frame) { this.frames.push(JSON.parse(frame)); }, close() { this.closed++; } };
      sockets.push(socket); return socket;
    },
  });
  const { useStaleRecheck } = h.load('src/features/asset/useStaleRecheck.ts', { './assetTickerPolicy': tickerPolicy });
  const hook = h.load(`src/features/asset/${name}.ts`, {
    './assetTickerPolicy': tickerPolicy, './useStaleRecheck': { useStaleRecheck },
    '../../services/ws/sharedRealtimeSocket': { getRealtimeSocketManager: () => manager },
  })[name];
  let result;
  const Probe = p => { result = hook({ assetId: 'btc', interval: '5m', wsUrl: 'wss://test/api/v1/ws', ...p }); return null; };
  const renderer = h.render(React.createElement(Probe, props));
  await act(async () => { await Promise.resolve(); });
  return { manager, sockets, result: () => result,
    open: () => act(() => sockets.at(-1).onopen?.({})),
    send: payload => act(() => sockets.at(-1).onmessage?.({ data: JSON.stringify(payload) })),
    drop: code => act(() => sockets.at(-1).onclose?.({ code })),
    update: p => act(() => renderer.update(React.createElement(Probe, p))),
    tick: async (t, ms) => { await act(async () => { t.mock.timers.tick(ms); await Promise.resolve(); }); },
    unmount: () => act(() => renderer.unmount()),
  };
}
module.exports = { realtimeHookHarness };
