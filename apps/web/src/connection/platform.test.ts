import {
  EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopBridge,
  type DesktopSshEnvironmentTarget,
} from "@bibcode/contracts";
import { describe, expect, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  ClientPresentation,
  EnvironmentOwnedDataCleanup,
  PlatformConnectionSource,
  PrimaryEnvironmentAuth,
  SshEnvironmentGateway,
} from "@bibcode/client-runtime/platform";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  Connectivity,
  DesktopWslBinding,
  Wakeups,
} from "@bibcode/client-runtime/connection";
import { EnvironmentRpcRequestObserver } from "@bibcode/client-runtime/rpc";

function platformDescriptor() {
  return {
    environmentId: "00000000-0000-4000-8000-000000000041",
    label: "Primary",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.0-test",
    storageInstanceId: "00000000-0000-4000-8000-000000000042",
    protocol: { minimum: 1, maximum: 1 },
    capabilities: {
      repositoryIdentity: true,
      worktreeCatalog: false,
      worktreeCatalogRefreshReason: false,
      vcsStatusSummary: false,
      activityProtocolVersion: null,
    },
  } as const;
}

function platformWslState(generation: number, distroState: "running" | "stopped" = "running") {
  const discovery = {
    generation,
    observedAt: "2026-08-25T00:00:00Z",
    health: "available" as const,
    detail: null,
    distros: [{ name: "Ubuntu", isDefault: true, state: distroState, version: 2 as const }],
  };
  return {
    enabled: distroState === "running",
    distro: null,
    legacyAcceptedDistro: null,
    available: true,
    wslOnly: false,
    distros: discovery.distros,
    discovery,
    preflightError: null,
  };
}

// ── Controllable mock state ──────────────────────────────────────────
const pf = vi.hoisted(() => ({
  isHostedStatic: false,
  desktopPrimaryBearer: null as null | (() => Promise<string | null>),
  primaryTarget: null as unknown,
  secondaryRead: { _tag: "Success", bootstraps: [] as unknown[] } as unknown,
  descriptor: platformDescriptor() as unknown,
  bearerAccess: { access_token: "secondary-token", expires_in: 3_600 } as unknown,
  descriptorCalls: [] as string[],
  bearerBootstrapCalls: [] as string[],
  clearCalls: [] as string[],
  trackCalls: [] as Array<{ requestId: string; tag: string }>,
  ackCalls: [] as string[],
  topologyListeners: [] as Array<() => void>,
  wslState: null as unknown,
  catalogEnvironments: [] as unknown[],
  catalogBindings: [] as unknown[],
  putBindings: [] as unknown[],
  removedBindings: [] as unknown[],
}));

vi.mock("../hostedPairing", () => ({
  isHostedStaticApp: () => pf.isHostedStatic,
}));

vi.mock("../rpc/requestLatencyState", () => ({
  trackRpcRequestSent: (requestId: string, tag: string) => {
    pf.trackCalls.push({ requestId, tag });
  },
  acknowledgeRpcRequest: (requestId: string) => {
    pf.ackCalls.push(requestId);
  },
}));

vi.mock("../composerDraftStore", () => ({
  clearComposerDraftsEnvironment: (environmentId: string) => {
    pf.clearCalls.push(environmentId);
  },
}));

vi.mock("../environments/primary/desktopAuth", () => ({
  readDesktopPrimaryBearerToken: () =>
    pf.desktopPrimaryBearer ? pf.desktopPrimaryBearer() : Promise.resolve(null),
}));

vi.mock("../environments/primary/httpLayer", async () => {
  const Layer = await import("effect/Layer");
  return { primaryEnvironmentHttpLayer: Layer.empty };
});

vi.mock("../environments/primary/target", () => ({
  readPrimaryEnvironmentTarget: () => {
    if (pf.primaryTarget instanceof Error) {
      throw pf.primaryTarget;
    }
    return pf.primaryTarget;
  },
}));

vi.mock("./desktopLocal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./desktopLocal")>();
  return {
    reconcileDesktopWslBindings: actual.reconcileDesktopWslBindings,
    desktopLocalConnectionId: (backendId: string) => `local:${backendId}`,
    readDesktopLocalTopologySnapshot: () => ({
      secondaryBootstraps: pf.secondaryRead,
      wslState: pf.wslState,
    }),
    observeDesktopLocalTopology: (listener: () => void) => {
      pf.topologyListeners.push(listener);
      listener();
      return () => {
        pf.topologyListeners = pf.topologyListeners.filter((current) => current !== listener);
      };
    },
  };
});

vi.mock("./storage", async () => {
  const Effect = await import("effect/Effect");
  const Layer = await import("effect/Layer");
  const Option = await import("effect/Option");
  const { EnvironmentCatalogStore } = await import("@bibcode/client-runtime/platform");
  const store = EnvironmentCatalogStore.of({
    list: Effect.sync(() => pf.catalogEnvironments as never[]),
    load: (environmentId) =>
      Effect.sync(() =>
        Option.fromUndefinedOr(
          pf.catalogEnvironments.find(
            (environment) =>
              (environment as { readonly environmentId?: unknown }).environmentId === environmentId,
          ) as never,
        ),
      ),
    put: (environment) =>
      Effect.sync(() => {
        pf.catalogEnvironments = [
          ...pf.catalogEnvironments.filter(
            (current) =>
              (current as { readonly environmentId?: unknown }).environmentId !==
              environment.environmentId,
          ),
          environment,
        ];
      }),
    updateRoutes: () => Effect.void,
    listBindings: Effect.sync(() => pf.catalogBindings as never[]),
    putBinding: (binding) =>
      Effect.sync(() => {
        pf.putBindings.push(binding);
        pf.catalogBindings = [
          ...pf.catalogBindings.filter(
            (current) =>
              (current as { readonly bindingId?: unknown }).bindingId !== binding.bindingId,
          ),
          binding,
        ];
      }),
    removeWslBindingIfUnchanged: (binding) =>
      Effect.sync(() => {
        pf.removedBindings.push(binding);
        const present = pf.catalogBindings.includes(binding);
        if (present) {
          pf.catalogBindings = pf.catalogBindings.filter((current) => current !== binding);
        }
        return present;
      }),
  });
  return {
    connectionStorageLayer: Layer.succeed(EnvironmentCatalogStore, store),
  };
});

