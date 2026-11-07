import assert from 'node:assert/strict';
import { it } from 'node:test';
import { replyTargetId, uniqueById, withLike } from './listUtils.ts';

it('joins offset pages without repeats, replies to the top comment, toggles likes', () => {
  const items = uniqueById([{ items: [{ id: 'a' }, { id: 'b' }] }, { items: [{ id: 'b' }, { id: 'c' }] }]);
  assert.equal(items.map((item) => item.id).join(','), 'a,b,c');
  assert.equal(uniqueById(undefined).length, 0);
  assert.equal(replyTargetId({ id: 'reply', parentCommentId: 'root' }), 'root');
  assert.equal(replyTargetId({ id: 'root', parentCommentId: null }), 'root');
  const liked = withLike({ likedByMe: false, likeCount: 2 }, true);
  assert.equal(`${liked.likedByMe}/${liked.likeCount}`, 'true/3');
  const same = { likedByMe: true, likeCount: 3 };
  assert.equal(withLike(same, true) === same, true);
  assert.equal(withLike({ likedByMe: true, likeCount: 0 }, false).likeCount, 0);
});
