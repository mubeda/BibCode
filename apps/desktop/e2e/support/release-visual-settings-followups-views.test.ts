// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - Actual mounted views receive decoded inert query/connection fixtures only.
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "../../../../packages/contracts/src/baseSchemas.ts";
import {
  ServerTraceDiagnosticsResult,
  ServerProcessDiagnosticsResult,
} from "../../../../packages/contracts/src/server.ts";
import {
  readSettingsFollowup,
  validateSettingsFollowupWitness,
  settingsFollowupCommonFacts,
  settingsFollowupFacts,
  type SettingsFollowupObservation,
} from "./release-visual-settings-followups.ts";
const state = vi.hoisted(() => ({
  trace: null as unknown,
  process: null as unknown,
  queries: [] as Array<{ environmentId: unknown; tag: string }>,
  refreshes: 0,
}));
vi.mock("../../../web/src/state/server.ts", () => {
  const Atom = NodeModule.createRequire(NodePath.resolve("apps/web/package.json"))(
    "effect/unstable/reactivity/Atom",
  );
  return {
    primaryServerObservabilityAtom: Atom.make({ logsDirectoryPath: "/owned/logs" }),
    primaryServerAvailableEditorsAtom: Atom.make([]),
    serverEnvironment: {
      traceDiagnostics: (args: object) => ({ ...args, tag: "trace" }),
      processDiagnostics: (args: object) => ({ ...args, tag: "process" }),
      processResourceHistory: (args: object) => ({ ...args, tag: "resource" }),
      signalProcess: "signal",
    },
  };
});
vi.mock("../../../web/src/state/shell.ts", () => ({ shellEnvironment: { openInEditor: "open" } }));
vi.mock("../../../web/src/state/environments.ts", () => ({
  usePrimaryEnvironment: () => ({
    environmentId: "local",
    serverConfig: { environment: { platform: { os: "linux" } } },
  }),
}));
vi.mock("../../../web/src/state/query.ts", () => ({
  useEnvironmentQuery: (query: { environmentId: string; tag: string }) => {
    state.queries.push(query);
    return {
      data: query.tag === "trace" ? state.trace : query.tag === "process" ? state.process : null,
      error: null,
      isPending: false,
      refresh: () => {
        state.refreshes++;
      },
    };
  },
}));
vi.mock("../../../web/src/state/use-atom-command.ts", () => ({
  useAtomCommand: () => async () => ({ _tag: "Success" }),
}));

const require = NodeModule.createRequire(NodePath.resolve("apps/web/package.json")),
  React = require("react") as {
    act: (run: () => void | Promise<void>) => Promise<void>;
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => unknown;
  },
  Schema = require("effect/Schema");
