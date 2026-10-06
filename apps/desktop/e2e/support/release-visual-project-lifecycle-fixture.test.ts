// @effect-diagnostics nodeBuiltinImport:off - Git tooling uses only new private TempGit roots.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { HostProcessPlatform } from "../../../../packages/shared/src/hostProcess.ts";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  prepareProjectLifecycleFixture,
  createLifecycleProcessProof,
  readLifecycleProcessRecord,
} from "./release-visual-project-lifecycle-fixture.ts";
import { bounded, delay } from "./qualification-owner.ts";

const roots: string[] = [];
const Effect = NodeModule.createRequire(
  new URL("../../../../packages/shared/package.json", import.meta.url),
)("effect/Effect");
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});
function setup() {
  const hostPlatform = Effect.runSync(HostProcessPlatform) as NodeJS.Platform;
  const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bc-life-")));
  roots.push(root);
  const home = NodePath.join(root, "home");
  const primary = NodePath.join(root, "primary");
  NodeFS.mkdirSync(home, { mode: 0o700 });
  NodeFS.mkdirSync(primary, { mode: 0o700 });
  const source = "a".repeat(40);
  const git = vi.fn(
    async (cwd: string, args: readonly string[], environment: NodeJS.ProcessEnv) => {
      const result = NodeChildProcess.spawnSync("git", [...args], {
        cwd,
        env: {
          ...process.env,
          HOME: home,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: NodePath.join(root, "empty-config"),
          GIT_CONFIG_COUNT: "0",
          GIT_TEST_ASSUME_DIFFERENT_OWNER: "0",
          ...environment,
          GIT_AUTHOR_NAME: "Owned fixture",
          GIT_AUTHOR_EMAIL: "owned@example.invalid",
          GIT_COMMITTER_NAME: "Owned fixture",
          GIT_COMMITTER_EMAIL: "owned@example.invalid",
        },
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      if (result.error) throw new Error("Owned Git tooling failed.");
      return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
    },
  );
  const admitOwner = vi.fn(async () => {});
  return {
    input: {
      root,
      home,
      primaryCheckout: primary,
      anchorCheckouts: [primary],
      source,
      theme: "light" as const,
      hostPlatform,
      nodeExecutable: NodeFS.realpathSync(process.execPath),
      gitExecutable: NodeFS.realpathSync("/usr/bin/git"),
      admitOwner,
      git,
    },
    root,
    primary,
    home,
    git,
    admitOwner,
  };
}

it("creates only owned exact exemptions, a file transport rewrite and a protected real-pack hook", async () => {
  const { input, admitOwner } = setup();
  const fixture = await prepareProjectLifecycleFixture(input);
  expect(admitOwner).toHaveBeenCalled();
  expect(fixture.cloneUrl).toBe("https://visual.invalid/lifecycle-origin.git");
  expect(fixture.cloneParent).toContain(input.root);
  expect(fixture.serverGitEnvironment.GIT_TEST_ASSUME_DIFFERENT_OWNER).toBe("1");
  await fixture.verifyCloneConfiguration();
  const config = NodeFS.readFileSync(fixture.gitConfig, "utf8");
  expect(config).toContain("file://");
  expect(config).toContain("packObjectsHook");
  expect(config).not.toMatch(/directory\s*=\s*\*/);
  expect(NodeFS.statSync(fixture.gitConfig).mode & 0o777).toBe(0o600);
});

it("removes and restores only the owned target exemption and proves actual Git ownership refusal", async () => {
  const { input, git } = setup();
  const fixture = await prepareProjectLifecycleFixture(input);
  const original = NodeFS.readFileSync(fixture.gitConfig);
  await fixture.setTargetTrust(fixture.trustCheckout, false);
  await fixture.verifyTrustRefusal();
  const denied = await git(
    fixture.trustCheckout,
    ["status", "--porcelain"],
    fixture.serverGitEnvironment,
  );
  expect(denied.status).not.toBe(0);
  expect(denied.stderr).toContain("detected dubious ownership");
  await fixture.setTargetTrust(fixture.trustCheckout, true);
  expect(NodeFS.readFileSync(fixture.gitConfig)).toEqual(original);
  const readable = await git(
    fixture.trustCheckout,
    ["status", "--porcelain"],
    fixture.serverGitEnvironment,
  );
  expect(readable.status).toBe(0);
});

it("refuses primary, foreign and alias targets before changing private policy", async () => {
  const { input, primary, root } = setup();
  const fixture = await prepareProjectLifecycleFixture(input);
  const original = NodeFS.readFileSync(fixture.gitConfig);
  const alias = NodePath.join(root, "alias");
  NodeFS.symlinkSync(fixture.trustCheckout, alias);
  for (const target of [primary, homeParent(root), alias]) {
    await expect(fixture.setTargetTrust(target, false)).rejects.toThrow();
    expect(NodeFS.readFileSync(fixture.gitConfig)).toEqual(original);
  }
});
function homeParent(root: string) {
  return NodePath.dirname(root);
}

it("refuses an owner failure, foreign anchors and preexisting fixture before Git work", async () => {
  const denied = setup();
  denied.input.admitOwner.mockRejectedValue(new Error("Inert admission refusal."));
  await expect(prepareProjectLifecycleFixture(denied.input)).rejects.toThrow();
  expect(denied.git).not.toHaveBeenCalled();
  const foreign = setup();
  await expect(
    prepareProjectLifecycleFixture({
      ...foreign.input,
      anchorCheckouts: [NodePath.dirname(foreign.root)],
    }),
  ).rejects.toThrow();
  expect(foreign.git).not.toHaveBeenCalled();
  const existing = setup();
  NodeFS.mkdirSync(NodePath.join(existing.root, "visual-project-lifecycle"));
  await expect(prepareProjectLifecycleFixture(existing.input)).rejects.toThrow();
  expect(existing.git).not.toHaveBeenCalled();
});

it("refuses missing/replaced hook configuration rather than manufacturing a transfer marker", async () => {
  const { input } = setup();
  const fixture = await prepareProjectLifecycleFixture(input);
  const config = NodeFS.readFileSync(fixture.gitConfig, "utf8");
  NodeFS.writeFileSync(fixture.gitConfig, config.replace(/\s*packObjectsHook[^\n]*\n/, "\n"));
  await expect(fixture.verifyCloneConfiguration()).rejects.toThrow();
  await expect(fixture.readHeldTransfer()).rejects.toThrow();
});

it("holds an actual file transport then delegates unchanged Git pack bytes and cloned input", async () => {
  const { input } = setup();
  const fixture = await prepareProjectLifecycleFixture(input);
  const child = NodeChildProcess.spawn(
    input.gitExecutable,
    [
      "clone",
      "--progress",
      fixture.cloneUrl,
      NodePath.join(fixture.cloneParent, "lifecycle-origin"),
    ],
    {
      cwd: fixture.cloneParent,
      env: { ...process.env, ...fixture.serverGitEnvironment },
      detached: input.hostPlatform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.resume();
  child.stderr.resume();
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  try {
    let proof: Awaited<ReturnType<typeof fixture.readHeldTransfer>> | undefined;
    for (let i = 0; i < 200 && proof === undefined; i++) {
      try {
        proof = await fixture.readHeldTransfer();
      } catch {
        if (child.exitCode !== null) break;
        await delay(25);
      }
    }
    expect(proof?.phase).toBe("real-pack-held");
    expect(proof?.forwardedBytes).toBe(4096);
    expect(proof?.totalBytes).toBeGreaterThan(4096);
    expect(proof?.delegateReaped).toBe(true);
    expect(child.exitCode).toBeNull();
    await fixture.releaseHeldTransfer();
    expect(await closed).toBe(0);
    const pack = NodeFS.readdirSync(
      NodePath.join(fixture.cloneParent, "lifecycle-origin", ".git", "objects", "pack"),
    ).find((file) => file.endsWith(".pack"))!;
    const raw = NodeFS.readFileSync(
      NodePath.join(fixture.cloneParent, "lifecycle-origin", ".git", "objects", "pack", pack),
    );
    expect(NodeCrypto.createHash("sha256").update(raw).digest("hex")).toBe(proof!.packSha256);
    expect(
      NodeFS.readFileSync(
        NodePath.join(fixture.cloneParent, "lifecycle-origin", "owned-transfer.bin"),
      ),
    ).toEqual(NodeFS.readFileSync(NodePath.join(fixture.root, "seed", "owned-transfer.bin")));
  } finally {
    if (child.exitCode === null && child.pid !== undefined) {
      if (input.hostPlatform === "win32") child.kill("SIGTERM");
      else process.kill(-child.pid, "SIGTERM");
    }
    await closed;
  }
}, 15_000);

it("requires the held actor to belong to the actual owned server and to be absent after joined cancel", async () => {
  const { input } = setup();
  let actor: { parent: number; uid: number; state: string; args: readonly string[] } | null = null;
  const readProcess = vi.fn((pid: number) =>
    pid === 31
      ? actor
      : pid === 42
        ? { parent: 1, uid: NodeFS.statSync(input.root).uid, state: "S", args: ["owned-server"] }
        : null,
  );
  const fixture = await prepareProjectLifecycleFixture({ ...input, readProcess });
  const manifestPath = NodePath.join(fixture.root, "owned-pack-manifest.json");
  const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
  NodeFS.writeFileSync(
    NodePath.join(fixture.root, "held-pack.json"),
    JSON.stringify({
      source: input.source,
      nonce: manifest.nonce,
      actorPid: 31,
      phase: "real-pack-held",
      forwardedBytes: 4096,
      totalBytes: 5000,
      packSha256: "b".repeat(64),
      delegateReaped: true,
    }),
    { mode: 0o600 },
  );
  actor = {
    parent: 42,
    uid: NodeFS.statSync(fixture.root).uid,
    state: "S",
    args: [input.nodeExecutable, manifest.script, manifestPath],
  };
  await expect(fixture.verifyHeldTransferOwner(42)).resolves.toMatchObject({
    phase: "real-pack-held",
  });
  await expect(fixture.verifyHeldTransferOwner(99)).rejects.toThrow();
  actor = { ...actor, state: "Z" };
  await expect(fixture.verifyHeldTransferOwner(42)).rejects.toThrow();
  await expect(fixture.verifyHeldTransferReaped()).rejects.toThrow();
  actor = null;
  await expect(fixture.verifyHeldTransferReaped()).resolves.toBeUndefined();
  NodeFS.mkdirSync(NodePath.join(fixture.cloneParent, "lifecycle-origin"));
  await expect(fixture.verifyHeldTransferReaped()).rejects.toThrow();
});

it("retains exact protected inputs/origin and restores only the owned trust policy", async () => {
  const { input } = setup(),
    fixture = await prepareProjectLifecycleFixture(input);
  await fixture.verifyInputsRetained();
  await fixture.setTargetTrust(fixture.trustCheckout, false);
  await expect(fixture.verifyInputsRetained()).rejects.toThrow();
  await fixture.setTargetTrust(fixture.trustCheckout, true);
  await fixture.verifyInputsRetained();
  const config = NodePath.join(fixture.origin, "config");
  NodeFS.appendFileSync(config, "\n# foreign mutation\n");
  await expect(fixture.verifyInputsRetained()).rejects.toThrow();
});

it("refuses a missing/zombie/foreign server and a noncanonical held actor executable", async () => {
  const { input } = setup();
  let server: { parent: number; uid: number; state: string; args: readonly string[] } | null = null;
  let actor: { parent: number; uid: number; state: string; args: readonly string[] } | null = null;
  const fixture = await prepareProjectLifecycleFixture({
    ...input,
    readProcess: (pid) => (pid === 31 ? actor : pid === 42 ? server : null),
  });
  const manifestPath = NodePath.join(fixture.root, "owned-pack-manifest.json"),
    manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
  NodeFS.writeFileSync(
    NodePath.join(fixture.root, "held-pack.json"),
    JSON.stringify({
      source: input.source,
      nonce: manifest.nonce,
      actorPid: 31,
      phase: "real-pack-held",
      forwardedBytes: 4096,
      totalBytes: 5000,
      packSha256: "b".repeat(64),
      delegateReaped: true,
    }),
    { mode: 0o600 },
  );
  const uid = NodeFS.statSync(fixture.root).uid;
  actor = {
    parent: 42,
    uid,
    state: "S",
    args: [input.nodeExecutable, manifest.script, manifestPath],
  };
  await expect(fixture.verifyHeldTransferOwner(42)).rejects.toThrow();
  server = { parent: 1, uid, state: "Z", args: ["owned-server"] };
  await expect(fixture.verifyHeldTransferOwner(42)).rejects.toThrow();
  server = { ...server, state: "S", uid: uid + 1 };
  await expect(fixture.verifyHeldTransferOwner(42)).rejects.toThrow();
  server = { ...server, uid };
  actor = { ...actor, args: ["/foreign/executable", manifest.script, manifestPath] };
  await expect(fixture.verifyHeldTransferOwner(42)).rejects.toThrow();
  actor = { ...actor, args: [input.nodeExecutable, manifest.script, manifestPath] };
  await expect(fixture.verifyHeldTransferOwner(42)).resolves.toMatchObject({
    phase: "real-pack-held",
  });
});

it("cancels and joins the owned real Git transfer while the unchanged pack gate is held", async () => {
  const { input } = setup(),
    fixture = await prepareProjectLifecycleFixture(input);
  const child = NodeChildProcess.spawn(
    input.gitExecutable,
    ["clone", "--", fixture.cloneUrl, NodePath.join(fixture.cloneParent, "lifecycle-origin")],
    {
      cwd: fixture.root,
      env: {
        ...process.env,
        ...fixture.serverGitEnvironment,
        GIT_TEST_ASSUME_DIFFERENT_OWNER: "0",
      },
      detached: input.hostPlatform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.resume();
  child.stderr.resume();
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  let killed = false;
  try {
    let held = false;
    for (let i = 0; i < 200 && !held; i++) {
      try {
        await fixture.readHeldTransfer();
        held = true;
      } catch {
        if (child.exitCode !== null) break;
        await delay(25);
      }
    }
    expect(held).toBe(true);
    expect(child.exitCode).toBeNull();
    if (child.pid === undefined) throw new Error("Owned transfer unavailable.");
    if (input.hostPlatform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
    killed = true;
    await bounded(closed, 5000);
    if (input.hostPlatform !== "win32") {
      await bounded(
        (async () => {
          for (let i = 0; i < 100; i++) {
            try {
              process.kill(-child.pid!, 0);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
              throw error;
            }
            await delay(25);
          }
          throw new Error("Owned transfer group did not join.");
        })(),
        5000,
      );
    }
    await fixture.verifyInputsRetained();
  } finally {
    if (!killed && child.exitCode === null && child.pid !== undefined) {
      if (input.hostPlatform === "win32") child.kill("SIGTERM");
      else process.kill(-child.pid, "SIGTERM");
    }
    await bounded(closed, 5000);
  }
}, 15000);

it("admits only the exact configured-base future managed anchor while leaving its reserved destination absent", async () => {
  const initial = setup(),
    base = NodePath.join(initial.root, "managed-worktrees"),
    parent = NodePath.join(base, NodePath.basename(initial.primary));
  NodeFS.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const plannedManagedCheckout = NodePath.join(parent, "codex-delivery-retry-light"),
    input = { ...initial.input, plannedManagedCheckout },
    fixture = await prepareProjectLifecycleFixture(input);
  expect(NodeFS.existsSync(plannedManagedCheckout)).toBe(false);
  const config = NodeFS.readFileSync(fixture.gitConfig, "utf8");
  expect(config.split(plannedManagedCheckout)).toHaveLength(2);
  await fixture.setTargetTrust(fixture.trustCheckout, false);
  expect(NodeFS.readFileSync(fixture.gitConfig, "utf8")).toContain(plannedManagedCheckout);
  await fixture.setTargetTrust(fixture.trustCheckout, true);
  await fixture.verifyInputsRetained();
});

it.each(["foreign", "dot-escape", "wrong-theme", "preexisting", "symlink-parent"])(
  "refuses a %s planned managed anchor before Git or public worktree creation",
  async (mode) => {
    const initial = setup(),
      base = NodePath.join(initial.root, "managed-worktrees"),
      parent = NodePath.join(base, NodePath.basename(initial.primary));
    NodeFS.mkdirSync(parent, { recursive: true, mode: 0o700 });
    let plannedManagedCheckout = NodePath.join(parent, "codex-delivery-retry-light");
    if (mode === "foreign") plannedManagedCheckout = NodePath.join(initial.home, "foreign");
    if (mode === "dot-escape")
      plannedManagedCheckout = parent + "/../primary/codex-delivery-retry-light";
    if (mode === "wrong-theme")
      plannedManagedCheckout = NodePath.join(parent, "codex-delivery-retry-dark");
    if (mode === "preexisting") NodeFS.mkdirSync(plannedManagedCheckout);
    if (mode === "symlink-parent") {
      NodeFS.rmdirSync(parent);
      NodeFS.symlinkSync(initial.home, parent);
    }
    const input = { ...initial.input, plannedManagedCheckout };
    await expect(prepareProjectLifecycleFixture(input)).rejects.toThrow();
    expect(initial.git).not.toHaveBeenCalled();
    expect(NodeFS.existsSync(NodePath.join(initial.root, "visual-project-lifecycle"))).toBe(false);
  },
);

it("proves exact protected target denial and unchanged inputs without a forced-ownership command", async () => {
  const { input, git } = setup(),
    fixture = await prepareProjectLifecycleFixture(input);
  expect(fixture.verifyTargetExemptionRemoved).toBeTypeOf("function");
  await expect(fixture.verifyTargetExemptionRemoved()).rejects.toThrow();
  await fixture.setTargetTrust(fixture.trustCheckout, false);
  git.mockClear();
  await fixture.verifyTargetExemptionRemoved();
  expect(git).not.toHaveBeenCalled();
  const head = NodePath.join(fixture.trustCheckout, ".git", "HEAD"),
    original = NodeFS.readFileSync(head);
  NodeFS.writeFileSync(head, "ref: refs/heads/foreign\n");
  await expect(fixture.verifyTargetExemptionRemoved()).rejects.toThrow();
  NodeFS.writeFileSync(head, original);
  await fixture.setTargetTrust(fixture.trustCheckout, true);
  await fixture.verifyInputsRetained();
});

function processProofFixture() {
  const namespace = { net: "net:[2]", pid: "pid:[3]", user: "user:[4]" },
    server = {
      pid: 42,
      parent: 1,
      uid: 1001,
      state: "S",
      started: "11",
      executable: "/owned/server",
      cwd: "/owned/repo",
      args: ["/owned/server", "serve"],
      namespaces: namespace,
    },
    provider = {
      pid: 57,
      parent: 42,
      uid: 1001,
      state: "S",
      started: "12",
      executable: "/owned/node",
      cwd: "/owned/managed",
      args: [
        "/owned/node",
        "/owned/shims/codex-fixture.mjs",
        "-c",
        "mcp_servers.bibcode.url=http://127.0.0.1:4885/mcp",
        "-c",
        'mcp_servers.bibcode.bearer_token_env_var="BIBCODE_MCP_BEARER_TOKEN"',
        "app-server",
      ],
      namespaces: namespace,
    };
  const records = new Map([
    [42, server],
    [57, provider],
  ]);
  const input = {
    CI: "true",
    uid: 1001,
    serverPid: 42,
    serverExecutable: server.executable,
    serverArgs: server.args,
    serverCwd: server.cwd,
    namespace,
    providerNode: provider.executable,
    providerScript: provider.args[1]!,
    providerCwd: provider.cwd,
    read: (pid: number) => records.get(pid) ?? null,
    pids: () => [...records.keys()],
  };
  return { input, records, server, provider };
}
it("joins the actual server and unique maintained provider by argv/cwd/namespace/uid/start identity and requires reaping", async () => {
  const f = processProofFixture(),
    owner = createLifecycleProcessProof(f.input);
  owner.verifyServerOwned();
  owner.verifyProviderLive("owned-native-turn");
  expect(() => owner.verifyProviderReaped()).toThrow();
  f.records.delete(57);
  owner.verifyProviderReaped();
});
it.each([
  "foreign-parent",
  "foreign-uid",
  "foreign-namespace",
  "wrong-argv",
  "wrong-cwd",
  "zombie",
  "reused",
  "duplicate",
  "foreign-mcp",
  "unexpected-listen",
])("refuses a %s provider without accepting another actor or weakening reaping", (mode) => {
  const f = processProofFixture(),
    owner = createLifecycleProcessProof(f.input);
  owner.verifyProviderLive("owned-native-turn");
  if (mode === "foreign-parent") f.provider.parent = 99;
  if (mode === "foreign-uid") f.provider.uid = 1002;
  if (mode === "foreign-namespace")
    f.provider.namespaces = { ...f.provider.namespaces, net: "net:[99]" };
  if (mode === "wrong-argv") f.provider.args = ["/owned/node", "/owned/foreign.mjs", "app-server"];
  if (mode === "wrong-cwd") f.provider.cwd = "/owned/foreign";
  if (mode === "zombie") f.provider.state = "Z";
  if (mode === "reused") f.provider.started = "99";
  if (mode === "duplicate") f.records.set(58, { ...f.provider, pid: 58 });
  if (mode === "foreign-mcp")
    f.provider.args[3] = "mcp_servers.bibcode.url=http://127.0.0.1:4888/mcp";
  if (mode === "unexpected-listen")
    f.provider.args = [
      "/owned/node",
      "/owned/shims/codex-fixture.mjs",
      "app-server",
      "--listen",
      "stdio://",
    ];
  expect(() => owner.verifyProviderLive("owned-native-turn")).toThrow();
  expect(() => owner.verifyProviderReaped()).toThrow();
});
it("refuses reused or foreign server identity and a changed original native turn", () => {
  const f = processProofFixture(),
    owner = createLifecycleProcessProof(f.input);
  owner.verifyProviderLive("owned-native-turn");
  expect(() => owner.verifyProviderLive("another-native-turn")).toThrow();
  f.server.started = "99";
  expect(() => owner.verifyServerOwned()).toThrow();
});

it("parses only bounded private procfs identity fields with matching stat/status parent", () => {
  const fields = ["S", "42", ...Array.from({ length: 17 }, () => "0"), "12"],
    ports = {
      read: (path: string) =>
        path.endsWith("/status")
          ? "Uid:\t1001 1001 1001 1001\nPPid:\t42\n"
          : path.endsWith("/stat")
            ? "57 (node fixture) " + fields.join(" ")
            : "/owned/node\0/owned/shims/codex-fixture.mjs\0app-server\0",
      readlink: (path: string) =>
        path.endsWith("/exe")
          ? "/owned/node"
          : path.endsWith("/cwd")
            ? "/owned/managed"
            : path.endsWith("/net")
              ? "net:[2]"
              : path.endsWith("/pid")
                ? "pid:[3]"
                : "user:[4]",
    };
  expect(readLifecycleProcessRecord(57, ports)).toMatchObject({
    pid: 57,
    parent: 42,
    uid: 1001,
    state: "S",
    started: "12",
    executable: "/owned/node",
    cwd: "/owned/managed",
    args: ["/owned/node", "/owned/shims/codex-fixture.mjs", "app-server"],
  });
  expect(() =>
    readLifecycleProcessRecord(57, {
      ...ports,
      read: (path) => (path.endsWith("/status") ? "Uid:\t1001\nPPid:\t99\n" : ports.read(path)),
    }),
  ).toThrow();
  expect(() =>
    readLifecycleProcessRecord(57, { ...ports, read: () => "x".repeat(65537) }),
  ).toThrow();
  const missing = () => {
    throw Object.assign(new Error("Inert missing procfs channel."), { code: "ENOENT" });
  };
  expect(readLifecycleProcessRecord(57, { ...ports, read: missing })).toBeNull();
  expect(readLifecycleProcessRecord(57, { ...ports, readlink: missing })).toMatchObject({
    pid: 57,
  });
  expect(
    readLifecycleProcessRecord(57, {
      ...ports,
      read: (path) =>
        path.endsWith("/stat")
          ? "57 (node fixture) Z " + fields.slice(1).join(" ")
          : ports.read(path),
      readlink: missing,
    }),
  ).toMatchObject({ pid: 57, state: "Z" });
});

function processReaderProofFixture() {
  const fixture = processProofFixture(),
    record = fixture.provider,
    prefix = "/proc/" + record.pid + "/",
    channels = new Map([
      ["status", "Uid:\t" + record.uid + "\nPPid:\t" + record.parent + "\n"],
      [
        "stat",
        record.pid +
          " (owned fixture) " +
          [
            record.state,
            String(record.parent),
            ...Array.from({ length: 17 }, () => "0"),
            record.started,
          ].join(" "),
      ],
      ["cmdline", record.args.join("\0") + "\0"],
      ["exe", record.executable],
      ["cwd", record.cwd],
      ["ns/net", record.namespaces.net],
      ["ns/pid", record.namespaces.pid],
      ["ns/user", record.namespaces.user],
    ]);
  let missing: { channel: string; code: "ENOENT" | "ESRCH" } | null = null;
  const read = (path: string) => {
    const channel = path.slice(prefix.length);
    if (!path.startsWith(prefix) || !channels.has(channel))
      throw new Error("Inert channel refused.");
    if (missing?.channel === channel)
      throw Object.assign(new Error("Inert missing channel."), { code: missing.code });
    return channels.get(channel)!;
  };
  const owner = createLifecycleProcessProof({
    ...fixture.input,
    read: (pid) =>
      pid === record.pid
        ? readLifecycleProcessRecord(pid, { read, readlink: read })
        : fixture.input.read(pid),
  });
  return {
    owner,
    setMissing: (channel: string, code: "ENOENT" | "ESRCH") => {
      missing = { channel, code };
    },
  };
}

it.each(
  (["ENOENT", "ESRCH"] as const).flatMap((code) =>
    ["stat", "cmdline", "exe", "cwd", "ns/net", "ns/pid", "ns/user"].map((channel) => ({
      code,
      channel,
    })),
  ),
)(
  "refuses reaping when $channel disappears with $code after an observed provider channel",
  ({ code, channel }) => {
    const fixture = processReaderProofFixture();
    fixture.owner.verifyProviderLive("owned-native-turn");
    fixture.setMissing(channel, code);
    expect(() => fixture.owner.verifyProviderReaped()).toThrow();
  },
);

it.each(["ENOENT", "ESRCH"] as const)(
  "permits reaping only when the initial provider channel is absent with %s",
  (code) => {
    const fixture = processReaderProofFixture();
    fixture.owner.verifyProviderLive("owned-native-turn");
    fixture.setMissing("status", code);
    expect(() => fixture.owner.verifyProviderReaped()).not.toThrow();
  },
);

it.each(["ENOENT", "ESRCH", "INITIAL_ABSENCE"] as const)(
  "joins the actual default held-actor reader and refuses partial absence: %s",
  async (mode) => {
    const { input } = setup(),
      source = NodeFS.readFileSync(
        new URL("./release-visual-project-lifecycle-fixture.ts", import.meta.url),
        "utf8",
      ),
      start = source.indexOf("  const readProcess =\n"),
      end = source.indexOf("  const verifyHeldTransferOwner =", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    let missing: { pid: number; channel: string; code: string } | null = null;
    let actorArgs: readonly string[] = [];
    const uid = NodeFS.statSync(input.root).uid,
      readProcess: NonNullable<
        Parameters<typeof prepareProjectLifecycleFixture>[0]["readProcess"]
      > = NodeVM.runInNewContext(
        NodeModule.stripTypeScriptTypes(source.slice(start, end), { mode: "strip" }) +
          "\nreadProcess;",
        {
          input: { hostPlatform: "linux" },
          NodePath,
          refused: () => new Error("Owned fixture refused."),
          NodeFS: {
            readFileSync: (path: string) => {
              const match = /^\/proc\/(31|42)\/(status|cmdline)$/.exec(path);
              if (!match) throw new Error("Inert channel refused.");
              const pid = Number(match[1]),
                channel = match[2]!;
              if (missing?.pid === pid && missing.channel === channel)
                throw Object.assign(new Error("Inert missing channel."), { code: missing.code });
              return channel === "status"
                ? "Uid:\t" + uid + "\nPPid:\t" + (pid === 31 ? 42 : 1) + "\nState:\tS\n"
                : (pid === 31 ? actorArgs : ["owned-server"]).join("\0") + "\0";
            },
          },
        },
      ),
      fixture = await prepareProjectLifecycleFixture({
        ...input,
        hostPlatform: "linux",
        readProcess,
      }),
      manifestPath = NodePath.join(fixture.root, "owned-pack-manifest.json"),
      manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
    actorArgs = [input.nodeExecutable, manifest.script, manifestPath];
    NodeFS.writeFileSync(
      NodePath.join(fixture.root, "held-pack.json"),
      JSON.stringify({
        source: input.source,
        nonce: manifest.nonce,
        actorPid: 31,
        phase: "real-pack-held",
        forwardedBytes: 4096,
        totalBytes: 5000,
        packSha256: "b".repeat(64),
        delegateReaped: true,
      }),
      { mode: 0o600 },
    );
    await expect(fixture.verifyHeldTransferOwner(42)).resolves.toMatchObject({
      phase: "real-pack-held",
    });
    missing = {
      pid: 31,
      channel: mode === "INITIAL_ABSENCE" ? "status" : "cmdline",
      code: mode === "INITIAL_ABSENCE" ? "ENOENT" : mode,
    };
    if (mode === "INITIAL_ABSENCE")
      await expect(fixture.verifyHeldTransferReaped()).resolves.toBeUndefined();
    else await expect(fixture.verifyHeldTransferReaped()).rejects.toThrow();
  },
);

it("distinguishes an absent owned transfer marker from a malformed or foreign marker", async () => {
  const { input } = setup(),
    fixture = await prepareProjectLifecycleFixture(input);
  expect(await fixture.heldTransferReady()).toBe(false);
  const marker = NodePath.join(fixture.root, "held-pack.json");
  NodeFS.writeFileSync(marker, "{}", { mode: 0o600 });
  await expect(fixture.heldTransferReady()).rejects.toThrow();
  NodeFS.unlinkSync(marker);
  NodeFS.symlinkSync(fixture.gitConfig, marker);
  await expect(fixture.heldTransferReady()).rejects.toThrow();
});
