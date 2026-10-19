import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it } from 'node:test';
import { QUEST_LOCK_CAPTION } from '../../features/quest/questProgress.ts';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act, flatten } = require('../../../test/interactionTestHarness.cjs');

function render(t: any, props: Record<string, unknown>) {
  const h = interactionHarness();
  const alerts: unknown[][] = [];
  h.native.Alert = { alert: (...args: unknown[]) => alerts.push(args) };
  const CTA = h.load('src/components/common/CTAButton.tsx', { './ActionPressable': { default: h.ActionPressable, __esModule: true } }).default;
  const renderer = h.render(React.createElement(CTA, { label: '구매하기', testID: 'cta', onPress() {}, ...props }));
  t.after(() => act(() => renderer.unmount()));
  const node = (id: string) => renderer.root.findAll((n: any) => typeof n.type === 'string' && n.props.testID === id)[0];
  // The nearest host View above a node (the harness's Pressable is a component around a host element).
  const hostView = (n: any) => { let at = n.parent; while (at && at.type !== 'View') at = at.parent; return at; };
  return { renderer, node, alerts, hostView, ActionPressable: h.ActionPressable };
}

it('an unlocked button renders exactly as before: no caption, no wrapper', (t) => {
  const r = render(t, { style: { flex: 1, minHeight: 50, backgroundColor: '#326FE5' } });
  assert.equal(r.node('cta-learning-caption') === undefined, true);
  // The button itself is the root, with its placement on it.
  assert.equal(r.renderer.root.children[0].type === r.ActionPressable, true);
  assert.equal(flatten(r.node('cta').props.style).flex, 1);
});

it('a learning-locked button keeps its look and size, with the quest caption under it in its place', (t) => {
  const r = render(t, { learningHint: '공통 기초 퀘스트를 모두 완료하면 사용할 수 있어요.',
    style: { flex: 1, minWidth: 0, minHeight: 50, marginTop: 4, backgroundColor: '#326FE5' } });
  const caption = r.node('cta-learning-caption');
  assert.equal(caption.findByType('Text').props.children, QUEST_LOCK_CAPTION);
  assert.equal(QUEST_LOCK_CAPTION, '퀘스트 완료 후 이용 가능합니다.');
  // The pair takes the button's place; the button keeps its own box and the lock look.
  const pair = flatten(r.hostView(caption).props.style);
  assert.equal(r.hostView(caption) === r.hostView(r.node('cta')), true, 'button and caption share the pair');
  assert.deepEqual([pair.flex, pair.minWidth, pair.marginTop], [1, 0, 4]);
  const button = flatten(r.node('cta').props.style);
  assert.deepEqual([button.flex, button.marginTop, button.minHeight], [undefined, undefined, 50]);
  assert.equal(r.renderer.root.findAll((n: any) => n.props.testID === 'learning-lock-icon').length > 0, true);
  // Still not pressable; the accessible label keeps the detailed reason.
  assert.equal(r.node('cta').props.accessibilityState.disabled, true);
  assert.match(r.node('cta').props.accessibilityLabel, /^구매하기, 학습 제한\. 공통 기초 퀘스트/);
  // The caption opens that detailed guidance.
  act(() => caption.props.onPress());
  assert.deepEqual(r.alerts, [['기능 안내', '공통 기초 퀘스트를 모두 완료하면 사용할 수 있어요.']]);
});

it('a screen-derived lock shows its own reason instead of the quest caption', (t) => {
  const r = render(t, { learningHint: '선물 퀘스트는 레버리지를 1배보다 높게 설정해 진입해야 해요.',
    learningCaption: '선물 퀘스트는 레버리지를 1배보다 높게 설정해 진입해야 해요.' });
  assert.equal(r.node('cta-learning-caption').findByType('Text').props.children, '선물 퀘스트는 레버리지를 1배보다 높게 설정해 진입해야 해요.');
});
