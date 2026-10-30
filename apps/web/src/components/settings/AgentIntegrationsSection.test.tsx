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

const h = vi.hoisted(() => ({
  settings: { enableMcpServer: true, mcpServerAccess: "approval-required" } as Record<
    string,
    unknown
  >,
  updates: [] as Array<{ environmentId: string; patch: unknown }>,
  copied: [] as string[],
  environments: [] as FakeEnvironment[],
  updateResult: null as unknown,
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

beforeEach(() => {
  h.settings = { enableMcpServer: true, mcpServerAccess: "approval-required" };
  h.updates = [];
  h.copied = [];
  h.environments = [environment()];
  h.updateResult = null;
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
      "Let AI tools on this computer, or over SSH, operate this environment's threads.",
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

    h.settings = { enableMcpServer: false, mcpServerAccess: "full-access" };
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

  it("quotes for the server host's own shell", () => {
    expect(launchShellFor(["C:\\Program Files\\BiBCode\\BiBCode.exe", "mcp"])).toBe("windows");
    expect(launchShellFor(["/usr/bin/bibcode", "mcp"])).toBe("posix");
  });
});
