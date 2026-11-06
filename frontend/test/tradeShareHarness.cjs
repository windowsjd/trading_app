// 거래 내역 › 거래 완료 (CompletedTrades) with its 수익 공유 sheet and card, over
// fake completed-trades and /me transports. The device share layer
// (features/share/shareImage) is a recording boundary: tests choose what each
// native call answers and see exactly which calls were made.
const React = require('react');
const { create, act } = require('react-test-renderer');
const query = require('@tanstack/react-query');
const { resolve } = require('node:path');
const { load } = require('./ledgerTestHarness.cjs');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function deferred() {
  let settle;
  let fail;
  const promise = new Promise((resolvePromise, rejectPromise) => { settle = resolvePromise; fail = rejectPromise; });
  return { promise, resolve: settle, reject: fail };
}

function futuresTrade(overrides = {}) {
  return { kind: 'futures', key: 'futures:lifetime-1', assetId: 'asset-btc', symbol: 'BTCUSDT', name: 'Bitcoin', market: 'BINANCE',
    direction: 'long', currencyCode: 'USD', entryMargin: '4454.20000000', realizedPnl: '152.34000000', returnRate: '3.42000000',
    positionId: 'lifetime-1', leverage: 10, marginMode: 'isolated', closeKind: 'closed', completedAt: '2026-11-05T12:44:04.000Z',
    averageEntryPrice: '80958.27000000', averageExitPrice: '85681.22000000', displayPriceDecimals: 2, ...overrides };
}
function spotTrade(overrides = {}) {
  return { kind: 'spot', key: 'spot:asset-samsung', assetId: 'asset-samsung', symbol: '005930', name: 'Samsung Electronics',
    market: 'KRX', assetType: 'domestic_stock', currencyCode: 'KRW', buyAmount: '1061060.00000000', realizedPnl: '-62815.00000005',
    returnRate: '-5.92002337', completedAt: '2026-11-05T06:30:00.000Z', averageBuyPrice: '70666.66666667',
    averageSellPrice: '75000.00000000', displayPriceDecimals: null, ...overrides };
}

