// @vitest-environment happy-dom

import { scopeThreadRef } from "@bibcode/client-runtime/environment";
import type { EnvironmentThreadShell } from "@bibcode/client-runtime/state/models";
import { EnvironmentId, ThreadId } from "@bibcode/contracts";
import { act, type ComponentPropsWithoutRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../sidebarWorkspaceMetaStore", () => ({
  selectIsUnread: () => false,
  useSidebarWorkspaceMetaStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ unreadThreadKeys: [] }),
}));
vi.mock("../ui/sidebar", () => ({
  SidebarMenuItem: ({ children, ...props }: ComponentPropsWithoutRef<"li">) => (
    <li {...props}>{children}</li>
  ),
  SidebarMenuButton: ({
    isActive: _isActive,
    size: _size,
    children,
    ...props
  }: ComponentPropsWithoutRef<"button"> & { isActive?: boolean; size?: string }) => (
    <button {...props}>{children}</button>
  ),
  SidebarMenuAction: ({
    showOnHover: _showOnHover,
    children,
    ...props
  }: ComponentPropsWithoutRef<"button"> & { showOnHover?: boolean }) => (
    <button {...props}>{children}</button>
  ),
}));

import { STATUS_TONES, type ThreadStatusPill } from "../Sidebar.logic";
import type { AgentRow } from "../sidebar/agentsSection.logic";
import { AgentsRow } from "./AgentsRow";

const ENVIRONMENT = EnvironmentId.make("environment-a");
const ref = scopeThreadRef(ENVIRONMENT, ThreadId.make("thread-1"));

function row(overrides: Partial<AgentRow> = {}): AgentRow {
  return {
    key: "row-1",
    ref,
    shell: {
      id: ref.threadId,
      title: "Fix the build",
      updatedAt: "2026-10-27T11:00:00.000Z",
    } as EnvironmentThreadShell,
    branch: "main",
    group: "working",
    pill: { label: "Working", ...STATUS_TONES.working, pulse: true },
    unknownReason: null,
    terminalId: null,
    environmentLabel: "Remote",
    environmentLive: true,
    environmentStatus: "live",
    projectTitle: "Project",
    providerDriverKind: null,
    providerLabel: "Codex",
    previewLine: null,
    searchText: "",
    ...overrides,
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount(agent: AgentRow, onJumpToWorkspace?: (row: AgentRow) => void) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <ul>
        <AgentsRow
          row={agent}
          selected={false}
          onSelect={() => {}}
          {...(onJumpToWorkspace === undefined ? {} : { onJumpToWorkspace })}
        />
      </ul>,
    );
  });
  return container;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("AgentsRow (#187)", () => {
  it("pulses a live Working dot, and never one from a disconnected environment", async () => {
    const live = await mount(row());
    expect(live.querySelector(".animate-pulse")).not.toBeNull();
    await act(async () => root?.unmount());
    container?.remove();

    const offline = await mount(row({ environmentLive: false, environmentStatus: "unavailable" }));
    expect(offline.querySelector(".animate-pulse")).toBeNull();
    expect(offline.textContent).toContain("unavailable");
  });

  it("labels an unknown row by its reason and names a terminal row's terminal", async () => {
    const pill: ThreadStatusPill = {
      label: "Status unavailable",
      ...STATUS_TONES.unknown,
      pulse: false,
    };
    const element = await mount(
      row({
        key: "row-1#terminal:t-cursor",
        group: "unknown",
        unknownReason: "unavailable",
        pill,
        terminalId: "t-cursor",
        previewLine: "Cursor Terminal",
      }),
      () => {},
    );
    expect(
      element.querySelector(
        'button[aria-label="Fix the build, Cursor Terminal, Status unavailable, Remote"]',
      ),
    ).not.toBeNull();
    expect(
      element.querySelector(
        'button[aria-label="Jump to workspace for Fix the build, Cursor Terminal"]',
      ),
    ).not.toBeNull();
  });

  it("omits Jump to workspace when the host passes no handler (the Inbox)", async () => {
    const element = await mount(row());
    expect(element.querySelector('button[title="Jump to workspace"]')).toBeNull();
    expect(element.querySelectorAll("button")).toHaveLength(1);
  });
});
