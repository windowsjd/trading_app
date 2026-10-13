export const guideTopics = {
  StockCharacteristics: {
    number: '04',
    title: '주식특성',
    description:
      '장이 닫혀 있는 동안 쌓인 주문이 개장 순간 어떻게 가격이 되는지 직접 주문하며 이해합니다.',
    chapters: [
      {
        id: 'closed-market',
        title: '장이 닫혀 있는 동안',
        description:
          '휴장 중 낸 지정가 주문이 개장 때 한 가격으로 체결되는 과정을 직접 확인합니다.',
      },
    ],
  },
  CorporateActions: {
    number: '05',
    title: '기업행동과 조정주가',
    description: '분할·배당에 따른 보유 상태와 차트 표시의 변화를 이해합니다.',
    chapters: [
      {
        id: 'splits',
        title: '주식분할과 병합',
        description: '주당가격과 수량이 함께 바뀌는 이론적 조정을 적용합니다.',
      },
      {
        id: 'dividends',
        title: '배당과 배당락',
        description: '배당 권리, 받을 배당금과 실제 지급 현금을 구분합니다.',
      },
      {
        id: 'adjusted',
        title: '조정주가 읽기',
        description: '같은 원본 기록을 분할·배당 반영 여부에 따라 비교합니다.',
      },
    ],
  },
  EtfIndex: {
    number: '06',
    title: 'ETF와 지수',
    description: '지수, 구성자산, 시장가격과 순자산가치의 관계를 이해합니다.',
    chapters: [
      {
        id: 'index',
        title: '지수란 무엇인가',
        description:
          '여러 종목의 움직임이 하나의 기준 숫자가 되는 과정을 봅니다.',
      },
      {
        id: 'etf',
        title: 'ETF란 무엇인가',
        description: '여러 자산을 담은 펀드와 ETF 한 주의 관계를 이해합니다.',
      },
      {
        id: 'following',
        title: 'ETF는 지수를 어떻게 따라가는가',
        description: '같은 구성종목의 변화가 지수와 펀드 가치에 반영됩니다.',
      },
      {
        id: 'nav',
        title: 'ETF 시장가격과 NAV',
        description: 'NAV, 시장가격, 괴리율과 평가 기준시각을 확인합니다.',
      },
      {
        id: 'tracking',
        title: 'ETF를 볼 때 확인해야 할 정보',
        description: '추적차이·추적오차를 구분하고 상품정보를 읽습니다.',
      },
    ],
  },
} as const;
export type GuideTopic = keyof typeof guideTopics;
export const guideChapters = Object.values(guideTopics).flatMap((topic) => [
  ...topic.chapters,
]);
export type GuideChapter = (typeof guideChapters)[number]['id'];
export const chapterTitle = (id: GuideChapter) =>
  guideChapters.find((chapter) => chapter.id === id).title;
