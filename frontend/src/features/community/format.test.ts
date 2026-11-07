import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { communityTextLength, formatCommunityCount, formatCommunityTime, formatKstDate } from './format.ts';

describe('community time and count copy', () => {
  const now = Date.parse('2026-11-07T12:00:00.000Z');
  it('relative times, then the KST date', () => {
    const at = (ms: number) => new Date(now - ms).toISOString();
    assert.deepEqual([
      formatCommunityTime(at(20_000), now), formatCommunityTime(at(8 * 60_000), now), formatCommunityTime(at(3 * 3_600_000), now),
      formatCommunityTime(at(2 * 86_400_000), now), formatCommunityTime(at(10 * 86_400_000), now), formatCommunityTime(at(-60_000), now),
      formatCommunityTime('nope', now),
    ], ['방금 전', '8분 전', '3시간 전', '2일 전', '2026.10.28', '방금 전', '-']);
    assert.equal(formatKstDate('2026-11-07T16:00:00.000Z'), '2026.11.08');
  });
  it('counts and code points', () => {
    assert.deepEqual([formatCommunityCount(0), formatCommunityCount(9999), formatCommunityCount(12_000), formatCommunityCount(15_300)], ['0', '9999', '1.2만', '1.5만']);
    assert.equal(communityTextLength('  가😀나  '), 3);
  });
});
