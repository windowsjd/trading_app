import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ScrollView, Text } from '../../src/theme/native';
import { AppearanceProvider } from '../../src/theme/appearance';
import ErrorNotice from '../../src/components/states/ErrorNotice';
import ErrorState from '../../src/components/states/ErrorState';
import CTAButton from '../../src/components/common/CTAButton';
import { QUERY_KEYS } from '../../src/constants/queryKeys';
import { clearSessionCache, seedSessionCache } from '../../src/features/auth/sessionCache';

const params = new URLSearchParams(location.search);
const fixture = window.diagnosticFixture = {
  me: { id: 'admin-A', role: params.get('role') ?? 'admin', status: 'active' },
  meBlocked: params.has('unresolved'), meFailure: params.has('meFailure'), meReads: 0, retries: 0,
};
export const apiClient = { get: async () => {
  fixture.meReads++;
  const me = fixture.me;
  if (fixture.meBlocked) await new Promise(resolve => { fixture.releaseMe = resolve; });
  if (fixture.meFailure) throw new Error('fixture role lookup failure');
  return { data: { success: true, data: me } };
} };
const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
if (params.has('cachedAdmin')) client.setQueryData(QUERY_KEYS.me, fixture.me);
fixture.clearRole = () => { fixture.meBlocked = true; clearSessionCache(client); };
fixture.installUser = (role, id) => {
  fixture.me = { id, role, status: 'active' }; fixture.meBlocked = false;
  return seedSessionCache(client, fixture.me);
};
const diagnostic = {
  version: 1, code: 'FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH'.repeat(6), httpStatus: 500,
  timestamp: '2026-10-09T00:00:00.000Z', requestId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  domain: 'WALLETS', operation: 'WALLET_TRANSFER', failureStage: 'transfer_destination_credit',
  evidence: { financialGuard: { walletFound: true, scopeValid: false, availableSufficient: false }, accessToken: 'PRIVATE_FIXTURE_TOKEN' },
  exception: { type: 'HttpException', message: 'Unexpected internal failure.', cause: 'scope_mismatch',
    applicationStack: Array.from({ length: 8 }, (_, index) => `backend/src/wallets/trading-account-wallet-transfer.service.ts:${index + 100}:10`), stack: [], truncated: false },
  diagnosticEvents: { events: [], truncated: false }, serverLogs: { entries: [], truncated: false },
  nextInvestigation: ['backend/src/wallets/trading-account-wallet-transfer.service.ts', 'frontend/src/features/wallet/walletTransfer.ts'], truncated: false,
};
const error = requestId => ({ response: { status: 500, data: { error: { code: 'INTERNAL_SERVER_ERROR', message: 'PRIVATE_FIXTURE_RAW_EXCEPTION', diagnostic: { ...diagnostic, requestId } } } } });
const message = '요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요. '.repeat(5);
function Fixture() {
  const [failure, setFailure] = useState(error(diagnostic.requestId));
  fixture.newFailure = () => setFailure(error('B-request'));
  const retry = () => { fixture.retries++; setFailure(null); };
  if (!failure) return <Text testID="diagnostic-recovered">다시 불러왔습니다.</Text>;
  if (params.get('surface') !== 'inline') return <ErrorState title="요청을 처리하지 못했습니다." message={message} error={failure} onRetry={retry} />;
  return <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16 }}>
    <ErrorNotice error={failure} message={message} />
    <CTAButton label="다시 시도" onPress={retry} style={{ marginTop: 16 }} />
  </ScrollView>;
}
createRoot(document.getElementById('root')).render(
  <QueryClientProvider client={client}><AppearanceProvider><Fixture /></AppearanceProvider></QueryClientProvider>,
);
