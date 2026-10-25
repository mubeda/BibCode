// @vitest-environment happy-dom

import {
  type AgentSessionHistoryEntry,
  AgentSessionsError,
  type AgentSessionThreadListResult,
  EnvironmentId,
  ThreadId,
} from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  primaryEnvironmentId: null as string | null,
  scopes: undefined as ReadonlyArray<string> | undefined,
  closedChats: [] as Array<{ id: string; title: string; archivedAt: string }>,
  closedChatsError: null as string | null,
  refreshClosedChats: vi.fn(),
  listCalls: [] as Array<{ input: unknown; signal: AbortSignal | undefined }>,
  listResults: [] as Array<() => Promise<unknown>>,
  serverConfig: { environment: { capabilities: { cliSessionHistory: true } } } as unknown,
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => h.serverConfig }));
vi.mock("~/state/server", () => ({
  serverEnvironment: { configValueAtom: (environmentId: string) => ({ environmentId }) },
}));

vi.mock("~/state/environments", () => ({
  usePrimaryEnvironmentId: () => h.primaryEnvironmentId,
}));
vi.mock("~/environments/primary", () => ({
  usePrimarySessionState: () => ({ data: h.scopes === undefined ? {} : { scopes: h.scopes } }),
}));
vi.mock("~/state/projects", () => ({
  projectEnvironment: { listThreadAgentSessions: { label: "list" } },
}));
vi.mock("~/state/use-atom-command", () => {
  const list = (input: unknown, runOptions?: { signal?: AbortSignal }) => {
    h.listCalls.push({ input, signal: runOptions?.signal });
    const next = h.listResults.shift();
    return next ? next() : new Promise(() => undefined);
  };
  return { useAtomCommand: () => list };
});
vi.mock("~/timestampFormat", () => ({ formatRelativeTimeLabel: () => "5 min ago" }));
vi.mock("./ChatHeaderPanelMenu", () => ({
  closedChatLabel: (title: string) => title,
  useClosedChatPanels: () => ({
    closedChats: h.closedChats,
    isLoading: false,
    error: h.closedChatsError,
    refresh: h.refreshClosedChats,
  }),
}));
vi.mock("../ui/button", () => ({
  Button: (props: React.ComponentProps<"button">) => <button {...props} />,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render?: React.ReactNode }) => <>{render}</>,
  TooltipPopup: ({ children }: { children?: React.ReactNode }) => (
    <span data-tooltip>{children}</span>
  ),
}));
vi.mock("../ui/menu", () => {
  const MenuContext = React.createContext<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }>({ open: false, onOpenChange: () => undefined });
  return {
    Menu: (props: {
      open: boolean;
      onOpenChange: (open: boolean) => void;
      children?: React.ReactNode;
    }) => {
      const value = React.useMemo(
        () => ({ open: props.open, onOpenChange: props.onOpenChange }),
        [props.open, props.onOpenChange],
      );
      return <MenuContext.Provider value={value}>{props.children}</MenuContext.Provider>;
    },
    MenuTrigger: ({ render }: { render: React.ReactElement<{ onClick?: () => void }> }) => {
      const menu = React.useContext(MenuContext);
      return React.cloneElement(render, { onClick: () => menu.onOpenChange(!menu.open) });
    },
    MenuPopup: ({ children }: { children?: React.ReactNode }) =>
      React.useContext(MenuContext).open ? <div role="menu">{children}</div> : null,
    MenuGroup: ({ children }: { children?: React.ReactNode }) => <div role="group">{children}</div>,
    MenuGroupLabel: ({ children }: { children?: React.ReactNode }) => <h3>{children}</h3>,
    MenuSeparator: () => <hr />,
    MenuItem: (props: {
      children?: React.ReactNode;
      disabled?: boolean;
      closeOnClick?: boolean;
      onClick?: () => void;
    }) => {
      const menu = React.useContext(MenuContext);
      return (
        <button
          type="button"
          role="menuitem"
          disabled={props.disabled}
          onClick={() => {
            props.onClick?.();
            if (props.closeOnClick !== false) menu.onOpenChange(false);
          }}
        >
          {props.children}
        </button>
      );
    },
  };
});

import { ComposerHistoryMenu, type ComposerHistoryMenuProps } from "./ComposerHistoryMenu";

const environmentId = EnvironmentId.make("studio");
const hostThreadId = ThreadId.make("host");
const CLOSED = "1a8b5c2e-4d6a-4b1c-9e3f-2a7d8c9b1e40";
const LIVE = "2a8b5c2e-4d6a-4b1c-9e3f-2a7d8c9b1e40";
const REFUSED = "3a8b5c2e-4d6a-4b1c-9e3f-2a7d8c9b1e40";
const IMPORTED = "4a8b5c2e-4d6a-4b1c-9e3f-2a7d8c9b1e40";

