import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { chartTransition, rootTransition, stackTransition, tabTransition, tabEaseOut, IOS_PUSH_DURATION, webPushMotion } from './transitionPolicy.ts';

test('native push matches the reference push length on iOS, Android direction and reverse native pop', () => {
  // Reference video 3: ~90% within 170ms and settled by ~350ms (iOS spring over this length).
  assert.equal(IOS_PUSH_DURATION, 350);
  assert.deepEqual(stackTransition(false, 'ios'), { animation: 'simple_push', animationDuration: 350 });
  assert.deepEqual(stackTransition(false, 'android'), { animation: 'ios_from_right' });
  assert.deepEqual(stackTransition(true, 'ios'), { animation: 'none' });
  assert.deepEqual(stackTransition(true, 'android'), { animation: 'none' });
  assert.deepEqual(rootTransition(false, 'ios'), { animation: 'fade', animationDuration: 190 });
  assert.deepEqual(rootTransition(true, 'ios'), { animation: 'none' });
  assert.deepEqual(tabTransition(false), { animation: 'fade', transitionSpec: { animation: 'timing', config: { duration: 190, easing: tabEaseOut } } });
  assert.deepEqual(tabTransition(true), { animation: 'none', transitionSpec: { animation: 'timing', config: { duration: 0, easing: tabEaseOut } } });
  assert.deepEqual(chartTransition(false, 'ios'), { ...rootTransition(false, 'ios'), presentation: 'fullScreenModal' });
  assert.deepEqual(chartTransition(true, 'ios'), { animation: 'none', presentation: 'fullScreenModal' });
});

test('all stacks share push policy and chart keeps fullscreen modal presentation', () => {
  for (const name of ['AuthStack', 'HomeStack', 'MarketStack', 'GuideStack', 'RankingStack', 'RecordStack', 'WalletStack', 'MyStack']) {
    const source = readFileSync(resolve('src/app/navigation', `${name}.tsx`), 'utf8');
    assert.match(source, /stackTransition\(reducedMotion, Platform\.OS\)/);
    // Web has no native stack motion; every stack adds the same directional cue.
    assert.equal(/screenLayout=\{stackScreenLayout\}/.test(source), true, name);
  }
  const root = readFileSync(resolve('src/app/navigation/RootNavigator.tsx'), 'utf8');
  assert.equal((root.match(/layout=\{pushedRootLayout\}/g) ?? []).length, 2, 'TradeHistory and SeasonJoin pushes');
  assert.match(root, /chartTransition\(reducedMotion, Platform\.OS\)/);
  assert.match(root, /rootTransition\(reducedMotion, Platform\.OS\)/);
  const tabs = readFileSync(resolve('src/app/navigation/MainTabs.tsx'), 'utf8');
  assert.match(tabs, /tabTransition\(reducedMotion\)/);
  assert.doesNotMatch(tabs, /duration:/);
  const reduced = readFileSync(resolve('src/theme/useReducedMotion.ts'), 'utf8');
  assert.match(reduced, /isReduceMotionEnabled/);
  assert.match(reduced, /prefers-reduced-motion/);
});

test('root/chart omit iOS duration on Android and web; tab easing settles monotonically', () => {
  for (const platform of ['android', 'web']) {
    assert.deepEqual(rootTransition(false, platform), { animation: 'fade' });
    assert.deepEqual(chartTransition(false, platform), { animation: 'fade', presentation: 'fullScreenModal' });
    assert.deepEqual(rootTransition(true, platform), { animation: 'none' });
  }
  assert.equal(tabEaseOut(0), 0); assert.equal(tabEaseOut(1), 1);
  for (let i = 1; i <= 100; i++) assert.ok(tabEaseOut(i / 100) > tabEaseOut((i - 1) / 100));
  assert.ok(tabEaseOut(0.5) > 0.5);
});

test('web push cue: short decelerate from the right, back from the left at the parallax share', () => {
  assert.ok(webPushMotion.duration > 0 && webPushMotion.duration <= 300);
  assert.ok(webPushMotion.backShare > 0 && webPushMotion.backShare < 1);
  assert.ok(webPushMotion.pushOpacity < 1 && webPushMotion.backOpacity < 1 && webPushMotion.pushOpacity <= webPushMotion.backOpacity);
  const layout = readFileSync(resolve('src/app/navigation/stackScreenLayout.tsx'), 'utf8');
  assert.equal(/Platform\.OS === 'web'/.test(layout), true, 'native stacks keep their own transitions');
  assert.equal(/prefers-reduced-motion: reduce/.test(layout), true);
});
