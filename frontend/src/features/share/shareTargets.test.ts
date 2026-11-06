import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHARE_TARGETS,
  normalizeMetaAppId,
  planShareTarget,
  shareOutcomeMessage,
  type ShareOutcome,
} from './shareTargets.ts';

const APP_ID = '123456789012345';

test('the row is 인스타그램 스토리 · 카카오톡 · 텔레그램 · 더보기, in that order', () => {
  assert.deepEqual(SHARE_TARGETS.map((item) => item.label), ['인스타그램 스토리', '카카오톡', '텔레그램', '더보기']);
  // Screen readers hear the right particle for each name.
  assert.deepEqual(SHARE_TARGETS.map((item) => item.accessibilityLabel),
    ['인스타그램 스토리로 공유', '카카오톡으로 공유', '텔레그램으로 공유', '다른 앱으로 공유 (더보기)']);
});

test('Instagram Stories needs a configured Meta App ID; without one nothing opens', () => {
  for (const platform of ['ios', 'android']) {
    assert.equal(planShareTarget('instagram_story', platform, null).kind, 'unconfigured');
    assert.equal(planShareTarget('instagram_story', platform, 'not-an-id').kind, 'unconfigured');
  }
  const android = planShareTarget('instagram_story', 'android', APP_ID);
  assert.equal(android.kind, 'instagram_story');
  assert.equal(android.kind === 'instagram_story' && android.appId, APP_ID);
  assert.equal(JSON.stringify(android.kind === 'instagram_story' && android.app), '{"packageName":"com.instagram.android"}');
  const ios = planShareTarget('instagram_story', 'ios', APP_ID);
  assert.equal(JSON.stringify(ios.kind === 'instagram_story' && ios.app), '{"scheme":"instagram-stories://share"}');
});

test('Telegram is direct on Android only; iOS opens the system sheet with a pick-Telegram hint', () => {
  const android = planShareTarget('telegram', 'android', APP_ID);
  assert.equal(android.kind, 'direct');
  assert.equal(JSON.stringify(android.kind === 'direct' && android.app), '{"packageName":"org.telegram.messenger"}');
  const ios = planShareTarget('telegram', 'ios', APP_ID);
  assert.equal(ios.kind, 'sheet');
  assert.equal(ios.kind === 'sheet' && ios.hint, '공유 목록에서 텔레그램을 선택해 주세요.');
  assert.equal(JSON.stringify(ios.kind === 'sheet' && ios.app), '{"scheme":"tg://"}');
});

test('KakaoTalk never pretends to be direct: the system sheet with a pick-KakaoTalk hint, after an installed check', () => {
  for (const platform of ['ios', 'android']) {
    const plan = planShareTarget('kakaotalk', platform, APP_ID);
    assert.equal(plan.kind, 'sheet');
    assert.equal(plan.kind === 'sheet' && plan.hint, '공유 목록에서 카카오톡을 선택해 주세요.');
    assert.equal(plan.kind === 'sheet' && plan.app !== null, true);
  }
});

test('더보기 is the plain system sheet; the web has no native sharing', () => {
  const more = planShareTarget('more', 'android', null);
  assert.equal(more.kind, 'sheet');
  assert.equal(more.kind === 'sheet' && more.app === null && more.hint === null, true);
  for (const target of ['instagram_story', 'kakaotalk', 'telegram', 'more'] as const)
    assert.equal(planShareTarget(target, 'web', APP_ID).kind, 'unsupported');
});

test('a Meta App ID is digits only', () => {
  assert.equal(normalizeMetaAppId(` ${APP_ID} `), APP_ID);
  assert.equal(normalizeMetaAppId('') === null, true);
  assert.equal(normalizeMetaAppId('12ab') === null, true);
  assert.equal(normalizeMetaAppId(undefined) === null, true);
});

test('a finished or cancelled share says nothing; failures and missing apps are explained', () => {
  for (const outcome of ['shared', 'cancelled'] as ShareOutcome[])
    assert.equal(shareOutcomeMessage(outcome, 'more') === null, true);
  assert.equal(shareOutcomeMessage('not_installed', 'kakaotalk'), '카카오톡이 설치되어 있지 않아요. 더보기로 다른 앱에 공유할 수 있어요.');
  assert.equal(shareOutcomeMessage('not_installed', 'instagram_story'), '인스타그램이 설치되어 있지 않아요. 더보기로 다른 앱에 공유할 수 있어요.');
  assert.match(shareOutcomeMessage('opened', 'instagram_story') ?? '', /게시는 인스타그램에서 직접/u);
  assert.match(shareOutcomeMessage('unconfigured', 'instagram_story') ?? '', /준비 중/u);
  assert.match(shareOutcomeMessage('permission_denied', 'save') ?? '', /권한/u);
  assert.equal(shareOutcomeMessage('saved', 'save'), '사진 앱에 저장했어요.');
  assert.match(shareOutcomeMessage('failed', 'save') ?? '', /저장하지 못했어요/u);
  assert.match(shareOutcomeMessage('capture_failed', 'more') ?? '', /이미지를 만들지 못했어요/u);
  // Nothing claims a post was published.
  for (const outcome of ['opened', 'saved', 'failed', 'not_installed'] as ShareOutcome[])
    assert.equal(/게시했|게시되었|업로드했/u.test(shareOutcomeMessage(outcome, 'instagram_story') ?? ''), false);
});
