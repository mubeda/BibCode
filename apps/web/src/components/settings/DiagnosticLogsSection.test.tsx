// @vitest-environment happy-dom

import { diagnosticLogsError } from "@bibcode/client-runtime/diagnostics";
import { EnvironmentId } from "@bibcode/contracts";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type AnyProps = Record<string, unknown>;

interface FakeEnvironment {
  readonly environmentId: string;
  readonly label: string;
  readonly connection: { readonly phase: string };
  readonly serverConfig: {
    readonly environment: { readonly capabilities: { readonly diagnosticLogs: boolean } };
  } | null;
}

const h = vi.hoisted(() => ({
  primary: null as FakeEnvironment | null,
  environments: [] as FakeEnvironment[],
  catalogReady: true,
  selections: [] as Array<string | null>,
  selectProps: null as null | { onValueChange: (value: string) => void },
  downloadCalls: [] as Array<{ frontendLog: string; options: unknown }>,
  downloadError: null as unknown,
  toasts: [] as unknown[],
}));

vi.mock("../../state/environments", () => ({
  usePrimaryEnvironment: () => h.primary,
  useEnvironments: () => ({ environments: h.environments, isReady: h.catalogReady }),
}));

vi.mock("../../diagnostics/frontendLogCapture", () => ({
  readFrontendLogSnapshot: () => "frontend snapshot\n",
}));

vi.mock("../../diagnostics/downloadDiagnosticLogs", () => ({
  downloadDiagnosticLogs: async (frontendLog: string, options: unknown) => {
    h.downloadCalls.push({ frontendLog, options });
    if (h.downloadError !== null) throw h.downloadError;
    return { status: "saved", filename: "bundle.zip", path: "/Downloads/bundle.zip" };
  },
}));

vi.mock("../ui/toast", () => ({
  toastManager: { add: (toast: unknown) => h.toasts.push(toast) },
}));

vi.mock("./settingsLayout", () => ({
  SettingsSection: (props: AnyProps) => (
    <section aria-label={props.title as string}>{props.children as ReactNode}</section>
  ),
  SettingsRow: (props: AnyProps) => (
    <div data-settings-row>
      <h3>{props.title as ReactNode}</h3>
      <p data-description>{props.description as ReactNode}</p>
      <div data-status>{props.status as ReactNode}</div>
      {props.control as ReactNode}
    </div>
  ),
}));

vi.mock("../ui/select", () => ({
  Select: (props: AnyProps) => {
    h.selectProps = props as unknown as { onValueChange: (value: string) => void };
    return <div data-select>{props.children as ReactNode}</div>;
  },
  SelectTrigger: (props: AnyProps) => (
    <button type="button" aria-label={props["aria-label"] as string}>
      {props.children as ReactNode}
    </button>
  ),
  SelectValue: (props: AnyProps) => <span>{props.children as ReactNode}</span>,
  SelectPopup: (props: AnyProps) => <div>{props.children as ReactNode}</div>,
  SelectItem: (props: AnyProps) => (
    <div data-item={props.value as string} data-disabled={Boolean(props.disabled)}>
      {props.children as ReactNode}
    </div>
  ),
}));

vi.mock("../ui/button", () => ({
  Button: (props: AnyProps) => (
    <button
      type="button"
      aria-label={props["aria-label"] as string | undefined}
      aria-describedby={props["aria-describedby"] as string | undefined}
      disabled={Boolean(props.disabled)}
      onClick={props.onClick as () => void}
    >
      {props.children as ReactNode}
    </button>
  ),
}));

import { DiagnosticLogsSection } from "./DiagnosticLogsSection";

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

function fakeEnvironment(
  label: string,
  { phase = "connected", diagnosticLogs = true } = {},
): FakeEnvironment {
  return {
    environmentId: `environment-${label}`,
    label,
    connection: { phase },
    serverConfig: { environment: { capabilities: { diagnosticLogs } } },
  };
}

