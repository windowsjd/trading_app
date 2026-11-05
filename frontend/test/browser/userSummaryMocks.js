// 유저 시즌 요약 fixture transport (userSummaryBrowser.cjs). `?tier=` (`none` = no
// rank or tier), `?long=1` long nickname and amounts, `?rel=` none|sent|received|friend|error
// is the server's relationship; commands change it as the server would.
const params = new URLSearchParams(location.search);
const tier = params.get('tier') ?? 'bronze';
const long = params.get('long') === '1';
let relationship = params.get('rel') ?? 'none';
export const transport = { requests: [] };
const nickname = long ? '아주긴닉네임대한민국LongNickname'.repeat(2) : '브론즈트레이더';
const summary = (userId) => ({
  state: 'available',
  user: { id: userId, nickname: userId === 'viewer' ? '나의닉네임' : nickname, profileImageUrl: null },
  season: {
    id: 'season-1', name: '2026 시즌 0', status: 'active', rank: tier === 'none' ? null : long ? 123456 : 12,
    provisionalTier: tier === 'none' ? null : tier, finalTier: null, percentile: '50',
    returnRate: tier === 'none' ? null : long ? '-12345.67890000' : '12.34000000',
    totalAssetKrw: tier === 'none' ? null : long ? '1234567890123456.00000000' : '10450000.00000000',
    maxDrawdown: '0', totalFillCount: 3,
  },
  portfolioAccess: relationship === 'friend' ? 'private' : 'not_friend',
  portfolio: null,
});
const failure = () => Object.assign(new Error('fixture'), {
  isAxiosError: true, response: { status: 500, data: { success: false, error: { code: 'INTERNAL_SERVER_ERROR', message: 'fixture' } } },
});
export const apiClient = {
  get: async (path) => {
    transport.requests.push(`GET ${path}`);
    let data;
    const user = /^\/users\/([^/]+)\/season-summary$/.exec(path);
    if (user) data = summary(user[1]);
    else if (path === '/friends/relationships/target') {
      if (relationship === 'error') throw failure();
      data = { userId: 'target', relationship, requestId: relationship === 'none' ? null : 'req-1' };
    } else if (path === '/me') data = { id: 'viewer', nickname: '나의닉네임', profileImageUrl: null, role: 'user', status: 'active' };
    else throw Error(`Unexpected read: ${path}`);
    return { data: { success: true, data } };
  },
  post: async (path) => {
    transport.requests.push(`POST ${path}`);
    // Long enough to see the busy state.
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (path === '/friends/requests') relationship = 'sent';
    else if (path === '/friends/requests/req-1/accept') relationship = 'friend';
    else if (path === '/friends/requests/req-1/reject') relationship = 'none';
    else throw Error(`Unexpected command: ${path}`);
    return { data: { success: true, data: {} } };
  },
};
export const useRootNavigation = () => ({ navigate: () => {} });
