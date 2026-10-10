/** Release gate policy. Keep current mode, collected evidence and readiness separate.
 * An active registered instrument is an operator-selected launch target, even if
 * its contract has expired/disappeared. Unsupported assets never registered and
 * intentionally inactive instruments are excluded unless they have live work. */
export type FuturesReadinessRow = {
  symbol: string;
  instrumentId: string;
  active: boolean;
  coverage: string;
  last: { valid: boolean } | null;
  mark: { valid: boolean };
  openPositions: number;
  pendingEntries: number;
  liveProtections: number;
};
export type FuturesWorkerObservation = {
  jobName: string;
  status: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  dryRun: boolean;
  resultJson?: unknown;
};
export type FuturesReadinessConfig = {
  // Parsed/validated by futuresTradingMode at the CLI boundary.
  tradingMode: string;
  riskEngine: boolean;
  markIngestion: boolean;
  lastPriceIngestion: boolean;
  conditionalOrders: boolean;
};
export type FuturesSettlementReadiness = {
  seasonId: string;
  instrumentId: string;
  endAt: string;
  ready: boolean;
  evidence:
    | 'pinned_last'
    | 'pinned_legacy_spot'
    | 'unfixed_last_candidate'
    | 'missing_or_invalid';
};
export const FUTURES_WORKER_REPORT_MAX_AGE_MS = 120000;

