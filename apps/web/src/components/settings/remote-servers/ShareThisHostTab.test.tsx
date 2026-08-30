import { act, type ReactNode } from "react";
import type {
  AdvertisedEndpoint,
  DesktopServerExposureMode,
  DesktopServerExposureState,
} from "@bibcode/contracts";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import * as DateTime from "effect/DateTime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type AnyProps = Record<string, unknown>;

const h = vi.hoisted(() => ({
  radioGroupProps: null as AnyProps | null,
  cancelOffer: vi.fn(),
  createOffer: vi.fn(),
  getShareState: vi.fn(),
  refreshNetwork: vi.fn(),
  networkQuery: {
    data: {
      serverExposureState: {
        configuredMode: "local-only" as "local-only" | "network-accessible",
        management: "native" as "native" | "external",
        mode: "local-only" as "local-only" | "network-accessible",
        endpointUrl: null as string | null,
        advertisedHost: null as string | null,
        tailscaleServeEnabled: false,
        tailscaleServePort: 443,
      },
      advertisedEndpoints: [] as AdvertisedEndpoint[],
    },
    error: null,
    isPending: false,
  },
  wslQuery: { data: { wslOnly: false }, error: null, isPending: false },
  sessionState: {
    data: { authenticated: true, auth: { policy: "remote-reachable" as const } },
  },
}));

vi.mock("~/environments/primary", () => ({
  cancelServerPairingOffer: h.cancelOffer,
  createServerPairingOffer: h.createOffer,
  getServerShareState: h.getShareState,
  PRIMARY_PAIRING_OFFER_REQUEST_TIMEOUT_MS: 50,
  usePrimarySessionState: () => h.sessionState,
}));

vi.mock("~/state/desktopNetworkAccess", () => ({
  desktopNetworkAccessStateAtom: Symbol.for("desktop-network-access"),
  refreshDesktopNetworkAccessState: h.refreshNetwork,
}));

vi.mock("~/state/desktopWslState", () => ({
  desktopWslStateAtom: Symbol.for("desktop-wsl-state"),
}));

vi.mock("~/state/environments", () => ({
  usePrimaryEnvironment: () => ({
    serverConfig: { environment: { label: "AI-SERVER" } },
  }),
  usePrimaryEnvironmentId: () => "primary",
  useEnvironmentHttpBaseUrl: () => "http://127.0.0.1:3773",
}));

vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) =>
    atom === null
      ? { data: null }
      : atom === Symbol.for("desktop-wsl-state")
        ? h.wslQuery
        : h.networkQuery,
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

import { canResumeLegacyExposure, ShareThisHostTab } from "./ShareThisHostTab";

let domWindow: Window;
let container: HTMLDivElement;
let root: Root;

const localState = {
  configuredMode: "local-only" as const,
  management: "native" as const,
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

function installBridge(
  applyServerExposure = vi.fn<
    (desired: DesktopServerExposureMode) => Promise<DesktopServerExposureState>
  >(async () => wideState),
  getServerExposureState = vi.fn<() => Promise<DesktopServerExposureState>>(async () => wideState),
) {
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { applyServerExposure, getServerExposureState },
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
  h.networkQuery.data.advertisedEndpoints = [];
  h.wslQuery.data.wslOnly = false;
  h.cancelOffer.mockReset().mockResolvedValue(undefined);
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
  vi.useRealTimers();
  domWindow.close();
  vi.unstubAllGlobals();
});

