export const guideTopics = {
  StockCharacteristics: {
    number: '04',
    title: '주식특성',
    description:
      '한국과 미국의 거래시간을 비교하며 캔들과 차트의 차이를 이해합니다.',
    chapters: [
      {
        id: 'sessions',
        title: '한국시장과 미국시장의 거래시간',
        description:
          '같은 구조의 시간축에서 거래시간과 캔들 생성 구간을 비교합니다.',
      },
      {
        id: 'auctions',
        title: '개장·마감과 시간대별 거래',
        description:
          '주문 수집에서 시가·종가와 캔들이 만들어지는 과정을 비교합니다.',
      },
      {
        id: 'gaps',
        title: '한국주식과 미국주식 차트의 특징',
        description:
          '거래 공백, 캔들 방향과 전일 대비 등락, 차트의 포함 범위를 비교합니다.',
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
