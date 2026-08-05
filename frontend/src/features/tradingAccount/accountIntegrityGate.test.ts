import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  findAccountIntegrityFailure,
  getAccountIntegrityMessage,
} from './accountIntegrityGate.ts';

function apiError(status: number, code?: string) {
  return {
    isAxiosError: true,
    response: {
      status,
      data: code ? { error: { code, message: 'server message' } } : {},
    },
  };
}

/** A dropped connection: no envelope, no code. The transient case. */
const networkError = { isAxiosError: true, message: 'Network Error' };

const ok = (section: string) => ({ section, isError: false });

describe('secondary account query integrity gate', () => {
  it('returns null when nothing failed', () => {
    assert.equal(
      findAccountIntegrityFailure([ok('지갑'), ok('보유 종목'), ok('순위')]),
      null,
    );
  });

  it('keeps a transient network failure OUT of the fail-closed state', () => {
    // A timeout must still render the existing section-level notice, not a
    // whole-screen error that tells the user their data may be damaged.
    assert.equal(
      findAccountIntegrityFailure([
        { section: '지갑', isError: true, error: networkError },
        { section: '보유 종목', isError: true, error: apiError(503) },
      ]),
      null,
    );
  });

  it('fails closed when a SECONDARY query reports a scope mismatch', () => {
    const failure = findAccountIntegrityFailure([
      ok('총 자산'),
      {
        section: '지갑',
        isError: true,
        error: apiError(500, 'TRADING_ACCOUNT_SCOPE_MISMATCH'),
      },
    ]);

    assert.ok(failure);
    assert.deepEqual(failure!.sections, ['지갑']);
  });

  it('never lets a wallet integrity fault read as a zero balance', () => {
    const failure = findAccountIntegrityFailure([
      {
        section: '지갑',
        isError: true,
        error: apiError(500, 'FINANCIAL_TRADING_ACCOUNT_SCOPE_MISMATCH'),
      },
    ]);

    assert.ok(failure);
    assert.match(failure!.message, /0이라는 뜻이 아닙니다/);
    assert.ok(!/잔액이 없습니다/.test(failure!.message));
  });

  it('never lets a position integrity fault read as "보유 종목이 없습니다"', () => {
    const failure = findAccountIntegrityFailure([
      {
        section: '보유 종목',
        isError: true,
        error: apiError(500, 'TRADING_SCOPE_REPAIR_REQUIRED'),
      },
    ]);

    assert.ok(failure);
    assert.ok(!/없습니다\.$/.test(failure!.message));
    assert.match(failure!.message, /고객센터/);
  });

  it('never lets a ranking integrity fault render as "-"', () => {
    const failure = findAccountIntegrityFailure([
      {
        section: '순위',
        isError: true,
        error: apiError(500, 'SEASON_RANKING_SCOPE_MISMATCH'),
      },
    ]);

    assert.ok(failure);
    // The caller renders this state INSTEAD of the rank row, so there is no
    // "-" to be mistaken for "you are unranked".
    assert.match(failure!.message, /순위/);
    assert.match(failure!.message, /안전하게 조회를 중단했습니다/);
  });

  it('fails closed when only ONE of several queries is structural', () => {
    const failure = findAccountIntegrityFailure([
      ok('총 자산'),
      { section: '지갑', isError: true, error: networkError },
      {
        section: '자산 추이',
        isError: true,
        error: apiError(500, 'SETTLEMENT_SNAPSHOT_SCOPE_MISMATCH'),
      },
      {
        section: '보유 종목',
        isError: true,
        error: apiError(500, 'GENERAL_PERFORMANCE_INTEGRITY'),
      },
    ]);

    assert.ok(failure);
    // The transient wallet failure is not named — only the structural ones.
    assert.deepEqual(failure!.sections, ['자산 추이', '보유 종목']);
  });

  it('names every structurally failed section, without duplicates', () => {
    const failure = findAccountIntegrityFailure([
      {
        section: '지갑',
        isError: true,
        error: apiError(500, 'TRADING_ACCOUNT_INTEGRITY'),
      },
      {
        section: '지갑',
        isError: true,
        error: apiError(500, 'TRADING_ACCOUNT_LINK_INTEGRITY'),
      },
      {
        section: '보유 종목',
        isError: true,
        error: apiError(500, 'TRADING_ACCOUNT_SCOPE_MISMATCH'),
      },
    ]);

    assert.ok(failure);
    assert.deepEqual(failure!.sections, ['지갑', '보유 종목']);
  });

  it('retries exactly the queries that failed structurally', () => {
    const retried: string[] = [];
    const failure = findAccountIntegrityFailure([
      {
        section: '총 자산',
        isError: false,
        retry: () => retried.push('총 자산'),
      },
      {
        section: '지갑',
        isError: true,
        error: networkError,
        retry: () => retried.push('지갑'),
      },
      {
        section: '보유 종목',
        isError: true,
        error: apiError(500, 'TRADING_ACCOUNT_SCOPE_MISMATCH'),
        retry: () => retried.push('보유 종목'),
      },
    ]);

    assert.ok(failure);
    failure!.retry();

    // Not the healthy query (nothing to fix) and not the transient one (it is
    // still showing its own notice with its own retry).
    assert.deepEqual(retried, ['보유 종목']);
  });

  it('tolerates a signal with no retry callback', () => {
    const failure = findAccountIntegrityFailure([
      {
        section: '순위',
        isError: true,
        error: apiError(500, 'FINAL_RESULTS_INTEGRITY'),
      },
    ]);

    assert.ok(failure);
    assert.doesNotThrow(() => failure!.retry());
  });

  it('falls back to a generic subject when no section is named', () => {
    assert.match(getAccountIntegrityMessage([]), /계정 데이터에 문제가/);
  });
});
