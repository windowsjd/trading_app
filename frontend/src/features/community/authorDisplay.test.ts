import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describeCommentAuthor, describePostAuthor } from './authorDisplay.ts';

const PUBLIC = { kind: 'public' as const, userId: 'user-7', nickname: 'bluechip', profileImageUrl: 'https://cdn.example.com/p.jpg', tier: 'gold' as const };
const fields = (display: ReturnType<typeof describePostAuthor>) =>
  [display.kind, display.name, display.userId, display.profileImageUrl, display.tier, display.tierName, display.pressable, display.postAuthorTag].join('|');

describe('community author display (contract §3)', () => {
  it('a public author carries the identity that opens 유저 시즌 요약 and the tier name', () => {
    assert.equal(fields(describePostAuthor(PUBLIC)), 'public|bluechip|user-7|https://cdn.example.com/p.jpg|gold|Gold|true|false');
    assert.equal(describePostAuthor({ ...PUBLIC, tier: 'master' }).tierName, 'Whale');
    assert.equal(describePostAuthor({ ...PUBLIC, tier: null }).tierName === null, true);
  });

  it('익명, 익명N, 글쓴이 and 탈퇴계정 carry no identity and open nothing', () => {
    assert.equal(fields(describePostAuthor({ kind: 'anonymous', label: '익명' })), 'anonymous|익명|||||false|false');
    const comment = (author: unknown, deleted = false) => describeCommentAuthor({ deleted, author: author as never });
    assert.equal(fields(comment({ kind: 'anonymous', label: '익명3', isPostAuthor: false })), 'anonymous|익명3|||||false|false');
    assert.equal(fields(comment({ kind: 'anonymous', label: '익명', isPostAuthor: true })), 'anonymous|익명|||||false|true');
    assert.equal(fields(comment({ kind: 'deleted_member', label: '탈퇴계정' })), 'deleted_member|탈퇴계정|||||false|false');
    assert.equal(fields(comment(null, true)), 'deleted|삭제된 댓글|||||false|false');
    assert.equal(fields(comment(PUBLIC)), 'public|bluechip|user-7|https://cdn.example.com/p.jpg|gold|Gold|true|false');
  });

  it('a deleted comment shows no author even if one is present', () => {
    const display = describeCommentAuthor({ deleted: true, author: PUBLIC });
    assert.equal(display.kind, 'deleted');
    assert.equal(display.userId === null && display.pressable === false, true);
  });
});
