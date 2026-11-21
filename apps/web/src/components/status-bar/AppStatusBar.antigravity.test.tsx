import type {
  ServerProviderUsageProvider,
  ServerProviderUsageResult,
  ServerProviderUsageSnapshot,
} from "@bibcode/contracts";
import { EnvironmentId } from "@bibcode/contracts";
import * as DateTime from "effect/DateTime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { AppStatusBarView, createStatusBarRefreshHandler } from "./AppStatusBar";
import { ProviderUsageControl } from "./ProviderUsageControl";

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("./McpAgentIndicator", () => ({ McpAgentIndicator: () => null }));
vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({
    children,
    ...props
  }: React.ComponentProps<"button"> & { children: React.ReactNode }) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  PopoverPopup: ({
    children,
    viewportClassName: _viewportClassName,
    ...props
  }: React.ComponentProps<"div"> & { viewportClassName?: string }) => (
    <div {...props}>{children}</div>
  ),
}));

const readAt = DateTime.makeUnsafe("2026-11-21T18:00:00.000Z");
const window = (usedPercent: number, windowMinutes: number) => ({
  usedPercent,
  windowMinutes,
  resetsAt: DateTime.makeUnsafe("2026-11-22T02:28:19.000Z"),
  resetDescription: null,
});

function snapshot(patch: Partial<ServerProviderUsageSnapshot> = {}): ServerProviderUsageSnapshot {
  return {
    provider: "antigravity",
    status: "ok",
    session: null,
    weekly: null,
    fableWeekly: null,
    windowGroups: [
      { id: "gemini", label: "Gemini models", session: window(50, 300), weekly: window(1, 10_080) },
      {
        id: "third-party",
        label: "Claude and GPT models",
        session: window(100, 300),
        weekly: window(0, 10_080),
      },
    ],
    planType: null,
    rateLimitResetCredits: null,
    updatedAt: readAt,
    error: null,
    metadata: {},
    ...patch,
  };
}

const result = (...providers: ServerProviderUsageSnapshot[]): ServerProviderUsageResult => ({
  readAt,
  isFetching: false,
  providers,
});

const diagnostics = {
  diagnostics: null,
  queryError: null,
};

function render(props: Partial<React.ComponentProps<typeof AppStatusBarView>>): string {
  return renderToStaticMarkup(
    <AppStatusBarView
      usage={result()}
      diagnostics={diagnostics}
      localDiagnostics={null}
      terminalCount={0}
      showClaudeUsage={false}
      showCodexUsage={false}
      showResourceUsage={false}
      presentationNow={readAt}
      onRefresh={() => undefined}
      {...props}
    />,
  );
}