describe("ShareThisHostTab", () => {
  it("offers legacy resume only for an explicitly configured prior wide native host", () => {
    const shareState = {
      desiredExposure: "loopback" as const,
      offHostGrantCount: 0,
      legacyGrantCount: 1,
    };
    expect(
      canResumeLegacyExposure(shareState, {
        ...localState,
        configuredMode: "network-accessible",
      }),
    ).toBe(true);
    expect(canResumeLegacyExposure({ ...shareState, legacyGrantCount: 0 }, localState)).toBe(false);
    expect(
      canResumeLegacyExposure(
        { ...shareState, desiredExposure: "wide", offHostGrantCount: 1 },
        { ...localState, configuredMode: "network-accessible" },
      ),
    ).toBe(false);
    expect(
      canResumeLegacyExposure(shareState, {
        ...localState,
        configuredMode: "network-accessible",
        management: "external",
      }),
    ).toBe(false);
  });

  it("requires an explicit action to resume legacy remote access", async () => {
    Object.assign(h.networkQuery.data.serverExposureState, {
      ...localState,
      configuredMode: "network-accessible",
    });
    h.getShareState.mockResolvedValue({
      desiredExposure: "loopback",
      offHostGrantCount: 0,
      legacyGrantCount: 1,
    });
    const apply = installBridge();

    await renderTab();

    expect(container.textContent).toContain("Resume legacy remote access");
    expect(apply).not.toHaveBeenCalled();
    await click("Resume legacy remote access");
    expect(apply).toHaveBeenCalledWith("network-accessible");
  });

  it("keeps waiting when legacy exposure resume exceeds the HTTP deadline", async () => {
    Object.assign(h.networkQuery.data.serverExposureState, {
      ...localState,
      configuredMode: "network-accessible",
    });
    h.getShareState.mockResolvedValue({
      desiredExposure: "loopback",
      offHostGrantCount: 0,
      legacyGrantCount: 1,
    });
    let finishApply: ((state: DesktopServerExposureState) => void) | undefined;
    installBridge(
      vi.fn(
        () =>
          new Promise<DesktopServerExposureState>((resolve) => {
            finishApply = resolve;
          }),
      ),
    );

    await renderTab();
    await click("Resume legacy remote access");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });

    expect(container.textContent).not.toContain("Server exposure update timed out");
    expect(container.textContent).toContain("Resuming…");
    await act(async () => finishApply?.(wideState));
    expect(container.textContent).not.toContain("Resuming…");
  });

  it("renders every intent and the threat-model copy", async () => {
    installBridge();
    await renderTab();
    expect(container.textContent).toContain("Another device");
    expect(container.textContent).toContain("This computer only");
    expect(container.textContent).toContain("Custom address");
    expect(container.textContent).toContain("Pairing grants your user account on this machine");
  });

  it("fails closed when native exposure discovers only a public address", async () => {
    h.networkQuery.data.advertisedEndpoints = [
      {
        id: "desktop-network:8.8.8.8:3773",
        label: "Public address",
        provider: { id: "desktop-core", label: "Desktop", kind: "core", isAddon: false },
        httpBaseUrl: "http://8.8.8.8:3773/",
        wsBaseUrl: "ws://8.8.8.8:3773/",
        reachability: "public",
        compatibility: { hostedHttpsApp: "mixed-content-blocked", desktopApp: "compatible" },
        source: "desktop-core",
        status: "available",
        isDefault: false,
        description:
          "Public address. Select explicitly only after reviewing exposure. BiBCode does not manage this platform's firewall.",
      },
    ];
    installBridge();

    await renderTab();
    const generate = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Generate pairing offer",
    );
    expect(generate?.disabled).toBe(true);
    expect(container.textContent).toContain("Native sharing needs a private network address");
    expect(container.textContent).toContain("externally managed server or reverse proxy");
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

  it("reports completed local-only restoration when minting fails after widening", async () => {
    const apply = installBridge(
      vi.fn(async (desired: "local-only" | "network-accessible") =>
        desired === "local-only" ? localState : wideState,
      ),
    );
    h.createOffer.mockRejectedValue(
      Object.assign(new Error("mint failed"), {
        cause: { _tag: "EnvironmentRequestInvalidError" },
      }),
    );

    await renderTab();
    await click("Generate pairing offer");

    expect(apply.mock.calls).toEqual([["network-accessible"], ["local-only"]]);
    expect(container.textContent).toContain(
      "The offer was not created. Remote access is confirmed local-only.",
    );
    expect(container.textContent).not.toContain("will switch off again automatically");
  });

  it("reports when minting and the direct exposure cleanup both fail", async () => {
    installBridge(
      vi.fn(async (desired: "local-only" | "network-accessible") => {
        if (desired === "local-only") throw new Error("firewall cleanup failed");
        return wideState;
      }),
    );
    h.createOffer.mockRejectedValue(
      Object.assign(new Error("mint failed"), {
        cause: { _tag: "EnvironmentRequestInvalidError" },
      }),
    );

    await renderTab();
    await click("Generate pairing offer");

    expect(container.textContent).toContain(
      "The offer was canceled, but remote-access cleanup could not be verified. Review Exposure and retry cleanup.",
    );
    expect(container.textContent).not.toContain("will switch off again automatically");
  });

  it("explains when another live access reason keeps the host wide", async () => {
    const apply = installBridge();
    h.createOffer.mockRejectedValue(
      Object.assign(new Error("mint failed"), {
        cause: { _tag: "EnvironmentRequestInvalidError" },
      }),
    );
    h.getShareState.mockResolvedValue({
      desiredExposure: "wide",
      offHostGrantCount: 1,
      legacyGrantCount: 0,
    });

    await renderTab();
    await click("Generate pairing offer");

    expect(apply).toHaveBeenCalledExactlyOnceWith("network-accessible");
    expect(container.textContent).toContain(
      "The offer was not created. Remote access remains enabled because another live access reason still requires it.",
    );
  });

  it("keeps exposure wide when cancellation is unconfirmed and authoritative state is wide", async () => {
    vi.useFakeTimers();
    const apply = installBridge();
    h.createOffer.mockRejectedValue(
      Object.assign(new Error("response lost"), {
        cause: { _tag: "EnvironmentRequestInvalidError" },
      }),
    );
    h.cancelOffer.mockRejectedValue(new Error("server unreachable"));
    h.getShareState.mockResolvedValue({
      desiredExposure: "wide",
      offHostGrantCount: 1,
      legacyGrantCount: 0,
    });

    await renderTab();
    await click("Generate pairing offer");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_100);
    });

    expect(apply).toHaveBeenCalledExactlyOnceWith("network-accessible");
    expect(container.textContent).toContain(
      "The offer result could not be canceled or confirmed. Remote access was deliberately left unchanged because a live credential may exist.",
    );
  });

  it("does not narrow after failed cancellation even when a read reports loopback", async () => {
    vi.useFakeTimers();
    const apply = installBridge(
      vi.fn(async (desired: "local-only" | "network-accessible") =>
        desired === "local-only" ? localState : wideState,
      ),
    );
    h.createOffer.mockRejectedValue(
      Object.assign(new Error("response lost"), {
        cause: { _tag: "EnvironmentRequestInvalidError" },
      }),
    );
    h.cancelOffer.mockRejectedValue(new Error("server unreachable"));

    await renderTab();
    await click("Generate pairing offer");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_100);
    });

    expect(h.cancelOffer).toHaveBeenCalledTimes(3);
    expect(apply.mock.calls).toEqual([["network-accessible"]]);
    expect(container.textContent).toContain(
      "The offer result could not be canceled or confirmed. Remote access was deliberately left unchanged because a live credential may exist.",
    );
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

  it("mints against the WSL endpoint without invoking native exposure", async () => {
    h.wslQuery.data.wslOnly = true;
    h.networkQuery.data.advertisedEndpoints = [
      {
        id: "wsl-primary",
        label: "WSL",
        provider: { id: "wsl", label: "WSL", kind: "private-network", isAddon: false },
        httpBaseUrl: "http://172.20.10.2:3773/",
        wsBaseUrl: "ws://172.20.10.2:3773/",
        reachability: "private-network",
        compatibility: { hostedHttpsApp: "compatible", desktopApp: "compatible" },
        source: "desktop-core",
        status: "available",
      },
    ];
    const apply = installBridge();
    await renderTab();
    await click("Generate pairing offer");

    expect(apply).not.toHaveBeenCalled();
    expect(h.createOffer).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: "http://172.20.10.2:3773/" }),
      expect.any(String),
    );
    expect(container.textContent).toContain("Reachable at http://172.20.10.2:3773/");
    expect(container.textContent).toContain("WSL/Hyper-V firewall policy");
    expect(container.textContent).not.toContain("Limited to this machine");
    expect(container.textContent).not.toContain("Managed automatically");

    await selectIntent("this-computer");
    await click("Generate pairing offer");
    const exposureSection = [...container.querySelectorAll("section")].find(
      (section) => section.querySelector("h2")?.textContent === "Exposure",
    );
    expect(exposureSection?.textContent).toContain("Reachable at http://172.20.10.2:3773/");
    expect(exposureSection?.textContent).not.toContain("http://127.0.0.1:3773");
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
