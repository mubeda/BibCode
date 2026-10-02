// Cross-language E2EE interop: TypeScript Noise NK initiator against the real
// Rust responder. Opt-in: requires a freshly built server binary.
//
//   cargo build -p bibcode-server --features hermetic-test-guard --bin bibcode -j 2
//   BIBCODE_E2EE_SERVER_BIN=$PWD/target/debug/bibcode vp test run src/e2ee/serverInterop.test.ts
//
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off - This opt-in harness probes a real loopback server process.
// @effect-diagnostics globalTimers:off - The process and WebSocket harness owns bounded watchdogs.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeZlib from "node:zlib";

import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  DEFAULT_SERVER_SETTINGS,
  AssetReadEvent,
  EnvironmentId,
  ProjectDownloadEvent,
  ServerConfig,
  type RemotePairingCodePayload,
} from "@bibcode/contracts";
import { parsePairingCode } from "@bibcode/shared/pairingCode";
import { HostProcessPlatform } from "@bibcode/shared/hostProcess";
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { downloadFile } from "../operations/fileTransfers.ts";
import type { RpcSession } from "../rpc/session.ts";

import { decodeBase64UrlKey } from "./noise.ts";
import {
  type EncryptedTestSocket,
  openEncryptedTestSocket,
  requestTestRpc,
  streamTestRpc,
} from "./testSupport.ts";

const serverBinary = process.env["BIBCODE_E2EE_SERVER_BIN"];
const hostPlatform = Context.get(Context.empty(), HostProcessPlatform);
const reportPath = process.env["BIBCODE_E2EE_REPORT_PATH"];
const decodeDownloadEvent = Schema.decodeUnknownSync(ProjectDownloadEvent);
const decodeAssetEvent = Schema.decodeUnknownSync(AssetReadEvent);
const decodeConfig = Schema.decodeUnknownSync(ServerConfig);
interface RunningServer {
  process: NodeChildProcess.ChildProcess;
  closed: Promise<void>;
  httpBaseUrl: string;
  token: string;
  dataRoot: string;
  adminAccessToken?: string;
  guardRefused?: () => boolean;
}

function prepareServerFixture(source: string) {
  const executable = NodeFS.realpathSync(source);
  if (
    !NodeFS.statSync(executable).isFile() ||
    !NodeFS.readFileSync(executable).includes(Buffer.from("hermetic-test-guard: refused"))
  ) {
    throw new Error(
      "Build the opt-in server with --features hermetic-test-guard before running this suite.",
    );
  }
  const dataRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-e2ee-"));
  try {
    NodeFS.chmodSync(dataRoot, 0o700);
    const home = NodePath.join(dataRoot, "home");
    const bin = NodePath.join(dataRoot, "bin");
    for (const path of [home, bin, NodePath.join(dataRoot, "userdata")])
      NodeFS.mkdirSync(path, { recursive: true });
    const binary = NodePath.join(bin, hostPlatform === "win32" ? "bibcode.exe" : "bibcode");
    NodeFS.copyFileSync(executable, binary);
    NodeFS.chmodSync(binary, 0o700);
    const absent = NodePath.join(dataRoot, "missing-provider-executable");
    const providers = Object.fromEntries(
      Object.keys(DEFAULT_SERVER_SETTINGS.providers).map((driver) => [
        driver,
        {
          enabled: false,
          binaryPath: absent,
          ...(driver === "codex"
            ? {
                homePath: NodePath.join(home, ".codex"),
                shadowHomePath: NodePath.join(home, "codex-shadow"),
              }
            : {}),
          ...(driver === "claudeAgent" ? { homePath: NodePath.join(home, ".claude") } : {}),
        },
      ]),
    );
    NodeFS.writeFileSync(
      NodePath.join(dataRoot, "userdata/settings.json"),
      JSON.stringify({
        enableProviderUpdateChecks: false,
        enableChatAgentActivity: false,
        enableTerminalAgentActivity: false,
        providers,
        providerInstances: {},
      }),
    );
    const systemRoot = process.env["SystemRoot"] ?? "C:\\Windows";
    const env: NodeJS.ProcessEnv = {
      PATH:
        hostPlatform === "win32"
          ? NodePath.join(systemRoot, "System32")
          : "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: home,
      USERPROFILE: home,
      TMPDIR: dataRoot,
      TMP: dataRoot,
      TEMP: dataRoot,
      XDG_CONFIG_HOME: NodePath.join(home, ".config"),
      XDG_DATA_HOME: NodePath.join(home, ".local/share"),
      XDG_CACHE_HOME: NodePath.join(home, ".cache"),
      XDG_STATE_HOME: NodePath.join(home, ".local/state"),
      CODEX_HOME: NodePath.join(home, ".codex"),
      CLAUDE_CONFIG_DIR: NodePath.join(home, ".claude"),
      APPDATA: NodePath.join(home, "AppData/Roaming"),
      LOCALAPPDATA: NodePath.join(home, "AppData/Local"),
      BIBCODE_HERMETIC_GUARD: "report",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: NodePath.join(home, "gitconfig"),
      GIT_TERMINAL_PROMPT: "0",
      TERM: "dumb",
      LANG: "C",
      ...(hostPlatform === "win32"
        ? { SystemRoot: systemRoot, ComSpec: NodePath.join(systemRoot, "System32/cmd.exe") }
        : { SHELL: "/bin/sh" }),
    };
    return { dataRoot, binary, env, cwd: home };
  } catch (error) {
    NodeFS.rmSync(dataRoot, { recursive: true, force: true });
    throw error;
  }
}

