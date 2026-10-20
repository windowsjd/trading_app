/**
 * Terms version of the current signup screen (docs/auth-api-contract.md).
 * Signup must send exactly this value with `ageConfirmed: true`. When the
 * terms change, raise it together with the app's `TERMS_VERSION`
 * (frontend/src/constants/legal.ts): until both ship, the other side refuses.
 */
export const CURRENT_TERMS_VERSION = '2026-10-20';
