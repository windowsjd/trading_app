import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  TRIGGER_DIRECTION_CHANGED,
  getTriggerDirectionText,
  isTriggerDirectionValid,
  resolveTriggerDirection,
} from './autoDirection.ts';

describe('automatic 이상/이하 of a conditional order', () => {
  it('a watch price above the reference waits for a rise, below waits for a fall', () => {
    assert.deepEqual(resolveTriggerDirection('72000', '70000'), { state: 'ready', condition: 'at_or_above' });
    assert.deepEqual(resolveTriggerDirection('68000', '70000'), { state: 'ready', condition: 'at_or_below' });
  });

  it('equal, missing or unusable prices never get a direction', () => {
    assert.equal(resolveTriggerDirection('70000', '70000').state, 'equal');
    assert.equal(resolveTriggerDirection('70000', '70000.00000000').state, 'equal', 'compared as decimals, not strings');
    assert.equal(resolveTriggerDirection('70000', null).state, 'no_reference');
    assert.equal(resolveTriggerDirection('70000', '0').state, 'no_reference');
    assert.equal(resolveTriggerDirection('70000', 'abc').state, 'no_reference');
    assert.equal(resolveTriggerDirection('', '70000').state, 'empty');
    assert.equal(resolveTriggerDirection('  ', '70000').state, 'empty');
    assert.equal(resolveTriggerDirection('-1', '70000').state, 'invalid');
    assert.equal(resolveTriggerDirection('1.123456789', '1').state, 'invalid', 'more than 8 decimals');
  });

  it('decides on the exact decimal, beyond floating point precision', () => {
    assert.deepEqual(resolveTriggerDirection('0.00000002', '0.00000001'), { state: 'ready', condition: 'at_or_above' });
    assert.deepEqual(
      resolveTriggerDirection('9007199254740993', '9007199254740992'),
      { state: 'ready', condition: 'at_or_above' },
      '2^53 + 1 and 2^53 are the same double',
    );
    assert.deepEqual(
      resolveTriggerDirection('1234567890.12345678', '1234567890.12345679'),
      { state: 'ready', condition: 'at_or_below' },
    );
  });

  it('a decided direction holds only while the watch price stays on its side', () => {
    assert.equal(isTriggerDirectionValid('at_or_above', '72000', '71000'), true);
    assert.equal(isTriggerDirectionValid('at_or_above', '72000', '72000'), false, 'reaching it means already met');
    assert.equal(isTriggerDirectionValid('at_or_above', '72000', '73000'), false);
    assert.equal(isTriggerDirectionValid('at_or_below', '68000', '69000'), true);
    assert.equal(isTriggerDirectionValid('at_or_below', '68000', '68000'), false);
    assert.equal(isTriggerDirectionValid('at_or_below', '68000', null), false, 'no latest price: cannot confirm');
  });

  it('shows the decided condition, or why none can be decided', () => {
    assert.equal(getTriggerDirectionText({ state: 'ready', condition: 'at_or_above' }, ' 72000 ', 'KRW'), '72000 KRW 이상 도달 시');
    assert.equal(getTriggerDirectionText({ state: 'ready', condition: 'at_or_below' }, '68000', 'USD'), '68000 USD 이하 도달 시');
    assert.match(getTriggerDirectionText({ state: 'equal' }, '70000', 'KRW') ?? '', /같은 가격/);
    assert.match(getTriggerDirectionText({ state: 'no_reference' }, '70000', 'KRW') ?? '', /현재가를 확인할 수 없어/);
    assert.match(getTriggerDirectionText({ state: 'no_reference' }, '70000', 'USD', 'Futures Last') ?? '', /Futures Last/);
    assert.equal(getTriggerDirectionText({ state: 'empty' }, '', 'KRW'), null);
    assert.equal(getTriggerDirectionText({ state: 'invalid' }, 'x', 'KRW'), null);
    assert.match(TRIGGER_DIRECTION_CHANGED, /다시 등록/);
  });
});
