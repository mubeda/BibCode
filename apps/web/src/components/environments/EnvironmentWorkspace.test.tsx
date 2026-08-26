import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { EnvironmentWorkspace } from "./EnvironmentWorkspace";
import {
  createEnvironmentWorkspaceModel,
  type EnvironmentWorkspaceSource,
} from "./environmentWorkspaceModel";

const source: EnvironmentWorkspaceSource = {
  environmentId: "00000000-0000-4000-8000-000000000081",
  acceptedStorageInstanceId: "00000000-0000-4000-8000-000000000082",
  alias: "Build Linux",
  canonicalLabel: "build.internal",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.4.1",
  protocol: { minimum: 1, maximum: 2 },
  capabilities: { repositoryIdentity: true, worktreeCatalog: true },
  status: "offline",
  hasCachedContent: true,
  lastSynchronizedAt: "2026-08-25T10:00:00.000Z",
  projectCount: 2,
  threadCount: 5,
  projects: [],
  pairedClients: [],
  activeRouteId: null,
  routes: [],
  service: null,
  hostAuthorityChannels: [],
  platformDetails: [],
};

describe("EnvironmentWorkspace", () => {
  it("renders stable center tabs, offline state, and editable client preferences", () => {
    const markup = renderToStaticMarkup(
      <EnvironmentWorkspace
        model={createEnvironmentWorkspaceModel(source)}
        activeTab="overview"
        pinned={false}
        onTabChange={vi.fn()}
        onSaveAlias={vi.fn()}
        onTogglePinned={vi.fn()}
        canMoveEarlier
        canMoveLater
        onMove={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Environment workspace"');
    expect(markup).toContain('role="tablist"');
    expect(markup).toContain('aria-selected="true"');
    expect(markup).toContain("Offline · last synchronized Aug 25, 2026, 10:00 AM");
    expect(markup).toContain('aria-label="Client alias"');
    expect(markup).not.toContain('aria-label="Client alias" disabled');
    expect(markup).toContain("Pin environment");
    expect(markup).toContain("Move earlier");
    expect(markup).toContain("Move later");
    expect(markup).toContain("Cached server data is read-only");
  });

  it("renders the selected section only and explains unavailable host controls nearby", () => {
    const markup = renderToStaticMarkup(
      <EnvironmentWorkspace
        model={createEnvironmentWorkspaceModel(source)}
        activeTab="service"
        pinned
        onTabChange={vi.fn()}
        onSaveAlias={vi.fn()}
        onTogglePinned={vi.fn()}
        canMoveEarlier={false}
        canMoveLater={false}
        onMove={vi.fn()}
      />,
    );

    expect(markup).toContain("Server runtime and host-owned service controls");
    expect(markup).toContain("Reconnect this environment before changing its host service");
    expect(markup).not.toContain("Identity, compatibility, and ownership");
  });

  it("never renders a telemetry switch or permission editor", () => {
    const markup = renderToStaticMarkup(
      <EnvironmentWorkspace
        model={createEnvironmentWorkspaceModel(source)}
        activeTab="diagnostics"
        pinned={false}
        onTabChange={vi.fn()}
        onSaveAlias={vi.fn()}
        onTogglePinned={vi.fn()}
        canMoveEarlier={false}
        canMoveLater={false}
        onMove={vi.fn()}
      />,
    ).toLowerCase();

    expect(markup).toContain("no upload, analytics, crash reporting, or usage reporting");
    expect(markup).not.toContain("telemetry");
    expect(markup).not.toContain("permission level");
  });
});
