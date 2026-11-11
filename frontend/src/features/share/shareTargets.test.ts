import assert from 'node:assert/strict';
import { it } from 'node:test';
import { shareOutcomeMessage, type ShareOutcome } from './shareTargets.ts';

it('a finished or dismissed share sheet says nothing; every other outcome is told apart', () => {
  assert.equal(shareOutcomeMessage('shared', 'share'), null);
  assert.equal(shareOutcomeMessage('cancelled', 'share'), null, 'closing the share sheet is not a failure');
  assert.equal(shareOutcomeMessage('saved', 'save'), '사진 앱에 저장했어요.');
  assert.match(shareOutcomeMessage('permission_denied', 'save')!, /사진 저장 권한이 없어/u);
  assert.equal(shareOutcomeMessage('failed', 'share'), '공유를 열지 못했어요. 잠시 후 다시 시도해 주세요.');
  assert.equal(shareOutcomeMessage('failed', 'save'), '이미지를 저장하지 못했어요. 잠시 후 다시 시도해 주세요.');
  assert.equal(shareOutcomeMessage('capture_failed', 'share'), '공유 이미지를 만들지 못했어요. 잠시 후 다시 시도해 주세요.');
  assert.equal(shareOutcomeMessage('unsupported', 'share'), '공유와 저장은 앱에서 이용할 수 있어요.');
});

it('no message names a specific app: the user picks one in the system sheet', () => {
  const outcomes: ShareOutcome[] = ['shared', 'cancelled', 'saved', 'permission_denied', 'unsupported', 'capture_failed', 'failed'];
  for (const outcome of outcomes) for (const action of ['share', 'save'] as const) {
    assert.equal(/인스타그램|카카오톡|텔레그램|더보기/u.test(shareOutcomeMessage(outcome, action) ?? ''), false, `${outcome}/${action}`);
  }
});
