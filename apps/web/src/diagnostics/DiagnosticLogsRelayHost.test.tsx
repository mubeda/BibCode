// @vitest-environment happy-dom

/**
 * The mounted relay host: a request announced on the primary's subscription opens the
 * prompt, and only Share starts a download, over the named environment's connection, whose
 * items go back to the primary.
 */
import type { DiagnosticLogsRelayEvent } from "@bibcode/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

interface FakeEnvironment {
  readonly environmentId: string;
  readonly label: string;
  readonly connection: { readonly phase: string };
}

const h = vi.hoisted(() => ({
  primary: null as FakeEnvironment | null,
  environments: [] as FakeEnvironment[],
  onEvent: null as null | ((event: DiagnosticLogsRelayEvent) => void),
  watchedOn: [] as string[],
  calls: [] as Array<{ environmentId: string; kind: string; item?: unknown }>,
  downloads: [] as Array<{ environmentId: string; label: string }>,
}));

vi.mock("../state/environments", () => ({
  usePrimaryEnvironment: () => h.primary,
  useEnvironments: () => ({ environments: h.environments, isReady: true }),
}));

vi.mock("@bibcode/client-runtime/diagnostics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bibcode/client-runtime/diagnostics")>()),
  watchDiagnosticLogsRelay: (onEvent: (event: DiagnosticLogsRelayEvent) => void) => ({
    kind: "watch",
    onEvent,
  }),
  claimDiagnosticLogsRelay: (requestId: string) => ({ kind: "claim", requestId }),
  sendDiagnosticLogsRelayItem: (requestId: string, item: unknown) => ({
    kind: "send",
    requestId,
    item,
  }),
}));

vi.mock("./environmentDiagnosticLogs", () => ({
  runInEnvironmentAsPromise: (
    environmentId: string,
    effect: { kind: string; onEvent?: (event: DiagnosticLogsRelayEvent) => void; item?: unknown },
  ) => {
    if (effect.kind === "watch") {
      h.watchedOn.push(environmentId);
      h.onEvent = effect.onEvent!;
      return new Promise(() => {});
    }
    h.calls.push({ environmentId, kind: effect.kind, item: effect.item });
    return Promise.resolve(effect.kind === "claim" ? true : undefined);
  },
  downloadEnvironmentDiagnosticLogs: async (environmentId: string, label: string) => {
    h.downloads.push({ environmentId, label });
    return {
      fileName: "bibcode-diagnostics-omarchy.zip",
      bytes: new Uint8Array([1, 2, 3]),
      manifest: { storageInstanceId: "storage-omarchy" },
    };
  },
}));

vi.mock("./frontendLogCapture", () => ({ readFrontendLogSnapshot: () => "snapshot\n" }));

vi.mock("../components/ui/alert-dialog", () => ({
  AlertDialog: (props: {
    open: boolean;
    children: ReactNode;
    onOpenChange: (open: boolean) => void;
  }) =>
    props.open ? (
      <div role="alertdialog">
        <button type="button" aria-label="Dismiss" onClick={() => props.onOpenChange(false)} />
        {props.children}
      </div>
    ) : null,
  AlertDialogPopup: (props: { children: ReactNode }) => <div>{props.children}</div>,
  AlertDialogHeader: (props: { children: ReactNode }) => <div>{props.children}</div>,
  AlertDialogFooter: (props: { children: ReactNode }) => <div>{props.children}</div>,
  AlertDialogTitle: (props: { children: ReactNode }) => <h2>{props.children}</h2>,
  AlertDialogDescription: (props: { children: ReactNode }) => <p>{props.children}</p>,
}));

import { DiagnosticLogsRelayHost } from "./DiagnosticLogsRelayHost";
import { useDiagnosticLogsRelayPrompts } from "./diagnosticLogsRelay";

let mounted: { root: Root; container: HTMLDivElement } | null = null;

async function render() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted = { root, container };
  await act(async () => root.render(<DiagnosticLogsRelayHost />));
  return container;
}

async function announce(event: DiagnosticLogsRelayEvent) {
  await act(async () => h.onEvent!(event));
}

async function click(container: HTMLElement, text: string) {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === text || candidate.getAttribute("aria-label") === text,
  );
  if (button === undefined) throw new Error(`No ${text} button.`);
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const environment = (environmentId: string, label: string, phase = "connected") => ({
  environmentId,
  label,
  connection: { phase },
});

const pending = (includeCrashDumps = false): DiagnosticLogsRelayEvent => ({
  _tag: "Pending",
  request: { requestId: "relay_1", environment: "Omarchy", includeCrashDumps },
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.primary = environment("primary", "This Mac");
  h.environments = [h.primary, environment("remote:omarchy", "Omarchy")];
  h.onEvent = null;
  h.watchedOn.length = 0;
  h.calls.length = 0;
  h.downloads.length = 0;
  useDiagnosticLogsRelayPrompts.setState({ prompts: [] });
});

afterEach(async () => {
  if (mounted !== null) {
    const { root, container } = mounted;
    await act(async () => root.unmount());
    container.remove();
    mounted = null;
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("DiagnosticLogsRelayHost", () => {
  it("asks, then relays the named environment's logs back through the primary", async () => {
    const container = await render();
    expect(h.watchedOn).toEqual(["primary"]);
    await announce(pending(true));

    const dialog = container.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("Share Omarchy's diagnostic logs?");
    expect(dialog?.textContent).toContain("crash dumps, which can hold fragments of memory");
    expect(h.downloads).toEqual([]);

    await click(container, "Share logs and crash dumps");
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    expect(h.downloads).toEqual([{ environmentId: "remote:omarchy", label: "Omarchy" }]);
    expect(h.calls.map(({ environmentId, kind }) => `${kind}@${environmentId}`)).toEqual([
      "claim@primary",
      "send@primary",
      "send@primary",
      "send@primary",
    ]);
    expect(h.calls.map(({ item }) => (item as { _tag?: string } | undefined)?._tag)).toEqual([
      undefined,
      "Started",
      "Data",
      "Finished",
    ]);
  });

  it("denies when dismissed, downloading nothing", async () => {
    const container = await render();
    await announce(pending());
    await click(container, "Dismiss");
    expect(h.downloads).toEqual([]);
    expect(h.calls.map(({ kind, item }) => [kind, (item as { _tag?: string })?._tag])).toEqual([
      ["claim", undefined],
      ["send", "Denied"],
    ]);
  });

  it("does not listen while its own server is not connected", async () => {
    h.primary = environment("primary", "This Mac", "reconnecting");
    h.environments = [h.primary];
    await render();
    expect(h.watchedOn).toEqual([]);
  });
});
