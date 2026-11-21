/**
 * 광고 성과 측정 동의 (2026-11-21) — the pure policy; node --test loads it.
 *
 * Meta App Events measures whether people install and open the app after a
 * Meta (Facebook·Instagram) ad (frontend/docs/meta-ad-measurement.md). The
 * measurement is optional and separate from signup's documents and from
 * Google's AdMob/UMP consent: nothing reaches Meta before the person agrees
 * here, a refusal changes nothing else in the app, and the choice can be
 * withdrawn at any time.
 *
 * The choice belongs to this device, not to an account: what Meta measures is
 * the device's install, which happens before any sign-in, so logging out or
 * switching members keeps it.
 */

/** The revision of AD_MEASUREMENT_NOTICE; a stored choice for another revision counts as undecided. */
export const AD_MEASUREMENT_CONSENT_VERSION = '2026-11-21';

export type ConsentChoice = 'granted' | 'declined';

export type ConsentRecord = {
  choice: ConsentChoice;
  version: string;
  decidedAt: string;
  /**
   * Whether the Meta SDK may have run since its last confirmed stop. Set before
   * the SDK is started and cleared only once the SDK confirms a stop that holds
   * for the next launches, so a stop that never completed (the app closed in
   * between, or the SDK failed) is repeated on the next launch. It never lets
   * the SDK run: only the choice does.
   */
  sdkOn: boolean;
};

export function parseConsentRecord(raw: string | null | undefined): ConsentRecord | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.choice !== 'granted' && record.choice !== 'declined') return null;
  if (typeof record.version !== 'string' || typeof record.decidedAt !== 'string') return null;
  return { choice: record.choice, version: record.version, decidedAt: record.decidedAt, sdkOn: record.sdkOn === true };
}

export function serializeConsentRecord(record: ConsentRecord): string {
  return JSON.stringify(record);
}

/** The choice that applies now: only one made for the current notice revision. */
export function currentChoice(record: ConsentRecord | null): ConsentChoice | null {
  return record && record.version === AD_MEASUREMENT_CONSENT_VERSION ? record.choice : null;
}

export type MeasurementPlatform = 'android' | 'ios' | 'unsupported';

export function measurementPlatform(os: string): MeasurementPlatform {
  return os === 'android' || os === 'ios' ? os : 'unsupported';
}

/**
 * iOS App Tracking Transparency, as expo-tracking-transparency reports it
 * (`restricted` arrives as `denied`, with `canAskAgain` false). Null where
 * there is no such permission (Android, web) or it could not be read.
 */
export type TrackingStatus = 'granted' | 'denied' | 'undetermined';
export type Tracking = { status: TrackingStatus; canAskAgain: boolean } | null;

/**
 * Whether the Meta SDK may run. Android: the in-app consent. iOS: the in-app
 * consent and the system's "앱 추적 허용" both; without the latter nothing is
 * sent (Meta's limited, identifier-less measurement is not enabled — see the
 * docs). Any unknown state counts as no.
 */
export function measurementAllowed(platform: MeasurementPlatform, choice: ConsentChoice | null, tracking: Tracking): boolean {
  if (choice !== 'granted') return false;
  if (platform === 'android') return true;
  return platform === 'ios' && tracking?.status === 'granted';
}

/**
 * The system prompt is asked for only after the in-app consent, only while iOS
 * has not decided yet: never on launch, never after a refusal (iOS would not
 * show it again either).
 */
export function shouldRequestTracking(platform: MeasurementPlatform, tracking: Tracking): boolean {
  return platform === 'ios' && tracking?.status === 'undetermined' && tracking.canAskAgain !== false;
}

/**
 * What the consent sheet says before anyone agrees: who receives what, why,
 * where and for how long, what is never sent, and that a refusal costs
 * nothing. Changing any of it means raising AD_MEASUREMENT_CONSENT_VERSION
 * (consent.test.ts pins the text) — every device is then asked again.
 */
export const AD_MEASUREMENT_NOTICE = {
  title: '광고 성과 측정 동의 (선택)',
  lead: '트레이딩 클래스는 Meta(Facebook·Instagram) 광고를 보고 앱을 설치했는지 알아보기 위해, 동의한 경우에만 아래 정보를 Meta에 제공합니다.',
  rows: [
    { label: '받는 자', value: 'Meta Platforms, Inc.' },
    { label: '목적', value: 'Meta 광고를 통한 앱 설치·실행 성과 측정' },
    {
      label: '항목',
      value: '앱 설치·실행·종료 기록과 사용 시간, 광고 식별자(Android 광고 ID, iOS는 앱 추적을 허용한 경우의 IDFA), '
        + 'Meta SDK가 이 기기에 만드는 임의 식별자(Android에서 Facebook 앱이 설치된 경우 그 앱의 광고 기여도 식별자 포함), '
        + '기기 모델·OS 버전·언어·시간대·통신사·화면 크기, 앱 버전, 설치 경로(Google Play 설치 리퍼러), IP 주소, Meta SDK 오류 기록',
    },
    { label: '이전 국가', value: '미국 등 Meta가 정보를 처리하는 국가로, 앱을 사용하는 동안 인터넷으로 전송' },
    { label: '보유 기간', value: 'Meta의 데이터 정책에서 정한 기간' },
  ],
  excluded: '이메일, 닉네임, 회원 ID, 가상자금 잔액·수익률·포트폴리오, 주문·체결·거래 기록, 지갑·원장·시즌 정보는 Meta에 보내지 않습니다.',
  refusal: '동의하지 않을 수 있으며, 동의하지 않아도 모든 기능을 그대로 이용할 수 있습니다. 동의는 MY › 설정(둘러보기 중에는 투자모드 탭)에서 언제든 철회할 수 있습니다.',
  ios: '동의하면 이어서 iOS의 앱 추적 허용 요청이 표시되며, 두 가지를 모두 허용한 경우에만 측정합니다. 앱 추적을 허용하면 앱 안 광고(Google AdMob)도 이 기기의 광고 식별자를 사용할 수 있습니다.',
  android: 'Android 설정에서 광고 ID를 삭제했거나 맞춤 광고를 제한했다면 그 설정이 그대로 적용됩니다.',
} as const;

/** Every word of the notice in reading order (consent.test.ts fingerprints it). */
export function adMeasurementNoticeText(): string[] {
  const notice = AD_MEASUREMENT_NOTICE;
  return [notice.title, notice.lead, ...notice.rows.flatMap((row) => [row.label, row.value]), notice.excluded, notice.refusal, notice.ios, notice.android];
}
