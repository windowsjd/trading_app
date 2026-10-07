import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ERROR_CODE } from '../../models/enums/errorCode.ts';
import {
  getApiErrorCode, getApiErrorDisplayMessage, getApiErrorInfo,
  getErrorMessageFromCode, isRequoteRequiredError,
} from './errorMapper.ts';

const raw = 'JWT_ACCESS_SECRET DB_SERVICE HTTP 599 req-private failureStage=wallet_write https://provider.invalid/private exact balance 194873.928374';

describe('public error presentation', () => {
  it('never copies unknown code, server message or client exception text', () => {
    for (const error of [
      new Error(raw), { code: raw, message: raw },
      { response: { status: 599, data: { error: { code: raw, message: raw } } } },
      { response: { status: 418, data: { error: { code: raw, message: raw } } } },
      { response: { status: 400, data: { error: { message: raw } } } },
      { isAxiosError: true, request: {}, code: 'ERR_NETWORK', message: raw },
      { request: {}, code: 'ECONNABORTED', message: raw },
    ]) {
      const message = getApiErrorDisplayMessage(error);
      assert.doesNotMatch(message, /JWT|SECRET|DB_SERVICE|HTTP|599|418|req-private|failureStage|provider.invalid|194873|백엔드|환경변수|콘솔|로그를/);
      assert.match(message, /다시|확인/);
    }
  });

  it('uses safe fixed copy for every known code', () => {
    for (const code of Object.values(ERROR_CODE)) {
      assert.doesNotMatch(getErrorMessageFromCode(code), /HTTP|백엔드|환경변수|콘솔|로그를|API 주소/);
      const display = getApiErrorDisplayMessage({ response: { status: 500, data: { error: { code, message: raw } } } });
      const mapped = getErrorMessageFromCode(code, { fallbackToGeneric: false });
      if (mapped) assert.equal(display, mapped);
      else assert.match(display, /잠시 후 다시 시도/);
    }
  });

  it('keeps actionable domain guidance and unchanged control-flow information', () => {
    for (const [code, expected] of [
      ['INVALID_CREDENTIALS', /이메일 또는 비밀번호/],
      ['NICKNAME_ALREADY_EXISTS', /이미 사용 중인 닉네임/],
      ['INVALID_AMOUNT', /매수 금액/],
      ['INSUFFICIENT_BALANCE', /잔액이 부족/],
      ['INSUFFICIENT_QUANTITY', /보유 수량이 부족/],
      ['MARKET_CLOSED', /지정가를 직접 선택/],
    ] as const) assert.match(getErrorMessageFromCode(code), expected);
    const error = { response: { status: 409, data: { error: { code: 'QUOTE_EXPIRED', message: raw } } }, code: 'ERR_BAD_REQUEST' };
    assert.equal(getApiErrorCode(error), 'QUOTE_EXPIRED');
    assert.equal(isRequoteRequiredError(getApiErrorCode(error)), true);
    assert.equal(getApiErrorInfo(error).status, 409);
    assert.equal(getApiErrorInfo(error).serverMessage, raw);
    assert.equal(getApiErrorInfo(error).clientCode, 'ERR_BAD_REQUEST');
  });
});
