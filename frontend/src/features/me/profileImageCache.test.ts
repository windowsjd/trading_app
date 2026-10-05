import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { QUERY_KEYS } from '../../constants/queryKeys.ts';
import { getSessionGeneration, startSessionInstall, isCurrentSession } from '../../services/api/sessionOwnership.ts';
import type { MeDto } from './api.ts';

const require = createRequire(import.meta.url);
const { QueryClient } = require('@tanstack/react-query');
const { load } = require('../../../test/ledgerTestHarness.cjs');
const { applyProfileImageResponse } = load(resolve('src/features/me/profileImageCache.ts'), {
  '../../constants/queryKeys': { QUERY_KEYS },
  '../../services/api/sessionOwnership': { isCurrentSession },
});
const me: MeDto = { id: 'viewer', email: 'me@example.test', nickname: 'me', profileImageUrl: null, role: 'user', status: 'active', portfolioPublic: true, createdAt: '2026-10-06T00:00:00Z' };

describe('profile image cache propagation', () => {
  it('updates shared /me immediately and invalidates only avatar-bearing self-dependent queries', async t => {
    const client = new QueryClient(); t.after(() => client.clear());
    const list = QUERY_KEYS.ranking.list({ scope: 'overall' });
    const infinite = QUERY_KEYS.ranking.infiniteList({ scope: 'friends' });
    const own = QUERY_KEYS.ranking.userSeasonSummary(me.id);
    const other = QUERY_KEYS.ranking.userSeasonSummary('other');
    const unrelated = [other, QUERY_KEYS.friends.list, QUERY_KEYS.record.seasons(), QUERY_KEYS.tradingAccount.wallets('account')];
    for (const key of [list, infinite, own, ...unrelated]) client.setQueryData(key, { marker: key });
    client.setQueryData(QUERY_KEYS.me, me);
    await applyProfileImageResponse(client, { ...me, profileImageUrl: 'https://cdn.example.test/new.jpg' }, getSessionGeneration());
    assert.equal(client.getQueryData(QUERY_KEYS.me).profileImageUrl, 'https://cdn.example.test/new.jpg');
    for (const key of [list, infinite, own]) assert.equal(client.getQueryState(key).isInvalidated, true);
    for (const key of unrelated) assert.equal(client.getQueryState(key).isInvalidated, false);
    await applyProfileImageResponse(client, me, getSessionGeneration());
    assert.equal(client.getQueryData(QUERY_KEYS.me).profileImageUrl, null);
  });

  it('preserves concurrent nickname and privacy changes', async t => {
    const client = new QueryClient(); t.after(() => client.clear());
    client.setQueryData(QUERY_KEYS.me, { ...me, nickname: 'new name', portfolioPublic: false });
    await applyProfileImageResponse(client, { ...me, profileImageUrl: 'https://cdn.example.test/new.jpg' }, getSessionGeneration());
    assert.deepEqual(client.getQueryData(QUERY_KEYS.me), { ...me, nickname: 'new name', portfolioPublic: false, profileImageUrl: 'https://cdn.example.test/new.jpg' });
  });

  it('never repopulates a missing/different user or the same user in a newer session', async t => {
    const client = new QueryClient(); t.after(() => client.clear());
    await applyProfileImageResponse(client, me, getSessionGeneration()); assert.equal(client.getQueryData(QUERY_KEYS.me), undefined);
    client.setQueryData(QUERY_KEYS.me, { ...me, id: 'other' });
    await applyProfileImageResponse(client, me, getSessionGeneration()); assert.equal(client.getQueryData(QUERY_KEYS.me).id, 'other');
    client.setQueryData(QUERY_KEYS.me, me); const owner = getSessionGeneration(); startSessionInstall(owner);
    await applyProfileImageResponse(client, { ...me, profileImageUrl: 'https://old-session.example.test/photo.jpg' }, owner);
    assert.equal(client.getQueryData(QUERY_KEYS.me).profileImageUrl, null);
  });
});
