// 친구 요청 banner fixture boundaries (friendRequestBannerBrowser.cjs): the signed-in member on the
// main tabs, switches on, and the server's 받은 요청 list in `window.fixture.incoming`.
// `?seed=1`: one request already pending at the first read.
const seeded = new URLSearchParams(location.search).get('seed') === '1'
  ? [{ userId: 'u-old', nickname: '예전요청', profileImageUrl: null, relationship: 'received', requestId: 'r-old' }] : [];
export const fixture = { incoming: seeded, navigations: [], requests: [] };
window.fixture = fixture;
export const MAIN_ROUTES = new Set(['MainTabs']);
export const useSessionUserId = () => 'viewer';
export const useRootRouteName = () => 'MainTabs';
export const navigateTo = (intent) => { fixture.navigations.push(intent); };
export const rootNavigationRef = { isReady: () => true };
export const questNavigationAllowed = () => true;
const switches = { allEnabled: true, preferences: { tradeFill: true, futuresLiquidation: true, orderFailure: true, friendRequest: true,
  importantNotice: true, seasonFinalResult: true, seasonEndingSoon: true } };
export const apiClient = { get: async (path) => {
  fixture.requests.push(path);
  if (path === '/notifications/preferences') return { data: { success: true, data: switches } };
  if (path.startsWith('/friends/requests?')) {
    const users = [...fixture.incoming];
    return { data: { success: true, data: { users, pagination: { limit: 30, offset: 0, total: users.length, returned: users.length, nextOffset: null } } } };
  }
  throw Error(`Unexpected read: ${path}`);
} };
