// @vitest-environment happy-dom

import { scopeThreadRef } from "@bibcode/client-runtime/environment";
import type { EnvironmentThreadShell } from "@bibcode/client-runtime/state/models";
import { EnvironmentId, ThreadId } from "@bibcode/contracts";
import { act, type ComponentPropsWithoutRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({ unread: false }));

vi.mock("../../sidebarWorkspaceMetaStore", () => ({
  selectIsUnread: () => h.unread,
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

async function mount(
  agent: AgentRow,
  onJumpToWorkspace?: (row: AgentRow) => void,
  selected = false,
) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <ul>
        <AgentsRow
          row={agent}
          selected={selected}
          onSelect={() => {}}
          {...(onJumpToWorkspace === undefined ? {} : { onJumpToWorkspace })}
        />
      </ul>,
    );
  });
  return container;
}

/** A row's accessible name or description: the text of the lines it references. */
function referencedText(element: Element, attribute: "aria-labelledby" | "aria-describedby") {
  return (element.getAttribute(attribute) ?? "")
    .split(" ")
    .filter((id) => id !== "")
    .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "")
    .join(", ");
}

function agentButton(element: HTMLElement): HTMLButtonElement {
  const button = element.querySelector<HTMLButtonElement>("button[aria-labelledby]");
  if (button === null) throw new Error("Missing the agent row button");
  return button;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.unread = false;
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
    const button = agentButton(element);
    expect(referencedText(button, "aria-labelledby")).toBe("main, Fix the build, Cursor Terminal");
    expect(referencedText(button, "aria-describedby")).toBe(
      "Status unavailable, Codex, Remote, Project",
    );
    expect(
      element.querySelector(
        'button[aria-label="Jump to workspace for Fix the build, Cursor Terminal"]',
      ),
    ).not.toBeNull();
  });

  it("omits Jump to workspace, and the room it takes, when the host passes no handler", async () => {
    const element = await mount(row());
    expect(element.querySelector('button[title="Jump to workspace"]')).toBeNull();
    expect(element.querySelectorAll("button")).toHaveLength(1);
    expect(agentButton(element).className).not.toContain("pr-9");
    await act(async () => root?.unmount());
    container?.remove();

    const withJump = await mount(row(), () => {});
    expect(agentButton(withJump).className).toContain("pr-9");
  });

  it("is named and described by what the card shows, unread included", async () => {
    // Mutation caught: an aria-label that replaces the card, dropping its branch, project
    // and unread state for a screen reader.
    h.unread = true;
    const element = await mount(row());
    const button = agentButton(element);
    expect(button.hasAttribute("aria-label")).toBe(false);
    expect(referencedText(button, "aria-labelledby")).toBe("main, Fix the build");
    expect(referencedText(button, "aria-describedby")).toBe(
      "Working, Codex, Remote, Project, Unread",
    );
  });

  it("marks the open row current instead of pressed", async () => {
    const closed = await mount(row());
    expect(agentButton(closed).hasAttribute("aria-current")).toBe(false);
    expect(agentButton(closed).hasAttribute("aria-pressed")).toBe(false);
    await act(async () => root?.unmount());
    container?.remove();

    const open = await mount(row(), undefined, true);
    expect(agentButton(open).getAttribute("aria-current")).toBe("true");
    expect(agentButton(open).hasAttribute("aria-pressed")).toBe(false);
  });
});
