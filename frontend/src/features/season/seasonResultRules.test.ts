import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  awaitsSettlement,
  canAutoOpen,
  hasFinalResultOnStack,
  isAtHomeRoot,
  seasonMayChange,
  unseenSettledSeason,
} from './seasonResultRules.ts';

const account = (season: Record<string, unknown> | null, mode = 'season') => ({ id: 'acct-1', mode, season } as never);
const season = (change: Record<string, unknown> = {}) => ({
  seasonId: 'sea-1', seasonName: 'season0', seasonStatus: 'settled', startAt: '2026-11-14T11:00:00.000Z',
  endAt: '2026-11-29T15:00:00.000Z', seasonParticipantId: 'sp-1', participantStatus: 'finished', joinedAt: '2026-11-14T11:01:00.000Z',
  finalResultViewedAt: null, ...change,
});
const result = (change: Record<string, unknown> = {}) => ({
  season: { id: 'sea-1', name: 'season0', status: 'settled', startAt: '', endAt: '' },
  participantStatus: 'finished', viewedAt: null,
  result: { state: 'not_qualified', totalAssetKrw: '10000000', returnRate: '0', tradedInstrumentCount: 0, recognizedTurnoverKrw: '0' },
  ...change,
} as never);

const HOME = { index: 0, routes: [{ name: 'MainTabs', state: { index: 0, routes: [{ name: 'HomeTab', state: { index: 0, routes: [{ name: 'Home' }] } }] } }] };

describe('시즌최종결과 자동 표시 — rules', () => {
  it('watches settlement only for the selected season account while it is ended', () => {
    assert.equal(awaitsSettlement(account(season({ seasonStatus: 'ended' }))), true);
    for (const status of ['upcoming', 'active', 'settled']) assert.equal(awaitsSettlement(account(season({ seasonStatus: status }))), false);
    assert.equal(awaitsSettlement(account(null, 'general')), false);
    assert.equal(awaitsSettlement(null), false);
    assert.equal(seasonMayChange(account(season({ seasonStatus: 'active' }))), true);
    assert.equal(seasonMayChange(account(season({ seasonStatus: 'ended' }))), true);
    assert.equal(seasonMayChange(account(season())), false, 'a settled season has nothing left to change');
  });

  it('the only candidate is the selected account’s settled season with an explicitly unseen result', () => {
    assert.deepEqual(unseenSettledSeason(account(season())), { accountId: 'acct-1', seasonId: 'sea-1' });
    assert.equal(unseenSettledSeason(account(season({ seasonStatus: 'ended' }))), null, 'never before settlement');
    assert.equal(unseenSettledSeason(account(season({ finalResultViewedAt: '2026-11-30T01:00:00.000Z' }))), null, 'already seen');
    const { finalResultViewedAt: _omit, ...older } = season();
    assert.equal(unseenSettledSeason(account(older)), null, 'an absent field (older server) is unknown, never unseen');
    assert.equal(unseenSettledSeason(account(null, 'general')), null);
    assert.equal(unseenSettledSeason(account(season(), 'beginner')), null);
  });

  it('opens only on the server’s own shown, unseen result of that very season', () => {
    assert.equal(canAutoOpen(result(), 'sea-1'), true);
    assert.equal(canAutoOpen(result({ result: { state: 'available', finalRank: 1, finalTier: 'gold', totalAssetKrw: '1', returnRate: '0', capturedAt: '' } }), 'sea-1'), true);
    assert.equal(canAutoOpen(result({ result: { state: 'excluded' } }), 'sea-1'), true, 'the screen shows (and records) an exclusion');
    assert.equal(canAutoOpen(result({ result: { state: 'pending' } }), 'sea-1'), false);
    assert.equal(canAutoOpen(result({ result: { state: 'unavailable', reason: 'X' } }), 'sea-1'), false);
    assert.equal(canAutoOpen(result({ result: { state: 'not_joined' } }), 'sea-1'), false);
    assert.equal(canAutoOpen(result({ viewedAt: '2026-11-30T01:00:00.000Z' }), 'sea-1'), false);
    assert.equal(canAutoOpen(result({ season: { id: 'sea-1', name: 'season0', status: 'ended' } }), 'sea-1'), false);
    assert.equal(canAutoOpen(result(), 'sea-other'), false, 'another season’s result never opens for this one');
    assert.equal(canAutoOpen(undefined, 'sea-1'), false);
  });

  it('the safe place is Home’s first screen; any pushed or other screen waits', () => {
    assert.equal(isAtHomeRoot(HOME), true);
    assert.equal(isAtHomeRoot({ index: 0, routes: [{ name: 'MainTabs' }] }), true, 'tabs not laid out yet open on Home');
    assert.equal(isAtHomeRoot({ index: 0, routes: [{ name: 'MainTabs', state: { index: 0, routes: [{ name: 'HomeTab', state: { index: 1, routes: [{ name: 'Home' }, { name: 'Portfolio' }] } }] } }] }), false);
    assert.equal(isAtHomeRoot({ index: 0, routes: [{ name: 'MainTabs', state: { index: 1, routes: [{ name: 'HomeTab' }, { name: 'MarketTab', state: { index: 2, routes: [{ name: 'Market' }, { name: 'AssetDetail' }, { name: 'Order' }] } }] } }] }), false, 'an order in progress');
    assert.equal(isAtHomeRoot({ index: 0, routes: [{ name: 'MainTabs', state: { index: 1, routes: [{ name: 'HomeTab' }, { name: 'RankingTab', state: { index: 0, routes: [{ name: 'Ranking' }] } }] } }] }), false, 'another tab');
    assert.equal(isAtHomeRoot({ index: 1, routes: [{ name: 'MainTabs' }, { name: 'AssetChart' }] }), false, 'a chart over the tabs');
    assert.equal(isAtHomeRoot({ index: 0, routes: [{ name: 'ModeSelection' }] }), false);
    assert.equal(isAtHomeRoot(undefined), false);
    assert.equal(hasFinalResultOnStack({ index: 1, routes: [{ name: 'MainTabs' }, { name: 'SeasonFinalResult' }] }), true);
    assert.equal(hasFinalResultOnStack(HOME), false);
  });
});
