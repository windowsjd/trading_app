export * from "./tradingMocks";
import { apiClient as original, state } from "./tradingMocks";
import { completedSellTrade, marketResult } from "./marketExecutionFixtures";
// `?share=ready|holding|unverified|failed|checking`: the `sell` result's 공유하기 check.
const share = new URLSearchParams(location.search).get("share") ?? "ready";
const answer = (data) => ({ data: { success: true, data } });
export const apiClient = {
  ...original,
  async get(path, options) {
    if (path.endsWith("/completed-trades")) {
      if (share === "failed") throw Error("completed trades unavailable");
      if (share === "checking") return new Promise(() => {});
      return answer({
        tradingAccountId: state.accountId,
        hasMore: false,
        items: share === "ready" ? [completedSellTrade()] : [],
      });
    }
    if (path.endsWith("/positions"))
      return answer({
        tradingAccountId: state.accountId,
        positions: share === "holding" ? [{ assetId: "asset", quantity: "200", currencyCode: "KRW" }] : [],
        pagination: { limit: 20, offset: 0, total: share === "holding" ? 1 : 0, returned: share === "holding" ? 1 : 0, nextOffset: null },
      });
    if (path.includes("/orders"))
      return {
        data: {
          success: true,
          data: {
            state: "available",
            tradingAccountId: state.accountId,
            orders: ["quantity", "amount", "large", "full", "limit"].map(
              (kind) => ({ ...marketResult(kind).order, orderId: kind }),
            ),
            pagination: {
              limit: 20,
              offset: 0,
              total: 5,
              returned: 5,
              nextOffset: null,
            },
          },
        },
      };
    return original.get(path, options);
  },
};
