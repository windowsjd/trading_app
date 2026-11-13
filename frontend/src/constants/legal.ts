/**
 * Document versions of the signup screen (2026-11-13: three separate required
 * boxes). Signup sends each document's version with its box; the server
 * accepts only its own CURRENT_TERMS_VERSION / CURRENT_PRIVACY_VERSION
 * (backend/src/auth/terms.constants.ts). The two documents are versioned
 * independently: when one's text changes (constants/legalDocuments.ts), raise
 * its version here and on the server together. A version is the revision
 * label of the published page, never shown as an effective date.
 */
export const TERMS_VERSION = '2026-10-20';
export const PRIVACY_VERSION = '2026-10-20';

/** The three required signup boxes, each separate and never pre-checked. */
export const AGE_CONFIRMATION_LABEL = '[필수] 만 16세 이상입니다';
export const TERMS_AGREEMENT_LABEL = '[필수] 이용약관에 동의합니다';
export const PRIVACY_AGREEMENT_LABEL = '[필수] 개인정보처리방침에 동의합니다';

/**
 * Support contact and account notices. A suspended or deleted member cannot
 * use the in-app inquiry, so appeals and questions go to this address.
 */
export const SUPPORT_EMAIL = 'admin@nanghwa.com';

/**
 * Login/sign-up copy for an account that cannot sign in. `unknown` is the
 * USER_NOT_ACTIVE answer, which does not say which of the two states it is.
 */
export const BLOCKED_ACCOUNT_MESSAGES = {
  suspended: `회원님의 계정이 정지됐습니다. ${SUPPORT_EMAIL}으로 문의하세요.`,
  deleted: `회원님의 계정이 삭제 처리됐습니다. ${SUPPORT_EMAIL}으로 문의하세요.`,
  unknown: `회원님의 계정이 정지되었거나 삭제 처리됐습니다. ${SUPPORT_EMAIL}으로 문의하세요.`,
} as const;