async function startServer(): Promise<RunningServer> {
  const fixture = prepareServerFixture(serverBinary!);
  const child = NodeChildProcess.spawn(
    fixture.binary,
    ["serve", "--host", "127.0.0.1", "--port", "0", "--base-dir", fixture.dataRoot, "--no-browser"],
    { cwd: fixture.cwd, env: fixture.env },
  );
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let guardDenied = false;
  let stderrTail = "";
  child.stderr?.on("data", (chunk) => {
    const text = stderrTail + String(chunk);
    if (text.includes("hermetic-test-guard:")) guardDenied = true;
    stderrTail = text.slice(-256);
  });
  const server: RunningServer = {
    process: child,
    closed,
    dataRoot: fixture.dataRoot,
    httpBaseUrl: "",
    token: "",
    guardRefused: () => guardDenied,
  };
  try {
    const startup = await new Promise<{ httpBaseUrl: string; token: string }>((resolve, reject) => {
      const lines = NodeReadline.createInterface({ input: child.stdout! });
      const timer = setTimeout(() => {
        lines.close();
        reject(new Error("owned interop server did not report readiness"));
      }, 30_000);
      let ready = false;
      lines.on("line", (line) => {
        try {
          const parsed = JSON.parse(line) as { httpBaseUrl?: string; token?: string };
          if (parsed.httpBaseUrl && parsed.token) {
            const endpoint = new URL(parsed.httpBaseUrl);
            if (
              endpoint.protocol !== "http:" ||
              endpoint.hostname !== "127.0.0.1" ||
              endpoint.port === "3773"
            ) {
              clearTimeout(timer);
              lines.close();
              reject(new Error("owned server reported an unexpected endpoint"));
              return;
            }
            ready = true;
            clearTimeout(timer);
            lines.close();
            resolve({ httpBaseUrl: parsed.httpBaseUrl, token: parsed.token });
          }
        } catch {
          // Ignore non-JSON log lines.
        }
      });
      child.once("error", () => {
        clearTimeout(timer);
        lines.close();
        reject(new Error("owned interop server could not start"));
      });
      child.once("exit", (code) => {
        if (!ready) {
          clearTimeout(timer);
          lines.close();
          reject(
            new Error(
              `owned interop server exited early (${String(code)}); provider guard refused: ${guardDenied}`,
            ),
          );
        }
      });
    });
    child.stdout?.resume();
    return { ...server, ...startup };
  } catch (error) {
    await stopServer(server);
    throw error;
  }
}

async function stopServer(server: RunningServer, graceMs = 5_000): Promise<void> {
  const wait = async (timeout: number): Promise<boolean> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        server.closed.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeout);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  if (server.process.exitCode === null && server.process.signalCode === null)
    server.process.kill("SIGTERM");
  if (!(await wait(graceMs))) {
    server.process.kill("SIGKILL");
    if (!(await wait(5_000)))
      throw new Error("Owned interop server did not exit; its private fixture was retained.");
  }
  NodeFS.rmSync(server.dataRoot, { recursive: true, force: true });
}

