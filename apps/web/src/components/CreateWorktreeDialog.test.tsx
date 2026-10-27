import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@bibcode/client-runtime/environment";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ScopedProjectRef,
} from "@bibcode/contracts";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type EffectCallback = () => void | (() => void);

const browserRuntime =
  typeof document !== "undefined" && typeof document.createElement === "function";
const staticDescribe = browserRuntime ? describe.skip : describe;

const hooks = vi.hoisted(() => {
  let cursor = 0;
  let stateSlots = new Map<number, unknown>();
  let refSlots = new Map<number, { current: unknown }>();

  return {
    effects: [] as EffectCallback[],
    beginRender() {
      cursor = 0;
      this.effects = [];
    },
    reset() {
      cursor = 0;
      stateSlots = new Map();
      refSlots = new Map();
      this.effects = [];
    },
    runEffects() {
      for (const effect of this.effects) effect();
    },
    useCallback<T>(callback: T): T {
      cursor += 1;
      return callback;
    },
    useMemo<T>(factory: () => T): T {
      cursor += 1;
      return factory();
    },
    useRef<T>(initialValue: T): { current: T } {
      const index = cursor++;
      const existing = refSlots.get(index);
      if (existing) return existing as { current: T };
      const ref = { current: initialValue };
      refSlots.set(index, ref);
      return ref;
    },
    useState<T>(initialValue: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
      const index = cursor++;
      if (!stateSlots.has(index)) {
        stateSlots.set(
          index,
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue,
        );
      }
      const setValue: Dispatch<SetStateAction<T>> = (nextValue) => {
        const previous = stateSlots.get(index) as T;
        stateSlots.set(
          index,
          typeof nextValue === "function" ? (nextValue as (value: T) => T)(previous) : nextValue,
        );
      };
      return [stateSlots.get(index) as T, setValue];
    },
    useEffect(effect: EffectCallback) {
      cursor += 1;
      this.effects.push(effect);
    },
  };
});

interface CapturedButtonProps {
  readonly "aria-pressed"?: boolean;
  readonly disabled?: boolean;
  readonly onClick?: () => void;
  readonly children?: ReactNode;
  readonly variant?: string;
}

interface CapturedInputProps {
  readonly ref?: React.Ref<HTMLInputElement>;
  readonly placeholder?: string;
  readonly value?: string;
  readonly onChange?: (event: { target: { value: string } }) => void;
}

interface CapturedSelectProps {
  readonly value?: string;
  readonly onValueChange?: (value: unknown) => void;
  readonly items?: ReadonlyArray<{ readonly value: string; readonly label: string }>;
  readonly children?: ReactNode;
}

interface CapturedDialogProps {
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly children?: ReactNode;
}

interface CapturedDialogPopupProps {
  readonly onKeyDown?: (event: {
    readonly ctrlKey: boolean;
    readonly metaKey: boolean;
    readonly key: string;
    readonly preventDefault: () => void;
  }) => void;
  readonly children?: ReactNode;
}

const captured = vi.hoisted(() => ({
  buttons: [] as CapturedButtonProps[],
  inputs: [] as CapturedInputProps[],
  selects: [] as CapturedSelectProps[],
  dialogs: [] as CapturedDialogProps[],
  popups: [] as CapturedDialogPopupProps[],
  collapsibles: [] as Array<{ open?: boolean; onOpenChange?: (open: boolean) => void }>,
  switches: [] as Array<{ checked?: boolean; onCheckedChange?: (checked: boolean) => void }>,
  clear() {
    this.buttons = [];
    this.inputs = [];
    this.selects = [];
    this.dialogs = [];
    this.popups = [];
    this.collapsibles = [];
    this.switches = [];
  },
}));

const testState = vi.hoisted(() => ({
  projects: [] as Array<Record<string, unknown>>,
  serverConfigs: new Map<string, Record<string, unknown>>(),
  // The primary-server settings that Settings → Default Agent reads and writes.
  primarySettings: {} as Record<string, unknown>,
  labelledConfigs: new WeakMap<object, Record<string, unknown>>(),
  connectionPhases: new Map<string, string>(),
  refs: [] as Array<{
    name: string;
    isRemote?: boolean;
    remoteName?: string;
    current?: boolean;
    worktreePath?: string | null;
  }>,
  queryAtoms: [] as unknown[],
  refsError: null as string | null,
  refreshRefs: vi.fn(),
  createWorktree: vi.fn(),
  replaceMainWithTerminal: vi.fn(),
  updateSettings: vi.fn(),
  navigate: vi.fn(),
  onOpenChange: vi.fn(),
  toastAdd: vi.fn(),
  nextThreadId: "thread-created",
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => testState.navigate }));

vi.mock("@bibcode/client-runtime/state/runtime", () => ({
  isAtomCommandInterrupted: (result: { interrupted?: boolean }) => result.interrupted === true,
  squashAtomCommandFailure: (result: { error?: unknown }) => result.error,
}));

vi.mock("~/lib/utils", () => ({
  cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
  newCommandId: () => "command-create-worktree",
  newThreadId: () => testState.nextThreadId,
}));

vi.mock("~/state/entities", () => ({
  useProjects: () => testState.projects,
  // Fixtures may omit the environment descriptor; give each config a stable labelled copy.
  useServerConfigs: () => {
    const configs = new Map<string, Record<string, unknown>>();
    for (const [environmentId, config] of testState.serverConfigs) {
      let labelled = testState.labelledConfigs.get(config);
      if (!labelled) {
        labelled = { environment: { label: `${environmentId} server` }, ...config };
        testState.labelledConfigs.set(config, labelled);
      }
      configs.set(environmentId, labelled);
    }
    return configs;
  },
}));

vi.mock("~/hooks/useSettings", () => ({
  usePrimaryDefaultAgent: () => testState.primarySettings["defaultAgent"],
}));

// Each environment is connected unless a test sets its supervisor phase.
vi.mock("~/state/environments", () => ({
  usePrimaryEnvironmentId: () => "local",
  useEnvironment: (environmentId: string | null) => {
    if (environmentId === null) return null;
    const config = testState.serverConfigs.get(environmentId) as
      | { environment?: { label?: string } }
      | undefined;
    return {
      label: config?.environment?.label ?? `${environmentId} server`,
      connection: { phase: testState.connectionPhases.get(environmentId) ?? "connected" },
    };
  },
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => {
    testState.queryAtoms.push(atom);
    return {
      data: testState.refsError ? undefined : atom ? { refs: testState.refs } : null,
      error: testState.refsError,
      isPending: false,
      refresh: testState.refreshRefs,
      revalidate: testState.refreshRefs,
      requiresRetry: false,
    };
  },
}));

vi.mock("~/state/vcs", () => ({
  vcsEnvironment: {
    listRefs: (args: unknown) => ({ kind: "vcs.listRefs", args }),
  },
}));

vi.mock("~/state/worktrees", () => ({
  worktreeEnvironment: { createManaged: "worktree.createManaged" },
}));

vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => testState.createWorktree,
}));

vi.mock("~/centerPanelStore", () => ({
  useCenterPanelStore: {
    getState: () => ({ replaceMainWithTerminal: testState.replaceMainWithTerminal }),
  },
}));

vi.mock("./ui/toast", () => ({
  toastManager: { add: testState.toastAdd },
  stackedThreadToast: (toast: Record<string, unknown>) => ({ ...toast, stacked: true }),
}));

vi.mock("./ui/button", () => ({
  Button: (props: CapturedButtonProps) => {
    captured.buttons.push(props);
    return (
      <button
        type="button"
        aria-pressed={props["aria-pressed"]}
        disabled={props.disabled}
        onClick={props.onClick}
      >
        {props.children}
      </button>
    );
  },
}));

vi.mock("./ui/input", () => ({
  Input: (props: CapturedInputProps) => {
    captured.inputs.push(props);
    return (
      <input
        ref={props.ref}
        value={props.value}
        placeholder={props.placeholder}
        readOnly={typeof document === "undefined"}
        onChange={props.onChange}
      />
    );
  },
}));

