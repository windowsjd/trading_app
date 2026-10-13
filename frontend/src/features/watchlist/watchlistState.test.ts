import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WatchlistDto, WatchlistItemDto } from './api';
import {
  applyConfirmedChange,
  resolveWatchState,
  watchlistChangeMessage,
} from './watchlistState.ts';

const item = (assetId: string, addedAt: string): WatchlistItemDto => ({
  assetId,
  symbol: assetId.toUpperCase(),
  name: assetId,
  market: 'KRX',
  assetType: 'domestic_stock',
  isActive: true,
  addedAt,
});
const list = (...items: WatchlistItemDto[]): WatchlistDto => ({ items, limit: 50 });
const ids = (value: WatchlistDto) => value.items.map((entry) => entry.assetId).join(',');

describe('applyConfirmedChange', () => {
  it('places a confirmed add in the server order (newest first, asset id descending)', () => {
    const current = list(item('b', '2026-10-13T02:00:00.000Z'), item('a', '2026-10-13T01:00:00.000Z'));
    assert.equal(ids(applyConfirmedChange(current, { item: item('c', '2026-10-13T03:00:00.000Z'), created: true })), 'c,b,a');
    assert.equal(ids(applyConfirmedChange(current, { item: item('z', '2026-10-13T01:00:00.000Z'), created: true })), 'b,z,a');
    assert.equal(ids(applyConfirmedChange(current, { item: item('0', '2026-10-13T00:00:00.000Z'), created: true })), 'b,a,0');
  });

  it('keeps the same list for an add the cache already holds and for a remove of an absent item', () => {
    const current = list(item('a', '2026-10-13T01:00:00.000Z'));
    assert.equal(applyConfirmedChange(current, { item: item('a', '2026-10-13T09:00:00.000Z'), created: false }) === current, true);
    assert.equal(applyConfirmedChange(current, { assetId: 'x', removed: false }) === current, true);
  });

  it('drops a confirmed remove and leaves the other items untouched', () => {
    const current = list(item('b', '2026-10-13T02:00:00.000Z'), item('a', '2026-10-13T01:00:00.000Z'));
    const next = applyConfirmedChange(current, { assetId: 'b', removed: true });
    assert.equal(ids(next), 'a');
    assert.equal(next.items[0] === current.items[1], true);
    assert.equal(ids(current), 'b,a');
  });
});

describe('resolveWatchState', () => {
  const watched = new Set(['a']);
  it('shows a pending request as its target, otherwise the server list', () => {
    assert.deepEqual(resolveWatchState('a', watched, new Map([['a', false]])), { watched: false, pending: true });
    assert.deepEqual(resolveWatchState('b', watched, new Map([['b', true]])), { watched: true, pending: true });
    assert.deepEqual(resolveWatchState('a', watched, new Map()), { watched: true, pending: false });
    assert.deepEqual(resolveWatchState('b', watched, new Map()), { watched: false, pending: false });
  });

  it('reports an unknown server list as unknown, never as "not watched"', () => {
    assert.deepEqual(resolveWatchState('a', null, new Map()), { watched: null, pending: false });
  });
});

describe('watchlistChangeMessage', () => {
  it('names the cap, the non-addable asset and an unknown asset; otherwise the direction', () => {
    assert.match(watchlistChangeMessage(true, 'WATCHLIST_LIMIT_EXCEEDED', 50), /최대 50개/u);
    assert.match(watchlistChangeMessage(true, 'ASSET_NOT_TRADABLE'), /추가할 수 없습니다/u);
    assert.match(watchlistChangeMessage(true, 'ASSET_NOT_FOUND'), /찾을 수 없습니다/u);
    assert.match(watchlistChangeMessage(true, undefined), /^관심종목에 추가하지 못했습니다/u);
    assert.match(watchlistChangeMessage(false, 'INTERNAL_SERVER_ERROR'), /^관심종목에서 해제하지 못했습니다/u);
  });
});