/** Keeps the selection the way the route does: in the caller, with every change reported. */
function Harness({ initial }: { readonly initial: string | null }) {
  "use no memo";
  const [selected, setSelected] = useState(initial);
  return (
    <DiagnosticLogsSection
      selectedEnvironmentId={selected === null ? null : EnvironmentId.make(selected)}
      onSelectEnvironment={(environmentId) => {
        h.selections.push(environmentId);
        setSelected(environmentId);
      }}
    />
  );
}

async function render(initial: string | null = null): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(<Harness initial={initial} />);
  });
  return container;
}

const downloadButton = (container: HTMLElement) =>
  container.querySelector('button[aria-label="Download diagnostic logs"]') as HTMLButtonElement;

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}

const descriptionOf = (container: HTMLElement) =>
  container.querySelector("[data-description]")?.textContent ?? "";
const statusOf = (container: HTMLElement) =>
  container.querySelector("[data-status]")?.textContent ?? "";

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.primary = fakeEnvironment("Work Server", { diagnosticLogs: false });
  h.environments = [h.primary];
  h.catalogReady = true;
  h.selections.length = 0;
  h.selectProps = null;
  h.downloadCalls.length = 0;
  h.downloadError = null;
  h.toasts.length = 0;
});

afterEach(async () => {
  for (const entry of mounted.splice(0)) {
    await act(async () => entry.root.unmount());
    entry.container.remove();
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("DiagnosticLogsSection", () => {
  it("downloads the primary environment's logs as before", async () => {
    const container = await render();

    expect(descriptionOf(container)).toContain("(without crash dumps) from Work Server.");
    expect(container.querySelector("[data-select]")).toBeNull();
    await click(downloadButton(container));

    expect(h.downloadCalls).toEqual([{ frontendLog: "frontend snapshot\n", options: undefined }]);
    expect(h.toasts).toEqual([
      expect.objectContaining({ type: "success", title: "Diagnostic logs saved" }),
    ]);
  });

  it("defaults to the primary even when a remote environment is connected", async () => {
    h.environments = [h.primary!, fakeEnvironment("Omarchy")];
    const container = await render();

    expect(descriptionOf(container)).toContain("from Work Server.");
    await click(downloadButton(container));
    expect(h.downloadCalls[0]?.options).toBeUndefined();
  });

  it("downloads the selected remote environment's logs over its connection", async () => {
    const omarchy = fakeEnvironment("Omarchy");
    h.environments = [h.primary!, omarchy];
    const container = await render(omarchy.environmentId);

    expect(descriptionOf(container)).toContain("from Omarchy.");
    await click(downloadButton(container));

    expect(h.downloadCalls).toEqual([
      {
        frontendLog: "frontend snapshot\n",
        options: { environment: { environmentId: omarchy.environmentId, label: "Omarchy" } },
      },
    ]);
    expect(h.toasts).toEqual([
      expect.objectContaining({
        type: "success",
        title: "Diagnostic logs from Omarchy saved",
        description: "/Downloads/bundle.zip",
      }),
    ]);
  });

  it("has no picker of its own: the Profiler section's picker sets the page's environment", async () => {
    h.environments = [h.primary!, fakeEnvironment("Omarchy")];
    const container = await render();

    expect(container.querySelector("[data-select]")).toBeNull();
    expect(container.querySelector('button[aria-label="Environment"]')).toBeNull();
  });

  it("targets a disconnected primary, never a connected remote, when none is chosen", async () => {
    h.primary = fakeEnvironment("Work Server", { phase: "disconnected", diagnosticLogs: false });
    h.environments = [h.primary, fakeEnvironment("Omarchy")];
    const container = await render();

    expect(descriptionOf(container)).toContain("from Work Server.");
    expect(downloadButton(container).disabled).toBe(true);
    expect(statusOf(container)).toBe(
      "Work Server is not connected. Reconnect it to download its logs.",
    );
    await click(downloadButton(container));
    expect(h.downloadCalls).toEqual([]);
  });

  it("explains, and refuses, a server too old to send its logs", async () => {
    const old = fakeEnvironment("Omarchy", { diagnosticLogs: false });
    h.environments = [h.primary!, old];
    const container = await render(old.environmentId);

    const button = downloadButton(container);
    expect(button.disabled).toBe(true);
    expect(statusOf(container)).toBe(
      "Omarchy runs an older BiBCode server that cannot send its logs. Update it to download them here.",
    );
    expect(document.getElementById(button.getAttribute("aria-describedby")!)).not.toBeNull();
    await click(button);
    expect(h.downloadCalls).toEqual([]);
  });

  it.each(["connecting", "reconnecting", "available"])(
    "waits, without asking to reconnect, while the chosen one is %s",
    async (phase) => {
      const connecting = fakeEnvironment("Omarchy", { phase });
      h.environments = [h.primary!, connecting];
      const container = await render(connecting.environmentId);

      expect(downloadButton(container).disabled).toBe(true);
      expect(statusOf(container)).toBe(
        "Omarchy is still connecting. Download its logs once it is connected.",
      );
      await click(downloadButton(container));
      expect(h.downloadCalls).toEqual([]);
    },
  );

  it("never downloads another environment while the chosen one is not connected", async () => {
    // Still listed while the catalog loads, so the page keeps the choice.
    h.catalogReady = false;
    const disconnected = fakeEnvironment("Omarchy", { phase: "disconnected" });
    h.environments = [h.primary!, disconnected];
    const container = await render(disconnected.environmentId);

    expect(downloadButton(container).disabled).toBe(true);
    expect(statusOf(container)).toBe(
      "Omarchy is not connected. Reconnect it to download its logs.",
    );
    expect(descriptionOf(container)).toContain("from Omarchy.");
    await click(downloadButton(container));
    expect(h.downloadCalls).toEqual([]);
  });

  it("keeps a disconnected remote chosen, disabled, until it reconnects", async () => {
    // A link from a remote thread whose environment is offline, with the catalog loaded.
    const offline = fakeEnvironment("Omarchy", { phase: "disconnected" });
    h.environments = [h.primary!, offline];
    const container = await render(offline.environmentId);

    expect(h.selections).toEqual([]);
    expect(downloadButton(container).disabled).toBe(true);
    expect(statusOf(container)).toBe(
      "Omarchy is not connected. Reconnect it to download its logs.",
    );
    expect(descriptionOf(container)).toContain("from Omarchy.");
    await click(downloadButton(container));
    expect(h.downloadCalls).toEqual([]);

    // Reconnected: the same choice downloads that environment, never the primary.
    h.environments = [h.primary!, { ...offline, connection: { phase: "connected" } }];
    const entry = mounted.find((candidate) => candidate.container === container)!;
    await act(async () => {
      entry.root.render(<Harness initial={offline.environmentId} />);
    });
    expect(downloadButton(container).disabled).toBe(false);
    await click(downloadButton(container));
    expect(h.downloadCalls[0]?.options).toEqual({
      environment: { environmentId: offline.environmentId, label: "Omarchy" },
    });
  });

  it("never downloads the stand-in while the chosen environment is not in the catalog", async () => {
    // A reload on a link: the catalog has not listed the chosen environment yet.
    h.catalogReady = false;
    h.environments = [h.primary!];
    const container = await render("environment-Omarchy");

    expect(downloadButton(container).disabled).toBe(true);
    expect(statusOf(container)).toBe(
      "The chosen environment is not connected. Reconnect it to download its logs.",
    );
    expect(descriptionOf(container)).not.toContain("from Work Server");
    await click(downloadButton(container));
    expect(h.downloadCalls).toEqual([]);
  });

  it("names the environment when its download fails", async () => {
    const omarchy = fakeEnvironment("Omarchy");
    h.environments = [h.primary!, omarchy];
    h.downloadError = diagnosticLogsError("connection-lost", "Omarchy");
    const container = await render(omarchy.environmentId);

    await click(downloadButton(container));

    expect(h.toasts).toEqual([
      expect.objectContaining({
        type: "error",
        title: "Could not download Omarchy's logs",
        description: "The connection to Omarchy was lost. Reconnect and try again.",
      }),
    ]);
    expect(downloadButton(container).disabled).toBe(false);
  });
});
