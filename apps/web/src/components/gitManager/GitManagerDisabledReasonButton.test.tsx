// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { GitManagerDisabledReasonButton } from "./GitManagerDisabledReasonButton";

function render(props: { reason: string | null; disabled?: boolean; describedBy?: string }) {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(
    <>
      <p id="caller-help">Caller help.</p>
      <GitManagerDisabledReasonButton
        {...(props.describedBy === undefined ? {} : { "aria-describedby": props.describedBy })}
        {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
        disabledReason={props.reason}
        enabledTitle="Does the thing"
      >
        Act
      </GitManagerDisabledReasonButton>
    </>,
  );
  return host;
}

/** The text assistive technology reads as the button's description, in order. */
function description(host: HTMLElement) {
  const ids = host.querySelector("button")?.getAttribute("aria-describedby")?.split(" ") ?? [];
  return ids.map((id) => host.querySelector(`[id="${id}"]`)?.textContent ?? `<missing ${id}>`);
}

describe("GitManagerDisabledReasonButton", () => {
  it("describes a disabled button by its reason without any wiring at the call site", () => {
    const host = render({ reason: "Not now." });
    const button = host.querySelector("button");
    expect(button?.disabled).toBe(true);
    expect(button?.title).toBe("");
    expect(button?.parentElement?.title).toBe("Not now.");
    expect(description(host)).toEqual(["Not now."]);
  });

  it("keeps a caller's own description beside the reason", () => {
    const host = render({ reason: "Not now.", describedBy: "caller-help" });
    expect(description(host)).toEqual(["Caller help.", "Not now."]);
  });

  it("keeps the normal tooltip and only the caller's description when enabled", () => {
    const host = render({ reason: null });
    const button = host.querySelector("button");
    expect(button?.disabled).toBe(false);
    expect(button?.title).toBe("Does the thing");
    expect(button?.parentElement?.title).toBe("");
    expect(button?.hasAttribute("aria-describedby")).toBe(false);
    expect(description(render({ reason: null, describedBy: "caller-help" }))).toEqual([
      "Caller help.",
    ]);
  });

  it("can be disabled without a reason", () => {
    const button = render({ reason: null, disabled: true }).querySelector("button");
    expect(button?.disabled).toBe(true);
  });
});
