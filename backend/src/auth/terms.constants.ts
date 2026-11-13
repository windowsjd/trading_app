/**
 * Document versions of the current signup screen (docs/auth-api-contract.md).
 * Signup must send `ageConfirmed: true`, `termsAgreed: true` with exactly
 * CURRENT_TERMS_VERSION and `privacyAgreed: true` with exactly
 * CURRENT_PRIVACY_VERSION. The two documents are versioned independently:
 * when one changes, raise its constant together with the app's matching value
 * (frontend/src/constants/legal.ts); until both ship, the other side refuses.
 *
 * A version names a document text (the revision label of the published page);
 * it is not shown in the app as an effective date.
 */
export const CURRENT_TERMS_VERSION = '2026-10-20';
export const CURRENT_PRIVACY_VERSION = '2026-10-20';
