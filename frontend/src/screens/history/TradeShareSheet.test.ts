import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { tradeShareHarness, futuresTrade, spotTrade, deferred } = require('../../../test/tradeShareHarness.cjs');
const session = require(resolve('src/services/api/sessionOwnership.ts'));

const FUTURES = 'futures:lifetime-1';
const SPOT = 'spot:asset-samsung';
const card = (h: any, part: string) => h.words(`trade-share-card-${part}`);
const disabled = (h: any, id: string) => h.node(id)?.props.disabled === true;
const names = (h: any) => h.calls.map((call: any) => call.name).join(',');

async function opened(t: any, options: Record<string, unknown> = {}, key = FUTURES) {
  const h = tradeShareHarness(options);
  await h.start();
  t.after(h.close);
  await h.open(key);
  return h;
}

test('거래 완료 lists the pinned account\'s confirmed results, each with 공유', async (t) => {
  const h = tradeShareHarness();
  await h.start();
  t.after(h.close);
  assert.deepEqual(h.reads, ['season-1']);
  assert.equal(h.words(`completed-trade-${FUTURES}-name`), 'Bitcoin');
  assert.equal(h.words(`completed-trade-${FUTURES}-meta`), '2026-11-05 21:44:04 완료 · 10x');
  assert.equal(h.words(`completed-trade-${FUTURES}-result`), '실현 손익 +$152.34 · 수익률 +3.42%');
  assert.equal(h.words(`completed-trade-${SPOT}-name`), '삼성전자');
  assert.equal(h.words(`completed-trade-${SPOT}-result`), '실현 손익 -62,815원 · 수익률 -5.92%');
  assert.equal(h.has(`completed-trade-${SPOT}-share`), true);
  assert.equal(h.has('trade-share-body'), false, 'no sheet until 공유 is pressed');
});

test('a read about another account is never listed', async (t) => {
  const h = tradeShareHarness();
  h.answerAccountId = 'someone-else';
  await h.start();
  t.after(h.close);
  assert.equal(h.has(`completed-trade-${FUTURES}`), false);
});

test('the card: the member\'s own nickname and completion time, the design\'s contract and position lines, 수익금액 by default', async (t) => {
  const h = await opened(t);
  assert.equal(card(h, 'nickname'), 'User-923a3');
  assert.equal(card(h, 'time'), '2026-11-05 21:44:04');
  assert.equal(card(h, 'title'), 'BTCUSDT Perpetual');
  assert.equal(card(h, 'direction'), 'Long');
  assert.equal(card(h, 'leverage'), '10x');
  assert.equal(card(h, 'headline'), '+152.34');
  assert.equal(card(h, 'unit'), 'USD');
  assert.deepEqual([card(h, 'price-0-label'), card(h, 'price-0'), card(h, 'price-1-label'), card(h, 'price-1')],
    ['진입가', '80,958.27', '평균 청산가', '85,681.22']);
  assert.equal(card(h, 'brand'), '트레이딩 클래스');
  assert.equal(card(h, 'invite'), '가상트레이딩 리그에 참여해보세요!');
  assert.equal(h.node('trade-share-metric-amount').props['aria-selected'], true);
  const cardText = h.text(h.node('trade-share-card'));
  assert.equal(/모의투자|선물 모의|가상 트레이딩 ·/u.test(cardText), false, 'no extra category wording');
  assert.equal(cardText.includes('%'), false, '수익금액 shows no rate');
  // The member's own photo policy: no photo → the app's default avatar.
  const avatar = h.renderer.root.findAll((n: any) => n.type === 'ProfileAvatar')[0];
  assert.equal(avatar.props.profileImageUrl === null, true);
  // The image does not follow the system font size.
  const texts = h.node('trade-share-card').findAll((n: any) => n.type === 'Text');
  assert.equal(texts.length > 10 && texts.every((n: any) => n.props.allowFontScaling === false), true);
});

test('수익률 replaces the figure (never both); 수익금액 comes back the same', async (t) => {
  const h = await opened(t);
  await h.press('trade-share-metric-rate');
  assert.equal(card(h, 'headline'), '+3.42%');
  assert.equal(h.has('trade-share-card-unit'), false);
  assert.equal(h.text(h.node('trade-share-card')).includes('152.34'), false, '수익률 shows no amount');
  await h.press('trade-share-metric-amount');
  assert.equal(card(h, 'headline'), '+152.34');
  assert.equal(card(h, 'unit'), 'USD');
});

