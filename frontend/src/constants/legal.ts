/**
 * Terms of service and privacy policy live on the website; the app only links
 * to them (opened in the external browser).
 */
export const TERMS_URL = 'https://nanghwa.com';
export const PRIVACY_URL = 'https://nanghwa.com';

/**
 * Terms version shown on the signup screen and sent with signup. The server
 * accepts only its own CURRENT_TERMS_VERSION (backend/src/auth/terms.constants.ts):
 * raise both together when the terms change.
 */
export const TERMS_VERSION = '2026-10-20';

/** The only signup checkbox: required, never pre-checked. */
export const AGE_CONFIRMATION_LABEL = '[필수] 만 16세 이상입니다';

/**
 * Notice under the checkbox (there is no terms checkbox). Joined, it reads
 * "가입하면 이용약관과 개인정보처리방침에 동의한 것으로 봅니다."; the `link`
 * parts open LEGAL_LINKS.
 */
export const SIGNUP_LEGAL_NOTICE = [
  '가입하면 ',
  { link: 'terms', label: '이용약관' },
  '과 ',
  { link: 'privacy', label: '개인정보처리방침' },
  '에 동의한 것으로 봅니다.',
] as const;

export const LEGAL_LINKS = { terms: TERMS_URL, privacy: PRIVACY_URL } as const;

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