vi.mock("@bibcode/client-runtime/environment", () => ({
  fetchRemoteEnvironmentDescriptor: (input: { httpBaseUrl: string }) => {
    pf.descriptorCalls.push(input.httpBaseUrl);
    return Effect.succeed(pf.descriptor);
  },
}));

vi.mock("@bibcode/client-runtime/authorization", () => ({
  bootstrapRemoteBearerSession: (input: { httpBaseUrl: string }) => {
    pf.bearerBootstrapCalls.push(input.httpBaseUrl);
    return Effect.succeed(pf.bearerAccess);
  },
}));

import {
  canRetainCachedPlatformRegistrationAfterRefreshFailure,
  canReuseCachedPlatformRegistration,
  connectionPlatformLayer,
  exchangeDesktopSshEnvironment,
  primaryRegistrationToRetainAfterTopologyRead,
  readPrimaryEnvironmentTargetResult,
  secondaryRegistrationsToRetainAfterTopologyRead,
  secondaryBearerExpiresAtEpochMs,
  secondaryBearerRefreshAtEpochMs,
} from "./platform.ts";

const TARGET: DesktopSshEnvironmentTarget = {
  alias: "devbox",
  hostname: "devbox.example.test",
  username: "developer",
  port: 22,
};

const SSH_DESCRIPTOR = {
  environmentId: EnvironmentId.make("environment-ssh"),
  label: "SSH environment",
  platform: { os: "linux" as const, arch: "x64" as const },
  serverVersion: "0.0.0-test",
  storageInstanceId: "00000000-0000-4000-8000-000000000052",
  protocol: { minimum: 1, maximum: 1 },
  capabilities: {
    repositoryIdentity: true,
    worktreeCatalog: false,
    worktreeCatalogRefreshReason: false,
    vcsStatusSummary: false,
    activityProtocolVersion: null,
  },
};

const SSH_BOOTSTRAP = {
  target: TARGET,
  httpBaseUrl: "http://127.0.0.1:3201/",
  wsBaseUrl: "ws://127.0.0.1:3201/",
  hostKeyFingerprint: "SHA256:known-host-key",
};

interface BridgeOptions {
  readonly failDescriptor?: boolean;
  readonly failEnsure?: unknown;
  readonly sessionSecret?: string | null;
  readonly failDpop?: boolean;
  readonly failDisconnect?: boolean;
  readonly onEnsure?: (options: {
    readonly operationId?: string;
    readonly environmentGeneration?: number;
    readonly bindingGeneration?: number;
  }) => void;
}

function makeBridge(calls: string[], options: BridgeOptions = {}): DesktopBridge {
  return {
    ensureSshEnvironment: async (
      target: DesktopSshEnvironmentTarget,
      ensureOptions: Parameters<DesktopBridge["ensureSshEnvironment"]>[1],
    ) => {
      calls.push("ensure");
      options.onEnsure?.(ensureOptions ?? {});
      if (options.failEnsure !== undefined) {
        throw options.failEnsure;
      }
      return {
        target,
        httpBaseUrl: "http://127.0.0.1:3201/",
        wsBaseUrl: "ws://127.0.0.1:3201/",
        hostKeyFingerprint: "SHA256:known-host-key",
      };
    },
    fetchSshEnvironmentDescriptor: async () => {
      calls.push("descriptor");
      if (options.failDescriptor === true) {
        throw new Error("descriptor unavailable");
      }
      return {
        environmentId: EnvironmentId.make("environment-ssh"),
        label: "SSH environment",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "0.0.0-test",
        storageInstanceId: "00000000-0000-4000-8000-000000000052",
        protocol: { minimum: 1, maximum: 1 },
        capabilities: {
          repositoryIdentity: true,
          worktreeCatalog: false,
          worktreeCatalogRefreshReason: false,
          vcsStatusSummary: false,
          activityProtocolVersion: null,
        },
      };
    },
    pairSshEnvironment: async () => {
      calls.push("pairing");
      if (options.sessionSecret === null) {
        return null as never;
      }
      calls.push("token");
      if (options.failDpop === true) {
        throw new Error("DPoP denied");
      }
      return {
        schemaVersion: 1,
        sessionSecret: options.sessionSecret ?? "protected-dpop-session",
        tokenType: "DPoP",
      };
    },
    fetchSshSessionState: async () => {
      calls.push("session");
      return { authenticated: true } as never;
    },
    issueSshWebSocketTicket: async () => {
      calls.push("ticket");
      return { ticket: "one-use-ticket" } as never;
    },
    disconnectSshEnvironment: async () => {
      calls.push("disconnect");
      if (options.failDisconnect === true) {
        throw new Error("disconnect failed");
      }
      return undefined;
    },
    cancelSshOperation: async () => {
      calls.push("cancel");
      return true;
    },
  } as unknown as DesktopBridge;
}

