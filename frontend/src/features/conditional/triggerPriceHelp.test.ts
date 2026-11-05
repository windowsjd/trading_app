import assert from 'node:assert/strict';
import { it } from 'node:test';
import { TRIGGER_PRICE_HELP } from './triggerPriceHelp.ts';
import { SELL_REFERENCE_LABEL } from './conditionalSellDisplay.ts';

it('the ⓘ copy is the agreed text: 감시가격 on a BUY, 매도 기준가 on a SELL, and no fill caveat', () => {
  assert.deepEqual(TRIGGER_PRICE_HELP.buy, {
    term: '감시가격',
    title: '감시가격이란?',
    paragraphs: [
      '감시가격은 자동으로 매수·매도 주문을 시작하는 기준가격입니다.',
      '시세가 설정한 방향에 따라 감시가격 이상 또는 이하에 도달하면 선택한 방식(시장가·지정가)으로 주문을 접수합니다.',
    ],
  });
  assert.deepEqual(TRIGGER_PRICE_HELP.sell, {
    term: '매도 기준가',
    title: '매도 기준가란?',
    paragraphs: [
      '매도 기준가는 자동으로 매도 주문을 시작하는 기준가격입니다.',
      '시세가 설정한 방향에 따라 매도 기준가 이상 또는 이하에 도달하면 선택한 방식(시장가·지정가)으로 주문을 접수합니다.',
    ],
  });
  // The SELL form's own word for its price.
  assert.equal(TRIGGER_PRICE_HELP.sell.term, SELL_REFERENCE_LABEL);
  for (const help of Object.values(TRIGGER_PRICE_HELP)) {
    const text = [help.title, ...help.paragraphs].join('\n');
    // The caveat the product owner left out, in any wording.
    assert.equal(/보장|체결되지 않을 수|체결가격/u.test(text), false, help.term);
  }
  assert.equal(/감시가격/u.test([TRIGGER_PRICE_HELP.sell.title, ...TRIGGER_PRICE_HELP.sell.paragraphs].join('')), false);
});
