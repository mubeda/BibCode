import {
  DiagnosticLogsRelaySendError,
  type DownloadedDiagnosticLogs,
  diagnosticLogsError,
} from "@bibcode/client-runtime/diagnostics";
import {
  DIAGNOSTIC_LOGS_CHUNK_BYTES,
  type DiagnosticLogsManifest,
  type DiagnosticLogsRelayItem,
} from "@bibcode/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  DiagnosticLogsRelayController,
  type DiagnosticLogsRelayDependencies,
  useDiagnosticLogsRelayPrompts,
} from "./diagnosticLogsRelay";

const MANIFEST: DiagnosticLogsManifest = {
  schemaVersion: 1,
  environmentId: "local",
  storageInstanceId: "storage-omarchy",
  environmentLabel: "omarchy",
  serverVersion: "0.12.0",
  platform: { os: "linux", arch: "x86_64" },
  generatedAt: "2026-10-27T12:00:00Z",
  crashDumps: { requested: false, included: 0 },
};

const ARCHIVE: DownloadedDiagnosticLogs = {
  fileName: "bibcode-diagnostics-omarchy.zip",
  bytes: new Uint8Array(DIAGNOSTIC_LOGS_CHUNK_BYTES + 3).fill(1),
  manifest: MANIFEST,
};

interface Harness {
  readonly controller: DiagnosticLogsRelayController;
  readonly claims: string[];
  readonly sent: DiagnosticLogsRelayItem[];
  readonly downloads: Array<{ environmentId: string; includeCrashDumps: boolean }>;
  signal: AbortSignal | null;
  finishDownload: (result: DownloadedDiagnosticLogs | Error) => void;
}

function harness(
  overrides: Partial<DiagnosticLogsRelayDependencies> & { claimed?: boolean } = {},
): Harness {
  const state = {
    claims: [] as string[],
    sent: [] as DiagnosticLogsRelayItem[],
    downloads: [] as Array<{ environmentId: string; includeCrashDumps: boolean }>,
    signal: null as AbortSignal | null,
    finishDownload: (_result: DownloadedDiagnosticLogs | Error) => {},
  };
  const controller = new DiagnosticLogsRelayController({
    candidates: () => [
      { environmentId: "primary", label: "This Mac", connected: true },
      { environmentId: "remote:omarchy", label: "Omarchy", connected: true },
    ],
    claim: async (requestId) => {
      state.claims.push(requestId);
      return overrides.claimed ?? true;
    },
    send: async (_requestId, item) => {
      state.sent.push(item);
    },
    download: (environmentId, _label, input, signal) => {
      state.downloads.push({ environmentId, includeCrashDumps: input.includeCrashDumps === true });
      state.signal = signal;
      return new Promise((resolve, reject) => {
        state.finishDownload = (result) =>
          result instanceof Error ? reject(result) : resolve(result);
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    },
    downloadInput: (includeCrashDumps) => ({ frontendLog: "", includeCrashDumps }),
    ...overrides,
  });
  return Object.assign(state, { controller });
}

const pending = (environment: string, includeCrashDumps = false) =>
  ({
    _tag: "Pending",
    request: {
      requestId: "relay_1",
      environment,
      includeCrashDumps,
      code: "K7Q-4M",
      outputDirectory: "/Users/me/logs",
    },
  }) as const;

const prompts = () => useDiagnosticLogsRelayPrompts.getState().prompts;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  useDiagnosticLogsRelayPrompts.setState({ prompts: [] });
});

