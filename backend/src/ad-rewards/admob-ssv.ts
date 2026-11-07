import { createHash, verify, type KeyObject } from 'node:crypto';

/**
 * AdMob rewarded-ad server-side verification (SSV) callbacks, as Google
 * documents them (developers.google.com/admob/android/ssv, /ios/ssv):
 *
 *   GET <callback>?ad_network=…&ad_unit=…&custom_data=…&reward_amount=…
 *     &reward_item=…&timestamp=…&transaction_id=…&user_id=…
 *     &signature=<web-safe base64 DER ECDSA>&key_id=<id>
 *
 * - `signature` and `key_id` are ALWAYS the last two parameters, in that
 *   order; the signed content is everything before `&signature=`, unmodified
 *   (parameter order kept).
 * - The signature is ECDSA with SHA-256, DER-encoded, web-safe base64; the
 *   public keys come from Google's key server (admob-ssv-keys.ts).
 * - Google's reference verifier (Tink RewardedAdsVerifier) reads the content
 *   with java.net.URI#getQuery(), i.e. percent-DECODED. The docs never say
 *   raw or decoded, so both readings of the same received bytes are tried,
 *   decoded first.
 * - The decoded reading loses the difference between a separator and an
 *   escaped `&`/`=`: a signature Google made for one split (e.g. a foreign
 *   ad unit whose custom data carries `&ad_unit=<ours>`) could otherwise be
 *   re-encoded so the raw query splits into OTHER parameters. So every
 *   parameter name must be plain (`[a-z_]`, never escaped) and no decoded
 *   value may contain `&` or `=` (our own values never do): then the raw and
 *   the decoded reading split into exactly the same parameters, and what was
 *   verified is what is applied.
 *
 * Pure (no I/O): parsing and the signature check only.
 */

export type AdMobSsvParams = {
  adNetwork: string | null;
  adUnit: string;
  customData: string | null;
  rewardAmount: string | null;
  rewardItem: string | null;
  timestamp: string;
  transactionId: string;
  userId: string | null;
};

export type AdMobSsvCallback = {
  /** Every reading of the signed content (decoded first, then raw). */
  signedContents: string[];
  signature: Buffer;
  keyId: string;
  params: AdMobSsvParams;
};

export type AdMobSsvParseResult =
  | { ok: true; callback: AdMobSsvCallback }
  | { ok: false; reason: string };

const MAX_QUERY_LENGTH = 8192;
/** Google's parameter names, never percent-escaped. */
const PLAIN_NAME = /^[a-z_]{1,64}$/u;
const FORMATS: Record<string, { pattern: RegExp; required: boolean }> = {
  ad_network: { pattern: /^[0-9A-Za-z._-]{1,64}$/u, required: false },
  ad_unit: { pattern: /^(?:ca-app-pub-\d{1,20}\/)?\d{1,20}$/u, required: true },
  custom_data: { pattern: /^[\s\S]{0,512}$/u, required: false },
  reward_amount: { pattern: /^[\s\S]{0,32}$/u, required: false },
  reward_item: { pattern: /^[\s\S]{0,128}$/u, required: false },
  timestamp: { pattern: /^\d{1,20}$/u, required: true },
  transaction_id: { pattern: /^[0-9A-Za-z_-]{1,128}$/u, required: true },
  user_id: { pattern: /^[\s\S]{0,256}$/u, required: false },
};

export function parseAdMobSsvQuery(rawQuery: string): AdMobSsvParseResult {
  if (!rawQuery || rawQuery.length > MAX_QUERY_LENGTH)
    return { ok: false, reason: 'QUERY_SIZE' };
  const at = rawQuery.lastIndexOf('&signature=');
  if (at <= 0) return { ok: false, reason: 'SIGNATURE_NOT_LAST' };
  const tail = /^signature=([^&]+)&key_id=(\d{1,20})$/u.exec(
    rawQuery.slice(at + 1),
  );
  if (!tail) return { ok: false, reason: 'SIGNATURE_KEY_ID_NOT_LAST' };
  const signatureText = decode(tail[1]);
  const signature =
    signatureText && /^[A-Za-z0-9_+/-]+={0,2}$/u.test(signatureText)
      ? Buffer.from(
          signatureText.replace(/-/gu, '+').replace(/_/gu, '/'),
          'base64',
        )
      : null;
  if (!signature || signature.length < 8)
    return { ok: false, reason: 'SIGNATURE_FORMAT' };

  const content = rawQuery.slice(0, at);
  const values = new Map<string, string>();
  for (const pair of content.split('&')) {
    const eq = pair.indexOf('=');
    const name = eq > 0 ? pair.slice(0, eq) : null;
    const value = eq > 0 ? decode(pair.slice(eq + 1)) : null;
    if (name === null || value === null)
      return { ok: false, reason: 'MALFORMED_PARAMETER' };
    // One split for both readings (see above): plain names, and no value
    // that decodes into a separator.
    if (!PLAIN_NAME.test(name)) return { ok: false, reason: 'PARAMETER_NAME' };
    if (/[&=]/u.test(value)) return { ok: false, reason: 'AMBIGUOUS_VALUE' };
    if (name === 'signature' || name === 'key_id' || values.has(name))
      return { ok: false, reason: 'DUPLICATE_PARAMETER' };
    values.set(name, value);
  }
  for (const [name, format] of Object.entries(FORMATS)) {
    const value = values.get(name);
    if (value === undefined) {
      if (format.required) return { ok: false, reason: `MISSING_${name}` };
      continue;
    }
    if (!format.pattern.test(value))
      return { ok: false, reason: `FORMAT_${name}` };
  }
  const decoded = decode(content);
  return {
    ok: true,
    callback: {
      signedContents:
        decoded !== null && decoded !== content
          ? [decoded, content]
          : [content],
      signature,
      keyId: tail[2],
      params: {
        adNetwork: values.get('ad_network') ?? null,
        adUnit: values.get('ad_unit')!,
        customData: values.get('custom_data') ?? null,
        rewardAmount: values.get('reward_amount') ?? null,
        rewardItem: values.get('reward_item') ?? null,
        timestamp: values.get('timestamp')!,
        transactionId: values.get('transaction_id')!,
        userId: values.get('user_id') ?? null,
      },
    },
  };
}

/** True when Google's key signed one reading of the content. */
export function verifyAdMobSsvSignature(
  callback: AdMobSsvCallback,
  key: KeyObject,
): boolean {
  return callback.signedContents.some((content) => {
    try {
      return verify(
        'sha256',
        Buffer.from(content, 'utf8'),
        { key, dsaEncoding: 'der' },
        callback.signature,
      );
    } catch {
      return false;
    }
  });
}

/**
 * The reward time Google reports: "Epoch time in ms" (one documented example
 * has 16 digits, i.e. µs — read as such). Null when it is not a plausible
 * instant; the verification time then stands in.
 */
export function adMobRewardTime(timestamp: string): Date | null {
  const value = Number(timestamp);
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  const ms = timestamp.length >= 16 ? Math.floor(value / 1000) : value;
  const at = new Date(ms);
  const year = at.getUTCFullYear();
  return year >= 2020 && year <= 2100 ? at : null;
}

/**
 * The SSV `user_id` an ad session asks the app to set: derived from the
 * member and the session, so Google never receives a stable member id, and
 * a callback for the session must carry exactly it.
 */
export function adMobSsvUserId(session: { id: string; userId: string }) {
  return createHash('sha256')
    .update(`admob-ssv-user:v1:${session.userId}:${session.id}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
