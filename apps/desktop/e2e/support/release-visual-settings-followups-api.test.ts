// @effect-diagnostics nodeBuiltinImport:off - Current public contracts and inert transport ports only.
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";
import { ExecutionEnvironmentDescriptor } from "../../../../packages/contracts/src/environment.ts";
import { ServerConfig } from "../../../../packages/contracts/src/server.ts";
import { DEFAULT_SERVER_SETTINGS } from "../../../../packages/contracts/src/settings.ts";
import { OrchestrationReadModel } from "../../../../packages/contracts/src/orchestration.ts";
import {
  withSettingsFollowupApi,
  type SettingsFollowupApiPorts,
} from "./release-visual-settings-followups-api.ts";
const Schema = NodeModule.createRequire(
  new NodeURL.URL("../../../../packages/contracts/package.json", import.meta.url),
)("effect/Schema");
const descriptor: ExecutionEnvironmentDescriptor = Schema.decodeUnknownSync(
  ExecutionEnvironmentDescriptor,
)({
  environmentId: "local",
  label: "Owned server",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.7.4",
  storageInstanceId: "owned-store",
  bootId: "owned-boot",
  capabilities: {},
});
const now = "2026-10-06T00:00:00Z";
const config = Schema.encodeSync(Schema.toCodecJson(ServerConfig))({
  environment: descriptor,
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["bearer-access-token"],
    sessionCookieName: "owned",
  },
  cwd: "/owned/project",
  keybindingsConfigPath: "/owned/keys.json",
  keybindings: [],
  issues: [],
  providers: [],
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/owned/logs",
    localTracingEnabled: true,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
});
function fixture(mode = "owned") {
  const callbacks = new Map<string, Array<(event: { data?: unknown }) => void>>(),
    requests: Array<{ tag: string; payload: unknown }> = [];
  let closed = 0,
    pongs = 0,
    fetches = 0;
  const socket = {
    readyState: 1,
    addEventListener: (name: string, callback: (event: { data?: unknown }) => void) =>
      callbacks.set(name, [...(callbacks.get(name) ?? []), callback]),
    removeEventListener: () => {},
    close: () => {
      closed++;
      socket.readyState = 3;
      for (const callback of callbacks.get("close") ?? []) callback({});
    },
    send: (text: string) => {
      const request = JSON.parse(text);
      if (request._tag === "Pong") {
        pongs++;
        return;
      }
      requests.push(request);
      const value =
        request.tag === "server.getConfig"
          ? {
              ...config,
              environment: {
                ...config.environment,
                ...(mode === "wrong-boot" ? { bootId: "foreign" } : {}),
                ...(mode === "wrong-storage" ? { storageInstanceId: "foreign" } : {}),
              },
            }
          : request.tag === "server.getProviderUsage" ||
              request.tag === "server.refreshProviderUsage"
            ? {
                readAt: now,
                isFetching: false,
                providers: [
                  {
                    provider: "codex",
                    status: "unavailable",
                    session: null,
                    weekly: null,
                    fableWeekly: null,
                    planType: null,
                    rateLimitResetCredits: null,
                    updatedAt: now,
                    error: "Codex not signed in.",
                    metadata: {},
                  },
                ],
              }
            : null;
      const frame = {
        _tag: "Exit",
        requestId: request.id,
        exit:
          request.tag === "gitManager.getRefs"
            ? {
                _tag: "Failure",
                cause: [
                  {
                    _tag: "Fail",
                    error: {
                      _tag:
                        mode === "wrong-error" ? "EnvironmentRpcError" : "GitManagerOperationError",
                      operation: "gitManager.getRefs",
                      code: "path-unavailable",
                      message: "Owned requested directory is unavailable.",
                      blocked: null,
                    },
                  },
                ],
              }
            : { _tag: "Success", value: mode === "malformed" ? {} : value },
      };
      if (mode === "manual-reply") return;
      queueMicrotask(() => {
        for (const callback of callbacks.get("message") ?? [])
          callback({ data: JSON.stringify(frame) });
      });
    },
  };
  const ports: SettingsFollowupApiPorts = {
    fetch: async () => {
      fetches++;
      return {
        ok: true,
        json: async () => ({ ticket: "owned-ticket", expiresAt: "2026-10-06T01:00:00Z" }),
      };
    },
    socket: () => socket,
  };
  const input = {
    CI: "true",
    origin: "http://127.0.0.1:4888" as const,
    ownedRoot: "/owned",
    accessToken: "owned-private-token",
    descriptor,
    verifyTarget: async () => {},
    observeUnsafeCleanup: () => {},
    ports,
  };
  return {
    input,
    requests,
    closed: () => closed,
    fetches: () => fetches,
    pongs: () => pongs,
    emit: (frame: unknown) => {
      for (const callback of callbacks.get("message") ?? [])
        callback({ data: JSON.stringify(frame) });
    },
  };
}
it("uses only the current typed selected-server usage and owned read-failure RPCs and closes its socket", async () => {
  const f = fixture();
  await withSettingsFollowupApi(f.input, async (api) => {
    expect((await api.usage()).providers[0]?.status).toBe("unavailable");
    await api.refreshUsage();
    expect(await api.requestOwnedReadFailure("/owned/missing")).toMatchObject({
      ownedReadFailure: true,
      error: {
        operation: "gitManager.getRefs",
        message: "Owned requested directory is unavailable.",
      },
    });
  });
  expect(f.closed()).toBe(1);
  expect(f.requests.map((value) => value.tag)).toEqual([
    "server.getProviderUsage",
    "server.refreshProviderUsage",
    "gitManager.getRefs",
  ]);
  expect(f.requests[1]?.payload).toEqual({ providers: ["codex"], force: true });
});
it("answers the actual typed RPC heartbeat while idle and while a native request is pending", async () => {
  const f = fixture();
  await withSettingsFollowupApi(f.input, async (api) => {
    f.emit({ _tag: "Ping" });
    expect(f.pongs()).toBe(1);
    const read = api.usage();
    await Promise.resolve();
    f.emit({ _tag: "Ping" });
    await read;
    expect(f.pongs()).toBe(2);
  });
  expect(f.closed()).toBe(1);
  expect(f.requests.map((value) => value.tag)).toEqual(["server.getProviderUsage"]);
});
it("caps decoded WebSocket response bytes even when multibyte JSON is below the character limit", async () => {
  const f = fixture("manual-reply");
  await withSettingsFollowupApi(f.input, async (api) => {
    const read = api.usage();
    for (let tick = 0; tick < 3 && f.requests.length === 0; tick++) await Promise.resolve();
    expect(f.requests).toHaveLength(1);
    f.emit({
      _tag: "Exit",
      requestId: "1",
      exit: {
        _tag: "Success",
        value: { readAt: now, isFetching: false, providers: [], extra: "😀".repeat(300000) },
      },
    });
    await expect(read).rejects.toThrow();
  });
  expect(f.closed()).toBe(1);
});

