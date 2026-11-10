import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ComposerPrimaryActions } from "../chat/ComposerPrimaryActions";
import { Button, buttonVariants } from "./button";

describe("buttonVariants default theme tokens", () => {
  it("the default button hovers with primary-hover and presses with primary-active", () => {
    const classes = buttonVariants({ variant: "default" }).split(/\s+/);

    expect(classes).toContain("hover:bg-primary-hover");
    expect(classes).toContain("data-pressed:bg-primary-active");
    expect(classes).toContain("active:hover:bg-primary-active");
    expect(classes.some((name) => name.includes("bg-primary/90"))).toBe(false);
  });
});

describe("buttonVariants content size", () => {
  it("uses responsive minimum heights without a fixed height", () => {
    const classes = buttonVariants({ size: "content" });

    expect(classes).toContain("min-h-9");
    expect(classes).toContain("sm:min-h-8");
    expect(classes).not.toMatch(/(?:^|\s)h-[^\s]+/);
    expect(classes).not.toMatch(/(?:^|\s)sm:h-[^\s]+/);
  });
});

describe("control shadow markers (#290, R59)", () => {
  it("the button and the Send button carry the control-shadow marker", () => {
    expect(renderToStaticMarkup(<Button>Save</Button>)).toContain('data-control-shadow=""');
    const send = renderToStaticMarkup(
      <ComposerPrimaryActions
        compact={false}
        pendingAction={null}
        isRunning={false}
        showPlanFollowUpPrompt={false}
        promptHasText
        isSendBusy={false}
        isConnecting={false}
        isEnvironmentUnavailable={false}
        isPreparingWorktree={false}
        hasSendableContent
        onPreviousPendingQuestion={vi.fn()}
        onInterrupt={vi.fn()}
        onImplementPlanInNewThread={vi.fn()}
      />,
    );
    expect(send).toMatch(
      /<button[^>]*type="submit"[^>]*data-control-shadow=""|<button[^>]*data-control-shadow=""[^>]*type="submit"/,
    );
  });
});
