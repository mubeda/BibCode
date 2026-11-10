import { renderToStaticMarkup } from "react-dom/server";
import { compile } from "tailwindcss";
import { describe, expect, it, vi } from "vite-plus/test";

import { ComposerPrimaryActions } from "../chat/ComposerPrimaryActions";
import { Button, buttonVariants } from "./button";

describe("buttonVariants default theme tokens", () => {
  /** The compiled rules of the default variant, with the two tokens mapped as in index.css. */
  async function compiledDefaultVariant(): Promise<string> {
    const compiler = await compile(`@theme inline {
      --color-primary: var(--primary);
      --color-primary-hover: var(--primary-hover);
      --color-primary-active: var(--primary-active);
    }
    @tailwind utilities;`);
    return compiler.build(buttonVariants({ variant: "default" }).split(/\s+/));
  }
  /** The selector of every rule whose declarations use `token`, and whether a media query wraps it. */
  function rulesUsing(css: string, token: string): { selector: string; inMedia: boolean }[] {
    const rules: { selector: string; inMedia: boolean }[] = [];
    const open: string[] = [];
    let preludeStart = 0;
    for (let index = 0; index < css.length; index += 1) {
      if (css[index] === "{") {
        open.push(css.slice(preludeStart, index).trim());
        preludeStart = index + 1;
      } else if (css[index] === "}") {
        open.pop();
        preludeStart = index + 1;
      } else if (css[index] === ";") {
        if (css.slice(preludeStart, index).includes(`var(--${token}`)) {
          rules.push({
            selector: open.findLast((prelude) => !prelude.startsWith("@")) ?? "",
            inMedia: open.some((prelude) => prelude.startsWith("@media")),
          });
        }
        preludeStart = index + 1;
      }
    }
    return rules;
  }

  it("the default button paints primary-hover on hover or press and primary-active on a pointer press or data-pressed, with no hover media gate (touch keeps both)", async () => {
    const css = await compiledDefaultVariant();
    const hover = rulesUsing(css, "primary-hover");
    const active = rulesUsing(css, "primary-active");

    expect(hover.length).toBeGreaterThan(0);
    expect(active.length).toBeGreaterThan(0);
    expect([...hover, ...active].filter((rule) => rule.inMedia)).toEqual([]);
    expect(hover.every((rule) => /:is\(:hover, \[data-pressed\]\)/.test(rule.selector))).toBe(true);
    expect(
      active.every((rule) => /:is\(:active:hover, \[data-pressed\]\)/.test(rule.selector)),
    ).toBe(true);
    expect(css).not.toContain("bg-primary/90");
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
