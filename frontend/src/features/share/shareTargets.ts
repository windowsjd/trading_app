/**
 * Where a 수익 공유 icon actually sends the card, decided per platform from
 * what each app officially supports — never a button that looks direct but is
 * not:
 *
 * - 인스타그램 스토리: Meta's Sharing to Stories (Android intent
 *   `com.instagram.share.ADD_TO_STORY`, iOS `instagram-stories://` + the
 *   pasteboard), which requires the app's Meta (Facebook) App ID since 2023.
 *   Without a configured App ID the button explains that instead of opening
 *   Instagram to an error.
 * - 텔레그램: Android hands the image to the installed Telegram app directly;
 *   iOS has no public way to target one app with an image, so the system
 *   share sheet opens with a hint to pick Telegram.
 * - 카카오톡: direct image sharing needs Kakao's SDK and a registered Kakao app
 *   key, which this app does not have; both platforms open the system share
 *   sheet with a hint to pick KakaoTalk (only when KakaoTalk is installed).
 * - 더보기: the system share sheet.
 *
 * Posting is always the user's own action in the target app.
 */
export type ShareTarget = 'instagram_story' | 'kakaotalk' | 'telegram' | 'more';
export type SharePlatform = 'ios' | 'android' | 'web' | (string & {});

/** How to tell an app is installed: an Android package or an iOS URL scheme (Info.plist LSApplicationQueriesSchemes). */
export type InstalledAppCheck = { packageName: string } | { scheme: string };

export type SharePlan =
  | { kind: 'unsupported' }
  | { kind: 'unconfigured' }
  | { kind: 'instagram_story'; appId: string; app: InstalledAppCheck }
  | { kind: 'direct'; app: InstalledAppCheck }
  | { kind: 'sheet'; app: InstalledAppCheck | null; hint: string | null };

export const SHARE_TARGETS: ReadonlyArray<{ target: ShareTarget; label: string; accessibilityLabel: string }> = [
  { target: 'instagram_story', label: '인스타그램 스토리', accessibilityLabel: '인스타그램 스토리로 공유' },
  { target: 'kakaotalk', label: '카카오톡', accessibilityLabel: '카카오톡으로 공유' },
  { target: 'telegram', label: '텔레그램', accessibilityLabel: '텔레그램으로 공유' },
  { target: 'more', label: '더보기', accessibilityLabel: '다른 앱으로 공유 (더보기)' },
];

const APPS = {
  instagram_story: { name: '인스타그램', packageName: 'com.instagram.android', scheme: 'instagram-stories://share' },
  kakaotalk: { name: '카카오톡', packageName: 'com.kakao.talk', scheme: 'kakaotalk://' },
  telegram: { name: '텔레그램', packageName: 'org.telegram.messenger', scheme: 'tg://' },
} as const;

function appCheck(target: Exclude<ShareTarget, 'more'>, platform: SharePlatform): InstalledAppCheck {
  return platform === 'android' ? { packageName: APPS[target].packageName } : { scheme: APPS[target].scheme };
}

/** A Meta App ID is a decimal number; anything else counts as not configured. */
export function normalizeMetaAppId(value: string | null | undefined) {
  const text = value?.trim() ?? '';
  return /^\d{5,20}$/u.test(text) ? text : null;
}

export function planShareTarget(target: ShareTarget, platform: SharePlatform, metaAppId: string | null): SharePlan {
  if (platform !== 'ios' && platform !== 'android') return { kind: 'unsupported' };
  if (target === 'more') return { kind: 'sheet', app: null, hint: null };
  if (target === 'instagram_story') {
    const appId = normalizeMetaAppId(metaAppId);
    return appId ? { kind: 'instagram_story', appId, app: appCheck(target, platform) } : { kind: 'unconfigured' };
  }
  if (target === 'telegram' && platform === 'android') return { kind: 'direct', app: appCheck(target, platform) };
  return { kind: 'sheet', app: appCheck(target, platform), hint: `공유 목록에서 ${APPS[target].name}을 선택해 주세요.` };
}

/** Results of one share or save action. A dismissed sheet is `cancelled`, not a failure. */
export type ShareOutcome =
  | 'opened'
  | 'shared'
  | 'cancelled'
  | 'saved'
  | 'not_installed'
  | 'permission_denied'
  | 'unconfigured'
  | 'unsupported'
  | 'capture_failed'
  | 'failed';

/** The sheet's status line for an outcome; null when nothing needs saying. */
export function shareOutcomeMessage(outcome: ShareOutcome, target: ShareTarget | 'save'): string | null {
  const name = target === 'save' || target === 'more' ? null : APPS[target].name;
  switch (outcome) {
    case 'opened':
      return target === 'instagram_story'
        ? '인스타그램 스토리 편집 화면으로 보냈어요. 게시는 인스타그램에서 직접 완료해 주세요.'
        : `${name ?? '선택한 앱'}으로 보냈어요. 전송은 그 앱에서 직접 완료해 주세요.`;
    case 'shared':
    case 'cancelled':
      return null;
    case 'saved':
      return '사진 앱에 저장했어요.';
    case 'not_installed':
      return `${name ?? '앱'}이 설치되어 있지 않아요. 더보기로 다른 앱에 공유할 수 있어요.`;
    case 'permission_denied':
      return '사진 저장 권한이 없어 저장하지 못했어요. 설정에서 사진 추가 권한을 허용해 주세요.';
    case 'unconfigured':
      return '인스타그램 스토리 바로 공유는 아직 준비 중이에요. 더보기에서 인스타그램을 선택해 공유할 수 있어요.';
    case 'unsupported':
      return '공유와 저장은 앱에서 이용할 수 있어요.';
    case 'capture_failed':
      return '공유 이미지를 만들지 못했어요. 잠시 후 다시 시도해 주세요.';
    case 'failed':
      return target === 'save'
        ? '이미지를 저장하지 못했어요. 잠시 후 다시 시도해 주세요.'
        : target === 'instagram_story'
          ? '인스타그램을 열지 못했어요. 앱을 업데이트했는지 확인하거나 더보기로 공유해 주세요.'
          : '공유를 열지 못했어요. 잠시 후 다시 시도해 주세요.';
  }
}
