import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { RecordSeasonListItemDto } from './api';
import { toSeasonBadges } from './seasonBadges.ts';

/** One `/records/me/seasons` item as the backend returns it (records.service). */
const item = (patch: Partial<RecordSeasonListItemDto> = {}): RecordSeasonListItemDto => ({
  seasonId: 'season-1', seasonName: 'Season 1', seasonStatus: 'settled', participantStatus: 'finished',
  joinedAt: '2026-05-01T00:00:00.000Z', finalRank: 3, finalTier: 'gold', finalQualified: null,
  latestReturnRate: '4.50000000', latestTotalAssetKrw: '10450000.00000000', ...patch,
});

it('a settled season with a confirmed final rank and tier becomes one card with its final figures', () => {
  assert.deepEqual(toSeasonBadges([item()]), [{
    seasonId: 'season-1', seasonName: 'Season 1', finalRank: 3, finalTier: 'gold',
    returnRate: '4.50000000', totalAssetKrw: '10450000.00000000',
  }]);
  // Qualified under an eligibility rule is the same official result.
  assert.equal(toSeasonBadges([item({ finalQualified: true })]).length, 1);
});

it('a season that is not settled never becomes a card, even with a provisional or corrected rank', () => {
  for (const seasonStatus of ['upcoming', 'active', 'ended', undefined]) {
    assert.equal(toSeasonBadges([item({ seasonStatus })]).length, 0, String(seasonStatus));
  }
});

it('no confirmed final rank or tier means no card: nothing is invented', () => {
  const rejected = [
    item({ finalRank: null }), item({ finalRank: undefined }), item({ finalRank: 0 }), item({ finalRank: -1 }),
    item({ finalRank: 1.5 }), item({ finalTier: null }), item({ finalTier: '' }), item({ finalTier: '  ' }),
    // Settlement confirmed the participant did not qualify; an excluded participant is never ranked.
    item({ finalQualified: false }), item({ participantStatus: 'excluded' }),
  ];
  for (const [index, rejectedItem] of rejected.entries()) {
    assert.equal(toSeasonBadges([rejectedItem]).length, 0, `case ${index}`);
  }
});

it('missing figures stay missing instead of borrowing another value', () => {
  const [badge] = toSeasonBadges([item({ latestReturnRate: null, latestTotalAssetKrw: undefined })]);
  assert.deepEqual([badge.returnRate, badge.totalAssetKrw], [null, null]);
});

it('every season keeps its own card and figures, in the server order, once per season', () => {
  const badges = toSeasonBadges([
    item({ seasonId: 'season-3', seasonName: 'Season 3', finalRank: 1, finalTier: 'master', latestReturnRate: '-12.34560000' }),
    item({ seasonId: 'season-2', seasonName: 'Season 2', seasonStatus: 'active', finalRank: 7 }),
    item(),
    // A repeated row (a retried page) never doubles a season.
    item({ finalRank: 99, latestReturnRate: '1.00000000' }),
  ]);
  assert.deepEqual(badges.map((badge) => [badge.seasonId, badge.finalRank, badge.finalTier, badge.returnRate]), [
    ['season-3', 1, 'master', '-12.34560000'],
    ['season-1', 3, 'gold', '4.50000000'],
  ]);
});
