export * from "./tradingMocks";
import { apiClient as original, state } from "./tradingMocks";
import { marketResult } from "./marketExecutionFixtures";
export const apiClient = {
  ...original,
  async get(path, options) {
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
