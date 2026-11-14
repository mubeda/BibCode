// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import type { CodeReviewScope } from "../SourceControlPanel.logic";
import { buildReviewPreviewContent, ReviewScopePicker } from "./ReviewScopePicker";
import type { ReviewScopeOption } from "./review.logic";
import type { PreviewContent } from "./sendToAgent.logic";
import type { SendOutcome } from "~/state/sendRequests";

const branch: ReviewScopeOption = {
  scope: { kind: "branch", base: "origin/main" },
  label: "Branch vs origin/main and uncommitted changes",
  disabledReason: null,
  isDefault: true,
};
const uncommitted: ReviewScopeOption = {
  scope: { kind: "uncommitted", base: "origin/main" },
  label: "Uncommitted changes",
  disabledReason: null,
  isDefault: false,
};

let root: Root;
let container: HTMLDivElement;
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

function Harness(props: { options: ReadonlyArray<ReviewScopeOption>; seen: CodeReviewScope[] }) {
  const [value, setValue] = useState<CodeReviewScope | null>(props.options[0]!.scope);
  return (
    <ReviewScopePicker
      options={props.options}
      value={value}
      onChange={(scope) => {
        props.seen.push(scope);
        setValue(scope);
      }}
    />
  );
}

const radios = () => [...container.querySelectorAll<HTMLElement>('[role="radio"]')];

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ReviewScopePicker", () => {
  it("renders a radio group with the default selected", () => {
    act(() => root.render(<Harness options={[branch, uncommitted]} seen={[]} />));
    expect(container.querySelector('[role="radiogroup"]')).not.toBeNull();
    expect(radios().map((radio) => radio.getAttribute("aria-checked"))).toEqual(["true", "false"]);
  });

  it("arrow keys change the scope", async () => {
    const seen: CodeReviewScope[] = [];
    act(() => root.render(<Harness options={[branch, uncommitted]} seen={seen} />));
    const first = radios()[0]!;
    act(() => first.focus());
    await act(async () => {
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    await flush();
    expect(seen.map((scope) => scope.kind)).toEqual(["uncommitted"]);
    expect(radios()[1]!.getAttribute("aria-checked")).toBe("true");
  });

  it("a disabled option stays focusable, names its reason and cannot be picked", async () => {
    const seen: CodeReviewScope[] = [];
    const blocked = { ...uncommitted, disabledReason: "No uncommitted changes" };
    act(() => root.render(<Harness options={[branch, blocked]} seen={seen} />));
    const radio = radios()[1]!;
    expect(radio.getAttribute("aria-disabled")).toBe("true");
    expect(radio.hasAttribute("disabled")).toBe(false);
    expect(container.textContent).toContain("No uncommitted changes");
    const reasonId = radio.getAttribute("aria-describedby")!;
    expect(container.querySelector(`[id="${reasonId}"]`)?.textContent).toBe(
      "No uncommitted changes",
    );
    act(() => radio.focus());
    expect(document.activeElement).toBe(radio);
    await act(async () => radio.click());
    expect(seen).toEqual([]);
  });
});

describe("buildReviewPreviewContent", () => {
  it("a late completion of an earlier send leaves the scope a reopened preview picked", async () => {
    const submitted: string[] = [];
    const resolvers: Array<(outcome: SendOutcome) => void> = [];
    const build = () =>
      buildReviewPreviewContent({
        options: [branch, uncommitted],
        pickKey: "late-send-key",
        contentFor: (scope): PreviewContent => ({
          leadIn: scope.kind,
          attachments: [],
          submit: () => {
            submitted.push(scope.kind);
            return new Promise<SendOutcome>((resolve) => resolvers.push(resolve));
          },
        }),
      });
    const draft = { leadIn: "", note: "", attachments: [] };
    const first = build();
    const firstSend = first.submit!(draft);
    const second = build();
    act(() => root.render(<>{second.extraContent}</>));
    await act(async () => radios()[1]!.click());
    await flush();
    expect(radios()[1]!.getAttribute("aria-checked")).toBe("true");
    resolvers[0]!({ kind: "sent" } as SendOutcome);
    await firstSend;
    void second.submit!(draft);
    expect(submitted).toEqual(["branch", "uncommitted"]);
  });
});
