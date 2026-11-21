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
 * The stored choice is the only thing that lets the SDK run: it never starts
 * by itself (no start-up provider on Android, no launch hook on iOS —
 * docs/meta-ad-measurement.md), so every launch begins with it off until the
 * choice read here allows it. Only a start the SDK confirmed counts as
 * running, and only a confirmed stop as stopped.
 *
 * Fails closed: a choice that cannot be read starts nothing, a choice that
 * cannot be saved is not acted on (a withdrawal still stops the SDK, and
 * Android keeps it), an SDK that fails to start counts as off and one that
 * fails to stop as possibly on. None of it ever blocks the rest of the app.
 */
export type StartResult = 'started' | 'nextLaunch' | 'withdrawn';

export type MetaMeasurementSdk = {
  /** False when this build has no Meta SDK (web, Expo Go, an older binary). */
  available: () => boolean;
  /**
   * Android: a confirmed stop also keeps its consent as withdrawn on the
   * device, and start() answers 'withdrawn' for it from then on, so a
   * withdrawal holds even when the app could not save it.
   */
  keepsWithdrawals: boolean;
  /** iOS: the current 앱 추적 허용 state; null elsewhere. */
  getTracking: () => Promise<Tracking>;
  /** iOS: shows the system prompt (only while undecided). */
  requestTracking: () => Promise<Tracking>;
  /**
   * Starts measuring in this app session for the consent decided at `consent`
   * and resolves once the SDK has: 'started'; 'nextLaunch' when this session
   * stopped it earlier (Android starts it again only in a new process);
   * 'withdrawn' when that consent was withdrawn on this device. Idempotent.
   */
  start: (consent: string) => Promise<StartResult>;
  /**
   * Stops it and resolves once the SDK has: true when the stop also holds for
   * the next launches without being repeated, false when only for this
   * session. Rejects when the SDK may still run. Idempotent.
   */
  stop: (consent: string) => Promise<boolean>;
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
  /** The Meta SDK runs in this app session (as it last confirmed). */
  active: boolean;
  /** Allowed, but this session stopped the SDK earlier: it starts on the next launch (Android). */
  deferred: boolean;
  prompt: ConsentPrompt;
  /** A decision is being applied (the iOS system prompt may be up). */
  busy: boolean;
};

/** `stopFailed`: a withdrawal was saved, but the SDK did not confirm it stopped in this session. */
export type DecisionResult = 'saved' | 'failed' | 'stopFailed';

export function createAdMeasurement(deps: AdMeasurementDeps) {
  const supported = deps.platform !== 'unsupported' && isAvailable(deps.sdk);
  let state: AdMeasurementState = {
    ready: !supported, supported, choice: null, tracking: null, active: false, deferred: false, prompt: 'none', busy: false,
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

  /** The SDK's own stop: whether it holds for the next launches, or null when the SDK may still run. */
  async function stopSdk(): Promise<boolean | null> {
    try {
      const kept = await deps.sdk.stop(record?.decidedAt ?? '');
      set({ active: false, deferred: false });
      return kept;
    } catch {
      return null;
    }
  }

  async function stop(): Promise<void> {
    // Cleared only once the stop holds without being repeated; until then every launch stops it again.
    if ((await stopSdk()) && record?.sdkOn) await save({ ...record, sdkOn: false });
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
    let result: StartResult;
    try {
      result = await deps.sdk.start(record.decidedAt);
    } catch {
      set({ active: false });
      return;
    }
    if (result === 'started') set({ active: true, deferred: false });
    else if (result === 'nextLaunch') set({ active: false, deferred: true });
    else await withdrawn(record);
  }

  /** The SDK kept this consent as withdrawn (a withdrawal the app could not save): 동의하지 않음. */
  async function withdrawn(granted: ConsentRecord): Promise<void> {
    set({ choice: 'declined', active: false, deferred: false });
    await save({ choice: 'declined', version: AD_MEASUREMENT_CONSENT_VERSION, decidedAt: deps.now().toISOString(), sdkOn: granted.sdkOn });
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
        // Unknown choice: no measurement and no question this session. The
        // SDK has not started; the stop also drops what it kept from before.
        await stopSdk();
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
    return serial(async (): Promise<DecisionResult> => {
      if (!supported || !state.ready) return 'failed';
      set({ busy: true });
      try {
        if (choice === 'declined' && record && currentChoice(record) === 'granted') return await withdraw(record);
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
        return saved ? 'saved' : 'failed';
      } finally {
        set({ busy: false });
      }
    });
  }

  /**
   * Withdrawing the consent in effect. The SDK stops first, so an app closed
   * while the choice is saved does not measure again either: Android keeps the
   * withdrawal itself, and that alone holds when the save fails.
   */
  async function withdraw(granted: ConsentRecord): Promise<DecisionResult> {
    const kept = await stopSdk();
    const saved = await save({
      choice: 'declined',
      version: AD_MEASUREMENT_CONSENT_VERSION,
      decidedAt: deps.now().toISOString(),
      // Still marked when the stop must be repeated on the next launch.
      sdkOn: kept ? false : granted.sdkOn,
    });
    const keptNatively = kept === true && deps.sdk.keepsWithdrawals;
    set({ prompt: 'none', ...(saved || keptNatively ? { choice: 'declined' as const } : {}) });
    if (!saved) return keptNatively ? 'saved' : 'failed';
    // A failed stop leaves `active` as it was: only a running SDK is reported.
    return kept === null && state.active ? 'stopFailed' : 'saved';
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
