import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import {
  adMobRewardTime,
  adMobSsvUserId,
  parseAdMobSsvQuery,
  verifyAdMobSsvSignature,
} from './admob-ssv';
import { AdMobSsvKeyStore, parseAdMobKeyFile } from './admob-ssv-keys';

/**
 * Google's AdMob SSV callback format (developers.google.com/admob/android/ssv),
 * MOCK-signed with a locally generated P-256 key standing in for Google's:
 * this proves the parser and the ECDSA/SHA-256/DER check, not a real Google
 * callback (that needs the AdMob console's Verify URL or a real ad).
 */
const google = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const stranger = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const KEY_ID = '3335741209';

function keyFile(entries: Array<{ keyId: number | string; key: KeyObject }>) {
  return {
    keys: entries.map(({ keyId, key }) => ({
      keyId,
      pem: key.export({ type: 'spki', format: 'pem' }),
      base64: key.export({ type: 'spki', format: 'der' }).toString('base64'),
    })),
  };
}
const webSafe = (buffer: Buffer) =>
  buffer
    .toString('base64')
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '');

/** A callback query as Google sends it: alphabetical params, then signature and key_id. */
function callback(
  overrides: Record<string, string> = {},
  { signer = google.privateKey, signDecoded = true, keyId = KEY_ID } = {},
) {
  const params: Record<string, string> = {
    ad_network: '5450213213286189855',
    ad_unit: '3165650506',
    custom_data: '0d5b8a43-6a1e-4c55-9d0b-4bbf8f6a1c2e',
    reward_amount: '1',
    reward_item: '가상 자금',
    timestamp: '1762483200123',
    transaction_id: '18fa792de1bca816048293fc71035638',
    user_id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    ...overrides,
  };
  const content = Object.keys(params)
    .sort()
    .map((name) => `${name}=${encodeURIComponent(params[name])}`)
    .join('&');
  const message = signDecoded ? decodeURIComponent(content) : content;
  const signature = sign('sha256', Buffer.from(message, 'utf8'), {
    key: signer,
    dsaEncoding: 'der',
  });
  return `${content}&signature=${webSafe(signature)}&key_id=${keyId}`;
}
const parsed = (query: string) => {
  const result = parseAdMobSsvQuery(query);
  if (!result.ok) throw new Error(result.reason);
  return result.callback;
};