test('one saturated green for profit, red for a loss, neutral for zero; Long green, Short red', async (t) => {
  const color = (h: any, part: string) => h.node(`trade-share-card-${part}`).props.style.color;
  const profit = await opened(t);
  assert.equal(color(profit, 'headline'), '#14FA2A');
  assert.equal(color(profit, 'direction'), '#14FA2A');
  const loss = await opened(t, { trades: [spotTrade()] }, SPOT);
  assert.equal(card(loss, 'headline'), '-62,815');
  assert.equal(card(loss, 'unit'), '원', 'the trade\'s own currency, not the example\'s USDT');
  assert.equal(color(loss, 'headline'), '#FF3B4A');
  assert.deepEqual([card(loss, 'title'), card(loss, 'subtitle')], ['삼성전자', '005930']);
  assert.deepEqual([card(loss, 'price-0-label'), card(loss, 'price-1-label')], ['평균 매수가', '평균 매도가']);
  assert.equal(loss.has('trade-share-card-direction'), false);
  const zero = await opened(t, { trades: [futuresTrade({ realizedPnl: '0.00000000', returnRate: '0.00000000', direction: 'short' })] });
  assert.equal(card(zero, 'headline'), '0.00');
  assert.equal(color(zero, 'headline'), '#E8EDF7');
  assert.equal(color(zero, 'direction'), '#FF3B4A');
});

test('a trade without a return rate cannot select 수익률 and says why', async (t) => {
  const h = await opened(t, { trades: [futuresTrade({ returnRate: null })] });
  assert.equal(disabled(h, 'trade-share-metric-rate'), true);
  assert.match(h.words('trade-share-rate-unavailable') ?? '', /수익금액만 공유할 수 있어요/u);
  assert.equal(card(h, 'unit'), 'USD');
});

test('nothing can be shared or saved before every picture of the card is drawn', async (t) => {
  const h = tradeShareHarness();
  await h.start();
  t.after(h.close);
  await h.press(`completed-trade-${FUTURES}-share`);
  for (const id of ['trade-share-open', 'trade-share-save'])
    assert.equal(disabled(h, id), true, id);
  assert.equal(h.has('trade-share-preparing'), true);
  await h.loadPictures();
  assert.equal(disabled(h, 'trade-share-open'), false);
  assert.equal(h.has('trade-share-preparing'), false);
});

test('exactly two actions, 공유하기 and 이미지 저장: no per-app buttons', async (t) => {
  const h = await opened(t);
  const buttons = h.renderer.root.findAll((n: any) => typeof n.type === 'string' && n.props.accessibilityRole === 'button'
    && /^trade-share-(?:open|save|target-)/u.test(n.props.testID ?? ''));
  assert.deepEqual(buttons.map((n: any) => n.props.testID), ['trade-share-open', 'trade-share-save']);
  assert.equal(h.text(h.node('trade-share-open')), '공유하기');
  assert.equal(h.text(h.node('trade-share-save')), '이미지 저장');
  const sheetText = h.text(h.node('trade-share-body'));
  assert.equal(/인스타그램 스토리|카카오톡|텔레그램|더보기/u.test(sheetText), false, 'no app names promise a direct share');
});

test('공유하기: the captured card goes to the system share sheet; nothing is said for a finished share', async (t) => {
  const h = await opened(t);
  await h.press('trade-share-open');
  assert.equal(names(h), 'capture,sheet');
  assert.equal(h.calls[0].target, 'trade-share-card', 'the card view on screen is what is captured');
  assert.equal(h.calls[1].image.uri, 'file:///cache/card-1.png');
  assert.equal(h.calls[1].args, 1, 'no app is preselected');
  assert.equal(h.status() === null, true);
});

test('a dismissed share sheet is not an error; a sheet that cannot open says so', async (t) => {
  const h = await opened(t);
  h.answers.sheet = 'cancelled';
  await h.press('trade-share-open');
  assert.equal(h.status() === null, true, 'a cancel shows no error');
  h.answers.sheet = 'failed';
  await h.press('trade-share-open');
  assert.equal(h.status(), '공유를 열지 못했어요. 잠시 후 다시 시도해 주세요.');
  // The next attempt starts clean: a later cancel clears the old failure line.
  h.answers.sheet = 'cancelled';
  await h.press('trade-share-open');
  assert.equal(h.status() === null, true);
});

