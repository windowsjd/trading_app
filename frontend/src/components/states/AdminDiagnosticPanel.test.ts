import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
const require = createRequire(import.meta.url);
const { interactionHarness, React, act } = require('../../../test/interactionTestHarness.cjs');
const { QueryClient, QueryClientProvider } = require('@tanstack/react-query');
const meIdentity = {};
const stubCache = { find: () => meIdentity, subscribe: () => () => {} };
const stubClient = { getQueryCache: () => stubCache };

const runtime = { socketStatus: 'disconnected', lastTransitionReason: 'socket_closed', lastCloseCode: 1006,
  lastTransitionAt: '2026-10-05T00:00:00.123Z', reconnectAttempt: 3 };
const diagnostic = { version: 1, code: 'PRICE_STALE', httpStatus: 503, timestamp: '2026-10-05T00:00:00Z',
  requestId: 'req', domain: 'ORDER', operation: 'ORDER_CREATE', failureStage: 'price',
  exception: { type: 'HttpException', message: 'stale', applicationStack: [], stack: [], truncated: false },
  diagnosticEvents: { events: [], truncated: false }, serverLogs: { entries: [], truncated: false }, truncated: false };

for (const platform of ['ios', 'android', 'web']) describe(`admin runtime gate and scalable text (${platform})`, () => {
  for (const role of ['admin', 'user', 'operator', undefined]) it(`fails closed for role ${role}`, () => {
    const h = interactionHarness(platform);
    const Panel = h.load('src/components/states/AdminDiagnosticPanel.tsx', {
      '@tanstack/react-query': { useQuery: () => ({ data: { role }, isError: false }), useQueryClient: () => stubClient },
      '../../features/me/api': { getMe: async () => ({ role }) },
    }).default;
    const renderer = h.render(React.createElement(Panel, { runtime }));
    if (role !== 'admin') assert.equal(renderer.toJSON() === null, true);
    else {
      assert.equal(renderer.root.findAllByProps({ testID: 'admin-diagnostic-content' }).length, 0);
      act(() => renderer.root.findByProps({ testID: 'admin-diagnostic-toggle' }).props.onPress());
      const text = JSON.stringify(renderer.toJSON()).replace(/\u200b/g, '');
      assert.match(text, /Client runtime 상태/);
      assert.match(text, /socket_closed/); assert.match(text, /1006/);
      for (const node of renderer.root.findAllByType('Text')) {
        assert.equal(node.props.numberOfLines, undefined);
        assert.notEqual(node.props.allowFontScaling, false);
      }
    }
    act(() => renderer.unmount());
  });

  it('keeps backend failures separate and hides cached admin role after /me errors', () => {
    const h = interactionHarness(platform); let isError = false;
    const Panel = h.load('src/components/states/AdminDiagnosticPanel.tsx', {
      '@tanstack/react-query': { useQuery: () => ({ data: { role: 'admin' }, isError }), useQueryClient: () => stubClient },
      '../../features/me/api': { getMe: async () => ({ role: 'admin' }) },
    }).default;
    const renderer = h.render(React.createElement(Panel, { diagnostic, runtime }));
    act(() => renderer.root.findByProps({ testID: 'admin-diagnostic-toggle' }).props.onPress());
    assert.match(JSON.stringify(renderer.toJSON()), /PRICE_STALE/);
    assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /socket_closed|Client runtime 상태/);
    isError = true; act(() => renderer.update(React.createElement(Panel, { diagnostic, runtime })));
    assert.equal(renderer.toJSON() === null, true);
    act(() => renderer.unmount());
  });
});

for (const payload of [{ diagnostic }, { runtime }]) it(`detaches ${payload.diagnostic ? 'server' : 'runtime'} diagnostics when the session me query is removed`, async t => {
  const h = interactionHarness();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: Infinity } } });
  client.setQueryData(['me'], { id: 'A', role: 'admin' });
  const Panel = h.load('src/components/states/AdminDiagnosticPanel.tsx', {
    '../../features/me/api': { getMe: () => new Promise(() => {}) },
  }).default;
  const tree = props => React.createElement(QueryClientProvider, { client }, React.createElement(Panel, props));
  const renderer = h.render(tree(payload));
  t.after(() => { act(() => renderer.unmount()); client.clear(); });
  const count = () => renderer.root.findAll(node => typeof node.type === 'string' && node.props.testID === 'admin-diagnostic-panel').length;
  const flush = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); }); };
  await flush(); assert.equal(count(), 1);

  // Logout clears the cache before credential I/O and navigation can complete.
  act(() => client.clear()); await flush();
  assert.equal(count(), 0, 'an unresolved incoming role cannot retain cached admin access');
  act(() => client.setQueryData(['me'], { id: 'B', role: 'admin' })); await flush();
  assert.equal(count(), 0, 'another admin must not inherit the previous session diagnostic');

  act(() => renderer.update(tree(payload.diagnostic
    ? { diagnostic: { ...diagnostic, requestId: 'B-request' } }
    : { runtime: { ...runtime, operation: 'B-request' } })));
  await flush(); assert.equal(count(), 1, 'a new failure in the current admin session remains visible');
});
