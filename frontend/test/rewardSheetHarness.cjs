// The general home's 보상 sheet (GeneralRewardSheet) over a fake transport and
// an optional fake rewarded-ad provider (AdMob-shaped, 2026-11-07). Tests
// only: nothing here is reachable from the app bundle.
const React = require('react');
const { create, act } = require('react-test-renderer');
const query = require('@tanstack/react-query');
const { resolve } = require('node:path');
const { load } = require('./ledgerTestHarness.cjs');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function eligibility(overrides = {}) {
  return { tradingAccountId: 'G', enabled: true, provider: 'admob', eligible: true, reason: null,
    rewardAmountKrw: '5000000.00000000', grantedCountToday: 0, grantedAmountTodayKrw: '0.00000000',
    remainingCountToday: 3, remainingAmountTodayKrw: '15000000.00000000', nextEligibleAt: null, ...overrides };
}
function resetEligibility(overrides = {}) {
  return { tradingAccountId: 'G', enabled: true, provider: 'admob', eligible: true, reason: null, blockers: [],
    targetKrwBalance: '10000000.00000000', resetCount: 0, lastResetAt: null, ...overrides };
}
const coded = (status, code) => Object.assign(new Error(code), { response: { status, data: { error: { code } } } });
/** "Google has not confirmed the watched ad yet" — the server's PENDING answer. */
const pending = () => coded(409, 'AD_REWARD_VERIFICATION_PENDING');

// A fresh sign-in generation per harness: remembered attempts never leak between tests.
let generations = 0;
// The real rules module, shared like the app's single instance, with short confirmation waits.
const rewardFlow = require(resolve(__dirname, '../src/features/adRewards/rewardFlow.ts'));

