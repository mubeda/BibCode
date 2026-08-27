import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentId } from "@bibcode/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  environment: null as Record<string, unknown> | null,
  activeEnvironmentId: null as string | null,
  navigate: vi.fn(),
  commandCalls: [] as Array<{ label?: string; input: unknown }>,
  menuItems: [] as Array<Record<string, unknown>>,
  reset() {
    h.environment = null;
    h.activeEnvironmentId = null;
    h.navigate.mockReset();
    h.commandCalls = [];
    h.menuItems = [];
  },
}));

vi.mock("../../state/entities", () => ({
  useActiveEnvironmentId: () => h.activeEnvironmentId,
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => h.environment,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { label?: string }) => (input: unknown) => {
    h.commandCalls.push(command.label === undefined ? { input } : { label: command.label, input });
    return Promise.resolve({ _tag: "Success", value: undefined });
  },
}));
vi.mock("../../connection/catalog", () => ({
  environmentCatalog: { disconnect: { label: "environment-catalog:disconnect" } },
}));
vi.mock("../../connection/environmentCompat", () => ({
  resolveEnvironmentCompatVerdict: () => null,
  selectRemoteUpdateControlCapability: (serverConfig: unknown) => serverConfig !== null,
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => h.navigate,
}));
vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children?: ReactNode }) => <>{children}</>,
  MenuPopup: ({ children }: { children?: ReactNode }) => <>{children}</>,
  MenuTrigger: ({ children }: { render?: ReactElement; children?: ReactNode }) => <>{children}</>,
  MenuItem: (props: Record<string, unknown>) => {
    h.menuItems.push(props);
    return null;
  },
}));

import { EnvironmentContextCard } from "./EnvironmentContextCard";

const ENV_REMOTE = EnvironmentId.make("env-remote");

function remoteEnvironment(serverConfig: unknown = null) {
  return {
    environmentId: ENV_REMOTE,
    label: "AI-SERVER",
    entry: { target: { _tag: "BearerConnectionTarget", connectionId: "paired-1" } },
    connection: { phase: "connected", error: null, traceId: null },
    serverConfig,
  };
}

describe("EnvironmentContextCard", () => {
  it("renders nothing for Local", () => {
    h.reset();
    h.activeEnvironmentId = ENV_REMOTE;
    h.environment = {
      ...remoteEnvironment(),
      entry: { target: { _tag: "PrimaryConnectionTarget" } },
    };
    expect(renderToStaticMarkup(<EnvironmentContextCard />)).toBe("");
  });

  it("renders name, status, and version line for a remote", () => {
    h.reset();
    h.activeEnvironmentId = ENV_REMOTE;
    h.environment = remoteEnvironment({
      environment: { serverVersion: "0.4.2", capabilities: {} },
    });
    const markup = renderToStaticMarkup(<EnvironmentContextCard />);
    expect(markup).toContain("AI-SERVER");
    expect(markup).toContain("Connected");
    expect(markup).toContain("BiBCode v0.4.2");
  });

  it("disconnects through the latch and deep-links Manage", () => {
    h.reset();
    h.activeEnvironmentId = ENV_REMOTE;
    h.environment = remoteEnvironment({
      environment: { serverVersion: "0.4.2", capabilities: {} },
    });
    renderToStaticMarkup(<EnvironmentContextCard />);
    const labels = h.menuItems.map((item) => item.children);
    expect(labels).toContain("Disconnect");
    expect(labels).toContain("Manage…");
    (h.menuItems.find((item) => item.children === "Disconnect")?.onClick as () => void)();
    expect(h.commandCalls).toEqual([
      { label: "environment-catalog:disconnect", input: ENV_REMOTE },
    ]);
    (h.menuItems.find((item) => item.children === "Manage…")?.onClick as () => void)();
    expect(h.navigate).toHaveBeenCalledWith({ to: "/settings/remote-servers" });
  });

  it("hides update checks until a capable handler is injected", () => {
    h.reset();
    h.activeEnvironmentId = ENV_REMOTE;
    h.environment = remoteEnvironment({
      environment: { serverVersion: "0.4.2", capabilities: {} },
    });
    renderToStaticMarkup(<EnvironmentContextCard />);
    expect(h.menuItems.map((item) => item.children)).not.toContain("Check for updates");

    h.menuItems = [];
    const onCheckForUpdates = vi.fn();
    renderToStaticMarkup(<EnvironmentContextCard onCheckForUpdates={onCheckForUpdates} />);
    const item = h.menuItems.find((entry) => entry.children === "Check for updates");
    expect(item).toBeDefined();
    (item?.onClick as () => void)();
    expect(onCheckForUpdates).toHaveBeenCalledWith(ENV_REMOTE);
  });

  it("renders the update-badge slot verbatim", () => {
    h.reset();
    h.activeEnvironmentId = ENV_REMOTE;
    h.environment = remoteEnvironment({
      environment: { serverVersion: "0.4.2", capabilities: {} },
    });
    const markup = renderToStaticMarkup(
      <EnvironmentContextCard updateBadge={<span data-testid="update-badge">Up to date</span>} />,
    );
    expect(markup).toContain('data-testid="update-badge"');
  });
});
