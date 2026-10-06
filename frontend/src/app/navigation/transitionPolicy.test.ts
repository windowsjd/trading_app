import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { chartTransition, rootTransition, stackTransition, tabTransition, tabEaseOut } from './transitionPolicy.ts';

test('native push has a short iOS duration, Android direction and reverse native pop', () => {
  assert.deepEqual(stackTransition(false, 'ios'), { animation: 'simple_push', animationDuration: 230 });
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
  }
  const root = readFileSync(resolve('src/app/navigation/RootNavigator.tsx'), 'utf8');
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
