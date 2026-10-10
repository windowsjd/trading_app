import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { Credentials, Manifest } from './manifest';
import { hash, workloadHash } from './manifest';
import {
  Histogram,
  jsonl,
  Metrics,
  ProcessSampler,
  writeJson,
} from './metrics';
import { preflight, verifyApi, controlKey } from './preflight';
import { Actor, type Fixture } from './actor';
import { AppClient } from './client';
import { Observer } from './observe';
import { audit } from './audit';
import { judge, type RunFacts } from './verdict';

export async function run(
  m: Manifest,
  c: Credentials,
  manifestHash: string,
  fixtureFile: string,
  out: string,
  metrics: Metrics,
) {
  await preflight(m, c);
  await verifyApi(m, c, manifestHash);
  const fixture = JSON.parse(readFileSync(fixtureFile, 'utf8')) as Fixture;
  if (
    fixture.runId !== m.runId ||
    fixture.manifestHash !== manifestHash ||
    fixture.actors.length !== m.users
  )
    throw new Error('RUN_FIXTURE_IDENTITY_MISMATCH');
  const selected = fixture.actors.filter(
    (a) => a.index % m.generator.shardCount === m.generator.shardIndex,
  );
  const observer = new Observer(m, c, out);
  await observer.connect();
  const server = JSON.parse(
    (await observer.redis.get(controlKey(m, 'server'))) ?? 'null',
  );
  if (server?.manifestHash !== manifestHash || server.sha !== m.expectedGitSha)
    throw new Error('RUN_SERVER_IDENTITY_MISMATCH');
  if (
    (await observer.redis.set(
      controlKey(m, `run-claimed-${m.generator.shardIndex}`),
      manifestHash,
      'NX',
    )) !== 'OK'
  ) {
    await observer.close();
    throw new Error(
      'RUN_REFUSES_REUSED_FIXTURE_USE_FRESH_PHYSICAL_VALKEY_AND_DATABASE',
    );
  }
  const facts: RunFacts = {
    completed: false,
    rampAcked: 0,
    expectedUsers: selected.length,
    connectedUserSeconds: 0,
    holdSeconds: 0,
    observerFailures: 0,
    generatorInvalidReasons: [],
    serviceFailures: [],
    auditVerdict: 'CORRECTNESS INCOMPLETE',
  };
  const actors: Actor[] = [];
  const sampler = new ProcessSampler();
  const lag = new Histogram();
  const cpu = new Histogram();
  const scheduled = new Histogram();
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  let lastObserve = 0,
    lastSample = performance.now(),
    lastWall = Date.now(),
    lastClockMono = performance.now(),
    peakBacklog = 0,
    peakRam = 0;
  let lastPending = 0,
    pendingIncrease = 0,
    serverPid: number | undefined;
  let clockOffset = 0;
  let observing: Promise<void> | undefined;
  const abort = (reason: string) => {
    if (!facts.serviceFailures.includes(reason))
      facts.serviceFailures.push(reason);
    stopping = true;
  };
  async function monitor() {
    const now = performance.now();
    const wall = Date.now();
    const elapsed = (now - lastSample) / 1000;
    lastSample = now;
    const authenticated = actors.filter(
      (a) => a.ws.connected && a.ws.acked.size > 0,
    ).length;
    if (metrics.phase === 'hold') {
      const covered = Math.max(
        0,
        Math.min(elapsed, m.holdSeconds - facts.holdSeconds),
      );
      facts.connectedUserSeconds += authenticated * covered;
      facts.holdSeconds += covered;
    }
    const processSample = sampler.sample();
    const backlog = actors.reduce((sum, a) => sum + a.ws.backlogBytes(), 0);
    peakBacklog = Math.max(peakBacklog, backlog);
    peakRam = Math.max(peakRam, processSample.rssBytes);
    if (metrics.phase === 'hold') {
      lag.add(processSample.eventLoopLagP99Ms);
      cpu.add(processSample.cpuCoresUsed / m.generator.cpuCores);
    }
    if (Math.abs(wall - lastWall - (now - lastClockMono)) > 50) {
      facts.generatorInvalidReasons.push('WALL_CLOCK_STEP');
      jsonl(resolve(out, 'wall-clock-steps.jsonl'), {
        at: new Date(wall).toISOString(),
        wallDeltaMs: wall - lastWall,
        monotonicDeltaMs: now - lastClockMono,
        stepMs: wall - lastWall - (now - lastClockMono),
      });
    }
    lastWall = wall;
    lastClockMono = now;
    const sample = {
      ...processSample,
      phase: metrics.phase,
      expected: selected.length,
      authenticated,
      subscriptions: actors.reduce((n, a) => n + a.ws.subscriptions.size, 0),
      acked: actors.reduce((n, a) => n + a.ws.acked.size, 0),
      openSockets: actors.filter((a) => a.ws.socket).length,
      receiveBacklogBytes: backlog,
      busyActors: actors.filter((a) => a.isBusy()).length,
      occupancy: Object.fromEntries(
        ['market', 'detail', 'spot', 'futures', 'home', 'historyFx'].map(
          (s) => [s, actors.filter((a) => a.screen === s).length],
        ),
      ),
    };
    jsonl(resolve(out, 'generator.samples.jsonl'), sample);
    if (authenticated > selected.length) abort('WS_CONNECTION_LEAK');
    if (
      Object.entries(metrics.counters)
        .filter(([k]) => /:((ws|http)\.receivedBytes)$/.test(k))
        .reduce((n, [, v]) => n + v, 0) >
      m.maxReceivedBytes / m.generator.shardCount
    )
      abort('APPROVED_NETWORK_BUDGET_EXCEEDED');
    if (now - lastObserve >= 5000 && !observing) {
      lastObserve = now;
      // Cloud metrics can take seconds. Never block action dispatch on the
      // observer; one bounded in-flight sample, joined before final audit.
      observing = (async () => {
        try {
          const state = await observer.sample();
          const midpoint = Date.now();
          const serverTime = Date.parse(state.server.at);
          clockOffset = serverTime - midpoint;
          // Use DB clock sampled directly over the connection, not the 1s-old
          // server metric timestamp, to validate cross-host latency accuracy.
          const t0 = Date.now();
          const dbClock = (
            await observer.pg.query('SELECT clock_timestamp() AS now')
          ).rows[0].now;
          const t1 = Date.now();
          clockOffset = +dbClock - (t0 + t1) / 2;
          if (Math.abs(clockOffset) > 50 || t1 - t0 > 100)
            facts.generatorInvalidReasons.push('CLOCK_OFFSET_OR_UNCERTAINTY');
          actors.forEach((a) => (a.ws.clockOffsetMs = clockOffset));
          if (serverPid !== undefined && serverPid !== state.server.pid)
            abort('API_RESTART');
          serverPid = state.server.pid;
          if (state.server.fanout.clients > m.users)
            abort('SERVER_WS_CONNECTION_LEAK');
          const pending = state.server.fanout.pendingTickers;
          pendingIncrease = pending > lastPending ? pendingIncrease + 1 : 0;
          lastPending = pending;
          if (pendingIncrease >= 6) abort('PERSISTENT_PENDING_QUEUE_GROWTH');
          if (Number(state.postgres.deadlocks) > 0) abort('POSTGRES_DEADLOCK');
          if (
            Object.keys(state.valkey).some(
              (k) => k === 'errorstat_OOM' && state.valkey[k] !== 'count=0',
            )
          )
            abort('VALKEY_OOM_WRITE_FAILURE');
          if (
            Object.entries(state.server.metrics.counters).some(
              ([key, n]) =>
                /failure:(WS_SEND_FAILURE|PG_|WORKER_FAILURE|VALKEY_|CONTROL_VALKEY_ERROR|REPLAY_FX_INGEST_FAILED)/.test(
                  key,
                ) && Number(n) > 0,
            )
          )
            abort('SERVER_RUNTIME_FAILURE');
          const external = Object.keys(state.server.metrics.counters).filter(
            (k) => /EXTERNAL_PROVIDER|NETWORK_BLOCKED/.test(k),
          );
          if (external.length) abort('EXTERNAL_PROVIDER_ATTEMPT');
        } catch {
          facts.observerFailures++;
        }
        if (await observer.redis.get(controlKey(m, 'abort')))
          abort('SERVER_ABORT');
      })()
        .catch(() => {
          facts.observerFailures++;
        })
        .finally(() => {
          observing = undefined;
        });
    }
  }
  async function phase(name: string) {
    metrics.phase = name;
    await observer.redis.set(controlKey(m, 'phase'), name);
  }
  try {
    writeJson(resolve(out, 'manifest.json'), {
      ...m,
      manifestHash,
      workloadHash: workloadHash(m),
      fixtureHash: hash(fixture),
      replayHash: server.replayHash,
      gitSha: m.expectedGitSha,
      node: process.version,
      actualWsCondition:
        'One socket per user; minimum one ticker retained explicitly for authenticated WS stress; initial subscription dispatch waits 100ms after socket open',
      behaviorSource:
        'Initial code-derived assumptions, not production analytics',
    });
    await phase('ramp');
    const phaseWait = performance.now() + 5000;
    let phaseAcknowledged = false;
    while (performance.now() < phaseWait) {
      const raw = await observer.redis.get(controlKey(m, 'server-sample'));
      if (raw && JSON.parse(raw).phase === 'ramp') {
        phaseAcknowledged = true;
        break;
      }
      await delay(100);
    }
    if (!phaseAcknowledged)
      throw new Error('REPLAY_RAMP_PHASE_NOT_ACKNOWLEDGED');
    const rampStart = performance.now();
    const starts: Promise<void>[] = [];
    for (const item of selected) {
      const due = rampStart + (item.index / m.users) * m.rampSeconds * 1000;
      while (performance.now() < due && !stopping) {
        for (const actor of actors)
          if (actor.started) void actor.step(performance.now());
        if (performance.now() - lastSample >= 1000) await monitor();
        await delay(Math.max(1, Math.min(100, due - performance.now())));
      }
      if (stopping) break;
      scheduled.add(Math.max(0, performance.now() - due));
      const client = new AppClient(m, c, item.email, metrics);
      const actor = new Actor(
        m,
        item,
        fixture,
        client,
        metrics,
        resolve(out, 'commands.jsonl'),
      );
      actors.push(actor);
      starts.push(
        actor.start().catch(() => {
          abort('ACTOR_LOGIN_OR_WS_ACK_FAILED');
        }),
      );
    }
    await Promise.all(starts);
    const rampEnd = rampStart + m.rampSeconds * 1000;
    if (performance.now() < rampEnd) await delay(rampEnd - performance.now());
    facts.rampAcked = actors.filter(
      (a) => a.ws.connected && a.ws.acked.size > 0,
    ).length;
    if (facts.rampAcked !== selected.length) abort('RAMP_TARGET_NOT_REACHED');
    if (m.profile === 'smoke' && !stopping) {
      await phase('smoke-protocol');
      const a = actors[0],
        asset = fixture.assets.find((s) => s.assetType === 'crypto')!;
      a.ws.setSubscriptions([
        { channel: 'asset_ticker', assetId: asset.id },
        { channel: 'asset_candle', assetId: asset.id, interval: '5m' },
        { channel: 'asset_order_book', assetId: asset.id },
        { channel: 'fx_rate', pair: 'USD/KRW' },
      ]);
      const ackDeadline = Date.now() + 10000;
      while (a.ws.acked.size < 4 && Date.now() < ackDeadline) await delay(50);
      if (a.ws.acked.size !== 4) throw new Error('SMOKE_CHANNEL_ACK_FAILED');
      a.ws.setSubscriptions([{ channel: 'asset_ticker', assetId: asset.id }]);
      await delay(100);
      a.ws.socket?.close(1000, 'smoke protocol reconnect');
      await delay(1200);
      await a.ws.ready();
      metrics.count('smoke.subscribeUnsubscribeReconnectVerified');
      await a.http.refresh();
      await a.ws.ready();
      metrics.count('smoke.refreshReconnectVerified');
      const limit = await a.spotTrade('buy', asset, 'limit', true);
      const id = limit.order?.orderId;
      if (!id) throw new Error('SMOKE_LIMIT_RESPONSE');
      const fillEnd = Date.now() + 15000;
      let terminal: any;
      do {
        terminal = await a.http.get(a.path(`/orders/${id}`), 0, true);
        if (terminal.order?.status === 'executed') break;
        await delay(500);
      } while (Date.now() < fillEnd);
      if (terminal.order?.status !== 'executed')
        throw new Error('SMOKE_SPOT_MATCHING_NOT_FILLED');
      metrics.count('smoke.spotLimitFillVerified');
      // Same key/body checks the actual durable response replay path.
      const commandRows = readFileSync(resolve(out, 'commands.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      const last = commandRows.filter((r) => r.path === '/orders').at(-1)!;
      const response = await a.http.request(
        'POST',
        a.path(last.path),
        last.body,
      );
      if (hash(response) !== last.responseHash)
        throw new Error('SMOKE_IDEMPOTENCY_MISMATCH');
      metrics.count('smoke.idempotencyVerified');
      // Verify the real Futures limit worker, every normal market operation,
      // and a small SL/TP/OCO commit. Never manipulate prices or financial rows.
      const instrument = fixture.instruments.at(-1)!;
      const catalog = await a.http.get(a.path('/futures/instruments'), 0, true);
      const info = catalog.instruments.find((i: any) => i.id === instrument.id);
      if (!info?.referencePrice || !info.referencePriceEvidence)
        throw new Error('SMOKE_VERIFIED_FUTURES_LAST_MISSING');
      const lastPrice = info.referencePrice;
      const { Prisma } = require('../../src/generated/prisma/client');
      const qty = new Prisma.Decimal('20')
        .div(lastPrice)
        .toDecimalPlaces(8, Prisma.Decimal.ROUND_DOWN)
        .toFixed(8);
      const entry = await a.command(
        '/futures/limit-orders',
        {
          instrumentId: instrument.id,
          direction: 'long',
          marginMode: 'isolated',
          leverage: 5,
          quantity: qty,
          limitPrice: new Prisma.Decimal(lastPrice).mul('1.001').toFixed(8),
          idempotencyKey: a.idempotency(),
        },
        true,
      );
      const futureDeadline = Date.now() + 15000;
      let filled = false;
      while (Date.now() < futureDeadline) {
        const row = (
          await observer.pg.query(
            'SELECT status FROM futures_limit_orders WHERE id=$1 AND trading_account_id=$2',
            [entry.order.id, a.fixture.accountId],
          )
        ).rows[0];
        if (row?.status === 'executed') {
          filled = true;
          break;
        }
        await delay(250);
      }
      if (!filled) throw new Error('SMOKE_FUTURES_LIMIT_NOT_FILLED');
      metrics.count('smoke.futuresLimitFillVerified');
      await a.futuresTrade(true, fixture.instruments.length - 1);
      let positions = await a.http.get(a.path('/futures/positions'), 0, true);
      let p = positions.positions.find(
        (p: any) => p.instrumentId === instrument.id,
      );
      const base = {
        instrumentId: instrument.id,
        direction: p.direction,
        positionId: p.id,
        leverage: p.leverage,
        marginMode: p.marginMode,
      };
      await a.command(
        '/futures/execute',
        {
          ...base,
          operation: 'reduce',
          quantity: new Prisma.Decimal(p.quantity)
            .div(2)
            .toDecimalPlaces(8, Prisma.Decimal.ROUND_DOWN)
            .toFixed(8),
          idempotencyKey: a.idempotency(),
        },
        true,
      );
      positions = await a.http.get(a.path('/futures/positions'), 0, true);
      p = positions.positions.find(
        (p: any) => p.instrumentId === instrument.id,
      );
      await a.command(
        '/futures/execute',
        {
          ...base,
          operation: 'close',
          quantity: p.quantity,
          idempotencyKey: a.idempotency(),
        },
        true,
      );
      const opened = await a.command(
        '/futures/execute',
        {
          instrumentId: instrument.id,
          direction: 'long',
          marginMode: 'isolated',
          leverage: 5,
          operation: 'open',
          quantity: qty,
          idempotencyKey: a.idempotency(),
        },
        true,
      );
      positions = await a.http.get(a.path('/futures/positions'), 0, true);
      p = positions.positions.find(
        (p: any) => p.instrumentId === instrument.id,
      );
      if (!opened.execution || !p)
        throw new Error('SMOKE_FUTURES_OPEN_EVIDENCE');
      metrics.count('smoke.futuresOpenIncreaseReduceCloseVerified');
      const protection = await a.command(
        '/protections',
        {
          domain: 'futures',
          assetId: instrument.underlyingAssetId,
          positionId: p.id,
          legs: [
            {
              kind: 'stop_loss',
              triggerPrice: new Prisma.Decimal(p.referencePrice)
                .mul('.9998')
                .toFixed(8),
              childOrderType: 'market',
            },
            {
              kind: 'take_profit',
              triggerPrice: new Prisma.Decimal(p.referencePrice)
                .mul('1.05')
                .toFixed(8),
              childOrderType: 'market',
            },
          ],
          idempotencyKey: a.idempotency(),
        },
        true,
      );
      const protectionDeadline = Date.now() + 15000;
      let childFilled = false;
      while (Date.now() < protectionDeadline) {
        const children = (
          await observer.pg.query(
            'SELECT status FROM protection_children WHERE group_id=$1',
            [protection.groupId],
          )
        ).rows;
        if (children.filter((c) => c.status === 'filled').length === 1) {
          childFilled = true;
          break;
        }
        await delay(250);
      }
      if (!childFilled) throw new Error('SMOKE_CONDITIONAL_NOT_FILLED');
      metrics.count('smoke.conditionalOcoCommitVerified');
      const pending = await actors[1].http.get(
        actors[1].path('/futures/limit-orders?limit=100&offset=0'),
        0,
        true,
      );
      if (pending.orders.length) {
        await actors[1].command(
          `/futures/limit-orders/${pending.orders[0].id}/cancel`,
          undefined,
        );
        metrics.count('smoke.futuresCancelVerified');
      }
    }
    if (!stopping) {
      await phase('hold');
      lastSample = performance.now();
      const end = performance.now() + m.holdSeconds * 1000;
      let dispatchDue = performance.now();
      while (performance.now() < end && !stopping) {
        const now = performance.now();
        metrics.time('generator.dispatchDelay', Math.max(0, now - dispatchDue));
        dispatchDue = now + 100;
        for (const actor of actors) void actor.step(now);
        if (now - lastSample >= 1000) await monitor();
        const critical = Object.keys(metrics.counters).some((k) =>
          /failure:(ACCOUNT_SCOPE|IDEMPOTENCY|EXTERNAL_PROVIDER|LOAD_TEST_NETWORK)/.test(
            k,
          ),
        );
        if (critical) abort('CORRECTNESS_OR_SAFETY_FAILURE');
        await delay(100);
      }
      await monitor();
      facts.completed = !stopping;
      facts.holdSeconds = Math.min(facts.holdSeconds, m.holdSeconds);
    }
    await phase('drain');
    const deadline = performance.now() + 10000;
    while (actors.some((a) => a.isBusy()) && performance.now() < deadline)
      await delay(100);
    if (actors.some((a) => a.isBusy())) abort('IN_FLIGHT_ACTION_DRAIN_TIMEOUT');
    // Cleanup is measured separately from hold, always via owned normal APIs.
    for (const actor of actors) {
      for (const suffix of [
        '/orders?status=submitted&limit=100&offset=0',
        '/futures/limit-orders?limit=100&offset=0',
      ]) {
        const data = await actor.http.get(actor.path(suffix), 0, true);
        for (const order of data.orders ?? []) {
          if (order.status !== 'submitted') continue;
          const path = suffix.startsWith('/orders')
            ? `/orders/${order.orderId}/cancel`
            : `/futures/limit-orders/${order.id}/cancel`;
          try {
            await actor.http.request('POST', actor.path(path));
          } catch {
            metrics.count('drain.cancelRaceOrFailure');
          }
        }
      }
    }
    const drainEnd = performance.now() + m.drainSeconds * 1000;
    while (performance.now() < drainEnd) {
      if (performance.now() - lastSample >= 1000) await monitor();
      await delay(100);
    }
    await observing;
    actors.forEach((a) => a.stop());
    await delay(500);
    const closeState = JSON.parse(
      (await observer.redis.get(controlKey(m, 'server-sample'))) ?? 'null',
    );
    if (closeState?.fanout.clients > 0) {
      await delay(1500);
      const settled = JSON.parse(
        (await observer.redis.get(controlKey(m, 'server-sample'))) ?? 'null',
      );
      if (settled?.fanout.clients > 0)
        facts.serviceFailures.push('WS_POST_DRAIN_CONNECTION_LEAK');
    }
    await phase('audit');
    const audited = await audit(m, c, fixture, out);
    facts.auditVerdict = audited.verdict;
    const serverFinal = JSON.parse(
      (await observer.redis.get(controlKey(m, 'server-sample'))) ?? 'null',
    );
    writeJson(resolve(out, 'server-metrics-final.json'), serverFinal);
    if (lag.percentile(0.99) > m.generator.maxLagP99Ms)
      facts.generatorInvalidReasons.push('GENERATOR_EVENT_LOOP_LAG');
    if (cpu.count && cpu.total / cpu.count > 0.6)
      facts.generatorInvalidReasons.push('GENERATOR_CPU');
    if (peakRam > m.generator.memoryBytes * 0.7)
      facts.generatorInvalidReasons.push('GENERATOR_MEMORY');
    if (peakBacklog > 1024 * 1024)
      facts.generatorInvalidReasons.push('GENERATOR_RECEIVE_BACKLOG');
    const dispatchDelay = metrics.histograms['hold:generator.dispatchDelay'];
    if (
      dispatchDelay?.percentile(0.99) > m.generator.maxScheduledDelayP99Ms ||
      scheduled.percentile(0.99) > m.generator.maxScheduledDelayP99Ms
    )
      facts.generatorInvalidReasons.push('GENERATOR_SCHEDULE_DELAY');
    const refreshes = metrics.counters['hold:auth.refresh'] ?? 0;
    const authCoverage = actors.map((a) => ({
      actor: a.fixture.index,
      refreshes: a.http.refreshCount,
    }));
    if (m.profile === 'baseline' && authCoverage.some((a) => a.refreshes < 3))
      facts.serviceFailures.push('AUTH_REFRESH_PER_USER_COVERAGE_MISSING');
    if ((m.profile === 'baseline' || m.holdSeconds >= 60) && refreshes === 0)
      facts.serviceFailures.push('AUTH_REFRESH_COVERAGE_MISSING');
    facts.generatorInvalidReasons = [...new Set(facts.generatorInvalidReasons)];
    const result = judge(m, metrics, facts);
    writeJson(resolve(out, 'summary.json'), {
      ...result,
      capacityHeadroom: { ...result.capacityHeadroom, ...observer.headroom() },
      facts,
      authCoverage,
      httpAndWs: metrics.summary(),
      generator: {
        cpuFraction: cpu.summary(),
        eventLoopLagSampleP99: lag.summary(),
        rampScheduledDelay: scheduled.summary(),
        peakRam,
        peakBacklog,
      },
      smokeOnly: m.profile === 'smoke',
      baselineCapacityConclusion:
        m.profile === 'smoke'
          ? 'No 1000-user capacity conclusion'
          : result.performance,
    });
    writeJson(resolve(out, 'histograms.json'), metrics.serializable());
    return result;
  } catch (e) {
    // A failed run can still have durable financial commits. Always inspect
    // the complete fixture instead of declaring an unexamined state correct.
    actors.forEach((a) => a.stop());
    const until = performance.now() + 10000;
    while (actors.some((a) => a.isBusy()) && performance.now() < until)
      await delay(100);
    if (m.generator.shardCount === 1) {
      try {
        await phase('audit');
        facts.auditVerdict = (await audit(m, c, fixture, out)).verdict;
      } catch {
        facts.auditVerdict = 'CORRECTNESS INCOMPLETE';
      }
    }
    writeJson(resolve(out, 'histograms.json'), metrics.serializable());
    writeJson(resolve(out, 'summary.json'), {
      runValidity: 'INVALID RUN',
      correctness: facts.auditVerdict,
      performance: 'NOT EVALUATED',
      reason: e instanceof Error ? e.message : 'RUN_ERROR',
      facts,
      metrics: metrics.summary(),
    });
    throw e;
  } finally {
    actors.forEach((a) => a.stop());
    sampler.close();
    await observing;
    await observer.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}
