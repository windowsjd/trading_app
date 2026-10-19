import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { NOTIFICATION_PREFERENCE_KEYS } from './types.ts';

const require = createRequire(import.meta.url);
const { load } = require('../../../test/ledgerTestHarness.cjs');
const preferences = Object.fromEntries(NOTIFICATION_PREFERENCE_KEYS.map((key) => [key, true]));

function api(answer: Record<string, unknown>) {
  const calls: unknown[][] = [];
  const reply = async (...args: unknown[]) => { calls.push(args); return { data: { success: true, data: answer } }; };
  const module = load(resolve('src/features/notifications/api.ts'), {
    '../../services/api/client': { apiClient: { get: reply, patch: reply } },
    '../../constants/env': { API_BASE_URL: 'https://app.example/api/v1' },
  });
  return { module, calls };
}

describe('notification settings transport', () => {
  it('reads 전체 알림 beside the seven switches', async () => {
    const { module, calls } = api({ allEnabled: false, preferences });
    assert.deepEqual(await module.getNotificationPreferences(), { allEnabled: false, preferences });
    assert.equal(calls[0][0], '/notifications/preferences');
  });

  it('a server before 전체 알림 answers without it: null, never a guessed on/off', async () => {
    for (const allEnabled of [undefined, 'false', 1, null]) {
      const { module } = api({ ...(allEnabled === undefined ? {} : { allEnabled }), preferences });
      assert.equal((await module.getNotificationPreferences()).allEnabled, null, String(allEnabled));
    }
  });

  it('sends only the changed field and answers with the stored settings', async () => {
    const { module, calls } = api({ allEnabled: true, preferences });
    assert.deepEqual(await module.updateNotificationPreferences({ allEnabled: true }), { allEnabled: true, preferences });
    assert.deepEqual(calls[0], ['/notifications/preferences', { allEnabled: true }]);
  });
});