export function evaluateFuturesReadiness(
  rows: FuturesReadinessRow[],
  observations: FuturesWorkerObservation[],
  config: FuturesReadinessConfig,
  now: Date,
  settlements: FuturesSettlementReadiness[] = [],
) {
  const instruments = rows.map((row) => {
    const existingWork =
      row.openPositions + row.pendingEntries + row.liveProtections > 0;
    const required = row.active || existingWork;
    const reasons: string[] = [];
    if (required) {
      if (row.active && row.coverage !== 'verified')
        reasons.push('CONTRACT_UNVERIFIED_EXPIRED_OR_INVALID');
      if (!row.last?.valid) reasons.push('LAST_UNAVAILABLE_OR_STALE');
      if (!row.mark.valid) reasons.push('MARK_UNAVAILABLE_OR_STALE');
    }
    return {
      ...row,
      required,
      targetReason: row.active
        ? 'active_registered'
        : existingWork
          ? 'existing_financial_work'
          : 'inactive_without_work',
      reasons,
      ready: required && reasons.length === 0,
      // Coverage/activation gates new entries; existing exits must stay priced.
      exitPricesReady: !!row.last?.valid && row.mark.valid,
    };
  });
  const totals = {
    openPositions: rows.reduce((n, r) => n + r.openPositions, 0),
    pendingEntries: rows.reduce((n, r) => n + r.pendingEntries, 0),
    liveProtections: rows.reduce((n, r) => n + r.liveProtections, 0),
  };
  const components = [
    { component: 'last_ingestion', ready: config.lastPriceIngestion },
    { component: 'mark_ingestion', ready: config.markIngestion },
    { component: 'risk_engine', ready: config.riskEngine },
  ].map((c) => ({ ...c, reason: c.ready ? null : 'CONFIG_DISABLED' }));
  if (totals.liveProtections > 0)
    components.push({
      component: 'conditional_orders_config',
      ready: config.conditionalOrders,
      reason: config.conditionalOrders ? null : 'CONFIG_DISABLED',
    });
  const demands: Record<string, number> = {
    futures_limit_matching: totals.pendingEntries,
    conditional_orders: totals.liveProtections,
    futures_liquidation: totals.openPositions,
  };
  const workers = observations.map((run) => {
    const required = (demands[run.jobName] ?? 0) > 0;
    const start = run.startedAt ? Date.parse(run.startedAt) : NaN;
    const finish = run.finishedAt ? Date.parse(run.finishedAt) : NaN;
    const observed = Number.isFinite(start) && Number.isFinite(finish);
    const recent =
      observed &&
      start <= finish &&
      finish <= +now &&
      +now - finish <= FUTURES_WORKER_REPORT_MAX_AGE_MS;
    // Workers may record a successful cycle containing individual failures.
    const json =
      run.resultJson && typeof run.resultJson === 'object'
        ? (run.resultJson as { states?: unknown; results?: unknown })
        : null;
    const expectedPending =
      run.jobName === 'futures_limit_matching'
        ? 'FUTURES_ENTRY_LIMIT_NOT_REACHED'
        : run.jobName === 'conditional_orders'
          ? 'CONDITIONAL_LIMIT_NOT_REACHED'
          : null;
    const executionErrors =
      !!json &&
      (Object.entries(
        json.states && typeof json.states === 'object' ? json.states : {},
      ).some(
        ([state, count]) =>
          /^[A-Z][A-Z0-9_]+$/.test(state) &&
          state !== expectedPending &&
          typeof count === 'number' &&
          count > 0,
      ) ||
        (Array.isArray(json.results) &&
          json.results.some(
            (r: unknown) =>
              !!r && typeof r === 'object' && 'failure' in r && !!r.failure,
          )));
    const healthy =
      run.status === 'succeeded' &&
      run.dryRun === false &&
      recent &&
      !executionErrors;
    return {
      ...run,
      required,
      ready: !required || healthy,
      observation: !required
        ? 'not_required_no_live_work'
        : healthy
          ? 'recent_success'
          : 'unhealthy_or_unobserved',
      reason:
        !required || healthy
          ? null
          : !run.status
            ? 'WORKER_UNOBSERVED'
            : run.status !== 'succeeded'
              ? 'WORKER_NOT_SUCCEEDED'
              : run.dryRun !== false
                ? 'WORKER_DRY_RUN_OR_EXECUTION_UNCONFIRMED'
                : !recent
                  ? 'WORKER_REPORT_STALE_OR_INVALID'
                  : 'WORKER_EXECUTION_ERRORS',
    };
  });
  // A missing observation must never silently remove a required component.
  for (const [jobName, demand] of Object.entries(demands)) {
    if (demand > 0 && !workers.some((w) => w.jobName === jobName))
      workers.push({
        jobName,
        status: null,
        startedAt: null,
        finishedAt: null,
        dryRun: false,
        required: true,
        ready: false,
        observation: 'unhealthy_or_unobserved',
        reason: 'WORKER_UNOBSERVED',
      });
  }
  const blockers = [
    ...components
      .filter((c) => !c.ready)
      .map((c) => ({ component: c.component, reason: c.reason })),
    ...instruments
      .filter((r) => r.required && !r.ready)
      .flatMap((r) =>
        r.reasons.map((reason) => ({ component: r.instrumentId, reason })),
      ),
    ...workers
      .filter((w) => !w.ready)
      .map((w) => ({ component: w.jobName, reason: w.reason })),
    ...settlements
      .filter((s) => !s.ready)
      .map((s) => ({
        component: `${s.seasonId}/${s.instrumentId}`,
        reason: 'FINAL_SETTLEMENT_EVIDENCE_MISSING_OR_INVALID',
      })),
  ];
  if (!rows.some((r) => r.active))
    blockers.push({
      component: 'catalog',
      reason: 'NO_ACTIVE_REGISTERED_INSTRUMENTS',
    });
  const launchReady = blockers.length === 0;
  const existingWorkReady =
    components.every((c) => c.ready) &&
    workers.every((w) => w.ready) &&
    settlements.every((s) => s.ready) &&
    instruments
      .filter((r) => r.openPositions + r.pendingEntries + r.liveProtections > 0)
      .every((r) => r.exitPricesReady);
  return {
    config,
    instruments,
    workers,
    components,
    settlements,
    blockers,
    summary: {
      instruments: rows.length,
      required: instruments.filter((r) => r.required).length,
      activeVerified: rows.filter((r) => r.active && r.coverage === 'verified')
        .length,
      ready: instruments.filter((r) => r.ready).length,
      ...totals,
    },
    readiness: {
      launchReady,
      existingWorkReady,
      newTradingAvailable: config.tradingMode === 'ENABLED' && launchReady,
      userExitsAvailable:
        config.tradingMode !== 'DISABLED' && existingWorkReady,
    },
  };
}
