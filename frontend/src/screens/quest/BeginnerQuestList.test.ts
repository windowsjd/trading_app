import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const React = require('react');
const Renderer = require('react-test-renderer');
const { load } = require('../../../test/ledgerTestHarness.cjs');
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test('completed cards preserve status and description, expose a centered static replay icon and hide chips/timestamps', async t => {
  const at = '2026-10-10T01:00:00.000Z';
  const progress = { exchange: { completed: true, completedAt: at, status: 'completed' },
    transfer: { completed: true, completedAt: '2026-10-10T01:05:00.000Z', status: 'completed' } };
  const starts: string[] = [];
  const List = load(resolve('src/screens/quest/BeginnerQuestList.tsx'), {
    'react-native': { View: 'View', Text: 'Text', ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator', StyleSheet: { create: (x: unknown) => x } },
    'react-native-svg': { default: 'Svg', Path: 'Path', __esModule: true },
    '../../hooks/usePullToRefresh': { usePullToRefresh: () => ({}) },
    '../../components/states/ErrorNotice': { default: 'ErrorNotice', __esModule: true },
    '../../features/quest/useBeginnerQuestProgress': { useBeginnerQuestProgress: () => ({ progress, accountId: 'A' }) },
    '../../features/quest/QuestGuideProvider': { useQuestGuide: () => ({ start: (key: string) => starts.push(key) }) },
  }).default;
  let renderer: any; await Renderer.act(async () => { renderer = Renderer.create(React.createElement(List)); });
  t.after(async () => { await Renderer.act(async () => renderer.unmount()); });
  const node = (id: string) => renderer.root.findAll((n: any) => typeof n.type === 'string' && n.props.testID === id)[0];
  for (const quest of ['exchange', 'transfer']) {
    const button = node(`quest-card-${quest}-start`);
    assert.equal(button.props.accessibilityLabel, '다시하기');
    assert.equal(button.props.accessibilityState.disabled, false);
    assert.equal(button.findAll((n: any) => typeof n.type === 'string' && n.props.testID === 'quest-replay-icon').length, 1);
    assert.equal(button.findAll((n: any) => n.type === 'Animated.View').length, 0);
    const group = button.findAllByType('View')[0];
    assert.equal(group.props.style.flexDirection, 'row');
    assert.equal(group.props.style.justifyContent, 'center');
    await Renderer.act(async () => button.props.onPress());
    assert.equal(node(`quest-card-${quest}-completed`) === undefined, true);
  }
  const displayed = JSON.stringify(renderer.toJSON());
  assert.doesNotMatch(displayed, /배우는 내용:|완료 ·|2026-|다시 둘러보기/);
  assert.match(displayed, /QUEST 01|QUEST 02|환전하기|이체하기/);
  assert.deepEqual(starts, ['exchange', 'transfer']);
  assert.equal(progress.exchange.completedAt, at);
});
