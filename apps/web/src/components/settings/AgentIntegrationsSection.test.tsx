// @vitest-environment happy-dom

import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type AnyProps = Record<string, unknown>;

interface FakeEnvironment {
  environmentId: string;
  label: string;
  connection: { phase: string };
  serverConfig: { mcpLaunch?: { argv: ReadonlyArray<string> } | null } | null;
}

const DEFAULT_CAPABILITIES = {
  workspace: true,
  sourceControl: true,
  files: true,
  diagnostics: true,
  terminals: false,
};

const h = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  updates: [] as Array<{ environmentId: string; patch: unknown }>,
  copied: [] as string[],
  environments: [] as FakeEnvironment[],
  updateResult: null as unknown,
  webhooks: null as null | { endpoints: ReadonlyArray<Record<string, unknown>> },
  clients: [] as Array<{ connected: boolean }>,
}));

vi.mock("../../state/webhooks", () => ({
  useWebhookList: (environmentId: string | null) => ({
    data: environmentId === null ? null : h.webhooks,
    error: null,
    refresh: () => undefined,
  }),
  isFailingEndpoint: (endpoint: {
    disabledReason: unknown;
    enabled: boolean;
    consecutiveFailures: number;
  }) => endpoint.disabledReason !== null || (endpoint.enabled && endpoint.consecutiveFailures > 0),
}));

vi.mock("../../state/mcpActivity", () => ({
  usePrimaryMcpActivity: () => ({ rows: [], active: [], canManage: false, environmentId: null }),
  usePrimaryMcpClients: () => h.clients,
  takenOverLevel: () => null,
}));

// Covered by its own tests; here only its place in the MCP tab matters.
vi.mock("./McpAgentsPanel", () => ({ McpAgentsPanel: () => <div data-testid="agents-panel" /> }));

vi.mock("./WebhooksTab", () => ({
  WebhooksTab: (props: AnyProps) => (
    <div data-testid="webhooks-tab" data-environment={props.environmentId as string} />
  ),
}));

vi.mock("./diagnosticsEnvironment", () => ({
  useDiagnosticsEnvironment: () => ({
    environments: h.environments,
    connected: h.environments.filter((environment) => environment.connection.phase === "connected"),
    primaryEnvironment: h.environments[0] ?? null,
    environment: h.environments[0] ?? null,
    waitingFor: undefined,
  }),
  DiagnosticsEnvironmentSelect: () => <div data-testid="environment-picker" />,
}));

vi.mock("../../hooks/useSettings", () => ({
  useEnvironmentSettings: (_environmentId: string, selector: (settings: unknown) => unknown) =>
    selector(h.settings),
  useUpdateEnvironmentSettings: (environmentId: string) => (patch: unknown) => {
    h.updates.push({ environmentId, patch });
    return Promise.resolve(h.updateResult ?? { _tag: "Success", value: undefined });
  },
}));

vi.mock("../../hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({
    copyToClipboard: (text: string) => h.copied.push(text),
    isCopied: false,
  }),
}));

vi.mock("../ui/switch", () => ({
  Switch: (props: AnyProps) => (
    <button
      type="button"
      role="switch"
      aria-label={props["aria-label"] as string}
      aria-checked={Boolean(props.checked)}
      aria-describedby={props["aria-describedby"] as string | undefined}
      disabled={Boolean(props.disabled)}
      onClick={() => (props.onCheckedChange as (checked: boolean) => void)(!props.checked)}
    />
  ),
}));

vi.mock("../ui/select", () => ({
  Select: (props: AnyProps) => (
    <div data-disabled={String(Boolean(props.disabled))} data-value={props.value as string}>
      {props.children as ReactNode}
    </div>
  ),
  SelectTrigger: (props: AnyProps) => (
    <button
      type="button"
      aria-label={props["aria-label"] as string}
      aria-describedby={props["aria-describedby"] as string | undefined}
    >
      {props.children as ReactNode}
    </button>
  ),
  SelectValue: (props: AnyProps) => <span>{props.children as ReactNode}</span>,
  SelectPopup: (props: AnyProps) => <div>{props.children as ReactNode}</div>,
  SelectItem: (props: AnyProps) => <div role="option">{props.children as ReactNode}</div>,
}));

import { AgentIntegrationsSection, launchShellFor } from "./AgentIntegrationsSection";

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

async function render(): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(<AgentIntegrationsSection />);
  });
  return container;
}

