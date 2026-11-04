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
  serverConfig: {
    mcpLaunch?: { argv: ReadonlyArray<string> } | null;
    environment: { capabilities: Record<string, boolean> };
  } | null;
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
  primaryId: null as string | null,
  copyFails: false,
  registrations: null as null | { clients: ReadonlyArray<Record<string, unknown>> },
  registrationsError: null as string | null,
  refreshes: 0,
  commands: [] as Array<{ command: string; environmentId: string; input: unknown }>,
  commandResult: null as null | ((command: string, input: { client: string }) => Promise<unknown>),
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
  usePrimaryAgentAccess: () => ({ environmentId: "local", canRead: true, canManage: true }),
  takenOverLevel: () => null,
}));

// Covered by its own tests; here only its place in the MCP tab matters.
vi.mock("./McpAgentsPanel", () => ({ McpAgentsPanel: () => <div data-testid="agents-panel" /> }));
vi.mock("./McpRemoteAgentsPanel", () => ({
  McpRemoteAgentsPanel: (props: AnyProps) => (
    <div
      data-testid="remote-agents-panel"
      data-environment={props.environmentId as string}
      data-primary={String(props.isPrimary)}
    />
  ),
}));

vi.mock("./WebhooksTab", () => ({
  WebhooksTab: (props: AnyProps) => (
    <div data-testid="webhooks-tab" data-environment={props.environmentId as string} />
  ),
}));

vi.mock("./diagnosticsEnvironment", () => ({
  useDiagnosticsEnvironment: () => ({
    environments: h.environments,
    connected: h.environments.filter((environment) => environment.connection.phase === "connected"),
    primaryEnvironment:
      h.environments.find((environment) => environment.environmentId === h.primaryId) ??
      (h.primaryId === null ? (h.environments[0] ?? null) : null),
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
  useCopyToClipboard: (options?: {
    onCopy?: (context: unknown) => void;
    onError?: (error: Error, context: unknown) => void;
  }) => ({
    copyToClipboard: (text: string, context: unknown) => {
      if (h.copyFails) {
        options?.onError?.(new Error("Clipboard API is unavailable."), context);
        return;
      }
      h.copied.push(text);
      options?.onCopy?.(context);
    },
    isCopied: false,
  }),
}));

vi.mock("../../state/mcpClients", () => ({
  mcpClientsEnvironment: { register: "register", unregister: "unregister" },
  useMcpClientRegistrations: (environmentId: string | null) => ({
    data: environmentId === null ? null : h.registrations,
    error: environmentId === null ? null : h.registrationsError,
    refresh: () => {
      h.refreshes += 1;
    },
  }),
}));

vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand:
    (command: string) => (value: { environmentId: string; input: { client: string } }) => {
      h.commands.push({ command, ...value });
      if (h.commandResult !== null) return h.commandResult(command, value.input);
      return Promise.resolve({
        _tag: "Success",
        value: {
          client: value.input.client,
          installed: true,
          registered: command === "register",
          upToDate: command === "register" ? true : null,
          error: null,
        },
      });
    },
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
      environment: { capabilities: {} },
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
  h.primaryId = null;
  h.copyFails = false;
  h.registrations = { clients: ALL_CLIENTS.map((client) => registration(client)) };
  h.registrationsError = null;
  h.refreshes = 0;
  h.commands = [];
  h.commandResult = null;
});

const ALL_CLIENTS = ["claude", "codex", "cursor", "opencode"] as const;

function registration(
  client: (typeof ALL_CLIENTS)[number],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { client, installed: true, registered: false, upToDate: null, error: null, ...overrides };
}

function buttonNamed(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent?.trim() === text,
  );
}

