import assert from 'node:assert/strict';
import { it } from 'node:test';
import { getApiErrorDiagnostic, sanitizeAdminDiagnostic, requestFailureFacts } from './errorMapper.ts';
const diagnostic = () => ({ version: 1, code: 'INTERNAL_SERVER_ERROR', httpStatus: 500, timestamp: '2026-10-09T00:00:00Z', requestId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', domain: 'WALLETS', operation: 'WALLET_TRANSFER', failureStage: 'transfer_source_debit', exception: { type: 'Error', message: 'Unexpected internal failure.', stack: [], applicationStack: [], truncated: false }, diagnosticEvents: { events: [], truncated: false }, serverLogs: { entries: [], truncated: false }, truncated: false });

it('sanitizes both direct partial diagnostics and HTTP errors without modifying financial responses', () => {
  const raw = { ...diagnostic(), evidence: { access_token: 'PRIVATE_TOKEN', balanceAmount: '987654.12345678', reserved_amount: '987654.12345678', amount: '987654.12345678', row: { privateField: 'PRIVATE_ROW' }, financialGuard: { walletFound: true, scopeValid: false, availableSufficient: false }, nested: { providerPayload: { body: 'PRIVATE_PAYLOAD' } }, text: '{"accessToken":"PRIVATE_NESTED_TOKEN"}', free: 'balanceAmount = 987654.12345678', url: 'https://provider.invalid/private' }, nextInvestigation: ['backend/src/wallets/trading-account-wallet-transfer.service.ts', 'curl https://private.invalid'] };
  const response = { balanceAmount: '987654.12345678', diagnostic: raw };
  const projected = sanitizeAdminDiagnostic(raw);
  assert.ok(projected);
  assert.doesNotMatch(JSON.stringify(projected), /987654|PRIVATE_|provider.invalid|private.invalid|curl/);
  assert.deepEqual(projected.evidence?.financialGuard, { walletFound: true, scopeValid: false, availableSufficient: false });
  assert.deepEqual(getApiErrorDiagnostic({ response: { data: { error: { diagnostic: raw } } } }), projected);
  assert.equal(response.balanceAmount, '987654.12345678');
  assert.equal(raw.evidence.access_token, 'PRIVATE_TOKEN');
});

it('bounds nested, cyclic and oversized input and rejects malformed optional fields', () => {
  const raw: any = { ...diagnostic(), evidence: { large: '가'.repeat(100000), items: Array.from({ length: 1000 }, (_, id) => ({ id, value: 'x'.repeat(1000) })) } };
  raw.evidence.cycle = raw.evidence;
  const projected = sanitizeAdminDiagnostic(raw);
  assert.ok(projected); assert.equal(projected.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(projected)) <= 24 * 1024);
  assert.equal(sanitizeAdminDiagnostic({ ...diagnostic(), exception: null }), null);
  assert.equal(sanitizeAdminDiagnostic({ ...diagnostic(), exception: { ...diagnostic().exception, cause: { raw: 'invalid' } } }), null);
  assert.equal(sanitizeAdminDiagnostic({ ...diagnostic(), nextInvestigation: 'bad' }), null);
});

it('request runtime retains only observed allowlisted facts and never invents a backend stage', () => {
  const context = { endpoint: 'POST /api/v1/trading-accounts/:accountId/orders', operation: 'order_create', outcome: 'unknown' as const };
  const facts = requestFailureFacts({ code: 'ECONNABORTED', message: 'secret=PRIVATE_TOKEN' }, context);
  assert.equal(facts.timeout, true); assert.equal(facts.hasResponse, false); assert.equal(facts.outcome, 'unknown');
  assert.equal(facts.clientFailureStage, 'request_transport'); assert.equal(facts.failureStage, undefined);
  const contract = requestFailureFacts(null, { ...context, contractFailure: true });
  assert.equal(contract.hasResponse, true); assert.equal(contract.httpStatus, 'not_observed'); assert.equal(contract.clientFailureStage, 'response_validation');
  const malformed = requestFailureFacts({ code: 'PRIVATE_TOKEN', response: { status: 9999, headers: { 'x-request-id': 'PRIVATE_TOKEN' }, data: { error: { code: 'PRIVATE_TOKEN' } } } }, context);
  assert.doesNotMatch(JSON.stringify(malformed), /PRIVATE_TOKEN|9999/);
});
