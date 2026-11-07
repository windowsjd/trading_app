import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const { load } = require('../../../test/ledgerTestHarness.cjs');

type Call = { method: string; path: string; body?: unknown; config?: any };
function harness(platform = 'ios', responses: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const answer = (method: string) => async (path: string, body?: unknown, config?: unknown) => {
    const record: Call = method === 'get' || method === 'delete' ? { method, path, config: body } : { method, path, body, config };
    calls.push(record);
    const key = Object.keys(responses).find((prefix) => `${method} ${path}`.startsWith(prefix));
    return { data: { success: true, data: key ? responses[key] : undefined } };
  };
  const api = load(resolve('src/features/community/api.ts'), {
    'react-native': { Platform: { OS: platform } },
    '../../services/api/client': { apiClient: { get: answer('get'), post: answer('post'), put: answer('put'), delete: answer('delete') } },
    '../../services/api/sessionOwnership': { getSessionGeneration: () => 1, assertCurrentSession: () => {} },
  });
  return { api, calls };
}

const PUBLIC = { kind: 'public', userId: 'author-1', nickname: 'bluechip', profileImageUrl: null, tier: 'gold' };
const post = (patch: Record<string, unknown> = {}) => ({
  id: 'post-1', category: 'free', body: '내일 시초가 어떻게 보세요?', createdAt: '2026-11-07T03:00:00.000Z', author: PUBLIC,
  asset: { id: 'asset-1', symbol: '000660', name: 'SK Hynix', market: 'KRX', assetType: 'domestic_stock' },
  photos: [{ url: 'https://cdn.example.com/community-images/x.jpg', width: 1280, height: 960 }],
  likeCount: 12, commentCount: 7, likedByMe: false, mine: false, isHot: true, ...patch,
});
const page = (key: string, items: unknown[], nextOffset: number | null = null) => ({
  [key]: items, pagination: { limit: 20, offset: 0, total: items.length, returned: items.length, nextOffset },
});

describe('community API responses (contract §4)', () => {
  it('reads a feed page and keeps nothing an anonymous author must not carry', async () => {
    const h = harness('ios', { 'get /community/posts?category=hot': page('posts', [
      post(), post({ id: 'post-2', author: { kind: 'anonymous', label: '익명', userId: 'secret-user', nickname: 'secret-nick', profileImageUrl: 'https://secret/p.jpg' } }),
    ]) });
    const result = await h.api.getCommunityPosts('hot', 0, 3);
    assert.equal(h.calls[0].path, '/community/posts?category=hot&limit=3&offset=0');
    assert.equal(result.items.length, 2);
    assert.equal(result.items[0].author.kind, 'public');
    const serialized = JSON.stringify(result.items[1]);
    assert.equal(/secret-user|secret-nick|secret\/p\.jpg/.test(serialized), false);
    assert.equal(result.nextOffset === null, true);
  });

  it('refuses shapes the contract does not allow', async () => {
    for (const bad of [post({ category: 'hot' }), post({ author: { kind: 'robot' } }), post({ likeCount: -1 }), post({ photos: [{ url: 'x', width: 0, height: 1 }] })]) {
      const h = harness('ios', { 'get /community/posts?': page('posts', [bad]) });
      await assert.rejects(h.api.getCommunityPosts('all', 0), (error: Error) => error.name === 'CommunityResponseError');
    }
    // A deleted comment keeps neither text nor author; a comment of another post is refused.
    const comment = (patch: Record<string, unknown>) => ({ id: 'c1', postId: 'post-1', parentCommentId: null, deleted: false, body: '좋아요',
      createdAt: '2026-11-07T03:00:00.000Z', author: { kind: 'deleted_member', label: '탈퇴계정' }, likeCount: 0, likedByMe: false, mine: false, ...patch });
    const ok = harness('ios', { 'get /community/posts/post-1/comments': page('comments', [comment({}), comment({ id: 'c2', deleted: true, body: null, author: null })]) });
    const read = await ok.api.getCommunityComments('post-1', 'likes', 0);
    assert.equal(ok.calls[0].path, '/community/posts/post-1/comments?sort=likes&limit=50&offset=0');
    assert.equal(read.items.map((item: any) => item.author?.kind ?? 'none').join(','), 'deleted_member,none');
    for (const bad of [comment({ deleted: true, body: '남은 글', author: null }), comment({ postId: 'post-9' })]) {
      const h = harness('ios', { 'get /community/posts/post-1/comments': page('comments', [bad]) });
      await assert.rejects(h.api.getCommunityComments('post-1', 'latest', 0), (error: Error) => error.name === 'CommunityResponseError');
    }
  });

  it('reads the bootstrap with the server limits and the restriction', async () => {
    const h = harness('ios', { 'get /community/bootstrap': {
      rulesVersion: '2026-11-07', rulesAccepted: false, maxPhotos: 4, postBodyMaxLength: 500, commentBodyMaxLength: 300,
      reasons: [{ code: 'OTHER', label: '기타', description: '그 밖의 위반', noteRequired: true }],
      me: { userId: 'me', nickname: 'mycroft', profileImageUrl: null, tier: 'silver' }, activeSanction: { reason: 'ABUSE', until: null },
    } });
    const bootstrap = await h.api.getCommunityBootstrap();
    assert.equal([bootstrap.rulesAccepted, bootstrap.reasons[0].noteRequired, bootstrap.me.tier, bootstrap.activeSanction.until === null].join('|'), 'false|true|silver|true');
  });
});