test('a double tap opens one share sheet; every action waits for the one in flight', async (t) => {
  const h = await opened(t);
  const pending = deferred();
  h.answers.sheet = () => pending.promise;
  await h.doublePress('trade-share-open');
  assert.equal(names(h), 'capture,sheet');
  assert.equal(h.text(h.node('trade-share-open')), '여는 중…');
  for (const id of ['trade-share-open', 'trade-share-save', 'trade-share-metric-rate'])
    assert.equal(disabled(h, id), true, id);
  await h.press('trade-share-save');
  assert.equal(names(h), 'capture,sheet', 'a press on a disabled action does nothing');
  pending.resolve('shared');
  await h.flush();
  assert.equal(disabled(h, 'trade-share-save'), false);
  assert.equal(h.text(h.node('trade-share-open')), '공유하기');
});

test('one capture per shown card: reused while unchanged, taken again after the figure changes', async (t) => {
  const h = await opened(t);
  await h.press('trade-share-open');
  await h.press('trade-share-save');
  assert.equal(names(h), 'capture,sheet,save');
  assert.equal(h.calls[2].image.uri, h.calls[1].image.uri);
  await h.press('trade-share-metric-rate');
  await h.press('trade-share-open');
  assert.equal(names(h), 'capture,sheet,save,capture,sheet');
  assert.notEqual(h.calls[4].image.uri, h.calls[1].image.uri);
});

test('a share call that throws (e.g. a build without the native module) is a reported failure, and the sheet stays usable', async (t) => {
  const h = await opened(t);
  h.answers.sheet = new Error('native module missing');
  await h.press('trade-share-open');
  assert.equal(names(h), 'capture,sheet');
  assert.equal(h.status(), '공유를 열지 못했어요. 잠시 후 다시 시도해 주세요.');
  assert.equal(disabled(h, 'trade-share-open'), false, 'the lock is released');
  assert.equal(disabled(h, 'trade-share-save'), false);
});

test('a failed capture shares nothing', async (t) => {
  const h = await opened(t);
  h.answers.capture = new Error('blank snapshot');
  await h.press('trade-share-open');
  assert.equal(names(h), 'capture');
  assert.equal(h.status(), '공유 이미지를 만들지 못했어요. 잠시 후 다시 시도해 주세요.');
});

test('이미지 저장: saved, a refused permission or a failure, each told apart', async (t) => {
  const h = await opened(t);
  await h.press('trade-share-save');
  assert.equal(h.status(), '사진 앱에 저장했어요.');
  h.answers.save = 'permission_denied';
  await h.press('trade-share-save');
  assert.match(h.status() ?? '', /사진 저장 권한이 없어/u);
  h.answers.save = 'failed';
  await h.press('trade-share-save');
  assert.equal(h.status(), '이미지를 저장하지 못했어요. 잠시 후 다시 시도해 주세요.');
});

test('closing the sheet while the card is captured drops the share', async (t) => {
  const h = await opened(t);
  const pending = deferred();
  h.answers.capture = () => pending.promise;
  await h.press('trade-share-open');
  await h.closeSheet();
  assert.equal(h.has('trade-share-body'), false);
  pending.resolve({ uri: 'file:///cache/late.png' });
  await h.flush();
  assert.equal(names(h), 'capture', 'nothing opens after the sheet closed');
});

test('a sign-out or another sign-in during an action drops the share', async (t) => {
  const h = await opened(t);
  const pending = deferred();
  h.answers.capture = () => pending.promise;
  await h.press('trade-share-open');
  session.invalidateSession(session.getSessionGeneration());
  pending.resolve({ uri: 'file:///cache/late.png' });
  await h.flush();
  assert.equal(names(h), 'capture');
});

test('without the app (web) the card previews, and actions say they need the app', async (t) => {
  const h = await opened(t, { supported: false });
  assert.equal(card(h, 'headline'), '+152.34');
  assert.equal(h.has('trade-share-unsupported'), true);
  assert.equal(disabled(h, 'trade-share-open'), true);
  assert.equal(disabled(h, 'trade-share-save'), true);
});

test('no profile, no card: the sheet offers a retry instead of a card without the member', async (t) => {
  const h = tradeShareHarness();
  h.meFailure = new Error('offline');
  await h.start();
  t.after(h.close);
  await h.open(FUTURES);
  assert.equal(h.has('trade-share-card'), false);
  assert.equal(h.has('trade-share-profile-error'), true);
  h.meFailure = null;
  await h.press('trade-share-profile-retry');
  assert.equal(card(h, 'nickname'), 'User-923a3');
});
