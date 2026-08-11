// @vitest-environment happy-dom

import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type ServerProvider,
} from "@bibcode/contracts";
import { scopeThreadRef } from "@bibcode/client-runtime/environment";
import { AsyncResult } from "effect/unstable/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  environments: [] as unknown[],
  projects: [] as unknown[],
  createProject: vi.fn(),
  cloneRepository: vi.fn(),
  createThread: vi.fn(),
  navigate: vi.fn(),
  readEnvironmentThreadRefs: vi.fn(),
  readThreadShell: vi.fn(),
  replaceMainWithTerminal: vi.fn(),
  onOpenChange: vi.fn(),
}));

vi.mock("~/connection/useDesktopLocalBootstraps", () => ({
  useDesktopLocalBootstraps: () => [],
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => harness.navigate,
}));

vi.mock("~/centerPanelStore", () => ({
  useCenterPanelStore: {
    getState: () => ({ replaceMainWithTerminal: harness.replaceMainWithTerminal }),
  },
}));

vi.mock("~/state/environments", () => ({
  useEnvironments: () => ({
    isReady: true,
    networkStatus: "online",
    environments: harness.environments,
  }),
  usePrimaryEnvironment: () => harness.environments[0] ?? null,
}));

vi.mock("~/state/entities", () => ({
  useProjects: () => harness.projects,
  readEnvironmentThreadRefs: (environmentId: unknown) =>
    harness.readEnvironmentThreadRefs(environmentId),
  readThreadShell: (ref: unknown) => harness.readThreadShell(ref),
}));

vi.mock("~/state/projects", () => ({
  projectEnvironment: {
    create: { key: "project.create" },
  },
}));

vi.mock("~/state/vcs", () => ({
  vcsEnvironment: {
    clone: { key: "vcs.clone" },
  },
}));

vi.mock("~/state/threads", () => ({
  threadEnvironment: {
    create: { key: "thread.create" },
  },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { readonly key?: string }) => {
    if (command.key === "project.create") {
      return (input: unknown) => harness.createProject(input);
    }
    if (command.key === "vcs.clone") {
      return (input: unknown) => harness.cloneRepository(input);
    }
    if (command.key === "thread.create") {
      return (input: unknown) => harness.createThread(input);
    }
    throw new Error(`Unexpected atom command: ${String(command.key)}`);
  },
}));

import { useAddProjectWorkflow, type AddProjectWorkflow } from "./useAddProjectWorkflow";

const environmentId = EnvironmentId.make("public-workflow");
const defaultThreadId = ThreadId.make("canonical-main");
const codexInstanceId = ProviderInstanceId.make("codex");
const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
const expectedSelection: ModelSelection = {
  instanceId: codexInstanceId,
  model: "gpt-5.4",
  options: [
    { id: "reasoningEffort", value: "high" },
    { id: "serviceTier", value: "fast" },
  ],
};

const provider: ServerProvider = {
  instanceId: codexInstanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-07-20T00:00:00.000Z",
  models: [
    {
      slug: "gpt-5.4",
      name: "GPT-5.4",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "medium", label: "Medium", isDefault: true },
              { id: "high", label: "High" },
            ],
            currentValue: "medium",
          },
          {
            id: "serviceTier",
            label: "Service tier",
            type: "select",
            options: [
              { id: "default", label: "Default", isDefault: true },
              { id: "fast", label: "Fast" },
            ],
            currentValue: "default",
          },
        ],
      },
    },
  ],
  slashCommands: [],
  skills: [],
  agents: [],
};
const claudeProvider: ServerProvider = {
  ...provider,
  instanceId: claudeInstanceId,
  driver: ProviderDriverKind.make("claudeAgent"),
  models: [
    {
      slug: "claude-opus-4-1",
      name: "Claude Opus 4.1",
      isCustom: false,
      capabilities: {},
    },
  ],
};

let currentWorkflow: AddProjectWorkflow;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

function WorkflowProbe() {
  currentWorkflow = useAddProjectWorkflow({
    open: true,
    onOpenChange: harness.onOpenChange,
  });
  return null;
}

