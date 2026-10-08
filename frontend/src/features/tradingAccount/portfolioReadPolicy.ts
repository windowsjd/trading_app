import { getApiErrorInfo, isKnownErrorCode } from '../../services/api/errorMapper.ts';
import { classifyAccountError, isTradingAccountIntegrityCode } from './integrityErrors.ts';
import type { RuntimeFacts } from '../../services/ws/runtimeDiagnostics';
import { isTradingAccountScopeMismatchError } from './accountScope.ts';

const TRANSPORT_CODES = new Set(['ERR_NETWORK', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN']);
const TIMEOUT_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT']);
const GATEWAY_CODES = new Set(['INTERNAL_SERVER_ERROR', 'HTTP_ERROR', 'BAD_GATEWAY', 'SERVICE_UNAVAILABLE', 'GATEWAY_TIMEOUT']);

/** A generic 500 can conceal an unexpected integrity fault. Never retry it
 * automatically; only known transport failures and gateway outages are safe. */
export function isTransientPortfolioError(error: unknown): boolean {
  if (classifyAccountError(error) !== 'other') return false;
  const info = getApiErrorInfo(error);
  if (info.hasResponse) {
    return [502, 503, 504].includes(info.status ?? 0) &&
      (info.serverCode === null || GATEWAY_CODES.has(info.serverCode));
  }
  return info.isAxiosError && (TIMEOUT_CODES.has(info.clientCode ?? '') || TRANSPORT_CODES.has(info.clientCode ?? ''));
}

type QuerySignal = { state: { status: string; error: unknown } };
// Keep the existing single retry and library delay. Scope this policy to the
// shared portfolio key, including observers in Wallet and Portfolio.
export const portfolioReadPolicy = {
  retry: (failureCount: number, error: unknown) => failureCount < 1 && isTransientPortfolioError(error),
  retryOnMount: (query: QuerySignal) => query.state.status !== 'error' || isTransientPortfolioError(query.state.error),
  refetchOnReconnect: (query: QuerySignal) => query.state.status !== 'error' || isTransientPortfolioError(query.state.error),
};

/** Allowlisted facts for the existing admin-only runtime panel. No raw error
 * messages, URLs, credentials, financial values or provider/DB payloads. */
export function portfolioFailureFacts(error: unknown): RuntimeFacts {
  const info = getApiErrorInfo(error);
  const timeout = !info.hasResponse && TIMEOUT_CODES.has(info.clientCode ?? '');
  const network = !info.hasResponse && TRANSPORT_CODES.has(info.clientCode ?? '');
  const headers = (error as { response?: { headers?: Record<string, unknown> } } | null)?.response?.headers;
  const requestId = headers?.['x-request-id'];
  return {
    endpoint: 'GET /api/v1/trading-accounts/:accountId/portfolio',
    hasResponse: info.hasResponse || isTradingAccountScopeMismatchError(error),
    httpStatus: info.status ?? (isTradingAccountScopeMismatchError(error) ? 'not_observed' : 'no_response'),
    clientInvestigation: 'frontend/src/features/tradingAccount/portfolioReadPolicy.ts',
    serverCode: isKnownErrorCode(info.serverCode) || isTradingAccountIntegrityCode(info.serverCode) || GATEWAY_CODES.has(info.serverCode ?? '')
      ? info.serverCode : info.serverCode ? 'unrecognized' : 'not_observed',
    clientCode: isTradingAccountScopeMismatchError(error) ? 'TRADING_ACCOUNT_SCOPE_MISMATCH' : TIMEOUT_CODES.has(info.clientCode ?? '') || TRANSPORT_CODES.has(info.clientCode ?? '') || ['ERR_BAD_REQUEST', 'ERR_BAD_RESPONSE', 'ERR_CANCELED'].includes(info.clientCode ?? '')
      ? info.clientCode : info.clientCode ? 'unrecognized' : 'not_observed',
    timeout,
    network,
    requestId: typeof requestId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(requestId) ? requestId : 'not_observed',
    clientFailureStage: classifyAccountError(error) === 'integrity' ? 'account_integrity_validation' : 'portfolio_request',
    automaticRecoveryEligible: isTransientPortfolioError(error),
  };
}