function stubBrowser(options: { desktopBridge?: DesktopBridge; platform?: string } = {}): void {
  vi.stubGlobal("window", options.desktopBridge ? { desktopBridge: options.desktopBridge } : {});
  vi.stubGlobal("navigator", {
    platform: options.platform ?? "Win32",
    onLine: true,
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
}

interface DomStubs {
  readonly windowListeners: (type: string) => Array<() => void>;
  readonly documentListeners: (type: string) => Array<() => void>;
  readonly fireWindow: (type: string) => void;
  readonly fireDocument: (type: string) => void;
}

function makeDomStubs(options: { desktopBridge?: DesktopBridge } = {}): DomStubs {
  const windowListeners = new Map<string, Array<() => void>>();
  const documentListeners = new Map<string, Array<() => void>>();
  const add = (map: Map<string, Array<() => void>>) => (type: string, handler: () => void) => {
    const bucket = map.get(type) ?? [];
    bucket.push(handler);
    map.set(type, bucket);
  };
  const remove = (map: Map<string, Array<() => void>>) => (type: string, handler: () => void) => {
    const bucket = map.get(type);
    if (!bucket) return;
    const index = bucket.indexOf(handler);
    if (index >= 0) bucket.splice(index, 1);
  };
  vi.stubGlobal("window", {
    desktopBridge: options.desktopBridge,
    addEventListener: add(windowListeners),
    removeEventListener: remove(windowListeners),
  });
  vi.stubGlobal("document", {
    visibilityState: "visible",
    addEventListener: add(documentListeners),
    removeEventListener: remove(documentListeners),
  });
  vi.stubGlobal("navigator", { platform: "Win32", onLine: true });
  return {
    windowListeners: (type) => windowListeners.get(type) ?? [],
    documentListeners: (type) => documentListeners.get(type) ?? [],
    fireWindow: (type) => {
      for (const handler of Array.from(windowListeners.get(type) ?? [])) handler();
    },
    fireDocument: (type) => {
      for (const handler of Array.from(documentListeners.get(type) ?? [])) handler();
    },
  };
}

function waitFor(check: () => boolean) {
  return Effect.gen(function* () {
    for (let index = 0; index < 2_000; index += 1) {
      if (check()) return;
      // Cooperative yield (clock-agnostic: it.effect runs on a frozen TestClock).
      yield* Effect.yieldNow;
    }
    throw new Error("Timed out waiting for a stubbed DOM listener to register.");
  });
}

function resetPf(): void {
  pf.isHostedStatic = false;
  pf.desktopPrimaryBearer = null;
  pf.primaryTarget = null;
  pf.secondaryRead = { _tag: "Success", bootstraps: [] };
  pf.descriptor = platformDescriptor();
  pf.bearerAccess = { access_token: "secondary-token", expires_in: 3_600 };
  pf.descriptorCalls = [];
  pf.bearerBootstrapCalls = [];
  pf.clearCalls.length = 0;
  pf.trackCalls.length = 0;
  pf.ackCalls.length = 0;
  pf.topologyListeners.length = 0;
  pf.wslState = null;
  pf.catalogEnvironments = [];
  pf.catalogBindings = [];
  pf.putBindings = [];
  pf.removedBindings = [];
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetPf();
});

// ─────────────────────────────────────────────────────────────────────
// Existing pure-function coverage (unchanged behavior)
// ─────────────────────────────────────────────────────────────────────

describe("desktop SSH pairing", () => {
  it.effect("exchanges only the identity already inspected by the caller", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const prepared = yield* exchangeDesktopSshEnvironment(makeBridge(calls), {
        bootstrap: SSH_BOOTSTRAP,
        descriptor: SSH_DESCRIPTOR,
      });
      expect(prepared.sessionSecret).toBe("protected-dpop-session");
      expect(calls).toEqual(["pairing", "token"]);
    }),
  );

  it.effect("blocks exchange when the SSH environment issues no paired session", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const error = yield* exchangeDesktopSshEnvironment(
        makeBridge(calls, { sessionSecret: null }),
        {
          bootstrap: SSH_BOOTSTRAP,
          descriptor: SSH_DESCRIPTOR,
        },
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConnectionBlockedError);
      expect(calls).toEqual(["pairing"]);
    }),
  );

  it.effect("propagates a DPoP-session failure while exchanging", () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const error = yield* exchangeDesktopSshEnvironment(makeBridge(calls, { failDpop: true }), {
        bootstrap: SSH_BOOTSTRAP,
        descriptor: SSH_DESCRIPTOR,
      }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(calls).toEqual(["pairing", "token"]);
    }),
  );
});

describe("desktop-local bearer cache", () => {
  const registration = {} as never;

  it("refreshes a secondary bearer before it expires", () => {
    const issuedAtEpochMs = 10_000;
    const refreshAtEpochMs = secondaryBearerRefreshAtEpochMs(issuedAtEpochMs, 60);
    const expiresAtEpochMs = secondaryBearerExpiresAtEpochMs(issuedAtEpochMs, 60);
    const cached = {
      expiresAtEpochMs,
      signature: "secondary-signature",
      registration,
      refreshAtEpochMs,
    };

    expect(refreshAtEpochMs).toBe(65_000);
    expect(canReuseCachedPlatformRegistration(cached, cached.signature, 64_999)).toBe(true);
    expect(canReuseCachedPlatformRegistration(cached, cached.signature, 65_000)).toBe(false);
    expect(
      canRetainCachedPlatformRegistrationAfterRefreshFailure(cached, cached.signature, 69_999),
    ).toBe(true);
    expect(
      canRetainCachedPlatformRegistrationAfterRefreshFailure(cached, cached.signature, 70_000),
    ).toBe(false);
  });

  it("does not cache credentials whose lifetime is shorter than the refresh skew", () => {
    const refreshAtEpochMs = secondaryBearerRefreshAtEpochMs(10_000, 3);
    const cached = {
      expiresAtEpochMs: secondaryBearerExpiresAtEpochMs(10_000, 3),
      signature: "secondary-signature",
      registration,
      refreshAtEpochMs,
    };

    expect(refreshAtEpochMs).toBe(10_000);
    expect(canReuseCachedPlatformRegistration(cached, cached.signature, 10_000)).toBe(false);
  });

  it("retains only unexpired secondaries after a topology read failure", () => {
    const valid = {
      expiresAtEpochMs: 20_000,
      signature: "valid-secondary",
      registration,
      refreshAtEpochMs: 15_000,
    };
    const previous = new Map([
      ["valid-secondary", valid],
      [
        "expired-secondary",
        {
          expiresAtEpochMs: 10_000,
          signature: "expired-secondary",
          registration,
          refreshAtEpochMs: 5_000,
        },
      ],
    ]);

    expect(
      secondaryRegistrationsToRetainAfterTopologyRead(
        previous,
        { _tag: "Failure", cause: new Error("IPC unavailable") },
        10_000,
      ),
    ).toEqual(new Map([["valid-secondary", valid]]));
  });

  it("treats a successful empty topology as authoritative removal", () => {
    const previous = new Map([
      [
        "secondary",
        {
          expiresAtEpochMs: 20_000,
          signature: "secondary",
          registration,
          refreshAtEpochMs: 15_000,
        },
      ],
    ]);

    expect(
      secondaryRegistrationsToRetainAfterTopologyRead(
        previous,
        { _tag: "Success", bootstraps: [] },
        10_000,
      ),
    ).toEqual(new Map());
  });
});