describe('AdMob SSV callback: parsing and Google signature', () => {
  it('verifies the decoded content (Google reference verifier), and the raw reading too', () => {
    const decodedSigned = parsed(callback());
    expect(decodedSigned.keyId).toBe(KEY_ID);
    expect(decodedSigned.params).toEqual({
      adNetwork: '5450213213286189855',
      adUnit: '3165650506',
      customData: '0d5b8a43-6a1e-4c55-9d0b-4bbf8f6a1c2e',
      rewardAmount: '1',
      rewardItem: '가상 자금',
      timestamp: '1762483200123',
      transactionId: '18fa792de1bca816048293fc71035638',
      userId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    });
    expect(verifyAdMobSsvSignature(decodedSigned, google.publicKey)).toBe(true);
    const rawSigned = parsed(callback({}, { signDecoded: false }));
    expect(verifyAdMobSsvSignature(rawSigned, google.publicKey)).toBe(true);
  });

  it('refuses a forged or altered callback and a key that did not sign it', () => {
    expect(
      verifyAdMobSsvSignature(
        parsed(callback({}, { signer: stranger.privateKey })),
        google.publicKey,
      ),
    ).toBe(false);
    const honest = callback();
    // Any byte of the signed content changed: the amount, the event, the session.
    for (const [from, to] of [
      ['transaction_id=18fa', 'transaction_id=28fa'],
      ['custom_data=0d5b', 'custom_data=1d5b'],
      ['ad_unit=3165650506', 'ad_unit=3165650507'],
    ]) {
      expect(
        verifyAdMobSsvSignature(
          parsed(honest.replace(from, to)),
          google.publicKey,
        ),
      ).toBe(false);
    }
    expect(verifyAdMobSsvSignature(parsed(honest), stranger.publicKey)).toBe(
      false,
    );
  });

  it('requires signature and key_id as the last two parameters, in that order, and strict formats', () => {
    const honest = callback();
    const [content, tail] = honest.split('&signature=');
    const [signature, keyPart] = tail.split('&key_id=');
    expect(
      parseAdMobSsvQuery(`key_id=${keyPart}&${content}&signature=${signature}`),
    ).toEqual({ ok: false, reason: 'SIGNATURE_KEY_ID_NOT_LAST' });
    expect(
      parseAdMobSsvQuery(`${content}&key_id=${keyPart}&signature=${signature}`),
    ).toEqual({ ok: false, reason: 'SIGNATURE_KEY_ID_NOT_LAST' });
    expect(parseAdMobSsvQuery(content)).toEqual({
      ok: false,
      reason: 'SIGNATURE_NOT_LAST',
    });
    expect(parseAdMobSsvQuery('')).toEqual({ ok: false, reason: 'QUERY_SIZE' });
    // A repeated parameter could be read two ways: refused before any key is read.
    expect(parseAdMobSsvQuery(`custom_data=x&${honest}`)).toEqual({
      ok: false,
      reason: 'DUPLICATE_PARAMETER',
    });
    expect(parseAdMobSsvQuery(callback({ transaction_id: 'a b' }))).toEqual({
      ok: false,
      reason: 'FORMAT_transaction_id',
    });
    expect(parseAdMobSsvQuery(callback({ ad_unit: 'banner' }))).toEqual({
      ok: false,
      reason: 'FORMAT_ad_unit',
    });
    const missing = callback().replace(/timestamp=\d+&/u, '');
    expect(parseAdMobSsvQuery(missing)).toEqual({
      ok: false,
      reason: 'MISSING_timestamp',
    });
    expect(
      parseAdMobSsvQuery(`${content}&signature=%%&key_id=${keyPart}`),
    ).toEqual({ ok: false, reason: 'SIGNATURE_FORMAT' });
  });

  it('a Google signature for one split can never be re-encoded into another split', () => {
    // An attacker's OWN unit (9999999999) whose custom data smuggles our unit:
    // Google signs the decoded content, where our unit looks like a parameter.
    const ours = '3165650506';
    const session = '0d5b8a43-6a1e-4c55-9d0b-4bbf8f6a1c2e';
    const rest = `reward_amount=1&reward_item=x&timestamp=1762483200123&transaction_id=18fa792de1bca816048293fc71035638&user_id=a1b2c3d4e5f60718293a4b5c6d7e8f90`;
    const signedByGoogle = `ad_network=5450213213286189855&ad_unit=9999999999&custom_data=${session}&ad_unit=${ours}&${rest}`;
    const tail = `&signature=${webSafe(
      sign('sha256', Buffer.from(signedByGoogle, 'utf8'), {
        key: google.privateKey,
        dsaEncoding: 'der',
      }),
    )}&key_id=${KEY_ID}`;
    for (const [content, reason] of [
      // The foreign pair hidden in an escaped NAME: the raw query would read our unit.
      [
        `ad_network%3D5450213213286189855%26ad_unit=9999999999&custom_data=${session}&ad_unit=${ours}&${rest}`,
        'PARAMETER_NAME',
      ],
      // …or in a VALUE that decodes into a separator.
      [
        `ad_network=5450213213286189855%26ad_unit%3D9999999999&custom_data=${session}&ad_unit=${ours}&${rest}`,
        'AMBIGUOUS_VALUE',
      ],
      // Google's own encoding of that callback.
      [
        `ad_network=5450213213286189855&ad_unit=9999999999&custom_data=${session}%26ad_unit%3D${ours}&${rest}`,
        'AMBIGUOUS_VALUE',
      ],
    ]) {
      // Each decoded reading IS what Google signed (it would verify)…
      expect(decodeURIComponent(content)).toBe(signedByGoogle);
      // …and each is refused before any key is read.
      expect(parseAdMobSsvQuery(`${content}${tail}`)).toEqual({
        ok: false,
        reason,
      });
    }
    // Nor may a free-text value hide a second event or session.
    expect(
      parseAdMobSsvQuery(
        callback({ reward_item: 'x&transaction_id=28fa792de1bca816' }),
      ),
    ).toEqual({ ok: false, reason: 'AMBIGUOUS_VALUE' });
    expect(
      parseAdMobSsvQuery(callback({ custom_data: `x=${session}` })),
    ).toEqual({ ok: false, reason: 'AMBIGUOUS_VALUE' });
  });

  it('reads the reward time in ms (and a 16-digit µs value), never an implausible instant', () => {
    expect(adMobRewardTime('1762483200123')?.toISOString()).toBe(
      '2025-11-07T02:40:00.123Z',
    );
    expect(adMobRewardTime('1762483200123456')?.toISOString()).toBe(
      '2025-11-07T02:40:00.123Z',
    );
    expect(adMobRewardTime('150777823')).toBeNull();
    expect(adMobRewardTime('0')).toBeNull();
  });

  it('derives a per-session SSV user id (no stable member id reaches Google)', () => {
    const a = adMobSsvUserId({ id: 's1', userId: 'u1' });
    expect(a).toMatch(/^[0-9a-f]{32}$/u);
    expect(adMobSsvUserId({ id: 's2', userId: 'u1' })).not.toBe(a);
    expect(adMobSsvUserId({ id: 's1', userId: 'u2' })).not.toBe(a);
    expect(adMobSsvUserId({ id: 's1', userId: 'u1' })).toBe(a);
  });
});

