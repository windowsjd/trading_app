import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FUTURES_MARK_NOTICE_DELAY_MS,
  freshFuturesEvaluation,
  freshFuturesEvidence,
  freshFuturesReference,
  futuresActionAllowed,
  futuresMarkNotice,
  futuresPriceBasisLabel,
  futuresServerNow,
} from "./policy.ts";

const now = Date.parse("2026-10-10T12:00:00.000Z");
const at = (ms: number) => new Date(now + ms).toISOString();

test("Futures Last reference needs a receipt within 10s and a trade within 60s", () => {
  const cases: Array<[string, string, string, boolean]> = [
    ["fresh trade", at(-500), at(-400), true],
    ["quiet market, re-confirmed", at(-30000), at(-1000), true],
    ["receipt at 10s boundary", at(-10000), at(-10000), true],
    ["receipt older than 10s", at(-10001), at(-10001), false],
    ["trade at 60s boundary", at(-60000), at(-1000), true],
    ["trade older than 60s", at(-60001), at(-1000), false],
    ["trade after receipt", at(-100), at(-200), false],
    ["future receipt", at(-100), at(1), false],
    ["malformed time", "not-a-time", at(-100), false],
  ];
  for (const [label, effectiveAt, capturedAt, expected] of cases)
    assert.equal(
      freshFuturesReference({ effectiveAt, capturedAt }, now),
      expected,
      label,
    );
  assert.equal(freshFuturesReference(null, now), false);
});

test("records show the basis they were executed on", () => {
  assert.equal(futuresPriceBasisLabel("futures_last"), "선물 Last");
  assert.equal(futuresPriceBasisLabel("spot_last"), "Spot(이전 기준)");
  assert.equal(futuresPriceBasisLabel(undefined), null);
});

test("a read's server clock is its evaluatedAt plus the device time since the request was sent", () => {
  const read = { evaluatedAt: at(0), clientRequestedAt: 50_000 };
  assert.equal(futuresServerNow(read, 51_500), now + 1500);
  // A device tick before the send never moves the server clock back.
  assert.equal(futuresServerNow(read, 49_000), now);
  // Without the send time (fixtures) or a parsable evaluatedAt: the device clock.
  assert.equal(futuresServerNow({ evaluatedAt: at(0) }, 7), 7);
  assert.equal(futuresServerNow({ evaluatedAt: "bad", clientRequestedAt: 1 }, 7), 7);
  assert.equal(futuresServerNow(undefined, 7), 7);
});

/**
 * The 2026-10-16 recording: "Mark 확인 불가" and its warning flashed for about
 * 0.3 s before a 2 s poll replaced the read, while the server's Mark was fresh.
 * Production timings: Mark every 1.0 s, captured about 80 ms after Binance's
 * event, so a read carries a Mark about 1.15 s old; reads every 2 s; the screen
 * renders every second and on each response. The device clock is the only
 * difference between the two judgements.
 */
function markTimeline(deviceAheadMs: number, options: { markAgeMs?: number; lastResponse?: number } = {}) {
  const markAgeMs = options.markAgeMs ?? 1150;
  const reads: Array<{ sentAt: number; receivedAt: number; evaluatedAt: string; evidence: { effectiveAt: string; capturedAt: string } }> = [];
  for (let k = 0; k <= (options.lastResponse ?? 10); k++) {
    const sentAt = 1_000_000 + 2000 * k; // device clock
    const evaluated = sentAt - deviceAheadMs + 120; // server clock: transit + handler
    reads.push({
      sentAt,
      receivedAt: sentAt + 260,
      evaluatedAt: new Date(evaluated).toISOString(),
      evidence: { effectiveAt: new Date(evaluated - markAgeMs).toISOString(), capturedAt: new Date(evaluated - markAgeMs + 80).toISOString() },
    });
  }
  const renders = new Set<number>();
  for (let t = 1_000_000; t <= 1_022_000; t += 1000) renders.add(t + 430);
  for (const read of reads) renders.add(read.receivedAt);
  const device: boolean[] = [];
  const server: boolean[] = [];
  for (const t of [...renders].sort((a, b) => a - b)) {
    const read = reads.filter((r) => r.receivedAt <= t).pop();
    if (!read) continue;
    device.push(freshFuturesEvaluation(read.evaluatedAt, t) && freshFuturesEvidence(read.evidence, t));
    const serverNow = futuresServerNow({ evaluatedAt: read.evaluatedAt, clientRequestedAt: read.sentAt }, t);
    server.push(freshFuturesEvaluation(read.evaluatedAt, serverNow) && freshFuturesEvidence(read.evidence, serverNow));
  }
  return { device, server };
}

test("a device clock offset made a fresh Mark flash stale; the read's server clock keeps it fresh", () => {
  const ahead = markTimeline(2500);
  assert.equal(ahead.device.includes(false), true, "device 2.5 s ahead: stale just before each poll");
  assert.equal(ahead.server.includes(false), false);
  const behind = markTimeline(-1500);
  assert.equal(behind.device.includes(false), true, "device 1.5 s behind: each new read looks like the future");
  assert.equal(behind.server.includes(false), false);
  const synced = markTimeline(0);
  assert.equal(synced.device.includes(false), false);
  assert.equal(synced.server.includes(false), false);
});

test("a really stale Mark or stopped reads still turn the Mark stale on the server clock", () => {
  // The server's newest Mark is 5.5 s old: stale from the first render, at any device offset.
  for (const offset of [-1500, 0, 2500]) {
    const old = markTimeline(offset, { markAgeMs: 5500 });
    assert.equal(old.server.every((fresh) => !fresh), true, `offset ${offset}`);
  }
  // Reads stop after the third: within a few seconds the last read is too old.
  const stopped = markTimeline(0, { lastResponse: 2 });
  assert.equal(stopped.server.slice(0, 3).every(Boolean), true);
  assert.equal(stopped.server.at(-1), false);
});

test("Mark notice: an admin is told at once, a member only after two 5 s Mark windows; a fresh Mark says nothing", () => {
  assert.equal(FUTURES_MARK_NOTICE_DELAY_MS, 2 * 5000);
  for (const admin of [false, true]) {
    for (const missingForMs of [0, 9_999, 10_000, 600_000]) assert.equal(futuresMarkNotice(true, missingForMs, admin), null);
  }
  assert.deepEqual([0, 4_000, 9_999].map((ms) => futuresMarkNotice(false, ms, true)), ["diagnostic", "diagnostic", "diagnostic"]);
  assert.deepEqual([0, 4_000, 9_999].map((ms) => futuresMarkNotice(false, ms, false)), [null, null, null]);
  assert.deepEqual([10_000, 60_000].map((ms) => futuresMarkNotice(false, ms, false)), ["member", "member"]);
});

test("the Mark notice never decides what may be ordered: Open/Increase need a fresh Mark whatever is shown", () => {
  const capabilities = { tradingMode: "ENABLED" as const, canOpen: true, canIncrease: true, canReduce: true, canClose: true, reason: null };
  for (const operation of ["open", "increase"] as const) {
    assert.equal(futuresActionAllowed(capabilities, operation, false, true), false, `${operation} without a fresh Mark`);
    assert.equal(futuresActionAllowed(capabilities, operation, true, true), true, operation);
  }
  // Reduce/Close keep their own rule: a fresh Last, no Mark needed.
  for (const operation of ["reduce", "close"] as const) {
    assert.equal(futuresActionAllowed(capabilities, operation, false, true), true, operation);
    assert.equal(futuresActionAllowed(capabilities, operation, false, false), false, `${operation} without a fresh Last`);
  }
});
