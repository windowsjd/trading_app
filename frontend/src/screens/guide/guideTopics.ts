export const guideTopics = {
  StockCharacteristics: {
    number: '04',
    title: '주식특성',
    description:
      '거래시간과 시장 제도가 체결과 차트에 미치는 영향을 이해합니다.',
    chapters: [
      {
        id: 'sessions',
        title: '거래시간과 휴장',
        description:
          '시장·거래 구간·날짜를 바꾸며 주문 접수와 체결 시간을 구분합니다.',
      },
      {
        id: 'auctions',
        title: '개장·마감과 시간대별 거래',
        description:
          '단일가 결정, 종가와 장후 가격, 지정가의 체결 범위를 확인합니다.',
      },
      {
        id: 'gaps',
        title: '주식 차트의 갭과 표시 기준',
        description:
          '거래 공백, 캔들 방향과 전일 대비 등락, 차트의 포함 범위를 비교합니다.',
      },
      {
        id: 'safeguards',
        title: '거래정지와 가격제한',
        description:
          '거래정지·VI·가격제한이 주문과 체결에 미치는 영향을 구분합니다.',
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
        title: '지수와 ETF의 구조',
        description:
          '종목별 비중과 가격 변화에서 지수와 ETF의 가치를 계산합니다.',
      },
      {
        id: 'nav',
        title: '시장가격과 순자산가치',
        description: 'NAV, 시장가격, 괴리율과 평가 기준시각을 확인합니다.',
      },
      {
        id: 'tracking',
        title: '지수 추종과 상품정보',
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
