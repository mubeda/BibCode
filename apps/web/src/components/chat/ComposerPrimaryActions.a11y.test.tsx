// @vitest-environment happy-dom

import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ComposerPrimaryActions } from "./ComposerPrimaryActions";

type Props = ComponentProps<typeof ComposerPrimaryActions>;

const defaults: Props = {
  compact: false,
  pendingAction: null,
  isRunning: false,
  showPlanFollowUpPrompt: false,
  promptHasText: false,
  isSendBusy: false,
  isConnecting: false,
  isEnvironmentUnavailable: false,
  isPreparingWorktree: false,
  hasSendableContent: true,
  onPreviousPendingQuestion: vi.fn(),
  onInterrupt: vi.fn(),
  onImplementPlanInNewThread: vi.fn(),
};

const offline: Partial<Props> = {
  isEnvironmentUnavailable: true,
  environmentUnavailableReason: "Laptop: Offline",
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function renderInForm(
  overrides: Partial<Props>,
): Promise<{ onSubmit: (event: { preventDefault: () => void }) => void }> {
  const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <form onSubmit={onSubmit}>
        <ComposerPrimaryActions {...defaults} {...overrides} />
      </form>,
    );
  });
  return { onSubmit };
}

/** The controls Tab visits, in document order, with the name assistive technology reads. */
function tabStops(): Array<{ element: HTMLElement; name: string }> {
  return [
    ...container!.querySelectorAll<HTMLElement>(
      'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    ),
  ]
    .filter((element) => !(element instanceof HTMLButtonElement && element.disabled))
    .map((element) => ({
      element,
      name: (element.getAttribute("aria-label") ?? element.textContent ?? "").trim(),
    }));
}

describe("ComposerPrimaryActions accessibility while the environment is unavailable", () => {
  it.each([
    ["Send", {}, "Send unavailable. Laptop: Offline"],
    [
      "a question's final Submit",
      {
        pendingAction: {
          questionIndex: 1,
          isLastQuestion: true,
          canAdvance: true,
          isResponding: false,
          isComplete: true,
        },
      },
      "Submit answers unavailable. Laptop: Offline",
    ],
    [
      "Refine",
      { showPlanFollowUpPrompt: true, promptHasText: true },
      "Refine unavailable. Laptop: Offline",
    ],
    ["Implement", { showPlanFollowUpPrompt: true }, "Implement unavailable. Laptop: Offline"],
  ] as const)(
    "lands Tab on %s named with the reason, and refuses to submit",
    async (_action, overrides, name) => {
      const { onSubmit } = await renderInForm({ ...offline, ...overrides });

      const stops = tabStops();
      // Every focus stop has a name; there is no unnamed wrapper around the blocked action.
      expect(stops.every((stop) => stop.name.length > 0)).toBe(true);
      const blockedStops = stops.filter(
        (stop) => stop.element.getAttribute("aria-disabled") === "true",
      );
      expect(blockedStops.map((stop) => stop.name)).toEqual([name]);
      const blocked = blockedStops[0]!.element;
      expect(blocked.tagName).toBe("BUTTON");

      blocked.focus();
      expect(document.activeElement).toBe(blocked);
      await act(async () => blocked.click());
      expect(onSubmit).not.toHaveBeenCalled();
    },
  );

  it("keeps a connected Send a plain, named submit button", async () => {
    const { onSubmit } = await renderInForm({});
    const stops = tabStops();
    expect(stops).toHaveLength(1);
    expect(stops[0]!.name).toBe("Send message");
    expect(stops[0]!.element.hasAttribute("aria-disabled")).toBe(false);
    await act(async () => stops[0]!.element.click());
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});
