import assert from 'node:assert/strict';
import { it } from 'node:test';
import { canManageCommunity } from './permissions.ts';

it('offers the operator tools to operator and admin sessions only (display gate)', () => {
  assert.deepEqual(['operator', 'admin', 'user', null, undefined].map((role) => canManageCommunity(role as never)), [true, true, false, false, false]);
});
