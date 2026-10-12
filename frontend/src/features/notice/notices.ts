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
