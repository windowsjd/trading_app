/**
 * Document versions of the current signup screen (docs/auth-api-contract.md).
 * Signup must send `ageConfirmed: true`, `termsAgreed: true` with exactly
 * CURRENT_TERMS_VERSION and `privacyAgreed: true` with one of
 * ACCEPTED_PRIVACY_VERSIONS. The two documents are versioned independently:
 * when one changes, raise its constant together with the app's matching value
 * (frontend/src/constants/legal.ts).
 *
 * A version names a document text (the revision label of the published page);
 * it is not shown in the app as an effective date.
 */
export const CURRENT_TERMS_VERSION = '2026-10-20';

/**
 * 2026-11-21: the privacy policy gained the optional 광고 성과 측정 (Meta) and
 * 앱 안 광고 (Google AdMob). Apps installed before that still show — and send —
 * the 2026-10-20 text, which matches what those apps do (they have no Meta
 * SDK), so their signups stay accepted and record the version the member saw.
 * Drop a previous version only once no supported app shows it any more.
 */
export const CURRENT_PRIVACY_VERSION = '2026-11-21';
export const ACCEPTED_PRIVACY_VERSIONS: readonly string[] = [
  CURRENT_PRIVACY_VERSION,
  '2026-10-20',
];
