// @vitest-environment happy-dom

import type { EnvironmentThreadShell } from "@bibcode/client-runtime/state/models";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId, TurnId } from "@bibcode/contracts";
import { createModelSelection } from "@bibcode/shared/model";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  markUnread: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ state: { matches: [{ params: {} }] } }),
}));
vi.mock("../../sidebarWorkspaceMetaStore", () => ({
  useSidebarWorkspaceMetaStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ markUnread: h.markUnread }),
}));

import { AgentsUnreadTracker } from "./AgentsUnreadTracker";

const UPDATED_AT = "2026-08-31T12:00:00.000Z";
const THREAD_ID = ThreadId.make("thread-settling");

function shell(state: "running" | "completed"): EnvironmentThreadShell {
  return {
    id: THREAD_ID,
    projectId: ProjectId.make("project-alpha"),
    title: "Settling agent",
    modelSelection: createModelSelection(ProviderInstanceId.make("codex"), "gpt-5-codex"),
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    latestTurn: {
      turnId: TurnId.make("turn-settling"),
      state,
      requestedAt: UPDATED_AT,
      startedAt: UPDATED_AT,
      completedAt: state === "completed" ? UPDATED_AT : null,
      assistantMessageId: null,
    },
    createdAt: UPDATED_AT,
    updatedAt: UPDATED_AT,
    archivedAt: null,
    session: {
      threadId: THREAD_ID,
      status: "ready",
      providerName: "Codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: UPDATED_AT,
    },
    latestUserMessageAt: UPDATED_AT,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    conversationPreview: null,
    environmentId: EnvironmentId.make("environment-local"),
  } as EnvironmentThreadShell;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.markUnread.mockReset();
});

afterEach(() => {
  document.body.replaceChildren();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("AgentsUnreadTracker", () => {
  it("marks a settling turn unread while mounted on a normal route", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const availability = [
      { environmentId: EnvironmentId.make("environment-local"), status: "live" as const },
    ];
    const render = (shells: EnvironmentThreadShell[]) =>
      root.render(
        <AgentsUnreadTracker
          shells={shells}
          projects={[]}
          environments={[]}
          availability={availability}
        />,
      );
    await act(async () => render([shell("running")]));
    expect(h.markUnread).not.toHaveBeenCalled();

    await act(async () => render([shell("completed")]));

    expect(h.markUnread).toHaveBeenCalledExactlyOnceWith("environment-local:thread-settling");
    expect(container.childElementCount).toBe(0);
    await act(async () => root.unmount());
  });
});
