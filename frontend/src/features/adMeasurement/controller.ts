import {
  AD_MEASUREMENT_CONSENT_VERSION,
  currentChoice,
  measurementAllowed,
  parseConsentRecord,
  serializeConsentRecord,
  shouldRequestTracking,
  type ConsentChoice,
  type ConsentRecord,
  type MeasurementPlatform,
  type Tracking,
} from './consent.ts';

/**
 * The 광고 성과 측정 state for this app session (2026-11-21): reads the stored
 * choice once at start, starts the Meta SDK only when the choice (and on iOS
 * the system's 앱 추적 허용) allows it, and stops it as soon as either is
 * withdrawn. Pure: the SDK, the storage and the clock are passed in, so
 * node --test drives every path (controller.test.ts).
 *
 * Fails closed: a choice that cannot be read starts nothing (and stops a
 * measurement left on), a choice that cannot be saved is not acted on (a
 * withdrawal still stops the SDK for this session), and an SDK that throws is
 * treated as off. None of it ever blocks the rest of the app.
 */
export type MetaMeasurementSdk = {
  /** False when this build has no Meta SDK (web, Expo Go, an older binary). */
  available: () => boolean;
  /** iOS: the current 앱 추적 허용 state; null elsewhere. */
  getTracking: () => Promise<Tracking>;
  /** iOS: shows the system prompt (only while undecided). */
  requestTracking: () => Promise<Tracking>;
  /** Turns the measurement on. Idempotent. */
  start: () => Promise<void>;
  /** Turns it off, here and for the next launches. Idempotent. */
  stop: () => Promise<void>;
};

export type AdMeasurementDeps = {
  platform: MeasurementPlatform;
  sdk: MetaMeasurementSdk;
  readRecord: () => Promise<string | null>;
  writeRecord: (raw: string) => Promise<void>;
  now: () => Date;
};

/** `launch`: the one-time question after install; `settings`: opened from 설정 to agree. */
export type ConsentPrompt = 'none' | 'launch' | 'settings';

export type AdMeasurementState = {
  /** The stored choice has been read (or could not be). */
  ready: boolean;
  /** This build and platform can measure at all. */
  supported: boolean;
  choice: ConsentChoice | null;
  tracking: Tracking;
  /** The Meta SDK runs in this app session. */
  active: boolean;
  prompt: ConsentPrompt;
  /** A decision is being applied (the iOS system prompt may be up). */
  busy: boolean;
};

export type DecisionResult = 'saved' | 'failed';

export function createAdMeasurement(deps: AdMeasurementDeps) {
  const supported = deps.platform !== 'unsupported' && isAvailable(deps.sdk);
  let state: AdMeasurementState = {
    ready: !supported, supported, choice: null, tracking: null, active: false, prompt: 'none', busy: false,
  };
  let record: ConsentRecord | null = null;
  let initialized = false;
  const listeners = new Set<() => void>();
  // One step at a time: a decision never interleaves with the start-up read
  // or with a foreground re-check.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  const set = (patch: Partial<AdMeasurementState>) => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };

  async function save(next: ConsentRecord): Promise<boolean> {
    try {
      await deps.writeRecord(serializeConsentRecord(next));
      record = next;
      return true;
    } catch {
      return false;
    }
  }

  async function readTracking(): Promise<Tracking> {
    if (deps.platform !== 'ios') return null;
    try {
      return await deps.sdk.getTracking();
    } catch {
      return null;
    }
  }

  async function stop(): Promise<void> {
    try {
      await deps.sdk.stop();
    } catch {
      // Still marked as on: the next launch stops it again.
      return;
    }
    set({ active: false });
    if (record?.sdkOn) await save({ ...record, sdkOn: false });
  }

  /** Brings the SDK in line with the saved choice and the system permission. */
  async function apply(): Promise<void> {
    if (!measurementAllowed(deps.platform, currentChoice(record), state.tracking) || !record) {
      // A device that never started the SDK never touches it.
      if (state.active || record?.sdkOn) await stop();
      return;
    }
    if (state.active) return;
    // Marked before the start: one cut short is redone or undone next launch.
    if (!record.sdkOn && !(await save({ ...record, sdkOn: true }))) return;
    try {
      await deps.sdk.start();
      set({ active: true });
    } catch {
      set({ active: false });
    }
  }

  /** Once per app session. */
  function init(): Promise<void> {
    if (!supported || initialized) return serial(() => Promise.resolve());
    initialized = true;
    return serial(async () => {
      let raw: string | null;
      try {
        raw = await deps.readRecord();
      } catch {
        // Unknown choice: no measurement and no question this session.
        try { await deps.sdk.stop(); } catch { /* nothing more to do */ }
        set({ ready: true });
        return;
      }
      record = parseConsentRecord(raw);
      set({ choice: currentChoice(record), tracking: await readTracking() });
      await apply();
      set({ ready: true, prompt: currentChoice(record) === null ? 'launch' : 'none' });
    });
  }

  /**
   * The person's answer from the consent sheet (or the 설정 switch turned off).
   * Agreeing on iOS asks the system once, while it has not decided yet.
   */
  function answer(choice: ConsentChoice): Promise<DecisionResult> {
    return serial(async () => {
      if (!supported || !state.ready) return 'failed' as const;
      set({ busy: true });
      try {
        if (choice === 'granted' && shouldRequestTracking(deps.platform, state.tracking)) {
          let tracking: Tracking;
          try {
            tracking = await deps.sdk.requestTracking();
          } catch {
            tracking = await readTracking();
          }
          set({ tracking });
        }
        const saved = await save({
          choice,
          version: AD_MEASUREMENT_CONSENT_VERSION,
          decidedAt: deps.now().toISOString(),
          sdkOn: record?.sdkOn ?? false,
        });
        set({ prompt: 'none', ...(saved ? { choice } : {}) });
        if (saved) await apply();
        else if (choice === 'declined' && (state.active || record?.sdkOn)) await stop();
        return saved ? ('saved' as const) : ('failed' as const);
      } finally {
        set({ busy: false });
      }
    });
  }

  /** 설정 › 광고 성과 측정 turned on: the notice comes first, then the answer. */
  function openSettingsPrompt() {
    if (state.supported && state.ready && !state.busy) set({ prompt: 'settings' });
  }

  /** Closing the sheet opened from 설정 changes nothing (the launch question has no close). */
  function closePrompt() {
    if (state.prompt === 'settings' && !state.busy) set({ prompt: 'none' });
  }

  /** iOS, back in the foreground: 앱 추적 허용 may have been changed in the system settings. */
  function refreshTracking(): Promise<void> {
    return serial(async () => {
      if (deps.platform !== 'ios' || !state.ready || !state.supported) return;
      set({ tracking: await readTracking() });
      await apply();
    });
  }

  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    init,
    answer,
    openSettingsPrompt,
    closePrompt,
    refreshTracking,
  };
}

export type AdMeasurement = ReturnType<typeof createAdMeasurement>;

function isAvailable(sdk: MetaMeasurementSdk): boolean {
  try {
    return sdk.available();
  } catch {
    return false;
  }
}