describe("the Antigravity usage item", () => {
  it("is absent unless the opt-in is on", () => {
    expect(render({ antigravityUsage: result(snapshot()) })).not.toContain("antigravity");
  });

  it("shows both groups with their windows and reset times", () => {
    const markup = render({ showAntigravityUsage: true, antigravityUsage: result(snapshot()) });
    expect(markup).toContain('data-provider="antigravity"');
    for (const label of ["Gemini session", "Gemini weekly", "Claude/GPT session"]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain("Refresh provider usage");
  });

  it("reads before the first answer and keeps the refresh control reachable", () => {
    const markup = render({ showAntigravityUsage: true, antigravityUsage: null });
    expect(markup).toContain("Reading Antigravity usage...");
    expect(markup).toContain("Refresh provider usage");
  });

  it("says the server is too old when its answer has no Antigravity entry", () => {
    const markup = render({ showAntigravityUsage: true, antigravityUsage: result() });
    expect(markup).toContain("This BiBCode server is too old to show Antigravity usage.");
  });

  it("shows the server's sentence alone when there is no data, and never a sign-in instruction", () => {
    const sentence = "This Antigravity sign-in uses an API key, which has no account quota.";
    const markup = render({
      showAntigravityUsage: true,
      antigravityUsage: result(
        snapshot({ status: "unavailable", windowGroups: [], error: sentence }),
      ),
    });
    expect(markup).toContain(sentence);
    expect(markup).not.toContain("Showing last available usage");
    expect(markup).not.toContain("sign in");
  });

  it("treats the server's not-fetched message as reading, and a stale snapshot with its own sentence", () => {
    const notFetched = render({
      showAntigravityUsage: true,
      antigravityUsage: result(
        snapshot({
          status: "unavailable",
          windowGroups: [],
          error: "Provider usage has not been fetched yet.",
        }),
      ),
    });
    expect(notFetched).toContain("Reading Antigravity usage...");
    const stale = render({
      showAntigravityUsage: true,
      antigravityUsage: result(
        snapshot({ status: "unavailable", error: "Provider usage snapshot is stale." }),
      ),
    });
    expect(stale).toContain("Antigravity usage is out of date. It will be tried again.");
  });

  it("keeps the last data on an error and says so", () => {
    const markup = render({
      showAntigravityUsage: true,
      antigravityUsage: result(
        snapshot({
          status: "error",
          error: "Antigravity usage could not be read. It will be tried again.",
        }),
      ),
    });
    expect(markup).toContain("Showing last available usage.");
  });

  it("an unknown provider renders nothing, never another provider", () => {
    const unknown = snapshot({ provider: "mystery" as ServerProviderUsageProvider });
    const markup = renderToStaticMarkup(
      <ProviderUsageControl
        iconOnly={false}
        statusBarUsageMode="detailed"
        viewModel={{
          provider: unknown.provider,
          status: "ok",
          windows: [],
          detailedWindows: [],
          compactWindows: [],
          plan: null,
          credits: null,
          updatedAt: readAt,
          error: null,
        }}
        onOpenProviderSettings={() => undefined}
      />,
    );
    expect(markup).toBe("");
  });
});

describe("the status bar refresh with Antigravity", () => {
  const base = () => ({
    environmentId: EnvironmentId.make("environment-1"),
    refreshUsageQuery: vi.fn(),
    refreshProcessDiagnostics: vi.fn(),
    refreshLocalProcessDiagnostics: null,
  });

  it("asks for Antigravity in its own request and never in the Claude and Codex one", async () => {
    const refreshProviderUsage = vi.fn().mockResolvedValue(undefined);
    const refreshQuery = vi.fn();
    await createStatusBarRefreshHandler({
      ...base(),
      refreshProviderUsage,
      antigravity: { refreshQuery },
    })(true);
    expect(refreshProviderUsage).toHaveBeenCalledTimes(2);
    expect(refreshProviderUsage.mock.calls[0]?.[0].input).toEqual({
      providers: ["claude", "codex"],
      force: true,
    });
    expect(refreshProviderUsage.mock.calls[1]?.[0].input).toEqual({
      providers: ["antigravity"],
      force: true,
    });
    expect(refreshQuery).toHaveBeenCalledTimes(1);
  });

  it("a failing Antigravity request neither fails nor delays the Claude and Codex answer", async () => {
    const order: string[] = [];
    const refreshProviderUsage = vi.fn(
      async ({ input }: { input: { providers: readonly string[] } }) => {
        if (input.providers[0] === "antigravity") {
          await Promise.resolve();
          throw new Error("rejected by an old server");
        }
      },
    );
    const input = base();
    input.refreshUsageQuery.mockImplementation(() => order.push("claude-codex"));
    await expect(
      createStatusBarRefreshHandler({
        ...input,
        refreshProviderUsage,
        antigravity: { refreshQuery: () => order.push("antigravity") },
      })(false),
    ).resolves.toBeUndefined();
    expect(order).toEqual(["claude-codex", "antigravity"]);
  });

  it("without the opt-in sends only the legacy request", async () => {
    const refreshProviderUsage = vi.fn().mockResolvedValue(undefined);
    await createStatusBarRefreshHandler({ ...base(), refreshProviderUsage })(false);
    expect(refreshProviderUsage).toHaveBeenCalledTimes(1);
  });
});
