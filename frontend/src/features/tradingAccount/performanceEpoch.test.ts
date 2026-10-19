import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isResetEpoch, openingFundingLabel, resetEpochNote } from './performanceEpoch.ts';

describe('general account performance epoch wording', () => {
  it('reads an account never reset (or an older server) as its opening epoch', () => {
    for (const summary of [{}, { performanceEpoch: { sequence: 0, startedAt: '2026-10-01T00:00:00.000Z' } }]) {
      assert.equal(isResetEpoch(summary), false);
      assert.equal(openingFundingLabel(summary), '최초 지급금');
      assert.equal(resetEpochNote(summary), null);
    }
  });

  it('names the reset target and where the shown performance starts after a reset', () => {
    const summary = { performanceEpoch: { sequence: 2, startedAt: '2026-10-20T03:04:05.000Z' } };
    assert.equal(isResetEpoch(summary), true);
    assert.equal(openingFundingLabel(summary), '초기화 기준 자금');
    assert.equal(resetEpochNote(summary), '2026-10-20 12:04 일반계정 초기화 이후의 성과입니다.');
    assert.equal(
      resetEpochNote({ performanceEpoch: { sequence: 1, startedAt: 'not-a-time' } }),
      '일반계정을 초기화한 뒤의 성과입니다.',
    );
  });
});
