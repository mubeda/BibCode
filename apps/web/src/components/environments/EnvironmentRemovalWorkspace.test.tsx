import { EnvironmentId } from "@bibcode/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { EnvironmentRemovalWorkspace } from "./EnvironmentRemovalWorkspace";
import type { EnvironmentRemovalContext } from "./environmentRemovalModel";

const NOW = new Date("2026-08-25T12:00:00.000Z");
const environmentId = EnvironmentId.make("env-build");

function context(overrides: Partial<EnvironmentRemovalContext> = {}): EnvironmentRemovalContext {
  return {
    environmentId,
    environmentGeneration: 3,
    alias: "Build Linux",
    kind: "remote",
    hidden: false,
    reachability: "online",
    storageId: "storage-build",
    hostAuthorityAvailable: true,
    plan: {
      schemaVersion: 1,
      planId: "plan-build",
      environmentId,
      environmentGeneration: 3,
      storageId: "storage-build",
      environmentName: "Build Linux",
      dataRoot: "/home/dev/.bibcode",
      projectCount: 2,
      worktreeCount: 4,
      processCount: 1,
      otherPairedClientCount: 2,
      createdAt: "2026-08-25T12:00:00.000Z",
      expiresAt: "2026-08-25T12:05:00.000Z",
      uninstallSupported: true,
      uninstallUnavailableReason: null,
    },
    ...overrides,
  };
}

const callbacks = {
  onBack: vi.fn(),
  onHide: vi.fn(),
  onRestore: vi.fn(),
  onDisconnect: vi.fn(),
  onRequestFreshPlan: vi.fn(),
  onRemove: vi.fn(),
};

describe("EnvironmentRemovalWorkspace", () => {
  it("keeps hide reversible and makes keep-data the online default", () => {
    const markup = renderToStaticMarkup(
      <EnvironmentRemovalWorkspace context={context()} now={NOW} {...callbacks} />,
    );
    expect(markup).toContain('aria-label="Environment removal workspace"');
    expect(markup).toContain(
      "Routes, credentials, cached content, projects, worktrees, and settings remain",
    );
    expect(markup).toContain("Uninstall BiBCode Server");
    expect(markup).toContain("Disconnect temporarily");
    expect(markup).toContain("Server data is preserved");
    expect(markup).toContain("Keep data is recommended");
    expect(markup).toContain("/home/dev/.bibcode");
    expect(markup).toContain("Other paired clients: 2");
    expect(markup).toContain("Remove from this client");
  });

  it("shows every offline consequence and no enabled remote choice", () => {
    const markup = renderToStaticMarkup(
      <EnvironmentRemovalWorkspace
        context={context({ reachability: "offline", plan: null, hostAuthorityAvailable: false })}
        now={NOW}
        {...callbacks}
      />,
    );
    expect(markup).toContain("The BiBCode Server may keep running on the host");
    expect(markup).toContain("Remote projects, worktrees, and data remain untouched");
    expect(markup).toContain("Other clients remain paired");
    expect(markup).toContain("Re-adding this environment requires pairing again");
    expect(markup).toContain("Manual host cleanup may still be required");
    expect(markup).toContain("Remote uninstall or purge will not run now or later");
    expect(markup).toContain('aria-label="Confirm environment alias"');
    expect(markup).toContain('aria-label="Force remove from this client"');
    expect(markup).not.toContain('aria-label="Uninstall BiBCode Server"');
  });

  it("blocks every removal choice for the primary environment", () => {
    const markup = renderToStaticMarkup(
      <EnvironmentRemovalWorkspace
        context={context({ kind: "primary" })}
        now={NOW}
        {...callbacks}
      />,
    );
    expect(markup).toContain("Primary environment is permanent");
    expect(markup).not.toContain("Fully remove");
    expect(markup).not.toContain("Hide from navigation");
  });

  it("explains stopped WSL without suggesting distro deletion", () => {
    const markup = renderToStaticMarkup(
      <EnvironmentRemovalWorkspace
        context={context({ kind: "wsl", reachability: "stopped", plan: null })}
        now={NOW}
        {...callbacks}
      />,
    );
    expect(markup).toContain("Remote consequences cannot be verified");
    expect(markup).not.toMatch(/unregister|delete distro/iu);
  });

  it("shows the verified native-package reason without enabling partial removal", () => {
    const markup = renderToStaticMarkup(
      <EnvironmentRemovalWorkspace
        context={context({
          plan: {
            ...context().plan!,
            uninstallSupported: false,
            uninstallUnavailableReason:
              "This server was installed by the host package manager; use its native uninstaller.",
          },
        })}
        now={NOW}
        {...callbacks}
      />,
    );
    expect(markup).toContain("installed by the host package manager");
    expect(markup).toContain('aria-label="Uninstall BiBCode Server"');
    expect(markup).toContain("disabled");
  });
});
