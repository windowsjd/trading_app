import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import { portfolioFailureFacts } from '../../features/tradingAccount/portfolioReadPolicy.ts';
const require = createRequire(import.meta.url);
const { interactionHarness, React, act } = require('../../../test/interactionTestHarness.cjs');
const error = { isAxiosError: true, code: 'ERR_BAD_RESPONSE', response: { status: 500, data: { error: {
  code: 'TRADING_ACCOUNT_SCOPE_MISMATCH', diagnostic: {
    version: 1, code: 'TRADING_ACCOUNT_SCOPE_MISMATCH', httpStatus: 500,
    timestamp: '2026-10-06T00:00:00Z', requestId: 'request-safe-1', domain: 'PORTFOLIO', operation: 'PORTFOLIO_VALUATION',
    failureStage: 'portfolio_valuation_validation', evidence: { failedStep: 'portfolio_valuation_validation' },
    exception: { type: 'HttpException', message: 'Portfolio data could not be safely valued.', applicationStack: [], stack: [], truncated: false },
    diagnosticEvents: { events: [], truncated: false }, serverLogs: { entries: [], truncated: false }, truncated: false,
  },
} } } };

for (const role of ['admin', 'user', 'operator', undefined]) it(`portfolio error panel reuses diagnostics and respects ${role ?? 'unresolved'} role`, t => {
  const h = interactionHarness(); h.native.SafeAreaView = 'SafeAreaView';
  const query = { data: role ? { id: 'user-1', role } : undefined, isError: false };
  const Panel = h.load('src/components/states/AdminDiagnosticPanel.tsx', {
    '@tanstack/react-query': { useQuery: () => query },
    '../../features/me/api': { getMe: async () => query.data },
  }).default;
  const ErrorState = h.load('src/components/states/ErrorState.tsx', { './AdminDiagnosticPanel': { default: Panel, __esModule: true } }).default;
  const renderer = h.render(React.createElement(ErrorState, { title: '포트폴리오 정보를 불러오지 못했습니다.', diagnosticError: error, diagnosticRuntime: portfolioFailureFacts(error), onRetry() {} }));
  t.after(() => act(() => renderer.unmount()));
  const toggle = renderer.root.findAll(node => node.props.testID === 'admin-diagnostic-toggle');
  if (role !== 'admin') { assert.equal(toggle.length, 0); return; }
  assert.equal(renderer.root.findAll(node => node.props.testID === 'admin-diagnostic-content').length, 0, 'collapsed by default');
  act(() => toggle[0].props.onPress());
  const text = renderer.root.findAllByType('Text').flatMap(node => node.props.children).filter(value => typeof value === 'string').join(' ').replace(/\u200b/g, '');
  for (const expected of ['portfolio_valuation_validation', 'request-safe-1', 'ERR_BAD_RESPONSE', 'GET /api/v1/trading-accounts/:accountId/portfolio', 'httpStatus']) assert.ok(text.includes(expected), expected);
  query.isError = true;
  act(() => renderer.update(React.createElement(ErrorState, { diagnosticError: error, diagnosticRuntime: portfolioFailureFacts(error) })));
  assert.equal(renderer.root.findAll(node => node.props.testID === 'admin-diagnostic-panel').length, 0, 'failed role lookup closes diagnostics');
});
