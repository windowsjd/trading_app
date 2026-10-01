// Test transport only. Production Home, account provider, cache, selection
// storage, API wrappers, appearance and AccountSwitcher all run unchanged.
const params = new URLSearchParams(location.search);
const long = params.get('long') === '1';
const variant = params.get('state');
const base = {
  status: 'active', initialCapitalKrw: '10000000',
  openedAt: '2026-09-01T00:00:00Z', closedAt: null,
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
};
const season = {
  seasonId: 'season-1', seasonName: long ? 'Season 1 대한민국 모의투자 챔피언십' : 'Season 1',
  seasonStatus: ['upcoming', 'ended', 'settled'].includes(variant) ? variant : 'active',
  participantStatus: ['registered', 'excluded', 'finished'].includes(variant) ? variant : 'active',
  startAt: '2020-01-01T00:00:00Z', endAt: '2099-01-01T00:00:00Z',
  seasonParticipantId: 'participant-1', joinedAt: '2026-09-01T00:00:00Z',
};
export const transport = {
  requests: [], pending: [], delay: null,
  release() { this.pending.splice(0).forEach((resolve) => resolve()); },
  accounts: [
    { ...base, id: 'season-account', mode: 'season', season, status: ['suspended', 'closed'].includes(variant) ? variant : 'active' },
    { ...base, id: 'general-account', mode: 'general', season: null },
  ],
};
export const navigation = { calls: [], navigate(...args) { this.calls.push(args); } };
export const useRootNavigation = () => navigation;
const response = (data) => ({ data: { success: true, data } });
export const apiClient = {
  async get(path) {
    transport.requests.push(path);
    if (path === '/me') return response({
      id: 'home-user', nickname: long ? '아주긴닉네임대한민국투자챔피언김재민ABCDEFGHIJKLMNOPQRSTUVWXYZ' : '김재민',
      role: 'user', status: 'active', email: 'home@example.invalid',
      profileImageUrl: null, createdAt: base.createdAt, portfolioPublic: true,
    });
    if (path === '/trading-accounts') return response({ accounts: transport.accounts });
    if (path === '/seasons/current') return response({
      id: season.seasonId, name: season.seasonName, status: season.seasonStatus,
      startAt: season.startAt, endAt: season.endAt, joined: true,
    });
    if (path.startsWith('/ranking?')) {
      if (variant === 'ranking-error' || variant === 'ranking-integrity') throw {
        response: { status: 500, data: { error: { code: variant === 'ranking-integrity' ? 'SEASON_RANKING_SCOPE_MISMATCH' : 'NETWORK_ERROR' } } },
      };
      return response({
        state: variant === 'unranked' ? 'unavailable' : 'available',
        season: { id: season.seasonId, name: season.seasonName, status: season.seasonStatus },
        rankType: season.seasonStatus === 'settled' ? 'final' : 'daily',
        rankings: [], pagination: { nextOffset: null },
        myRanking: variant === 'unranked'
          ? { state: 'unavailable', reason: 'MY_RANKING_UNAVAILABLE' }
          : { state: 'available', rank: long ? 123456789 : 2,
              provisionalTier: long ? 'Silver 대한민국 모의투자 특별 등급' : 'Silver', finalTier: 'Gold' },
      });
    }
    const account = transport.accounts.find((item) => path.split('/')[2] === item.id);
    if (!account) throw new Error(`Unexpected fixture request: ${path}`);
    const returnRateMethod = account.mode === 'season' ? 'initial_capital' : 'time_weighted';
    if (path.endsWith('/portfolio')) {
      if (transport.delay === account.id || variant === 'loading') await new Promise((resolve) => transport.pending.push(resolve));
      if (variant === 'portfolio-error') throw new Error('Test network error');
      return response({
        tradingAccountId: account.id, mode: account.mode, status: account.status,
        state: variant === 'empty-summary' ? 'unavailable' : 'available', sectionErrors: [],
        summary: variant === 'empty-summary' ? null : {
          totalAssetKrw: long ? '1234567890123456' : account.mode === 'season' ? '9648192' : '12530200',
          returnRate: account.mode === 'season' ? '-3.52' : '4.82', returnRateMethod,
          unrealizedPnlKrw: '-351885', realizedPnlKrw: '12000',
          krwCash: '1000000', usdCashKrw: '1000000', assetValueKrw: '7648192',
          initialFundingKrw: '10000000', cumulativeExternalFundingKrw: '0',
          cumulativeAdRewardKrw: '0', investmentPnlKrw: '2530200',
        },
        allocation: { state: 'available', cashKrwValue: '2000000', domesticStockValueKrw: '7648192', usStockValueKrw: '0', cryptoValueKrw: '0' },
      });
    }
    if (path.endsWith('/portfolio/equity')) return response({
      tradingAccountId: account.id, mode: account.mode, state: 'empty',
      range: '30d', granularity: 'daily', returnRateMethod, points: [],
    });
    if (path.endsWith('/wallets')) return response({ tradingAccountId: account.id, wallets: [] });
    if (path.endsWith('/positions')) return response({ tradingAccountId: account.id, positions: [] });
    throw new Error(`Unexpected fixture request: ${path}`);
  },
};
