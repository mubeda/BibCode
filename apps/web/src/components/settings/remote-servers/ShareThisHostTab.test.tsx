import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import * as DateTime from "effect/DateTime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type AnyProps = Record<string, unknown>;

const h = vi.hoisted(() => ({
  radioGroupProps: null as AnyProps | null,
  createOffer: vi.fn(),
  getShareState: vi.fn(),
  refreshNetwork: vi.fn(),
  networkQuery: {
    data: {
      serverExposureState: {
        mode: "local-only" as "local-only" | "network-accessible",
        endpointUrl: null as string | null,
        advertisedHost: null as string | null,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      },
      advertisedEndpoints: [],
    },
    error: null,
    isPending: false,
  },
  sessionState: {
    data: { authenticated: true, auth: { policy: "remote-reachable" as const } },
  },
}));

vi.mock("~/environments/primary", () => ({
  createServerPairingOffer: h.createOffer,
  getServerShareState: h.getShareState,
  usePrimarySessionState: () => h.sessionState,
}));

vi.mock("~/state/desktopNetworkAccess", () => ({
  desktopNetworkAccessStateAtom: Symbol.for("desktop-network-access"),
  refreshDesktopNetworkAccessState: h.refreshNetwork,
}));

vi.mock("~/state/environments", () => ({
  usePrimaryEnvironment: () => ({
    serverConfig: { environment: { label: "AI-SERVER" } },
  }),
  usePrimaryEnvironmentId: () => "primary",
  useEnvironmentHttpBaseUrl: () => "http://127.0.0.1:3773",
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => (atom === null ? { data: null } : h.networkQuery),
}));

vi.mock("~/connection/currentEnvironmentPresentation", () => ({
  readCurrentEnvironmentPresentationPolicy: () => ({
    surface: window.desktopBridge === undefined ? "browser" : "desktop",
    platform: "linux",
  }),
}));

vi.mock("../settingsLayout", () => ({
  SettingsSection: (props: AnyProps) => (
    <section>
      <h2>{props.title as ReactNode}</h2>
      {props.children as ReactNode}
    </section>
  ),
  SettingsRow: (props: AnyProps) => (
    <div>
      <h3>{props.title as ReactNode}</h3>
      {props.description as ReactNode}
      {props.status as ReactNode}
      {props.control as ReactNode}
    </div>
  ),
}));

vi.mock("../../ui/button", () => ({
  Button: ({ children, ...props }: AnyProps) => <button {...props}>{children as ReactNode}</button>,
}));

vi.mock("../../ui/input", () => ({
  Input: (props: AnyProps) => <input {...props} />,
}));

vi.mock("../../ui/qr-code", () => ({
  QRCodeSvg: (props: AnyProps) => (
    <svg aria-label={String(props.title)} data-value={String(props.value)} />
  ),
}));

vi.mock("../../ui/radio-group", () => ({
  RadioGroup: (props: AnyProps) => {
    h.radioGroupProps = props;
    return <div>{props.children as ReactNode}</div>;
  },
  Radio: (props: AnyProps) => <input type="radio" aria-label={String(props["aria-label"])} />,
}));

vi.mock("./ShareTab", () => ({
  ShareTab: (props: AnyProps) => (
    <div>
      Paired clients
      <button onClick={() => (props.onAccessRevoked as (() => void) | undefined)?.()}>
        Simulate revoke
      </button>
    </div>
  ),
}));

import { ShareThisHostTab } from "./ShareThisHostTab";

let domWindow: Window;
let container: HTMLDivElement;
let root: Root;

const localState = {
  mode: "local-only" as const,
  endpointUrl: null,
  advertisedHost: null,
  tailscaleServeEnabled: false,
  tailscaleServePort: 443,
};
const wideState = {
  ...localState,
  mode: "network-accessible" as const,
  endpointUrl: "http://192.168.1.20:3773",
  advertisedHost: "192.168.1.20",
};

function installBridge(applyServerExposure = vi.fn(async () => wideState)) {
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { applyServerExposure },
  });
  return applyServerExposure;
}