function clientLine(container: HTMLElement, name: string): HTMLElement {
  return container.querySelector<HTMLElement>(`[data-mcp-client][aria-label="${name}"]`)!;
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

describe("AgentIntegrationsSection", () => {
  it("shows the switch and the access limit", async () => {
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
    h.environments = [environment({ serverConfig: { environment: { capabilities: {} } } })];
    const container = await render();
    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="MCP server"]')!;
    expect(toggle.disabled).toBe(true);
    expect(
      container.querySelector(`[id="${toggle.getAttribute("aria-describedby")}"]`)?.textContent,
    ).toBe("Update this server to use outside agents.");
    expect(container.textContent).not.toContain("Connect an agent");
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
    // Remote agents and their requests to connect sit in the MCP tab, after the Agents list.
    const remote = container.querySelector('[data-testid="remote-agents-panel"]');
    expect(remote?.getAttribute("data-environment")).toBe("local");
    expect(remote?.getAttribute("data-primary")).toBe("true");
    const agents = container.querySelector('[data-testid="agents-panel"]')!;
    expect(agents.compareDocumentPosition(remote!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const webhooksTab = [...container.querySelectorAll<HTMLElement>('[role="tab"]')].find(
      (tab) => tab.textContent === "Webhooks",
    )!;
    await act(async () => webhooksTab.click());
    expect(
      container.querySelector('[data-testid="webhooks-tab"]')?.getAttribute("data-environment"),
    ).toBe("local");
    expect(container.querySelector('[aria-label="MCP server"]')).toBeNull();
  });

  it("names webhook endpoints a revoked agent's pairing turned off in the MCP tab", async () => {
    h.webhooks = {
      endpoints: [
        { name: "CI", enabled: false, consecutiveFailures: 0, disabledReason: "client-revoked" },
        { name: "Pager", enabled: true, consecutiveFailures: 0, disabledReason: null },
      ],
    };
    const container = await render();
    expect(container.textContent).toContain(
      "Revoking their paired MCP client turned off CI. Re-enable them in the Webhooks tab.",
    );
  });

  describe("Connect an agent", () => {
    it("adds BiBCode to each tool in one click, without showing a path", async () => {
      h.registrations = {
        clients: [
          registration("claude"),
          registration("codex", { registered: true, upToDate: true }),
          registration("cursor"),
          registration("opencode"),
        ],
      };
      const container = await render();
      expect(container.textContent).toContain("Connect an agent");
      expect(container.textContent).toContain(
        "Add BiBCode to the AI tools on this computer, so they can use this environment.",
      );
      expect(container.textContent).not.toContain("/Applications/BiBCode.app");
      const lines = [...container.querySelectorAll("[data-mcp-client]")].map((line) =>
        line.getAttribute("aria-label"),
      );
      expect(lines).toEqual(["Claude Code", "Codex", "Cursor", "OpenCode"]);
      expect(clientLine(container, "Codex").textContent).toContain("Added to Codex");
      expect(buttonNamed(clientLine(container, "Codex"), "Remove")).toBeDefined();
      for (const name of ["Cursor", "OpenCode"]) {
        expect(buttonNamed(clientLine(container, name), `Add to ${name}`)?.disabled, name).toBe(
          false,
        );
      }

      const add = buttonNamed(clientLine(container, "Claude Code"), "Add to Claude Code")!;
      expect(add.disabled).toBe(false);
      await act(async () => add.click());
      expect(h.commands).toEqual([
        { command: "register", environmentId: "local", input: { client: "claude" } },
      ]);
      expect(clientLine(container, "Claude Code").textContent).toContain("Added to Claude Code");
      expect(buttonNamed(clientLine(container, "Claude Code"), "Remove")).toBeDefined();
      expect(h.refreshes).toBe(1);
    });

    it("says it is adding while the tool runs, and removes on request", async () => {
      let finish: (value: unknown) => void = () => undefined;
      h.commandResult = () => new Promise((resolve) => (finish = resolve));
      const container = await render();
      await act(async () => buttonNamed(clientLine(container, "Cursor"), "Add to Cursor")!.click());
      const busy = buttonNamed(clientLine(container, "Cursor"), "Adding…")!;
      expect(busy.disabled).toBe(true);
      await act(async () =>
        finish({
          _tag: "Success",
          value: registration("cursor", { registered: true, upToDate: true }),
        }),
      );
      h.commandResult = null;
      await act(async () => buttonNamed(clientLine(container, "Cursor"), "Remove")!.click());
      expect(h.commands.at(-1)).toEqual({
        command: "unregister",
        environmentId: "local",
        input: { client: "cursor" },
      });
      expect(buttonNamed(clientLine(container, "Cursor"), "Add to Cursor")).toBeDefined();
    });

    it("offers Update for an entry that runs another command, then shows it current", async () => {
      h.registrations = {
        clients: [
          registration("claude"),
          registration("codex", { registered: true, upToDate: false }),
          registration("cursor", { registered: true, upToDate: null }),
          registration("opencode"),
        ],
      };
      const container = await render();
      const codex = clientLine(container, "Codex");
      expect(codex.textContent).toContain("Added to Codex (out of date)");
      expect(buttonNamed(codex, "Remove")).toBeDefined();
      expect(clientLine(container, "Cursor").textContent).toContain(
        "Added to Cursor. BiBCode couldn't check which command it runs.",
      );
      expect(buttonNamed(clientLine(container, "Cursor"), "Update")).toBeDefined();

      await act(async () => buttonNamed(codex, "Update")!.click());
      expect(h.commands).toEqual([
        { command: "register", environmentId: "local", input: { client: "codex" } },
      ]);
      const updated = clientLine(container, "Codex");
      expect(updated.textContent).toContain("Added to Codex");
      expect(updated.textContent).not.toContain("out of date");
      expect(buttonNamed(updated, "Update")).toBeUndefined();
      expect(buttonNamed(updated, "Remove")).toBeDefined();
    });

    it("disables a tool that is not installed and says where it is missing", async () => {
      h.registrations = {
        clients: [
          registration("claude"),
          registration("codex", { installed: false }),
          registration("cursor"),
          registration("opencode"),
        ],
      };
      const container = await render();
      const add = buttonNamed(clientLine(container, "Codex"), "Add to Codex")!;
      expect(add.disabled).toBe(true);
      expect(describedText(container, add)).toBe("Codex isn't installed on this computer.");

      h.primaryId = "elsewhere";
      h.environments = [environment({ label: "Build box" })];
      const remote = await render();
      const remoteAdd = buttonNamed(clientLine(remote, "Codex"), "Add to Codex")!;
      expect(describedText(remote, remoteAdd)).toBe("Codex isn't installed on Build box's host.");
      expect(remote.textContent).toContain(
        "Add BiBCode to the AI tools on Build box's host, so they can use this environment.",
      );
    });

    it("shows what the tool said when adding fails, and keeps the action", async () => {
      const message =
        "Claude Code could not add BiBCode: permission denied. Check that `claude mcp list` works in a terminal, then try again.";
      h.commandResult = () =>
        Promise.resolve(
          AsyncResult.failure(
            Cause.fail({ _tag: "McpClientRegistrationError", reason: "failed", message }),
          ),
        );
      const container = await render();
      await act(async () =>
        buttonNamed(clientLine(container, "Claude Code"), "Add to Claude Code")!.click(),
      );
      expect(
        clientLine(container, "Claude Code").querySelector('[role="alert"]')?.textContent,
      ).toBe(message);
      expect(
        buttonNamed(clientLine(container, "Claude Code"), "Add to Claude Code")?.disabled,
      ).toBe(false);
    });

    it("shows a tool's own read error, and a failed check with a way to retry", async () => {
      h.registrations = {
        clients: [
          registration("claude"),
          registration("codex"),
          registration("cursor", {
            error:
              "BiBCode left ~/.cursor/mcp.json unchanged because it isn't plain JSON (line 1). Fix the file, or add BiBCode to Cursor by hand from Other MCP clients.",
          }),
          registration("opencode"),
        ],
      };
      const container = await render();
      expect(clientLine(container, "Cursor").textContent).toContain(
        "BiBCode left ~/.cursor/mcp.json unchanged because it isn't plain JSON (line 1).",
      );

      h.registrations = null;
      h.registrationsError = "The authenticated token is missing required scope: access:read.";
      const failed = await render();
      expect(failed.textContent).toContain(
        "Could not check your AI tools. The authenticated token is missing required scope: access:read.",
      );
      await act(async () => buttonNamed(failed, "Try again")!.click());
      expect(h.refreshes).toBe(1);
    });

    it("keeps the command for other clients collapsed, shortened, and copies it in full", async () => {
      const container = await render();
      expect(container.querySelector('[aria-label="MCP launch command"]')).toBeNull();
      const disclosure = buttonNamed(container, "Other MCP clients")!;
      expect(disclosure.getAttribute("aria-expanded")).toBe("false");
      await act(async () => disclosure.click());
      expect(disclosure.getAttribute("aria-expanded")).toBe("true");
      const full =
        "/Applications/BiBCode.app/Contents/MacOS/BiBCode mcp --base-dir /Users/me/.bibcode";
      const shown = container.querySelector('[aria-label="MCP launch command"]')!;
      expect(shown.textContent).toBe("…/BiBCode mcp --base-dir /Users/me/.bibcode");
      expect(shown.getAttribute("title")).toBe(full);
      expect(container.textContent).not.toContain("Development build");
      await act(async () => buttonNamed(container, "Copy command")!.click());
      await act(async () => buttonNamed(container, "Copy MCP config")!.click());
      expect(h.copied).toEqual([
        full,
        JSON.stringify(
          {
            mcpServers: {
              bibcode: {
                command: "/Applications/BiBCode.app/Contents/MacOS/BiBCode",
                args: ["mcp", "--base-dir", "/Users/me/.bibcode"],
              },
            },
          },
          null,
          2,
        ),
      ]);
    });

    it("explains a development build's extra flags", async () => {
      h.environments = [
        environment({
          serverConfig: {
            environment: { capabilities: {} },
            mcpLaunch: {
              argv: [
                "/repo/target/debug/bibcode",
                "mcp",
                "--base-dir",
                "/tmp/dev",
                "--dev-url",
                "http://localhost:5733/",
              ],
            },
          },
        }),
      ];
      const container = await render();
      await act(async () => buttonNamed(container, "Other MCP clients")!.click());
      expect(container.querySelector('[aria-label="MCP launch command"]')?.textContent).toBe(
        "…/bibcode mcp --base-dir /tmp/dev --dev-url http://localhost:5733/",
      );
      expect(container.textContent).toContain(
        "Development build: includes its data folder and dev server.",
      );
    });

    it("reveals the full text to select when the clipboard refuses", async () => {
      h.copyFails = true;
      const container = await render();
      await act(async () => buttonNamed(container, "Other MCP clients")!.click());
      await act(async () => buttonNamed(container, "Copy command")!.click());
      expect(container.querySelector('[role="alert"]')?.textContent).toBe(
        "Couldn't copy to the clipboard. Select the text below and copy it.",
      );
      expect(container.querySelector('[aria-label="Text to copy"]')?.textContent).toBe(
        "/Applications/BiBCode.app/Contents/MacOS/BiBCode mcp --base-dir /Users/me/.bibcode",
      );
    });
  });

  it("quotes for the server host's own shell", () => {
    expect(launchShellFor(["C:\\Program Files\\BiBCode\\BiBCode.exe", "mcp"])).toBe("windows");
    expect(launchShellFor(["/usr/bin/bibcode", "mcp"])).toBe("posix");
  });
});
