import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { it } from 'node:test';

const require = createRequire(import.meta.url);
const React = require('react');
const Renderer = require('react-test-renderer');
const { load } = require('../../../test/ledgerTestHarness.cjs');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

it('switches between an honest preparation state and the actual existing guide content/navigation', async t => {
  const Screen = load(resolve('src/screens/guide/BeginnerLearningScreen.tsx'), {
    'react-native': { View: 'View', Text: 'Text', ScrollView: 'ScrollView', SafeAreaView: 'SafeAreaView', Platform: { OS: 'ios' }, StyleSheet: { create: x => x } },
  }).default;
  const navigated: string[] = [];
  let renderer: any;
  await Renderer.act(async () => { renderer = Renderer.create(React.createElement(Screen, { navigation: { navigate: route => navigated.push(route) } })); });
  t.after(async () => { await Renderer.act(async () => renderer.unmount()); });
  const find = (id: string) => renderer.root.findAll(node => node.props.testID === id)[0];
  assert.equal(find('beginner-quests-ready') !== undefined, true);
  const readyText = renderer.root.findAllByType('Text').map(node => node.props.children).join(' ');
  assert.match(readyText, /퀘스트를 준비/);
  assert.doesNotMatch(readyText, /\d+%|레벨|해금|잠금|완료 조건|경험치/);
  assert.equal(find('beginner-segment-quests').props.accessibilityState.selected, true);
  await Renderer.act(async () => find('beginner-segment-guide').props.onPress());
  assert.equal(find('beginner-quests-ready') === undefined, true);
  assert.equal(find('beginner-segment-guide').props.accessibilityState.selected, true);
  const guideCard = renderer.root.findAll(node => node.props.accessibilityHint === '시장기초 가이드를 엽니다.')[0];
  assert.equal(guideCard !== undefined, true);
  await Renderer.act(async () => guideCard.props.onPress());
  assert.deepEqual(navigated, ['MarketBasics']);
  await Renderer.act(async () => find('beginner-segment-quests').props.onPress());
  assert.equal(find('beginner-quests-ready') !== undefined, true);
  assert.equal(renderer.root.findAll(node => node.props.accessibilityHint === '시장기초 가이드를 엽니다.').length, 0);
});
