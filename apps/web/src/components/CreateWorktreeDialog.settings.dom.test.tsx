// @vitest-environment happy-dom

// Complete caller for #185: the Default Agent control in Settings writes the primary-server
// setting, the primary config update comes back through the real settings hook, and the next
// Create Worktree dialog preselects that agent and creates the thread with it.

import { scopeProjectRef } from "@bibcode/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  type ScopedProjectRef,
  type ServerSettings,
} from "@bibcode/contracts";
import { RegistryContext } from "@effect/atom-react";
import { createContext, useContext, type ReactNode } from "react";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const PRIMARY_ENVIRONMENT_ID = EnvironmentId.make("local");
const REMOTE_ENVIRONMENT_ID = EnvironmentId.make("remote");
const PROJECT_ID = ProjectId.make("project-one");

const h = await vi.hoisted(async () => {
  const { Atom, AtomRegistry } = await import("effect/reactivity");
  const { DEFAULT_SERVER_SETTINGS: settings } = await import("@bibcode/contracts");
  const provider = (instanceId: string) => ({
    instanceId,
    driver: instanceId,
    enabled: true,
    installed: true,
    status: "ready",
    models: [],
  });
  const initialConfig = {
    environment: { label: "Local" },
    providers: [provider("codex"), provider("claudeAgent")],
    settings,
  };
  // The primary server's config projection: Settings and the dialog both derive from it.
  const primaryConfigAtom = Atom.make<Record<string, unknown> & { settings: typeof settings }>(
    initialConfig,
  );
  // Another server keeps its own persisted settings, with the built-in Default Agent.
  const remoteConfig = { ...initialConfig, environment: { label: "Build server" } };
  const project = (environmentId: string) => ({
    id: "project-one",
    environmentId,
    title: "BiBCode",
    workspaceRoot: "/repo",
    defaultModelSelection: null,
  });
  return {
    registry: AtomRegistry.make(),
    initialConfig,
    primaryConfigAtom,
    primaryServerSettingsAtom: Atom.make((get) => get(primaryConfigAtom).settings),
    primaryServerProvidersAtom: Atom.make(
      (get) => get(primaryConfigAtom)["providers"] as ReadonlyArray<unknown>,
    ),
    serverConfigsAtom: Atom.make(
      (get) =>
        new Map<string, unknown>([
          ["local", get(primaryConfigAtom)],
          ["remote", remoteConfig],
        ]),
    ),
    projects: [project("local"), project("remote")],
    updateSettings: { key: "server.updateSettings" },
    createManaged: { key: "worktree.createManaged" },
    createWorktree: vi.fn(),
    settingsUpdates: [] as unknown[],
  };
});

vi.mock("~/state/server", () => ({
  primaryServerSettingsAtom: h.primaryServerSettingsAtom,
  primaryServerProvidersAtom: h.primaryServerProvidersAtom,
  serverEnvironment: {
    settingsValueAtom: () => h.primaryServerSettingsAtom,
    updateSettings: h.updateSettings,
  },
}));

vi.mock("~/state/environments", () => ({
  usePrimaryEnvironment: () => ({ environmentId: "local" }),
  usePrimaryEnvironmentId: () => "local",
  // Settings → Agents also mounts Agent integrations, which picks among connected environments.
  useEnvironments: () => ({
    environments: [
      {
        environmentId: "local",
        label: "local",
        connection: { phase: "connected" },
        serverConfig: null,
      },
    ],
    isReady: true,
  }),
  useEnvironment: (environmentId: string | null) =>
    environmentId === null ? null : { label: environmentId, connection: { phase: "connected" } },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => {
    if (command === h.updateSettings) {
      // The server persists the patch and its config stream delivers the new settings.
      // Settings sends whole top-level values here (the Default Agent selection), so a shallow
      // merge is the server's result.
      return async (request: { input: { patch: Partial<ServerSettings> } }) => {
        h.settingsUpdates.push(request);
        h.registry.update(h.primaryConfigAtom, (config) => ({
          ...config,
          settings: { ...config.settings, ...request.input.patch },
        }));
        return { _tag: "Success", value: undefined };
      };
    }
    if (command === h.createManaged) return h.createWorktree;
    throw new Error(`Unexpected atom command: ${JSON.stringify(command)}`);
  },
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({
    persistence: {
      getClientSettings: async () => null,
      setClientSettings: async () => undefined,
    },
  }),
}));

vi.mock("~/state/entities", async () => {
  const { useAtomValue } = await import("@effect/atom-react");
  return {
    useProjects: () => h.projects,
    useServerConfigs: () => useAtomValue(h.serverConfigsAtom),
  };
});

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { refs: [] },
    error: null,
    isPending: false,
    refresh: vi.fn(),
    revalidate: vi.fn(),
    requiresRetry: false,
  }),
}));
vi.mock("~/state/vcs", () => ({ vcsEnvironment: { listRefs: () => ({ kind: "listRefs" }) } }));
// Settings → Agents also shows the Agents panel; it reads the agent activity.
vi.mock("~/state/mcpActivity", () => ({
  usePrimaryMcpActivity: () => ({ rows: [], active: [], canManage: false, environmentId: null }),
  usePrimaryMcpClients: () => [],
  usePrimaryAgentAccess: () => ({ environmentId: null, canRead: false, canManage: false }),
  takenOverLevel: () => null,
}));
// …and its header summarizes the webhook endpoints.
vi.mock("~/state/webhooks", () => ({
  useWebhookList: () => ({ data: null, error: null, refresh: vi.fn() }),
  isFailingEndpoint: () => false,
  webhooksEnvironment: {},
}));
vi.mock("~/state/worktrees", () => ({ worktreeEnvironment: { createManaged: h.createManaged } }));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("~/centerPanelStore", () => ({
  useCenterPanelStore: { getState: () => ({ replaceMainWithTerminal: vi.fn() }) },
}));
vi.mock("./ui/toast", () => ({
  toastManager: { add: vi.fn() },
  stackedThreadToast: (toast: unknown) => toast,
}));
vi.mock("./chat/ProviderModelPicker", () => ({ ProviderModelPicker: () => null }));
vi.mock("./chat/TraitsPicker", () => ({
  findProviderEffortDescriptor: () => null,
  TraitsPicker: () => null,
}));

