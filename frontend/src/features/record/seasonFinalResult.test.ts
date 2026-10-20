import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SeasonFinalResultDto } from './api.ts';
import { toSeasonBadges } from './seasonBadges.ts';
import { finalResultBadge, isShownFinalResult } from './seasonFinalResult.ts';

const dto = (
  result: SeasonFinalResultDto['result'],
  patch: Partial<SeasonFinalResultDto> = {},
): SeasonFinalResultDto => ({
  season: {
    id: 'season-1',
    name: 'Season 1',
    status: 'settled',
    startAt: '2026-09-01T00:00:00.000Z',
    endAt: '2026-10-01T00:00:00.000Z',
  },
  participantStatus: 'finished',
  viewedAt: null,
  result,
  ...patch,
});

const ranked = {
  state: 'available' as const,
  finalRank: 3,
  finalTier: 'gold',
  totalAssetKrw: '12345678.90000000',
  returnRate: '23.45670000',
  capturedAt: '2026-10-01T00:00:05.000Z',
};

describe('isShownFinalResult', () => {
  it('records only an official outcome as seen', () => {
    assert.equal(isShownFinalResult(ranked), true);
    assert.equal(
      isShownFinalResult({
        state: 'not_qualified',
        totalAssetKrw: '1',
        returnRate: '0',
        tradedInstrumentCount: 2,
        recognizedTurnoverKrw: null,
      }),
      true,
    );
    assert.equal(isShownFinalResult({ state: 'excluded' }), true);
    for (const state of ['pending', 'not_joined'] as const) {
      assert.equal(isShownFinalResult({ state }), false, state);
    }
    assert.equal(
      isShownFinalResult({ state: 'unavailable', reason: 'FINAL_RESULT_UNAVAILABLE' }),
      false,
    );
  });
});

describe('finalResultBadge', () => {
  it('is the card 내 뱃지 builds from the same settled figures', () => {
    const badge = finalResultBadge(dto(ranked));
    const myBadges = toSeasonBadges([
      {
        seasonId: 'season-1',
        seasonName: 'Season 1',
        seasonStatus: 'settled',
        participantStatus: 'finished',
        finalQualified: null,
        joinedAt: '2026-09-01T00:00:00.000Z',
        finalRank: 3,
        finalTier: 'gold',
        latestReturnRate: '23.45670000',
        latestTotalAssetKrw: '12345678.90000000',
      },
    ]);

    assert.deepEqual(badge, myBadges[0]);
  });

  it('has no badge without a confirmed final rank and tier', () => {
    assert.equal(
      finalResultBadge(
        dto({
          state: 'not_qualified',
          totalAssetKrw: '1',
          returnRate: '0',
          tradedInstrumentCount: 1,
          recognizedTurnoverKrw: null,
        }),
      ),
      null,
    );
    assert.equal(finalResultBadge(dto({ state: 'excluded' })), null);
    assert.equal(finalResultBadge(dto({ state: 'pending' })), null);
    // 내 뱃지's own guards still apply (a settled season, a real tier).
    assert.equal(
      finalResultBadge(dto(ranked, { season: { ...dto(ranked).season, status: 'ended' } })),
      null,
    );
    assert.equal(finalResultBadge(dto({ ...ranked, finalTier: ' ' })), null);
  });
});