function rewardSheetHarness(options = {}) {
  const h = { requests: [], reads: [], invalidations: [], shows: [], sessions: [], funding: eligibility(options.funding),
    reset: resetEligibility(options.reset), failures: [], sessionFailures: [], pendingAnswers: options.pendingAnswers ?? 0,
    adOutcome: { status: 'earned' }, adsReady: options.adsReady ?? { canRequestAds: true, privacyOptionsRequired: false },
    privacyOpened: 0, generation: ++generations };
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = client.invalidateQueries.bind(client);
  client.invalidateQueries = (config) => { h.invalidations.push(config?.queryKey ?? []); return invalidate(config); };
  const command = (path) => async (accountId, body) => {
    h.requests.push({ path: `/trading-accounts/${accountId}${path}`, body });
    const failure = h.failures.shift();
    if (failure) throw failure;
    if (h.pendingAnswers > 0) { h.pendingAnswers -= 1; throw pending(); }
    return path === '/ad-rewards/claim'
      ? { granted: true, duplicate: false, claimId: 'claim-1', grantedAt: new Date().toISOString(), walletBalanceAfter: '15000000.00000000' }
      : { reset: true, duplicate: false, resetId: 'reset-1', claimId: 'claim-2', sequence: 1, resetAt: new Date().toISOString(),
        totalAssetKrw: '10000000.00000000', wallets: [] };
  };
  const api = {
    getAdRewardEligibility: async (id) => { h.reads.push(`funding:${id}`); return h.funding; },
    getAccountResetEligibility: async (id) => { h.reads.push(`reset:${id}`); return h.reset; },
    createAdRewardSession: async (accountId, body) => {
      h.sessions.push({ accountId, ...body });
      const failure = h.sessionFailures.shift();
      if (failure) throw failure;
      const sessionId = `session-${h.sessions.length}`;
      return { sessionId, tradingAccountId: accountId, provider: 'admob', purpose: body.purpose, platform: body.platform, created: true,
        expiresAt: new Date(Date.now() + 1_800_000).toISOString(), ssv: { userId: `ssv-user-${h.sessions.length}`, customData: sessionId } };
    },
    claimAdReward: command('/ad-rewards/claim'),
    resetGeneralAccount: command('/account-reset'),
  };
  const native = Object.fromEntries(['View', 'Text', 'ScrollView', 'Pressable'].map((name) => [name, name]));
  Object.assign(native, { Platform: { OS: 'android' }, StyleSheet: { create: (value) => value },
    Keyboard: { addListener: () => ({ remove() {} }), dismiss() {} }, BackHandler: { addEventListener: () => ({ remove() {} }) },
    useWindowDimensions: () => ({ width: 360, height: 760, fontScale: 1 }) });
  const sheet = load(resolve(__dirname, '../src/screens/home/GeneralRewardSheet.tsx'), {
    'react-native': native,
    '../../features/tradingAccount/api': api,
    '../../components/common/CTAButton': { default: 'CTAButton', __esModule: true },
    '../../components/states/ErrorNotice': { default: 'ErrorNotice', __esModule: true },
    '../../features/adRewards/rewardFlow': { ...rewardFlow, REWARD_CONFIRM_POLL_MS: 5, REWARD_CONFIRM_WAIT_MS: options.confirmWaitMs ?? 60 },
    '../../features/ads/adsRuntime': {
      ensureAdsReady: () => (h.adsReady ? Promise.resolve(h.adsReady) : Promise.reject(new Error('no SDK'))),
      showAdsPrivacyOptions: () => { h.privacyOpened += 1; return Promise.resolve({ canRequestAds: true, privacyOptionsRequired: true }); },
    },
    '../../services/api/sessionOwnership': {
      getSessionGeneration: () => h.generation,
      isCurrentSession: (owner) => owner === h.generation,
    },
  });
  const provider = options.provider === null ? null : {
    key: 'admob',
    platform: 'android',
    show: async (input) => {
      h.shows.push(input);
      input.onPhase?.('loading');
      if (h.showGate) await h.showGate;
      input.onPhase?.('showing');
      return h.adOutcome;
    },
  };
  h.visible = true;
  h.accountId = 'G';
  h.mode = 'general';
  h.closed = 0;
  h.mountKey = 0;
  const tree = () => React.createElement(query.QueryClientProvider, { client },
    React.createElement(sheet.default, { key: h.mountKey, visible: h.visible, account: { id: h.accountId, mode: h.mode, status: 'active' },
      onClose: () => { h.closed += 1; }, provider }));
  h.flush = async (ms = 20) => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
  h.start = async () => { await act(async () => { h.renderer = create(tree()); }); await h.flush(); };
  h.node = (id) => h.renderer.root.findAll((n) => typeof n.type === 'string' && n.props.testID === id)[0];
  h.has = (id) => h.node(id) !== undefined;
  h.press = async (id) => { await act(async () => h.node(id).props.onPress()); await h.flush(); };
  h.state = (id) => h.node(id)?.props.state;
  // One string per Text (its pieces joined as rendered), Texts separated by a space.
  h.text = () => h.renderer.root.findAll((n) => n.type === 'Text').map((n) => [n.props.children].flat(Infinity)
    .filter((v) => typeof v === 'string' || typeof v === 'number').join('')).join(' ');
  // Home hides the sheet (blur, account change) by re-rendering it invisible.
  h.setVisible = async (visible) => { h.visible = visible; await act(async () => h.renderer.update(tree())); await h.flush(); };
  h.update = async () => { await act(async () => h.renderer.update(tree())); await h.flush(); };
  /** A fresh mount of the sheet for the same sign-in and account (Home keyed it again). */
  h.remount = async () => { h.mountKey += 1; await h.update(); };
  // The sheet's own close (backdrop, back, 닫기) as InlineBottomSheet calls it.
  h.dismiss = async () => {
    const sheetNode = h.renderer.root.find((n) => typeof n.type !== 'string' && n.props.testID === 'home-reward-sheet');
    await act(async () => sheetNode.props.onClose()); await h.flush();
  };
  h.notices = () => h.renderer.root.findAll((n) => n.type === 'ErrorNotice');
  h.close = async () => { await act(async () => h.renderer.unmount()); client.clear(); };
  h.ButtonHost = sheet.HomeRewardButton;
  return h;
}

module.exports = { rewardSheetHarness, eligibility, resetEligibility, coded };
