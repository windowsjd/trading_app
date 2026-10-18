import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { questProgress } from '../../../test/questFixtures.ts';
const { futuresHarness } = createRequire(import.meta.url)('../../../test/futuresHarness.cjs');

const ALL = '모든 퀘스트를 완료하면 사용할 수 있어요.';
const LEVERAGE = '선물 퀘스트는 레버리지를 1배보다 높게 설정해 진입해야 해요.';
/** Account A selected as a beginner with this server progress. */
function beginner(progress: ReturnType<typeof questProgress>, options: Record<string, unknown> = {}) {
  const h = futuresHarness(options);
  h.questProgress = progress;
  h.accountState = { selectedAccount: { id: 'A', mode: 'beginner', status: 'active', season: null } };
  return h;
}
const hint = (h: any) => h.node('futures-submit').props.learningHint ?? null;

test('after QUEST 06 a Futures practice opens above 1x only; 1x explains why and sends nothing', async t => {
  const h = beginner(questProgress(6));
  await h.start(); t.after(h.close);
  await h.amount('50');
  assert.equal(hint(h), LEVERAGE, 'the screen default is 1x');
  await h.press('futures-submit');
  assert.deepEqual([h.requests.length, h.alerts.map((alert: unknown[]) => alert[1])], [0, [LEVERAGE]]);
  await h.setLeverage(2);
  assert.equal(hint(h), null);
  await h.press('futures-submit');
  assert.equal(h.requests.length, 1);
  assert.deepEqual([h.requests[0].body.operation, h.requests[0].body.leverage], ['open', 2]);
});

test('a direction whose quest is done (or whose practice position is open) waits; the other stays open', async t => {
  const progress = questProgress(6);
  progress.learningPermissions = { ...progress.learningPermissions, futuresLongOpen: false };
  const h = beginner(progress);
  await h.start(); t.after(h.close);
  await h.amount('50');
  await h.setLeverage(2);
  assert.equal(hint(h), '진행 중인 롱 포지션을 전량 종료하면 새로 진입할 수 있어요.');
  await h.press('futures-direction-short');
  assert.equal(hint(h), null);
});

test('every quest complete: 1x and an increase are ordinary trades; before that an increase waits for all ten', async t => {
  const done = beginner(questProgress(10));
  await done.start(); t.after(done.close);
  await done.amount('50');
  assert.equal(hint(done), null);
  const open = beginner(questProgress(6), { position: true });
  await open.start(); t.after(open.close);
  await open.amount('50');
  // With a position the order form increases it.
  assert.equal(hint(open), ALL);
});
