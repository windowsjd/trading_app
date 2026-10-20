import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MyRankingDto, RankingItemDto, RankingsResponseDto } from './api.ts';
import { availableRankings } from './fixtures.ts';
import { podiumEntries } from './podium.ts';

const row = (rank: number, patch: Partial<RankingItemDto> = {}): RankingItemDto => ({
  ...availableRankings.rankings[0], rank, seasonParticipantId: `sp-${rank}`, userId: `user-${rank}`, nickname: `trader-${rank}`,
  ...patch,
});
const publication = (rows: RankingItemDto[], patch: Partial<RankingsResponseDto> = {}): RankingsResponseDto => ({
  ...structuredClone(availableRankings), rankings: rows,
  pagination: { limit: 3, offset: 0, total: rows.length, returned: rows.length, nextOffset: null }, ...patch,
} as RankingsResponseDto);
const me = (seasonParticipantId: string): MyRankingDto => ({ ...availableRankings.myRanking, seasonParticipantId } as MyRankingDto);

describe('podiumEntries', () => {
  it('takes exactly ranks 1, 2 and 3 of the whole ranking, in place order', () => {
    const entries = podiumEntries(publication([row(1), row(2), row(3)]), null);
    assert.deepEqual(entries?.map((entry) => [entry.place, entry.item.seasonParticipantId, entry.mine]),
      [[1, 'sp-1', false], [2, 'sp-2', false], [3, 'sp-3', false]]);
  });

  it('draws nothing without three confirmed places', () => {
    for (const rows of [[], [row(1)], [row(1), row(2)]]) assert.equal(podiumEntries(publication(rows), null), null, `${rows.length}`);
    // A hidden participant leaves a gap: ranks 1, 2, 4 are not a podium.
    assert.equal(podiumEntries(publication([row(1), row(2), row(4)]), null), null);
    assert.equal(podiumEntries(publication([row(2), row(3), row(4)]), null), null);
    // The same participant twice is never three people.
    assert.equal(podiumEntries(publication([row(1), row(2), row(3, { seasonParticipantId: 'sp-2' })]), null), null);
    // Not the first window, not available, or not loaded.
    assert.equal(podiumEntries(publication([row(1), row(2), row(3)], { pagination: { limit: 3, offset: 3, total: 9, returned: 3, nextOffset: 6 } }), null), null);
    assert.equal(podiumEntries(publication([row(1), row(2), row(3)], { state: 'unavailable' }), null), null);
    assert.equal(podiumEntries(undefined, null), null);
  });

  it('marks me by participant id, never by nickname', () => {
    const rows = [row(1), row(2, { nickname: 'me' }), row(3)];
    assert.deepEqual(podiumEntries(publication(rows), me('sp-3'))?.map((entry) => entry.mine), [false, false, true]);
    assert.deepEqual(podiumEntries(publication(rows), me('sp-9'))?.map((entry) => entry.mine), [false, false, false]);
    assert.deepEqual(podiumEntries(publication(rows), { state: 'not_joined', reason: 'SEASON_NOT_JOINED', message: '-' })
      ?.map((entry) => entry.mine), [false, false, false]);
  });
});