async function renderTab(): Promise<void> {
  await act(async () => root.render(<ShareThisHostTab />));
  await act(async () => {
    await Promise.resolve();
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find((item) =>
    item.textContent?.includes(label),
  );
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
}

async function click(label: string): Promise<void> {
  await act(async () => {
    button(label).click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function selectIntent(intent: "another-device" | "this-computer" | "custom") {
  const onValueChange = h.radioGroupProps?.onValueChange;
  if (typeof onValueChange !== "function") throw new Error("Radio group is not mounted.");
  await act(async () => {
    onValueChange(intent);
  });
}

beforeEach(() => {
  domWindow = new Window({ url: "http://127.0.0.1:3773/settings/remote-servers" });
  vi.stubGlobal("window", domWindow as unknown as Window & typeof globalThis);
  vi.stubGlobal("document", domWindow.document);
  vi.stubGlobal("navigator", domWindow.navigator);
  vi.stubGlobal("HTMLElement", domWindow.HTMLElement);
  vi.stubGlobal("Node", domWindow.Node);
  vi.stubGlobal("Event", domWindow.Event);
  vi.stubGlobal("MouseEvent", domWindow.MouseEvent);
  vi.stubGlobal("crypto", domWindow.crypto);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  Object.assign(h.networkQuery.data.serverExposureState, localState);
  h.createOffer.mockReset().mockImplementation(async (input) => ({
    id: "offer-1",
    code: "c0de",
    reach: input.reach,
    endpoint: input.endpoint,
    name: input.name,
    expiresAt: DateTime.makeUnsafe("2026-08-27T01:00:00.000Z"),
  }));
  h.getShareState.mockReset().mockResolvedValue({
    desiredExposure: "loopback",
    offHostGrantCount: 0,
    legacyGrantCount: 0,
  });
  h.refreshNetwork.mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  domWindow.close();
  vi.unstubAllGlobals();
});

describe("ShareThisHostTab", () => {
  it("renders every intent and the threat-model copy", async () => {
    installBridge();
    await renderTab();
    expect(container.textContent).toContain("Another device");
    expect(container.textContent).toContain("This computer only");
    expect(container.textContent).toContain("Custom address");
    expect(container.textContent).toContain("Pairing grants your user account on this machine");
  });

  it("widens before minting and renders code, links, and QR", async () => {
    const order: string[] = [];
    const apply = installBridge(
      vi.fn(async () => {
        order.push("widen");
        return wideState;
      }),
    );
    h.createOffer.mockImplementation(async (input) => {
      order.push("mint");
      return {
        id: "offer-1",
        code: "c0de",
        reach: input.reach,
        endpoint: input.endpoint,
        name: input.name,
        expiresAt: DateTime.makeUnsafe("2026-08-27T01:00:00.000Z"),
      };
    });
    await renderTab();
    expect(container.textContent).toContain("Running turns on this machine will stop");
    await click("Generate pairing offer");
    expect(order).toEqual(["widen", "mint"]);
    expect(apply).toHaveBeenCalledWith("network-accessible");
    expect(container.textContent).toContain("bibcode://pair?code=c0de");
    expect(container.textContent).toContain("for networks you trust");
    expect(
      container.querySelector('svg[aria-label="Pairing code — scan with a BiBCode client"]'),
    ).not.toBeNull();
  });

  it("reports widening failure without minting", async () => {
    installBridge(vi.fn(async () => Promise.reject(new Error("bind failed"))));
    await renderTab();
    await click("Generate pairing offer");
    expect(h.createOffer).not.toHaveBeenCalled();
    expect(container.textContent).toContain("bind failed");
  });

  it("creates a loopback offer without touching exposure", async () => {
    const apply = installBridge();
    await renderTab();
    await selectIntent("this-computer");
    await click("Generate pairing offer");
    expect(apply).not.toHaveBeenCalled();
    expect(h.createOffer).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "http://127.0.0.1:3773", reach: "this-computer" }),
      expect.any(String),
    );
    expect(container.textContent).toContain("Loopback offer: reachable only through a tunnel");
  });

  it("keeps browser exposure read-only while server-side minting remains available", async () => {
    await renderTab();
    expect(container.textContent).toContain("restart `bibcode serve` with `--host`");
    await click("Generate pairing offer");
    expect(h.createOffer).toHaveBeenCalledOnce();
  });

  it("refreshes share state after client revocation", async () => {
    installBridge();
    await renderTab();
    const callsBefore = h.getShareState.mock.calls.length;
    await click("Simulate revoke");
    expect(h.getShareState.mock.calls.length).toBe(callsBefore + 1);
  });
});