function environment(overrides: Partial<FakeEnvironment> = {}): FakeEnvironment {
  return {
    environmentId: "local",
    label: "This Mac",
    connection: { phase: "connected" },
    serverConfig: {
      mcpLaunch: {
        argv: [
          "/Applications/BiBCode.app/Contents/MacOS/BiBCode",
          "mcp",
          "--base-dir",
          "/Users/me/.bibcode",
        ],
      },
    },
    ...overrides,
  };
}

function settings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enableMcpServer: true,
    mcpServerAccess: "approval-required",
    mcpCapabilities: DEFAULT_CAPABILITIES,
    ...overrides,
  };
}

const CAPABILITY_SWITCHES = [
  ["Threads and worktrees", "workspace"],
  ["Source Control and pull requests", "sourceControl"],
  ["Files", "files"],
  ["Diagnostics", "diagnostics"],
  ["Terminals", "terminals"],
] as const;

function capabilitySwitch(container: HTMLElement, label: string): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(`[role="switch"][aria-label="${label}"]`)!;
}

function describedText(container: HTMLElement, element: Element): string | null | undefined {
  const describedBy = element.getAttribute("aria-describedby");
  return describedBy === null
    ? null
    : container.querySelector(`[id="${describedBy}"]`)?.textContent;
}

