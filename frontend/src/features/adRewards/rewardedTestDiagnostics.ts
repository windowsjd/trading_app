export const REWARDED_TEST_STAGES = {
  'native-module': '네이티브 모듈 로딩',
  'sdk-preparation': '광고 SDK 준비',
  'ump-consent': '개인정보 동의(UMP)',
  'ump-eligibility': '동의 상태에 따른 광고 요청 가능 여부',
  'request-configuration': '광고 요청 설정',
  'mobile-ads-initialization': 'Mobile Ads 초기화',
  'ad-creation': '보상형 광고 인스턴스 생성',
  'sdk-timeout': '광고 SDK 준비 제한시간 초과',
  'ad-load': '광고 불러오기',
  'ad-show': '광고 표시',
  'privacy-options': '광고 개인정보 선택',
} as const;
export type RewardedTestStage = keyof typeof REWARDED_TEST_STAGES;
export type RewardedTestDiagnostic = {
  stage: RewardedTestStage;
  code: string;
  codeSource: 'sdk' | 'internal' | 'unavailable';
  detail: string;
};

// Codes emitted by the pinned 16.3.4 native adapters. Never accept arbitrary
// strings as codes (even short strings can contain credentials or account IDs).
const SDK_CODES = new Set([
  'null-activity', 'consent-update-failed', 'consent-form-error', 'privacy-options-form-error',
  'app-id-missing', 'internal-error', 'invalid-ad-string', 'invalid-request',
  'mediation-no-fill', 'network-error', 'no-fill', 'request-id-mismatch', 'unknown',
]);
// Only literal fragments actually present in a received message are retained.
// Dynamic suffixes, URLs, IDs, tokens, stacks and unrecognized prose are omitted.
// A code alone must never manufacture an SDK explanation.
const SAFE_MESSAGE_FRAGMENTS = [
  'Publisher misconfiguration',
  "Failed to read publisher's account configuration",
  'No consent messages are configured',
  'The current Activity was null',
  'the current Activity was null',
  'Network error', 'Network Error', 'Unable to resolve host',
  'The Internet connection appears to be offline',
  'No fill', 'No ad config',
  "'RNGoogleMobileAdsModule' could not be found",
  "'RNGoogleMobileAdsConsentModule' could not be found",
  "'RNGoogleMobileAdsRewardedModule' could not be found",
  'Native module cannot be null',
];

function field(error: unknown, key: string): unknown {
  // Do not stringify objects, traverse causes/userInfo, or invoke getters.
  try {
    if (!error || typeof error !== 'object') return undefined;
    return Object.getOwnPropertyDescriptor(error, key)?.value;
  } catch { return undefined; }
}

export function rewardedTestDiagnostic(stage: RewardedTestStage, error?: unknown): RewardedTestDiagnostic {
  if (error instanceof RewardedTestFailure) return error.diagnostic;
  const rawCode = field(error, 'code');
  const code = typeof rawCode === 'string' && rawCode.length <= 80
    ? rawCode.replace(/^googleMobileAds\//, '') : undefined;
  const message = typeof error === 'string' ? error : field(error, 'message');
  const fragments = typeof message === 'string' && message.length <= 8192
    ? SAFE_MESSAGE_FRAGMENTS.filter((fragment) => message.includes(fragment)) : [];
  return {
    stage,
    code: code && SDK_CODES.has(code) ? rawCode as string : 'SDK 코드 없음 또는 안전하게 표시할 수 없음',
    codeSource: code && SDK_CODES.has(code) ? 'sdk' : 'unavailable',
    detail: fragments.length ? `${fragments.join('; ').slice(0, 300)} (수신 설명의 허용된 부분만 표시)`
      : '안전하게 표시할 수 있는 SDK 설명이 없습니다. 원문은 저장·출력하지 않습니다.',
  };
}

/** Contains sanitized primitives only; never retain the original exception. */
export class RewardedTestFailure extends Error {
  diagnostic: RewardedTestDiagnostic;
  constructor(stage: RewardedTestStage, error?: unknown) {
    const diagnostic = rewardedTestDiagnostic(stage, error);
    super(diagnostic.detail);
    this.diagnostic = diagnostic;
  }
}

export function internalTestFailure(stage: RewardedTestStage, code: string, detail: string) {
  const failure = new RewardedTestFailure(stage);
  // Callers supply only fixed application diagnostics, explicitly labeled in UI.
  failure.diagnostic = { stage, code, codeSource: 'internal', detail };
  return failure;
}

export async function testSdkStep<T>(stage: RewardedTestStage, action: () => T | Promise<T>): Promise<T> {
  try { return await action(); }
  catch (error) { throw new RewardedTestFailure(stage, error); }
}
