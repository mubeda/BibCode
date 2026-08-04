import { ProviderDriverKind, type TurnDelivery } from "@bibcode/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { TurnDeliveryNotice } from "./TurnDeliveryNotice";

function delivery(state: TurnDelivery["state"], provider = "claudeAgent"): TurnDelivery {
  return {
    state,
    provider: ProviderDriverKind.make(provider),
    detail: "connection closed before acknowledgement",
  };
}

describe("TurnDeliveryNotice", () => {
  it("explains uncertain delivery with provider-specific safe actions", () => {
    const markup = renderToStaticMarkup(
      <TurnDeliveryNotice
        delivery={delivery("uncertain")}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
        disabled={false}
      />,
    );

    expect(markup).toContain("Delivery uncertain");
    expect(markup).toContain("Claude may have received this message");
    expect(markup).toContain('aria-label="Retry message delivery"');
    expect(markup).toContain('aria-label="Dismiss delivery warning"');
  });

  it("explains failed delivery and disables both actions together", () => {
    const markup = renderToStaticMarkup(
      <TurnDeliveryNotice
        delivery={delivery("failed", "opencode")}
        onRetry={vi.fn()}
        onDismiss={vi.fn()}
        disabled
      />,
    );

    expect(markup).toContain("Delivery failed");
    expect(markup).toContain("OpenCode did not receive this message");
    expect(markup.match(/disabled=""/gu)).toHaveLength(2);
  });

  it.each(["pending", "sending", "delivered", "dismissed"] as const)(
    "renders nothing for %s delivery",
    (state) => {
      expect(
        renderToStaticMarkup(
          <TurnDeliveryNotice
            delivery={delivery(state)}
            onRetry={vi.fn()}
            onDismiss={vi.fn()}
            disabled={false}
          />,
        ),
      ).toBe("");
    },
  );
});