vi.mock("./ui/select", () => ({
  Select: (props: CapturedSelectProps) => {
    captured.selects.push(props);
    return <div data-select-value={props.value}>{props.children}</div>;
  },
  SelectGroup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SelectGroupLabel: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  SelectItem: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  SelectPopup: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  SelectTrigger: (props: { "aria-describedby"?: string; children?: ReactNode }) => (
    <div data-select-trigger="" aria-describedby={props["aria-describedby"]}>
      {props.children}
    </div>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
}));

vi.mock("./ui/dialog", () => ({
  Dialog: (props: CapturedDialogProps) => {
    captured.dialogs.push(props);
    return props.open ? <div>{props.children}</div> : null;
  },
  DialogPopup: (props: CapturedDialogPopupProps) => {
    captured.popups.push(props);
    return (
      <div data-testid="dialog-popup" onKeyDown={props.onKeyDown}>
        {props.children}
      </div>
    );
  },
  DialogDescription: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children?: ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children?: ReactNode }) => <header>{children}</header>,
  DialogPanel: ({ children }: { children?: ReactNode }) => <main>{children}</main>,
  DialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("./ui/collapsible", () => ({
  Collapsible: (props: {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    children?: ReactNode;
  }) => {
    captured.collapsibles.push(props);
    return <div>{props.children}</div>;
  },
  CollapsibleTrigger: ({ children }: { children?: ReactNode }) => (
    <button type="button">{children}</button>
  ),
  CollapsiblePanel: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("./ui/switch", () => ({
  Switch: (props: { checked?: boolean; onCheckedChange?: (checked: boolean) => void }) => {
    captured.switches.push(props);
    return <input type="checkbox" checked={props.checked} readOnly />;
  },
}));

vi.mock("./ui/kbd", () => ({
  Kbd: ({ children }: { children?: ReactNode }) => <kbd>{children}</kbd>,
}));

if (!browserRuntime) {
  vi.doMock("react", async () => {
    const actual = await vi.importActual<typeof import("react")>("react");
    return {
      ...actual,
      useCallback: hooks.useCallback,
      useMemo: hooks.useMemo,
      useRef: hooks.useRef,
      useState: hooks.useState,
      useEffect: hooks.useEffect.bind(hooks),
    };
  });
  vi.doMock("react/compiler-runtime", () => ({
    c: (size: number) =>
      Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel")),
  }));
}

const { CreateWorktreeDialog } = await import("./CreateWorktreeDialog");

const ENVIRONMENT_ID = EnvironmentId.make("local");
const PROJECT_ID = ProjectId.make("project-one");
const PROJECT_REF = scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID);

function project(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    title: "BiBCode",
    workspaceRoot: "/repo",
    defaultModelSelection: null,
    ...overrides,
  };
}

function readyProvider(instanceId: string, overrides: Record<string, unknown> = {}) {
  return {
    instanceId,
    driver: instanceId,
    enabled: true,
    installed: true,
    status: "ready",
    models: [],
    ...overrides,
  };
}

function serverConfig(
  providers: ReadonlyArray<Record<string, unknown>>,
  settings: Record<string, unknown> = DEFAULT_SERVER_SETTINGS,
  label = "Local",
): Record<string, unknown> {
  return { environment: { label }, providers, settings };
}

function setDefaultAgent(kind: "chat" | "terminal", instanceId: string): void {
  testState.primarySettings = {
    ...testState.primarySettings,
    defaultAgent: { kind, instanceId: ProviderInstanceId.make(instanceId) },
  };
}

function success(value: unknown) {
  return { _tag: "Success", value };
}

function failure(error: unknown, interrupted = false) {
  return { _tag: "Failure", error, interrupted };
}

function collectText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("");
  if (typeof node === "object" && "props" in node) {
    return collectText((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

function render(open = true, defaultProjectRef?: ScopedProjectRef | null): string {
  const renderPass = () => {
    hooks.beginRender();
    return renderToStaticMarkup(
      <CreateWorktreeDialog
        open={open}
        onOpenChange={testState.onOpenChange}
        {...(defaultProjectRef === undefined ? {} : { defaultProjectRef })}
      />,
    );
  };
  renderPass();
  hooks.runEffects();
  captured.clear();
  renderPass();
  hooks.runEffects();
  captured.clear();
  return renderPass();
}

function button(label: string): CapturedButtonProps {
  const match = captured.buttons.find((candidate) =>
    collectText(candidate.children).includes(label),
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}

function input(placeholder: string): CapturedInputProps {
  const match = captured.inputs.find((candidate) => candidate.placeholder === placeholder);
  if (!match) throw new Error(`Missing input: ${placeholder}`);
  return match;
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

function resetScenario(): void {
  hooks.reset();
  captured.clear();
  testState.projects = [project()];
  testState.primarySettings = DEFAULT_SERVER_SETTINGS;
  testState.connectionPhases = new Map();
  testState.serverConfigs = new Map([[ENVIRONMENT_ID, serverConfig([readyProvider("codex")])]]);
  testState.refs = [];
  testState.refsError = null;
  testState.queryAtoms = [];
  testState.refreshRefs.mockReset();
  testState.createWorktree.mockReset().mockResolvedValue(
    success({
      threadId: testState.nextThreadId,
      path: "/repo/.worktrees/feature",
      refName: "feature",
    }),
  );
  testState.replaceMainWithTerminal.mockReset();
  testState.updateSettings.mockReset();
  testState.navigate.mockReset();
  testState.onOpenChange.mockReset();
  testState.toastAdd.mockReset();
  testState.nextThreadId = "thread-created";
}

staticDescribe("CreateWorktreeDialog", () => {
  beforeEach(() => {
    resetScenario();
    vi.stubGlobal("window", {
      requestAnimationFrame: vi.fn((callback: () => void) => {
        callback();
        return 1;
      }),
      cancelAnimationFrame: vi.fn(),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function submitWorktree(): Promise<void> {
    render();
    input("Worktree name").onChange?.({ target: { value: "agent-selection" } });
    render();
    button("Create worktree").onClick?.();
    await flushPromises();
  }

  it("keeps a closed dialog inert and skips branch discovery without a project", () => {
    testState.projects = [];
    const markup = render(false);

    expect(markup).toBe("");
    expect(captured.dialogs[0]?.open).toBe(false);
    expect(testState.queryAtoms.at(-1)).toBeNull();
    expect(window.cancelAnimationFrame).not.toHaveBeenCalled();
  });

  it("adopts an explicit row target when opening after mounting closed", () => {
    const targetProjectId = ProjectId.make("project-two");
    const targetEnvironmentId = EnvironmentId.make("remote");
    testState.projects = [
      project(),
      project({
        id: targetProjectId,
        environmentId: targetEnvironmentId,
        title: "Remote project",
        workspaceRoot: "/remote/repo",
      }),
    ];

    render(false, PROJECT_REF);
    render(true, scopeProjectRef(targetEnvironmentId, targetProjectId));

    expect(captured.selects[0]?.value).toBe(
      scopedProjectKey(scopeProjectRef(targetEnvironmentId, targetProjectId)),
    );
    expect(testState.queryAtoms.at(-1)).toEqual({
      kind: "vcs.listRefs",
      args: {
        environmentId: targetEnvironmentId,
        input: { cwd: "/remote/repo", query: undefined, limit: 200 },
      },
    });
  });

  it("preserves an open dialog's selected project across unrelated project updates", () => {
    const secondProjectId = ProjectId.make("project-two");
    testState.projects = [project(), project({ id: secondProjectId, title: "Second" })];

    render(true, PROJECT_REF);
    captured.selects[0]?.onValueChange?.(
      scopedProjectKey(scopeProjectRef(ENVIRONMENT_ID, secondProjectId)),
    );
    testState.projects = [...testState.projects];
    render(true, PROJECT_REF);

    expect(captured.selects[0]?.value).toBe(
      scopedProjectKey(scopeProjectRef(ENVIRONMENT_ID, secondProjectId)),
    );
  });

  it("selects the first project, filters providers, and requests refs for smart mode", () => {
    testState.serverConfigs.set(ENVIRONMENT_ID, {
      providers: [
        {
          instanceId: "claude",
          driver: "claudeAgent",
          displayName: "Claude",
          enabled: true,
          installed: true,
          status: "ready",
          models: [{ slug: "sonnet", name: "Sonnet", isCustom: false, capabilities: null }],
        },
        {
          instanceId: "disabled",
          driver: "codex",
          enabled: false,
          installed: true,
          status: "ready",
          models: [],
        },
        {
          instanceId: "missing",
          driver: "codex",
          enabled: true,
          installed: false,
          status: "ready",
          models: [],
        },
      ],
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {},
        providerInstances: {
          claude: { driver: "claudeAgent" },
        },
      },
    });

    const markup = render();

    expect(captured.selects[0]?.value).toBe(scopedProjectKey(PROJECT_REF));
    expect(captured.selects[1]?.value).toBe("chat:claude");
    expect(captured.selects[1]?.items).toEqual([
      { value: "chat:claude", label: "Claude" },
      { value: "terminal:claude", label: "Claude Terminal" },
    ]);
    expect(testState.queryAtoms.at(-1)).toEqual({
      kind: "vcs.listRefs",
      args: {
        environmentId: ENVIRONMENT_ID,
        input: { cwd: "/repo", query: undefined, limit: 200 },
      },
    });
    expect(markup).toContain("Interpreting as:");
    expect(input("Type #1234 or search branches").value).toBe("");
  });

  it("adopts the first scoped project when projects load after the dialog opens", () => {
    testState.projects = [];
    render();
    expect(captured.selects[0]?.value).toBeUndefined();

    testState.projects = [project()];
    render();

    expect(captured.selects[0]?.value).toBe(scopedProjectKey(PROJECT_REF));
    expect(testState.queryAtoms.at(-1)).toEqual({
      kind: "vcs.listRefs",
      args: {
        environmentId: ENVIRONMENT_ID,
        input: { cwd: "/repo", query: undefined, limit: 200 },
      },
    });
  });

  it("uses canonical and configured provider names in the Agent selector", () => {
    testState.serverConfigs.set(ENVIRONMENT_ID, {
      providers: [
        {
          instanceId: "cursor",
          driver: "cursor",
          enabled: true,
          installed: true,
          status: "ready",
          models: [],
        },
        {
          instanceId: "opencode",
          driver: "opencode",
          enabled: true,
          installed: true,
          status: "ready",
          models: [],
        },
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          status: "ready",
          models: [],
        },
        {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          enabled: true,
          installed: true,
          status: "ready",
          models: [],
        },
        {
          instanceId: "codex_personal",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          status: "ready",
          models: [],
        },
      ],
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {},
        providerInstances: {
          codex_personal: { driver: "codex", displayName: "Personal Codex" },
        },
      },
    });

    const markup = render();

    expect(captured.selects[1]?.items).toEqual([
      { value: "chat:cursor", label: "Cursor" },
      { value: "chat:opencode", label: "OpenCode" },
      { value: "chat:codex", label: "Codex" },
      { value: "chat:claudeAgent", label: "Claude" },
      { value: "chat:codex_personal", label: "Personal Codex" },
      { value: "terminal:cursor", label: "Cursor Terminal" },
      { value: "terminal:opencode", label: "OpenCode Terminal" },
      { value: "terminal:codex", label: "Codex Terminal" },
      { value: "terminal:claudeAgent", label: "Claude Terminal" },
      { value: "terminal:codex_personal", label: "Personal Codex Terminal" },
    ]);
    expect(markup).not.toContain("claudeAgent");
    expect(markup).toContain("Codex Terminal");
    expect(markup).not.toContain("Open Terminal");
    expect(markup).not.toContain("Add custom action");
  });

  it("preselects the saved chat default and creates Main with that provider", async () => {
    testState.serverConfigs.set(ENVIRONMENT_ID, {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          status: "ready",
          models: [],
        },
        {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          enabled: true,
          installed: true,
          status: "ready",
          models: [],
        },
      ],
      settings: DEFAULT_SERVER_SETTINGS,
    });
    setDefaultAgent("chat", "claudeAgent");

    render();
    expect(captured.selects[1]?.value).toBe("chat:claudeAgent");
    await submitWorktree();

    expect(testState.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          threadDefaults: expect.objectContaining({
            modelSelection: expect.objectContaining({ instanceId: "claudeAgent" }),
          }),
        }),
      }),
    );
    expect(testState.replaceMainWithTerminal).not.toHaveBeenCalled();
  });

  it("replaces Main with the saved AI terminal", async () => {
    testState.serverConfigs.set(ENVIRONMENT_ID, {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          status: "ready",
          models: [],
        },
      ],
      settings: DEFAULT_SERVER_SETTINGS,
    });
    setDefaultAgent("terminal", "codex");

    render();
    expect(captured.selects[1]?.value).toBe("terminal:codex");
    await submitWorktree();

    expect(testState.replaceMainWithTerminal).toHaveBeenCalledWith(
      scopeThreadRef(ENVIRONMENT_ID, ThreadId.make(testState.nextThreadId)),
      [],
      expect.objectContaining({
        label: "Codex Terminal",
        command: expect.objectContaining({ executable: "codex" }),
      }),
    );
  });

  it("uses a one-time override without updating settings", async () => {
    testState.serverConfigs.set(ENVIRONMENT_ID, {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          status: "ready",
          models: [],
        },
        {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          enabled: true,
          installed: true,
          status: "ready",
          models: [],
        },
      ],
      settings: DEFAULT_SERVER_SETTINGS,
    });

    render();
    captured.selects[1]?.onValueChange?.("chat:claudeAgent");
    render();
    await submitWorktree();

    expect(testState.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          threadDefaults: expect.objectContaining({
            modelSelection: expect.objectContaining({ instanceId: "claudeAgent" }),
          }),
        }),
      }),
    );
    expect(testState.updateSettings).not.toHaveBeenCalled();
  });

  it("falls back when the saved provider is disabled", async () => {
    testState.serverConfigs.set(ENVIRONMENT_ID, {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          status: "ready",
          models: [],
        },
        {
          instanceId: "disabled",
          driver: "codex",
          enabled: false,
          installed: true,
          status: "ready",
          models: [],
        },
      ],
      settings: DEFAULT_SERVER_SETTINGS,
    });
    setDefaultAgent("terminal", "disabled");

    const markup = render();
    expect(captured.selects[1]?.value).toBe("chat:codex");
    expect(markup).toContain(
      "Your default agent is not available on local server, so Codex is selected.",
    );
    await submitWorktree();

    expect(testState.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          threadDefaults: expect.objectContaining({
            modelSelection: expect.objectContaining({ instanceId: "codex" }),
          }),
        }),
      }),
    );
    expect(testState.replaceMainWithTerminal).not.toHaveBeenCalled();
  });

  it("keeps Name visible while switching among Smart, GitHub, and Branch sources", () => {
    testState.refs = [{ name: "main" }, { name: "feature/login" }];
    render();
    expect(input("Worktree name").value).toBe("");
    expect(button("Smart")["aria-pressed"]).toBe(true);

    input("Type #1234 or search branches").onChange?.({ target: { value: "feature" } });
    let markup = render();
    expect(markup).toContain("feature/login");

    button("Branch").onClick?.();
    markup = render();
    expect(button("Branch")["aria-pressed"]).toBe(true);
    expect(input("Search branches").value).toBe("feature");
    expect(markup).toContain("feature/login");
    expect(testState.queryAtoms.at(-1)).toEqual(
      expect.objectContaining({
        args: expect.objectContaining({
          input: { cwd: "/repo", query: undefined, limit: 200 },
        }),
      }),
    );

    button("GitHub").onClick?.();
    render();
    input("#1234 or a GitHub issue/PR URL").onChange?.({ target: { value: "#42" } });
    markup = render();
    expect(button("Create worktree").disabled).toBe(false);
    expect(input("Worktree name").value).toBe("pr-42");
    expect(markup).not.toContain(">Name</button>");
    expect(testState.queryAtoms.at(-1)).toBeNull();
  });

  it("updates project, agent, advanced override, and create-more controls", () => {
    const secondId = ProjectId.make("project-two");
    const secondEnvironmentId = EnvironmentId.make("remote");
    testState.projects.push(
      project({
        id: secondId,
        environmentId: secondEnvironmentId,
        title: "Second",
        workspaceRoot: "/second",
      }),
    );
    testState.serverConfigs.set(ENVIRONMENT_ID, {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          status: "ready",
          models: [],
        },
        {
          instanceId: "claude",
          driver: "claudeAgent",
          displayName: null,
          enabled: true,
          installed: true,
          status: "ready",
          models: [{ slug: "opus", name: "Opus", isCustom: false, capabilities: null }],
        },
      ],
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providers: {},
        providerInstances: { claude: { driver: "claudeAgent" } },
      },
    });

    render(true, PROJECT_REF);
    captured.selects[0]?.onValueChange?.(
      scopedProjectKey(scopeProjectRef(secondEnvironmentId, secondId)),
    );
    render();
    expect(captured.selects[0]?.value).toBe(
      scopedProjectKey(scopeProjectRef(secondEnvironmentId, secondId)),
    );

    captured.selects[0]?.onValueChange?.(scopedProjectKey(PROJECT_REF));
    render();
    captured.selects[1]?.onValueChange?.("chat:claude");
    captured.collapsibles[0]?.onOpenChange?.(true);
    captured.switches[0]?.onCheckedChange?.(true);
    let markup = render();
    expect(markup).toContain("Hide advanced");
    input("Defaults to the current branch").onChange?.({ target: { value: "develop" } });
    markup = render();
    expect(input("Defaults to the current branch").value).toBe("develop");
    expect(captured.selects[1]?.value).toBe("chat:claude");
    expect(captured.switches[0]?.checked).toBe(true);
  });

  it("initializes an untouched dialog from the available project provider and its options", async () => {
    testState.projects = [
      project({
        defaultModelSelection: {
          instanceId: "codex",
          model: "gpt-5.4",
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "fast" },
          ],
        },
      }),
    ];
    testState.serverConfigs.set(ENVIRONMENT_ID, {
      providers: [
        {
          instanceId: "claudeAgent",
          driver: "claudeAgent",
          displayName: "Claude",
          enabled: true,
          installed: true,
          status: "ready",
          models: [
            {
              slug: "claude-sonnet-4-6",
              name: "Sonnet",
              isCustom: false,
              capabilities: null,
            },
          ],
        },
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          status: "ready",
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
        },
      ],
      settings: DEFAULT_SERVER_SETTINGS,
    });
    render();
    expect(captured.selects[1]?.value).toBe("chat:codex");
    render();
    input("Worktree name").onChange?.({ target: { value: "project-default" } });
    render();
    button("Create worktree").onClick?.();
    await flushPromises();

    expect(testState.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          threadDefaults: expect.objectContaining({
            modelSelection: {
              instanceId: "codex",
              model: "gpt-5.4",
              options: [
                { id: "reasoningEffort", value: "high" },
                { id: "serviceTier", value: "fast" },
              ],
            },
          }),
        }),
      }),
    );
  });

  it("resolves the selected provider's shared model, effort, and fast defaults", async () => {
    testState.projects = [
      project({
        defaultModelSelection: {
          instanceId: "codex",
          model: "gpt-5.4",
          options: [
            { id: "reasoningEffort", value: "medium" },
            { id: "serviceTier", value: "default" },
          ],
        },
      }),
    ];
    testState.serverConfigs.set(ENVIRONMENT_ID, {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          status: "ready",
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
        },
      ],
      settings: {
        ...DEFAULT_SERVER_SETTINGS,
        providerSessionDefaults: {
          codex: {
            model: "gpt-5.4",
            options: [
              { id: "reasoningEffort", value: "high" },
              { id: "serviceTier", value: "fast" },
            ],
          },
        },
      },
    });

    render();
    render();
    input("Worktree name").onChange?.({ target: { value: "defaults" } });
    render();
    button("Create worktree").onClick?.();
    await flushPromises();

    expect(testState.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          threadDefaults: expect.objectContaining({
            modelSelection: {
              instanceId: "codex",
              model: "gpt-5.4",
              options: [
                { id: "reasoningEffort", value: "high" },
                { id: "serviceTier", value: "fast" },
              ],
            },
          }),
        }),
      }),
    );
  });

  it("falls back to the default Codex selection when project and providers have no model", async () => {
    render();
    render();
    input("Worktree name").onChange?.({ target: { value: "fallback" } });
    render();
    button("Create worktree").onClick?.();
    await flushPromises();

    expect(testState.createWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          threadDefaults: expect.objectContaining({
            modelSelection: expect.objectContaining({ instanceId: "codex" }),
          }),
        }),
      }),
    );
  });

  it.each([
    [new Error("git failed"), "git failed"],
    ["opaque", "An error occurred."],
  ])("reports worktree creation failures", async (error, description) => {
    testState.createWorktree.mockResolvedValue(failure(error));
    render();
    render();
    input("Worktree name").onChange?.({ target: { value: "failure" } });
    render();
    button("Create worktree").onClick?.();
    await flushPromises();

    expect(testState.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Failed to create worktree", description }),
    );
    expect(testState.createWorktree).toHaveBeenCalledTimes(1);
    expect(testState.navigate).not.toHaveBeenCalled();
  });

  it("suppresses interrupted worktree failures", async () => {
    testState.createWorktree.mockResolvedValue(failure(new Error("cancelled"), true));
    render();
    render();
    input("Worktree name").onChange?.({ target: { value: "cancelled" } });
    render();
    button("Create worktree").onClick?.();
    await flushPromises();
    expect(testState.toastAdd).not.toHaveBeenCalled();
    expect(testState.navigate).not.toHaveBeenCalled();
  });

  it("resets the form instead of closing when Create more is enabled", async () => {
    render();
    render();
    input("Worktree name").onChange?.({ target: { value: "one" } });
    captured.switches[0]?.onCheckedChange?.(true);
    render();
    button("Create worktree").onClick?.();
    await flushPromises();
    const markup = render();

    expect(markup).toContain("Create worktree");
    expect(input("Worktree name").value).toBe("");
    expect(testState.onOpenChange).not.toHaveBeenCalled();
    expect(testState.navigate).not.toHaveBeenCalled();
  });

  it("submits with Ctrl+Enter and Meta+Enter but ignores other key combinations", async () => {
    render();
    render();
    input("Worktree name").onChange?.({ target: { value: "keyboard" } });
    render();
    const preventDefault = vi.fn();

    captured.popups[0]?.onKeyDown?.({
      ctrlKey: false,
      metaKey: false,
      key: "Enter",
      preventDefault,
    });
    captured.popups[0]?.onKeyDown?.({
      ctrlKey: true,
      metaKey: false,
      key: "Escape",
      preventDefault,
    });
    expect(testState.createWorktree).not.toHaveBeenCalled();

    captured.popups[0]?.onKeyDown?.({
      ctrlKey: true,
      metaKey: false,
      key: "Enter",
      preventDefault,
    });
    await flushPromises();
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(testState.createWorktree).toHaveBeenCalledTimes(1);

    testState.createWorktree.mockClear();
    captured.popups[0]?.onKeyDown?.({
      ctrlKey: false,
      metaKey: true,
      key: "Enter",
      preventDefault,
    });
    await flushPromises();
    expect(testState.createWorktree).toHaveBeenCalledTimes(1);
  });

  it("does not submit an invalid keyboard form and reports invalid direct submission", async () => {
    testState.projects = [];
    render();
    const preventDefault = vi.fn();
    captured.popups[0]?.onKeyDown?.({
      ctrlKey: true,
      metaKey: false,
      key: "Enter",
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalled();
    expect(testState.createWorktree).not.toHaveBeenCalled();

    button("Create worktree").onClick?.();
    await flushPromises();
    expect(render()).toContain("Choose a project and enter a worktree name.");
  });

  it("ignores close requests while a command is pending", async () => {
    let resolveWorktree: ((result: unknown) => void) | undefined;
    testState.createWorktree.mockReturnValue(
      new Promise((resolve) => {
        resolveWorktree = resolve;
      }),
    );
    render();
    render();
    input("Worktree name").onChange?.({ target: { value: "pending" } });
    render();
    button("Create worktree").onClick?.();
    render();

    expect(button("Creating...").disabled).toBe(true);
    captured.dialogs[0]?.onOpenChange?.(false);
    expect(testState.onOpenChange).not.toHaveBeenCalled();

    resolveWorktree?.(failure(new Error("stopped"), true));
    await flushPromises();
    render();
    captured.dialogs[0]?.onOpenChange?.(false);
    expect(testState.onOpenChange).toHaveBeenCalledWith(false);
  });
});

