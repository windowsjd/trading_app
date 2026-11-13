// 관리자 공지·공지 팝업 fixture transport (2026-11-13): an in-memory notice store.
const long = '서비스 안정화를 위한 정기 점검이 진행됩니다. 점검 시간에는 주문 접수와 체결, 환전과 이체가 일시적으로 중지되며 점검이 끝나면 자동으로 다시 열립니다. 이용에 불편을 드려 죄송합니다.';
window.adminRequests = [];
window.noticeStore = [
  { id: 'n-2', title: '11월 20일(목) 새벽 2시부터 3시까지 정기 서버 점검 및 주문 시스템 개선 작업 안내', summary: long.slice(0, 190), sections: [{ heading: '점검 시간', paragraphs: ['2026년 11월 20일 02:00 ~ 03:00 (KST)\n점검이 길어지면 공지로 다시 알려 드립니다.', long] }, { heading: '영향 범위', paragraphs: [long] }],
    showPopup: true, status: 'published', createdAt: '2026-11-13T00:00:00.000Z', publishedAt: '2026-11-13T01:00:00.000Z', withdrawnAt: null, delivery: { sent: 1234, skipped: 56, failed: 2 } },
  { id: 'n-1', title: '초안: 시즌 일정 변경', summary: '시즌 종료일이 하루 늦춰집니다.', sections: [{ heading: '안내', paragraphs: ['본문'] }],
    showPopup: false, status: 'draft', createdAt: '2026-11-12T00:00:00.000Z', publishedAt: null, withdrawnAt: null, delivery: {} },
];
export const apiClient = {
  async get(path) {
    window.adminRequests.push(['GET', path]);
    if (path === '/operator/notices') return { data: { success: true, data: { notices: window.noticeStore } } };
    if (path === '/notices/popup') return { data: { success: true, data: { notices: window.noticeStore.filter(n => n.status === 'published' && n.showPopup).map(({ id, title, summary, publishedAt }) => ({ id, title, summary, publishedAt })) } } };
    throw new Error('Unexpected fixture request ' + path);
  },
  async post(path, body) {
    window.adminRequests.push(['POST', path, body]);
    if (/acknowledgement$/.test(path)) return { data: { success: true, data: { noticeId: path.split('/')[2], acknowledgedAt: new Date().toISOString() } } };
    throw new Error('Unexpected fixture request ' + path);
  },
};
export const rootNavigationRef = { isReady: () => false, addListener: () => () => {}, navigate() {} };
export const useHeaderHeight = () => 56;
