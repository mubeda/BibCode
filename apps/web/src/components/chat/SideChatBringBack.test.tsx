// @vitest-environment happy-dom

import { scopeThreadRef } from "@bibcode/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@bibcode/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  hostStatus: "ready" as "ready" | "running",
  drafts: new Map<string, string>(),
  hostChatsOpened: 0,
  sends: 0,
}));

vi.mock("~/state/entities", () => ({
  useThreadShell: () => ({ session: { status: h.hostStatus } }),
}));
vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: {
    getState: () => ({
      getComposerDraft: (ref: { threadId: string }) => {
        const prompt = h.drafts.get(ref.threadId);
        return prompt === undefined ? null : { prompt };
      },
      setPrompt: (ref: { threadId: string }, prompt: string) => h.drafts.set(ref.threadId, prompt),
    }),
  },
}));
vi.mock("~/centerPanelStore", () => ({
  useCenterPanelStore: {
    getState: () => ({
      openHostChat: () => {
        h.hostChatsOpened += 1;
      },
    }),
  },
}));
// Any command, a send included, would go through here.
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => () => {
    h.sends += 1;
    return Promise.resolve({ _tag: "Success" });
  },
}));

import { BRING_BACK_HOST_RUNNING_REASON, BRING_BACK_NO_ANSWER_REASON } from "~/sideChatBringBack";
import { BRING_BACK_DESCRIPTION, SideChatBringBack } from "./SideChatBringBack";

const HOST = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("host"));
const SUMMARY = "From the side chat:\n\n> Because.";

let root: Root | null = null;

async function mount(summary: string | null): Promise<HTMLButtonElement> {
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<SideChatBringBack hostRef={HOST} summary={summary} />));
  const button = container.querySelector("button");
  expect(button?.textContent).toBe("Bring back");
  return button!;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  h.drafts.clear();
  h.hostChatsOpened = 0;
  h.sends = 0;
  h.hostStatus = "ready";
});

describe("SideChatBringBack", () => {
  it("puts the answer after the host draft and sends nothing", async () => {
    h.drafts.set("host", "half a thought");
    const button = await mount(SUMMARY);
    expect(button.disabled).toBe(false);
    expect(button.title).toBe(BRING_BACK_DESCRIPTION);
    await act(async () => button.click());
    expect(h.drafts.get("host")).toBe(`half a thought\n\n${SUMMARY}`);
    expect(h.hostChatsOpened).toBe(1);
    expect(h.sends).toBe(0);
  });

  it("is disabled with its reason while the host runs", async () => {
    h.hostStatus = "running";
    const button = await mount(SUMMARY);
    expect(button.disabled).toBe(true);
    expect(button.title).toBe(BRING_BACK_HOST_RUNNING_REASON);
    expect(document.body.textContent).toContain("Available when the thread is idle.");
    await act(async () => button.click());
    expect(h.drafts.has("host")).toBe(false);
  });

  it("is disabled until the side chat has answered", async () => {
    const button = await mount(null);
    expect(button.disabled).toBe(true);
    expect(button.title).toBe(BRING_BACK_NO_ANSWER_REASON);
  });
});
