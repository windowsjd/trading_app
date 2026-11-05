/**
 * The ⓘ beside a Spot condition's price field (2026-11-06): what that price
 * is, in the field's own term — 감시가격 on a conditional BUY, 매도 기준가 on a
 * SELL condition. The product owner's final copy: it explains the price only
 * and adds no fill caveat (the notice and the SELL field's hint keep the fill
 * rules). Pure: runs under `node --test`.
 */
export type TriggerPriceHelp = { term: string; title: string; paragraphs: readonly string[] };

export const TRIGGER_PRICE_HELP: Record<'buy' | 'sell', TriggerPriceHelp> = {
  buy: {
    term: '감시가격',
    title: '감시가격이란?',
    paragraphs: [
      '감시가격은 자동으로 매수·매도 주문을 시작하는 기준가격입니다.',
      '시세가 설정한 방향에 따라 감시가격 이상 또는 이하에 도달하면 선택한 방식(시장가·지정가)으로 주문을 접수합니다.',
    ],
  },
  sell: {
    term: '매도 기준가',
    title: '매도 기준가란?',
    paragraphs: [
      '매도 기준가는 자동으로 매도 주문을 시작하는 기준가격입니다.',
      '시세가 설정한 방향에 따라 매도 기준가 이상 또는 이하에 도달하면 선택한 방식(시장가·지정가)으로 주문을 접수합니다.',
    ],
  },
};
