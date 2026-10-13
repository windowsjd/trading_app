export const guideTopics = {
  StockCharacteristics: {
    number: '04',
    title: '주식특성',
    description:
      '밤사이 가상으로 주문을 준비하며 개장 시가와 지정가 주문의 체결 여부를 이해합니다.',
    chapters: [
      {
        id: 'closed-market',
        title: '장이 닫혀 있는 동안',
        description:
          '개장 때 시가가 어떻게 결정되고, 내 지정가 주문의 체결 여부가 어떻게 정해지는지 확인합니다.',
      },
    ],
  },
  EtfIndex: {
    number: '05',
    title: 'ETF와 지수',
    description:
      '지수와 ETF의 관계, 분산의 효과와 한계, ETF 가격을 읽고 고르는 기준을 이해합니다.',
    chapters: [
      {
        id: 'index',
        title: '지수는 시장의 온도계',
        description:
          '종목별 움직임이 비중에 따라 하나의 기준 숫자가 되는 과정을 봅니다.',
      },
      {
        id: 'etf',
        title: 'ETF는 한 번에 담는 바구니',
        description:
          '여러 자산을 한 번에 담는 펀드 지분과, 분산이 줄여 주는 것과 못 줄이는 것을 확인합니다.',
      },
      {
        id: 'etf-price',
        title: 'ETF 가격은 바구니 값을 따라간다',
        description: 'NAV와 시장가격의 관계, 괴리율을 계산으로 확인합니다.',
      },
      {
        id: 'etf-pick',
        title: 'ETF를 고를 때 보는 세 가지',
        description: '구성·추종·비용 세 가지를 가상 ETF 두 개로 비교합니다.',
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