function session(
  sessionId: string,
  title: string,
  overrides: Partial<AgentSessionHistoryEntry> = {},
): AgentSessionHistoryEntry {
  return {
    sessionId,
    title,
    lastActiveAt: "2026-10-24T10:00:00.000Z",
    branch: "feature/history",
    liveness: "closed",
    importDeleted: false,
    ...overrides,
  } as AgentSessionHistoryEntry;
}

function listing(
  sessions: ReadonlyArray<AgentSessionHistoryEntry>,
  overrides: Partial<AgentSessionThreadListResult> = {},
) {
  return () =>
    Promise.resolve({
      _tag: "Success",
      value: { sessions, truncated: false, copySupported: true, ...overrides },
    });
}

let root: Root | null = null;
let container: HTMLDivElement;
const onReopenChat = vi.fn();
const onOpenImported = vi.fn();
const onContinueSession = vi.fn<ComposerHistoryMenuProps["onContinueSession"]>();

function render(overrides: Partial<ComposerHistoryMenuProps> = {}) {
  const props: ComposerHistoryMenuProps = {
    environmentId,
    hostThreadId,
    unavailableReason: null,
    environmentLabel: "Studio",
    onReopenChat,
    onOpenImported,
    onContinueSession,
    ...overrides,
  };
  act(() => {
    root ??= createRoot(container);
    root.render(<ComposerHistoryMenu {...props} />);
  });
}

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));
const historyButton = () => container.querySelector<HTMLButtonElement>('[aria-label="History"]')!;
const items = () => [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
const item = (text: string) => items().find((element) => element.textContent?.includes(text))!;
const text = () => container.textContent ?? "";

async function open() {
  act(() => historyButton().click());
  await flush();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  h.primaryEnvironmentId = null;
  h.scopes = undefined;
  h.closedChats = [];
  h.closedChatsError = null;
  h.listCalls.length = 0;
  h.listResults.length = 0;
  h.serverConfig = { environment: { capabilities: { cliSessionHistory: true } } };
  vi.clearAllMocks();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

describe("ComposerHistoryMenu", () => {
  it("loads nothing until opened and aborts the listing when closed", async () => {
    render();
    expect(h.listCalls).toHaveLength(0);
    expect(container.querySelector('[role="menu"]')).toBeNull();
    await open();
    expect(h.listCalls).toEqual([
      { input: { environmentId, input: { threadId: hostThreadId } }, signal: expect.anything() },
    ]);
    const signal = h.listCalls[0]!.signal!;
    expect(signal.aborted).toBe(false);
    expect(item("Claude Code terminal")).toBeUndefined();
    expect(text()).toContain("Loading…");
    act(() => historyButton().click());
    expect(signal.aborted).toBe(true);
  });

  it("shows This thread above the terminal sessions, each with its empty state", async () => {
    h.listResults.push(listing([]));
    render();
    await open();
    const content = text();
    expect(content.indexOf("This thread")).toBeLessThan(content.indexOf("Claude Code terminal"));
    expect(content).toContain("No closed chats");
    expect(content).toContain("No Claude Code sessions in this folder.");
    expect(content).toContain("Only sessions run on Studio appear here.");
    expect(container.querySelector("hr")).not.toBeNull();
  });

  it("leaves the remote note out for this machine's own server", async () => {
    h.primaryEnvironmentId = environmentId;
    h.listResults.push(listing([]));
    render();
    await open();
    expect(text()).toContain("No Claude Code sessions in this folder.");
    expect(text()).not.toContain("Only sessions run on");
  });

  it("reopens a closed chat of this thread", async () => {
    h.closedChats = [{ id: "panel-1", title: "Codex", archivedAt: "2026-10-24T09:00:00.000Z" }];
    render();
    await open();
    act(() => item("Codex").click());
    expect(onReopenChat).toHaveBeenCalledWith("panel-1", "Codex");
  });

  it("offers a retry with the server's reason when the listing fails", async () => {
    h.listResults.push(() =>
      Promise.resolve({
        _tag: "Failure",
        cause: Cause.fail(
          new AgentSessionsError({ message: "Claude Code is turned off on the server." }),
        ),
      }),
    );
    render();
    await open();
    expect(text()).toContain("Couldn't load sessions. Select to retry.");
    expect(text()).toContain("Claude Code is turned off on the server.");
    h.listResults.push(listing([session(CLOSED, "Flaky test")]));
    act(() => item("Couldn't load sessions").click());
    await flush();
    expect(h.listCalls).toHaveLength(2);
    expect(text()).toContain("Flaky test");
  });

  it("asks an older server to be updated instead of listing", async () => {
    h.serverConfig = { environment: { capabilities: { cliSessionHistory: false } } };
    render();
    await open();
    expect(text()).toContain("Update Studio to list its terminal sessions here.");
    expect(h.listCalls).toHaveLength(0);
  });

  it("names each row's action and sends the matching mode", async () => {
    h.listResults.push(
      listing(
        [
          session(CLOSED, "Closed work"),
          session(LIVE, "Live work", { liveness: "live" }),
          session(REFUSED, "Refused work", {
            importedThread: {
              threadId: ThreadId.make(`import:claudeAgent:${REFUSED}`),
              hostThreadId,
              archived: false,
              resumeRefused: true,
            },
          }),
          session(IMPORTED, "Imported work", {
            importedThread: {
              threadId: ThreadId.make(`import:claudeAgent:${IMPORTED}`),
              hostThreadId: ThreadId.make("other-host"),
              archived: true,
              resumeRefused: false,
            },
          }),
        ],
        { truncated: true },
      ),
    );
    render();
    await open();
    expect(item("Closed work").textContent).toContain("feature/history · Continue");
    expect(item("Live work").textContent).toContain("Open in a terminal · Continue in a copy");
    expect(item("Refused work").textContent).toContain(
      "Couldn't continue it here · Continue in a copy",
    );
    expect(item("Imported work").textContent).toContain("Open");
    expect(text()).toContain("Older sessions aren't shown.");

    // Continue keeps the menu open, showing the row's progress, until the panel opened.
    let finish!: (opened: boolean) => void;
    onContinueSession.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    act(() => item("Closed work").click());
    expect(onContinueSession).toHaveBeenCalledWith(CLOSED, "resume", "Closed work");
    expect(item("Closed work").textContent).toContain("Opening…");
    expect(item("Live work").disabled).toBe(true);
    await act(async () => finish(true));
    expect(container.querySelector('[role="menu"]')).toBeNull();

    // A copy that fails leaves the menu open and lists the sessions again.
    h.listResults.push(listing([session(LIVE, "Live work", { liveness: "live" })]));
    await open();
    onContinueSession.mockResolvedValueOnce(false);
    h.listResults.push(listing([session(LIVE, "Live work", { liveness: "live" })]));
    await act(async () => item("Live work").click());
    await flush();
    expect(onContinueSession).toHaveBeenLastCalledWith(LIVE, "fork", "Live work");
    expect(container.querySelector('[role="menu"]')).not.toBeNull();
    expect(h.listCalls).toHaveLength(3);
  });

  it("opens a session's existing thread and continues a refused import in a copy", async () => {
    const refused = session(REFUSED, "Refused work", {
      importedThread: {
        threadId: ThreadId.make(`import:claudeAgent:${REFUSED}`),
        hostThreadId,
        archived: false,
        resumeRefused: true,
      },
    });
    const imported = session(IMPORTED, "Imported work", {
      importedThread: {
        threadId: ThreadId.make(`import:claudeAgent:${IMPORTED}`),
        hostThreadId: ThreadId.make("other-host"),
        archived: true,
        resumeRefused: false,
      },
    });
    h.listResults.push(listing([refused, imported]));
    render();
    await open();
    onContinueSession.mockResolvedValueOnce(true);
    await act(async () => item("Refused work").click());
    expect(onContinueSession).toHaveBeenCalledWith(REFUSED, "fork", "Refused work");

    h.listResults.push(listing([refused, imported]));
    await open();
    act(() => item("Imported work").click());
    expect(onOpenImported).toHaveBeenCalledWith(
      {
        threadId: `import:claudeAgent:${IMPORTED}`,
        hostThreadId: "other-host",
        archived: true,
      },
      "Imported work",
    );
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it("disables a copy this server's Claude Code can't make, saying why", async () => {
    h.listResults.push(
      listing([session(LIVE, "Live work", { liveness: "live" })], { copySupported: false }),
    );
    render();
    await open();
    const row = item("Live work");
    expect(row.disabled).toBe(true);
    expect(row.textContent).toContain("Update Claude Code to continue this in a copy.");
    expect(row.textContent).not.toContain("Continue in a copy");
  });

  it("explains a disabled button, also for a view-only connection", () => {
    render({ unavailableReason: "Available once this thread has started.", hostThreadId: null });
    expect(historyButton().getAttribute("aria-disabled")).toBe("true");
    expect(text()).toContain("Available once this thread has started.");

    const remount = () => {
      act(() => root?.unmount());
      root = null;
      render();
    };
    h.primaryEnvironmentId = environmentId;
    h.scopes = ["orchestration:read"];
    remount();
    expect(historyButton().getAttribute("aria-disabled")).toBe("true");
    expect(text()).toContain("This connection can only view threads.");

    // A server that sends no scope list leaves the button enabled.
    h.scopes = undefined;
    remount();
    expect(historyButton().getAttribute("aria-disabled")).toBeNull();
    expect(text()).toContain("History");
  });
});
