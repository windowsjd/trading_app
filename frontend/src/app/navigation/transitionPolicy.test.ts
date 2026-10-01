import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { rootTransition, stackTransition } from './transitionPolicy.ts';

test('native push has a short iOS duration, Android direction and reverse native pop', () => {
  assert.deepEqual(stackTransition(false, 'ios'), { animation: 'simple_push', animationDuration: 210 });
  assert.deepEqual(stackTransition(false, 'android'), { animation: 'ios_from_right' });
  assert.deepEqual(stackTransition(true, 'ios'), { animation: 'none' });
  assert.deepEqual(stackTransition(true, 'android'), { animation: 'none' });
  assert.deepEqual(rootTransition(false), { animation: 'fade', animationDuration: 170 });
  assert.deepEqual(rootTransition(true), { animation: 'none' });
});

test('all stacks share push policy and chart keeps fullscreen modal presentation', () => {
  for (const name of ['AuthStack', 'HomeStack', 'MarketStack', 'GuideStack', 'RankingStack', 'RecordStack', 'WalletStack', 'MyStack']) {
    const source = readFileSync(resolve('src/app/navigation', `${name}.tsx`), 'utf8');
    assert.match(source, /stackTransition\(reducedMotion, Platform\.OS\)/);
  }
  const root = readFileSync(resolve('src/app/navigation/RootNavigator.tsx'), 'utf8');
  assert.match(root, /presentation: 'fullScreenModal'/);
  assert.match(root, /rootTransition\(reducedMotion\)/);
  const tabs = readFileSync(resolve('src/app/navigation/MainTabs.tsx'), 'utf8');
  assert.match(tabs, /animation: reducedMotion \? 'none' : 'fade'/);
  assert.match(tabs, /duration: 130/);
  const reduced = readFileSync(resolve('src/theme/useReducedMotion.ts'), 'utf8');
  assert.match(reduced, /isReduceMotionEnabled/);
  assert.match(reduced, /prefers-reduced-motion/);
});
