import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { ProfileImageSelectionError, PROFILE_IMAGE_MAX_BYTES } from './profileImageTypes.ts';
import { getSessionGeneration, invalidateSession, assertCurrentSession } from '../../services/api/sessionOwnership.ts';

const require = createRequire(import.meta.url);
const { load } = require('../../../test/ledgerTestHarness.cjs');
const image = { uri: 'file:///normalized.jpg', name: 'profile.jpg', type: 'image/jpeg' };

function harness(platform: string) {
  const requests: any[] = [];
  const data = { id: 'viewer', profileImageUrl: null };
  const api = load(resolve('src/features/me/api.ts'), {
    'react-native': { Platform: { OS: platform } },
    './profileImageTypes': { ProfileImageSelectionError, PROFILE_IMAGE_MAX_BYTES },
    '../../services/api/sessionOwnership': { getSessionGeneration, assertCurrentSession },
    '../../services/api/client': { apiClient: {
      post: async (...args: unknown[]) => { requests.push(args); return { data: { data } }; },
      delete: async (...args: unknown[]) => { requests.push(args); return { data: { data } }; },
    } },
  });
  return { api, requests, data };
}

describe('profile image multipart API', () => {
  it('uses the native URI descriptor with current authenticated API client', async t => {
    const original = globalThis.FormData;
    const entries: unknown[][] = [];
    globalThis.FormData = class { append(...values: unknown[]) { entries.push(values); } } as any;
    t.after(() => { globalThis.FormData = original; });
    const h = harness('android');
    assert.deepEqual(await h.api.uploadProfileImage(image), h.data);
    assert.deepEqual(entries, [['file', image]]);
    assert.equal(h.requests[0][0], '/me/profile-image');
    assert.equal(h.requests[0][2].headers['Content-Type'], 'multipart/form-data');
    assert.deepEqual(await h.api.deleteProfileImage(), h.data);
    assert.equal(h.requests[1][0], '/me/profile-image');
  });

  it('uses a Web JPEG Blob and lets the browser generate the multipart boundary', async t => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(new Blob(['JPEG'], { type: 'image/jpeg' }))) as any;
    t.after(() => { globalThis.fetch = original; });
    const h = harness('web'); await h.api.uploadProfileImage(image);
    const file = h.requests[0][1].get('file') as File;
    assert.equal(file.type, 'image/jpeg'); assert.equal(file.name, 'profile.jpg');
    assert.equal(h.requests[0][2].headers['Content-Type'], undefined);
  });

  it('rejects oversized normalized output before requesting an upload', async t => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(new Blob([new Uint8Array(PROFILE_IMAGE_MAX_BYTES + 1)], { type: 'image/jpeg' }))) as any;
    t.after(() => { globalThis.fetch = original; });
    const h = harness('web'); await assert.rejects(() => h.api.uploadProfileImage(image), { reason: 'too_large' });
    assert.deepEqual(h.requests, []);
  });

  it('does not submit a prepared blob under a newer login session', async t => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => { invalidateSession(getSessionGeneration()); return new Response(new Blob(['JPEG'])); }) as any;
    t.after(() => { globalThis.fetch = original; });
    const h = harness('web'); await assert.rejects(() => h.api.uploadProfileImage(image), { name: 'SessionSupersededError' });
    assert.deepEqual(h.requests, []);
  });
});
