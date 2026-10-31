// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, ThreadId, type UiFocusIntent } from "@bibcode/contracts";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const environmentId = EnvironmentId.make("env-1");

const h = vi.hoisted(() => ({
  toasts: [] as Array<{
    title: string;
    description: string;
    timeout?: number;
    actionProps?: { children: string; onClick: () => void };
  }>,
  close: vi.fn(),
  rightPanel: { open: vi.fn(), openFile: vi.fn() },
  openChatPanel: vi.fn(),
  selectCompareFile: vi.fn(),
  environments: [] as Array<{ environmentId: string }>,
  shells: {} as Record<string, { title: string; hostThreadId?: string }>,
}));
vi.mock("./ui/toast", () => ({
  stackedThreadToast: (options: unknown) => options,
  toastManager: {
    add: (toast: (typeof h.toasts)[number]) => {
      h.toasts.push(toast);
      return `toast-${h.toasts.length}`;
    },
    close: h.close,
  },
}));
vi.mock("~/state/entities", () => ({
  readThreadShell: (ref: { threadId: string }) => h.shells[ref.threadId] ?? null,
}));
vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({ environments: h.environments }),
}));
vi.mock("~/state/uiIntents", () => ({
  uiIntentsEnvironment: {
    intents: (target: { environmentId: string }) => `intents:${target.environmentId}`,
  },
}));
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: { getState: () => h.rightPanel },
}));
vi.mock("~/centerPanelStore", () => ({
  useCenterPanelStore: { getState: () => ({ openChatPanel: h.openChatPanel }) },
}));
vi.mock("~/diffPanelStore", () => ({
  useDiffPanelStore: { getState: () => ({ selectCompareFile: h.selectCompareFile }) },
}));

import { UiIntentNotifier, uiIntentToastCopy } from "./UiIntentNotifier";

function fakeRegistry() {
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  return {
    subscribe(atom: string, f: (value: unknown) => void, options?: { immediate?: boolean }) {
      if (options?.immediate) f(AsyncResult.initial());
      const set = listeners.get(atom) ?? new Set();
      set.add(f);
      listeners.set(atom, set);
      return () => set.delete(f);
    },
    emit(atom: string, value: unknown) {
      for (const f of listeners.get(atom) ?? []) f(value);
    },
  };
}

let sequence = 0;
function intent(overrides: Partial<UiFocusIntent> = {}): UiFocusIntent {
  sequence += 1;
  return {
    kind: "focus",
    intentId: `intent-${sequence}`,
    threadId: ThreadId.make("thread-1"),
    surface: "sourceControl",
    path: null,
    actor: { kind: "mcp-client", clientId: "session-1", label: "Claude Code" },
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
  };
}

const roots: ReturnType<typeof createRoot>[] = [];
const navigate = vi.fn(async () => undefined);
async function mount(registry: ReturnType<typeof fakeRegistry>) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={registry as never}>
        <UiIntentNotifier router={{ navigate } as never} />
      </RegistryContext.Provider>,
    ),
  );
}

const emit = (registry: ReturnType<typeof fakeRegistry>, intents: UiFocusIntent[]) =>
  act(async () => registry.emit(`intents:${environmentId}`, AsyncResult.success(intents)));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  h.toasts = [];
  h.environments = [{ environmentId }];
  h.shells = { "thread-1": { title: "Fix login" } };
});

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
});

describe("uiIntentToastCopy", () => {
  it("names the agent, the surface and the thread, with the file when there is one", () => {
    expect(uiIntentToastCopy(intent(), "Fix login")).toEqual({
      title: "Agent Claude Code wants to show Source Control",
      description: "“Fix login”",
    });
    expect(
      uiIntentToastCopy(
        intent({
          surface: "files",
          path: "src/app.ts",
          actor: { kind: "mcp-client", clientId: "s", label: null },
        }),
        null,
      ),
    ).toEqual({ title: "An agent wants to show a file", description: "A thread · src/app.ts" });
  });
});

describe("UiIntentNotifier", () => {
  it("raises one notice per intent and moves nothing until Show", async () => {
    const registry = fakeRegistry();
    await mount(registry);
    const first = intent({ surface: "files", path: "src/app.ts" });
    await emit(registry, [first]);
    // The snapshot after a reconnect carries it again: still one notice.
    await emit(registry, [first]);

    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0]?.title).toBe("Agent Claude Code wants to show a file");
    expect(h.toasts[0]?.timeout).toBeGreaterThan(59_000);
    expect(navigate).not.toHaveBeenCalled();
    expect(h.rightPanel.openFile).not.toHaveBeenCalled();

    await act(async () => h.toasts[0]?.actionProps?.onClick());
    expect(h.close).toHaveBeenCalledWith("toast-1");
    expect(navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: "thread-1" },
    });
    expect(h.rightPanel.openFile).toHaveBeenCalledWith(
      { environmentId, threadId: "thread-1" },
      "src/app.ts",
    );
  });

  it("shows a chat panel's surface on its host, with the panel's tab active", async () => {
    h.shells = { panel: { title: "Review", hostThreadId: "host" } };
    const registry = fakeRegistry();
    await mount(registry);
    await emit(registry, [
      intent({ threadId: ThreadId.make("panel"), surface: "diff", path: "a.ts" }),
    ]);
    await act(async () => h.toasts[0]?.actionProps?.onClick());

    const host = { environmentId, threadId: "host" };
    expect(navigate).toHaveBeenCalledWith({ to: "/$environmentId/$threadId", params: host });
    expect(h.openChatPanel).toHaveBeenCalledWith(host, "panel");
    expect(h.rightPanel.open).toHaveBeenCalledWith(host, "diff");
    expect(h.selectCompareFile).toHaveBeenCalledWith(host, "a.ts");
  });

  it("skips an expired intent and holds one for a hidden window until it is shown", async () => {
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      const registry = fakeRegistry();
      await mount(registry);
      await emit(registry, [
        intent({ expiresAt: new Date(Date.now() - 1).toISOString() }),
        intent({ surface: "thread" }),
      ]);
      expect(h.toasts).toHaveLength(0);

      visibility.mockReturnValue("visible");
      await act(async () => document.dispatchEvent(new Event("visibilitychange")));
      expect(h.toasts.map((toast) => toast.title)).toEqual([
        "Agent Claude Code wants to show a thread",
      ]);
    } finally {
      visibility.mockRestore();
    }
  });
});