function readHostPublicKey(dataRoot: string): Uint8Array {
  const record = NodeFS.readFileSync(
    NodePath.join(dataRoot, "userdata", "secrets", "host-identity-x25519.bin"),
  );
  expect(record.byteLength).toBe(64);
  return Uint8Array.from(record.subarray(32));
}

async function adminAccessToken(server: RunningServer): Promise<string> {
  if (server.adminAccessToken !== undefined) return server.adminAccessToken;
  const response = await fetch(`${server.httpBaseUrl}/oauth/token`, {
    signal: AbortSignal.timeout(10_000),
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: AuthTokenExchangeGrantType,
      subject_token: server.token,
      subject_token_type: AuthEnvironmentBootstrapTokenType,
      requested_token_type: AuthAccessTokenType,
    }),
  });
  const body = (await response.json()) as { access_token?: string };
  expect(response.ok).toBe(true);
  expect(typeof body.access_token === "string" && body.access_token.length > 0).toBe(true);
  server.adminAccessToken = body.access_token!;
  return body.access_token!;
}

async function mintedPairing(server: RunningServer): Promise<{
  payload: RemotePairingCodePayload;
  hostKey: Uint8Array;
}> {
  const response = await fetch(`${server.httpBaseUrl}/api/auth/pairing-offer`, {
    signal: AbortSignal.timeout(10_000),
    method: "POST",
    headers: {
      authorization: `Bearer ${await adminAccessToken(server)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: "Interop",
      // An off-host reach requires an off-host-classified endpoint; the test
      // channel still connects to the loopback server address.
      endpoint: "http://192.168.1.20:3773",
      reach: "another-device",
    }),
  });
  const offer = (await response.json()) as { code?: string };
  expect(response.ok).toBe(true);
  expect(typeof offer.code === "string" && offer.code.length > 0).toBe(true);
  const payload = parsePairingCode(offer.code!);
  const hostKey = decodeBase64UrlKey(payload.hostKey);
  expect(hostKey).toEqual(readHostPublicKey(server.dataRoot));
  return { payload, hostKey };
}

const liveChannels = new Set<EncryptedTestSocket>();
const openEncrypted = async (
  server: RunningServer,
  hostKey: Uint8Array,
): Promise<EncryptedTestSocket> => {
  const channel = await openEncryptedTestSocket(server.httpBaseUrl, hostKey);
  const owned = {
    ...channel,
    close: () => {
      liveChannels.delete(owned);
      channel.close();
    },
  };
  liveChannels.add(owned);
  return owned;
};

async function confirmedChannel(server: RunningServer): Promise<EncryptedTestSocket> {
  const { payload, hostKey } = await mintedPairing(server);
  const channel = await openEncrypted(server, hostKey);
  try {
    channel.sendMessage(JSON.stringify({ type: "e2ee_auth", pairing: payload.token }));
    const authenticated = JSON.parse(await channel.nextMessage()) as {
      type?: string;
      pairingConfirmationRequired?: boolean;
    };
    expect(authenticated.type === "e2ee_authenticated").toBe(true);
    if (authenticated.pairingConfirmationRequired) {
      const reply = (await requestTestRpc(channel, "1", "auth.confirmPairing")) as {
        exit?: { _tag?: string };
      };
      expect(reply.exit?._tag === "Success").toBe(true);
    }
    return channel;
  } catch (error) {
    channel.close();
    throw error;
  }
}

function finiteBytes(
  events: ReadonlyArray<ProjectDownloadEvent | AssetReadEvent>,
  initialOffset = 0,
): Buffer {
  expect(events[0]?._tag).toBe("start");
  expect(events.at(-1)?._tag).toBe("end");
  let offset = initialOffset;
  const chunks: Buffer[] = [];
  for (const event of events.slice(1, -1)) {
    if (event._tag !== "bytes") throw new Error("Expected only bytes between start and end");
    expect(event.offset).toBe(offset);
    const bytes = Buffer.from(event.data, "base64");
    expect(bytes.toString("base64")).toBe(event.data);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(bytes.byteLength).toBeLessThanOrEqual(1024 * 1024);
    offset += bytes.byteLength;
    chunks.push(bytes);
  }
  const end = events.at(-1);
  if (end?._tag === "end" && "totalBytes" in end) expect(end.totalBytes).toBe(offset);
  return Buffer.concat(chunks);
}

/** Reads the bounded fixture's central directory, including streamed ZIP data descriptors. */
function fixtureZipEntries(zip: Buffer): ReadonlyMap<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThanOrEqual(0);
  const count = zip.readUInt16LE(end + 10);
  let cursor = zip.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(cursor)).toBe(0x02014b50);
    const method = zip.readUInt16LE(cursor + 10);
    let compressedSize = zip.readUInt32LE(cursor + 20);
    let size = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    let local = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    let extra = cursor + 46 + nameLength;
    const extraEnd = extra + extraLength;
    while (extra + 4 <= extraEnd) {
      const tag = zip.readUInt16LE(extra);
      const length = zip.readUInt16LE(extra + 2);
      if (tag === 0x0001) {
        let field = extra + 4;
        const next = () => {
          const value = Number(zip.readBigUInt64LE(field));
          field += 8;
          expect(Number.isSafeInteger(value)).toBe(true);
          return value;
        };
        if (size === 0xffffffff) size = next();
        if (compressedSize === 0xffffffff) compressedSize = next();
        if (local === 0xffffffff) local = next();
      }
      extra += 4 + length;
    }
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    const data = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const compressed = zip.subarray(data, data + compressedSize);
    expect([0, 8]).toContain(method);
    const bytes = method === 0 ? compressed : NodeZlib.inflateRawSync(compressed);
    expect(bytes.byteLength).toBe(size);
    entries.set(name, bytes);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe("E2EE interop fixture isolation", () => {
  it("copies a guarded executable and pins every provider and HOME path to its private fixture", () => {
    const binaries = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "bibcode-interop-binary-test-"),
    );
    let fixture: ReturnType<typeof prepareServerFixture> | undefined;
    try {
      const binary = NodePath.join(binaries, "guarded-fixture");
      NodeFS.writeFileSync(binary, "hermetic-test-guard: refused fixture");
      fixture = prepareServerFixture(binary);
      expect(NodeFS.readFileSync(fixture.binary, "utf8")).toBe(
        "hermetic-test-guard: refused fixture",
      );
      expect(fixture.binary.startsWith(`${fixture.dataRoot}${NodePath.sep}`)).toBe(true);
      for (const name of [
        "HOME",
        "USERPROFILE",
        "CODEX_HOME",
        "CLAUDE_CONFIG_DIR",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "TMPDIR",
      ]) {
        expect(fixture.env[name]?.startsWith(fixture.dataRoot)).toBe(true);
      }
      expect(Object.keys(fixture.env)).not.toContain("OPENAI_API_KEY");
      expect(Object.keys(fixture.env)).not.toContain("ANTHROPIC_API_KEY");
      expect(fixture.env["BIBCODE_HERMETIC_GUARD"]).toBe("report");
      const settings = JSON.parse(
        NodeFS.readFileSync(NodePath.join(fixture.dataRoot, "userdata/settings.json"), "utf8"),
      ) as {
        enableProviderUpdateChecks: boolean;
        providers: Record<string, { enabled: boolean; binaryPath: string }>;
      };
      expect(settings.enableProviderUpdateChecks).toBe(false);
      expect(Object.keys(settings.providers).sort()).toEqual([
        "claudeAgent",
        "codex",
        "cursor",
        "grok",
        "opencode",
      ]);
      for (const provider of Object.values(settings.providers)) {
        expect(provider.enabled).toBe(false);
        expect(provider.binaryPath.startsWith(fixture.dataRoot)).toBe(true);
        expect(NodeFS.existsSync(provider.binaryPath)).toBe(false);
      }
    } finally {
      if (fixture) NodeFS.rmSync(fixture.dataRoot, { recursive: true, force: true });
      NodeFS.rmSync(binaries, { recursive: true, force: true });
    }
  });

  it("refuses an executable without the hermetic guard before spawning it", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-interop-unguarded-"));
    try {
      const binary = NodePath.join(root, "unguarded");
      NodeFS.writeFileSync(binary, "unguarded fixture");
      expect(() => prepareServerFixture(binary)).toThrow("hermetic-test-guard");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(hostPlatform === "win32")(
    "joins an owned TERM-ignoring process after KILL before deleting its fixture",
    async () => {
      const dataRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-interop-stop-"));
      const child = NodeChildProcess.spawn(
        process.execPath,
        ["-e", "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],
        { cwd: dataRoot },
      );
      let joined = false;
      const closed = new Promise<void>((resolve) =>
        child.once("close", () => {
          joined = true;
          resolve();
        }),
      );
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("owned stop fixture did not start")),
            5_000,
          );
          child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          child.stdout!.once("data", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        await stopServer({ process: child, closed, dataRoot, httpBaseUrl: "", token: "" }, 25);
        expect(joined).toBe(true);
        expect(child.signalCode).toBe("SIGKILL");
        expect(NodeFS.existsSync(dataRoot)).toBe(false);
      } finally {
        if (!joined) child.kill("SIGKILL");
        await closed;
        NodeFS.rmSync(dataRoot, { recursive: true, force: true });
      }
    },
    10_000,
  );
});

describe.skipIf(serverBinary === undefined)(
  "TypeScript initiator against the Rust responder",
  () => {
    let server: RunningServer;

    beforeAll(async () => {
      server = await startServer();
      if (reportPath)
        NodeFS.writeFileSync(
          reportPath,
          JSON.stringify({
            event: "started",
            pid: server.process.pid,
            httpBaseUrl: server.httpBaseUrl,
            dataRoot: server.dataRoot,
            copiedGuardedBinary: true,
          }) + "\n",
        );
    }, 60_000);

    afterAll(async () => {
      for (const channel of liveChannels) channel.close();
      if (server !== undefined) {
        await stopServer(server);
        if (reportPath)
          NodeFS.appendFileSync(
            reportPath,
            JSON.stringify({
              event: "closed",
              pid: server.process.pid,
              exitCode: server.process.exitCode,
              signalCode: server.process.signalCode,
              fixtureRemoved: !NodeFS.existsSync(server.dataRoot),
              guardRefused: server.guardRefused?.() ?? false,
            }) + "\n",
          );
        expect(server.guardRefused?.()).toBe(false);
      }
    }, 15_000);

    it("reads exact full, resumed, empty and ZIP downloads over the encrypted stream", async () => {
      const channel = await confirmedChannel(server);
      const cwd = NodePath.join(server.dataRoot, "download-fixture");
      NodeFS.mkdirSync(NodePath.join(cwd, "bundle", "nested"), { recursive: true });
      const expected = Buffer.from(
        Uint8Array.from({ length: 1024 * 1024 + 1234 }, (_, index) => index % 251),
      );
      NodeFS.writeFileSync(NodePath.join(cwd, "bytes.bin"), expected);
      NodeFS.writeFileSync(NodePath.join(cwd, "empty.txt"), "");
      NodeFS.writeFileSync(NodePath.join(cwd, "bundle", "a.txt"), "archive-a");
      NodeFS.writeFileSync(NodePath.join(cwd, "bundle", "nested", "b.txt"), "archive-b");
      try {
        const full = await streamTestRpc(
          channel,
          "2",
          "projects.readDownload",
          { cwd, relativePath: "bytes.bin" },
          decodeDownloadEvent,
        );
        expect(finiteBytes(full).equals(expected)).toBe(true);
        const start = full[0];
        if (start?._tag !== "start" || start.version === null)
          throw new Error("Expected a resumable file start");
        expect(start).toMatchObject({
          kind: "file",
          fileName: "bytes.bin",
          sizeBytes: expected.byteLength,
        });
        const offset = 71_357;
        const resumed = await streamTestRpc(
          channel,
          "3",
          "projects.readDownload",
          { cwd, relativePath: "bytes.bin", offset, expect: start.version },
          decodeDownloadEvent,
        );
        expect(finiteBytes(resumed, offset).equals(expected.subarray(offset))).toBe(true);
        expect(resumed[0]).toEqual(start);
        const empty = await streamTestRpc(
          channel,
          "4",
          "projects.readDownload",
          { cwd, relativePath: "empty.txt" },
          decodeDownloadEvent,
        );
        expect(finiteBytes(empty).byteLength).toBe(0);
        expect(empty).toHaveLength(2);
        const archive = await streamTestRpc(
          channel,
          "5",
          "projects.readDownload",
          { cwd, relativePath: "bundle" },
          decodeDownloadEvent,
        );
        expect(archive[0]).toMatchObject({
          kind: "archive",
          fileName: "bundle.zip",
          sizeBytes: null,
          version: null,
        });
        const entries = fixtureZipEntries(finiteBytes(archive));
        expect(entries.get("a.txt")?.toString("utf8")).toBe("archive-a");
        expect(entries.get("nested/b.txt")?.toString("utf8")).toBe("archive-b");
      } finally {
        channel.close();
      }
    }, 30_000);

    it("reads exact SVG favicon bytes and MIME without an HTTP asset capability", async () => {
      const channel = await confirmedChannel(server);
      const cwd = NodePath.join(server.dataRoot, "asset-fixture");
      NodeFS.mkdirSync(cwd, { recursive: true });
      const expected = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><path d="M0 0h1v1H0z"/></svg>',
      );
      NodeFS.writeFileSync(NodePath.join(cwd, "favicon.svg"), expected);
      try {
        const events = await streamTestRpc(
          channel,
          "2",
          "assets.read",
          { resource: { _tag: "project-favicon", cwd } },
          decodeAssetEvent,
        );
        expect(events[0]).toEqual({
          _tag: "start",
          mimeType: "image/svg+xml",
          sizeBytes: expected.byteLength,
        });
        expect(finiteBytes(events).equals(expected)).toBe(true);
      } finally {
        channel.close();
      }
    }, 30_000);

    it.effect(
      "keeps production capability false and refuses the pinned client operation before bytes or HTTP mint",
      () =>
        Effect.gen(function* () {
          const channel = yield* Effect.acquireRelease(
            Effect.promise(() => confirmedChannel(server)),
            (value) => Effect.sync(value.close),
          );
          const reply = yield* Effect.promise(() =>
            requestTestRpc(channel, "2", "server.getConfig"),
          );
          const result = reply as { exit: { _tag: string; value: unknown } };
          expect(result.exit._tag).toBe("Success");
          const config = decodeConfig(result.exit.value);
          expect(config.environment.capabilities.inChannelTransfers).toBe(false);
          const environmentId = EnvironmentId.make("owned-interop");
          const target = new PrimaryConnectionTarget({
            environmentId,
            label: "Owned interop",
            httpBaseUrl: server.httpBaseUrl,
            wsBaseUrl: server.httpBaseUrl.replace(/^http/, "ws"),
          });
          let rpcCalls = 0;
          let sinkCalls = 0;
          const forbidden = () => {
            rpcCalls += 1;
            throw new Error("Unavailable route attempted file RPC");
          };
          const session: RpcSession = {
            client: {
              "projects.readDownload": forbidden,
              "projects.createDownloadUrl": forbidden,
            } as unknown as RpcSession["client"],
            initialConfig: Effect.succeed(config),
            ready: Effect.void,
            probe: Effect.void,
            closed: Effect.never,
            e2eeAuthenticated: Effect.succeed(null),
          };
          const prepared: PreparedConnection = {
            target,
            environmentId,
            label: target.label,
            descriptor: config.environment,
            httpBaseUrl: server.httpBaseUrl,
            socketUrl: `${target.wsBaseUrl}/ws-e2ee`,
            httpAuthorization: null,
            e2ee: {
              hostKey: Buffer.from(readHostPublicKey(server.dataRoot)).toString("base64url"),
              auth: { kind: "bearer", credential: "never-used-fixture" },
            },
          };
          const supervisor = EnvironmentSupervisor.of({
            target,
            state: yield* SubscriptionRef.make<SupervisorConnectionState>({
              ...AVAILABLE_CONNECTION_STATE,
              desired: true,
              phase: "connected" as const,
            }),
            session: yield* SubscriptionRef.make(Option.some(session)),
            prepared: yield* SubscriptionRef.make(Option.some(prepared)),
            connect: Effect.void,
            disconnect: Effect.void,
            retryNow: Effect.void,
          });
          const lifetime = {};
          const registry: Pick<
            EnvironmentRegistry["Service"],
            "entries" | "registrationLifetime" | "run" | "followStream"
          > = {
            entries: yield* SubscriptionRef.make<
              ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>
            >(new Map([[environmentId, { target, profile: Option.none() }]])),
            registrationLifetime: () => Effect.succeed(lifetime),
            run: (_id, operation) =>
              Effect.provideService(operation, EnvironmentSupervisor, supervisor),
            followStream: () => {
              throw new Error("Unavailable route attempted a stream follower");
            },
          };
          const touchedSink = () =>
            Effect.sync(() => {
              sinkCalls += 1;
            });
          const exit = yield* downloadFile({
            cwd: server.dataRoot,
            relativePath: "never-read",
            sink: {
              start: touchedSink,
              write: touchedSink,
              reset: touchedSink,
              finish: touchedSink,
              abort: () => Effect.void,
            },
          }).pipe(
            Effect.provideService(EnvironmentRegistry, registry as EnvironmentRegistry["Service"]),
            Effect.provideService(EnvironmentSupervisor, supervisor),
            Effect.exit,
          );
          expect(exit).toMatchObject({
            _tag: "Failure",
            cause: {
              reasons: [{ error: { _tag: "FileTransferClientError", reason: "unavailable" } }],
            },
          });
          expect(rpcCalls).toBe(0);
          expect(sinkCalls).toBe(0);
        }),
      30_000,
    );

    it("mints, pairs in-channel, round-trips RPC, and reconnects with the minted bearer", async () => {
      const { payload, hostKey } = await mintedPairing(server);
      const channel = await openEncrypted(server, hostKey);
      // No confirmation flag is sent: the server decides delivery from the
      // grant, and the reply's pairingConfirmationRequired is the client's
      // only signal. Servers that predate the confirmation flow omit the
      // field and deliver immediately, so this suite gates both generations.
      channel.sendMessage(
        JSON.stringify({
          type: "e2ee_auth",
          pairing: payload.token,
        }),
      );
      const authenticated = JSON.parse(await channel.nextMessage()) as {
        type: string;
        credential?: string;
        storageInstanceId?: string;
        pairingConfirmationRequired?: boolean;
      };
      expect(authenticated.type).toBe("e2ee_authenticated");
      expect(
        typeof authenticated.credential === "string" && authenticated.credential.length > 0,
      ).toBe(true);
      expect(authenticated.storageInstanceId).toBe(payload.storageInstanceId);

      let nextRequestId = 1;
      if (authenticated.pairingConfirmationRequired === true) {
        const pending = await openEncrypted(server, hostKey);
        pending.sendMessage(
          JSON.stringify({ type: "e2ee_auth", bearer: authenticated.credential }),
        );
        const pendingResult = JSON.parse(await pending.nextMessage()) as {
          type?: string;
          code?: string;
        };
        expect(pendingResult.type === "e2ee_error" && pendingResult.code === "unauthorized").toBe(
          true,
        );
        pending.close();

        expect(
          await requestTestRpc(channel, String(nextRequestId), "auth.confirmPairing"),
        ).toMatchObject({
          _tag: "Exit",
          requestId: String(nextRequestId),
          exit: { _tag: "Success", value: {} },
        });
        nextRequestId += 1;
      }
      expect(
        await requestTestRpc(channel, String(nextRequestId), "server.getConfig"),
      ).toMatchObject({
        _tag: "Exit",
        requestId: String(nextRequestId),
      });
      channel.close();

      const second = await openEncrypted(server, hostKey);
      second.sendMessage(JSON.stringify({ type: "e2ee_auth", bearer: authenticated.credential }));
      expect(
        (JSON.parse(await second.nextMessage()) as { type?: string }).type === "e2ee_authenticated",
      ).toBe(true);
      second.close();
    }, 30_000);

    it("delivers ordered native PTY input over E2EE and rejects another socket's lease", async () => {
      const { payload, hostKey } = await mintedPairing(server);
      const channel = await openEncrypted(server, hostKey);
      let nextRequestId = 1;
      const nextId = () => String(nextRequestId++);
      const scope = { threadId: "interop-ordered-input", terminalId: "term-ordered" };
      const cwd = NodePath.join(server.dataRoot, "ordered-input-fixture");
      NodeFS.mkdirSync(cwd, { recursive: true });
      let opened = false;
      try {
        channel.sendMessage(JSON.stringify({ type: "e2ee_auth", pairing: payload.token }));
        const authenticated = JSON.parse(await channel.nextMessage()) as {
          type: string;
          credential: string;
          pairingConfirmationRequired?: boolean;
        };
        expect(authenticated.type).toBe("e2ee_authenticated");
        if (authenticated.pairingConfirmationRequired) {
          expect(await requestTestRpc(channel, nextId(), "auth.confirmPairing")).toMatchObject({
            exit: { _tag: "Success" },
          });
        }
        const config = (await requestTestRpc(channel, nextId(), "server.getConfig")) as {
          exit: { value: { environment: { platform: { os: string } } } };
        };
        expect(config).toMatchObject({
          exit: {
            _tag: "Success",
            value: { environment: { capabilities: { terminalOrderedInput: true } } },
          },
        });
        const isWindows = config.exit.value.environment.platform.os === "windows";
        const command = isWindows
          ? { executable: "cmd.exe", args: ["/D", "/Q", "/K"] }
          : { executable: "/bin/sh", args: ["-s"] };
        expect(
          await requestTestRpc(channel, nextId(), "terminal.open", {
            ...scope,
            cwd,
            cols: 80,
            rows: 24,
            command,
          }),
        ).toMatchObject({ exit: { _tag: "Success" } });
        opened = true;
        const begun = (await requestTestRpc(channel, nextId(), "terminal.beginInput", {
          ...scope,
          attachmentSequence: 0,
        })) as { exit: { _tag: string; value: { inputId: string } } };
        expect(begun.exit._tag).toBe("Success");
        const inputId = begun.exit.value.inputId;
        const frames = ["echo ordered-", "input-ok > ordered-input.txt", isWindows ? "\r" : "\n"];
        const expected = new Map<string, number>();
        for (const sequence of [2, 1, 0]) {
          const id = nextId();
          expected.set(id, sequence);
          channel.sendMessage(
            JSON.stringify({
              _tag: "Request",
              id,
              tag: "terminal.writeInput",
              payload: { ...scope, inputId, sequence, data: frames[sequence] },
              headers: [],
            }),
          );
        }
        for (let index = 0; index < frames.length; index++) {
          const response = JSON.parse(await channel.nextMessage()) as { requestId: string };
          expect(response).toMatchObject({
            _tag: "Exit",
            exit: {
              _tag: "Success",
              value: { inputId, sequence: expected.get(response.requestId) },
            },
          });
          expect(expected.delete(response.requestId)).toBe(true);
        }
        expect(expected.size).toBe(0);
        const output = NodePath.join(cwd, "ordered-input.txt");
        await expect
          .poll(
            () => (NodeFS.existsSync(output) ? NodeFS.readFileSync(output, "utf8").trim() : ""),
            { timeout: 5_000 },
          )
          .toBe("ordered-input-ok");
        const other = await openEncrypted(server, hostKey);
        try {
          other.sendMessage(
            JSON.stringify({ type: "e2ee_auth", bearer: authenticated.credential }),
          );
          expect(
            (JSON.parse(await other.nextMessage()) as { type?: string }).type ===
              "e2ee_authenticated",
          ).toBe(true);
          expect(
            await requestTestRpc(other, "1", "terminal.writeInput", {
              ...scope,
              inputId,
              sequence: 3,
              data: "foreign\n",
            }),
          ).toMatchObject({
            exit: {
              _tag: "Failure",
              cause: [{ _tag: "Fail", error: { _tag: "TerminalInputError", code: "closed" } }],
            },
          });
        } finally {
          other.close();
        }
      } finally {
        if (opened)
          await requestTestRpc(channel, nextId(), "terminal.close", scope).catch(() => undefined);
        channel.close();
      }
    }, 30_000);

    it("reassembles a fragmented client message across the language boundary", async () => {
      const { payload, hostKey } = await mintedPairing(server);
      const channel = await openEncrypted(server, hostKey);
      channel.sendMessage(JSON.stringify({ type: "e2ee_auth", pairing: payload.token }));
      await channel.nextMessage();
      expect(
        await requestTestRpc(channel, "2", "server.getConfig", {
          ignored: "x".repeat(200_000),
        }),
      ).toMatchObject({ requestId: "2" });
      channel.close();
    }, 30_000);

    it("rejects a bad pairing token inside the encrypted channel", async () => {
      const { hostKey } = await mintedPairing(server);
      const channel = await openEncrypted(server, hostKey);
      channel.sendMessage(JSON.stringify({ type: "e2ee_auth", pairing: "bogus" }));
      const rejected = JSON.parse(await channel.nextMessage()) as { type?: string; code?: string };
      expect(rejected.type === "e2ee_error" && rejected.code === "unauthorized").toBe(true);
      channel.close();
    }, 30_000);
  },
);