/** @param {{ platform?: string, appId?: string | null, supported?: boolean, trades?: object[], accountId?: string }} options */
function tradeShareHarness(options = {}) {
  const h = {
    accountId: options.accountId ?? 'season-1',
    me: { id: 'user-1', email: 'a@b.c', nickname: 'User-923a3', profileImageUrl: null, role: 'user', status: 'active', createdAt: '2026-01-01T00:00:00.000Z', portfolioPublic: true },
    trades: options.trades ?? [futuresTrade(), spotTrade()],
    reads: [],
    calls: [],
    /** Installed apps by Android package or iOS scheme. */
    installed: new Set(['com.instagram.android', 'com.kakao.talk', 'org.telegram.messenger', 'instagram-stories://share', 'kakaotalk://', 'tg://']),
    /** Per native call: an outcome string, a function returning a promise, or an Error to throw. */
    answers: {},
  };
  const answer = (name, fallback) => {
    const next = h.answers[name];
    if (typeof next === 'function') return next();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next ?? fallback);
  };
  const shareImage = {
    SHARE_CAPTURE_SUPPORTED: options.supported ?? true,
    captureShareCard: (ref) => { h.calls.push({ name: 'capture', target: ref?.current?.testID ?? null }); return answer('capture', { uri: `file:///cache/card-${h.calls.length}.png` }); },
    isShareAppInstalled: async (app) => { h.calls.push({ name: 'installed', app }); return h.installed.has(app.packageName ?? app.scheme); },
    shareToInstagramStory: (image, appId) => { h.calls.push({ name: 'instagram', image, appId }); return answer('instagram', 'opened'); },
    shareToTelegram: (image) => { h.calls.push({ name: 'telegram', image }); return answer('telegram', 'opened'); },
    openShareSheet: (image, hint) => { h.calls.push({ name: 'sheet', image, hint }); return answer('sheet', 'shared'); },
    saveToPhotos: (image) => { h.calls.push({ name: 'save', image }); return answer('save', 'saved'); },
  };
  const native = Object.fromEntries(['View', 'Text', 'ScrollView', 'Pressable', 'Image', 'RefreshControl'].map((name) => [name, name]));
  Object.assign(native, {
    Platform: { OS: options.platform ?? 'android' },
    PixelRatio: { get: () => 3 },
    StyleSheet: { create: (value) => value, flatten: (value) => value },
    Keyboard: { addListener: () => ({ remove() {} }), dismiss() {} },
    BackHandler: { addEventListener: () => ({ remove() {} }) },
    useWindowDimensions: () => ({ width: 390, height: 844, fontScale: 1 }),
    FlatList: ({ data, renderItem, keyExtractor, ListHeaderComponent, ListEmptyComponent, ListFooterComponent, ...props }) =>
      React.createElement('FlatList', props, ListHeaderComponent,
        ...(data.length ? data.map((item, index) => React.cloneElement(renderItem({ item, index }), { key: keyExtractor(item) })) : [ListEmptyComponent]),
        ListFooterComponent),
  });
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const List = load(resolve(__dirname, '../src/screens/history/CompletedTrades.tsx'), {
    'react-native': native,
    '@react-navigation/native': { useIsFocused: () => true },
    '../../features/tradingAccount/api': {
      getCompletedTrades: async (accountId) => {
        h.reads.push(accountId);
        if (h.readFailure) throw h.readFailure;
        return { tradingAccountId: h.answerAccountId ?? accountId, items: h.trades, hasMore: !!h.hasMore };
      },
    },
    '../../features/me/api': { getMe: async () => { if (h.meFailure) throw h.meFailure; return h.me; } },
    '../../features/share/shareImage': shareImage,
    '../../features/share/shareConfig': { META_APP_ID: options.appId === undefined ? '123456789012345' : options.appId },
    '../../components/common/CTAButton': { default: 'CTAButton', __esModule: true },
    '../../components/states/ErrorNotice': { default: 'ErrorNotice', __esModule: true },
  }).default;
  const tree = () => React.createElement(query.QueryClientProvider, { client },
    React.createElement(List, { key: h.accountId, accountId: h.accountId, header: React.createElement('Text', { testID: 'header' }, 'header') }));
  h.flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };
  // Host refs resolve to the element's testID, so a capture shows which view it was given.
  h.start = async () => { await act(async () => { h.renderer = create(tree(), { createNodeMock: (element) => ({ testID: element.props.testID }) }); }); await h.flush(); };
  h.update = async () => { await act(async () => h.renderer.update(tree())); await h.flush(); };
  h.node = (id) => h.renderer.root.findAll((n) => typeof n.type === 'string' && n.props.testID === id)[0];
  h.has = (id) => h.node(id) !== undefined;
  h.press = async (id) => { await act(async () => h.node(id).props.onPress()); await h.flush(); };
  /** Two presses in the same tick (a double tap), then settle. */
  h.doublePress = async (id) => { await act(async () => { const target = h.node(id).props; target.onPress(); target.onPress(); }); await h.flush(); };
  const words = (n) => [n.props.children].flat(Infinity).filter((v) => typeof v === 'string' || typeof v === 'number').join('');
  h.words = (id) => { const target = h.node(id); return target ? words(target) : null; };
  h.text = (root = h.renderer.root) => root.findAll((n) => n.type === 'Text').map(words).join(' ');
  /** The card's pictures report loaded (the art, and the profile photo when one is drawn). */
  h.loadPictures = async () => {
    await act(async () => {
      for (const image of h.renderer.root.findAll((n) => n.type === 'Image' && typeof n.props.onLoad === 'function')) image.props.onLoad();
      for (const avatar of h.renderer.root.findAll((n) => n.type === 'ProfileAvatar' && n.props.profileImageUrl)) avatar.props.onImageSettled?.();
    });
    await h.flush();
  };
  h.open = async (key) => { await h.press(`completed-trade-${key}-share`); await h.loadPictures(); };
  h.closeSheet = async () => {
    const sheet = h.renderer.root.find((n) => typeof n.type !== 'string' && n.props.testID === 'trade-share-sheet');
    await act(async () => sheet.props.onClose()); await h.flush();
  };
  h.status = () => h.words('trade-share-status');
  h.close = async () => { await act(async () => h.renderer.unmount()); client.clear(); };
  return h;
}

module.exports = { tradeShareHarness, futuresTrade, spotTrade, deferred, act };
