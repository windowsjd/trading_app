import assert from "node:assert/strict";
import { test } from "node:test";
import { freshFuturesReference, futuresPriceBasisLabel } from "./policy.ts";

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
