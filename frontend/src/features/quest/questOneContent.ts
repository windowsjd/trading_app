/**
 * QUEST 01 teaching copy. Static text only: no rate, fee or amount appears
 * here, because every real number comes from the server's FX quote on the
 * existing exchange screen. Reading these sections is learning, not practice —
 * only the server-proven FX and transfer steps count toward progress.
 */

export const QUEST_01_CONTENT = {
  category: '공통 기초 — 암호화폐 현물',
  number: 'QUEST 01',
  title: '거래 자금 준비하기',
  summary: '환전과 이체를 배우고 암호화폐 현물 거래를 준비합니다.',
  goal: '각 지갑의 역할과 환전·이체의 차이를 이해하고, 암호화폐 현물 거래에 필요한 USD 자금을 준비해요.',
  wallets: {
    title: '지갑의 역할 이해하기',
    intro: '계정에는 목적이 다른 네 개의 지갑이 있어요. 지갑마다 잔액을 따로 관리하기 때문에, 한 지갑의 돈을 다른 거래에 쓰려면 직접 옮겨야 해요.',
    items: [
      {
        name: '증권 KRW 지갑',
        lines: ['원화 자금을 관리해요.', '한국주식 거래에 사용해요.', '초보계정의 최초 가상자금이 지급되는 곳이에요.'],
      },
      {
        name: '증권 USD 지갑',
        lines: ['달러 자금을 관리해요.', '미국주식 거래에 사용해요.', '원화를 달러로 환전하면 받은 달러가 이 지갑에 보관돼요.'],
      },
      {
        name: '암호화폐 현물 USD 지갑',
        lines: ['암호화폐 현물 거래에 사용하는 달러 자금을 관리해요.'],
      },
      {
        name: '암호화폐 선물 USD 지갑',
        lines: ['암호화폐 선물 거래에 사용하는 별도의 달러 자금을 관리해요.'],
      },
    ],
    point: '같은 USD라도 증권 USD 지갑과 암호화폐 지갑의 잔액은 서로 독립적이에요. 암호화폐 현물을 거래하려면 USD가 암호화폐 현물 USD 지갑에 있어야 해요.',
  },
  fxConcepts: {
    title: '환전과 환전 수수료 이해하기',
    terms: [
      { term: '환전', english: 'Foreign Exchange', meaning: 'KRW를 USD로, 또는 USD를 KRW로 바꾸는 거래예요.' },
      { term: '환율', english: 'Exchange Rate', meaning: '두 통화를 교환하는 비율이에요. 1달러를 바꾸는 데 필요한 원화 금액으로 표시해요.' },
      { term: '환전 수수료', english: 'FX Fee', meaning: '환전할 때 부과되는 비용이에요. 받는 통화로 계산되어 수령액에서 빠져요.' },
      { term: '실제 수령액', english: 'Net Received Amount', meaning: '환율과 수수료를 반영해 실제로 지갑에 들어오는 금액이에요.' },
    ],
    flowTitle: 'KRW를 USD로 환전하는 순서',
    flow: [
      '환전할 KRW 금액을 입력해요.',
      '적용 환율을 확인해요.',
      '환전 수수료를 확인해요.',
      '최종 USD 수령액을 확인해요.',
      '환전을 실행해요.',
    ],
    notes: [
      '환율과 수수료는 이 화면에서 정하지 않아요. 환전 화면에서 서버가 계산한 실제 견적으로 확인해요.',
      '견적은 짧은 시간 동안만 유효해요. 실행할 때 최신 환율로 다시 계산하므로 수령액이 견적과 조금 다를 수 있고, 환율이 크게 움직였다면 견적을 다시 받아야 해요.',
      '최신 환율을 확인할 수 없는 동안에는 환전이 잠시 제한될 수 있어요. 이때는 환전 화면의 안내에 따라 잠시 후 다시 시도해 주세요.',
    ],
  },
  fxPractice: {
    title: '실제 환전하기',
    route: '증권 KRW → 증권 USD',
    body: '환전 화면에서 증권 KRW 지갑의 원화를 증권 USD 지갑의 달러로 바꿔 보세요.',
    condition: '환전이 확정되면 완료돼요. 견적만 확인했거나 실패·취소된 환전은 인정되지 않아요.',
    action: '환전하러 가기',
  },
  transferPractice: {
    title: '실제 이체하기',
    route: '증권 USD → 암호화폐 현물 USD',
    lines: [
      '이체는 통화를 바꾸는 거래가 아니에요.',
      '같은 USD를 목적이 다른 지갑 사이에서 옮기는 거예요.',
      '같은 통화끼리 옮기는 이체에는 환전 수수료가 없어요.',
      '이체는 투자 수익이나 새로운 자금 지급이 아니에요. 계정 전체 자산은 그대로예요.',
    ],
    condition: '환전 후 증권 USD 지갑에서 암호화폐 현물 USD 지갑으로 이체가 확정되면 완료돼요. 다른 방향이나 선물 지갑으로의 이체는 인정되지 않아요.',
    action: '이체하러 가기',
    waitForFx: '환전을 먼저 완료하면 이체 실습을 진행할 수 있어요.',
  },
  returnHint: '환전이나 이체를 마친 뒤 하단의 퀘스트 탭으로 돌아오면 진행 상황이 갱신돼요.',
  completed: '퀘스트 완료! 암호화폐 현물 거래에 사용할 USD를 준비했어요.',
} as const;