if (browserRuntime) {
  describe("CreateWorktreeDialog browser interactions", () => {
    beforeEach(() => {
      resetScenario();
      (
        globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
      ).IS_REACT_ACT_ENVIRONMENT = true;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    function requiredElement<T extends Element>(container: ParentNode, selector: string): T {
      const element = container.querySelector<T>(selector);
      if (!element) throw new Error(`Missing DOM element: ${selector}`);
      return element;
    }

    function requiredButton(container: ParentNode, label: string): HTMLButtonElement {
      const match = Array.from(container.querySelectorAll("button")).find((candidate) =>
        candidate.textContent?.trim().startsWith(label),
      );
      if (!match) {
        throw new Error(`Missing DOM button: ${label}; rendered: ${container.textContent ?? ""}`);
      }
      return match;
    }

    async function dispatch(element: Element, event: Event): Promise<void> {
      await React.act(async () => {
        element.dispatchEvent(event);
      });
    }

    async function setInputValue(input: HTMLInputElement, value: string): Promise<void> {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      if (!setter) throw new Error("HTMLInputElement.value setter is unavailable");
      setter.call(input, value);
      await dispatch(input, new Event("input", { bubbles: true, cancelable: true }));
    }

    async function renderDialog(
      root: Root,
      open: boolean,
      defaultProjectRef?: ScopedProjectRef | null,
    ): Promise<void> {
      await React.act(async () => {
        root.render(
          <CreateWorktreeDialog
            open={open}
            onOpenChange={testState.onOpenChange}
            {...(defaultProjectRef === undefined ? {} : { defaultProjectRef })}
          />,
        );
      });
    }

    async function mountDialog(
      open = true,
      defaultProjectRef?: ScopedProjectRef | null,
    ): Promise<{
      container: HTMLDivElement;
      root: Root;
    }> {
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      await renderDialog(root, open, defaultProjectRef);
      return { container, root };
    }

    it("adopts an explicit project target when transitioning from closed to open", async () => {
      const targetProjectId = ProjectId.make("project-two");
      const targetEnvironmentId = EnvironmentId.make("remote");
      testState.projects = [
        project(),
        project({
          id: targetProjectId,
          environmentId: targetEnvironmentId,
          title: "Remote project",
          workspaceRoot: "/remote/repo",
        }),
      ];
      const { container, root } = await mountDialog(false, PROJECT_REF);

      testState.queryAtoms = [];
      await renderDialog(root, true, scopeProjectRef(targetEnvironmentId, targetProjectId));

      expect(
        requiredElement<HTMLDivElement>(container, "[data-select-value]").dataset["selectValue"],
      ).toBe(scopedProjectKey(scopeProjectRef(targetEnvironmentId, targetProjectId)));
      expect(testState.queryAtoms.at(-1)).toEqual({
        kind: "vcs.listRefs",
        args: {
          environmentId: targetEnvironmentId,
          input: { cwd: "/remote/repo", query: undefined, limit: 200 },
        },
      });

      await React.act(async () => root.unmount());
      container.remove();
    });

    it("refreshes cached refs whenever the dialog opens", async () => {
      const { container, root } = await mountDialog(false, PROJECT_REF);

      expect(testState.refreshRefs).not.toHaveBeenCalled();
      await renderDialog(root, true, PROJECT_REF);
      expect(testState.refreshRefs).toHaveBeenCalledTimes(1);

      await renderDialog(root, false, PROJECT_REF);
      await renderDialog(root, true, PROJECT_REF);
      expect(testState.refreshRefs).toHaveBeenCalledTimes(2);

      await React.act(async () => root.unmount());
      container.remove();
    });

    it("submits a selected existing branch without requesting a new branch", async () => {
      testState.refs = [{ name: "main" }, { name: "feature/login" }];
      testState.createWorktree.mockResolvedValue(
        success({
          threadId: "thread-created",
          path: "/repo/.worktrees/feature-login",
          refName: "feature/login",
        }),
      );
      const { container, root } = await mountDialog();

      await React.act(async () => requiredButton(container, "Branch").click());
      await React.act(async () => requiredButton(container, "feature/login").click());
      await React.act(async () => requiredButton(container, "Create worktree").click());
      await React.act(async () => flushPromises());

      expect(testState.createWorktree).toHaveBeenCalledWith({
        environmentId: ENVIRONMENT_ID,
        input: {
          commandId: "command-create-worktree",
          projectId: PROJECT_ID,
          threadId: "thread-created",
          title: "feature/login",
          refName: "feature/login",
          newRefName: null,
          baseRefName: null,
          threadDefaults: {
            modelSelection: expect.objectContaining({ instanceId: "codex" }),
            runtimeMode: "full-access",
            interactionMode: "default",
          },
        },
      });
      const managedInput = testState.createWorktree.mock.calls[0]?.[0].input;
      expect(managedInput).not.toHaveProperty("cwd");
      expect(managedInput).not.toHaveProperty("path");
      expect(managedInput).not.toHaveProperty("worktreePath");
      expect(managedInput).not.toHaveProperty("kind");

      await React.act(async () => root.unmount());
      container.remove();
    });

    it("suggests a permanent name and defaults reuse on for a free local branch", async () => {
      testState.refs = [
        { name: "main", current: true, worktreePath: "/repo" },
        { name: "feature/login", isRemote: false, current: false, worktreePath: null },
      ];
      const { container, root } = await mountDialog();

      const nameInput = container.querySelector<HTMLInputElement>(
        "input[placeholder='Worktree name']",
      );
      expect(nameInput?.value).toBe("");

      await React.act(async () => requiredButton(container, "Branch").click());
      await React.act(async () => requiredButton(container, "feature/login").click());

      expect(nameInput?.value).toBe("feature/login");
      const reuseLabel = Array.from(container.querySelectorAll("label")).find((label) =>
        label.textContent?.includes("Reuse branch"),
      );
      expect(reuseLabel?.querySelector<HTMLInputElement>("input[type='checkbox']")?.checked).toBe(
        true,
      );

      await React.act(async () => root.unmount());
      container.remove();
    });

    it("turns an exact remote ref into the selection without duplicating it below the input", async () => {
      testState.refs = [
        {
          name: "origin/feature/remote-only",
          isRemote: true,
          remoteName: "origin",
        },
      ];
      const { container, root } = await mountDialog();

      await React.act(async () => requiredButton(container, "Branch").click());
      const sourceInput = requiredElement<HTMLInputElement>(
        container,
        "input[placeholder='Search branches']",
      );
      await setInputValue(sourceInput, "origin/feature/remote-only");

      expect(sourceInput.value).toBe("origin/feature/remote-only");
      expect(testState.queryAtoms.at(-1)).toEqual({
        kind: "vcs.listRefs",
        args: {
          environmentId: ENVIRONMENT_ID,
          input: { cwd: "/repo", query: undefined, limit: 200 },
        },
      });
      expect(
        Array.from(container.querySelectorAll("button")).filter(
          (button) => button.textContent?.trim() === "origin/feature/remote-only",
        ),
      ).toHaveLength(0);
      expect(
        requiredElement<HTMLInputElement>(container, "input[placeholder='Worktree name']").value,
      ).toBe("feature/remote-only");
      expect(requiredButton(container, "Create worktree").disabled).toBe(false);

      await React.act(async () => root.unmount());
      container.remove();
    });

    it("closes the branch list on a pick and shows the branch in the field (#151)", async () => {
      testState.refs = [{ name: "main" }, { name: "feature-PFS-2272-alpha" }];
      const { container, root } = await mountDialog();
      const rowsNamed = (name: string) =>
        Array.from(container.querySelectorAll("button")).filter(
          (button) => button.textContent?.trim() === name,
        );

      await React.act(async () => requiredButton(container, "Branch").click());
      const sourceInput = requiredElement<HTMLInputElement>(
        container,
        "input[placeholder='Search branches']",
      );
      await React.act(async () => requiredButton(container, "feature-PFS-2272-alpha").click());

      expect(sourceInput.value).toBe("feature-PFS-2272-alpha");
      expect(rowsNamed("main")).toHaveLength(0);
      expect(rowsNamed("feature-PFS-2272-alpha")).toHaveLength(0);
      expect(document.activeElement).toBe(sourceInput);
      expect(requiredButton(container, "Create worktree").disabled).toBe(false);

      // Editing the field drops the pick and brings the list back.
      await setInputValue(sourceInput, "feature");
      expect(rowsNamed("feature-PFS-2272-alpha")).toHaveLength(1);
      expect(requiredButton(container, "Create worktree").disabled).toBe(true);

      await React.act(async () => root.unmount());
      container.remove();
    });

    it("closes the Smart rows on a branch pick (#151)", async () => {
      testState.refs = [
        { name: "main" },
        { name: "origin/main", isRemote: true, remoteName: "origin" },
      ];
      const { container, root } = await mountDialog();
      const sourceInput = requiredElement<HTMLInputElement>(
        container,
        "input[placeholder='Type #1234 or search branches']",
      );

      await setInputValue(sourceInput, "mai");
      await React.act(async () => requiredButton(container, "main").click());

      expect(sourceInput.value).toBe("main");
      expect(
        Array.from(container.querySelectorAll("button")).filter((button) =>
          button.textContent?.includes("origin/main"),
        ),
      ).toHaveLength(0);
      expect(requiredButton(container, "Create worktree").disabled).toBe(false);

      await React.act(async () => root.unmount());
      container.remove();
    });

    it("creates from a picked branch whose name is a number, not GitHub # (#151)", async () => {
      testState.refs = [{ name: "main" }, { name: "2026" }];
      const { container, root } = await mountDialog();
      await setInputValue(
        requiredElement<HTMLInputElement>(container, "input[placeholder='Worktree name']"),
        "investigation",
      );
      await setInputValue(
        requiredElement<HTMLInputElement>(
          container,
          "input[placeholder='Type #1234 or search branches']",
        ),
        "0",
      );
      await React.act(async () => requiredButton(container, "2026").click());

      expect(container.textContent).toContain("Interpreting as: branch");
      await React.act(async () => requiredButton(container, "Create worktree").click());
      await React.act(async () => flushPromises());
      expect(testState.createWorktree).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            title: "investigation",
            refName: "2026",
            newRefName: "investigation",
            baseRefName: "2026",
          }),
        }),
      );

      await React.act(async () => root.unmount());
      container.remove();
    });

    it("preserves a manually edited name and leaves branch reuse off", async () => {
      testState.refs = [{ name: "feature/login", isRemote: false }];
      const { container, root } = await mountDialog();
      const nameInput = requiredElement<HTMLInputElement>(
        container,
        "input[placeholder='Worktree name']",
      );

      await setInputValue(nameInput, "Custom workspace");
      await React.act(async () => requiredButton(container, "Branch").click());
      await React.act(async () => requiredButton(container, "feature/login").click());

      expect(nameInput.value).toBe("Custom workspace");
      const reuseCheckbox = Array.from(container.querySelectorAll("label"))
        .find((label) => label.textContent?.includes("Reuse branch"))
        ?.querySelector<HTMLInputElement>("input[type='checkbox']");
      expect(reuseCheckbox?.checked).toBe(false);

      await React.act(async () => root.unmount());
      container.remove();
    });

    it("creates the edited Name from an occupied branch instead of a suffixed copy (#136)", async () => {
      testState.refs = [{ name: "master", isRemote: false, current: true }];
      const { container, root } = await mountDialog();

      await React.act(async () => requiredButton(container, "Branch").click());
      await React.act(async () => requiredButton(container, "master").click());
      await setInputValue(
        requiredElement<HTMLInputElement>(container, "input[placeholder='Worktree name']"),
        "my-feature",
      );
      expect(container.textContent).toContain(
        'A new branch ("my-feature" or the next available name) will be created from it.',
      );
      await React.act(async () => requiredButton(container, "Create worktree").click());
      await React.act(async () => flushPromises());
      expect(testState.createWorktree).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            title: "my-feature",
            refName: "master",
            newRefName: "my-feature",
            baseRefName: "master",
          }),
        }),
      );

      await React.act(async () => root.unmount());
      container.remove();
    });

    it("advances an untouched name when opting out of branch reuse", async () => {
      testState.refs = [
        { name: "feature/login", isRemote: false },
        { name: "feature/login-2", isRemote: false },
      ];
      const { container, root } = await mountDialog();

      await React.act(async () => requiredButton(container, "Branch").click());
      await React.act(async () => requiredButton(container, "feature/login").click());
      const reuseCheckbox = Array.from(container.querySelectorAll("label"))
        .find((label) => label.textContent?.includes("Reuse branch"))
        ?.querySelector<HTMLInputElement>("input[type='checkbox']");
      await React.act(async () => reuseCheckbox?.click());

      expect(
        requiredElement<HTMLInputElement>(container, "input[placeholder='Worktree name']").value,
      ).toBe("feature/login-3");
      await React.act(async () => requiredButton(container, "Create worktree").click());
      await React.act(async () => flushPromises());
      expect(testState.createWorktree).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({
            title: "feature/login-3",
            refName: "feature/login",
            newRefName: "feature/login-3",
            baseRefName: "feature/login",
          }),
        }),
      );

      await React.act(async () => root.unmount());
      container.remove();
    });

    it("explains when the selected local branch is already checked out", async () => {
      testState.refs = [
        {
          name: "main",
          isRemote: false,
          current: true,
          worktreePath: "/repo",
        },
      ];
      const { container, root } = await mountDialog();

      await React.act(async () => requiredButton(container, "Branch").click());
      await React.act(async () => requiredButton(container, "main").click());

      expect(container.textContent).toContain(
        '"main" is already checked out. A new branch ("main-2" or the next available name) will be created from it.',
      );
      const reuseLabel = Array.from(container.querySelectorAll("label")).find((label) =>
        label.textContent?.includes("Reuse branch"),
      );
      expect(reuseLabel).toBeDefined();
      const reuseCheckbox = reuseLabel?.querySelector<HTMLInputElement>("input[type='checkbox']");
      expect(reuseCheckbox?.disabled).toBe(true);
      expect(reuseCheckbox?.checked).toBe(false);

      await React.act(async () => root.unmount());
      container.remove();
    });

    it("offers Reuse branch disabled for a selected remote branch and says why", async () => {
      testState.refs = [
        { name: "origin/feature/remote-only", isRemote: true, remoteName: "origin" },
      ];
      const { container, root } = await mountDialog();

      await React.act(async () => requiredButton(container, "Branch").click());
      await React.act(async () => requiredButton(container, "origin/feature/remote-only").click());

      const reuseLabel = Array.from(container.querySelectorAll("label")).find((label) =>
        label.textContent?.includes("Reuse branch"),
      );
      const reuseCheckbox = reuseLabel?.querySelector<HTMLInputElement>("input[type='checkbox']");
      expect(reuseCheckbox?.disabled).toBe(true);
      expect(reuseCheckbox?.checked).toBe(false);
      expect(container.textContent).toContain(
        '"origin/feature/remote-only" is a remote branch. A local branch will be created from it.',
      );

      await React.act(async () => root.unmount());
      container.remove();
    });

    it("offers Reuse branch enabled and checked for a free local branch", async () => {
      testState.refs = [
        { name: "feature/free", isRemote: false, current: false, worktreePath: null },
      ];
      const { container, root } = await mountDialog();

      await React.act(async () => requiredButton(container, "Branch").click());
      await React.act(async () => requiredButton(container, "feature/free").click());

      const reuseLabel = Array.from(container.querySelectorAll("label")).find((label) =>
        label.textContent?.includes("Reuse branch"),
      );
      const reuseCheckbox = reuseLabel?.querySelector<HTMLInputElement>("input[type='checkbox']");
      expect(reuseCheckbox?.disabled).toBe(false);
      expect(reuseCheckbox?.checked).toBe(true);
      expect(container.textContent).toContain(
        "Check out the existing branch instead of creating a new one from it.",
      );

      await React.act(async () => root.unmount());
      container.remove();
    });

    it("uses the scoped environment when projects share the same project id", async () => {
      const remoteEnvironmentId = EnvironmentId.make("remote");
      const remoteProjectRef = scopeProjectRef(remoteEnvironmentId, PROJECT_ID);
      testState.projects = [
        project({ title: "Local copy", workspaceRoot: "/local/repo" }),
        project({
          environmentId: remoteEnvironmentId,
          title: "Remote copy",
          workspaceRoot: "/remote/repo",
        }),
      ];
      testState.refs = [{ name: "remote-feature" }];
      testState.serverConfigs.set(remoteEnvironmentId, serverConfig([readyProvider("codex")]));
      testState.createWorktree.mockResolvedValue(
        success({
          threadId: "thread-created",
          path: "/remote/worktree",
          refName: "remote-feature",
        }),
      );
      const { container, root } = await mountDialog(true, remoteProjectRef);

      expect(
        requiredElement<HTMLDivElement>(container, "[data-select-value]").dataset["selectValue"],
      ).toBe(scopedProjectKey(remoteProjectRef));
      expect(testState.queryAtoms.at(-1)).toEqual({
        kind: "vcs.listRefs",
        args: {
          environmentId: remoteEnvironmentId,
          input: { cwd: "/remote/repo", query: undefined, limit: 200 },
        },
      });

      await React.act(async () => requiredButton(container, "Branch").click());
      await React.act(async () => requiredButton(container, "remote-feature").click());
      await React.act(async () => requiredButton(container, "Create worktree").click());
      await React.act(async () => flushPromises());

      expect(testState.createWorktree).toHaveBeenCalledWith({
        environmentId: remoteEnvironmentId,
        input: {
          commandId: "command-create-worktree",
          projectId: PROJECT_ID,
          threadId: "thread-created",
          title: "remote-feature",
          refName: "remote-feature",
          newRefName: null,
          baseRefName: null,
          threadDefaults: {
            modelSelection: expect.objectContaining({ instanceId: "codex" }),
            runtimeMode: "full-access",
            interactionMode: "default",
          },
        },
      });

      await React.act(async () => root.unmount());
      container.remove();
    });

    it("clears a selected branch when the Project select changes", async () => {
      const secondProjectId = ProjectId.make("project-two");
      const secondEnvironmentId = EnvironmentId.make("remote");
      const secondProjectRef = scopeProjectRef(secondEnvironmentId, secondProjectId);
      testState.projects = [
        project(),
        project({
          id: secondProjectId,
          environmentId: secondEnvironmentId,
          title: "Repo B",
          workspaceRoot: "/repo-b",
        }),
      ];
      testState.refs = [{ name: "main" }];
      testState.serverConfigs.set(secondEnvironmentId, serverConfig([readyProvider("codex")]));
      const { container, root } = await mountDialog(true, PROJECT_REF);

      await React.act(async () => requiredButton(container, "Branch").click());
      await React.act(async () => requiredButton(container, "main").click());
      expect(requiredButton(container, "Create worktree").disabled).toBe(false);

      const projectSelect = captured.selects.find((select) =>
        select.items?.some((item) => item.label === "Repo B"),
      );
      await React.act(async () =>
        projectSelect?.onValueChange?.(scopedProjectKey(secondProjectRef)),
      );

      expect(requiredButton(container, "Create worktree").disabled).toBe(true);
      expect(testState.queryAtoms.at(-1)).toEqual({
        kind: "vcs.listRefs",
        args: {
          environmentId: secondEnvironmentId,
          input: { cwd: "/repo-b", query: undefined, limit: 200 },
        },
      });

      await React.act(async () => requiredButton(container, "main").click());
      expect(requiredButton(container, "Create worktree").disabled).toBe(false);

      await React.act(async () => root.unmount());
      container.remove();
    });

    it("clears a selected branch when reopening for another row", async () => {
      const secondProjectId = ProjectId.make("project-two");
      const secondEnvironmentId = EnvironmentId.make("remote");
      const secondProjectRef = scopeProjectRef(secondEnvironmentId, secondProjectId);
      testState.projects = [
        project(),
        project({
          id: secondProjectId,
          environmentId: secondEnvironmentId,
          title: "Repo B",
          workspaceRoot: "/repo-b",
        }),
      ];
      testState.refs = [{ name: "main" }];
      const { container, root } = await mountDialog(true, PROJECT_REF);

      await React.act(async () => requiredButton(container, "Branch").click());
      await React.act(async () => requiredButton(container, "main").click());
      expect(requiredButton(container, "Create worktree").disabled).toBe(false);

      await renderDialog(root, false, PROJECT_REF);
      await renderDialog(root, true, secondProjectRef);

      expect(requiredButton(container, "Create worktree").disabled).toBe(true);
      expect(testState.queryAtoms.at(-1)).toEqual({
        kind: "vcs.listRefs",
        args: {
          environmentId: secondEnvironmentId,
          input: { cwd: "/repo-b", query: undefined, limit: 200 },
        },
      });

      await React.act(async () => root.unmount());
      container.remove();
    });

    it("clears another project's branch when reopening for the original row (#151)", async () => {
      const secondProjectId = ProjectId.make("project-two");
      const secondEnvironmentId = EnvironmentId.make("remote");
      const secondProjectRef = scopeProjectRef(secondEnvironmentId, secondProjectId);
      testState.projects = [
        project(),
        project({
          id: secondProjectId,
          environmentId: secondEnvironmentId,
          title: "Repo B",
          workspaceRoot: "/repo-b",
        }),
      ];
      // Both projects have the branch, so a stale field would select the first one's.
      testState.refs = [{ name: "main" }, { name: "feature/login" }];
      const { container, root } = await mountDialog(true, PROJECT_REF);

      const projectSelect = captured.selects.find((select) =>
        select.items?.some((item) => item.label === "Repo B"),
      );
      await React.act(async () =>
        projectSelect?.onValueChange?.(scopedProjectKey(secondProjectRef)),
      );
      await React.act(async () => requiredButton(container, "Branch").click());
      await React.act(async () => requiredButton(container, "feature/login").click());
      expect(
        requiredElement<HTMLInputElement>(container, "input[placeholder='Search branches']").value,
      ).toBe("feature/login");

      await renderDialog(root, false, PROJECT_REF);
      await renderDialog(root, true, PROJECT_REF);

      expect(
        requiredElement<HTMLInputElement>(container, "input[placeholder='Search branches']").value,
      ).toBe("");
      expect(requiredButton(container, "Create worktree").disabled).toBe(true);

      await React.act(async () => root.unmount());
      container.remove();
    });

    it("disables Create when the selected ref disappears from refreshed results", async () => {
      testState.refs = [{ name: "main", current: false, worktreePath: null }];
      const { container, root } = await mountDialog(true, PROJECT_REF);

      await React.act(async () => requiredButton(container, "Branch").click());
      await React.act(async () => requiredButton(container, "main").click());
      expect(requiredButton(container, "Create worktree").disabled).toBe(false);

      testState.refs = [];
      await renderDialog(root, true, PROJECT_REF);

      expect(requiredButton(container, "Create worktree").disabled).toBe(true);

      await React.act(async () => root.unmount());
      container.remove();
    });

    it("updates the occupied explanation from refreshed ref metadata", async () => {
      testState.refs = [{ name: "main", current: false, worktreePath: null }];
      const { container, root } = await mountDialog(true, PROJECT_REF);

      await React.act(async () => requiredButton(container, "Branch").click());
      await React.act(async () => requiredButton(container, "main").click());
      expect(container.textContent).not.toContain("is already checked out");

      testState.refs = [{ name: "main", current: true, worktreePath: "/repo" }];
      await renderDialog(root, true, PROJECT_REF);
      expect(container.textContent).toContain('"main" is already checked out.');

      testState.refs = [{ name: "main", current: false, worktreePath: null }];
      await renderDialog(root, true, PROJECT_REF);
      expect(container.textContent).not.toContain("is already checked out");

      await React.act(async () => root.unmount());
      container.remove();
    });

    it("selects the branch the field still names when reopening the same scoped project", async () => {
      testState.refs = [{ name: "main", current: false, worktreePath: null }];
      const { container, root } = await mountDialog(true, PROJECT_REF);

      await React.act(async () => requiredButton(container, "Branch").click());
      await React.act(async () => requiredButton(container, "main").click());
      expect(requiredButton(container, "Create worktree").disabled).toBe(false);

      await renderDialog(root, false, PROJECT_REF);
      await renderDialog(root, true, PROJECT_REF);

      // A pick is the field's text, so it is read again from the refreshed refs.
      expect(
        requiredElement<HTMLInputElement>(container, "input[placeholder='Search branches']").value,
      ).toBe("main");
      expect(requiredButton(container, "Create worktree").disabled).toBe(false);

      await React.act(async () => root.unmount());
      container.remove();
    });

    it("keeps a stale Smart source invalid after reopening", async () => {
      testState.refs = [{ name: "feature/login", isRemote: false }];
      const { container, root } = await mountDialog(true, PROJECT_REF);
      const sourceInput = requiredElement<HTMLInputElement>(
        container,
        "input[placeholder='Type #1234 or search branches']",
      );

      await setInputValue(sourceInput, "feature");
      await React.act(async () => requiredButton(container, "feature/login").click());
      await setInputValue(
        requiredElement<HTMLInputElement>(container, "input[placeholder='Worktree name']"),
        "Custom workspace",
      );
      await renderDialog(root, false, PROJECT_REF);
      // The branch is gone by the time the dialog opens again.
      testState.refs = [];
      await renderDialog(root, true, PROJECT_REF);

      expect(
        requiredElement<HTMLInputElement>(container, "input[placeholder='Worktree name']").value,
      ).toBe("Custom workspace");
      expect(
        requiredElement<HTMLInputElement>(
          container,
          "input[placeholder='Type #1234 or search branches']",
        ).value,
      ).toBe("feature/login");
      expect(requiredButton(container, "Create worktree").disabled).toBe(true);

      await React.act(async () => root.unmount());
      container.remove();
    });

    it("reads a picked branch from the field after switching Create From modes", async () => {
      testState.refs = [{ name: "feature/login", isRemote: false }];
      const { container, root } = await mountDialog(true, PROJECT_REF);

      await React.act(async () => requiredButton(container, "Branch").click());
      await setInputValue(
        requiredElement<HTMLInputElement>(container, "input[placeholder='Search branches']"),
        "feature",
      );
      await React.act(async () => requiredButton(container, "feature/login").click());
      await setInputValue(
        requiredElement<HTMLInputElement>(container, "input[placeholder='Worktree name']"),
        "Custom workspace",
      );
      await React.act(async () => requiredButton(container, "Smart").click());

      expect(
        requiredElement<HTMLInputElement>(
          container,
          "input[placeholder='Type #1234 or search branches']",
        ).value,
      ).toBe("feature/login");
      expect(container.textContent).toContain("Interpreting as: branch");
      expect(requiredButton(container, "Create worktree").disabled).toBe(false);

      await React.act(async () => root.unmount());
      container.remove();
    });

    it("enables and submits the worktree form through real input and Ctrl+Enter events", async () => {
      testState.serverConfigs.set(ENVIRONMENT_ID, {
        providers: [
          {
            instanceId: "claude",
            driver: "claudeAgent",
            displayName: "Claude",
            enabled: true,
            installed: true,
            status: "ready",
            models: [{ slug: "sonnet", name: "Sonnet", isCustom: false, capabilities: null }],
          },
        ],
        settings: {
          ...DEFAULT_SERVER_SETTINGS,
          providers: {},
          providerInstances: { claude: { driver: "claudeAgent" } },
        },
      });
      const { container, root } = await mountDialog();

      expect(requiredButton(container, "Create worktree").disabled).toBe(true);
      const nameInput = requiredElement<HTMLInputElement>(
        container,
        "input[placeholder='Worktree name']",
      );
      await setInputValue(nameInput, "My Feature");
      expect(nameInput.value).toBe("My Feature");
      expect(requiredButton(container, "Create worktree").disabled).toBe(false);

      const popup = requiredElement<HTMLDivElement>(container, "[data-testid='dialog-popup']");
      await dispatch(
        popup,
        new KeyboardEvent("keydown", {
          key: "Enter",
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      await React.act(async () => flushPromises());

      expect(testState.createWorktree).toHaveBeenCalledWith({
        environmentId: ENVIRONMENT_ID,
        input: {
          commandId: "command-create-worktree",
          projectId: PROJECT_ID,
          threadId: "thread-created",
          title: "My Feature",
          refName: "HEAD",
          newRefName: "My-Feature",
          baseRefName: "HEAD",
          threadDefaults: {
            modelSelection: expect.any(Object),
            runtimeMode: "full-access",
            interactionMode: "default",
          },
        },
      });
      expect(testState.onOpenChange).toHaveBeenCalledWith(false);
      expect(testState.navigate).toHaveBeenCalledWith({
        to: "/$environmentId/$threadId",
        params: { environmentId: ENVIRONMENT_ID, threadId: "thread-created" },
      });

      await React.act(async () => root.unmount());
      container.remove();
    });

    describe("Default Agent (#185)", () => {
      const REMOTE_ENVIRONMENT_ID = EnvironmentId.make("remote");
      const REMOTE_PROJECT_REF = scopeProjectRef(REMOTE_ENVIRONMENT_ID, PROJECT_ID);

      function agentPickerValue(container: ParentNode): string | undefined {
        const pickers = container.querySelectorAll<HTMLElement>("[data-select-value]");
        return pickers[1]?.dataset["selectValue"];
      }

      /** Settings writes the primary server; its config stream carries the new settings back. */
      function changeDefaultAgentInSettings(kind: "chat" | "terminal", instanceId: string): void {
        setDefaultAgent(kind, instanceId);
        const primaryConfig = testState.serverConfigs.get(ENVIRONMENT_ID);
        if (primaryConfig) {
          testState.serverConfigs.set(ENVIRONMENT_ID, {
            ...primaryConfig,
            settings: testState.primarySettings,
          });
        }
      }

      function useRemoteProject(providers: ReadonlyArray<Record<string, unknown>>): void {
        testState.projects = [
          project({ environmentId: REMOTE_ENVIRONMENT_ID, workspaceRoot: "/remote/repo" }),
        ];
        // The remote server's own persisted settings keep the built-in Default Agent.
        testState.serverConfigs.set(
          REMOTE_ENVIRONMENT_ID,
          serverConfig(providers, DEFAULT_SERVER_SETTINGS, "Remote"),
        );
      }

      async function typeName(container: HTMLDivElement): Promise<void> {
        await setInputValue(
          requiredElement<HTMLInputElement>(container, "input[placeholder='Worktree name']"),
          "agent-default",
        );
      }

      async function createWithoutTouchingAgent(container: HTMLDivElement): Promise<void> {
        await typeName(container);
        await React.act(async () => requiredButton(container, "Create worktree").click());
        await React.act(async () => flushPromises());
      }

      function createdInstanceId(): unknown {
        const call = testState.createWorktree.mock.calls.at(-1)?.[0] as
          | { input: { threadDefaults: { modelSelection: { instanceId: unknown } } } }
          | undefined;
        return call?.input.threadDefaults.modelSelection.instanceId;
      }

      it("opens on a Default Agent changed while the app runs and creates with it", async () => {
        testState.serverConfigs.set(
          ENVIRONMENT_ID,
          serverConfig([readyProvider("codex"), readyProvider("claudeAgent")]),
        );
        const { container, root } = await mountDialog(true, PROJECT_REF);
        expect(agentPickerValue(container)).toBe("chat:codex");
        await renderDialog(root, false, PROJECT_REF);

        changeDefaultAgentInSettings("chat", "claudeAgent");
        await renderDialog(root, true, PROJECT_REF);

        expect(agentPickerValue(container)).toBe("chat:claudeAgent");
        await createWithoutTouchingAgent(container);
        expect(createdInstanceId()).toBe("claudeAgent");
        expect(testState.replaceMainWithTerminal).not.toHaveBeenCalled();

        await renderDialog(root, false, PROJECT_REF);
        changeDefaultAgentInSettings("terminal", "codex");
        await renderDialog(root, true, PROJECT_REF);

        expect(agentPickerValue(container)).toBe("terminal:codex");
        await createWithoutTouchingAgent(container);
        expect(createdInstanceId()).toBe("codex");
        expect(testState.replaceMainWithTerminal).toHaveBeenCalledWith(
          scopeThreadRef(ENVIRONMENT_ID, ThreadId.make(testState.nextThreadId)),
          [],
          expect.objectContaining({ label: "Codex Terminal" }),
        );

        await React.act(async () => root.unmount());
        container.remove();
      });

      it("applies the primary-server Default Agent to a project on another server", async () => {
        useRemoteProject([readyProvider("codex"), readyProvider("claudeAgent")]);
        changeDefaultAgentInSettings("chat", "claudeAgent");
        const { container, root } = await mountDialog(true, REMOTE_PROJECT_REF);

        expect(agentPickerValue(container)).toBe("chat:claudeAgent");
        expect(container.textContent).not.toContain("so Codex is selected");
        await createWithoutTouchingAgent(container);
        expect(testState.createWorktree).toHaveBeenCalledWith(
          expect.objectContaining({ environmentId: REMOTE_ENVIRONMENT_ID }),
        );
        expect(createdInstanceId()).toBe("claudeAgent");

        await React.act(async () => root.unmount());
        container.remove();
      });

      it("says why it falls back when the other server lacks the Default Agent", async () => {
        useRemoteProject([readyProvider("codex")]);
        changeDefaultAgentInSettings("chat", "claudeAgent");
        const { container, root } = await mountDialog(true, REMOTE_PROJECT_REF);

        const notice = "Your default agent is not available on Remote, so Codex is selected.";
        expect(agentPickerValue(container)).toBe("chat:codex");
        expect(container.textContent).toContain(notice);
        // The note describes the picker without being part of its label: clicking it opens nothing.
        const note = requiredElement<HTMLElement>(container, "[role='status']");
        expect(note.textContent).toBe(notice);
        expect(note.closest("label")).toBeNull();
        expect(
          requiredElement<HTMLElement>(container, "[aria-describedby]").getAttribute(
            "aria-describedby",
          ),
        ).toBe(note.id);

        await React.act(async () => captured.selects.at(-1)?.onValueChange?.("terminal:codex"));
        expect(agentPickerValue(container)).toBe("terminal:codex");
        expect(container.textContent).not.toContain(notice);
        expect(container.querySelector("[aria-describedby]")).toBeNull();

        await React.act(async () => root.unmount());
        container.remove();
      });

      it("names the reason when the Default Agent is present but not ready", async () => {
        useRemoteProject([
          readyProvider("codex"),
          readyProvider("claudeAgent", { status: "error" }),
        ]);
        changeDefaultAgentInSettings("chat", "claudeAgent");
        const { container, root } = await mountDialog(true, REMOTE_PROJECT_REF);

        expect(agentPickerValue(container)).toBe("chat:codex");
        expect(container.textContent).toMatch(
          /Claude is unavailable \(.+\), so Codex is selected\./,
        );
        await createWithoutTouchingAgent(container);
        expect(createdInstanceId()).toBe("codex");

        await React.act(async () => root.unmount());
        container.remove();
      });

      it("waits for the project's agents before creating, then uses the Default Agent", async () => {
        testState.serverConfigs = new Map();
        changeDefaultAgentInSettings("chat", "claudeAgent");
        const { container, root } = await mountDialog(true, PROJECT_REF);
        await typeName(container);

        expect(agentPickerValue(container)).toBeUndefined();
        expect(container.textContent).toContain(
          "Loading this project's agents. Create waits until they arrive.",
        );
        expect(requiredButton(container, "Create worktree").disabled).toBe(true);

        testState.serverConfigs.set(
          ENVIRONMENT_ID,
          serverConfig([readyProvider("codex"), readyProvider("claudeAgent")]),
        );
        await renderDialog(root, true, PROJECT_REF);

        expect(agentPickerValue(container)).toBe("chat:claudeAgent");
        expect(container.textContent).not.toContain("Loading this project's agents");
        await React.act(async () => requiredButton(container, "Create worktree").click());
        await React.act(async () => flushPromises());
        expect(createdInstanceId()).toBe("claudeAgent");

        await React.act(async () => root.unmount());
        container.remove();
      });

      it("waits while the project's server has no ready agent", async () => {
        testState.serverConfigs.set(
          ENVIRONMENT_ID,
          serverConfig([readyProvider("codex", { status: "error" })]),
        );
        const { container, root } = await mountDialog(true, PROJECT_REF);
        await typeName(container);

        expect(container.textContent).toContain(
          "No agent is ready on Local. Sign in to or enable one in Settings → Providers.",
        );
        expect(requiredButton(container, "Create worktree").disabled).toBe(true);
        await React.act(async () => {
          requiredElement<HTMLDivElement>(container, "[data-testid='dialog-popup']").dispatchEvent(
            new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
          );
        });
        expect(testState.createWorktree).not.toHaveBeenCalled();

        await React.act(async () => root.unmount());
        container.remove();
      });

      it("says where to fix it when another server has no ready agent", async () => {
        useRemoteProject([readyProvider("codex", { status: "error" })]);
        const { container, root } = await mountDialog(true, REMOTE_PROJECT_REF);

        expect(container.textContent).toContain(
          "No agent is ready on Remote. Sign in to or enable one on that server.",
        );
        expect(requiredButton(container, "Create worktree").disabled).toBe(true);

        await React.act(async () => root.unmount());
        container.remove();
      });

      it("waits while the session is lost even though the last config remains", async () => {
        useRemoteProject([readyProvider("codex"), readyProvider("claudeAgent")]);
        const { container, root } = await mountDialog(true, REMOTE_PROJECT_REF);
        await typeName(container);
        await React.act(async () => captured.selects.at(-1)?.onValueChange?.("chat:claudeAgent"));
        expect(requiredButton(container, "Create worktree").disabled).toBe(false);

        // The supervisor loses the session; the config map keeps the last snapshot.
        testState.connectionPhases.set(REMOTE_ENVIRONMENT_ID, "reconnecting");
        await renderDialog(root, true, REMOTE_PROJECT_REF);
        expect(testState.serverConfigs.has(REMOTE_ENVIRONMENT_ID)).toBe(true);
        expect(container.textContent).toContain(
          "Remote is not connected. Create waits until it reconnects.",
        );
        expect(requiredButton(container, "Create worktree").disabled).toBe(true);
        await React.act(async () => requiredButton(container, "Create worktree").click());
        expect(testState.createWorktree).not.toHaveBeenCalled();

        testState.connectionPhases.set(REMOTE_ENVIRONMENT_ID, "connected");
        await renderDialog(root, true, REMOTE_PROJECT_REF);
        expect(agentPickerValue(container)).toBe("chat:claudeAgent");
        expect(container.textContent).not.toContain("is not connected");
        expect(requiredButton(container, "Create worktree").disabled).toBe(false);

        await React.act(async () => root.unmount());
        container.remove();
      });

      it("says a server offline since start is not connected, then uses the default", async () => {
        testState.projects = [
          project({ environmentId: REMOTE_ENVIRONMENT_ID, workspaceRoot: "/remote/repo" }),
        ];
        testState.connectionPhases.set(REMOTE_ENVIRONMENT_ID, "offline");
        changeDefaultAgentInSettings("chat", "claudeAgent");
        const { container, root } = await mountDialog(true, REMOTE_PROJECT_REF);
        await typeName(container);

        expect(container.textContent).toContain(
          "remote server is not connected. Create waits until it reconnects.",
        );
        expect(container.textContent).not.toContain("Loading this project's agents");
        expect(requiredButton(container, "Create worktree").disabled).toBe(true);

        testState.connectionPhases.set(REMOTE_ENVIRONMENT_ID, "connecting");
        await renderDialog(root, true, REMOTE_PROJECT_REF);
        expect(container.textContent).toContain(
          "Connecting to remote server. Create waits until it connects.",
        );

        testState.connectionPhases.set(REMOTE_ENVIRONMENT_ID, "connected");
        await renderDialog(root, true, REMOTE_PROJECT_REF);
        expect(container.textContent).toContain("Loading this project's agents");

        testState.serverConfigs.set(
          REMOTE_ENVIRONMENT_ID,
          serverConfig([readyProvider("codex"), readyProvider("claudeAgent")], undefined, "Remote"),
        );
        await renderDialog(root, true, REMOTE_PROJECT_REF);
        expect(agentPickerValue(container)).toBe("chat:claudeAgent");
        expect(requiredButton(container, "Create worktree").disabled).toBe(false);

        await React.act(async () => root.unmount());
        container.remove();
      });

      it("drops a manual pick its connected server stops offering, so it never returns unseen", async () => {
        const ready = [readyProvider("codex"), readyProvider("claudeAgent")];
        testState.serverConfigs.set(ENVIRONMENT_ID, serverConfig(ready));
        changeDefaultAgentInSettings("chat", "claudeAgent");
        const { container, root } = await mountDialog(true, PROJECT_REF);
        await React.act(async () => captured.selects.at(-1)?.onValueChange?.("chat:codex"));
        expect(agentPickerValue(container)).toBe("chat:codex");

        testState.serverConfigs.set(
          ENVIRONMENT_ID,
          serverConfig([readyProvider("codex", { status: "error" }), readyProvider("claudeAgent")]),
        );
        await renderDialog(root, true, PROJECT_REF);
        expect(agentPickerValue(container)).toBe("chat:claudeAgent");

        testState.serverConfigs.set(ENVIRONMENT_ID, serverConfig(ready));
        await renderDialog(root, true, PROJECT_REF);
        expect(agentPickerValue(container)).toBe("chat:claudeAgent");
        await createWithoutTouchingAgent(container);
        expect(createdInstanceId()).toBe("claudeAgent");

        await React.act(async () => root.unmount());
        container.remove();
      });

      it("shows the fallback note again once a dropped pick leaves the fallback selected", async () => {
        testState.serverConfigs.set(
          ENVIRONMENT_ID,
          serverConfig([readyProvider("codex"), readyProvider("cursor")]),
        );
        changeDefaultAgentInSettings("chat", "claudeAgent");
        const { container, root } = await mountDialog(true, PROJECT_REF);
        const notice = "Your default agent is not available on Local, so Codex is selected.";
        expect(container.textContent).toContain(notice);
        await React.act(async () => captured.selects.at(-1)?.onValueChange?.("chat:cursor"));
        expect(container.textContent).not.toContain(notice);

        testState.serverConfigs.set(
          ENVIRONMENT_ID,
          serverConfig([readyProvider("codex"), readyProvider("cursor", { status: "error" })]),
        );
        await renderDialog(root, true, PROJECT_REF);
        expect(agentPickerValue(container)).toBe("chat:codex");
        expect(container.textContent).toContain(notice);

        await React.act(async () => root.unmount());
        container.remove();
      });

      it("keeps a manual pick while the agents are loading or the server is away", async () => {
        const config = serverConfig([readyProvider("codex"), readyProvider("claudeAgent")]);
        testState.serverConfigs.set(ENVIRONMENT_ID, config);
        const { container, root } = await mountDialog(true, PROJECT_REF);
        await React.act(async () => captured.selects.at(-1)?.onValueChange?.("chat:claudeAgent"));

        testState.serverConfigs = new Map();
        await renderDialog(root, true, PROJECT_REF);
        expect(container.textContent).toContain("Loading this project's agents");
        testState.connectionPhases.set(ENVIRONMENT_ID, "connecting");
        await renderDialog(root, true, PROJECT_REF);
        expect(container.textContent).toContain("Connecting to");

        testState.connectionPhases.set(ENVIRONMENT_ID, "connected");
        testState.serverConfigs = new Map([[ENVIRONMENT_ID, config]]);
        await renderDialog(root, true, PROJECT_REF);
        expect(agentPickerValue(container)).toBe("chat:claudeAgent");

        await React.act(async () => root.unmount());
        container.remove();
      });

      it("keeps a manual pick without a fallback note when the default stops being ready", async () => {
        const providers = [readyProvider("codex"), readyProvider("claudeAgent")];
        testState.serverConfigs.set(ENVIRONMENT_ID, serverConfig(providers));
        changeDefaultAgentInSettings("chat", "claudeAgent");
        const { container, root } = await mountDialog(true, PROJECT_REF);
        expect(agentPickerValue(container)).toBe("chat:claudeAgent");
        await React.act(async () => captured.selects.at(-1)?.onValueChange?.("chat:codex"));

        testState.serverConfigs.set(
          ENVIRONMENT_ID,
          serverConfig([readyProvider("codex"), readyProvider("claudeAgent", { status: "error" })]),
        );
        await renderDialog(root, true, PROJECT_REF);

        expect(agentPickerValue(container)).toBe("chat:codex");
        expect(container.textContent).not.toContain("is selected");
        expect(container.querySelector("[role='status']")).toBeNull();

        await React.act(async () => root.unmount());
        container.remove();
      });
    });

    it("explains when the branch list could not be loaded", async () => {
      testState.refsError = "Git is unavailable on this host.";
      const { container, root } = await mountDialog();

      await React.act(async () => requiredButton(container, "Branch").click());

      const alert = container.querySelector("[role='alert']");
      expect(alert?.textContent).toContain("Git is unavailable on this host.");
      expect(alert?.textContent).toContain("Branches could not be loaded");
      const lines = Array.from(alert?.querySelectorAll("span") ?? []).map(
        (span) => span.textContent,
      );
      expect(lines).toEqual([
        "Branches could not be loaded: Git is unavailable on this host.",
        "Retry after fixing Git, or clear this field and enter a Name above to create a new branch.",
      ]);

      await React.act(async () => root.unmount());
      container.remove();
      testState.refsError = null;
    });
  });
}
