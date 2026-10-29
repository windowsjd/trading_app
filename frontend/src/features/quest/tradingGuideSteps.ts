import type { BeginnerQuestKey } from './questProgress';
import type { TradeGuideScreen, QuestGuideTargetId } from './questGuideBridge';
export type TradingQuestKey = Exclude<BeginnerQuestKey, 'exchange' | 'transfer'>;
export type TradingGuideStep = { screen: TradeGuideScreen; target: QuestGuideTargetId; title: string; body: string; next?: boolean };
const market: TradingGuideStep = { screen: 'market', target: 'market-assets', title: '종목 선택', body: '목록에서 현재 거래 가능한 종목을 선택해 주세요. 시세와 차트는 언제든 확인할 수 있어요.' };
const price: TradingGuideStep = { screen: 'asset', target: 'asset-price', title: '현재가', body: '암호화폐의 현재 가격은 여기에 표시돼요.', next: true };
const buy: TradingGuideStep = { screen: 'asset', target: 'asset-buy', title: '매수하기', body: '매수하기를 눌러 실제 주문 화면으로 이동해 주세요.' };
const marketType: TradingGuideStep = { screen: 'order', target: 'order-type', title: '시장가 주문', body: '시장가 주문은 가격을 직접 지정하지 않고, 주문이 체결되는 시점에 시장에서 거래 가능한 가격으로 매수하는 방식이에요.', next: true };
const amount: TradingGuideStep = { screen: 'order', target: 'order-input', title: '금액과 수량', body: '사용 가능한 잔액 안에서 실습할 금액이나 수량을 입력해 주세요. 수수료도 필요해요.', next: true };
const preview: TradingGuideStep = { screen: 'order', target: 'order-preview', title: '금액과 수수료 확인', body: '예상 금액과 거래 수수료를 확인해 주세요. 시장가의 최종 가격과 수수료는 실행 시 확정돼요.', next: true };
const submit: TradingGuideStep = { screen: 'order', target: 'order-submit', title: '주문 실행', body: '화면의 주문 버튼으로 실행해 주세요. 실패하거나 시세를 확인할 수 없으면 화면 안내에 따라 다시 확인해 주세요.' };
// Holdings (and their TP/SL and limit review) live under the order screen only.
const holdings: TradingGuideStep = { screen: 'order', target: 'asset-holdings', title: '보유종목과 수익률', body: '주문 화면 아래 보유종목에서 보유수량과 수익률을 확인해 주세요. 수익률은 가격과 수수료에 따라 음수일 수도 있어요. 표시를 확인한 뒤 다음을 눌러 주세요.', next: true };
// Stocks show the holding as 내 보유 in the order card's right column (A-2).
const stockHoldings: TradingGuideStep = { ...holdings, body: '주문 카드의 내 보유에서 보유수량과 수익률을 확인해 주세요. 수익률은 가격과 수수료에 따라 음수일 수도 있어요. 표시를 확인한 뒤 다음을 눌러 주세요.' };
const stock = (us: boolean): TradingGuideStep[] => [market, { ...price, body: us
  ? '미국 주식은 미국 시장 운영시간에 증권 USD 지갑으로 거래해요. 환율도 원화 기준 자산 평가에 영향을 줘요. 휴장 또는 시세 미준비 시 다른 심화 퀘스트를 진행할 수 있어요.'
  : '국내 주식은 한국 시장 운영시간에 KRW로 거래해요. 휴장 중에는 다른 심화 퀘스트를 진행할 수 있어요.' }, buy, marketType, amount, preview, submit, stockHoldings];
