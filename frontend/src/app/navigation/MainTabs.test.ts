import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { URL } from 'node:url';

const tabs = readFileSync(new URL('./MainTabs.tsx', import.meta.url), 'utf8');
const icons = readFileSync(
  new URL('../../components/navigation/TabBarIcon.tsx', import.meta.url),
  'utf8',
);

describe('bottom tab icon contract', () => {
  it('preserves all five routes, stacks, labels and order with explicit SVG icons', () => {
    const screens = [...tabs.matchAll(/<Tab\.Screen\b([\s\S]*?)\n\s*\/>/g)];
    const actual = screens.map(([, screen]) => {
      assert.match(screen, /tabBarIcon: \(\{ color, size \}\) =>/);
      assert.match(screen, /<TabBarIcon name="\w+" color=\{color\} size=\{size\} \/>/);
      return [
        screen.match(/name="(\w+)"/)?.[1],
        screen.match(/component=\{(\w+)\}/)?.[1],
        screen.match(/title: '([^']+)'/)?.[1],
        screen.match(/<TabBarIcon name="(\w+)"/)?.[1],
      ];
    });
    assert.deepEqual(actual, [
      ['HomeTab', 'HomeStack', '홈', 'home'],
      ['MarketTab', 'MarketStack', '마켓', 'market'],
      ['RankingTab', 'RankingStack', '랭킹', 'ranking'],
      ['RecordTab', 'RecordStack', '전적', 'record'],
      ['MyTab', 'MyStack', 'MY', 'profile'],
    ]);
  });

  it('draws every icon with consistent SVG strokes, without text or font assets', () => {
    assert.match(icons, /import Svg, \{ Circle, Path \} from 'react-native-svg'/);
    assert.deepEqual([...icons.matchAll(/case '(\w+)':/g)].map((match) => match[1]),
      ['home', 'market', 'ranking', 'record', 'profile']);
    assert.match(icons, /width=\{size\}\s+height=\{size\}/);
    assert.match(icons, /viewBox="0 0 24 24"/);
    assert.match(icons, /fill="none"\s+stroke=\{color\}\s+strokeWidth=\{2\}/);
    assert.match(icons, /strokeLinecap="round"\s+strokeLinejoin="round"/);
    assert.doesNotMatch(icons, /<Text|<Image|fontFamily|vector-icons|lucide|#[\da-f]{3,8}\b/i);
    assert.doesNotMatch(icons, /[^\x00-\x7F]/);
  });

  it('leaves accessibility on the tab and prevents duplicate icon announcements', () => {
    assert.match(icons, /accessible=\{false\}/);
    assert.match(icons, /accessibilityElementsHidden/);
    assert.match(icons, /importantForAccessibility="no-hide-descendants"/);
    assert.match(icons, /aria-hidden/);
    assert.match(icons, /focusable=\{false\}/);
  });

  it('keeps labels below icons and reserves safe-area space when fonts grow', () => {
    assert.match(tabs, /tabBarLabelPosition: 'below-icon'/);
    assert.match(tabs, /fontScale.*useWindowDimensions\(\)/);
    assert.match(tabs, /insets = useSafeAreaInsets\(\)/);
    assert.match(tabs, /fontScale > 1\s*\? \{ height: 49 \+ Math\.ceil\(14 \* \(fontScale - 1\)\) \+ insets\.bottom \}\s*: undefined/);
    assert.doesNotMatch(tabs, /tabBarAllowFontScaling:\s*false|tabBarActiveTintColor|tabBarInactiveTintColor/);
  });
});
