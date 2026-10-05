import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
const require = createRequire(import.meta.url);
const { interactionHarness, React, act } = require('../../../test/interactionTestHarness.cjs');

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
      '@tanstack/react-query': { useQuery: () => ({ data: { role }, isError: false }) },
      '../../features/me/api': { getMe: async () => ({ role }) },
    }).default;
    const renderer = h.render(React.createElement(Panel, { runtime }));
    if (role !== 'admin') assert.equal(renderer.toJSON(), null);
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
      '@tanstack/react-query': { useQuery: () => ({ data: { role: 'admin' }, isError }) },
      '../../features/me/api': { getMe: async () => ({ role: 'admin' }) },
    }).default;
    const renderer = h.render(React.createElement(Panel, { diagnostic, runtime }));
    act(() => renderer.root.findByProps({ testID: 'admin-diagnostic-toggle' }).props.onPress());
    assert.match(JSON.stringify(renderer.toJSON()), /PRICE_STALE/);
    assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /socket_closed|Client runtime 상태/);
    isError = true; act(() => renderer.update(React.createElement(Panel, { diagnostic, runtime })));
    assert.equal(renderer.toJSON(), null);
    act(() => renderer.unmount());
  });
});
