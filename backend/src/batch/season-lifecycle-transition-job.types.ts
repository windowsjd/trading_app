export const SEASON_LIFECYCLE_TRANSITION_JOB_NAME =
  'season-lifecycle-transition' as const;

export type SeasonLifecycleTransitionJobInput = {
  now?: string;
  dryRun?: boolean;
  requestedBy?: string;
  idempotencyKey?: string;
};

export type SeasonLifecycleTransitionJobRequestPayload = {
  now: string | null;
  dryRun: boolean;
  requestedBy: string | null;
  idempotencyKey: string;
};

export type SeasonLifecycleTransitionSummary = {
  scanned: number;
  wouldActivate: number;
  activated: number;
  wouldEnd: number;
  ended: number;
  /**
   * Submitted limit-buy orders of ended/settled seasons canceled by this
   * run (their cash reservations were released). Runs after the status
   * transition, is idempotent, and self-heals leftovers from earlier runs.
   */
  limitOrdersCanceled: number;
};

export type SeasonLifecycleTransitionJobResult = {
  now: string;
  dryRun: boolean;
  summary: SeasonLifecycleTransitionSummary;
  activatedSeasonIds: string[];
  endedSeasonIds: string[];
  errors: Array<{
    code: string;
    message: string;
  }>;
};

export type SeasonLifecycleTransitionJobRunResponse = {
  success: true;
  data: {
    run: {
      id: string;
      resultPayloadJson: unknown;
    };
    deduplicated: boolean;
    skipped: boolean;
  };
};