it("reads the actual authenticated selected-server HTTP snapshot with target checks on both sides", async () => {
  const f = fixture(),
    originalFetch = f.input.ports.fetch;
  const model = { snapshotSequence: 0, projects: [], threads: [], updatedAt: now };
  let checks = 0,
    reads = 0;
  f.input.verifyTarget = async () => {
    checks++;
  };
  f.input.ports.fetch = async (url, input) => {
    if (url.endsWith("/api/orchestration/snapshot")) {
      expect(url).toBe("http://127.0.0.1:4888/api/orchestration/snapshot");
      expect(input.method).toBe("GET");
      expect(input.headers).toEqual({ authorization: "Bearer owned-private-token" });
      reads++;
      return { ok: true, json: async () => model };
    }
    return originalFetch(url, input);
  };
  await withSettingsFollowupApi(f.input, async (api) => {
    const before = checks;
    expect(await api.snapshot()).toEqual(Schema.decodeUnknownSync(OrchestrationReadModel)(model));
    expect(checks - before).toBe(2);
  });
  expect(reads).toBe(1);
  expect(f.closed()).toBe(1);
});

it.each(["malformed", "oversized", "changed-target", "concurrent"])(
  "refuses %s HTTP snapshot sources and joins the owned socket",
  async (mode) => {
    const f = fixture(),
      originalFetch = f.input.ports.fetch;
    let changed = false;
    f.input.verifyTarget = async () => {
      if (changed) throw new Error("Inert target changed.");
    };
    f.input.ports.fetch = async (url, input) => {
      if (!url.endsWith("/api/orchestration/snapshot")) return originalFetch(url, input);
      if (mode === "changed-target") changed = true;
      if (mode === "concurrent") await Promise.resolve();
      return {
        ok: true,
        json: async () =>
          mode === "malformed"
            ? {}
            : {
                snapshotSequence: 0,
                projects: [],
                threads: [],
                updatedAt: now,
                ...(mode === "oversized" ? { extra: "x".repeat(1048577) } : {}),
              },
      };
    };
    await expect(
      withSettingsFollowupApi(f.input, async (api) => {
        if (mode === "concurrent") await Promise.all([api.snapshot(), api.snapshot()]);
        else await api.snapshot();
      }),
    ).rejects.toThrow();
    expect(f.closed()).toBe(1);
  },
);
it.each(["malformed", "wrong-error"])(
  "refuses invalid native output rather than inferring source readiness: %s",
  async (mode) => {
    const f = fixture(mode);
    if (mode === "wrong-error") {
      await expect(
        withSettingsFollowupApi(f.input, (api) => api.requestOwnedReadFailure("/owned/missing")),
      ).rejects.toThrow();
    } else {
      await expect(withSettingsFollowupApi(f.input, (api) => api.usage())).rejects.toThrow();
    }
    expect(f.closed()).toBe(1);
  },
);
it("refuses non-CI before tickets, sockets or source probes", async () => {
  const f = fixture();
  await expect(
    withSettingsFollowupApi({ ...f.input, CI: undefined }, async () => {}),
  ).rejects.toThrow();
  expect(f.fetches()).toBe(0);
});
it("retains the exact body exception after closing its private public API socket", async () => {
  const f = fixture(),
    original = new Error("Inert original source refusal.");
  await expect(
    withSettingsFollowupApi(f.input, async (api) => {
      await api.usage();
      throw original;
    }),
  ).rejects.toBe(original);
  expect(f.closed()).toBe(1);
});
it("decodes the genuine full config contract and binds boot/storage identity before returning source data", async () => {
  const f = fixture();
  let probes = 0;
  await withSettingsFollowupApi(
    {
      ...f.input,
      verifyTarget: async () => {
        probes++;
      },
    },
    async (api) => {
      expect((await api.config()).environment.bootId).toBe(descriptor.bootId);
    },
  );
  expect(probes).toBeGreaterThanOrEqual(3);
  expect(f.closed()).toBe(1);
});
it.each(["wrong-boot", "wrong-storage"])(
  "refuses foreign config identity on the existing public API: %s",
  async (mode) => {
    const f = fixture(mode);
    await expect(withSettingsFollowupApi(f.input, (api) => api.config())).rejects.toThrow();
    expect(f.closed()).toBe(1);
  },
);
it("refuses an unowned read-failure input without issuing that native operation", async () => {
  const f = fixture();
  await expect(
    withSettingsFollowupApi(f.input, (api) => api.requestOwnedReadFailure("/foreign/missing")),
  ).rejects.toThrow();
  expect(f.requests).toEqual([]);
  expect(f.closed()).toBe(1);
});
