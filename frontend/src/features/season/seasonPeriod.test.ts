import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getSeasonPeriod } from './seasonPeriod.ts';

// The server's season instants as the account list carries them.
const NEW_SEASON0 = { startAt: '2026-11-14T11:00:00.000Z', endAt: '2026-11-29T15:00:00.000Z' };
const OLD_SEASON0 = { startAt: '2026-10-24T00:00:00.000Z', endAt: '2026-11-14T00:00:00.000Z' };

describe('season period under the season name (Asia/Seoul, exclusive end)', () => {
  it('the new season0 reads 2026.11.14 ~ 2026.11.29 — its 11-30 00:00 KST end is never shown as 11.30', () => {
    assert.deepEqual(getSeasonPeriod(NEW_SEASON0), {
      text: '2026.11.14 ~ 2026.11.29',
      spoken: '2026년 11월 14일부터 2026년 11월 29일까지',
    });
  });

  it('the settled first season0 keeps its own period (it traded until 11-14 08:59:59 KST)', () => {
    assert.equal(getSeasonPeriod(OLD_SEASON0)?.text, '2026.10.24 ~ 2026.11.14');
  });

  it('days are Korean calendar days around the UTC date line', () => {
    // 2026-11-13T15:00Z is 11-14 00:00 KST; one millisecond earlier is still 11-13.
    assert.equal(getSeasonPeriod({ startAt: '2026-11-13T15:00:00.000Z', endAt: '2026-11-29T15:00:00.000Z' })?.text,
      '2026.11.14 ~ 2026.11.29');
    assert.equal(getSeasonPeriod({ startAt: '2026-11-13T14:59:59.999Z', endAt: '2026-11-29T15:00:00.000Z' })?.text,
      '2026.11.13 ~ 2026.11.29');
    // An end one millisecond after KST midnight keeps that day as the last operating day.
    assert.equal(getSeasonPeriod({ startAt: '2026-11-14T11:00:00.000Z', endAt: '2026-11-29T15:00:00.001Z' })?.text,
      '2026.11.14 ~ 2026.11.30');
    // Offsets are honoured exactly as the instant they name.
    assert.equal(getSeasonPeriod({ startAt: '2026-11-14T20:00:00+09:00', endAt: '2026-11-30T00:00:00+09:00' })?.text,
      '2026.11.14 ~ 2026.11.29');
  });

  it('does not depend on the device time zone (the shared fixed-KST formatter decides)', () => {
    const before = process.env.TZ;
    try {
      for (const zone of ['UTC', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Asia/Seoul']) {
        process.env.TZ = zone;
        assert.equal(getSeasonPeriod(NEW_SEASON0)?.text, '2026.11.14 ~ 2026.11.29', zone);
      }
    } finally {
      if (before === undefined) delete process.env.TZ;
      else process.env.TZ = before;
    }
  });

  it('never invents a date: missing, zone-less, unreadable or reversed instants show nothing', () => {
    for (const season of [
      null, undefined, {}, { startAt: NEW_SEASON0.startAt }, { endAt: NEW_SEASON0.endAt },
      { startAt: '2026-11-14', endAt: '2026-11-29' },
      { startAt: '2026-11-14T11:00:00', endAt: '2026-11-29T15:00:00' },
      { startAt: 'not-a-date', endAt: NEW_SEASON0.endAt },
      { startAt: NEW_SEASON0.endAt, endAt: NEW_SEASON0.startAt },
      { startAt: NEW_SEASON0.startAt, endAt: NEW_SEASON0.startAt },
    ]) assert.equal(getSeasonPeriod(season as never), null, JSON.stringify(season));
  });
});
