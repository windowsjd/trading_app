export function marketResult(kind = "quantity") {
  const amount = kind === "amount";
  const full = kind === "full";
  const limit = kind === "limit";
  const large = kind === "large";
  const result = {
    order: {
      orderId: "market-fixture",
      asset: {
        id: "asset",
        name: "아주 긴 이름을 가진 거래 대상 자산",
        symbol: "EXAMPLE",
        market: "KRX",
      },
      orderType: limit ? "limit" : "market",
      status: limit ? "submitted" : "executed",
      side: "buy",
      quantity: amount ? "0.6" : large ? "9999999999999999.000000" : "1000",
      currencyCode: amount ? "USD" : "KRW",
      executedPrice: limit ? null : amount ? "100.03333333" : full ? "100" : "100.0875",
      grossAmount: limit ? null : amount ? "60.02" : full ? "100000" : "80070",
      feeAmount: limit ? null : amount ? "0.06002" : full ? "100" : "80.07",
      netAmount: limit ? null : amount ? "60.08002" : full ? "100100" : "80150.07",
      limitPrice: limit ? "100" : null,
      reservedAmount: limit ? "100100" : null,
      submittedAt: "2026-10-02T01:00:00Z",
      executedAt: limit ? null : "2026-10-02T01:00:00Z",
      ...(!full && !limit
        ? {
            marketExecution: {
              status: "partial",
              requestedQuantity: amount
                ? null
                : large
                  ? "9999999999999999.000000"
                  : "1000",
              executedQuantity: amount ? "0.6" : "800",
              canceledQuantity: amount
                ? null
                : large
                  ? "9999999999999199.000000"
                  : "200",
              requestedAmount: amount ? "100" : null,
              unspentAmount: amount ? "39.98" : null,
              remainderCancelReason: "insufficient_market_liquidity",
              remainderCanceledAt: "2026-10-02T01:00:00Z",
            },
          }
        : {}),
    },
    execution: {
      state: limit ? "submitted" : "executed",
      executePrice: amount ? "100.03333333" : full ? "100" : "100.0875",
      quotedPrice: "100",
      priceChangeBps: "8.75",
      executedAt: "2026-10-02T01:00:00Z",
      walletBalanceAfter: "1000000",
    },
  };
  return result;
}