describe("primary topology cache", () => {
  const registration = {} as never;
  const cached = {
    signature: "primary|http://127.0.0.1:3773/|ws://127.0.0.1:3773/",
    registration,
  };
  const previous = new Map([[PRIMARY_LOCAL_ENVIRONMENT_ID, cached]]);

  it("captures synchronous primary target read failures", () => {
    const cause = new Error("invalid primary target");
    expect(
      readPrimaryEnvironmentTargetResult(() => {
        throw cause;
      }),
    ).toEqual({ _tag: "Failure", cause });
  });

  it("retains the cached primary after a transient topology read failure", () => {
    expect(
      primaryRegistrationToRetainAfterTopologyRead(previous, {
        _tag: "Failure",
        cause: new Error("IPC unavailable"),
      }),
    ).toBe(cached);
  });

  it("treats a successful primary absence as authoritative removal", () => {
    expect(
      primaryRegistrationToRetainAfterTopologyRead(previous, {
        _tag: "Success",
        target: null,
      }),
    ).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
// connectionPlatformLayer — capability services and connection source
// ─────────────────────────────────────────────────────────────────────

describe("connectionPlatformLayer capabilities", () => {
  it.effect("builds the layer and exposes the platform capability services", () => {
    stubBrowser({ desktopBridge: makeBridge([]) });
    return Effect.gen(function* () {
      const presentation = yield* ClientPresentation;
      expect(presentation.metadata.label).toBe("BiBCode Desktop");
      expect(yield* ClientPresentation).toBeDefined();
      expect(yield* PrimaryEnvironmentAuth).toBeDefined();
      expect(yield* SshEnvironmentGateway).toBeDefined();
      expect(yield* PlatformConnectionSource).toBeDefined();
      expect(yield* EnvironmentOwnedDataCleanup).toBeDefined();
      expect(yield* EnvironmentRpcRequestObserver).toBeDefined();
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("labels the web client and omits the os when the platform is blank", () => {
    stubBrowser({ platform: "" });
    return Effect.gen(function* () {
      const presentation = yield* ClientPresentation;
      expect(presentation.metadata.label).toBe("BiBCode Web");
      expect("os" in presentation.metadata).toBe(false);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });
});

describe("connectionPlatformLayer primary bearer credential", () => {
  it.effect("wraps the desktop primary bearer token in an option", () => {
    stubBrowser();
    pf.desktopPrimaryBearer = () => Promise.resolve("primary-bearer");
    return Effect.gen(function* () {
      const auth = yield* PrimaryEnvironmentAuth;
      const token = yield* auth.bearerToken;
      expect(Option.isSome(token)).toBe(true);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("reports no credential when the desktop returns null", () => {
    stubBrowser();
    pf.desktopPrimaryBearer = () => Promise.resolve(null);
    return Effect.gen(function* () {
      const auth = yield* PrimaryEnvironmentAuth;
      expect(Option.isNone(yield* auth.bearerToken)).toBe(true);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("maps a desktop credential read rejection to a transient error", () => {
    stubBrowser();
    pf.desktopPrimaryBearer = () => Promise.reject(new Error("keychain locked"));
    return Effect.gen(function* () {
      const auth = yield* PrimaryEnvironmentAuth;
      const error = yield* auth.bearerToken.pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConnectionTransientError);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });
});

describe("connectionPlatformLayer ssh gateway", () => {
  it.effect("inspects through the desktop bridge without pairing", () => {
    const calls: string[] = [];
    const bridge = makeBridge(calls);
    stubBrowser({ desktopBridge: bridge });
    return Effect.gen(function* () {
      const ssh = yield* SshEnvironmentGateway;
      const inspected = yield* ssh.inspect({
        target: TARGET,
        hostKeyFingerprint: "SHA256:known-host-key",
        cancellation: new AbortController().signal,
      });
      expect(inspected.descriptor.environmentId).toBe(EnvironmentId.make("environment-ssh"));
      expect(calls).toEqual(["ensure", "descriptor"]);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("cancels the exact native generation when an SSH attempt is aborted", () => {
    const calls: string[] = [];
    const cancellation = new AbortController();
    let observedFence: {
      readonly operationId?: string;
      readonly environmentGeneration?: number;
      readonly bindingGeneration?: number;
    } | null = null;
    const bridge = makeBridge(calls, {
      onEnsure: (options) => {
        observedFence = options;
        cancellation.abort();
      },
    });
    stubBrowser({ desktopBridge: bridge });
    return Effect.gen(function* () {
      const ssh = yield* SshEnvironmentGateway;
      const exit = yield* Effect.exit(
        ssh.inspect({
          target: TARGET,
          hostKeyFingerprint: "SHA256:known-host-key",
          environmentGeneration: 8,
          bindingGeneration: 21,
          cancellation: cancellation.signal,
        }),
      );
      expect(exit._tag).toBe("Failure");
      if (exit._tag === "Failure") {
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
      }
      expect(calls).toEqual(["ensure", "cancel"]);
      expect(observedFence).toMatchObject({
        operationId: expect.any(String),
        environmentGeneration: 8,
        bindingGeneration: 21,
      });
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("blocks inspection when no desktop bridge is present", () => {
    stubBrowser();
    return Effect.gen(function* () {
      const ssh = yield* SshEnvironmentGateway;
      const error = yield* ssh
        .inspect({
          target: TARGET,
          hostKeyFingerprint: null,
          cancellation: new AbortController().signal,
        })
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConnectionBlockedError);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("exchanges an accepted inspection through the desktop bridge", () => {
    const calls: string[] = [];
    const bridge = makeBridge(calls);
    stubBrowser({ desktopBridge: bridge });
    return Effect.gen(function* () {
      const ssh = yield* SshEnvironmentGateway;
      const prepared = yield* ssh.exchange({
        bootstrap: SSH_BOOTSTRAP,
        descriptor: SSH_DESCRIPTOR,
      });
      expect(prepared.sessionSecret).toBe("protected-dpop-session");
      expect(calls).toEqual(["pairing", "token"]);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("mints an SSH WebSocket ticket through the native DPoP session", () => {
    const calls: string[] = [];
    const bridge = makeBridge(calls);
    stubBrowser({ desktopBridge: bridge });
    return Effect.gen(function* () {
      const ssh = yield* SshEnvironmentGateway;
      const authorized = yield* ssh.authorize({
        bootstrap: SSH_BOOTSTRAP,
        sessionSecret: "protected-dpop-session",
        cancellation: new AbortController().signal,
      });
      expect(authorized.socketUrl).toBe("ws://127.0.0.1:3201/ws?wsTicket=one-use-ticket");
      expect(calls).toEqual(["session", "ticket"]);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("blocks exchange when no desktop bridge is present", () => {
    stubBrowser();
    return Effect.gen(function* () {
      const ssh = yield* SshEnvironmentGateway;
      const error = yield* ssh
        .exchange({ bootstrap: SSH_BOOTSTRAP, descriptor: SSH_DESCRIPTOR })
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConnectionBlockedError);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("disconnects through the desktop bridge when present", () => {
    const calls: string[] = [];
    const bridge = makeBridge(calls);
    stubBrowser({ desktopBridge: bridge });
    return Effect.gen(function* () {
      const ssh = yield* SshEnvironmentGateway;
      yield* ssh.disconnect(TARGET, "SHA256:saved");
      expect(calls).toContain("disconnect");
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("is a no-op disconnect when no desktop bridge is present", () => {
    stubBrowser();
    return Effect.gen(function* () {
      const ssh = yield* SshEnvironmentGateway;
      yield* ssh.disconnect(TARGET, "SHA256:saved");
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("maps a disconnect failure to a transient error", () => {
    const bridge = makeBridge([], { failDisconnect: true });
    stubBrowser({ desktopBridge: bridge });
    return Effect.gen(function* () {
      const ssh = yield* SshEnvironmentGateway;
      const error = yield* ssh.disconnect(TARGET, "SHA256:saved").pipe(Effect.flip);
      expect(error).toBeInstanceOf(ConnectionTransientError);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });
});

describe("connectionPlatformLayer environment side effects", () => {
  it.effect("clears composer drafts for an environment", () => {
    stubBrowser();
    return Effect.gen(function* () {
      const cleanup = yield* EnvironmentOwnedDataCleanup;
      yield* cleanup.clear(EnvironmentId.make("environment-x"));
      expect(pf.clearCalls).toContain("environment-x");
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("tracks and acknowledges observed RPC requests", () => {
    stubBrowser();
    return Effect.gen(function* () {
      const observer = yield* EnvironmentRpcRequestObserver;
      const acknowledge = yield* observer.observe({
        environmentId: EnvironmentId.make("environment-x"),
        method: "session.start",
      });
      expect(pf.trackCalls).toHaveLength(1);
      expect(pf.trackCalls[0]!.tag).toContain("session.start");
      yield* acknowledge;
      expect(pf.ackCalls).toHaveLength(1);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });
});

describe("connectionPlatformLayer connectivity and wakeups", () => {
  it.effect("reports the current network status and wires connectivity listeners", () => {
    const dom = makeDomStubs();
    return Effect.gen(function* () {
      const connectivity = yield* Connectivity.Connectivity;
      expect(yield* connectivity.status).toBe("online");

      const fiber = yield* Effect.forkChild(Stream.runDrain(connectivity.changes));
      yield* waitFor(() => dom.windowListeners("online").length > 0);
      expect(dom.windowListeners("offline").length).toBeGreaterThan(0);
      // Exercise both browser online/offline listener bodies.
      dom.fireWindow("online");
      dom.fireWindow("offline");
      yield* Fiber.interrupt(fiber);
      // The release finalizer removed the listeners.
      expect(dom.windowListeners("online").length).toBe(0);
      expect(dom.windowListeners("offline").length).toBe(0);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("wires a visibility-change wakeup listener and tears it down", () => {
    const dom = makeDomStubs();
    return Effect.gen(function* () {
      const wakeups = yield* Wakeups.ConnectionWakeups;
      const fiber = yield* Effect.forkChild(Stream.runDrain(wakeups.changes));
      yield* waitFor(() => dom.documentListeners("visibilitychange").length > 0);
      // Fire while visible so the listener enqueues an application-active wakeup.
      dom.fireDocument("visibilitychange");
      yield* Fiber.interrupt(fiber);
      expect(dom.documentListeners("visibilitychange").length).toBe(0);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });
});

// ─────────────────────────────────────────────────────────────────────
// PlatformConnectionSource registrations stream
// ─────────────────────────────────────────────────────────────────────

describe("connectionPlatformLayer connection source", () => {
  it.effect("emits no registrations for the hosted static app", () => {
    pf.isHostedStatic = true;
    stubBrowser();
    return Effect.gen(function* () {
      const source = yield* PlatformConnectionSource;
      const head = yield* Stream.runHead(source.registrations);
      expect(Option.isNone(head)).toBe(true);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("reads the primary and desktop-local topology on the initial event", () => {
    stubBrowser({ desktopBridge: makeBridge([]) });
    pf.isHostedStatic = false;
    pf.primaryTarget = {
      source: "cli",
      target: {
        httpBaseUrl: "http://127.0.0.1:3773/",
        wsBaseUrl: "ws://127.0.0.1:3773/",
      },
    };
    pf.secondaryRead = {
      _tag: "Success",
      bootstraps: [
        {
          id: "wsl",
          label: "WSL: Ubuntu",
          httpBaseUrl: "http://127.0.0.1:3202/",
          wsBaseUrl: "ws://127.0.0.1:3202/",
          bootstrapToken: "bootstrap-token",
        },
        {
          // A not-yet-ready desktop-local backend is skipped this poll.
          id: "pending",
          label: "",
          httpBaseUrl: null,
          wsBaseUrl: null,
          bootstrapToken: undefined,
        },
      ],
    };
    return Effect.gen(function* () {
      const source = yield* PlatformConnectionSource;
      const fiber = yield* Effect.forkChild(
        Stream.runHead(source.registrations.pipe(Stream.take(1))),
      );
      const head = yield* Fiber.join(fiber);
      expect(Option.isSome(head)).toBe(true);
      const registrations = Option.getOrThrow(head);
      // Primary (same-origin) + secondary (desktop-local bearer) registrations.
      expect(registrations.length).toBeGreaterThanOrEqual(2);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("withholds a WSL runtime until the initial discovery state is available", () => {
    stubBrowser({ desktopBridge: makeBridge([]) });
    pf.isHostedStatic = false;
    pf.wslState = null;
    pf.secondaryRead = {
      _tag: "Success",
      bootstraps: [
        {
          id: "delayed-wsl-state",
          label: "WSL: Ubuntu",
          runningDistro: "Ubuntu",
          httpBaseUrl: "http://127.0.0.1:3202/",
          wsBaseUrl: "ws://127.0.0.1:3202/",
          bootstrapToken: "bootstrap-token",
        },
      ],
    };
    return Effect.gen(function* () {
      const source = yield* PlatformConnectionSource;
      const fiber = yield* Effect.forkChild(
        Stream.runCollect(source.registrations.pipe(Stream.take(2))),
      );
      yield* waitFor(() => pf.topologyListeners.length === 1);
      yield* Effect.yieldNow;
      expect(pf.descriptorCalls).toEqual([]);

      pf.wslState = platformWslState(1);
      for (const listener of pf.topologyListeners) listener();
      const batches = Array.from(yield* Fiber.join(fiber));
      expect(batches[0]).toEqual([]);
      expect(batches[1]).toEqual([
        expect.objectContaining({
          _tag: "BearerConnectionRegistration",
          wslRouteId: "platform:wsl:desktop:wsl:ubuntu",
        }),
      ]);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("attaches a proved WSL binding and stable candidate route to a live runtime", () => {
    stubBrowser({ desktopBridge: makeBridge([]) });
    pf.isHostedStatic = false;
    pf.wslState = platformWslState(7);
    pf.secondaryRead = {
      _tag: "Success",
      bootstraps: [
        {
          id: "runtime-slot-1",
          label: "WSL: Ubuntu",
          runningDistro: "Ubuntu",
          httpBaseUrl: "http://127.0.0.1:3202/",
          wsBaseUrl: "ws://127.0.0.1:3202/",
          bootstrapToken: "bootstrap-token",
        },
      ],
    };
    return Effect.gen(function* () {
      const source = yield* PlatformConnectionSource;
      const registrations = Option.getOrThrow(yield* Stream.runHead(source.registrations));
      expect(registrations).toContainEqual(
        expect.objectContaining({
          _tag: "BearerConnectionRegistration",
          target: expect.objectContaining({ connectionId: "local:runtime-slot-1" }),
          wslBinding: expect.objectContaining({
            bindingId: "desktop:wsl:ubuntu",
            distroName: "Ubuntu",
            acceptedEnvironmentId: platformDescriptor().environmentId,
            condition: "available",
            lastDiscoveryGeneration: 7,
          }),
          wslRouteId: "platform:wsl:desktop:wsl:ubuntu",
        }),
      );
      expect(pf.putBindings).toEqual([]);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("retains accepted stopped environments as unavailable registrations", () => {
    stubBrowser({ desktopBridge: makeBridge([]) });
    pf.isHostedStatic = false;
    pf.wslState = platformWslState(8, "stopped");
    const acceptedBinding = new DesktopWslBinding({
      bindingId: "desktop:wsl:ubuntu",
      distroName: "Ubuntu",
      acceptedEnvironmentId: EnvironmentId.make(platformDescriptor().environmentId),
      acceptedStorageInstanceIds: [platformDescriptor().storageInstanceId],
      acceptedAt: "2026-08-25T00:00:00Z",
      lastDiscoveryGeneration: 7,
      condition: "available",
      detail: null,
    });
    pf.catalogBindings = [acceptedBinding];
    pf.catalogEnvironments = [
      {
        environmentId: platformDescriptor().environmentId,
        acceptedStorageInstanceId: platformDescriptor().storageInstanceId,
        descriptor: platformDescriptor(),
        alias: "WSL: Ubuntu",
        hidden: false,
        bindings: [acceptedBinding],
        routes: [],
      },
    ];
    pf.secondaryRead = { _tag: "Success", bootstraps: [] };
    return Effect.gen(function* () {
      const source = yield* PlatformConnectionSource;
      const registrations = Option.getOrThrow(yield* Stream.runHead(source.registrations));
      expect(registrations).toEqual([
        expect.objectContaining({
          _tag: "UnavailableConnectionRegistration",
          target: expect.objectContaining({
            environmentId: platformDescriptor().environmentId,
            configuredDistro: "Ubuntu",
          }),
          wslBinding: expect.objectContaining({
            bindingId: "desktop:wsl:ubuntu",
            condition: "stopped",
            lastDiscoveryGeneration: 8,
          }),
        }),
      ]);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("blocks a live WSL locator that reports a replacement server identity", () => {
    stubBrowser({ desktopBridge: makeBridge([]) });
    pf.isHostedStatic = false;
    pf.wslState = platformWslState(9);
    const acceptedBinding = new DesktopWslBinding({
      bindingId: "desktop:wsl:ubuntu",
      distroName: "Ubuntu",
      acceptedEnvironmentId: EnvironmentId.make(platformDescriptor().environmentId),
      acceptedStorageInstanceIds: [platformDescriptor().storageInstanceId],
      acceptedAt: "2026-08-25T00:00:00Z",
      lastDiscoveryGeneration: 8,
      condition: "available",
      detail: null,
    });
    pf.catalogBindings = [acceptedBinding];
    pf.catalogEnvironments = [
      {
        environmentId: platformDescriptor().environmentId,
        acceptedStorageInstanceId: platformDescriptor().storageInstanceId,
        descriptor: platformDescriptor(),
        alias: "WSL: Ubuntu",
        hidden: false,
        bindings: [acceptedBinding],
        routes: [],
      },
    ];
    pf.descriptor = {
      ...platformDescriptor(),
      environmentId: EnvironmentId.make("00000000-0000-4000-8000-000000000091"),
      storageInstanceId: "00000000-0000-4000-8000-000000000092",
    };
    pf.secondaryRead = {
      _tag: "Success",
      bootstraps: [
        {
          id: "replacement-runtime-slot",
          label: "WSL: Ubuntu",
          runningDistro: "Ubuntu",
          httpBaseUrl: "http://127.0.0.1:3209/",
          wsBaseUrl: "ws://127.0.0.1:3209/",
          bootstrapToken: "replacement-bootstrap-token",
        },
      ],
    };
    return Effect.gen(function* () {
      const source = yield* PlatformConnectionSource;
      const registrations = Option.getOrThrow(yield* Stream.runHead(source.registrations));
      expect(registrations).toEqual([
        expect.objectContaining({
          _tag: "UnavailableConnectionRegistration",
          target: expect.objectContaining({
            environmentId: platformDescriptor().environmentId,
            connectionId: "local:replacement-runtime-slot",
          }),
          wslBinding: expect.objectContaining({
            bindingId: "desktop:wsl:ubuntu",
            acceptedEnvironmentId: platformDescriptor().environmentId,
            condition: "identity-conflict",
          }),
        }),
      ]);
      expect(registrations).not.toContainEqual(
        expect.objectContaining({ _tag: "BearerConnectionRegistration" }),
      );
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("persists an unproved setup-required WSL candidate", () => {
    stubBrowser({ desktopBridge: makeBridge([]) });
    pf.isHostedStatic = false;
    pf.wslState = platformWslState(5);
    pf.secondaryRead = {
      _tag: "Success",
      bootstraps: [
        {
          id: "pending-ubuntu",
          label: "WSL: Ubuntu",
          configuredDistro: "Ubuntu",
          runningDistro: "Ubuntu",
          httpBaseUrl: null,
          wsBaseUrl: null,
          preflightError: {
            kind: "wsl-secondary-unavailable",
            detail: "BiBCode Server setup is required.",
          },
        },
      ],
    };
    return Effect.gen(function* () {
      const source = yield* PlatformConnectionSource;
      const registrations = Option.getOrThrow(yield* Stream.runHead(source.registrations));
      expect(registrations).toEqual([
        expect.objectContaining({
          _tag: "UnavailableConnectionRegistration",
          wslBinding: expect.objectContaining({
            bindingId: "desktop:wsl:ubuntu",
            acceptedEnvironmentId: null,
            condition: "setup-required",
            lastDiscoveryGeneration: 5,
          }),
        }),
      ]);
      expect(pf.putBindings).toEqual([
        expect.objectContaining({
          bindingId: "desktop:wsl:ubuntu",
          condition: "setup-required",
        }),
      ]);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("deletes a transient rename candidate after descriptor proof", () => {
    stubBrowser({ desktopBridge: makeBridge([]) });
    pf.isHostedStatic = false;
    pf.wslState = {
      ...platformWslState(3),
      discovery: {
        ...platformWslState(3).discovery,
        distros: [
          { name: "Ubuntu-Renamed", isDefault: true, state: "running", version: 2 as const },
        ],
      },
      distros: [{ name: "Ubuntu-Renamed", isDefault: true, state: "running", version: 2 as const }],
    };
    const accepted = new DesktopWslBinding({
      bindingId: "desktop:wsl:ubuntu",
      distroName: "Ubuntu",
      acceptedEnvironmentId: EnvironmentId.make(platformDescriptor().environmentId),
      acceptedStorageInstanceIds: [platformDescriptor().storageInstanceId],
      acceptedAt: "2026-08-25T00:00:00Z",
      lastDiscoveryGeneration: 1,
      condition: "available",
      detail: null,
    });
    const transient = new DesktopWslBinding({
      bindingId: "desktop:wsl:ubuntu-renamed",
      distroName: "Ubuntu-Renamed",
      acceptedEnvironmentId: null,
      acceptedStorageInstanceIds: [],
      acceptedAt: null,
      lastDiscoveryGeneration: 2,
      condition: "setup-required",
      detail: "Setup required.",
    });
    pf.catalogBindings = [accepted, transient];
    pf.catalogEnvironments = [
      {
        environmentId: platformDescriptor().environmentId,
        acceptedStorageInstanceId: platformDescriptor().storageInstanceId,
        descriptor: platformDescriptor(),
        alias: "WSL: Ubuntu",
        hidden: false,
        bindings: [accepted],
        routes: [],
      },
    ];
    pf.secondaryRead = {
      _tag: "Success",
      bootstraps: [
        {
          id: "renamed-runtime-slot",
          label: "WSL: Ubuntu-Renamed",
          runningDistro: "Ubuntu-Renamed",
          httpBaseUrl: "http://127.0.0.1:3210/",
          wsBaseUrl: "ws://127.0.0.1:3210/",
          bootstrapToken: "bootstrap-token",
        },
      ],
    };
    return Effect.gen(function* () {
      const source = yield* PlatformConnectionSource;
      const registrations = Option.getOrThrow(yield* Stream.runHead(source.registrations));
      expect(registrations).toHaveLength(1);
      expect(registrations[0]).toEqual(
        expect.objectContaining({
          _tag: "BearerConnectionRegistration",
          wslBinding: expect.objectContaining({
            bindingId: accepted.bindingId,
            distroName: "Ubuntu-Renamed",
            condition: "available",
          }),
        }),
      );
      expect(pf.removedBindings).toEqual([transient]);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("rebuilds registrations on topology events and unsubscribes on teardown", () => {
    stubBrowser({ desktopBridge: makeBridge([]) });
    pf.isHostedStatic = false;
    pf.wslState = platformWslState(1);
    pf.secondaryRead = {
      _tag: "Success",
      bootstraps: [
        {
          id: "wsl-first",
          label: "WSL: Ubuntu",
          runningDistro: "Ubuntu",
          httpBaseUrl: "http://127.0.0.1:3201/",
          wsBaseUrl: "ws://127.0.0.1:3201/",
          bootstrapToken: "bootstrap-token-1",
        },
      ],
    };
    return Effect.gen(function* () {
      const source = yield* PlatformConnectionSource;
      const fiber = yield* Effect.forkChild(
        Stream.runCollect(source.registrations.pipe(Stream.take(2))),
      );
      yield* waitFor(() => pf.topologyListeners.length === 1);
      yield* waitFor(() => pf.descriptorCalls.length === 1);
      pf.secondaryRead = {
        _tag: "Success",
        bootstraps: [
          {
            id: "wsl",
            label: "WSL: Ubuntu",
            runningDistro: "Ubuntu",
            httpBaseUrl: "http://127.0.0.1:3202/",
            wsBaseUrl: "ws://127.0.0.1:3202/",
            bootstrapToken: "bootstrap-token",
          },
        ],
      };
      for (const listener of pf.topologyListeners) listener();
      const batches = Array.from(yield* Fiber.join(fiber));

      expect(batches).toHaveLength(2);
      expect(batches[0]?.[0]).toEqual(
        expect.objectContaining({
          target: expect.objectContaining({ connectionId: "local:wsl-first" }),
        }),
      );
      expect(batches[1]?.[0]).toEqual(
        expect.objectContaining({
          target: expect.objectContaining({ connectionId: "local:wsl" }),
        }),
      );
      expect(pf.topologyListeners).toEqual([]);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("retains a configured unavailable WSL secondary without fabricating a session", () => {
    stubBrowser({ desktopBridge: makeBridge([]) });
    pf.isHostedStatic = false;
    pf.wslState = platformWslState(1);
    pf.primaryTarget = {
      source: "cli",
      target: {
        httpBaseUrl: "http://127.0.0.1:3773/",
        wsBaseUrl: "ws://127.0.0.1:3773/",
      },
    };
    pf.secondaryRead = {
      _tag: "Success",
      bootstraps: [
        {
          id: "wsl:Ubuntu",
          label: "WSL (Ubuntu)",
          configuredDistro: "Ubuntu",
          runningDistro: null,
          httpBaseUrl: null,
          wsBaseUrl: null,
          preflightError: {
            kind: "wsl-secondary-unavailable",
            detail: "the configured WSL distribution could not start",
          },
        },
      ],
    };
    return Effect.gen(function* () {
      const source = yield* PlatformConnectionSource;
      const fiber = yield* Effect.forkChild(
        Stream.runHead(source.registrations.pipe(Stream.take(1))),
      );
      const registrations = Option.getOrThrow(yield* Fiber.join(fiber));

      expect(registrations).toContainEqual(
        expect.objectContaining({
          _tag: "UnavailableConnectionRegistration",
          target: expect.objectContaining({
            _tag: "UnavailableConnectionTarget",
            environmentId: "wsl:Ubuntu",
            label: "WSL (Ubuntu)",
            connectionId: "local:wsl:Ubuntu",
            configuredDistro: "Ubuntu",
            detail: "the configured WSL distribution could not start",
          }),
        }),
      );
      expect(pf.descriptorCalls).toEqual(["http://127.0.0.1:3773/"]);
      expect(pf.bearerBootstrapCalls).toEqual([]);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("logs and yields an empty batch when both topology reads fail", () => {
    stubBrowser();
    pf.isHostedStatic = false;
    pf.primaryTarget = new Error("invalid primary target");
    pf.secondaryRead = { _tag: "Failure", cause: new Error("IPC unavailable") };
    return Effect.gen(function* () {
      const source = yield* PlatformConnectionSource;
      const fiber = yield* Effect.forkChild(
        Stream.runHead(source.registrations.pipe(Stream.take(1))),
      );
      const head = yield* Fiber.join(fiber);
      expect(Option.isSome(head)).toBe(true);
      // No primary target and a failed secondary read yields an empty batch.
      expect(Option.getOrThrow(head)).toEqual([]);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });

  it.effect("retains an accepted WSL environment after topology failure and token expiry", () => {
    stubBrowser({ desktopBridge: makeBridge([]) });
    pf.isHostedStatic = false;
    pf.wslState = platformWslState(4);
    pf.bearerAccess = { access_token: "short-lived", expires_in: 1 };
    const accepted = new DesktopWslBinding({
      bindingId: "desktop:wsl:ubuntu",
      distroName: "Ubuntu",
      acceptedEnvironmentId: EnvironmentId.make(platformDescriptor().environmentId),
      acceptedStorageInstanceIds: [platformDescriptor().storageInstanceId],
      acceptedAt: "2026-08-25T00:00:00Z",
      lastDiscoveryGeneration: 3,
      condition: "available",
      detail: null,
    });
    pf.catalogBindings = [accepted];
    pf.catalogEnvironments = [
      {
        environmentId: platformDescriptor().environmentId,
        acceptedStorageInstanceId: platformDescriptor().storageInstanceId,
        descriptor: platformDescriptor(),
        alias: "WSL: Ubuntu",
        hidden: false,
        bindings: [accepted],
        routes: [],
      },
    ];
    pf.secondaryRead = {
      _tag: "Success",
      bootstraps: [
        {
          id: "expiring-runtime",
          label: "WSL: Ubuntu",
          runningDistro: "Ubuntu",
          httpBaseUrl: "http://127.0.0.1:3211/",
          wsBaseUrl: "ws://127.0.0.1:3211/",
          bootstrapToken: "bootstrap-token",
        },
      ],
    };
    return Effect.gen(function* () {
      const source = yield* PlatformConnectionSource;
      const fiber = yield* Effect.forkChild(
        Stream.runCollect(source.registrations.pipe(Stream.take(2))),
      );
      yield* waitFor(() => pf.topologyListeners.length === 1);
      yield* waitFor(() => pf.descriptorCalls.length === 1);
      yield* TestClock.adjust("2 seconds");
      pf.secondaryRead = { _tag: "Failure", cause: new Error("IPC unavailable") };
      for (const listener of pf.topologyListeners) listener();
      const batches = Array.from(yield* Fiber.join(fiber));
      expect(batches[0]?.[0]).toEqual(
        expect.objectContaining({ _tag: "BearerConnectionRegistration" }),
      );
      expect(batches[1]).toEqual([
        expect.objectContaining({
          _tag: "UnavailableConnectionRegistration",
          target: expect.objectContaining({
            environmentId: platformDescriptor().environmentId,
          }),
          wslBinding: expect.objectContaining({ bindingId: accepted.bindingId }),
        }),
      ]);
    }).pipe(Effect.provide(connectionPlatformLayer));
  });
});
