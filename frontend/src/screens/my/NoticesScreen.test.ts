import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { it, type TestContext } from 'node:test';

const require = createRequire(import.meta.url);
const { interactionHarness, React, act } = require('../../../test/interactionTestHarness.cjs');
const id = 'execution-gap-protection';

type Important = { notices: unknown[]; state: 'loading' | 'error' | 'ready'; retry: () => void };

function setup(t: TestContext, params?: { noticeId?: string }, important: Partial<Important> = {}) {
  const h = interactionHarness();
  h.retries = 0;
  h.important = { notices: [], state: 'ready', retry: () => { h.retries++; }, ...important };
  h.scrolls = [];
  h.native.ScrollView = ({ ref, ...props }: any) => {
    React.useImperativeHandle(ref, () => ({ scrollTo: (options: any) => h.scrolls.push(options) }), []);
    return React.createElement('ScrollView', props);
  };
  const Screen = h.load('src/screens/my/NoticesScreen.tsx', {
    '../../components/states/EmptyState': { __esModule: true, default: 'EmptyState' },
    // Server read of operator-published important notices (a React Query hook).
    '../../features/notice/useImportantNotices': { useImportantNotices: () => h.important },
  }).default;
  const element = (next = params) => React.createElement(Screen, { route: { params: next }, navigation: {} });
  h.renderer = h.render(element());
  h.update = (next?: { noticeId?: string }) => act(() => h.renderer.update(element(next)));
  h.find = (testID: string) => h.renderer.root.findAll((node: any) => typeof node.type === 'string' && node.props.testID === testID)[0];
  t.after(() => act(() => h.renderer.unmount()));
  return h;
}

it('lists the execution gap notice collapsed, and its header toggles the content', (t) => {
  const h = setup(t);
  const toggle = h.find(`notice-${id}-toggle`);
  assert.equal(toggle.props.accessibilityRole, 'button');
  assert.equal(toggle.props.accessibilityState.expanded, false);
  assert.equal(toggle.props.accessibilityLabel, '체결괴리 방지시스템 안내, 2026.10.12');
  assert.equal(h.find(`notice-${id}-body`) === undefined, true);
  act(() => toggle.props.onPress());
  assert.equal(h.find(`notice-${id}-toggle`).props.accessibilityState.expanded, true);
  assert.equal(h.find(`notice-${id}-body`) !== undefined, true);
  act(() => h.find(`notice-${id}-toggle`).props.onPress());
  assert.equal(h.find(`notice-${id}-body`) === undefined, true);
  assert.equal(h.renderer.root.findAllByType('EmptyState').length, 0);
});

it('a link with noticeId opens that notice and scrolls to it, also when the screen is already open', (t) => {
  const h = setup(t, { noticeId: id });
  assert.equal(h.find(`notice-${id}-body`) !== undefined, true);
  act(() => h.find(`notice-${id}`).props.onLayout({ nativeEvent: { layout: { y: 240 } } }));
  assert.deepEqual(h.scrolls, [{ y: 240, animated: false }]);
  const reopened = setup(t);
  assert.equal(reopened.find(`notice-${id}-body`) === undefined, true);
  reopened.update({ noticeId: id });
  assert.equal(reopened.find(`notice-${id}-body`) !== undefined, true);
});

const published = {
  id: '0190a2b4-0000-7000-8000-000000000001',
  title: '서버 점검 안내',
  // 2026-10-20 00:30 KST
  publishedAt: '2026-10-19T15:30:00.000Z',
  sections: [{ heading: '점검 시간', paragraphs: ['10월 21일 02:00–03:00'] }],
};

it('lists an important notice published by an operator, newest first and marked', (t) => {
  const h = setup(t, undefined, { notices: [published] });
  const toggle = h.find(`notice-${published.id}-toggle`);
  assert.equal(toggle.props.accessibilityLabel, '중요 공지, 서버 점검 안내, 2026.10.20');
  const ids = h.renderer.root
    .findAll((node: any) => typeof node.type === 'string' && /^notice-[^]+-toggle$/.test(node.props.testID ?? ''))
    .map((node: any) => node.props.testID);
  assert.equal(ids[0], `notice-${published.id}-toggle`);
  // The app's own notices are still all there.
  assert.equal(h.find(`notice-${id}-toggle`) !== undefined, true);
});

it('an important-notice push opens that notice', (t) => {
  const h = setup(t, { noticeId: published.id }, { notices: [published] });
  assert.equal(h.find(`notice-${published.id}-body`) !== undefined, true);
  assert.equal(h.find('notices-target-missing') === undefined, true);
});

it('says so when a pushed notice is no longer published, and keeps the list', (t) => {
  const h = setup(t, { noticeId: 'withdrawn-notice' });
  // Read again once before saying so (it may have been published just now).
  assert.equal(h.retries, 1);
  assert.equal(h.find('notices-target-missing') !== undefined, true);
  assert.equal(h.find(`notice-${id}-toggle`) !== undefined, true);
  // Still loading: no premature "missing" message.
  const loading = setup(t, { noticeId: 'withdrawn-notice' }, { state: 'loading' });
  assert.equal(loading.find('notices-target-missing') === undefined, true);
});

it('keeps the app notices when the server read fails and offers a retry', (t) => {
  const h = setup(t, undefined, { state: 'error' });
  assert.equal(h.find(`notice-${id}-toggle`) !== undefined, true);
  act(() => h.find('notices-important-retry').props.onPress());
  assert.equal(h.retries, 1);
});

it('reads the list again for a notice published after it was loaded, then opens it', (t) => {
  const h = setup(t, { noticeId: published.id });
  assert.equal(h.retries, 1);
  h.important = { ...h.important, notices: [published] };
  h.update({ noticeId: published.id });
  assert.equal(h.find(`notice-${published.id}-body`) !== undefined, true);
  assert.equal(h.find('notices-target-missing') === undefined, true);
});

it('a repeated tap on the same notice opens it again after it was collapsed', (t) => {
  const h = setup(t, { noticeId: id, pushAt: 1 } as { noticeId?: string });
  act(() => h.find(`notice-${id}-toggle`).props.onPress());
  assert.equal(h.find(`notice-${id}-body`) === undefined, true);
  h.update({ noticeId: id, pushAt: 2 } as { noticeId?: string });
  assert.equal(h.find(`notice-${id}-body`) !== undefined, true);
});

