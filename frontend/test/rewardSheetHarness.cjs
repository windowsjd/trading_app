// The general home's 보상 sheet (GeneralRewardSheet) over a fake transport and
// an optional fake rewarded-ad provider. Tests only: production has no
// provider, and nothing here is reachable from the app bundle.
const React = require('react');
const { create, act } = require('react-test-renderer');
const query = require('@tanstack/react-query');
const { resolve } = require('node:path');
const { load } = require('./ledgerTestHarness.cjs');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function eligibility(overrides = {}) {
  return { tradingAccountId: 'G', enabled: true, provider: 'test-ads', eligible: true, reason: null,
    rewardAmountKrw: '5000000.00000000', grantedCountToday: 0, grantedAmountTodayKrw: '0.00000000',
    remainingCountToday: 3, remainingAmountTodayKrw: '15000000.00000000', nextEligibleAt: null, ...overrides };
}
function resetEligibility(overrides = {}) {
  return { tradingAccountId: 'G', enabled: true, provider: 'test-ads', eligible: true, reason: null, blockers: [],
    targetKrwBalance: '10000000.00000000', resetCount: 0, lastResetAt: null, ...overrides };
}

function rewardSheetHarness(options = {}) {
  const h = { requests: [], reads: [], invalidations: [], shows: [], funding: eligibility(options.funding),
    reset: resetEligibility(options.reset), failures: [], adOutcome: { status: 'completed', proof: 'proof-1' } };
  const client = new query.QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const invalidate = client.invalidateQueries.bind(client);
  client.invalidateQueries = (config) => { h.invalidations.push(config?.queryKey ?? []); return invalidate(config); };
  const command = (path) => async (accountId, body) => {
    h.requests.push({ path: `/trading-accounts/${accountId}${path}`, body });
    const failure = h.failures.shift();
    if (failure) throw failure;
    return path === '/ad-rewards/claim'
      ? { granted: true, duplicate: false, claimId: 'claim-1', grantedAt: new Date().toISOString(), walletBalanceAfter: '15000000.00000000' }
      : { reset: true, duplicate: false, resetId: 'reset-1', claimId: 'claim-2', sequence: 1, resetAt: new Date().toISOString(),
        totalAssetKrw: '10000000.00000000', wallets: [] };
  };
  const api = {
    getAdRewardEligibility: async (id) => { h.reads.push(`funding:${id}`); return h.funding; },
    getAccountResetEligibility: async (id) => { h.reads.push(`reset:${id}`); return h.reset; },
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
  });
  const provider = options.provider === null ? null : {
    key: 'test-ads',
    show: async (input) => { h.shows.push(input); return h.adOutcome; },
  };
  h.visible = true;
  h.closed = 0;
  const tree = () => React.createElement(query.QueryClientProvider, { client },
    React.createElement(sheet.default, { visible: h.visible, account: { id: 'G', mode: 'general', status: 'active' },
      onClose: () => { h.closed += 1; }, provider }));
  h.flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 20)); }); };
  h.start = async () => { await act(async () => { h.renderer = create(tree()); }); await h.flush(); };
  h.node = (id) => h.renderer.root.findAll((n) => typeof n.type === 'string' && n.props.testID === id)[0];
  h.press = async (id) => { await act(async () => h.node(id).props.onPress()); await h.flush(); };
  h.state = (id) => h.node(id)?.props.state;
  // One string per Text (its pieces joined as rendered), Texts separated by a space.
  h.text = () => h.renderer.root.findAll((n) => n.type === 'Text').map((n) => [n.props.children].flat(Infinity)
    .filter((v) => typeof v === 'string' || typeof v === 'number').join('')).join(' ');
  // Home hides the sheet (blur, account change) by re-rendering it invisible.
  h.setVisible = async (visible) => { h.visible = visible; await act(async () => h.renderer.update(tree())); await h.flush(); };
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

module.exports = { rewardSheetHarness, eligibility, resetEligibility };