describe("DiagnosticLogsRelayController", () => {
  it("asks first, then relays the named environment's checked archive in order", async () => {
    const h = harness();
    h.controller.handle(pending("omarchy", true));

    expect(prompts()).toEqual([
      {
        requestId: "relay_1",
        environmentId: "remote:omarchy",
        label: "Omarchy",
        includeCrashDumps: true,
        requested: "omarchy",
        code: "K7Q-4M",
        outputDirectory: "/Users/me/logs",
      },
    ]);
    expect(h.claims).toEqual([]);
    expect(h.downloads).toEqual([]);

    const approved = h.controller.approve(prompts()[0]!);
    await settle();
    expect(prompts()).toEqual([]);
    expect(h.claims).toEqual(["relay_1"]);
    expect(h.downloads).toEqual([{ environmentId: "remote:omarchy", includeCrashDumps: true }]);
    h.finishDownload(ARCHIVE);
    await approved;
    expect(h.sent.map((item) => item._tag)).toEqual(["Started", "Data", "Data", "Finished"]);
  });

  it("denies without downloading anything", async () => {
    const h = harness();
    h.controller.handle(pending("Omarchy"));
    await h.controller.deny(prompts()[0]!);
    expect(h.claims).toEqual(["relay_1"]);
    expect(h.sent).toEqual([{ _tag: "Denied" }]);
    expect(h.downloads).toEqual([]);
  });

  it("answers an unknown name without listing what it can reach, asking nothing", async () => {
    const h = harness();
    h.controller.handle(pending("Mars"));
    await settle();
    expect(prompts()).toEqual([]);
    expect(h.sent).toEqual([
      {
        _tag: "Failed",
        reason: "unknown-environment",
        message: "BiBCode has no environment named Mars.",
      },
    ]);
    expect(h.downloads).toEqual([]);
  });

  it("never downloads a request that closed while its claim was in flight", async () => {
    let finishClaim: (claimed: boolean) => void = () => {};
    const h = harness({
      claim: () =>
        new Promise<boolean>((resolve) => {
          finishClaim = resolve;
        }),
    });
    h.controller.handle(pending("Omarchy"));
    const approved = h.controller.approve(prompts()[0]!);
    await settle();
    // The command exits while the claim is on its way.
    h.controller.handle({ _tag: "Closed", requestId: "relay_1" });
    finishClaim(true);
    await approved;
    expect(h.downloads).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it("drops its prompt once another window claims the request", () => {
    const h = harness();
    h.controller.handle(pending("Omarchy"));
    h.controller.handle({ _tag: "Claimed", requestId: "relay_1" });
    expect(prompts()).toEqual([]);
    expect(h.downloads).toEqual([]);
  });

  it("stops the download and sends nothing once the request closes", async () => {
    const h = harness();
    h.controller.handle(pending("Omarchy"));
    const approved = h.controller.approve(prompts()[0]!);
    await settle();
    h.controller.handle({ _tag: "Closed", requestId: "relay_1" });
    await approved;
    expect(h.signal?.aborted).toBe(true);
    expect(h.sent).toEqual([]);
  });

  it("closes a prompt the request no longer needs", () => {
    const h = harness();
    h.controller.handle(pending("Omarchy"));
    h.controller.handle({ _tag: "Closed", requestId: "relay_1" });
    expect(prompts()).toEqual([]);
  });

  it("relays a failed download with its own reason and copy", async () => {
    const h = harness();
    h.controller.handle(pending("Omarchy"));
    const approved = h.controller.approve(prompts()[0]!);
    await settle();
    h.finishDownload(diagnosticLogsError("wrong-environment", "Omarchy"));
    await approved;
    expect(h.sent).toEqual([
      {
        _tag: "Failed",
        reason: "wrong-environment",
        message: "The logs that arrived are not from Omarchy. Nothing was saved. Try again.",
      },
    ]);
  });

  it("stops sending once the primary says the command left", async () => {
    const sent: DiagnosticLogsRelayItem[] = [];
    const h = harness({
      send: async (_requestId, item) => {
        sent.push(item);
        if (item._tag === "Data") throw new DiagnosticLogsRelaySendError({ reason: "cancelled" });
      },
    });
    h.controller.handle(pending("Omarchy"));
    const approved = h.controller.approve(prompts()[0]!);
    await settle();
    h.finishDownload(ARCHIVE);
    await approved;
    expect(sent.map((item) => item._tag)).toEqual(["Started", "Data"]);
  });

  it("downloads nothing when another window took the request", async () => {
    const h = harness({ claimed: false });
    h.controller.handle(pending("Omarchy"));
    await h.controller.approve(prompts()[0]!);
    expect(h.downloads).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it("asks once for a request a resubscription replays", () => {
    const h = harness();
    h.controller.handle(pending("Omarchy"));
    h.controller.handle(pending("Omarchy"));
    expect(prompts()).toHaveLength(1);
  });

  it("clears its prompts and stops its downloads when the subscription ends", async () => {
    const h = harness();
    h.controller.handle(pending("Omarchy"));
    h.controller.dispose();
    expect(prompts()).toEqual([]);
    h.controller.handle({
      _tag: "Pending",
      request: { ...pending("Omarchy").request, requestId: "relay_2" },
    });
    expect(prompts()).toEqual([]);
    expect(h.claims).toEqual([]);
  });
});
