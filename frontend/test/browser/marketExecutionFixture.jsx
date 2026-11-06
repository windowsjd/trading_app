import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppearanceProvider } from "../../src/theme/appearance";
import Sheet from "../../src/screens/order/OrderSuccessBottomSheet";
import { ScreenSheetHost } from "../../src/components/common/ScreenSheetHost";
import { View } from "react-native";
import History from "../../src/screens/history/TradeHistoryScreen";
import { marketResult } from "./marketExecutionFixtures";
const params = new URLSearchParams(location.search);
const kind = params.get("kind") ?? "quantity";
const client = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});
window.fixtureClosed = false;
function App() {
  const [visible, setVisible] = React.useState(true);
  const close = () => {
    window.fixtureClosed = true;
    setVisible(false);
  };
  return (
    <QueryClientProvider client={client}>
      <AppearanceProvider>
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 0, bottom: 0, left: 0, right: 0 },
          }}
        >
          {kind === "history" ? (
            <History route={{ params: { accountId: "account-fixture" } }} />
          ) : (
            // A numeric height: the 수익 공유 sheet draws in this host over the screen.
            <View style={{ height: window.innerHeight }}>
              <ScreenSheetHost>
                <Sheet
                  visible={visible}
                  onClose={close}
                  onGoHome={close}
                  onGoOrderHistory={close}
                  payload={marketResult(kind)}
                  displayPriceDecimals={4}
                  // Only the SELL fixture names its account: a BUY never offers 공유하기.
                  accountId={kind === "sell" ? "account-fixture" : undefined}
                />
              </ScreenSheetHost>
            </View>
          )}
        </SafeAreaProvider>
      </AppearanceProvider>
    </QueryClientProvider>
  );
}
createRoot(document.getElementById("root")).render(<App />);
