/**
 * Beginner quest copy. Static text only: no rate, fee or amount appears here,
 * because every real number comes from the existing Wallet screens and the
 * server's quotes. Reading or following a spotlight step is learning, not
 * practice — only the server-proven FX and transfer complete a quest.
 */

export const QUEST_CATEGORY = '공통 기초 — 암호화폐 현물';

export const QUEST_CARDS = {
  exchange: {
    number: 'QUEST 01',
    title: '환전하기',
    summary: '원화(KRW)를 달러(USD)로 직접 바꿔 보며 환율과 수수료를 배워요.',
    topics: ['KRW와 USD', '환율', '환전 수수료', '실제 수령액', '증권 KRW·USD 지갑'],
    condition: '증권 KRW → 증권 USD 환전이 확정되면 완료돼요.',
    completed: '환전하기 퀘스트 완료!',
    result: '환전',
  },
  transfer: {
    number: 'QUEST 02',
    title: '이체하기',
    summary: '증권 USD를 암호화폐 현물 USD 지갑으로 옮겨 보며 지갑의 역할을 배워요.',
    topics: ['지갑의 역할', '환전과 이체의 차이', '같은 통화 이동', '증권·현물 USD 지갑', '잔액 변화'],
    condition: '증권 USD → 암호화폐 현물 USD 이체가 확정되면 완료돼요.',
    waiting: '환전하기 퀘스트를 완료하면 시작할 수 있어요.',
    completed: '이체하기 퀘스트 완료!',
    result: '이체',
  },
} as const;

/** One spotlight step: what the highlighted control is, in a sentence or two. */
export const QUEST_GUIDE_COPY = {
  exchange: {
    entry: {
      title: '환전하기',
      body: '환전하기에서는 KRW와 USD 환전을 할 수 있어요.',
      hint: '강조된 환전하기 버튼을 눌러 주세요.',
    },
    direction: {
      title: '환전 방향',
      body: 'KRW → USD가 선택되어 있어요. 원화(KRW)를 내고 달러(USD)를 받는 환전이에요.',
      wrong: '이 퀘스트는 KRW → USD 환전이에요. KRW → USD를 선택해 주세요.',
    },
    amount: {
      title: '환전 금액',
      body: '바꿀 원화 금액을 입력해 주세요. 입력한 KRW는 증권 KRW 지갑에서 빠져나가요.',
      hint: '금액을 입력하면 다음으로 넘어갈 수 있어요.',
    },
    quote: {
      title: '환율과 예상 견적',
      body: '환율은 1달러를 사는 데 필요한 원화예요. 입력한 금액에 지금 환율을 적용한 예상 견적이에요.',
    },
    fee: {
      title: '수수료와 예상 수령액',
      body: '환전 수수료는 받는 USD에서 빠져요. 수수료를 뺀 금액이 실제로 받는 예상 수령액이에요.',
    },
    submit: {
      title: '환전 확정',
      body: '환전하기를 누르면 환전이 확정돼요. 받는 금액은 실행할 때의 환율로 최종 확정돼요.',
      pending: '환전을 처리하고 있어요.',
      failed: '환전하지 못했어요. 화면의 안내를 확인한 뒤 다시 시도해 주세요.',
      unavailable: '지금은 환전하기를 누를 수 없어요. 금액과 환율을 확인해 주세요.',
    },
    rateLoading: { title: '환율 확인 중', body: '현재 환율을 불러오고 있어요.' },
    rateUnavailable: {
      title: '환율 확인 필요',
      body: '지금은 환율을 확인할 수 없어 환전이 잠시 멈췄어요. 환율 다시 불러오기를 눌러 주세요.',
    },
    previewUnavailable: {
      title: '예상 견적 준비 중',
      body: '예상 견적을 아직 표시할 수 없어요. 화면의 안내를 확인해 주세요.',
    },
    blocked: { title: '환전 제한', body: '지금은 이 계정에서 환전할 수 없어요. 화면의 안내를 확인해 주세요.' },
  },
  transfer: {
    entry: {
      title: '이체하기',
      body: '이체하기에서는 같은 통화를 내 지갑 사이에서 옮길 수 있어요.',
      hint: '강조된 이체하기 버튼을 눌러 주세요.',
    },
    source: {
      title: '보내는 지갑',
      body: '보내는 지갑은 증권 USD예요. 환전으로 받은 달러가 이 지갑에 있어요.',
      wrong: '보내는 지갑을 증권 USD로 선택해 주세요.',
    },
    destination: {
      title: '받는 지갑',
      body: '받는 지갑은 암호화폐 현물 USD예요. 같은 USD라도 지갑마다 잔액을 따로 관리해요.',
      wrong: '받는 지갑을 암호화폐 현물 USD로 선택해 주세요. 선물 지갑으로 옮기는 이체는 이 퀘스트에 포함되지 않아요.',
    },
    amount: {
      title: '이체 금액',
      body: '옮길 USD 금액을 입력해 주세요. 이체는 통화를 바꾸지 않아서 환전 수수료가 없어요.',
      hint: '이체 가능 금액 안에서 입력하면 다음으로 넘어갈 수 있어요.',
      empty: '증권 USD 지갑에 옮길 달러가 없어요. 먼저 환전으로 USD를 준비해 주세요.',
    },
    review: {
      title: '이체 내용 확인',
      body: '이체하면 증권 USD는 입력한 만큼 줄고, 암호화폐 현물 USD는 같은 금액만큼 늘어요. 계정 전체 자산은 그대로예요.',
    },
    submit: {
      title: '이체 확정',
      body: '이체하기를 누르면 이체가 확정돼요.',
      pending: '이체를 처리하고 있어요.',
      failed: '이체하지 못했어요. 화면의 안내를 확인한 뒤 다시 시도해 주세요.',
      unavailable: '지금은 이체하기를 누를 수 없어요. 지갑과 금액을 확인해 주세요.',
    },
    otherRoute: {
      title: '다른 경로의 이체',
      body: '이 퀘스트는 증권 USD → 암호화폐 현물 USD 이체로 완료돼요. 다른 이체하기를 눌러 다시 시도해 주세요.',
    },
    blocked: { title: '이체 제한', body: '지금은 이 계정에서 이체할 수 없어요. 화면의 안내를 확인해 주세요.' },
  },
  wallet: {
    unavailable: { title: '지갑 확인 필요', body: '지갑 정보를 확인할 수 없어 안내를 진행할 수 없어요. 화면의 다시 시도를 눌러 주세요.' },
    disabled: { title: '지갑 이용 제한', body: '지금은 이 계정에서 환전과 이체를 할 수 없어요.' },
  },
  waiting: { title: '화면 준비 중', body: '화면을 준비하고 있어요. 계속 진행되지 않으면 화면의 안내를 확인해 주세요.' },
  verifying: { title: '완료 확인 중', body: '서버 기록으로 퀘스트 완료를 확인하고 있어요.' },
  unconfirmed: {
    title: '완료를 아직 확인하지 못했어요',
    body: '처리된 거래는 그대로예요. 퀘스트 완료는 서버 기록으로만 확인하므로 다시 확인해 주세요.',
  },
  completedElsewhere: { title: '이미 완료된 퀘스트예요', body: '이 퀘스트는 이미 완료되었어요. 퀘스트 목록에서 확인해 주세요.' },
  celebrationNote: '퀘스트 목록으로 이동할게요.',
  actions: { next: '다음', exit: '안내 종료', retry: '다시 확인', back: '퀘스트로 돌아가기' },
} as const;
