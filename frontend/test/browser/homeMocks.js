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
export const navigation = { calls: [], navigate(...args) { this.calls.push(args); if (window.fixture?.navigationRef?.isReady()) window.fixture.navigationRef.navigate(...args); } };
export const useRootNavigation = () => navigation;
const response = (data) => ({ data: { success: true, data } });
export const apiClient = {
  async get(path, config) {
    transport.requests.push(path);
    if (path === '/me') return response({
      id: 'home-user', nickname: long ? '아주긴닉네임대한민국투자챔피언김재민ABCDEFGHIJKLMNOPQRSTUVWXYZ' : '김재민',
      role: 'user', status: 'active', email: 'home@example.invalid',
      profileImageUrl: params.get('profile') === 'valid' ? `${location.origin}/avatar.svg` : params.get('profile') === 'broken' ? `${location.origin}/missing-avatar.png` : null, createdAt: base.createdAt, portfolioPublic: true,
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
    if (path.endsWith('/wallets')) return response({ tradingAccountId: account.id, wallets: params.has('holdings') ? [
      { currencyCode: 'KRW', balance: long ? '1234567890123456' : account.mode === 'general' ? '9900000' : '8800000' },
      { currencyCode: 'USD', balance: long ? '1234567890123.45' : '50.39' },
    ] : [] });
    if (path.endsWith('/positions')) {
      const offset = config?.params?.offset ?? 0, limit = config?.params?.limit ?? 20;
      if (transport.delay === `${account.id}:positions`) await new Promise((resolve) => transport.pending.push(resolve));
      const total = params.has('holdings') ? (params.has('many') ? 207 : 7) : 0;
      const positions = Array.from({ length: Math.min(limit, total - offset) }, (_, index) => {
        const i = offset + index, currency = i % 3 === 0 ? 'KRW' : 'USD';
        const hierarchy = params.get('positionFixtures') === 'hierarchy';
        const available = { state: 'available', currentPrice: '1', priceCurrency: currency,
          positionValue: long ? currency === 'KRW' ? '1234567890123456' : '1234567890123.45' : hierarchy ? ['1120000', '123456.78', '123456.78'][i % 3] : ['1120000', '530.25', '146.88'][i % 3],
          positionValueKrw: '9999999', returnRate: hierarchy ? ['4.82', '123.45', '-99.12', '0'][i % 4] : ['123.45', '-99.12', '0'][i % 3],
          unrealizedPnl: '10', unrealizedPnlKrw: '10', priceSource: null };
        return { positionId: `${account.id}-position-${i}`, assetId: `${account.id}-asset-${i}`, symbol: ['005930', 'AAPL', 'BTCUSDT'][i % 3],
          name: long ? '대한민국 미래산업 우량주 투자기업 우선주 ABCDEFGHIJKLMNOPQRSTUVWXYZ' : hierarchy ? ['삼성전자', 'Berkshire Hathaway Class B', 'Bitcoin'][i % 3] : ['삼성전자', 'Apple', 'Bitcoin'][i % 3],
          assetType: ['domestic_stock', 'us_stock', 'crypto'][i % 3], market: ['KRX', 'NASDAQ', 'BINANCE'][i % 3],
          currencyCode: currency, quantity: hierarchy ? ['10.000000', '0.12345600', '0.00080500'][i % 3] : '0.00080500', averageCost: '999999',
          valuation: i === 4 ? { ...available, state: 'stale_cache' } : i === 5 ? { state: 'unavailable', reason: 'ASSET_PRICE_UNAVAILABLE', message: 'internal' } : available };
      });
      return response({ state: 'available', tradingAccountId: account.id, positions,
        pagination: { offset, limit, total, returned: positions.length, nextOffset: offset + positions.length < total ? offset + positions.length : null } });
    }
    throw new Error(`Unexpected fixture request: ${path}`);
  },
};
