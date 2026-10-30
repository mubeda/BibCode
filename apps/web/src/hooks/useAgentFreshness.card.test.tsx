// @vitest-environment happy-dom

import { EnvironmentId, ThreadId, type TerminalSummary } from "@bibcode/contracts";
import { DEFAULT_RUNTIME_MODE } from "../types";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// A mounted workspace card glyph through `useWorkspaceCardStatus`, the hook the left
// panel's cards call (#187): it decays at the threshold, and a terminal agent BiBCode
// cannot see keeps a finished card from reading Done.

const h = vi.hoisted(() => ({
  terminals: [] as ReadonlyArray<TerminalSummary>,
  statuses: [] as ReadonlyArray<{ environmentId: string; status: string }>,
}));

vi.mock("@effect/atom-react", () => ({
  // The only atoms the hook reads are the terminal ones.
  useAtomValue: () => h.terminals,
}));
vi.mock("../state/shell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/shell")>()),
  useEnvironmentShellSummary: () => ({ statuses: h.statuses }),
}));
vi.mock("../components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render: ReactNode; children: ReactNode }) => (
    <span data-trigger>
      {render}
      {children}
    </span>
  ),
  TooltipPopup: () => null,
}));

import { WORKSPACE_CARD_STATUS } from "../components/Sidebar.logic";
import { WorkspaceCardStatusGlyph } from "../components/sidebar/WorkspaceCard";
import { resetAgentEvidenceStampsForTests, useWorkspaceCardStatus } from "./useAgentFreshness";

const ENVIRONMENT = EnvironmentId.make("environment-a");
const START = Date.parse("2026-10-27T12:00:00.000Z");

type CardThread = NonNullable<Parameters<typeof useWorkspaceCardStatus>[0]>;

function thread(status: "running" | "ready", overrides: Partial<CardThread> = {}): CardThread {
  return {
    id: "thread-card",
    environmentId: ENVIRONMENT,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default",
    latestTurn: null,
    unresolvedDelivery: null,
    session: {
      threadId: ThreadId.make("thread-card"),
      status,
      providerName: "codex",
      runtimeMode: DEFAULT_RUNTIME_MODE,
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-10-27T11:00:00.000Z",
    },
    ...overrides,
  } as CardThread;
}

function Card(props: { readonly thread: CardThread }) {
  const status = useWorkspaceCardStatus(props.thread, null, WORKSPACE_CARD_STATUS.idle);
  return <WorkspaceCardStatusGlyph status={status} />;
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function mount(node: ReactNode): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
  return container;
}

function glyph(element: HTMLElement): string | null {
  return element.querySelector("[data-status]")?.getAttribute("aria-label") ?? null;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.terminals = [];
  h.statuses = [{ environmentId: ENVIRONMENT, status: "live" }];
  resetAgentEvidenceStampsForTests();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container?.remove();
  container = null;
  vi.useRealTimers();
});

describe("useWorkspaceCardStatus", () => {
  it("decays a mounted Working card glyph at the 30-minute threshold", async () => {
    vi.useFakeTimers({ now: START });
    const element = await mount(
      <Card
        thread={thread("running", {
          lastActivityAt: "2026-10-27T12:00:00.000Z",
          lastActivityAgeMs: 0,
        })}
      />,
    );
    expect(glyph(element)).toBe("Working");

    await act(async () => {
      vi.advanceTimersByTime(29 * 60_000);
    });
    expect(glyph(element)).toBe("Working");

    await act(async () => {
      vi.advanceTimersByTime(2 * 60_000);
    });
    expect(glyph(element)).toBe(WORKSPACE_CARD_STATUS.stale.label);
  });

  it("shows a running unobserved terminal agent instead of an idle card", async () => {
    h.terminals = [
      {
        threadId: "thread-card",
        terminalId: "t-cursor",
        cwd: "/repo",
        worktreePath: null,
        status: "running",
        pid: 1,
        exitCode: null,
        exitSignal: null,
        hasRunningSubprocess: true,
        label: "cursor-agent",
        updatedAt: "2026-10-27T11:00:00.000Z",
        centerPanel: true,
        oscColorResponderActive: false,
        agentStatus: { state: "unavailable", failed: false },
      } as unknown as TerminalSummary,
    ];
    const element = await mount(<Card thread={thread("ready")} />);
    expect(glyph(element)).toBe(WORKSPACE_CARD_STATUS.unavailable.label);
  });

  it("marks a disconnected environment's Working claim offline", async () => {
    h.statuses = [{ environmentId: ENVIRONMENT, status: "unavailable" }];
    const element = await mount(<Card thread={thread("running")} />);
    expect(glyph(element)).toBe(WORKSPACE_CARD_STATUS.offline.label);
  });
});
