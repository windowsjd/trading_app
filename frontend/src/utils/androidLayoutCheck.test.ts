import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';

// The device-side check (scripts/android-layout-check.cjs): its parsing of real
// `dumpsys window` / `uiautomator dump` shapes, so a device run reports truly.
const require = createRequire(import.meta.url);
const { parseNavigationBar, parseNodes, parseHierarchy, measureAction, measureFooter, diagnose } = require('../../scripts/android-layout-check.cjs');

// Android 14 (InsetsSource id=… type=navigationBars), 3-button bar 126 px at 2.625x.
const ANDROID_14 = `
  Window #3 Window{a1 u0 com.leagueoftrading/com.leagueoftrading.MainActivity}:
    mInsetsState=InsetsState: {mDisplayFrame=Rect(0, 0 - 1080, 2400), mSources= {
      InsetsSource: {id=1 mType=statusBars mFrame=[0,0][1080,63] mVisible=true}
      InsetsSource id=3 type=navigationBars frame=[0,2274][1080,2400] visible=true flags= sideHint=BOTTOM
      InsetsSource id=4 type=navigationBars frame=[0,2274][1080,2400] visible=true flags=
      InsetsSource id=5 type=tappableElement frame=[0,2274][1080,2400] visible=true
  Window #4 Window{b2 u0 NavigationBar0}:
      InsetsSource id=3 type=navigationBars frame=[0,2274][1080,2400] visible=false`;
// Newer dumps print the source as an object with m-prefixed fields.
const ANDROID_15 = `
      InsetsSource: {id=1 mType=statusBars mFrame=[0,0][1080,63] mVisible=true mFlags=}
      InsetsSource: {id=3 mType=navigationBars mFrame=[0,2274][1080,2400] mVisible=true mFlags=}`;
// Android 12 (ITYPE_NAVIGATION_BAR), gesture handle 63 px.
const ANDROID_12 = `
      InsetsSource type=ITYPE_STATUS_BAR frame=[0,0][1080,63] visible=true
      InsetsSource type=ITYPE_NAVIGATION_BAR frame=[0,2337][1080,2400] visible=true`;

const node = (attrs: Record<string, string>) =>
  `<node index="0" ${Object.entries(attrs).map(([key, value]) => `${key}="${value}"`).join(' ')} class="android.view.ViewGroup" package="com.leagueoftrading">`;
const DUMP = `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
  ${node({ 'resource-id': 'asset-order-actions', text: '', 'content-desc': '', clickable: 'false', bounds: '[0,2170][1080,2400]' })}
  ${node({ text: '', 'content-desc': '매도하기', clickable: 'true', bounds: '[36,2196][531,2346]' })}
  ${node({ text: '매도하기', 'content-desc': '', clickable: 'false', bounds: '[220,2250][347,2293]' })}</node></node>
  ${node({ text: '', 'content-desc': '매수하기, 학습 제한. 퀘스트를 먼저 완료해주세요.', clickable: 'true', bounds: '[549,2196][1044,2346]' })}
  ${node({ text: '매수하기', 'content-desc': '', clickable: 'false', bounds: '[733,2250][860,2293]' })}</node></node>
</hierarchy>`;

