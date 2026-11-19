// @vitest-environment happy-dom
// The Dashboard center panel (#378) over the real `serverEnvironment.hostMetrics` atom: a fake
// server stream counts opens and closes per environment, so a leaked subscription fails.
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, type ServerHostMetricsEvent, WS_METHODS } from "@bibcode/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AtomRegistry } from "effect/reactivity";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  opened: new Map<string, number>(),
  closed: new Map<string, number>(),
  visibility: "visible" as DocumentVisibilityState,
  phase: new Map<string, string>(),
  hostMetrics: new Map<string, boolean>(),
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => h.navigate }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));
vi.mock("~/hooks/useSettings", () => ({ useClientSettings: () => "locale" }));
vi.mock("~/state/environments", () => {
  const environment = (environmentId: string) => ({
    environmentId,
    label: `Server ${environmentId}`,
    entry: { target: { _tag: "BearerConnectionTarget", connectionId: environmentId } },
    connection: { phase: h.phase.get(environmentId) ?? "connected", error: null, traceId: null },
    serverConfig: {
      environment: { capabilities: { hostMetrics: h.hostMetrics.get(environmentId) ?? true } },
    },
  });
  return {
    useEnvironment: environment,
    useEnvironments: () => ({ environments: [], isReady: true }),
  };
});
vi.mock("~/state/server", async () => {
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  const Option = await import("effect/Option");
  const Stream = await import("effect/Stream");
  const SubscriptionRef = await import("effect/SubscriptionRef");
  const { Atom } = await import("effect/reactivity");
  const { createServerEnvironmentAtoms } = await import("@bibcode/client-runtime/state/server");
  const { EnvironmentRegistry, EnvironmentSupervisor } =
    await import("@bibcode/client-runtime/connection");
  const bump = (counts: Map<string, number>, id: string) =>
    counts.set(id, (counts.get(id) ?? 0) + 1);
  const snapshot = (environmentId: string): ServerHostMetricsEvent => ({
    _tag: "Snapshot",
    host: { os: "linux", arch: "x86_64", cpuCount: 12, memoryTotalBytes: 1_000 },
    bootId: "boot-1",
    startedAt: "2026-11-11T19:00:00.000Z",
    statisticsSince: "2026-11-11T19:00:00.000Z",
    sample: {
      sampledAt: "2026-11-11T19:00:01.000Z",
      // Each server reads differently, so a reading shown under the wrong server is visible.
      cpuPercent: environmentId === "server-a" ? 23.5 : 61.5,
      memoryTotalBytes: 1_000,
      memoryUsedBytes: 250,
      memoryAvailableBytes: 750,
      volumes: [],
      volumesPaused: false,
    },
    cpu: null,
    memory: null,
    recent: [],
    uptime: [],
    hiddenVolumes: [],
    volumeStatistics: [],
  });
  const fakeStream = (environmentId: string) =>
    Stream.unwrap(
      Effect.sync(() => {
        bump(h.opened, environmentId);
        return Stream.make(snapshot(environmentId)).pipe(Stream.concat(Stream.never));
      }),
    ).pipe(Stream.ensuring(Effect.sync(() => bump(h.closed, environmentId))));
  const registry = EnvironmentRegistry.of({
    followStream: (environmentId: string, stream: unknown) =>
      Stream.unwrap(
        Effect.map(
          SubscriptionRef.make(
            Option.some({
              client: { [WS_METHODS.serverSubscribeHostMetrics]: () => fakeStream(environmentId) },
            }),
          ),
          (session) =>
            (stream as Parameters<typeof Stream.provideService>[0]).pipe(
              Stream.provideService(
                EnvironmentSupervisor,
                EnvironmentSupervisor.of({ target: { environmentId }, session } as never),
              ),
            ),
        ),
      ),
  } as never);
  return {
    serverEnvironment: createServerEnvironmentAtoms(
      Atom.runtime(Layer.succeed(EnvironmentRegistry, registry)),
      { initialConfigValueAtom: () => Atom.make(null) },
    ),
  };
});

import { HostDashboardPanel } from "./HostDashboardPanel";

const SERVER_A = EnvironmentId.make("server-a");
const SERVER_B = EnvironmentId.make("server-b");

let root: Root;
let container: HTMLDivElement;
let registry: AtomRegistry.AtomRegistry;

beforeEach(() => {
  h.opened.clear();
  h.closed.clear();
  h.phase.clear();
  h.hostMetrics.clear();
  h.navigate.mockReset();
  h.visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => h.visibility,
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  registry = AtomRegistry.make();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  registry.dispose();
});

/** Lets the atom registry run its idle disposal and the stream's finalizers. */
async function settle() {
  for (let turn = 0; turn < 5; turn += 1) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  }
}

/** Renders the panel the way its route does: keyed by the server it shows. */
async function show(environmentId: EnvironmentId | null) {
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        {environmentId === null ? null : (
          <HostDashboardPanel key={environmentId} environmentId={environmentId} />
        )}
      </RegistryContext.Provider>,
    ),
  );
  await settle();
}

describe("Dashboard center panel", () => {
  it("shows the server's live dashboard and ends its stream when the panel closes", async () => {
    await show(SERVER_A);
    const panel = container.querySelector('[data-testid="host-dashboard-panel"]');
    expect(panel?.querySelector("h1")?.textContent).toBe("Server server-a");
    expect(panel?.textContent).toContain("Dashboard");
    expect(h.opened.get(SERVER_A)).toBe(1);
    expect(container.querySelector('[data-testid="host-dashboard-cpu"]')?.textContent).toBe(
      "23.5%",
    );
    expect(container.textContent).toContain("Volumes");
    await show(null);
    expect(h.closed.get(SERVER_A)).toBe(1);
  });

  it("stops the stream while the document is hidden and subscribes again after", async () => {
    await show(SERVER_A);
    h.visibility = "hidden";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await settle();
    expect(h.closed.get(SERVER_A)).toBe(1);
    h.visibility = "visible";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await settle();
    expect(h.opened.get(SERVER_A)).toBe(2);
  });

  it("releases the first server's stream and never shows its values for another", async () => {
    await show(SERVER_A);
    await show(SERVER_B);
    expect(h.closed.get(SERVER_A)).toBe(1);
    expect(h.opened.get(SERVER_B)).toBe(1);
    expect(container.querySelector('[data-testid="host-dashboard-cpu"]')?.textContent).toBe(
      "61.5%",
    );
  });

  it("explains an unsupported server without sending a host-metrics request", async () => {
    h.hostMetrics.set(SERVER_A, false);
    await show(SERVER_A);
    expect(h.opened.get(SERVER_A)).toBeUndefined();
    const openRemoteServers = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Open Remote Servers",
    );
    expect(openRemoteServers).toBeDefined();
    await act(async () => openRemoteServers!.click());
    expect(h.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/settings/remote-servers" });
  });

  it("opens no stream on a server that is not connected", async () => {
    h.phase.set(SERVER_A, "disconnected");
    await show(SERVER_A);
    expect(h.opened.get(SERVER_A)).toBeUndefined();
  });
});