const futures = (short: boolean): TradingGuideStep[] => [
  { screen: 'futures', target: 'futures-funding', title: '선물 지갑 준비', body: '주문가능 USD에서 선물 지갑으로 주문할 수 있는 금액을 확인해 주세요. 부족하면 지갑 탭에서 USD를 이체한 뒤 마켓 탭의 선물 화면으로 돌아와 진행해 주세요.', next: true },
  { screen: 'futures', target: 'futures-instrument', title: '선물 종목', body: '거래 가능한 선물 상품을 선택해 주세요. 같은 종목은 One-way 방식이에요. 반대 포지션이 열려 있다면 먼저 종료해야 해요.', next: true },
  { screen: 'futures', target: 'futures-direction', title: short ? 'Short · 숏' : 'Long · 롱', body: short ? '숏은 가격이 하락하면 이익, 상승하면 손실이 발생해요. Short를 선택해 주세요.' : '롱은 가격이 상승하면 이익, 하락하면 손실이 발생해요. Long을 선택해 주세요.', next: true },
  { screen: 'futures', target: 'futures-margin', title: '레버리지와 격리마진', body: '낮은 레버리지(예: 2배)와 Isolated 격리마진을 권장해요. 적은 증거금으로 큰 포지션을 만들 수 있지만 손실과 청산 위험도 커져요.', next: true },
  { screen: 'futures', target: 'futures-submit', title: '포지션 진입', body: '수량·증거금·수수료를 확인한 뒤 진입해 주세요. 이 실습은 1배보다 높은 레버리지로 진입해야 해요.' },
  { screen: 'futures', target: 'futures-position', title: '손익과 청산가격', body: '같은 포지션의 미실현손익과 청산가격을 확인해 주세요. 포지션 카드의 포지션 종료를 누르고, 열린 화면에서 100%로 포지션 종료를 실행해 주세요. 강제청산은 종료 실습에 포함되지 않아요.' },
];
export const TRADING_GUIDE_STEPS: Record<TradingQuestKey, TradingGuideStep[]> = {
  marketBuy: [market, price, buy, marketType, amount, preview, submit, holdings],
  // Spot 손절가/익절가 is set from the practiced holding's card (under the
  // order form), in its bottom sheet — not a 주문방식 (2026-10-16).
  protection: [
    { screen: 'order', target: 'asset-protection', title: '손절가/익절가 설정', body: '아래 보유종목 카드에서 손절가/익절가 설정을 눌러 주세요. 보유한 현물을 정한 가격에서 자동으로 매도하도록 예약하는 방법이에요.' },
    { screen: 'order', target: 'protection-editor', title: '익절가와 손절가', body: '익절가는 이익을 실현할 목표가격, 손절가는 손실을 줄이려는 가격이에요. 둘 중 하나 이상을 선택하고 가격과 매도 수량 비율을 정해 주세요. 가격에 도달하면 정한 수량을 시장가로 매도해요.', next: true },
    { screen: 'order', target: 'protection-submit', title: '등록하기', body: '가격과 수량을 확인한 뒤 등록하기를 눌러 주세요. 등록이 확정되면 완료되며 발동까지 기다리지 않아요.' },
  ],
  marketSell: [
    { screen: 'asset', target: 'asset-sell', title: '매도하기', body: '매도하기를 눌러 매도 화면으로 이동해 주세요.' },
    { ...holdings, body: '주문 화면 아래 보유종목에서 매도 가능한 수량을 확인해 주세요. 수량이 없으면 정상 시장가 매수로 다시 준비할 수 있어요. 보호 주문과 충돌하면 기존 보호를 취소한 뒤 진행해 주세요.' },
    { ...marketType, body: '시장가로 매도해요. 보유 위험을 줄이는 매도는 학습 진행도와 관계없이 사용할 수 있어요.' }, amount,
    { ...preview, body: '미실현손익은 아직 보유한 자산의 평가 변화예요. 매도가 체결되면 실현손익이 확정돼요. 매도 수수료와 예상 수령액도 확인해 주세요.' }, submit,
  ],
  limitBuy: [market, price, buy,
    { ...marketType, title: '지정가 주문', body: '지정가는 원하는 가격을 지정하는 주문이에요. 접수만으로 체결되지는 않아요.' },
    { ...amount, body: '원하는 지정가격과 매수 금액을 입력해 주세요. 주문에는 수수료를 포함한 예약금이 필요해요.' },
    { ...preview, body: '미체결 주문의 예약금은 다른 거래에 사용할 수 없어요. 취소하면 예약이 해제되고, 체결되면 실제 매수가 이루어져요.' }, submit,
    { screen: 'order', target: 'limit-review', title: '주문 상태와 예약금', body: '등록한 주문의 상태를 확인해 주세요. 미체결이면 주문 취소를 실습해 주세요. 이미 체결되었다면 취소할 필요 없이 결과를 확인하면 돼요.', next: true },
  ],
  krStock: stock(false), usStock: stock(true), futuresLong: futures(false), futuresShort: futures(true),
};
export function isTradingQuest(key: BeginnerQuestKey): key is TradingQuestKey { return key !== 'exchange' && key !== 'transfer'; }
