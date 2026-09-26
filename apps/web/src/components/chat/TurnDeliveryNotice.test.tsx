import { ProviderDriverKind, type TurnDelivery } from "@bibcode/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { TurnDeliveryNotice } from "./TurnDeliveryNotice";

function delivery(
  state: TurnDelivery["state"],
  provider = "claudeAgent",
  detail: string | null = "connection closed before acknowledgement",
): TurnDelivery {
  return {
    state,
    provider: ProviderDriverKind.make(provider),
    ...(detail === null ? {} : { detail }),
  };
}

function renderNotice(value: TurnDelivery): string {
  return renderToStaticMarkup(
    <TurnDeliveryNotice delivery={value} onRetry={vi.fn()} onDismiss={vi.fn()} disabled={false} />,
  );
}

/** The classes of the paragraph whose text starts with `text`. */
function paragraphClasses(markup: string, text: string): string[] | undefined {
  return markup
    .split("<p")
    .slice(1)
    .find((paragraph) => paragraph.slice(paragraph.indexOf(">") + 1).startsWith(text))
    ?.match(/^[^>]*class="([^"]*)"/u)?.[1]
    ?.split(" ");
}

// The server keeps the refusal as the delivery's detail (ProviderRuntimeError::InvalidOption).
const OPTION_REFUSAL =
  "claudeAgent provider operation failed: option fastMode is not supported by the selected model/session";

describe("TurnDeliveryNotice", () => {
  it("shows why a delivery failed directly under the heading", () => {
    const markup = renderNotice(delivery("failed", "claudeAgent", OPTION_REFUSAL));

    expect(markup).toContain(OPTION_REFUSAL);
    expect(markup.indexOf("Delivery failed")).toBeLessThan(markup.indexOf(OPTION_REFUSAL));
    expect(markup.indexOf(OPTION_REFUSAL)).toBeLessThan(
      markup.indexOf("Claude did not receive this message"),
    );
  });

  it("says that later messages wait and what Retry and Dismiss do", () => {
    const markup = renderNotice(delivery("failed", "claudeAgent", OPTION_REFUSAL));

    // A failed delivery holds back the thread's later deliveries until the user acts, and Retry
    // replays the unchanged message, so a refused model option is refused again.
    expect(markup).not.toContain("Retry to send it again");
    expect(markup).toContain(
      "Claude did not receive this message, and later messages wait behind it. Retry sends it again unchanged; Dismiss skips it.",
    );
    expect(markup).toContain('aria-label="Retry message delivery"');
    expect(markup).toContain('aria-label="Dismiss and skip this message"');
  });

  it.each([
    ["failed", "Delivery failed", OPTION_REFUSAL],
    ["uncertain", "Delivery uncertain", "connection closed before acknowledgement"],
  ] as const)(
    "shows the detail muted under a heading that keeps its tone (%s)",
    (state, heading, detail) => {
      const markup = renderNotice(delivery(state, "claudeAgent", detail));

      expect(paragraphClasses(markup, heading)).toBeDefined();
      expect(paragraphClasses(markup, heading)).not.toContain("text-muted-foreground");
      expect(paragraphClasses(markup, detail)).toContain("text-muted-foreground");
    },
  );

  it("shows why a delivery is uncertain", () => {
    const markup = renderNotice(delivery("uncertain"));

    expect(markup).toContain("connection closed before acknowledgement");
    expect(markup.indexOf("Delivery uncertain")).toBeLessThan(
      markup.indexOf("connection closed before acknowledgement"),
    );
  });

  it.each(["failed", "uncertain"] as const)(
    "leaves no empty line for a %s delivery without a detail",
    (state) => {
      const markup = renderNotice(delivery(state, "claudeAgent", null));

      expect(markup).toContain(state === "failed" ? "Delivery failed" : "Delivery uncertain");
      expect(markup).not.toMatch(/<p[^>]*><\/p>/u);
      expect(markup.match(/<p[\s>]/gu)).toHaveLength(2);
    },
  );

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
    // An uncertain delivery holds back later ones too, so the copy says so.
    expect(markup).toContain("later messages wait behind it");
    expect(markup).toContain("Retrying could deliver a duplicate; Dismiss skips it.");
    expect(markup).toContain('aria-label="Retry message delivery"');
    expect(markup).toContain('aria-label="Dismiss and skip this message"');
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