beforeEach(() => {
  h.settings = settings();
  h.updates = [];
  h.copied = [];
  h.environments = [environment()];
  h.updateResult = null;
  h.webhooks = null;
  h.clients = [];
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("AgentIntegrationsSection", () => {
  it("shows the switch, the access limit and the copyable launch command", async () => {
    const container = await render();
    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="MCP server"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(toggle.disabled).toBe(false);
    expect(container.textContent).toContain(
      "Let AI tools operate this environment: threads, worktrees, Git and pull requests.",
    );
    expect(container.textContent).toContain(
      "At any level above Read only, agents can also answer approvals, remove worktrees, discard changes, force-push and merge pull requests.",
    );
    expect(container.querySelector('[aria-label="Agents may"]')?.textContent).toBe("Supervised");
    const command = container.querySelector('[aria-label="Launch command"]')?.textContent;
    expect(command).toBe(
      "/Applications/BiBCode.app/Contents/MacOS/BiBCode mcp --base-dir /Users/me/.bibcode",
    );
    const buttons = [...container.querySelectorAll("button")].filter((button) =>
      button.textContent?.startsWith("Copy"),
    );
    for (const button of buttons) {
      await act(async () => button.click());
    }
    expect(h.copied).toEqual([
      command,
      `claude mcp add bibcode -- ${command}`,
      `codex mcp add bibcode -- ${command}`,
    ]);
    expect(container.querySelector('[data-testid="environment-picker"]')).toBeNull();
  });

  it("turns the server off without asking, and offers a reset back on", async () => {
    const container = await render();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="MCP server"]')!.click(),
    );
    expect(h.updates).toEqual([{ environmentId: "local", patch: { enableMcpServer: false } }]);

    h.settings = settings({ enableMcpServer: false, mcpServerAccess: "full-access" });
    const off = await render();
    expect(off.textContent).toContain("Turn on MCP server first.");
    expect(off.querySelector('[data-value="full-access"]')?.getAttribute("data-disabled")).toBe(
      "true",
    );
    const describedBy = off
      .querySelector('[aria-label="Agents may"]')
      ?.getAttribute("aria-describedby");
    expect(off.querySelector(`[id="${describedBy}"]`)?.textContent).toBe(
      "Turn on MCP server first.",
    );
    await act(async () =>
      off.querySelector<HTMLButtonElement>('[aria-label="Reset MCP server to default"]')!.click(),
    );
    await act(async () =>
      off.querySelector<HTMLButtonElement>('[aria-label="Reset agent access to default"]')!.click(),
    );
    expect(h.updates.slice(1)).toEqual([
      { environmentId: "local", patch: { enableMcpServer: true } },
      { environmentId: "local", patch: { mcpServerAccess: "approval-required" } },
    ]);
  });

  it("says what failed when a change is not saved", async () => {
    h.updateResult = AsyncResult.failure(Cause.fail(new Error("The server refused the change.")));
    const container = await render();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="MCP server"]')!.click(),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Could not save the MCP server setting. The server refused the change. Try again.",
    );
  });

  it("explains why an older server's rows are disabled", async () => {
    h.environments = [environment({ serverConfig: {} })];
    const container = await render();
    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="MCP server"]')!;
    expect(toggle.disabled).toBe(true);
    expect(
      container.querySelector(`[id="${toggle.getAttribute("aria-describedby")}"]`)?.textContent,
    ).toBe("Update this server to use outside agents.");
    expect(container.querySelector('[aria-label="Launch command"]')).toBeNull();
  });

  it("names the picker when several environments are connected, and the host for a remote one", async () => {
    h.environments = [environment(), environment({ environmentId: "remote", label: "Build box" })];
    const container = await render();
    expect(container.querySelector('[data-testid="environment-picker"]')).not.toBeNull();
  });

  it("writes each capability switch to its own key, without asking", async () => {
    h.settings = settings({ mcpServerAccess: "full-access" });
    const container = await render();
    for (const [label] of CAPABILITY_SWITCHES) {
      const toggle = capabilitySwitch(container, label);
      expect(toggle.disabled, label).toBe(false);
      await act(async () => toggle.click());
    }
    expect(h.updates).toEqual(
      CAPABILITY_SWITCHES.map(([, key]) => ({
        environmentId: "local",
        patch: { mcpCapabilities: { [key]: !DEFAULT_CAPABILITIES[key] } },
      })),
    );
    expect(capabilitySwitch(container, "Threads and worktrees").getAttribute("aria-checked")).toBe(
      "true",
    );
    expect(capabilitySwitch(container, "Terminals").getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain(
      "Let MCP agents open terminals and run any command in this environment.",
    );
    expect(container.textContent).toContain("after their MCP server restarts");
  });

  it("disables Terminals below Full access and says why", async () => {
    const container = await render();
    const terminals = capabilitySwitch(container, "Terminals");
    expect(terminals.disabled).toBe(true);
    expect(describedText(container, terminals)).toBe("Set Agents may to Full access first.");
    expect(capabilitySwitch(container, "Files").disabled).toBe(false);
  });

  it("disables every capability until the MCP server is on, and resets them to the defaults", async () => {
    h.settings = settings({
      enableMcpServer: false,
      mcpServerAccess: "full-access",
      mcpCapabilities: { ...DEFAULT_CAPABILITIES, files: false, terminals: true },
    });
    const container = await render();
    for (const [label] of CAPABILITY_SWITCHES) {
      const toggle = capabilitySwitch(container, label);
      expect(toggle.disabled, label).toBe(true);
      expect(describedText(container, toggle), label).toBe("Turn on MCP server first.");
    }
    expect(capabilitySwitch(container, "Terminals").getAttribute("aria-checked")).toBe("true");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Reset agent capabilities to default"]')!
        .click(),
    );
    expect(h.updates).toEqual([
      { environmentId: "local", patch: { mcpCapabilities: DEFAULT_CAPABILITIES } },
    ]);
  });

  it("summarizes MCP, connected agents and webhooks in the header", async () => {
    h.clients = [{ connected: true }, { connected: false }];
    const container = await render();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "MCP on · 1 agent connected · Webhooks off",
    );

    h.settings = settings({ enableMcpServer: false, enableWebhooks: true });
    h.webhooks = {
      endpoints: [
        { enabled: true, consecutiveFailures: 0, disabledReason: null },
        { enabled: true, consecutiveFailures: 2, disabledReason: null },
        { enabled: false, consecutiveFailures: 10, disabledReason: "failures" },
        { enabled: false, consecutiveFailures: 0, disabledReason: null },
      ],
    };
    const on = await render();
    expect(on.querySelector('[role="status"]')?.textContent).toBe(
      "MCP off · 1 agent connected · 1 webhook active, 2 failing",
    );
  });

  it("shows the MCP tab first and the webhooks of the same environment in the other tab", async () => {
    const container = await render();
    const tabs = [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent);
    expect(tabs).toEqual(["MCP", "Webhooks"]);
    expect(container.querySelector('[aria-label="MCP server"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="webhooks-tab"]')).toBeNull();
    const webhooksTab = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (tab) => tab.textContent === "Webhooks",
    )!;
    await act(async () => webhooksTab.click());
    expect(
      container.querySelector('[data-testid="webhooks-tab"]')?.getAttribute("data-environment"),
    ).toBe("local");
    expect(container.querySelector('[aria-label="MCP server"]')).toBeNull();
  });

  it("quotes for the server host's own shell", () => {
    expect(launchShellFor(["C:\\Program Files\\BiBCode\\BiBCode.exe", "mcp"])).toBe("windows");
    expect(launchShellFor(["/usr/bin/bibcode", "mcp"])).toBe("posix");
  });
});
