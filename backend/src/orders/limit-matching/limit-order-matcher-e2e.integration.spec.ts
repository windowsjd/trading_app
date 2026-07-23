import { spawnSync } from 'node:child_process';

/**
 * END-TO-END matcher suite: XADD -> consumer-group read -> validation ->
 * boundary -> dedupe -> candidate query -> execution transaction ->
 * processed-event insert -> XACK.
 *
 * This is deliberately NOT the publisher throughput suite. The phase-3 runner
 * measures how fast the PUBLISHER can validate and XADD a normalized tick
 * (`limit_order_publisher_throughput`); this one measures how fast the MATCHER
 * can consume one (`limit_order_matcher_e2e_throughput`). The consumer does
 * strictly more work per event, so the two numbers differ by an order of
 * magnitude and must never be quoted for each other.
 *
 * CI asserts only hardware-independent invariants. Absolute rates are printed
 * for the soak run (`pnpm soak:limit-order-matcher-e2e`) and never asserted,
 * because a GitHub runner's throughput says nothing about production capacity.
 *
 * What IS asserted about the numbers is that they are arithmetically sound:
 * the matcher rate's denominator is the window the consumer actually ran in
 * (the backlog is published with the consumer stopped), every event has a real
 * XADD -> XACK latency sample, and nothing is reported that was not measured.
 * A rate divided by a window that does not contain the work is wrong on every
 * machine, so it is a CI gate rather than a soak observation.
 *
 * The runner needs a DISPOSABLE database.
 */
const RUN_INTEGRATION = process.env.LIMIT_ORDER_MATCHER_E2E_INTEGRATION === '1';
const itIntegration = RUN_INTEGRATION ? it : it.skip;

describe('Limit order matcher end-to-end integration', () => {
  itIntegration(
    'processes and acknowledges every event with no duplicate fill, backlog, or residual lock',
    () => {
      const suffix = `${process.pid}-${Date.now()}`;
      const result = spawnSync(
        'pnpm',
        ['tsx', 'scripts/limit-order-matcher-e2e-integration.ts'],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            LIMIT_ORDER_AUTO_EXECUTION_ENABLED: 'true',
            LIMIT_ORDER_EVENT_STREAM_KEY: `limit-order:e2e:${suffix}`,
            LIMIT_ORDER_EVENT_CONSUMER_GROUP: `limit-order-e2e:${suffix}`,
            LIMIT_ORDER_EVENT_BLOCK_MS: '250',
            LIMIT_ORDER_EVENT_MAXLEN: '5000',
            LIMIT_ORDER_PENDING_IDLE_MS: '1000',
            LIMIT_ORDER_RECLAIM_INTERVAL_MS: '1000',
            LIMIT_ORDER_MATCHER_HEARTBEAT_INTERVAL_MS: '500',
            LIMIT_ORDER_MATCHER_HEALTH_MAX_AGE_MS: '3000',
            // Reduced CI volume; the soak run raises these.
            LIMIT_ORDER_E2E_ASSET_COUNT: '6',
            LIMIT_ORDER_E2E_EVENTS_PER_ASSET: '25',
          },
          encoding: 'utf8',
          timeout: 300_000,
        },
      );

      if (result.status !== 0) {
        throw new Error(
          [
            'Limit order matcher e2e integration runner failed.',
            'stdout:',
            result.stdout,
            'stderr:',
            result.stderr,
          ].join('\n'),
        );
      }
      for (const name of [
        'every published event is processed and acknowledged',
        'every reported rate has a measured denominator',
        'consumer lag returns to zero',
        'pending returns to zero',
        'no order is filled twice',
        'a duplicate eventId is not re-processed',
        'a reclaimed pending entry is drained',
        'a new leader drains the backlog after takeover',
        'no residual boundary advisory lock remains',
        'the matcher reports no degraded state',
      ]) {
        expect(result.stdout).toContain(`ok ${name}`);
      }
      // The load report CI keeps in its job log. The event NAME is the
      // contract: it must never be confused with the publisher measurement.
      expect(result.stdout).toContain('limit_order_matcher_e2e_throughput');
      expect(result.stdout).toContain('"measured":"xadd_to_xack"');
      expect(result.stdout).not.toContain('limit_order_publisher_throughput');
      // The matcher's capacity is reported under a name that says whose
      // capacity it is, and the runner's own XADD rate under one that says it
      // is the runner's. `drainEventsPerSecond` was neither: it divided every
      // event by the tail window left after publishing stopped, while the
      // consumer had been running the whole time.
      expect(result.stdout).toContain('matcherDrainEventsPerSecond');
      expect(result.stdout).toContain('runnerXaddEventsPerSecond');
      // The split instrumentation: XADD->processed (ACK start) and the ACK
      // round trip are separate, real samples; the per-event boundary wait is
      // reported as unmeasured, never as a fake constant.
      expect(result.stdout).toContain('xaddToProcessedMsP50');
      expect(result.stdout).toContain('ackRoundTripMsP50');
      expect(result.stdout).toContain('"boundaryWait":"not_measured"');
      expect(result.stdout).not.toContain('drainEventsPerSecond"');
      expect(result.stdout).not.toContain('endToEndEventsPerSecond');
      // Nothing is printed that was not measured; `boundaryWaitMs` was a
      // hardcoded zero presented as an observation.
      expect(result.stdout).not.toContain('"boundaryWaitMs"');
      expect(result.stdout).toContain('limit order matcher e2e integration ok');
    },
    320_000,
  );
});