describe('AdMob SSV keys (Google key server)', () => {
  const file = keyFile([{ keyId: Number(KEY_ID), key: google.publicKey }]);

  it('parses keyId/base64 (and pem) entries; skips unreadable ones', () => {
    const keys = parseAdMobKeyFile({
      keys: [
        ...file.keys,
        { keyId: 7, base64: 'not a key' },
        { keyId: 'x', base64: file.keys[0].base64 },
        {
          keyId: 8,
          pem: stranger.publicKey.export({ type: 'spki', format: 'pem' }),
        },
      ],
    });
    expect([...keys.keys()].sort()).toEqual([KEY_ID, '8']);
    expect(() => parseAdMobKeyFile({})).toThrow();
  });

  it('caches ≤ 12 h, re-reads an unknown key id at most once a minute, and keeps a < 24 h cache when the server fails', async () => {
    let now = 0;
    const reads: string[] = [];
    let answer: unknown = file;
    let fail = false;
    const store = new AdMobSsvKeyStore(
      (url) => {
        reads.push(url);
        return fail
          ? Promise.reject(new Error('down'))
          : Promise.resolve(answer);
      },
      () => now,
      { production: 'prod', test: 'test' },
    );
    expect(await store.key('production', KEY_ID)).toBeTruthy();
    expect(await store.key('production', KEY_ID)).toBeTruthy();
    expect(reads).toEqual(['prod']);
    // A rotated key the cache lacks: one re-read, then not again within a minute.
    expect(await store.key('production', '42')).toBeNull();
    expect(reads).toEqual(['prod']);
    now += 60_000;
    answer = keyFile([{ keyId: 42, key: stranger.publicKey }]);
    expect(await store.key('production', '42')).toBeTruthy();
    expect(reads).toEqual(['prod', 'prod']);
    // The server failing: a cache younger than 24 h still answers…
    fail = true;
    now += 12 * 3_600_000;
    expect(await store.key('production', '42')).toBeTruthy();
    // …but never one 24 h old: then the callback is answered 503 (Google retries).
    now += 12 * 3_600_000;
    expect(await store.key('production', '42')).toBe('unavailable');
    // The test set is read on its own URL.
    fail = false;
    answer = file;
    expect(await store.key('test', KEY_ID)).toBeTruthy();
    expect(reads.at(-1)).toBe('test');
  });

  it('a failed read is not repeated within 10 s; an unknown key_id while the key server fails is undecidable (503), not forged', async () => {
    let now = 0;
    const reads: string[] = [];
    let fail = true;
    const store = new AdMobSsvKeyStore(
      (url) => {
        reads.push(url);
        return fail ? Promise.reject(new Error('down')) : Promise.resolve(file);
      },
      () => now,
      { production: 'prod', test: 'test' },
    );
    // Nothing cached and the server down: undecidable, and one read only per backoff.
    expect(await store.key('production', KEY_ID)).toBe('unavailable');
    expect(await store.key('production', KEY_ID)).toBe('unavailable');
    expect(reads).toEqual(['prod']);
    now += 10_000;
    fail = false;
    expect(await store.key('production', KEY_ID)).toBeTruthy();
    expect(reads).toEqual(['prod', 'prod']);
    // A rotated key the failing server cannot confirm: 503 (Google retries), never 403.
    fail = true;
    now += 60_000;
    expect(await store.key('production', '77')).toBe('unavailable');
    // The cached key keeps verifying meanwhile.
    expect(await store.key('production', KEY_ID)).toBeTruthy();
    // After a SUCCESSFUL read an unknown key_id is just unknown (forged): 403.
    fail = false;
    now += 60_000;
    expect(await store.key('production', '78')).toBeNull();
    expect(await store.key('production', '79')).toBeNull();
    expect(reads).toEqual(['prod', 'prod', 'prod', 'prod']);
  });
});