const { createRoot } = require("react-dom/client") as {
  createRoot: (node: HTMLElement) => { render: (value: unknown) => void; unmount: () => void };
};
const mounts: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of mounts.splice(0)) await close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  state.queries = [];
  state.refreshes = 0;
  document.body.innerHTML = "";
});
const time = "2026-10-06T00:00:00Z";
function fixtures() {
  state.trace = Schema.decodeUnknownSync(Schema.toCodecJson(ServerTraceDiagnosticsResult))({
    traceFilePath: "/owned/logs/server.trace.ndjson",
    scannedFilePaths: ["/owned/logs/server.trace.ndjson"],
    readAt: time,
    recordCount: 3,
    parseErrorCount: 0,
    firstSpanAt: { _tag: "None" },
    lastSpanAt: { _tag: "None" },
    failureCount: 1,
    interruptionCount: 0,
    slowSpanThresholdMs: 500,
    slowSpanCount: 0,
    logLevelCounts: { Error: 1 },
    topSpansByCount: [
      {
        name: "agent_activity_enabled",
        count: 2,
        failureCount: 0,
        measuredCount: 0,
        totalDurationMs: 0,
        averageDurationMs: 0,
        maxDurationMs: 0,
      },
    ],
    slowestSpans: [],
    commonFailures: [],
    latestFailures: [
      {
        name: "gitManager.getRefs",
        durationMs: 0.5,
        durationMeasured: true,
        endedAt: time,
        traceId: "owned-trace",
        spanId: "owned-span",
        cause:
          "Owned requested repository directory is unavailable. Open an existing owned folder and try again.",
      },
    ],
    latestWarningAndErrorLogs: [],
    partialFailure: { _tag: "None" },
    error: { _tag: "None" },
  });
  state.process = Schema.decodeUnknownSync(Schema.toCodecJson(ServerProcessDiagnosticsResult))({
    serverPid: 1,
    readAt: time,
    totals: {
      combined: { cpuPercent: 1, rssBytes: 1000, processCount: 1 },
      core: { cpuPercent: 1, rssBytes: 1000, processCount: 1 },
      external: { cpuPercent: 0, rssBytes: 0, processCount: 0 },
    },
    uiCoverage: { status: "notApplicable", message: { _tag: "None" } },
    processes: [
      {
        pid: 1,
        ppid: 0,
        pgid: { _tag: "None" },
        status: "Running",
        cpuPercent: 1,
        rssBytes: 1000,
        elapsed: "1s",
        command: "Owned server",
        depth: 0,
        childPids: [],
        processKey: "owned-key",
        scope: "core",
        kind: "server",
        label: "Owned server",
        confidence: "exact",
      },
    ],
    error: { _tag: "None" },
  });
}
const input: SettingsFollowupObservation = {
  scene: "diagnostics-unknown-duration",
  theme: "light",
  origin: "http://127.0.0.1:4885",
  environmentId: "local",
  environmentLabel: "Owned server",
  projectTitle: "Owned project",
  threadId: "owned-thread",
  projectId: "owned-project",
  workspaceKind: "primary",
  originalLabel: "Owned server",
  reportedLabel: "Owned server",
  spanCount: 3,
  failureCount: 1,
  usageLabels: [],
  formerUsageLabels: [],
  processLabels: ["Owned server"],
  unmeasuredSpanName: "agent_activity_enabled",
  unmeasuredCount: 2,
  failureCause:
    "Owned requested repository directory is unavailable. Open an existing owned folder and try again.",
};
it.each([
  "diagnostics-unknown-duration",
  "settings-diagnostics",
  "diagnostics-live-processes",
] as const)(
  "mounts actual primary Diagnostics and binds the %s native values and critical targets",
  async (scene) => {
    const observed = { ...input, scene };
    fixtures();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("location", {
      origin: input.origin,
      pathname: "/settings/diagnostics",
      search: "",
      hash: "",
    });
    vi.stubGlobal("innerWidth", 1280);
    vi.stubGlobal("innerHeight", 960);
    const path = "../../../web/src/components/settings/DiagnosticsSettings.tsx",
      { DiagnosticsSettingsPanel } = await import(path);
    const node = document.createElement("div");
    document.body.append(node);
    const root = createRoot(node);
    mounts.push(async () => {
      await React.act(async () => root.unmount());
      node.remove();
    });
    await React.act(async () =>
      root.render(
        React.createElement(
          "div",
          null,
          React.createElement(
            "button",
            {
              "data-testid": "environment-rail-local",
              "aria-label": "Local — this machine",
              "aria-checked": "true",
            },
            React.createElement("i", { "data-status": "connected" }),
          ),
          React.createElement(DiagnosticsSettingsPanel, null),
        ),
      ),
    );
    expect(
      state.queries.every((query) => query.environmentId === EnvironmentId.make("local")),
    ).toBe(true);
    const sectionWith = (title: string) =>
      Array.from(document.querySelectorAll("section")).find(
        (value) => value.querySelector("h2")?.textContent?.trim() === title,
      )!;
    const unknown = sectionWith("Top Span Names"),
      failures = sectionWith("Latest Failures"),
      section = sectionWith(
        scene === "settings-diagnostics"
          ? "Trace Diagnostics"
          : scene === "diagnostics-live-processes"
            ? "Live Processes"
            : "Top Span Names",
      );
    expect(unknown.textContent).toContain("agent_activity_enabled");
    expect(unknown.textContent?.match(/Not recorded/g)).toHaveLength(2);
    expect(unknown.textContent).not.toContain("0 ms");
    const rail = document.querySelector('[data-testid="environment-rail-local"]')!;
    const cause = failures.querySelector("td:nth-child(2) div > div") as HTMLElement,
      duration = failures.querySelector("td:nth-child(3)"),
      combined = section.querySelector('[data-resource-card="combined"]'),
      label = section.querySelector("tbody td:nth-child(3) span");
    cause.style.lineHeight = "18px";
    cause.style.whiteSpace = "pre-wrap";
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        return this === rail || rail.contains(this)
          ? new DOMRect(0, 0, 30, 30)
          : this === cause
            ? new DOMRect(300, 550, 300, 40)
            : this === duration
              ? new DOMRect(800, 550, 100, 40)
              : this === failures
                ? new DOMRect(100, 500, 1000, 200)
                : this === combined
                  ? new DOMRect(100, 100, 1000, 200)
                  : this === label
                    ? new DOMRect(100, 400, 200, 50)
                    : this.closest("tbody")
                      ? new DOMRect(100, 400, 1000, 100)
                      : new DOMRect(100, 40, 1000, 800);
      },
    );
    vi.spyOn(document, "elementFromPoint").mockImplementation((x, y) =>
      x < 50
        ? rail
        : y >= 550 && y <= 590 && x >= 800 && x <= 900
          ? duration
          : y >= 550 && y <= 590 && x >= 300 && x <= 600
            ? cause
            : y >= 500 && y <= 700 && scene === "settings-diagnostics"
              ? failures.querySelector("tbody tr")
              : y >= 100 && y <= 300 && combined
                ? combined
                : y >= 400 && y <= 450 && x < 350 && label
                  ? label
                  : y >= 400 && y <= 500
                    ? (section.querySelector("tbody tr") ?? section)
                    : section,
    );
    expect(readSettingsFollowup(observed)).toEqual(
      Object.fromEntries(
        [...settingsFollowupCommonFacts, ...settingsFollowupFacts[scene]].map((key) => [key, true]),
      ),
    );
    expect(() =>
      validateSettingsFollowupWitness(observed.scene, readSettingsFollowup(observed)),
    ).not.toThrow();
    if (scene === "settings-diagnostics") {
      cause.textContent = "An unrelated earlier read failed.";
      expect(() =>
        validateSettingsFollowupWitness(observed.scene, readSettingsFollowup(observed)),
      ).toThrow();
    }
    const refresh = document.querySelector<HTMLButtonElement>(
      '[aria-label="Refresh trace diagnostics"]',
    )!;
    await React.act(async () => refresh.click());
    expect(state.refreshes).toBe(1);
  },
);
