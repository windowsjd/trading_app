/**
 * Android Back that would leave the app (2026-11-06): nothing left to close or
 * go back to (Home with no earlier tab, or a first screen such as login) asks
 * first with a short notice. A second Back within the window leaves through the
 * system's own default, so the task moves to the background as usual. Every
 * other Back stays with the navigators, sheets and dialogs. iOS has no Back
 * to confirm.
 */
export const EXIT_CONFIRM_WINDOW_MS = 2000;
export const EXIT_CONFIRM_MESSAGE = '뒤로 가기를 한 번 더 하면 앱이 종료됩니다.';

/** A hardwareBackPress listener: true keeps the app (asked), false lets Back through. */
export function createExitConfirm({ canGoBack, notify, now = () => performance.now() }: {
  /** The navigators would handle this Back themselves. */
  canGoBack: () => boolean;
  notify: (message: string) => void;
  /** Monotonic milliseconds. */
  now?: () => number;
}): () => boolean {
  let askedAt: number | null = null;
  return () => {
    if (canGoBack()) return false;
    const at = now();
    if (askedAt !== null && at - askedAt < EXIT_CONFIRM_WINDOW_MS) {
      askedAt = null;
      return false;
    }
    askedAt = at;
    notify(EXIT_CONFIRM_MESSAGE);
    return true;
  };
}
