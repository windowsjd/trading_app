// Fixture transport for inquiryAnswerBrowser.cjs: the author's inquiry pages
// (long, answered, pending) and failure rows. Any other read fails loudly.
const scenario = () => new URLSearchParams(location.search);
const LONG_TITLE = '주문 체결 후 지갑 잔액과 보유 수량이 서로 다르게 보이는 문제에 대해 확인을 요청드립니다 정말 긴 제목입니다 확인';
const LONG_BODY = `${'시장가로 매수한 뒤 보유 수량은 늘었는데 원화 잔액이 바로 줄지 않아 보였습니다. '.repeat(40)}`.slice(0, 2000);
const LONG_ANSWER = `${'안녕하세요. 확인 결과 체결과 정산은 정상 처리되었고 화면 갱신이 늦게 보였던 것으로 확인했습니다. '.repeat(40)}`.slice(0, 2000);
const at = (minutes) => new Date(Date.UTC(2026, 9, 17, 6, 0) - minutes * 60_000).toISOString();
const inquiries = () => {
  const list = [
    { id: 'long', category: 'wallet', title: LONG_TITLE.slice(0, 100), content: LONG_BODY, createdAt: at(1), status: 'answered',
      answer: { content: LONG_ANSWER, answeredAt: at(0) } },
    { id: 'pending', category: 'bug', title: '앱 오류 문의', content: '주문 화면에서 버튼이 눌리지 않습니다.\n두 번째 줄입니다.', createdAt: at(2), status: 'pending', answer: null },
  ];
  for (let index = 0; index < 23; index++)
    list.push({ id: `old-${index}`, category: 'other', title: `이전 문의 ${index + 1}`, content: '이전에 보낸 문의입니다.', createdAt: at(60 + index), status: 'pending', answer: null });
  return list;
};
const failures = {
  loc: { kind: 'loc', id: 'order-1', tradingAccountId: 'acct-a', market: 'spot', status: 'expired', final: true,
    instrument: { name: '삼성바이오로직스우선주긴이름테스트', symbol: '207945' }, side: 'buy', direction: null, protection: null,
    reasonCode: 'loc_close_evidence_unavailable', failureCode: null, endedAt: at(5), createdAt: at(400) },
  futures_tp_sl: { kind: 'futures_tp_sl', id: 'tpsl-1', tradingAccountId: 'acct-a', market: 'futures', status: 'failed', final: true,
    instrument: { name: null, symbol: '1000SHIBUSDT' }, side: null, direction: 'long', protection: 'take_profit',
    reasonCode: 'execution_failed', failureCode: 'INSUFFICIENT_FUTURES_FREE_COLLATERAL', endedAt: at(3), createdAt: at(300) },
};
const ok = (data) => ({ data: { success: true, data } });
export const apiClient = {
  async get(path) {
    const inquiry = /^\/inquiries\/me\?limit=(\d+)&offset=(\d+)$/.exec(path);
    if (inquiry) {
      const [limit, offset] = [Number(inquiry[1]), Number(inquiry[2])];
      const all = inquiries(), items = all.slice(offset, offset + limit);
      const nextOffset = offset + items.length < all.length ? offset + items.length : null;
      return ok({ items, pagination: { limit, offset, total: all.length, returned: items.length, nextOffset } });
    }
    const failure = /^\/trading-accounts\/acct-a\/order-failures\/([a-z_]+)\/([A-Za-z0-9_-]+)$/.exec(path);
    if (failure && failures[failure[1]]) return ok({ failure: failures[failure[1]] });
    throw new Error(`Unexpected fixture read ${path}`);
  },
  async post(path) { throw new Error(`Unexpected fixture write ${path}`); },
};
export const useHeaderHeight = () => 56;
export const useTradingAccount = () => ({ accounts: [{ id: 'acct-a', mode: 'general', status: 'active' }], isLoading: false });
export const scenarioName = () => scenario().get('screen') ?? 'inquiry';
