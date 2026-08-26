import type { DesktopWslDiscovery } from "@bibcode/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { AddEnvironmentWorkspace, parseSshEnvironmentTarget } from "./AddEnvironmentWorkspace";

const discovery: DesktopWslDiscovery = {
  generation: 7,
  observedAt: "2026-08-25T12:00:00.000Z",
  health: "available",
  detail: null,
  distros: [
    { name: "Ubuntu-24.04", isDefault: true, state: "running", version: 2 },
    { name: "Debian", isDefault: false, state: "stopped", version: 2 },
  ],
};

const props = {
  wslDiscovery: discovery,
  addedWslDistroNames: [] as readonly string[],
  onRefreshWsl: vi.fn(),
  onPrepareWsl: vi.fn(),
  onPrepareSsh: vi.fn(),
  onInstallSetup: vi.fn(),
  onConnectSsh: vi.fn(),
  onConnectDirect: vi.fn(),
};

describe("AddEnvironmentWorkspace", () => {
  it("shows discovered WSL, SSH, and Direct HTTPS in the center without unsafe options", () => {
    const markup = renderToStaticMarkup(<AddEnvironmentWorkspace {...props} />);

    expect(markup).toContain('aria-label="Add environment workspace"');
    expect(markup).toContain("Ubuntu-24.04");
    expect(markup).toContain("Default · Running · WSL 2");
    expect(markup).toContain("Debian");
    expect(markup).toContain("Stopped distributions are never started automatically");
    expect(markup).toContain("SSH host or alias");
    expect(markup).toContain("https:// or wss:// endpoint");
    expect(markup).toContain("system certificate trust or an explicit SPKI SHA-256 pin");
    expect(markup).not.toContain("insecure override");
    expect(markup).not.toContain('value="http://');
  });

  it("marks an already-added WSL environment and never offers setup for a stopped distro", () => {
    const markup = renderToStaticMarkup(
      <AddEnvironmentWorkspace {...props} addedWslDistroNames={["Ubuntu-24.04"]} />,
    );

    expect(markup).toContain("Added environment");
    expect(markup).toContain('data-wsl-distro="Debian"');
    expect(markup).toContain("Open WSL management to start it intentionally");
  });

  it("parses manual SSH targets without shell syntax or hidden defaults", () => {
    expect(
      parseSshEnvironmentTarget({ host: "dev@build.example.com:2222", username: "", port: "" }),
    ).toEqual({
      alias: "build.example.com",
      hostname: "build.example.com",
      username: "dev",
      port: 2222,
    });
    expect(() =>
      parseSshEnvironmentTarget({ host: "build.example.com; shutdown", username: "", port: "" }),
    ).toThrow(/valid SSH host/iu);
  });
});
