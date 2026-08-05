import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { Thread } from "./types";
import { resolveThreadProviderBinding } from "./threadProviderBinding";

const now = "2026-08-04T00:00:00.000Z";
const threadId = ThreadId.make("thread-binding");
const codexInstanceId = ProviderInstanceId.make("codex");
const claudeInstanceId = ProviderInstanceId.make("claude");

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
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: now,
    models: [],
    slashCommands: [],
    skills: [],
    agents: [],
  };
}

const codexProvider = provider(codexInstanceId, "codex", "Codex");
const claudeProvider = provider(claudeInstanceId, "claude", "Claude");

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: threadId,
    environmentId: EnvironmentId.make("environment-local"),
    projectId: ProjectId.make("project-binding"),
    title: "Binding",
    modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

describe("resolveThreadProviderBinding", () => {
  it("uses a legacy session driver instead of contradictory model and composer instances", () => {
    const binding = resolveThreadProviderBinding({
      thread: thread({
        modelSelection: { instanceId: claudeInstanceId, model: "claude-sonnet" },
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
      }),
      projectDefaultModelSelection: null,
      selectedProviderInstanceId: claudeInstanceId,
      providers: [codexProvider, claudeProvider],
    });

    expect(binding).toMatchObject({
      instanceId: "codex",
      driver: "codex",
      status: { instanceId: "codex" },
      lockedProvider: "codex",
      lockedProviderInstanceId: null,
    });
  });

  it("rejects a session instance whose live driver contradicts the authoritative session driver", () => {
    const binding = resolveThreadProviderBinding({
      thread: thread({
        modelSelection: { instanceId: claudeInstanceId, model: "claude-sonnet" },
        session: {
          threadId,
          status: "ready",
          providerName: "codex",
          providerInstanceId: claudeInstanceId,
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: now,
        },
      }),
      projectDefaultModelSelection: null,
      selectedProviderInstanceId: claudeInstanceId,
      providers: [codexProvider, claudeProvider],
    });

    expect(binding).toMatchObject({
      instanceId: "codex",
      driver: "codex",
      status: { instanceId: "codex" },
      lockedProvider: "codex",
      lockedProviderInstanceId: null,
    });
  });

  it("preserves an exact started binding when no authoritative driver metadata exists", () => {
    const customInstanceId = ProviderInstanceId.make("codex_personal");
    const binding = resolveThreadProviderBinding({
      thread: thread({
        modelSelection: { instanceId: customInstanceId, model: "gpt-5.4" },
        messages: [{ id: "started" } as never],
      }),
      projectDefaultModelSelection: null,
      selectedProviderInstanceId: claudeInstanceId,
      providers: [claudeProvider],
    });

    expect(binding).toMatchObject({
      instanceId: "codex_personal",
      driver: null,
      status: null,
      lockedProvider: null,
      lockedProviderInstanceId: "codex_personal",
    });
  });

  it("keeps a pre-start live composer selection unlocked", () => {
    const binding = resolveThreadProviderBinding({
      thread: thread(),
      projectDefaultModelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
      selectedProviderInstanceId: claudeInstanceId,
      providers: [codexProvider, claudeProvider],
    });

    expect(binding).toMatchObject({
      instanceId: "claude",
      driver: "claude",
      status: { instanceId: "claude" },
      lockedProvider: null,
      lockedProviderInstanceId: null,
    });
  });
});
