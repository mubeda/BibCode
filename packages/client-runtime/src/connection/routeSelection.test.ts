import { DurableEnvironmentId, type ExecutionEnvironmentDescriptor } from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { type KnownEnvironment, KnownEnvironment as KnownEnvironmentSchema } from "./catalog.ts";
import {
  DesktopLoopbackRoute,
  DirectHttpsRoute,
  SshTunnelRoute,
  type EnvironmentRoute,
} from "./model.ts";
import { eligibleRoutes, selectRoute } from "./routeSelection.ts";

const ENVIRONMENT_ID = DurableEnvironmentId.make("018f1f52-0d78-7d73-8dc8-7bd50db6f001");
const STORAGE_ID = "018f1f52-0d78-7d73-8dc8-7bd50db6f101";

const DESCRIPTOR = {
  environmentId: ENVIRONMENT_ID,
  label: "Build environment",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  storageInstanceId: STORAGE_ID,
  protocol: { minimum: 1, maximum: 1 },
  capabilities: {
    repositoryIdentity: true,
    worktreeCatalog: true,
    worktreeCatalogRefreshReason: true,
    vcsStatusSummary: true,
    activityProtocolVersion: 2,
  },
} satisfies ExecutionEnvironmentDescriptor;

const local = new DesktopLoopbackRoute({
  routeId: "local",
  environmentId: ENVIRONMENT_ID,
  label: "Local",
  priority: 20,
  pinned: false,
  autoconnect: true,
  secretRef: null,
  httpBaseUrl: "http://127.0.0.1:48271",
  wsBaseUrl: "ws://127.0.0.1:48271",
});
const https = new DirectHttpsRoute({
  routeId: "https",
  environmentId: ENVIRONMENT_ID,
  label: "HTTPS",
  priority: 10,
  pinned: false,
  autoconnect: true,
  secretRef: null,
  httpsBaseUrl: "https://build.example.test",
  trust: { _tag: "System" },
});
const ssh = new SshTunnelRoute({
  routeId: "ssh",
  environmentId: ENVIRONMENT_ID,
  label: "SSH",
  priority: 30,
  pinned: false,
  autoconnect: true,
  secretRef: null,
  target: {
    alias: "build",
    hostname: "build.example.test",
    username: "builder",
    port: 22,
  },
  hostKeyFingerprint: null,
});

const decodeEnvironment = Schema.decodeUnknownSync(KnownEnvironmentSchema);

function environment(
  routes: ReadonlyArray<EnvironmentRoute>,
  options?: { readonly pinnedRouteId?: string; readonly disabledRouteIds?: ReadonlySet<string> },
): KnownEnvironment {
  return decodeEnvironment({
    environmentId: ENVIRONMENT_ID,
    acceptedStorageInstanceId: STORAGE_ID,
    descriptor: DESCRIPTOR,
    alias: "Build",
    hidden: false,
    bindings: [],
    routes: routes.map((route) => ({
      ...route,
      pinned: route.routeId === options?.pinnedRouteId,
      autoconnect: !options?.disabledRouteIds?.has(route.routeId),
    })),
  });
}

describe("environment route selection", () => {
  it("puts the eligible pinned route before a healthy active route", () => {
    const selected = eligibleRoutes(environment([local, https, ssh], { pinnedRouteId: "ssh" }), {
      activeRouteId: "https",
    });

    expect(selected.map((route) => route.routeId)).toEqual(["ssh", "https", "local"]);
    expect(
      selectRoute(environment([local, https, ssh], { pinnedRouteId: "ssh" }), {
        activeRouteId: "https",
      })?.routeId,
    ).toBe("ssh");
  });

  it("keeps the active route sticky when no eligible route is pinned", () => {
    expect(
      eligibleRoutes(environment([local, https, ssh]), { activeRouteId: "local" }).map(
        (route) => route.routeId,
      ),
    ).toEqual(["local", "https", "ssh"]);
  });

  it("orders inactive routes by priority and then stable route id", () => {
    const later = new DirectHttpsRoute({ ...https, routeId: "z-route", priority: 10 });
    const earlier = new DirectHttpsRoute({ ...https, routeId: "a-route", priority: 10 });

    expect(
      eligibleRoutes(environment([later, ssh, earlier]), { activeRouteId: null }).map(
        (route) => route.routeId,
      ),
    ).toEqual(["a-route", "z-route", "ssh"]);
  });

  it("excludes manual-only and route-blocked candidates unless manually pinned", () => {
    const catalog = environment([local, https, ssh], {
      pinnedRouteId: "ssh",
      disabledRouteIds: new Set(["local", "ssh"]),
    });

    expect(
      eligibleRoutes(catalog, {
        activeRouteId: "local",
        blockedRouteIds: new Set(["https"]),
      }).map((route) => route.routeId),
    ).toEqual(["ssh"]);
  });

  it("does not mutate catalog route order", () => {
    const catalog = environment([ssh, local, https]);
    const before = catalog.routes.map((route) => route.routeId);

    eligibleRoutes(catalog, { activeRouteId: "https" });

    expect(catalog.routes.map((route) => route.routeId)).toEqual(before);
  });
});
