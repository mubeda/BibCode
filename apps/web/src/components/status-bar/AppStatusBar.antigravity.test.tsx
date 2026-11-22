import type {
  ServerProviderUsageProvider,
  ServerProviderUsageResult,
  ServerProviderUsageSnapshot,
} from "@bibcode/contracts";
import { EnvironmentId } from "@bibcode/contracts";
import * as DateTime from "effect/DateTime";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  AppStatusBarView,
  createAntigravityUsageRefreshHandler,
  createStatusBarRefreshHandler,
  statusBarRefreshControl,
} from "./AppStatusBar";
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

/** The bar and the popover of a rendered status bar (the popover is always rendered here). */
function parts(markup: string): [string, string] {
  const at = markup.indexOf('data-testid="provider-usage-detail"');
  return [markup.slice(0, at), markup.slice(at)];
}

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

  it("shows only the tightest window in the bar, in both modes", () => {
    for (const statusBarUsageMode of ["detailed", "compact"] as const) {
      const [bar] = parts(
        render({
          showAntigravityUsage: true,
          antigravityUsage: result(snapshot()),
          statusBarUsageMode,
        }),
      );
      expect(bar).toContain('data-provider="antigravity"');
      expect(bar).toContain("Claude/GPT 5-hour");
      expect(bar).not.toContain("Gemini");
      expect(bar).not.toContain("Weekly");
    }
  });

  it("shows one popover section per group, with 5-hour and weekly windows and reset times", () => {
    const [, popover] = parts(
      render({ showAntigravityUsage: true, antigravityUsage: result(snapshot()) }),
    );
    expect(popover).toContain('aria-label="Gemini models"');
    expect(popover).toContain('aria-label="Claude and GPT models"');
    expect(popover.match(/>5-hour</g)).toHaveLength(2);
    expect(popover.match(/>Weekly</g)).toHaveLength(2);
    expect(popover).not.toContain("Reset time unavailable");
    expect(popover).toContain("Updated");
  });

  it("uses the Antigravity icon, not the Gemini one", () => {
    const markup = render({ showAntigravityUsage: true, antigravityUsage: result(snapshot()) });
    expect(markup).toContain('data-provider-icon="antigravity"');
    expect(markup).toContain("<image");
    expect(markup).not.toContain("gemini__");
  });

  it("reads before the first answer, quietly, with no update time, and keeps the refresh control", () => {
    const markup = render({ showAntigravityUsage: true, antigravityUsage: null });
    expect(markup).toContain(
      'class="text-muted-foreground" role="status">Reading Antigravity usage...',
    );
    expect(markup).not.toContain("Updated");
    expect(markup).toContain("Refresh provider usage");
  });

  it("says how to recover when the read failed, instead of reading forever", () => {
    const markup = render({
      showAntigravityUsage: true,
      antigravityUsage: null,
      antigravityUsageError: "The environment is not connected.",
    });
    expect(markup).toContain(
      "Could not load Antigravity usage. Use the refresh button to try again.",
    );
    expect(markup).not.toContain("Reading Antigravity usage...");
  });

  it("says how to recover when a read fails after the server's not-fetched answer", () => {
    const markup = render({
      showAntigravityUsage: true,
      antigravityUsage: result(
        snapshot({
          status: "unavailable",
          windowGroups: [],
          error: "Provider usage has not been fetched yet.",
        }),
      ),
      antigravityUsageError: "The environment is not connected.",
    });
    expect(markup).toContain(
      "Could not load Antigravity usage. Use the refresh button to try again.",
    );
    expect(markup).not.toContain("Reading Antigravity usage...");
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
    expect(notFetched).toContain(
      'class="text-muted-foreground" role="status">Reading Antigravity usage...',
    );
    expect(notFetched).not.toContain("Updated");
    const stale = render({
      showAntigravityUsage: true,
      antigravityUsage: result(
        snapshot({ status: "unavailable", error: "Provider usage snapshot is stale." }),
      ),
    });
    expect(stale).toContain("Antigravity usage is out of date. It will be tried again.");
    // Expired data shows the sentence only: no meters in the bar or the popover.
    expect(stale).not.toContain("5-hour");
    expect(stale).not.toContain("Weekly");
    expect(stale).not.toContain("Showing last available usage");
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
          groups: [],
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
  const environmentId = EnvironmentId.make("environment-1");

  it("never names Antigravity in the Claude and Codex request", async () => {
    const refreshProviderUsage = vi.fn().mockResolvedValue(undefined);
    await createStatusBarRefreshHandler({
      environmentId,
      refreshProviderUsage,
      refreshUsageQuery: vi.fn(),
      refreshProcessDiagnostics: vi.fn(),
      refreshLocalProcessDiagnostics: null,
    })(true);
    expect(refreshProviderUsage).toHaveBeenCalledTimes(1);
    expect(refreshProviderUsage.mock.calls[0]?.[0].input).toEqual({
      providers: ["claude", "codex"],
      force: true,
    });
  });

  it("asks for Antigravity alone and re-reads it when its own request settles", async () => {
    const legacyNeverSettles = new Promise<never>(() => undefined);
    const refreshProviderUsage = vi.fn(({ input }: { input: { providers: readonly string[] } }) =>
      input.providers[0] === "antigravity" ? Promise.resolve() : legacyNeverSettles,
    );
    void createStatusBarRefreshHandler({
      environmentId,
      refreshProviderUsage,
      refreshUsageQuery: vi.fn(),
      refreshProcessDiagnostics: vi.fn(),
      refreshLocalProcessDiagnostics: null,
    })(false);
    const refreshQuery = vi.fn();
    await createAntigravityUsageRefreshHandler({
      environmentId,
      refreshProviderUsage,
      refreshQuery,
    })(false);
    expect(refreshProviderUsage.mock.calls[1]?.[0].input).toEqual({
      providers: ["antigravity"],
      force: false,
    });
    expect(refreshQuery).toHaveBeenCalledTimes(1);
  });

  it("a rejected Antigravity request still re-reads, so an old server is recognized", async () => {
    const refreshQuery = vi.fn();
    await expect(
      createAntigravityUsageRefreshHandler({
        environmentId,
        refreshProviderUsage: vi.fn().mockRejectedValue(new Error("invalid request")),
        refreshQuery,
      })(true),
    ).resolves.toBeUndefined();
    expect(refreshQuery).toHaveBeenCalledTimes(1);
  });

  it("a slow request disables the button only when every visible request is busy", () => {
    const legacy = (busy: boolean) => ({ visible: true, busy });
    const antigravity = (busy: boolean) => ({ visible: true, busy });
    expect(statusBarRefreshControl([legacy(false), antigravity(true)])).toEqual({
      busy: true,
      disabled: false,
    });
    expect(statusBarRefreshControl([legacy(true), antigravity(false)])).toEqual({
      busy: true,
      disabled: false,
    });
    expect(statusBarRefreshControl([legacy(true), antigravity(true)])).toEqual({
      busy: true,
      disabled: true,
    });
    // Antigravity alone: its own request decides; a hidden legacy poll never spins the button.
    expect(statusBarRefreshControl([{ visible: false, busy: true }, antigravity(false)])).toEqual({
      busy: false,
      disabled: false,
    });
    expect(statusBarRefreshControl([legacy(true), { visible: false, busy: false }])).toEqual({
      busy: true,
      disabled: true,
    });
  });
});
