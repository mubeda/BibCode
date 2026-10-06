// @vitest-environment happy-dom
// Actual binding and mounted picker; only browser layout ports are inert.
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@bibcode/contracts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { Thread } from "./types";
import type { ModelEsque } from "./components/chat/providerIconUtils";
import { resolveThreadProviderBinding } from "./threadProviderBinding";
import { deriveProviderInstanceEntries } from "./providerInstances";
import { ProviderModelPicker } from "./components/chat/ProviderModelPicker";

const now = "2026-10-05T00:00:00.000Z";
const claudeId = ProviderInstanceId.make("claudeAgent");
const cursorId = ProviderInstanceId.make("cursor");
const threadId = ThreadId.make("owned-thread");
function provider(
  instanceId: ProviderInstanceId,
  driver: string,
  displayName: string,
): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make(driver),
    displayName,
    enabled: true,
    installed: true,
    version: "0.0.0-owned-fixture",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: now,
    models: [],
    slashCommands: [],
    skills: [],
    agents: [],
  };
}
const providers = [provider(claudeId, "claude", "Claude"), provider(cursorId, "cursor", "Cursor")];
const modelOptions: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>> = new Map([
  [claudeId, [{ slug: "opus", name: "Opus 5" }]],
  [cursorId, [{ slug: "cursor-fixture", name: "Cursor Fixture" }]],
]);
function thread(started: boolean): Thread {
  return {
    id: threadId,
    environmentId: EnvironmentId.make("local"),
    projectId: ProjectId.make("owned-project"),
    title: "Owned",
    modelSelection: { instanceId: claudeId, model: "opus" },
    runtimeMode: "full-access",
    interactionMode: "default",
    kind: "workspace",
    branch: "codex/delivery-retry-light",
    worktreePath: "/owned/worktree",
    latestTurn: null,
    messages: [],
    activities: [],
    checkpoints: [],
    proposedPlans: [],
    archivedAt: null,
    deletedAt: null,
    createdAt: now,
    updatedAt: now,
    session: started
      ? {
          threadId,
          providerName: "claude",
          providerInstanceId: claudeId,
          status: "ready",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        }
      : null,
  };
}

it.each([false, true])(
  "mounts the actual public picker from the real thread binding (started=%s)",
  async (started) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const rectangle: DOMRect = {
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      width: 640,
      height: 480,
      right: 640,
      bottom: 480,
      toJSON: () => ({}),
    };
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue(rectangle);
    const oldHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    const oldWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 480,
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => 640,
    });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const binding = resolveThreadProviderBinding({
      thread: thread(started),
      projectDefaultModelSelection: null,
      selectedProviderInstanceId: claudeId,
      providers,
    });
    try {
      await act(async () =>
        root.render(
          createElement(ProviderModelPicker, {
            activeInstanceId: binding.instanceId,
            model: "opus",
            lockToActiveInstance: binding.lockedProviderInstanceId !== null,
            lockedProvider: binding.lockedProvider,
            instanceEntries: deriveProviderInstanceEntries(providers),
            modelOptionsByInstance: modelOptions,
            terminalOpen: false,
            open: true,
            onOpenChange: () => {},
            onInstanceModelChange: () => {},
          }),
        ),
      );
      await vi.waitFor(() =>
        expect(
          document.querySelector(
            '[data-model-picker-instance-id="claudeAgent"][data-model-picker-model-slug="opus"]',
          ),
        ).not.toBeNull(),
      );
      expect(binding.lockedProvider).toBe(started ? "claude" : null);
      expect(
        document.querySelectorAll(
          '[data-model-picker-instance-id="cursor"][data-model-picker-model-slug="cursor-fixture"]',
        ),
      ).toHaveLength(started ? 0 : 1);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      document.body.replaceChildren();
      rect.mockRestore();
      if (oldHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", oldHeight);
      else Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
      if (oldWidth) Object.defineProperty(HTMLElement.prototype, "clientWidth", oldWidth);
      else Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
      vi.unstubAllGlobals();
    }
  },
);
