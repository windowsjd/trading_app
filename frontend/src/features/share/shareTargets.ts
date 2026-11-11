/**
 * 수익 공유 has two actions (2026-11-10): 공유하기 opens the system share sheet
 * with the card image — the user picks KakaoTalk, Instagram, Telegram or any
 * other app there — and 이미지 저장 adds it to the photo library. Per-app
 * buttons were removed: Instagram Stories needs a Meta App ID the app does not
 * have, and KakaoTalk could only ever open the same system sheet, so the
 * buttons promised direct shares they could not make.
 *
 * Posting is always the user's own action in the app they pick.
 */
export type ShareAction = 'share' | 'save';

/** Results of one share or save action. A dismissed sheet is `cancelled`, not a failure. */
export type ShareOutcome =
  | 'shared'
  | 'cancelled'
  | 'saved'
  | 'permission_denied'
  | 'unsupported'
  | 'capture_failed'
  | 'failed';

/** The sheet's status line for an outcome; null when nothing needs saying. */
export function shareOutcomeMessage(outcome: ShareOutcome, action: ShareAction): string | null {
  switch (outcome) {
    case 'shared':
    case 'cancelled':
      return null;
    case 'saved':
      return '사진 앱에 저장했어요.';
    case 'permission_denied':
      return '사진 저장 권한이 없어 저장하지 못했어요. 설정에서 사진 추가 권한을 허용해 주세요.';
    case 'unsupported':
      return '공유와 저장은 앱에서 이용할 수 있어요.';
    case 'capture_failed':
      return '공유 이미지를 만들지 못했어요. 잠시 후 다시 시도해 주세요.';
    case 'failed':
      return action === 'save'
        ? '이미지를 저장하지 못했어요. 잠시 후 다시 시도해 주세요.'
        : '공유를 열지 못했어요. 잠시 후 다시 시도해 주세요.';
  }
}
