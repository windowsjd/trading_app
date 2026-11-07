import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { commentAnonymityLocked, communityWriteGate, restrictionMessage, showAnonymousPhotoNotice } from './gates.ts';

const bootstrap = (patch: Record<string, unknown> = {}) => ({
  rulesVersion: '2026-11-07', rulesAccepted: true, reasons: [], maxPhotos: 4, postBodyMaxLength: 500, commentBodyMaxLength: 300,
  me: { kind: 'public' as const, userId: 'me', nickname: 'me', profileImageUrl: null, tier: null }, activeSanction: null, ...patch,
}) as never;

describe('community write gate (contract §6.4–6.5)', () => {
  it('unknown, failed, restricted, rules, open', () => {
    assert.equal(communityWriteGate(undefined).kind, 'loading');
    assert.equal(communityWriteGate(null, true).kind, 'unavailable');
    assert.equal(communityWriteGate(bootstrap({ rulesAccepted: false })).kind, 'rules');
    assert.equal(communityWriteGate(bootstrap()).kind, 'open');
    // A restriction wins over a missing consent: nothing would let them write.
    const restricted = communityWriteGate(bootstrap({ rulesAccepted: false, activeSanction: { reason: 'ABUSE', until: null } }));
    assert.equal(restricted.kind, 'restricted');
    assert.equal(restricted.kind === 'restricted' && restricted.message, '커뮤니티 이용이 제한되었어요 (영구)');
  });

  it('names the end date in Korea time', () => {
    // 2026-12-07T15:30Z is 12-08 00:30 KST.
    assert.equal(restrictionMessage({ until: '2026-12-07T15:30:00.000Z' }), '커뮤니티 이용이 제한되었어요 (2026.12.08까지)');
    assert.equal(restrictionMessage({ until: '2026-12-07T03:00:00.000Z' }), '커뮤니티 이용이 제한되었어요 (2026.12.07까지)');
    assert.equal(restrictionMessage({ until: null }), '커뮤니티 이용이 제한되었어요 (영구)');
  });

  it('warns about photos only on anonymous posts with photos', () => {
    assert.deepEqual([showAnonymousPhotoNotice(true, 1), showAnonymousPhotoNotice(true, 0), showAnonymousPhotoNotice(false, 4)], [true, false, false]);
  });

  it('locks 익명 on for the anonymous post\'s own author only', () => {
    const post = (mine: boolean, kind: 'anonymous' | 'public') => ({ mine, author: kind === 'anonymous'
      ? { kind, label: '익명' } : { kind, userId: 'u', nickname: 'n', profileImageUrl: null, tier: null } }) as never;
    assert.deepEqual([commentAnonymityLocked(post(true, 'anonymous')), commentAnonymityLocked(post(false, 'anonymous')),
      commentAnonymityLocked(post(true, 'public')), commentAnonymityLocked(null)], [true, false, false, false]);
  });
});