describe('community API writes', () => {
  const withFormData = async (run: () => Promise<void>) => {
    const original = globalThis.FormData;
    class RecordingForm { parts: unknown[][] = []; append(...args: unknown[]) { this.parts.push(args); } }
    (globalThis as any).FormData = RecordingForm;
    try { await run(); } finally { (globalThis as any).FormData = original; }
  };

  it('posts multipart: one payload part, one photos part per photo, the multipart hint on native', async () => withFormData(async () => {
    const h = harness('android', { 'post /community/posts': { post: post({ mine: true, body: '본문' }), replayed: false } });
    const result = await h.api.createCommunityPost({ clientRequestId: 'community_post_1234', category: 'free', body: '본문', anonymous: true, assetId: 'asset-1',
      photos: [{ uri: 'file:///1.jpg', name: 'photo-1.jpg', type: 'image/jpeg', width: 1280, height: 960 }, { uri: 'file:///2.jpg', name: 'photo-2.jpg', type: 'image/jpeg', width: 960, height: 1280 }] });
    const form = h.calls[0].body as { parts: unknown[][] };
    assert.equal(form.parts.map((part) => part[0]).join(','), 'payload,photos,photos');
    const payload = JSON.parse(form.parts[0][1] as string);
    assert.equal([payload.clientRequestId, payload.category, payload.body, payload.anonymous, payload.assetId].join('|'), 'community_post_1234|free|본문|true|asset-1');
    assert.equal((form.parts[1][1] as { uri: string }).uri, 'file:///1.jpg');
    assert.equal(h.calls[0].config.headers['Content-Type'], 'multipart/form-data');
    assert.equal(h.calls[0].config.timeout >= 30000, true);
    assert.equal(result.replayed, false);
  }));

  it('web sends blobs with their names and lets the browser set the boundary', async () => withFormData(async () => {
    const originalFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => ({ blob: async () => 'BLOB' });
    try {
      const h = harness('web', { 'post /community/posts': { post: post({ mine: true, body: '본문', photos: [] }), replayed: true } });
      const result = await h.api.createCommunityPost({ clientRequestId: 'community_post_1234', category: 'free', body: '본문', anonymous: false, assetId: null,
        photos: [{ uri: 'blob:1', name: 'photo-1.jpg', type: 'image/jpeg', width: 10, height: 10 }] });
      const form = h.calls[0].body as { parts: unknown[][] };
      assert.equal(form.parts[1].join('|'), 'photos|BLOB|photo-1.jpg');
      assert.equal(h.calls[0].config.headers['Content-Type'] === undefined, true);
      assert.equal(JSON.parse(form.parts[0][1] as string).assetId === undefined, true);
      assert.equal(result.replayed, true);
    } finally { (globalThis as any).fetch = originalFetch; }
  }));

  it('likes use PUT and DELETE and trust only a matching answer', async () => {
    const h = harness('ios', { 'put /community/posts/p/like': { liked: true, likeCount: 3 }, 'delete /community/posts/p/like': { liked: false, likeCount: 2 } });
    assert.equal((await h.api.setCommunityPostLike('p', true)).likeCount, 3);
    assert.equal((await h.api.setCommunityPostLike('p', false)).likeCount, 2);
    assert.equal(h.calls.map((call) => `${call.method} ${call.path}`).join(','), 'put /community/posts/p/like,delete /community/posts/p/like');
    const wrong = harness('ios', { 'put /community/comments/c/like': { liked: false, likeCount: 3 } });
    await assert.rejects(wrong.api.setCommunityCommentLike('c', true), (error: Error) => error.name === 'CommunityResponseError');
  });

  it('a report replays the first one; operator calls carry the reason', async () => {
    const h = harness('ios', {
      'post /community/reports': { report: { targetType: 'comment', targetId: 'c', reason: 'ABUSE', createdAt: '2026-11-07T03:00:00.000Z' }, replayed: true },
      'post /operator/community/posts/p/remove': { removal: { targetType: 'post', targetId: 'p', deletionKind: 'operator', reason: 'OTHER', removedAt: '2026-11-07T03:00:00.000Z' }, replayed: false },
    });
    assert.equal((await h.api.reportCommunityTarget({ targetType: 'comment', targetId: 'c', reason: 'ABUSE' })).replayed, true);
    const removed = await h.api.removeCommunityPost('p', { reason: 'OTHER', note: '사유 메모' });
    assert.equal(`${removed.removal.deletionKind}/${removed.replayed}`, 'operator/false');
    assert.equal(JSON.stringify(h.calls[1].body), JSON.stringify({ reason: 'OTHER', note: '사유 메모' }));
  });
});
