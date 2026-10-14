import { NOTICE_IDS } from '../../constants/noticeIds.ts';

/**
 * In-app notices (전체 > 공지사항). There is no notice API: these are reviewed
 * product copy shipped with the app, newest first. Other screens link to a
 * notice by its id, never by its title or position.
 */
export type NoticeSection = { heading: string; paragraphs: readonly string[] };
export type Notice = {
  id: string;
  title: string;
  /** Publication date (KST, YYYY-MM-DD). */
  publishedOn: string;
  sections: readonly NoticeSection[];
};

export const notices: readonly Notice[] = [
  {
    id: NOTICE_IDS.returnRateCalculation,
    title: '일반모드·초보모드 수익률 계산 방식 안내',
    publishedOn: '2026-10-14',
    sections: [
      {
        heading: '수익률은 누적 투자원금을 기준으로 계산합니다',
        paragraphs: [
          '일반모드와 초보모드의 수익률은 지금까지 계정에 들어온 누적 투자원금 대비 투자 손익의 비율입니다.',
          '수익률(%) = (총자산 − 누적 투자원금) ÷ 누적 투자원금 × 100',
          '투자 손익은 총자산에서 누적 투자원금을 뺀 금액입니다.',
        ],
      },
      {
        heading: '누적 투자원금에 포함되는 금액',
        paragraphs: [
          '· 계정을 열 때 받은 최초 지급금',
          '· 실제로 지급이 완료된 광고 보상금 등 외부 가상자금',
          '매수·매도 대금, 매도 후 돌려받은 현금, 원화·달러 환전, 지갑 간 이동, 실현·평가 손익은 누적 투자원금이 아닙니다. 지급되지 않았거나 실패·거절된 보상도 포함하지 않습니다.',
        ],
      },
      {
        heading: '광고 보상금은 투자 수익이 아닙니다',
        paragraphs: [
          '광고 보상금을 받으면 총자산과 누적 투자원금이 같은 금액만큼 늘어납니다. 그래서 투자 손익은 그대로입니다.',
          '다만 수익률의 기준이 되는 누적 투자원금이 커지므로, 투자 손익이 같아도 수익률은 달라질 수 있습니다. 투자 손익이 0원이면 보상을 받아도 수익률은 0%입니다.',
          '지난 날짜의 수익률은 그 시점까지의 누적 투자원금으로 계산하며, 나중에 받은 보상금을 과거 수익률에 소급하지 않습니다.',
        ],
      },
      {
        heading: '예시로 알아보기',
        paragraphs: [
          '· 최초 지급금 1,000만 원으로 시작해 총자산이 1,200만 원이 되면 투자 손익은 +200만 원, 수익률은 +20%입니다.',
          '· 이 상태에서 광고 보상 200만 원을 받으면 총자산은 1,400만 원, 누적 투자원금은 1,200만 원이 됩니다. 투자 손익은 그대로 +200만 원이고, 수익률은 200만 ÷ 1,200만 × 100 = 약 +16.67%입니다.',
          '· 손실 중일 때도 같습니다. 총자산 900만 원(수익률 -10%)에서 광고 보상 200만 원을 받으면 총자산 1,100만 원, 누적 투자원금 1,200만 원이 되고, 투자 손익은 그대로 -100만 원, 수익률은 약 -8.33%입니다.',
        ],
      },
      {
        heading: '초보모드와 시즌모드',
        paragraphs: [
          '초보모드도 같은 방식으로 계산합니다. 초보모드에서는 광고 보상을 받을 수 없으므로 누적 투자원금은 최초 지급금과 같습니다.',
          '시즌모드는 지금처럼 시즌 초기 자본 대비 수익률을 사용하며, 랭킹·티어 기준도 바뀌지 않습니다.',
        ],
      },
    ],
  },
  {
    id: NOTICE_IDS.executionGapProtection,
    title: '체결괴리 방지시스템 안내',
    publishedOn: '2026-10-12',
    sections: [
      {
        heading: '모의투자 거래는 실제 호가창에 반영되지 않습니다',
        paragraphs: [
          'Trading Class의 주문은 실제 거래소로 전송되지 않습니다. 앱에서 매수·매도가 체결되어도 실제 거래소 호가창의 잔량이나 체결 내역은 바뀌지 않습니다.',
        ],
      },
      {
        heading: '대신 체결괴리 방지시스템이 적용됩니다',
        paragraphs: [
          '모의투자 체결이 실제 시장 가격과 동떨어지지 않도록 하는 장치입니다.',
          '· 체결 시점에 실제 시장에서 받은 최신 시세로 체결가격을 다시 확인합니다.',
          '· 시세가 오래되었거나 확인할 수 없으면 체결하지 않고 다시 시도하도록 안내합니다.',
          '· 현물 주문은 확인한 가격과 체결 시점 가격의 차이가 허용 범위를 넘으면 다시 확인을 요청합니다.',
        ],
      },
      {
        heading: '왜 필요한가요?',
        paragraphs: [
          '모의투자 주문은 실제 호가창에 쌓이지 않습니다. 오래된 가격이나 지금 시장에서 거래되지 않는 가격으로 체결되면 실제 시장과 다른 결과가 나오므로, 이 차이를 줄여 실제 시장에 가까운 연습 결과를 제공합니다.',
        ],
      },
      {
        heading: '가이드 체험 화면과의 차이',
        paragraphs: [
          '가이드의 호가창·체결 실습은 원리를 설명하기 위한 예시 시장입니다. 실습에서 잔량이 줄거나 현재가가 바뀌어도 실제 시장이나 내 계정에는 영향이 없습니다.',
        ],
      },
    ],
  },
];

export function findNotice(id: string | undefined): Notice | undefined {
  return id === undefined ? undefined : notices.find((notice) => notice.id === id);
}
