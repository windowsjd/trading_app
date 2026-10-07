import { recordDetail, recordEquity } from '../recordFixtures';
import cryptoContract from '../../../backend/src/assets/fixtures/binance-crypto-hot-contract.json';
// The production screens, query observers and API mappers run unchanged.
// REST/WebSocket transport and navigation are the browser fixture boundaries.
import { apiClient as homeClient, navigation, transport } from './homeMocks';
export { navigation, transport };
export const useRootNavigation = () => navigation;
const params = new URLSearchParams(location.search);
const long = params.get('long') === '1';
if (params.has('navigation')) transport.accounts[0].season.seasonId = 'record-0';
navigation.reset = (...args) => navigation.calls.push(['reset', ...args]);
const response = (data) => ({ data: { success: true, data } });
const pagination = (offset, limit, total) => ({
  offset, limit, total, returned: Math.min(limit, total - offset),
  nextOffset: offset + limit < total ? offset + limit : null,
});
const tickerSnapshot = { tickersByAssetId: new Map(), staleAssetIds: new Set(), showReconnectBanner: false };
export const useMarketTickers = () => tickerSnapshot;

export const apiClient = {
  async post(path, body) {
    if (path.endsWith('/wallet-transfers/quote')) {
      transport.postRequests ??= []; transport.postRequests.push({ path, body });
      const fromCurrency = body.sourceWalletId.endsWith(':krw') ? 'KRW' : 'USD';
      transport.transferQuote = {
        tradingAccountId: path.split('/')[2], sourceWalletId: body.sourceWalletId, destinationWalletId: body.destinationWalletId,
        quoteId: 'fixture-transfer-quote', fromCurrency, toCurrency: fromCurrency === 'KRW' ? 'USD' : 'KRW', sourceAmount: body.amount,
        appliedRate: '1400.00000000', grossTargetAmount: '1000.00000000', netTargetAmount: '999.00000000', feeRate: '0.001000', feeAmount: '1.00000000', feeCurrency: fromCurrency === 'KRW' ? 'USD' : 'KRW',
        maxChangeBps: '30.0000', expiresAt: new Date(Date.now() + 15000).toISOString(), rateCapturedAt: new Date().toISOString(), rateEffectiveAt: new Date().toISOString(), rateSource: null,
      };
      return response(transport.transferQuote);
    }
    if (path.endsWith('/wallet-transfers/execute')) {
      transport.postRequests.push({ path, body });
      const q = transport.transferQuote;
      const wallet = (id, currencyCode) => ({ walletId: id, currencyCode, walletScope: id.endsWith(':krw') ? 'securities' : id.endsWith(':spot') ? 'crypto_spot' : 'crypto_futures', balanceAfter: '1234567.12345678', availableAfter: '1234000.12345678' });
      return response({ commandId: 'fixture-composite', quoteId: q.quoteId, tradingAccountId: q.tradingAccountId, executedAt: new Date().toISOString(),
        sourceAmount: q.sourceAmount, receivedAmount: '998.00000000', source: wallet(q.sourceWalletId, q.fromCurrency), destination: wallet(q.destinationWalletId, q.toCurrency), transferId: 'fixture-transfer',
        fx: { ...q, exchangeId: 'fixture-exchange', quotedRate: q.appliedRate, appliedRate: '1401.00000000', netTargetAmount: '998.00000000' },
      });
    }
    if (path.endsWith('/wallet-transfers')) {
      transport.postRequests ??= []; transport.postRequests.push({ path, body });
      const walletScope = id => id.endsWith(':usd') ? 'securities' : id.endsWith(':spot') ? 'crypto_spot' : 'crypto_futures';
      return response({ tradingAccountId: path.split('/')[2], transferId: 'fixture-transfer', currencyCode: 'USD', amount: body.amount, executedAt: new Date().toISOString(),
        source: { walletId: body.sourceWalletId, walletScope: walletScope(body.sourceWalletId), balanceAfter: '40.39000000', availableAfter: '20.39000000' },
        destination: { walletId: body.destinationWalletId, walletScope: walletScope(body.destinationWalletId), balanceAfter: '510.12000000', availableAfter: '410.12000000' },
      });
    }
    return response({});
  },
  async get(path, config) {
    const url = new URL(path, 'https://fixture.invalid');
    const offset = Number(url.searchParams.get('offset') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 20);
    if (url.pathname === '/assets') {
      transport.requests.push(path);
      if (params.has('cryptoContract') && url.searchParams.get('assetType') === 'crypto') {
        return response({ sortSnapshot: 'crypto-writer-contract',
          pagination: pagination(offset, limit, cryptoContract.assets.length),
          assets: cryptoContract.assets.slice(offset, offset + limit) });
      }
      const page = pagination(offset, limit, 44);
      return response({ sortSnapshot: url.searchParams.get('sortSnapshot') ?? `fixture-${url.searchParams.get('sortBy')}-${url.searchParams.get('sortOrder')}-${url.searchParams.get('assetType')}`, pagination: page, assets: Array.from({ length: page.returned }, (_, i) => ({
        id: `asset-${offset + i}`, assetType: url.searchParams.get('assetType') ?? 'domestic_stock',
        symbol: '005930', name: long ? '대한민국 미래산업 우량주 투자기업 우선주' : '삼성전자',
        market: 'KRX', priceCurrency: 'KRW', settlementCurrency: 'KRW',
        turnover: String(1000000 - offset - i), turnoverPeriod: url.searchParams.get('assetType') === 'crypto' ? 'rolling_24h' : 'session',
        isActive: true, marketStatus: url.searchParams.get('assetType') === 'crypto' ? 'always_open' : params.get('session') ?? 'open',
        tradable: params.get('session') !== 'closed', tradeBlockedReason: params.get('session') === 'closed' ? 'MARKET_CLOSED' : null,
        price: { state: 'available', currentPrice: params.has('hugePrice') ? '1234567890123456' : '70000', priceCurrency: 'KRW', changeRate: ['1.25', '-3.52', '0', null][i % 4] },
      })) });
    }
    if (url.pathname === '/ranking' && limit > 1) {
      transport.requests.push(path);
      const friendScope = params.has('separateScopes') && url.searchParams.get('scope') === 'friends';
      const rankOffset = friendScope ? 40 : offset;
      const page = pagination(offset, limit, friendScope ? 2 : url.searchParams.get('scope') === 'top10' ? 10 : 53);
      const rankings = Array.from({ length: page.returned }, (_, i) => ({
        seasonParticipantId: `participant-${rankOffset + i}`, userId: `user-${rankOffset + i}`,
        profileImageUrl: params.get('profile') === 'valid' ? `${location.origin}/avatar.svg` : params.get('profile') === 'broken' ? `${location.origin}/missing-avatar.png` : null,
        rank: params.has('hugeRank') ? 123456789 : rankOffset + i + 1, nickname: long ? '아주긴닉네임대한민국투자챔피언ABCDEFGHIJKLMNOPQRSTUVWXYZ' : `투자자 ${offset + i + 1}`,
        provisionalTier: long ? 'Silver 대한민국 특별 경쟁 등급' : 'Silver', finalTier: 'Gold',
        returnRate: '4.82', percentile: '99.5', totalAssetKrw: '10482000',
        maxDrawdown: '0', totalFillCount: 3, capturedAt: '2026-09-01T00:00:00Z',
      }));
      return response({
        state: 'available', pagination: page, rankings,
        season: { id: 'season-1', status: params.get('state') === 'settled' ? 'settled' : 'active' },
        myRanking: { ...rankings[0], state: 'available' },
        rankType: url.searchParams.get('rankType') ?? 'daily', rankingDate: '2026-09-01', capturedAt: '2026-09-01T00:00:00Z',
      });
    }
    if (url.pathname === '/records/me/seasons') {
      transport.requests.push(path);
      const page = pagination(offset, limit, 23);
      return response({ pagination: page, seasons: Array.from({ length: page.returned }, (_, i) => ({
        seasonId: `record-${offset + i}`, seasonName: long ? '대한민국 모의투자 챔피언십 특별 경쟁 시즌' : `Season ${offset + i + 1}`,
        joinedAt: '2026-09-01T00:00:00Z', finalRank: i + 1,
        finalTier: long ? 'Gold 대한민국 특별 경쟁 등급' : 'Gold', finalReturnRate: '4.82',
      })) });
    }
    if (params.has('navigation')) {
      transport.requests.push(path);
      if (url.pathname === '/records/me/seasons/record-0') return response(recordDetail({ state: params.get('recordState') ?? 'available', status: params.get('recordStatus') ?? 'settled', long }));
      if (url.pathname === '/records/me/seasons/record-0/equity') return response(recordEquity);
      if (/^\/trading-accounts\/[^/]+\/orders$/.test(path)) return response({ state: 'available', tradingAccountId: path.split('/')[2], orders: [], pagination: pagination(0, 20, 0) });
      if (/^\/trading-accounts\/[^/]+\/wallet-transactions$/.test(path)) return response({ tradingAccountId: path.split('/')[2], filters: { currency: config?.params?.currency ?? null, direction: config?.params?.direction ?? null, txType: config?.params?.txType ?? null }, transactions: [], pagination: pagination(0, 20, 0) });
      const account = transport.accounts.find((a) => path === `/trading-accounts/${a.id}`);
      if (account) return response(account);
      if (url.pathname === '/fx/rates/current') return response({ state: 'unavailable' });
    }
    return homeClient.get(path, config);
  },
};

export const getRequestGeneration = () => 0;
