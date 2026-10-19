import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const read = (sourcePath: string) => readFileSync(path.join(process.cwd(), 'src', sourcePath), 'utf8');
// The module a file takes its SafeAreaView from.
const safeAreaModule = (source: string) =>
  [...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/gu)].find(([, names]) => /\bSafeAreaView\b/u.test(names))?.[2] ?? null;
const safeAreaViews = (source: string): string[] => source.match(/<SafeAreaView\b[^>]*>/gu) ?? [];

// Android draws every window edge to edge (edgeToEdgeEnabled) and React Native's
// SafeAreaView pads on iOS only. Off the tab bar (root pushes, the detail with its
// tab bar hidden) or as a whole root screen, only safe-area-context's view keeps
// content off the status and navigation bars.
describe('Android safe area off the tab bar', () => {
  it("root screens, and states returned as one, use safe-area-context's view", () => {
    for (const file of [
      'screens/entry/ModeSelectionScreen.tsx', 'screens/season/SeasonJoinScreen.tsx',
      'screens/history/TradeHistoryScreen.tsx', 'screens/history/OrderFailureScreen.tsx',
      'screens/asset/AssetDetailScreen.tsx', 'screens/asset/AssetChartScreen.tsx', 'screens/futures/FuturesChartScreen.tsx',
      'components/states/ErrorState.tsx', 'components/states/BlockedState.tsx', 'components/tradingAccount/AccountSetupPanel.tsx',
    ]) assert.equal(safeAreaModule(read(file)), '../../theme/safeArea', file);
  });

  it('headerless roots keep every edge, screens under a native header leave the top to it, and the detail bar pads itself', () => {
    for (const file of ['screens/entry/ModeSelectionScreen.tsx', 'screens/season/SeasonJoinScreen.tsx']) {
      const views = safeAreaViews(read(file));
      assert.equal(views.length > 0 && views.every((view) => view.includes("edges={['top', 'bottom', 'left', 'right']}")), true, file);
    }
    for (const file of ['screens/history/TradeHistoryScreen.tsx', 'screens/history/OrderFailureScreen.tsx']) {
      const views = safeAreaViews(read(file));
      assert.equal(views.length > 0 && views.every((view) => view.includes("edges={['bottom', 'left', 'right']}")), true, file);
    }
    // The order bar adds 8 + insets.bottom itself, so its screen takes no bottom edge (applied once).
    const detail = read('screens/asset/AssetDetailScreen.tsx');
    assert.deepEqual(safeAreaViews(detail).map((view) => view.includes("edges={['left', 'right']}")), [true]);
    assert.match(detail, /paddingBottom: styles\.footer\.paddingBottom \+ insets\.bottom/u);
  });
});