// One Select stand-in for both surfaces: the trigger's label names it and each item is a button.
const SelectContext = createContext<((value: string) => void) | null>(null);
vi.mock("./ui/select", () => ({
  Select: (props: {
    value?: string;
    onValueChange?: (value: string) => void;
    children?: ReactNode;
  }) => (
    <SelectContext.Provider value={props.onValueChange ?? null}>
      <div data-select-value={props.value}>{props.children}</div>
    </SelectContext.Provider>
  ),
  SelectTrigger: (props: { "aria-label"?: string; children?: ReactNode }) => (
    <div data-select-label={props["aria-label"]}>{props.children}</div>
  ),
  SelectItem: (props: { value: string; children?: ReactNode }) => {
    const onValueChange = useContext(SelectContext);
    return (
      <button
        type="button"
        data-select-item={props.value}
        onClick={() => onValueChange?.(props.value)}
      >
        {props.children}
      </button>
    );
  },
  SelectGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SelectGroupLabel: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  SelectPopup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
}));
vi.mock("./ui/dialog", () => ({
  Dialog: (props: { open?: boolean; children?: ReactNode }) =>
    props.open ? <div data-testid="create-worktree">{props.children}</div> : null,
  DialogPopup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children?: ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children?: ReactNode }) => <header>{children}</header>,
  DialogPanel: ({ children }: { children?: ReactNode }) => <main>{children}</main>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}));

const { AgentsSettingsPanel } = await import("./settings/SettingsPanels");
const { CreateWorktreeDialog } = await import("./CreateWorktreeDialog");

function App({
  dialogOpen,
  projectRef,
}: {
  readonly dialogOpen: boolean;
  readonly projectRef: ScopedProjectRef;
}) {
  return (
    <RegistryContext.Provider value={h.registry}>
      <div data-testid="settings">
        <AgentsSettingsPanel />
      </div>
      <CreateWorktreeDialog
        open={dialogOpen}
        onOpenChange={() => {}}
        defaultProjectRef={projectRef}
      />
    </RegistryContext.Provider>
  );
}

function required<T extends Element>(parent: ParentNode, selector: string): T {
  const element = parent.querySelector<T>(selector);
  if (!element) throw new Error(`Missing element: ${selector}`);
  return element;
}

describe("Settings Default Agent reaches Create Worktree (#185)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    h.registry.set(h.primaryConfigAtom, h.initialConfig);
    h.settingsUpdates = [];
    h.createWorktree.mockReset().mockResolvedValue({
      _tag: "Success",
      value: { threadId: "thread-created", path: "/repo/.worktrees/x", refName: "x" },
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await React.act(async () => root.unmount());
    container.remove();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  it.each([
    ["the primary server", PRIMARY_ENVIRONMENT_ID],
    ["another server with its own persisted default", REMOTE_ENVIRONMENT_ID],
  ])("preselects the agent just chosen in Settings for a project on %s", async (_, target) => {
    const projectRef = scopeProjectRef(target, PROJECT_ID);
    await React.act(async () => root.render(<App dialogOpen={false} projectRef={projectRef} />));
    const settings = required<HTMLElement>(container, "[data-testid='settings']");
    const defaultAgentPicker = required<HTMLElement>(
      settings,
      "[data-select-label='Default Agent']",
    ).parentElement as HTMLElement;
    expect(defaultAgentPicker.dataset["selectValue"]).toBe("chat:codex");

    await React.act(async () =>
      required<HTMLButtonElement>(
        defaultAgentPicker,
        "[data-select-item='chat:claudeAgent']",
      ).click(),
    );
    expect(h.settingsUpdates).toEqual([
      {
        environmentId: "local",
        input: { patch: { defaultAgent: { kind: "chat", instanceId: "claudeAgent" } } },
      },
    ]);
    expect(defaultAgentPicker.dataset["selectValue"]).toBe("chat:claudeAgent");

    await React.act(async () => root.render(<App dialogOpen projectRef={projectRef} />));
    const dialog = required<HTMLElement>(container, "[data-testid='create-worktree']");
    const agentPicker = required<HTMLElement>(dialog, "[data-select-label='Agent']")
      .parentElement as HTMLElement;
    expect(agentPicker.dataset["selectValue"]).toBe("chat:claudeAgent");

    const nameInput = required<HTMLInputElement>(dialog, "input[placeholder='Worktree name']");
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await React.act(async () => {
      setValue?.call(nameInput, "agent-default");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const create = Array.from(dialog.querySelectorAll("button")).find((button) =>
      button.textContent?.startsWith("Create worktree"),
    );
    await React.act(async () => create?.click());

    expect(h.createWorktree).toHaveBeenCalledTimes(1);
    expect(h.createWorktree.mock.calls[0]?.[0]).toMatchObject({
      environmentId: target,
      input: {
        threadDefaults: { modelSelection: { instanceId: "claudeAgent" } },
      },
    });
  });
});
