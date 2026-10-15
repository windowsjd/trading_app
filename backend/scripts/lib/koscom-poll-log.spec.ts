import { parseKoscomPollLine, toKoscomPollCsv } from './koscom-poll-log';

const ok =
  '[Nest] 1  - 10/15/2026 LOG [KoscomIngestionService] {"event":"koscom_poll","slot":1,"market":"kospi","batch":0,"requestedAt":"2026-10-15T01:00:00.000Z","receivedAt":"2026-10-15T01:00:00.400Z","ok":true,"errorCode":null,"quotes":[["005930",1792026000.25],["000660",null]]}';
const failed =
  '{"event":"koscom_poll","slot":2,"market":"kospi","batch":0,"requestedAt":"2026-10-15T01:00:03.000Z","receivedAt":null,"ok":false,"errorCode":"KOSCOM_TIMEOUT","quotes":[["005930",null]]}';

describe('KOSCOM poll log → er_replay.py --polls CSV', () => {
  it('keeps every quoted symbol, empty effective time for failed or unusable polls', () => {
    expect(
      toKoscomPollCsv([ok, failed, 'unrelated line', '{"event":"x"}']),
    ).toBe(
      [
        'symbol,received_s,effective_s',
        '005930,1792026000.400,1792026000.250',
        '000660,1792026000.400,',
        '005930,1792026003.000,',
        '',
      ].join('\n'),
    );
  });

  it('ignores malformed lines instead of inventing a poll', () => {
    expect(parseKoscomPollLine('{"event":"koscom_poll", broken').length).toBe(
      0,
    );
    expect(
      parseKoscomPollLine('{"event":"koscom_poll","quotes":[["005930",1]]}')
        .length,
    ).toBe(0);
  });
});
