import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { QUALIFICATION_REFRESH_MS, qualificationNotice, qualificationRefreshMs, wholeWon } from './qualification.ts';

const SEASON = { id: 'sea_2026_s0_20261114', name: 'season0', status: 'active', startAt: '2026-11-14T11:00:00.000Z', endAt: '2026-11-29T15:00:00.000Z' };
const NOW = Date.parse('2026-11-20T03:00:00.000Z');

/** The server's `available` answer (docs/season-final-ranking-eligibility.md §7). */
function answer(change: Record<string, unknown> = {}) {
  return {
    state: 'available', season: SEASON, basis: 'provisional', asOf: '2026-11-20T03:00:00.000Z',
    criteria: { minTradedInstrumentCount: 5, minTurnoverRatio: '3.0000', minRecognizedTurnoverKrw: '30000000.00000000' },
    tradedInstrumentCount: 3, recognizedTurnoverKrw: '12000000.00000000',
    remainingTradedInstrumentCount: 2, remainingRecognizedTurnoverKrw: '18000000.00000000',
    tradedInstrumentRequirementMet: false, turnoverRequirementMet: false, qualified: false,
    ...change,
  };
}
const fallback = (state: string, reason: string, season: unknown = SEASON) => ({
  state, season, basis: null, asOf: null, criteria: null, tradedInstrumentCount: null, recognizedTurnoverKrw: null,
  remainingTradedInstrumentCount: null, remainingRecognizedTurnoverKrw: null, tradedInstrumentRequirementMet: null,
  turnoverRequirementMet: null, qualified: null, reason, message: '',
});