async function mountWorkflow(): Promise<AddProjectWorkflow> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<WorkflowProbe />));
  return currentWorkflow;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.environments = [
    {
      environmentId,
      label: "Local",
      displayUrl: "http://localhost:4317",
      relayManaged: false,
      entry: {
        target: {
          _tag: "PrimaryConnectionTarget",
          environmentId,
          label: "Local",
          httpBaseUrl: "http://localhost:4317",
          wsBaseUrl: "ws://localhost:4317",
        },
      },
      connection: { phase: "connected", error: null, traceId: null },
      serverConfig: {
        environment: {
          environmentId,
          label: "Local",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.2.3",
          capabilities: { repositoryIdentity: true },
        },
        providers: [provider, claudeProvider],
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          addProjectBaseDirectory: "/code/",
          defaultAgent: { kind: "chat", instanceId: claudeInstanceId },
          providerSessionDefaults: {
            ...DEFAULT_SERVER_SETTINGS.providerSessionDefaults,
            codex: { model: expectedSelection.model, options: expectedSelection.options },
            claudeAgent: { model: "claude-opus-4-1", options: [] },
          },
        },
      },
    },
  ];
  harness.projects = [];
  harness.createProject.mockReset().mockImplementation(async (command) => {
    const input = command as { readonly input: { readonly projectId: string } };
    return AsyncResult.success({ projectId: input.input.projectId, threadId: defaultThreadId });
  });
  harness.cloneRepository
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ path: "/code/cloned" }));
  harness.createThread.mockReset().mockResolvedValue(AsyncResult.success({ sequence: 1 }));
  harness.navigate.mockReset().mockResolvedValue(undefined);
  harness.readEnvironmentThreadRefs.mockReset().mockReturnValue([]);
  harness.readThreadShell.mockReset().mockReturnValue(null);
  harness.replaceMainWithTerminal.mockReset();
  harness.onOpenChange.mockReset();
});

