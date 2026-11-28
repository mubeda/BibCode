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
const usageWindow = (usedPercent: number, windowMinutes: number) => ({
  usedPercent,
  windowMinutes,
  resetsAt: DateTime.makeUnsafe("2026-11-22T02:28:19.000Z"),
  resetDescription: null,
});

function snapshot(
  provider: ServerProviderUsageProvider,
  patch: Partial<ServerProviderUsageSnapshot> = {},
): ServerProviderUsageSnapshot {
  return {
    provider,
    status: "ok",
    session: usageWindow(20, 300),
    weekly: usageWindow(45, 10_080),
    fableWeekly: null,
    windowGroups: [],
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

describe("Antigravity status-bar usage removal (#429)", () => {
  it("never renders an Antigravity usage chip while keeping Claude and Codex meters unchanged", () => {
    const markup = renderToStaticMarkup(
      <AppStatusBarView
        usage={result(
          snapshot("claude"),
          snapshot("codex"),
          snapshot("antigravity", {
            session: null,
            weekly: null,
            windowGroups: [
              {
                id: "gemini",
                label: "Gemini models",
                session: usageWindow(50, 300),
                weekly: usageWindow(1, 10_080),
              },
            ],
          }),
        )}
        diagnostics={diagnostics}
        localDiagnostics={null}
        terminalCount={0}
        showClaudeUsage
        showCodexUsage
        showResourceUsage={false}
        presentationNow={readAt}
        onRefresh={() => undefined}
      />,
    );

    expect(markup).toContain('data-provider="claude"');
    expect(markup).toContain('data-provider="codex"');
    expect(markup).not.toContain('data-provider="antigravity"');
    expect(markup).not.toContain("Gemini models");
    expect(markup).not.toContain("Antigravity usage");
  });

  it("an unknown provider renders nothing, never another provider", () => {
    const unknown = snapshot("mystery" as ServerProviderUsageProvider);
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

  it("refreshes only Claude and Codex and never names Antigravity", async () => {
    const refreshProviderUsage = vi.fn().mockResolvedValue(undefined);
    await createStatusBarRefreshHandler({
      environmentId: EnvironmentId.make("environment-1"),
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
});
