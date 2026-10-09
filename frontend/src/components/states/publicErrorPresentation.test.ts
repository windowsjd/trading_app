import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
const { interactionHarness, React, act } = createRequire(import.meta.url)('../../../test/interactionTestHarness.cjs');
const { QueryClient } = createRequire(import.meta.url)('@tanstack/react-query');

const diagnostic = { version: 1, code: 'NEW_SYNTHETIC_ERROR', httpStatus: 500,
  timestamp: '2026-10-07T00:00:00Z', requestId: 'req-private', domain: 'ORDER', operation: 'ORDER_CREATE', failureStage: 'wallet_write',
  evidence: { selectionResult: 'REJECTED', safeCause: { category: 'db_transaction_conflict' } },
  exception: { type: 'Error', message: 'Unexpected internal failure.', applicationStack: [], stack: [], truncated: false },
  diagnosticEvents: { events: [], truncated: false }, serverLogs: { entries: [], truncated: false },
  nextInvestigation: ['backend/src/orders/orders.service.ts'], truncated: false };
const error = { code: 'ECONNABORTED', response: { status: 503, data: { error: { code: 'NEW_SYNTHETIC_ERROR', message: 'PRIVATE_UNKNOWN_CODE HTTP 503 PROVIDER_INTERNAL_FAILURE JWT_ACCESS_SECRET postgres://user:secret@host/db https://private.invalid Request ID req-private failureStage wallet_write exact balance 184927.543281', diagnostic } } } };

describe('rendered public error boundary', () => {
  for (const component of ['ErrorState', 'ErrorNotice']) for (const role of ['user', 'operator', 'admin', undefined]) it(`keeps ${component} public text safe with role=${role}`, t => {
    const h = interactionHarness(); h.native.SafeAreaView = 'SafeAreaView';
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    client.setQueryData(['me'], { role });
    const Screen = h.load(`src/components/states/${component}.tsx`, {
      '@tanstack/react-query': { useQuery: () => ({ data: { role }, isError: false }), useQueryClient: () => client },
      '../../features/me/api': { getMe: async () => ({ role }) },
    }).default;
    const renderer = h.render(React.createElement(Screen, { error, onRetry() {} }));
    t.after(() => { act(() => renderer.unmount()); client.clear(); });
    const visible = () => JSON.stringify(renderer.toJSON()).replace(/\u200b/g, '');
    assert.match(visible(), /잠시 후 다시 시도/);
    assert.doesNotMatch(visible(), /PRIVATE_UNKNOWN_CODE|JWT_ACCESS_SECRET|private.invalid|184927|req-private|wallet_write|INTERNAL_SERVER_ERROR|NEW_SYNTHETIC_ERROR|INTERNAL_DB_FAILURE|PROVIDER_INTERNAL_FAILURE|HTTP 503|ECONNABORTED|postgres/);
    const toggles = renderer.root.findAllByProps({ testID: 'admin-diagnostic-toggle' });
    assert.equal(toggles.length, role === 'admin' ? 1 : 0);
    if (role === 'admin') {
      act(() => toggles[0].props.onPress());
      for (const value of ['NEW_SYNTHETIC_ERROR', 'ORDER_CREATE', 'wallet_write', 'req-private', 'db_transaction_conflict', 'orders.service.ts']) assert.ok(visible().includes(value));
      assert.doesNotMatch(visible(), /JWT_ACCESS_SECRET|private.invalid|184927/);
    }
  });
});
