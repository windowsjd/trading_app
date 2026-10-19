// Fixture boundaries for membershipDeletionBrowser.cjs: the 회원탈퇴 transport
// (password check, deletion, status) and inert session/navigation effects.
// Query: check=fail|role, delete=hang|unknown|ok, status=cleanup_pending|completed.
const scenario = () => new URLSearchParams(location.search);
const httpError = (status, code) => Object.assign(new Error(code), {
  isAxiosError: true, request: {}, response: { status, data: { success: false, error: { code, message: code } } },
});
const networkError = () => Object.assign(new Error('Network Error'), { isAxiosError: true, request: {} });
const receipt = { status: 'completed', deletedAt: '2026-10-18T03:00:00.000Z', completedAt: '2026-10-18T03:00:01.000Z' };
export const apiClient = {
  async get(path) {
    throw new Error(`Unexpected fixture read ${path}`);
  },
  async post(path) {
    const q = scenario();
    if (path === '/me/account-deletion/password-check') {
      if (q.get('check') === 'fail') throw httpError(400, 'ACCOUNT_DELETION_PASSWORD_MISMATCH');
      if (q.get('check') === 'role') throw httpError(409, 'ACCOUNT_DELETION_ROLE_RESTRICTED');
      return { data: { success: true, data: { verified: true } } };
    }
    if (path === '/me/account-deletion') {
      if (q.get('delete') === 'hang') return new Promise(() => {});
      if (q.get('delete') === 'unknown') throw networkError();
      return { data: { success: true, data: { deletion: receipt } } };
    }
    if (path === '/auth/account-deletion/status') throw networkError();
    throw new Error(`Unexpected fixture write ${path}`);
  },
};
export const useHeaderHeight = () => 0;
export async function endSession() {
  return { tokensRemoved: true, selectionRemoved: true };
}
export function resetToMembershipDeletionResultFromRef(params) {
  window.lastReset = params;
}
export function isOnMembershipDeletionResult() {
  return Boolean(window.lastReset);
}
export async function clearSelectedAccountId() {
  return true;
}