afterEach(async () => {
  if (root !== null) {
    await act(async () => root?.unmount());
  }
  container?.remove();
  root = null;
  container = null;
  document.body.replaceChildren();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("useAddProjectWorkflow public adapter", () => {
  it.each(["add", "clone", "create"] as const)(
    "opens canonical Main with the selected chat default for the %s flow",
    async (flow) => {
      const workflow = await mountWorkflow();

      if (flow === "add") {
        act(() => currentWorkflow.setHostPath("/code/added"));
        await act(async () => currentWorkflow.submitHostPath());
      } else if (flow === "clone") {
        act(() => currentWorkflow.openClone());
        act(() => currentWorkflow.setCloneUrl("https://example.test/repository.git"));
        act(() => currentWorkflow.setCloneParent("/code"));
        await act(async () => currentWorkflow.submitClone());
      } else {
        act(() => currentWorkflow.openCreate());
        act(() => currentWorkflow.setCreateName("created"));
        act(() => currentWorkflow.setCreateParent("/code"));
        await act(async () => currentWorkflow.submitCreate());
      }

      expect(workflow.selectedHost.environmentId).toBe(environmentId);
      expect(harness.createProject).toHaveBeenCalledTimes(1);
      expect(harness.createProject.mock.calls[0]?.[0]).toMatchObject({
        environmentId,
        input: {
          defaultModelSelection: expect.objectContaining({ instanceId: claudeInstanceId }),
        },
      });
      expect(harness.navigate).toHaveBeenCalledWith({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: defaultThreadId },
      });
      expect(harness.replaceMainWithTerminal).not.toHaveBeenCalled();
      expect(harness.onOpenChange).toHaveBeenCalledWith(false);
    },
  );

  it("replaces canonical Main with the selected terminal default", async () => {
    const environment = harness.environments[0] as {
      serverConfig: { settings: typeof DEFAULT_SERVER_SETTINGS };
    };
    environment.serverConfig.settings = {
      ...environment.serverConfig.settings,
      defaultAgent: { kind: "terminal", instanceId: codexInstanceId },
    };
    await mountWorkflow();

    act(() => currentWorkflow.setHostPath("/code/terminal"));
    await act(async () => currentWorkflow.submitHostPath());

    expect(harness.createProject.mock.calls[0]?.[0]).toMatchObject({
      environmentId,
      input: {
        defaultModelSelection: expect.objectContaining({ instanceId: codexInstanceId }),
      },
    });
    expect(harness.replaceMainWithTerminal).toHaveBeenCalledWith(
      scopeThreadRef(environmentId, defaultThreadId),
      [],
      expect.objectContaining({
        label: "Codex Terminal",
        command: expect.objectContaining({ executable: "codex" }),
      }),
    );
    expect(harness.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: defaultThreadId },
    });
  });

  it("falls back from an unavailable saved provider to the first ready chat", async () => {
    const environment = harness.environments[0] as {
      serverConfig: {
        providers: ServerProvider[];
        settings: typeof DEFAULT_SERVER_SETTINGS;
      };
    };
    environment.serverConfig.providers = [claudeProvider, provider];
    environment.serverConfig.settings = {
      ...environment.serverConfig.settings,
      defaultAgent: {
        kind: "terminal",
        instanceId: ProviderInstanceId.make("missing-provider"),
      },
    };
    await mountWorkflow();

    act(() => currentWorkflow.setHostPath("/code/fallback"));
    await act(async () => currentWorkflow.submitHostPath());

    expect(harness.createProject.mock.calls[0]?.[0]).toMatchObject({
      input: {
        defaultModelSelection: expect.objectContaining({ instanceId: claudeInstanceId }),
      },
    });
    expect(harness.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: defaultThreadId },
    });
  });

  it("uses project.create to find an existing registered project's canonical Main before the thread cache arrives", async () => {
    const existingProjectId = "existing-project";
    const canonicalProjectId = "canonical-project";
    const canonicalThreadId = ThreadId.make("canonical-existing-main");
    harness.projects = [
      {
        id: existingProjectId,
        environmentId,
        workspaceRoot: "/code/existing",
      },
    ];
    harness.createProject.mockResolvedValueOnce(
      AsyncResult.success({ projectId: canonicalProjectId, threadId: canonicalThreadId }),
    );
    await mountWorkflow();

    act(() => currentWorkflow.setHostPath("/code/existing"));
    await act(async () => currentWorkflow.submitHostPath());

    expect(harness.createProject).toHaveBeenCalledWith({
      environmentId,
      input: expect.objectContaining({
        workspaceRoot: "/code/existing",
        createWorkspaceRootIfMissing: false,
        initializeGit: false,
      }),
    });
    expect(harness.createProject.mock.calls[0]?.[0].input.projectId).not.toBe(existingProjectId);
    expect(harness.createThread).not.toHaveBeenCalled();
    expect(harness.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: canonicalThreadId },
    });
  });

  it("creates the legacy safety-net default thread when canonicalization returns no Main", async () => {
    const existingProjectId = "legacy-project";
    harness.projects = [
      {
        id: existingProjectId,
        environmentId,
        workspaceRoot: "/code/legacy",
      },
    ];
    harness.createProject.mockResolvedValueOnce(
      AsyncResult.success({ projectId: existingProjectId }),
    );
    await mountWorkflow();

    act(() => currentWorkflow.setHostPath("/code/legacy"));
    await act(async () => currentWorkflow.submitHostPath());

    expect(harness.createProject).toHaveBeenCalledTimes(1);
    expect(harness.createThread).toHaveBeenCalledWith({
      environmentId,
      input: expect.objectContaining({
        projectId: existingProjectId,
        modelSelection: expect.objectContaining({ instanceId: claudeInstanceId }),
      }),
    });
    expect(harness.createThread.mock.calls[0]?.[0].input).not.toHaveProperty("kind");
    expect(harness.createThread.mock.calls[0]?.[0].input).not.toHaveProperty("worktreePath");
    const createdThreadId = harness.createThread.mock.calls[0]?.[0].input.threadId;
    expect(harness.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: createdThreadId },
    });
  });

  it("keeps the canonical Main chat fallback when no provider is ready", async () => {
    const environment = harness.environments[0] as {
      serverConfig: {
        providers: ServerProvider[];
        settings: typeof DEFAULT_SERVER_SETTINGS;
      };
    };
    environment.serverConfig.providers = [
      { ...provider, status: "error" },
      { ...claudeProvider, status: "error" },
    ];
    environment.serverConfig.settings = {
      ...environment.serverConfig.settings,
      defaultAgent: { kind: "terminal", instanceId: codexInstanceId },
    };
    await mountWorkflow();

    act(() => currentWorkflow.setHostPath("/code/no-ready-provider"));
    await act(async () => currentWorkflow.submitHostPath());

    expect(harness.createProject.mock.calls[0]?.[0]).toMatchObject({
      input: {
        defaultModelSelection: expect.objectContaining({ instanceId: codexInstanceId }),
      },
    });
    expect(harness.replaceMainWithTerminal).not.toHaveBeenCalled();
    expect(harness.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: defaultThreadId },
    });
  });
});
