import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { AssetCandlesDto } from "./api";
import {
  mergeAssetCandleSnapshot,
  parseAssetCandleSnapshot,
  type AssetCandleSnapshotMessage,
} from "./liveCandle.ts";

describe("live candle chart reducer", () => {
  it("replaces the same bucket, appends a new bucket, sorts, and enforces limit", () => {
    const baseline = fixtureBaseline();
    const replacement = fixtureSnapshot("2026-07-13T00:05:00.000Z", 2);
    assert.deepEqual(
      mergeAssetCandleSnapshot(baseline, replacement, 2).map(
        (row) => row.close,
      ),
      ["100.00000000", "109.00000000"],
    );

    const appended = fixtureSnapshot("2026-07-13T00:10:00.000Z", 3);
    const rows = mergeAssetCandleSnapshot(baseline, appended, 2);
    assert.deepEqual(
      rows.map((row) => row.time),
      ["2026-07-13T00:05:00.000Z", "2026-07-13T00:10:00.000Z"],
    );
  });

  it("rejects malformed, mismatched, and inconsistent OHLC messages", () => {
    const valid = fixtureSnapshot("2026-07-13T00:05:00.000Z", 2);
    assert.ok(
      parseAssetCandleSnapshot(valid, { assetId: "asset-1", interval: "5m" }),
    );
    assert.equal(
      parseAssetCandleSnapshot(valid, { assetId: "other", interval: "5m" }),
      null,
    );
    assert.equal(
      parseAssetCandleSnapshot(
        { ...valid, final: undefined },
        { assetId: "asset-1", interval: "5m" },
      ),
      null,
    );
    assert.equal(
      parseAssetCandleSnapshot(
        { ...valid, candle: { ...valid.candle, high: "1" } },
        { assetId: "asset-1", interval: "5m" },
      ),
      null,
    );
    assert.equal(
      parseAssetCandleSnapshot(
        { ...valid, candle: { ...valid.candle, amount: "-1" } },
        { assetId: "asset-1", interval: "5m" },
      ),
      null,
    );
    assert.equal(
      parseAssetCandleSnapshot(
        {
          ...valid,
          candle: {
            ...valid.candle,
            openTime: "2026-07-13T00:00:00.000Z",
          },
        },
        { assetId: "asset-1", interval: "5m" },
      ),
      null,
    );
  });

  it("does not merge 1d/1w or a prior interval snapshot", () => {
    const baseline = fixtureBaseline();
    const snapshot = fixtureSnapshot("2026-07-13T00:10:00.000Z", 3);
    assert.deepEqual(
      mergeAssetCandleSnapshot({ ...baseline, interval: "1d" }, snapshot, 100),
      baseline.candles,
    );
  });
});

function fixtureBaseline(): AssetCandlesDto {
  return {
    range: "1d",
    interval: "5m",
    candles: [
      candle("2026-07-13T00:00:00.000Z", "100.00000000"),
      candle("2026-07-13T00:05:00.000Z", "105.00000000"),
    ],
    source: {
      provider: "binance",
      requestedCount: 100,
      returnedCount: 2,
    },
  };
}

function candle(time: string, close: string) {
  return {
    time,
    open: "100.00000000",
    high: "110.00000000",
    low: "90.00000000",
    close,
    volume: "10.00000000",
  };
}

function fixtureSnapshot(
  time: string,
  sequence: number,
): AssetCandleSnapshotMessage {
  return {
    type: "asset_candle",
    assetId: "asset-1",
    interval: "5m",
    candle: {
      ...candle(time, "109.00000000"),
      closeTime: new Date(Date.parse(time) + 300_000).toISOString(),
    },
    revision: sequence,
    sequence,
    provisional: true,
    complete: true,
    delayed: false,
    sourceUpdatedAt: new Date(Date.parse(time) + 60_000).toISOString(),
    final: false,
  };
}
