// @vitest-environment happy-dom
// The Host dashboard over the real `serverEnvironment.hostMetrics` atom and the real query hook:
// a fake server stream counts how often it is opened and closed, so a leaked subscription fails.
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
}));

vi.mock("../ui/sheet", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Sheet: Box,
    SheetPopup: ({ children }: { children?: ReactNode }) => (
      <div data-testid="host-dashboard">{children}</div>
    ),
    SheetHeader: Box,
    SheetTitle: Box,
    SheetDescription: Box,
    SheetPanel: Box,
  };
});
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));
vi.mock("~/hooks/useSettings", () => ({ useClientSettings: () => "locale" }));
vi.mock("~/state/environments", () => ({
  useEnvironment: (environmentId: string) => ({
    environmentId,
    label: environmentId,
    connection: { phase: "connected", error: null, traceId: null },
    serverConfig: { environment: { capabilities: { hostMetrics: true } } },
  }),
}));
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
  const snapshot = (): ServerHostMetricsEvent => ({
    _tag: "Snapshot",
    host: { os: "linux", arch: "x86_64", cpuCount: 12, memoryTotalBytes: 1_000 },
    bootId: "boot-1",
    startedAt: "2026-11-11T19:00:00.000Z",
    statisticsSince: "2026-11-11T19:00:00.000Z",
    sample: {
      sampledAt: "2026-11-11T19:00:01.000Z",
      cpuPercent: 23.5,
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
  });
  const fakeStream = (environmentId: string) =>
    Stream.unwrap(
      Effect.sync(() => {
        bump(h.opened, environmentId);
        return Stream.make(snapshot()).pipe(Stream.concat(Stream.never));
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

import { hostDashboardRequest } from "~/state/hostDashboard";
import { HostDashboardCoordinator } from "./HostDashboardSheet";

const FIRST = EnvironmentId.make("example-server");
const SECOND = EnvironmentId.make("example-server-2");

let root: Root;
let container: HTMLDivElement;
let registry: AtomRegistry.AtomRegistry;

beforeEach(async () => {
  h.opened.clear();
  h.closed.clear();
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
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <HostDashboardCoordinator onOpenRemoteServers={() => undefined} />
      </RegistryContext.Provider>,
    ),
  );
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

async function open(environmentId: EnvironmentId) {
  await act(async () => registry.set(hostDashboardRequest, { environmentId }));
  await settle();
}

describe("Host dashboard stream lifetime", () => {
  it("opens one stream, shows its snapshot, and closes it when the sheet closes", async () => {
    await open(FIRST);
    expect(h.opened.get(FIRST)).toBe(1);
    expect(container.textContent).toContain("23.5%");
    await act(async () => registry.set(hostDashboardRequest, null));
    await settle();
    expect(h.closed.get(FIRST)).toBe(1);
  });

  it("closes the stream while the document is hidden and opens a new one after", async () => {
    await open(FIRST);
    h.visibility = "hidden";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await settle();
    expect(h.closed.get(FIRST)).toBe(1);
    h.visibility = "visible";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await settle();
    expect(h.opened.get(FIRST)).toBe(2);
    expect(h.closed.get(FIRST)).toBe(1);
  });

  it("closes the first environment's stream when another environment replaces it", async () => {
    await open(FIRST);
    await open(SECOND);
    expect(h.closed.get(FIRST)).toBe(1);
    expect(h.opened.get(SECOND)).toBe(1);
    expect(h.closed.get(SECOND)).toBeUndefined();
  });
});
