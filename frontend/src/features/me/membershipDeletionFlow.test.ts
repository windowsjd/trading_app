import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  confirmMembershipDeletion,
  createMembershipDeletionKey,
  forgetMembershipDeletion,
  membershipDeletionRequestKey,
  rememberMembershipDeletion,
  settleMembershipDeletion,
  type MembershipDeletionReceipt,
} from './membershipDeletionFlow.ts';

const receipt: MembershipDeletionReceipt = {
  status: 'completed',
  deletedAt: '2026-10-18T00:00:00.000Z',
  completedAt: '2026-10-18T00:00:00.000Z',
};
const httpError = (status: number, code?: string) =>
  Object.assign(new Error(code ?? `HTTP ${status}`), {
    isAxiosError: true,
    request: {},
    response: { status, data: code ? { success: false, error: { code } } : {} },
  });
const networkError = () =>
  Object.assign(new Error('Network Error'), { isAxiosError: true, request: {} });

describe('회원탈퇴 outcome', () => {
  it('is deleted only by a server receipt, never by request success alone', async () => {
    const lookups: string[] = [];
    const outcome = await settleMembershipDeletion(
      async () => receipt,
      async () => { lookups.push('status'); return null; },
    );
    assert.equal(outcome.kind, 'deleted');
    assert.equal(lookups.length, 0);
  });

  it('treats server refusals as final for the attempt without a status lookup', async () => {
    for (const code of [
      'ACCOUNT_DELETION_PASSWORD_MISMATCH',
      'ACCOUNT_DELETION_ROLE_RESTRICTED',
      'ACCOUNT_DELETION_REQUIRES_SUPPORT',
      'ACCOUNT_DELETION_FAILED',
      'USER_NOT_ACTIVE',
    ]) {
      let lookups = 0;
      const outcome = await settleMembershipDeletion(
        async () => { throw httpError(code === 'ACCOUNT_DELETION_FAILED' ? 503 : 400, code); },
        async () => { lookups++; return receipt; },
      );
      assert.equal(outcome.kind, 'refused');
      assert.equal(outcome.kind === 'refused' && outcome.code, code);
      assert.equal(lookups, 0);
    }
  });

  it('resolves lost responses, proxy errors and an already-gone account by the receipt', async () => {
    for (const failure of [networkError(), httpError(502), httpError(401, 'UNAUTHORIZED'), new Error('superseded')]) {
      const deleted = await settleMembershipDeletion(async () => { throw failure; }, async () => receipt);
      assert.equal(deleted.kind, 'deleted');
      const kept = await settleMembershipDeletion(async () => { throw failure; }, async () => null);
      assert.equal(kept.kind, 'not_deleted');
      const unknown = await settleMembershipDeletion(async () => { throw failure; }, async () => { throw networkError(); });
      assert.equal(unknown.kind, 'unknown');
    }
  });

  it('rechecks only through the status lookup', async () => {
    assert.equal((await confirmMembershipDeletion(async () => receipt, null)).kind, 'deleted');
    assert.equal((await confirmMembershipDeletion(async () => null, null)).kind, 'not_deleted');
  });
});

describe('회원탈퇴 request key', () => {
  it('joins two platform UUIDs (web crypto first, then the Expo native generator)', () => {
    let n = 0;
    const uuid = () => `00000000-0000-4000-8000-00000000000${n++}`;
    const web = createMembershipDeletionKey({ crypto: { randomUUID: uuid } });
    assert.equal(web, `${'00000000-0000-4000-8000-000000000000'}${'00000000-0000-4000-8000-000000000001'}`.replace(/-/g, ''));
    assert.match(web, /^[A-Za-z0-9_-]{32,128}$/);
    const native = createMembershipDeletionKey({ expo: { uuidv4: uuid } });
    assert.match(native, /^[0-9a-f]{64}$/);
    assert.notEqual(native, web);
  });

  it('still produces a valid unique key without a platform generator', () => {
    const first = createMembershipDeletionKey({});
    const second = createMembershipDeletionKey({});
    assert.match(first, /^[A-Za-z0-9_-]{32,128}$/);
    assert.notEqual(first, second);
  });

  it('keeps the last confirmed key in memory until forgotten', () => {
    rememberMembershipDeletion('k'.repeat(43));
    assert.equal(membershipDeletionRequestKey(), 'k'.repeat(43));
    forgetMembershipDeletion();
    assert.equal(membershipDeletionRequestKey(), null);
  });
});
