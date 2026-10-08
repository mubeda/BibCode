// @vitest-environment happy-dom
import { EnvironmentId, ThreadId } from "@bibcode/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  openLink: vi.fn(),
  openPreview: vi.fn(),
}));
vi.mock("~/browser/openLink", () => ({ openLink: h.openLink }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => h.openPreview }));
vi.mock("~/state/preview", () => ({ previewEnvironment: { open: {} } }));

import { enqueueOpenPrompt, OpenPromptBanner, resetOpenPromptsForTests } from "./OpenPromptBanner";

const threadRef = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  resetOpenPromptsForTests();
  vi.clearAllMocks();
  h.openLink.mockReturnValue("system");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<OpenPromptBanner />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
});

const button = (name: string) =>
  Array.from(container.querySelectorAll("button")).find((b) => b.textContent === name)!;

describe("OpenPromptBanner", () => {
  it("names who asked and the full address", async () => {
    expect(container.textContent).toBe("");
    await act(async () =>
      enqueueOpenPrompt({ id: "r1", source: "command", url: "http://localhost:5173/", threadRef }),
    );
    expect(container.textContent).toContain("A command wants to open http://localhost:5173/");

    await act(async () => button("Dismiss").click());
    await act(async () =>
      enqueueOpenPrompt({ source: "agent", url: "http://localhost:3000/", threadRef }),
    );
    expect(container.textContent).toContain("Agent wants to open http://localhost:3000/");
  });

  it("opens through openLink from the click and removes the prompt", async () => {
    await act(async () =>
      enqueueOpenPrompt({ id: "r1", source: "command", url: "http://localhost:5173/", threadRef }),
    );
    await act(async () => button("Open").click());

    expect(h.openLink).toHaveBeenCalledWith({
      url: "http://localhost:5173/",
      threadRef,
      invert: false,
      openPreview: h.openPreview,
      onPopupBlocked: expect.any(Function),
      onUnopened: expect.any(Function),
    });
    expect(container.textContent).toBe("");
  });

  it("keeps the prompt when opening is refused, so it can be retried", async () => {
    h.openLink.mockReturnValueOnce("unreachable");
    await act(async () =>
      enqueueOpenPrompt({ id: "r1", source: "command", url: "http://localhost:5173/", threadRef }),
    );
    await act(async () => button("Open").click());

    expect(container.textContent).toContain("A command wants to open http://localhost:5173/");
  });

  it("offers the request again when the gateway refuses after the tab opened", async () => {
    let unopened!: () => void;
    h.openLink.mockImplementationOnce((input: { onUnopened: () => void }) => {
      unopened = input.onUnopened;
      return "system";
    });
    await act(async () =>
      enqueueOpenPrompt({ id: "r1", source: "command", url: "http://localhost:5173/", threadRef }),
    );
    await act(async () => button("Open").click());
    expect(container.textContent).toBe("");

    await act(async () => unopened());
    expect(container.textContent).toContain("A command wants to open http://localhost:5173/");
  });

  it("keeps a prompt whose tab the browser blocked, so Open can be retried", async () => {
    h.openLink.mockImplementationOnce((input: { onPopupBlocked: (url: string) => void }) =>
      input.onPopupBlocked("http://localhost:5173/"),
    );
    await act(async () =>
      enqueueOpenPrompt({ id: "r1", source: "command", url: "http://localhost:5173/", threadRef }),
    );
    await act(async () => button("Open").click());

    expect(container.textContent).toContain(
      "Your browser blocked a new tab for http://localhost:5173/",
    );
    await act(async () => button("Open").click());
    expect(h.openLink).toHaveBeenCalledTimes(2);
    expect(container.textContent).toBe("");
  });

  it("does not bring a dismissed prompt back and shows the next one", async () => {
    await act(async () => {
      enqueueOpenPrompt({ id: "r1", source: "command", url: "http://localhost:5173/", threadRef });
      enqueueOpenPrompt({ id: "r1", source: "command", url: "http://localhost:5173/", threadRef });
      enqueueOpenPrompt({ id: "r2", source: "agent", url: "http://localhost:3000/", threadRef });
    });
    expect(container.textContent).toContain("(1 more waiting)");
    await act(async () => button("Dismiss").click());
    expect(h.openLink).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("more waiting");
    expect(container.textContent).toContain("http://localhost:3000/");

    await act(async () => button("Dismiss").click());
    expect(container.textContent).toBe("");
  });
});
