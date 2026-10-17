/**
 * First-launch notification permission policy (pure; node --test loads it).
 *
 * The app asks once, on its first launch, before any sign-in: only while the
 * OS still reports "not decided" and this install has not asked before. An
 * allowed or denied permission is never asked again here (the OS also decides
 * whether a prompt can appear at all, e.g. after a reinstall). Android 12 and
 * below grant notifications at install, so they report `granted` and skip the
 * prompt. A denial never blocks sign-in or any screen.
 *
 * A request that ends without a decision — the native call throws, or it
 * answers "not decided" (no prompt could be shown) — does not count as asked:
 * the marker is removed, so a later launch asks again while the OS is still
 * undecided. Only a crash while the prompt is up keeps the marker.
 */

/** expo-notifications' IosAuthorizationStatus values. */
const IOS_NOT_DETERMINED = 0;
const IOS_DENIED = 1;

export type PermissionSnapshot = {
  status: 'granted' | 'denied' | 'undetermined';
  granted: boolean;
  canAskAgain: boolean;
  /** iOS authorization status; null/undefined elsewhere. */
  iosStatus?: number | null;
};

/** iOS answers through `ios.status` (provisional/ephemeral can deliver too). */
export function toDevicePermission(snapshot: PermissionSnapshot): 'granted' | 'denied' | 'undetermined' {
  if (typeof snapshot.iosStatus === 'number') {
    if (snapshot.iosStatus === IOS_NOT_DETERMINED) return 'undetermined';
    if (snapshot.iosStatus === IOS_DENIED) return 'denied';
    return 'granted';
  }
  if (snapshot.granted || snapshot.status === 'granted') return 'granted';
  return snapshot.status === 'undetermined' ? 'undetermined' : 'denied';
}

export function shouldRequestOnFirstLaunch(
  snapshot: PermissionSnapshot,
  alreadyRequested: boolean,
): boolean {
  return (
    toDevicePermission(snapshot) === 'undetermined' &&
    snapshot.canAskAgain !== false &&
    !alreadyRequested
  );
}

/** What the settings screen offers for the device permission. */
export function permissionAction(
  permission: 'granted' | 'denied' | 'undetermined' | 'unsupported',
  canAskAgain: boolean,
): 'none' | 'request' | 'open_settings' {
  if (permission === 'granted' || permission === 'unsupported') return 'none';
  return permission === 'undetermined' && canAskAgain ? 'request' : 'open_settings';
}

export type PermissionBootstrapDeps = {
  /** Android: the channel must exist before Android 13 shows the prompt. */
  ensureChannel: () => Promise<void>;
  getPermission: () => Promise<PermissionSnapshot>;
  requestPermission: () => Promise<PermissionSnapshot>;
  readRequested: () => Promise<boolean>;
  writeRequested: () => Promise<void>;
  clearRequested: () => Promise<void>;
};

/** Runs once per app start; never throws (a failure only skips the prompt). */
export async function bootstrapNotificationPermission(
  deps: PermissionBootstrapDeps,
): Promise<'granted' | 'denied' | 'undetermined' | 'unavailable'> {
  // Best effort: without the channel Android 13 may not show the prompt, but
  // the request itself must still be made.
  await deps.ensureChannel().catch(() => undefined);
  try {
    const current = await deps.getPermission();
    const requested = await deps.readRequested().catch(() => false);
    if (!shouldRequestOnFirstLaunch(current, requested)) return toDevicePermission(current);
    // Recorded before the prompt: a crash mid-prompt still counts as asked.
    await deps.writeRequested().catch(() => undefined);
    let answer: PermissionSnapshot;
    try {
      answer = await deps.requestPermission();
    } catch {
      // No decision was made; the next launch re-reads the OS first.
      await deps.clearRequested().catch(() => undefined);
      return 'unavailable';
    }
    const result = toDevicePermission(answer);
    if (result === 'undetermined') await deps.clearRequested().catch(() => undefined);
    return result;
  } catch {
    return 'unavailable';
  }
}
