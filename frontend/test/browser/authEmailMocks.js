// Only transport/session effects are mocked. Screens, hook, error mapper,
// theme, keyboard scroll and button components use production code.
window.authCalls = [];
const stamp = delta => new Date(Date.now() + delta).toISOString();
export const apiClient = {
  async post(path, payload) {
    window.authCalls.push(path);
    if (path === '/auth/email/request') {
      if (window.holdSend) await new Promise(resolve => { window.releaseSend = resolve; });
      if (window.failSend) throw Object.assign(new Error('timeout'), { isAxiosError: true, code: 'ECONNABORTED', request: {} });
      return { data: { data: { challengeId: 'fixture', serverTime: stamp(0), expiresAt: stamp(window.expiredCode ? -1_000 : 600_000), resendAt: stamp(window.cooldown ? 60_000 : 0), message: '입력하신 이메일로 계정이 등록되어 있다면 인증번호가 발송됩니다.' } } };
    }
    if (path === '/auth/email/verify') {
      if (window.failCode) throw { isAxiosError: true, response: { status: 400, data: { error: { code: 'EMAIL_CODE_INVALID' } } } };
      return { data: { data: { verificationToken: 'fixture-proof', serverTime: stamp(0), expiresAt: stamp(600_000) } } };
    }
    if (path === '/auth/password/reset') {
      if (window.holdReset) await new Promise(resolve => { window.releaseReset = resolve; });
      return { data: { data: { changed: true } } };
    }
    if (path === '/auth/login' || path === '/auth/signup') return { data: { data: { user: { id: 'fixture-user', status: 'active' }, tokens: {} } } };
    throw new Error('Unexpected fixture request');
  },
};
export async function authenticateSession(_client, work) { return { ...(await work()), generation: 1 }; }
export async function endSession() {}
export function useEnterApp() { return async () => { window.enteredApp = true; }; }
export function isCurrentSession() { return true; }
export class SessionSupersededError extends Error {}