describe('Android bottom-action check (adb)', () => {
  it('rejects a null-root dump even if an old XML would report clear buttons', () => {
    let reads = 0;
    assert.throws(() => parseHierarchy('ERROR: null root node returned by UiTestAutomationBridge.', () => {
      reads++;
      return DUMP;
    }), /null root node/);
    assert.equal(reads, 0, 'never reads stale XML after a failed dump');
    assert.throws(() => parseHierarchy('', () => '<hierarchy rotation="0"></hierarchy>'), /no measurable nodes/);
    assert.equal(parseHierarchy('UI hierchary dumped to: /sdcard/tc-layout-check.xml', () => DUMP).length, 5);
  });
  it('cannot pass missing actions or label-only bounds as verified touch areas', () => {
    const label = node({ text: '매도하기', clickable: 'false', bounds: '[36,2000][531,2050]' });
    const action = measureAction(parseNodes(label), '매도하기', parseNavigationBar(ANDROID_14), 420);
    assert.deepEqual([action.found, action.clickable, action.overlaps], [true, false, false]);
    assert.equal(diagnose([action], { found: false }), 'unavailable: clickable action bounds missing');
    assert.equal(diagnose([{ found: false }], { found: false }), 'unavailable: clickable action bounds missing');
  });
  it('reads the navigation bar frame most windows report, ignoring hidden ones, in both dumpsys formats', () => {
    assert.deepEqual(parseNavigationBar(ANDROID_14), { left: 0, top: 2274, right: 1080, bottom: 2400 });
    assert.deepEqual(parseNavigationBar(ANDROID_12), { left: 0, top: 2337, right: 1080, bottom: 2400 });
    assert.deepEqual(parseNavigationBar(ANDROID_15), { left: 0, top: 2274, right: 1080, bottom: 2400 });
    assert.equal(parseNavigationBar('no insets here') === null, true);
  });

  it('measures each action by its clickable node and reports the gap or overlap in px and dp', () => {
    const nodes = parseNodes(DUMP);
    assert.deepEqual(nodes.map((n: { id: string }) => n.id), ['asset-order-actions', '', '', '', ''], 'the order bar and the four action nodes');
    const bar = parseNavigationBar(ANDROID_14);
    const sell = measureAction(nodes, '매도하기', bar, 420);
    assert.deepEqual([sell.found, sell.clickable, sell.bounds.join(','), sell.gapPx, sell.gapDp, sell.overlaps],
      [true, true, '36,2196,531,2346', -72, -27.4, true]);
    // A learning-locked button is still found by its label.
    const buy = measureAction(nodes, '매수하기', parseNavigationBar(ANDROID_12), 420);
    assert.deepEqual([buy.clickable, buy.gapPx, buy.overlaps], [true, -9, true]);
    const above = measureAction(nodes, '매도하기', { left: 0, top: 2360, right: 1080, bottom: 2400 }, 420);
    assert.deepEqual([above.gapPx, above.gapDp, above.overlaps], [14, 5.3, false]);
    assert.deepEqual(measureAction(nodes, '없는 버튼', bar, 420), { label: '없는 버튼', found: false });
  });

  it('reports effective clearance without treating inferred padding as the actual hook inset', () => {
    const nodes = parseNodes(DUMP);
    const bar = parseNavigationBar(ANDROID_14);
    const actions = ['매도하기', '매수하기'].map((label) => measureAction(nodes, label, bar, 420));
    // 54px under the actions at 2.625x = 20.6dp = 8dp + a 12.6dp inset, against a 48dp bar.
    const footer = measureFooter(nodes, 'asset-order-actions', actions, bar, 420);
    assert.deepEqual([footer.found, footer.bounds.join(','), footer.paddingBelowActionsDp, footer.appBottomInsetDp, footer.navigationBarDp, footer.overrunPx],
      [true, '0,2170,1080,2400', 20.6, 12.6, 48, 0]);
    assert.equal(diagnose(actions, footer), 'inferred bottom clearance (12.6dp) is smaller than the navigation bar (48dp): measure insets.bottom and child overflow');
    // The same bar with no inset at all (8dp under the actions).
    const bare = { ...footer, paddingBelowActionsDp: 8, appBottomInsetDp: 0 };
    assert.equal(diagnose(actions, bare), 'no effective bottom clearance: measure insets.bottom and child overflow');
    // A full inset, but the screen ends 63px below the display (status bar height).
    assert.equal(diagnose(actions, { ...footer, appBottomInsetDp: 48, overrunPx: 63 }), 'screen reaches 63px past the display bottom');
    // Actions ending above the bar: clear, whatever the bar's padding.
    const above = { left: 0, top: 2360, right: 1080, bottom: 2400 };
    assert.equal(diagnose(['매도하기', '매수하기'].map((label) => measureAction(nodes, label, above, 420)), footer), 'clear');
    assert.deepEqual(measureFooter(nodes, 'missing-bar', actions, bar, 420), { id: 'missing-bar', found: false });
  });
});