describe('최종 랭킹 참가 기준 안내 — the server verdict only', () => {
  it('1) only the instrument count is short: the notice and exactly the server figures', () => {
    const notice = qualificationNotice(answer({
      recognizedTurnoverKrw: '31000000.00000000', remainingRecognizedTurnoverKrw: '0.00000000', turnoverRequirementMet: true,
    }), SEASON.id, NOW);
    assert.equal(notice?.text, '최종 랭킹 참가 기준을 아직 충족하지 못했습니다.');
    assert.deepEqual(notice?.instruments, { required: '5개', current: '3개', remaining: '2개', met: false });
    assert.deepEqual(notice?.turnover, { required: '30,000,000원', current: '31,000,000원', remaining: null, met: true });
  });

  it('2) only the recognized turnover is short', () => {
    const notice = qualificationNotice(answer({
      tradedInstrumentCount: 6, remainingTradedInstrumentCount: 0, tradedInstrumentRequirementMet: true,
    }), SEASON.id, NOW);
    assert.deepEqual(notice?.instruments, { required: '5개', current: '6개', remaining: null, met: true });
    assert.deepEqual(notice?.turnover, { required: '30,000,000원', current: '12,000,000원', remaining: '18,000,000원', met: false });
  });

  it('3) both are short; the provisional basis names its time in KST', () => {
    const notice = qualificationNotice(answer(), SEASON.id, NOW);
    assert.equal(notice?.phase, 'in_progress');
    assert.equal(notice?.instruments.remaining, '2개');
    assert.equal(notice?.turnover.remaining, '18,000,000원');
    assert.equal(notice?.basisLine, '2026-11-20 12:00 기준의 체결로 본 잠정 판정입니다.');
    assert.ok(notice?.notes.some((note) => note.includes('거래와 잠정 순위·티어 확인은 그대로')), 'not a trading block');
  });

  it('4) both criteria met: nothing', () => {
    assert.equal(qualificationNotice(answer({
      tradedInstrumentCount: 5, remainingTradedInstrumentCount: 0, tradedInstrumentRequirementMet: true,
      recognizedTurnoverKrw: '30000000.00000000', remainingRecognizedTurnoverKrw: '0.00000000', turnoverRequirementMet: true, qualified: true,
    }), SEASON.id, NOW), null);
  });

  it('5) not joined, 6) excluded, 7) a season without criteria: never mistaken for "not met"', () => {
    assert.equal(qualificationNotice(fallback('not_joined', 'SEASON_NOT_JOINED'), SEASON.id, NOW), null);
    assert.equal(qualificationNotice(fallback('unavailable', 'PARTICIPANT_EXCLUDED'), SEASON.id, NOW), null);
    assert.equal(qualificationNotice(fallback('unavailable', 'PARTICIPANT_NOT_ACTIVE'), SEASON.id, NOW), null);
    assert.equal(qualificationNotice(fallback('not_applicable', 'FINAL_RANKING_QUALIFICATION_NOT_REQUIRED'), SEASON.id, NOW), null);
    assert.equal(qualificationNotice(fallback('unavailable', 'CURRENT_SEASON_NOT_FOUND', null), SEASON.id, NOW), null);
  });

  it('8) ended, awaiting settlement: still provisional, said so; no trading sentence', () => {
    for (const [season, now] of [[{ ...SEASON, status: 'ended' }, NOW], [SEASON, Date.parse(SEASON.endAt)]] as const) {
      const notice = qualificationNotice(answer({ season, asOf: SEASON.endAt }), SEASON.id, now);
      assert.equal(notice?.phase, 'awaiting_settlement');
      assert.equal(notice?.text, '최종 랭킹 참가 기준을 충족하지 못했습니다. 정산 후 확정됩니다.');
      assert.match(notice!.basisLine, /정산 후 확정/);
      assert.equal(notice!.notes.some((note) => note.includes('거래와')), false);
    }
  });

  it('9) settled: the confirmed verdict (and a qualified participant sees nothing)', () => {
    const settled = { ...SEASON, status: 'settled' };
    const notice = qualificationNotice(answer({ season: settled, basis: 'final', asOf: SEASON.endAt }), SEASON.id, NOW);
    assert.equal(notice?.phase, 'final');
    assert.equal(notice?.text, '최종 랭킹 참가 기준을 충족하지 못해 최종 순위에 포함되지 않았습니다.');
    assert.equal(notice?.basisLine, '정산에서 확정된 판정입니다.');
    assert.equal(qualificationNotice(answer({ season: settled, basis: 'final', qualified: true,
      tradedInstrumentCount: 5, remainingTradedInstrumentCount: 0, tradedInstrumentRequirementMet: true,
      recognizedTurnoverKrw: '30000000.00000000', remainingRecognizedTurnoverKrw: '0.00000000', turnoverRequirementMet: true }), SEASON.id, NOW), null);
    // A basis that disagrees with the season's state is not shown.
    assert.equal(qualificationNotice(answer({ season: settled }), SEASON.id, NOW), null);
    assert.equal(qualificationNotice(answer({ basis: 'final' }), SEASON.id, NOW), null);
  });

  it('10) a failed, partial or contradictory read shows nothing (never a guessed verdict)', () => {
    for (const value of [undefined, null, 'error', {}, { state: 'available' }]) assert.equal(qualificationNotice(value, SEASON.id, NOW), null);
    for (const change of [
      { qualified: null }, { qualified: 'false' }, { criteria: null }, { basis: null },
      { tradedInstrumentCount: -1 }, { tradedInstrumentCount: 2.5 }, { recognizedTurnoverKrw: '1e7' }, { remainingRecognizedTurnoverKrw: '-1' },
      { tradedInstrumentRequirementMet: null },
      // The server's own fields disagree.
      { tradedInstrumentRequirementMet: true, turnoverRequirementMet: true },
      { remainingTradedInstrumentCount: 0 },
      { turnoverRequirementMet: true },
      { criteria: { minTradedInstrumentCount: 0, minTurnoverRatio: '3.0000', minRecognizedTurnoverKrw: '30000000.00000000' } },
    ]) assert.equal(qualificationNotice(answer(change), SEASON.id, NOW), null, JSON.stringify(change));
  });

  it('another season’s answer is never shown for this one', () => {
    assert.equal(qualificationNotice(answer(), 'sea_2026_s0_release', NOW), null);
    assert.equal(qualificationNotice(answer(), null, NOW), null);
  });

  it('whole won never overstates progress: required/remaining round up, current rounds down', () => {
    assert.equal(wholeWon('29999999.10000000', 'down'), '29,999,999원');
    assert.equal(wholeWon('0.10000000', 'up'), '1원');
    assert.equal(wholeWon('999999.00000001', 'up'), '1,000,000원');
    assert.equal(wholeWon('30000000.00000000', 'up'), '30,000,000원');
    assert.equal(wholeWon('0.00000000', 'down'), '0원');
    const notice = qualificationNotice(answer({
      recognizedTurnoverKrw: '29999999.60000000', remainingRecognizedTurnoverKrw: '0.40000000',
    }), SEASON.id, NOW);
    assert.equal(notice?.turnover.current, '29,999,999원');
    assert.equal(notice?.turnover.remaining, '1원');
  });
});

describe('re-reading the verdict', () => {
  it('only while the tab is on screen and a running season is still short; never after settlement or once met', () => {
    assert.equal(qualificationRefreshMs(answer(), true), QUALIFICATION_REFRESH_MS);
    assert.equal(qualificationRefreshMs(answer(), false), false, 'another tab is in front');
    assert.equal(qualificationRefreshMs(answer({ qualified: true }), true), false);
    assert.equal(qualificationRefreshMs(answer({ basis: 'final' }), true), false);
    assert.equal(qualificationRefreshMs(fallback('not_applicable', 'FINAL_RANKING_QUALIFICATION_NOT_REQUIRED'), true), false);
    assert.equal(qualificationRefreshMs(undefined, true), false);
  });
});
