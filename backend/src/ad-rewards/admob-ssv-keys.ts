import { createPublicKey, type KeyObject } from 'node:crypto';

/**
 * Google's AdMob SSV public keys (developers.google.com/admob/android/ssv):
 * `{ "keys": [{ "keyId": <int>, "pem": "...", "base64": "<SPKI DER>" }] }`.
 *
 * - Production keys verify real callbacks. Google rotates them on a variable
 *   schedule and says not to cache them for longer than 24 hours: they are
 *   re-read after 12 h, and at once (at most once a minute) when a callback
 *   names an unknown key_id. A failed re-read keeps a cache younger than 24 h
 *   and is not repeated for 10 s; with nothing usable — or an unknown key_id
 *   while the key server fails — the callback is answered 503 so Google
 *   retries. The cache is in memory: a restart during a key-server outage
 *   answers 503 until a read succeeds.
 * - Google's test key set (the reference Tink verifier's TEST url) only lets
 *   the AdMob console's "Verify URL" check be ACKNOWLEDGED: a callback that
 *   verifies with a test key alone never redeems anything.
 */
export const ADMOB_SSV_KEYS_URL =
  'https://www.gstatic.com/admob/reward/verifier-keys.json';
export const ADMOB_SSV_TEST_KEYS_URL =
  'https://www.gstatic.com/admob/reward/verifier-keys-test.json';

export type AdMobKeySet = 'production' | 'test';

const KEY_REFRESH_MS = 12 * 3_600_000;
const KEY_MAX_AGE_MS = 24 * 3_600_000;
const UNKNOWN_KEY_REFRESH_MIN_MS = 60_000;
const FAILED_REFRESH_BACKOFF_MS = 10_000;
const FETCH_TIMEOUT_MS = 5_000;

export type AdMobKeyFetch = (url: string) => Promise<unknown>;

/** The key server read: HTTP 200 JSON only, bounded in time. */
export const fetchAdMobKeys: AdMobKeyFetch = async (url) => {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (response.status !== 200)
    // @diagnosticSurface internal: AdMobSsvKeyStore.key() catches and discards every key read failure; the SSV callback answers only its fixed 503 KEYS_UNAVAILABLE outcome. The text carries the HTTP status alone, never the URL or the body.
    throw new Error(`AdMob key server answered ${response.status}`);
  return response.json();
};

/** Parses the key file; keys that are not EC public keys are skipped. */
export function parseAdMobKeyFile(body: unknown): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  const list =
    body &&
    typeof body === 'object' &&
    Array.isArray((body as { keys?: unknown }).keys)
      ? (body as { keys: unknown[] }).keys
      : null;
  if (!list)
    // @diagnosticSurface internal: Only AdMobSsvKeyStore.refresh() parses key files; key() catches and discards the failed read, and the SSV callback answers its fixed 503 KEYS_UNAVAILABLE outcome. Fixed text, no key material.
    throw new Error('AdMob key file has no keys array');
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const { keyId, base64, pem } = entry as Record<string, unknown>;
    const id =
      typeof keyId === 'number' && Number.isSafeInteger(keyId) && keyId >= 0
        ? String(keyId)
        : typeof keyId === 'string' && /^\d{1,20}$/u.test(keyId)
          ? keyId
          : null;
    if (!id) continue;
    try {
      const key =
        typeof base64 === 'string' && base64
          ? createPublicKey({
              key: Buffer.from(base64, 'base64'),
              format: 'der',
              type: 'spki',
            })
          : typeof pem === 'string' && pem
            ? createPublicKey(pem)
            : null;
      if (key?.asymmetricKeyType === 'ec') keys.set(id, key);
    } catch {
      // An unreadable entry verifies nothing.
    }
  }
  return keys;
}

type CachedSet = { keys: Map<string, KeyObject>; fetchedAt: number };

export class AdMobSsvKeyStore {
  private readonly sets = new Map<AdMobKeySet, CachedSet>();
  private readonly attempts = new Map<AdMobKeySet, number>();
  private readonly inflight = new Map<AdMobKeySet, Promise<CachedSet>>();

  constructor(
    private readonly fetchJson: AdMobKeyFetch = fetchAdMobKeys,
    private readonly clock: () => number = () => Date.now(),
    private readonly urls: Record<AdMobKeySet, string> = {
      production: ADMOB_SSV_KEYS_URL,
      test: ADMOB_SSV_TEST_KEYS_URL,
    },
  ) {}

  /**
   * The key; null when the latest read of the set (which succeeded) has no
   * such key; 'unavailable' when it cannot be decided now — no set younger
   * than 24 h, or an unknown key_id while the latest read failed (it may be
   * a rotated key): the callback is then answered 503.
   */
  async key(
    set: AdMobKeySet,
    keyId: string,
  ): Promise<KeyObject | null | 'unavailable'> {
    const now = this.clock();
    let cached = this.sets.get(set);
    const lastAttempt = this.attempts.get(set);
    const due = !cached || now - cached.fetchedAt >= KEY_REFRESH_MS;
    const missing = !!cached && !cached.keys.has(keyId);
    // Bounded reads whatever callers send: an unknown key_id re-reads at
    // most once a minute, and a failed read is not repeated within the
    // backoff (each one may take the full fetch timeout).
    const allowed =
      lastAttempt === undefined ||
      now - lastAttempt >=
        (due ? FAILED_REFRESH_BACKOFF_MS : UNKNOWN_KEY_REFRESH_MIN_MS);
    if ((due || missing) && allowed) {
      try {
        cached = await this.refresh(set);
      } catch {
        // A cache younger than 24 h stays usable.
      }
    }
    if (!cached || now - cached.fetchedAt >= KEY_MAX_AGE_MS)
      return 'unavailable';
    const key = cached.keys.get(keyId);
    if (key) return key;
    const latestReadFailed =
      (this.attempts.get(set) ?? -Infinity) > cached.fetchedAt;
    return latestReadFailed ? 'unavailable' : null;
  }

  private refresh(set: AdMobKeySet): Promise<CachedSet> {
    const running = this.inflight.get(set);
    if (running) return running;
    this.attempts.set(set, this.clock());
    const next = this.fetchJson(this.urls[set])
      .then((body) => {
        const fresh = {
          keys: parseAdMobKeyFile(body),
          fetchedAt: this.clock(),
        };
        this.sets.set(set, fresh);
        return fresh;
      })
      .finally(() => this.inflight.delete(set));
    this.inflight.set(set, next);
    return next;
  }
}
