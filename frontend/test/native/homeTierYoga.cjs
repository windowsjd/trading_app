// Diagnostic with Native Yoga defaults, not an Android/iOS device screenshot.
// Run with YOGA_LAYOUT_MODULE=/absolute/path/to/yoga-layout/dist/src/index.js
// Text uses a controlled 96x27dp measure; production component styles are real.
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { interactionHarness, React, act, flatten } = require('../interactionTestHarness.cjs');
(async () => {
  const { default: Yoga } = await import(pathToFileURL(process.env.YOGA_LAYOUT_MODULE || require.resolve('yoga-layout')).href);
  const h = interactionHarness('android');
  const account = { id: 'season', mode: 'season', status: 'active', season: {
    seasonId: 's1', seasonName: 'Season 1', seasonStatus: 'active', participantStatus: 'active',
  } };
  const Switcher = h.load('src/components/tradingAccount/AccountSwitcher.tsx', {
    '@tanstack/react-query': { useQuery: () => ({ isSuccess: false }) },
    '../../features/season/api': { getCurrentSeason() {} },
    '../../features/tradingAccount/TradingAccountContext': { useTradingAccount: () => ({ accounts: [account], selectedAccount: account }) },
    '../../features/tradingAccount/useOpenGeneralAccount': { useOpenGeneralAccount: () => ({}) },
    '../../app/navigation/navigationHooks': { useRootNavigation: () => ({}) },
    '../common/ActionPressable': { default: h.ActionPressable, __esModule: true },
    '../common/CTAButton': { default: 'CTAButton', __esModule: true },
    './AdminDiagnosticPanel': { default: () => null, __esModule: true },
    '../common/BottomSheetBackdrop': { default: () => null, __esModule: true },
  }).default;
  const tree = h.render(React.createElement(Switcher, { home: true, homeVisual: React.createElement('View') }));
  try {
    const title = tree.root.findByProps({ testID: 'home-account-title' });
    const titleStyle = flatten(title.props.style), rowStyle = flatten(title.parent.props.style);
    const buttonStyle = flatten(tree.root.findByType('Pressable').props.style);
    function layout(width, fontScale, legacy, web) {
      const config = Yoga.Config.create(); config.setUseWebDefaults(web);
      const row = Yoga.Node.create(config), text = Yoga.Node.create(config), button = Yoga.Node.create(config);
      row.setWidth(width); row.setFlexDirection(Yoga.FLEX_DIRECTION_ROW); row.setAlignItems(Yoga.ALIGN_CENTER);
      row.setFlexWrap(rowStyle.flexWrap === 'wrap' ? Yoga.WRAP_WRAP : Yoga.WRAP_NO_WRAP); row.setGap(Yoga.GUTTER_ALL, rowStyle.gap);
      const style = legacy ? { ...titleStyle, flex: 1, flexGrow: 0, flexBasis: 'auto' } : titleStyle;
      if (style.flex !== undefined) text.setFlex(style.flex);
      if (style.flexGrow !== undefined) text.setFlexGrow(style.flexGrow);
      if (style.flexBasis === 'auto') text.setFlexBasisAuto();
      text.setMinWidth(style.minWidth); text.setFlexShrink(style.flexShrink);
      text.setMeasureFunc((available, mode) => {
        const width = mode === Yoga.MEASURE_MODE_UNDEFINED ? 96 * fontScale : Math.min(available, 96 * fontScale);
        return { width, height: titleStyle.lineHeight * fontScale * Math.max(1, Math.ceil(96 * fontScale / Math.max(width, 12 * fontScale))) };
      });
      button.setMinWidth(buttonStyle.minWidth); button.setMinHeight(buttonStyle.minHeight); button.setFlexShrink(buttonStyle.flexShrink);
      row.insertChild(text, 0); row.insertChild(button, 1); row.calculateLayout(undefined, undefined, Yoga.DIRECTION_LTR);
      const result = { row: row.getComputedLayout(), title: text.getComputedLayout(), button: button.getComputedLayout() };
      row.freeRecursive(); config.free(); return result;
    }
    const records = [];
    for (const viewport of [320, 360, 390, 430]) for (const fontScale of [1, 1.5, 2]) {
      // Gold's existing slot; large font layout gives the heading its own row.
      const width = viewport - 32 - 16 - (fontScale > 1.3 ? 0 : (viewport < 360 ? 142 : 172) + 2);
      const before = layout(width, fontScale, true, false), after = layout(width, fontScale, false, false);
      assert.equal(before.title.width, 0, 'reproduces the positive-flex/auto-basis Native failure');
      assert.ok(after.title.width > 0, 'production season title keeps intrinsic width');
      assert.ok(after.row.height < before.row.height);
      assert.ok(after.button.width >= 44 && after.button.height >= 44);
      if (viewport === 390 && fontScale === 1) assert.equal(after.row.height, 44);
      records.push({ viewport, fontScale, width, before, after });
    }
    const webBefore = layout(168, 1, true, true);
    assert.equal(webBefore.title.width, 96, 'Web defaults hid the Native regression');
    console.log(JSON.stringify({ engine: 'yoga-layout 3.2.1', nativeDevice: false, textMeasurement: 'controlled 96x27dp, scaled', webBefore, records }, null, 2));
  } finally { act(() => tree.unmount()); }
})().catch(error => { console.error(error); process.exitCode = 1; });
