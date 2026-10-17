/**
 * Device token ownership on the server (pure; node --test loads it).
 *
 * The permission prompt happens before sign-in; the token is tied to a user
 * only after sign-in or session restore. Every change of session, OS
 * permission or token runs `reconcile`, serialized, so the server always ends
 * up matching this device:
 *   - signed in + permission granted → register the token for that user
 *     (a token used by someone else on this device moves to this user);
 *   - signed out, or permission not granted → release every token this install
 *     registered (and, once per launch, the current one: a reinstall may reuse
 *     a token the server still maps to a previous user).
 * Failures never reach the UI; the next trigger retries. A token that could
 * not be released stays stored and is released on the next run.
 */

export type RegistrationSession = { userId: string } | null;

export type PushRegistrationDeps = {
  supported: boolean;
  platform: 'ios' | 'android';
  isPermissionGranted: () => Promise<boolean>;
  /** Throws when no token can be obtained (simulator, no FCM, offline). */
  getToken: () => Promise<string>;
  register: (token: string, platform: 'ios' | 'android') => Promise<void>;
  release: (token: string) => Promise<void>;
  readStoredToken: () => Promise<string | null>;
  writeStoredToken: (token: string | null) => Promise<void>;
  now: () => number;
};

export type ReconcileOutcome =
  | 'unsupported'
  | 'registered'
  | 'unchanged'
  | 'released'
  | 'token_unavailable'
  | 'register_failed'
  | 'release_failed';

/** A registration for the same user and token is refreshed after this. */
export const REGISTRATION_REFRESH_MS = 6 * 60 * 60 * 1000;

export function createPushRegistrar(deps: PushRegistrationDeps) {
  let tail: Promise<unknown> = Promise.resolve();
  let registered: { userId: string; token: string; at: number } | null = null;
  let releasedLaunchToken = false;

  /** Releases the stored token; answers whether nothing is left pending and
   * which token (if any) was released. */
  async function releaseStored(): Promise<{ ok: boolean; token: string | null }> {
    const stored = await deps.readStoredToken().catch(() => null);
    if (!stored) return { ok: true, token: null };
    try {
      await deps.release(stored);
    } catch {
      return { ok: false, token: null };
    }
    await deps.writeStoredToken(null).catch(() => undefined);
    return { ok: true, token: stored };
  }

  async function run(session: RegistrationSession, force: boolean): Promise<ReconcileOutcome> {
    if (!deps.supported) return 'unsupported';
    const granted = await deps.isPermissionGranted().catch(() => false);
    if (session && granted) {
      let token: string;
      try {
        token = await deps.getToken();
      } catch {
        return 'token_unavailable';
      }
      const stored = await deps.readStoredToken().catch(() => null);
      // A rotated token: the old one must not keep a registration.
      if (stored && stored !== token) await deps.release(stored).catch(() => undefined);
      if (
        !force &&
        registered &&
        registered.userId === session.userId &&
        registered.token === token &&
        deps.now() - registered.at < REGISTRATION_REFRESH_MS
      )
        return 'unchanged';
      try {
        await deps.register(token, deps.platform);
      } catch {
        registered = null;
        return 'register_failed';
      }
      registered = { userId: session.userId, token, at: deps.now() };
      await deps.writeStoredToken(token).catch(() => undefined);
      return 'registered';
    }
    registered = null;
    const released = await releaseStored();
    if (!session && granted && !releasedLaunchToken) {
      try {
        const token = await deps.getToken();
        if (token !== released.token) await deps.release(token);
        releasedLaunchToken = true;
      } catch {
        // No token on this device yet, or offline: nothing to release now.
      }
    }
    return released.ok ? 'released' : 'release_failed';
  }

  return {
    /** Serialized: a logout's release always reaches the server before the
     * next user's register. */
    reconcile(session: RegistrationSession, options: { force?: boolean } = {}) {
      const next = tail.then(() => run(session, options.force === true));
      tail = next.catch(() => undefined);
      return next;
    },
  };
}
