// @effect-diagnostics nodeBuiltinImport:off - Finite private CI fixture; Git is owner-admitted tooling.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeURL from "node:url";

export interface ProjectLifecycleFixtureInput {
  readonly root: string;
  readonly home: string;
  readonly primaryCheckout: string;
  readonly anchorCheckouts: readonly string[];
  /** Exact absent destination under the caller's current configured managed base. */
  readonly plannedManagedCheckout?: string;
  readonly source: string;
  readonly theme: "light" | "dark";
  readonly hostPlatform: NodeJS.Platform;
  readonly nodeExecutable: string;
  readonly gitExecutable: string;
  readonly admitOwner: () => Promise<void>;
  /** Inert tests may supply process observations; CI defaults to its private Linux /proc. */
  readonly readProcess?: (
    pid: number,
  ) => { parent: number; uid: number; state: string; args: readonly string[] } | null;
  readonly git: (
    cwd: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
  ) => Promise<{ status: number; stdout: string; stderr: string }>;
}

const refused = () => new Error("Owned project lifecycle fixture refused.");
const digest = (value: string | Buffer) =>
  NodeCrypto.createHash("sha256").update(value).digest("hex");
const inside = (root: string, path: string) => {
  const relative = NodePath.relative(root, path);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(".." + NodePath.sep) &&
    !NodePath.isAbsolute(relative)
  );
};
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** Only Git-produced pack bytes are forwarded; the remaining bytes stay in this bounded owned hook. */
const packHook = String.raw`import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
const fail = () => { process.stderr.write("owned-pack-refused\n"); process.exit(1); };
let manifest;
try {
  const file = process.argv[2];
  manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  const stat = fs.lstatSync(file);
  if (process.env.CI !== "true" || process.env.BIBCODE_UPLOAD_SOURCE !== manifest.source ||
      fs.realpathSync(file) !== file || stat.isSymbolicLink() || stat.nlink !== 1 ||
      (stat.mode & 511) !== 384 || stat.uid !== fs.statSync(manifest.root).uid ||
      fs.realpathSync(process.cwd()) !== manifest.origin ||
      fs.realpathSync(process.argv[1]) !== manifest.script ||
      crypto.createHash("sha256").update(fs.readFileSync(manifest.script)).digest("hex") !== manifest.scriptSha256) fail();
} catch { fail(); }
const args = process.argv.slice(3);
if (args.length < 3 || args.length > 32 || args[0] !== "git" || args[1] !== "pack-objects" ||
    !args.includes("--stdout") || args.some(x => x.length > 512)) fail();
const child = spawn(manifest.git, args.slice(1), { cwd: manifest.origin, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
process.stdin.pipe(child.stdin);
child.stderr.pipe(process.stderr);
let size = 0, failed = false;
const chunks = [];
child.stdout.on("data", chunk => {
  size += chunk.length;
  if (size > 2097152) { failed = true; child.kill("SIGTERM"); } else chunks.push(chunk);
});
child.on("error", fail);
let timer;
const stop = () => { clearInterval(timer); if (child.exitCode === null) child.kill("SIGTERM"); process.exitCode = 143; };
process.once("SIGTERM", stop); process.once("SIGINT", stop);
child.on("close", code => {
  if (failed || code !== 0) return fail();
  const pack = Buffer.concat(chunks);
  if (pack.length <= 4096 || pack.subarray(0,4).toString("ascii") !== "PACK") return fail();
  const prefix = 4096;
  process.stdout.write(pack.subarray(0,prefix));
  const proof = { source: manifest.source, nonce: manifest.nonce, actorPid: process.pid,
    phase: "real-pack-held", forwardedBytes: prefix, totalBytes: pack.length,
    packSha256: crypto.createHash("sha256").update(pack).digest("hex"), delegateReaped: true };
  try { fs.writeFileSync(manifest.ready, JSON.stringify(proof), { mode: 384, flag: "wx" }); } catch { return fail(); }
  const until = Date.now() + 90000;
  timer = setInterval(() => {
    if (process.exitCode === 143) { clearInterval(timer); return; }
    if (Date.now() > until) { clearInterval(timer); return fail(); }
    if (!fs.existsSync(manifest.release)) return;
    try {
      if (fs.readFileSync(manifest.release,"utf8") !== manifest.nonce) return fail();
      clearInterval(timer);
      process.stdout.end(pack.subarray(prefix));
    } catch { fail(); }
  }, 50);
});
`;

export interface LifecycleProcessRecord {
  readonly pid: number;
  readonly parent: number;
  readonly uid: number;
  readonly state: string;
  readonly started: string;
  readonly executable: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly namespaces: { readonly net: string; readonly pid: string; readonly user: string };
}

/** Used only by the already admitted CI caller; tests provide inert file/readlink ports. */
export function readLifecycleProcessRecord(
  pid: number,
  ports: { read: (path: string) => string; readlink: (path: string) => string } = {
    read: (path) => NodeFS.readFileSync(path, "utf8"),
    readlink: (path) => NodeFS.readlinkSync(path),
  },
): LifecycleProcessRecord | null {
  if (!Number.isInteger(pid) || pid < 2 || pid > 2147483647) throw refused();
  const base = "/proc/" + pid;
  let observed: LifecycleProcessRecord | null = null;
  let channelObserved = false;
  try {
    const status = ports.read(base + "/status");
    channelObserved = true;
    const stat = ports.read(base + "/stat");
    if ([status, stat].some((value) => Buffer.byteLength(value) > 65536)) throw refused();
    const close = stat.lastIndexOf(") "),
      fields = stat
        .slice(close + 2)
        .trim()
        .split(/\s+/);
    const parent = Number(fields[1]),
      uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]),
      statedParent = Number(/^PPid:\s+(\d+)/m.exec(status)?.[1]);
    if (
      !stat.startsWith(String(pid) + " (") ||
      close < 3 ||
      fields.length < 20 ||
      !Number.isInteger(parent) ||
      parent < 0 ||
      parent !== statedParent ||
      !Number.isInteger(uid) ||
      uid < 0 ||
      !/^[A-Zt]$/.test(fields[0]!) ||
      !/^[0-9]{1,32}$/.test(fields[19]!)
    )
      throw refused();
    observed = {
      pid,
      parent,
      uid,
      state: fields[0]!,
      started: fields[19]!,
      args: [],
      executable: "",
      cwd: "",
      namespaces: { net: "", pid: "", user: "" },
    };
    if (observed.state === "Z" || observed.state === "X") return observed;
    const command = ports.read(base + "/cmdline");
    if (Buffer.byteLength(command) > 65536 || !command.endsWith("\0")) throw refused();
    const args = command.slice(0, -1).split("\0");
    if (args.length < 1 || args.length > 128 || args.some((value) => value.length === 0))
      throw refused();
    return {
      ...observed,
      args,
      executable: ports.readlink(base + "/exe"),
      cwd: ports.readlink(base + "/cwd"),
      namespaces: {
        net: ports.readlink(base + "/ns/net"),
        pid: ports.readlink(base + "/ns/pid"),
        user: ports.readlink(base + "/ns/user"),
      },
    };
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ESRCH"
    ) {
      if (channelObserved && observed === null) throw refused();
      return observed;
    }
    throw refused();
  }
}

/** Pure ownership joins over private procfs observations; no process is started or signalled. */
export function createLifecycleProcessProof(input: {
  readonly CI: string | undefined;
  readonly uid: number;
  readonly serverPid: number;
  readonly serverExecutable: string;
  readonly serverArgs: readonly string[];
  readonly serverCwd: string;
  readonly namespace: LifecycleProcessRecord["namespaces"];
  readonly providerNode: string;
  readonly providerScript: string;
  readonly providerCwd: string;
  readonly read: (pid: number) => LifecycleProcessRecord | null;
  readonly pids: () => readonly number[];
}) {
  if (
    input.CI !== "true" ||
    !Number.isInteger(input.uid) ||
    input.uid < 0 ||
    !Number.isInteger(input.serverPid) ||
    input.serverPid < 2 ||
    input.serverPid > 2147483647 ||
    ![
      input.serverExecutable,
      input.serverCwd,
      input.providerNode,
      input.providerScript,
      input.providerCwd,
    ].every((path) => NodePath.isAbsolute(path) && NodePath.normalize(path) === path)
  )
    throw refused();
  const namespace = Object.freeze({ ...input.namespace }),
    serverArgs = [...input.serverArgs],
    namespaceKeys = ["net", "pid", "user"] as const;
  if (
    !namespaceKeys.every(
      (key) =>
        /^(net|pid|user):\[[0-9]+\]$/.test(namespace[key]) && namespace[key].startsWith(key + ":"),
    ) ||
    serverArgs.length < 1 ||
    serverArgs.length > 128 ||
    serverArgs[0] !== input.serverExecutable
  )
    throw refused();
  let serverStarted: string | null = null,
    provider: { pid: number; started: string; turnId: string } | null = null;
  const alive = (record: LifecycleProcessRecord) =>
    record.uid === input.uid &&
    ["R", "S", "D", "I"].includes(record.state) &&
    /^[0-9]{1,32}$/.test(record.started) &&
    namespaceKeys.every((key) => record.namespaces[key] === namespace[key]);
  const verifyServerOwned = () => {
    const record = input.read(input.serverPid);
    if (
      !record ||
      record.pid !== input.serverPid ||
      !alive(record) ||
      record.executable !== input.serverExecutable ||
      record.cwd !== input.serverCwd ||
      JSON.stringify(record.args) !== JSON.stringify(serverArgs) ||
      (serverStarted !== null && serverStarted !== record.started)
    )
      throw refused();
    serverStarted ??= record.started;
  };
  const records = () => {
    const pids = input.pids();
    if (
      pids.length > 1024 ||
      new Set(pids).size !== pids.length ||
      !pids.every((pid) => Number.isInteger(pid) && pid >= 2 && pid <= 2147483647)
    )
      throw refused();
    return pids
      .map((pid) => input.read(pid))
      .filter((record): record is LifecycleProcessRecord => record !== null);
  };
  const relevant = (record: LifecycleProcessRecord) =>
    record.cwd === input.providerCwd &&
    record.args[0] === input.providerNode &&
    record.args[1] === input.providerScript;
  const verifyProviderLive = (turnId: string) => {
    verifyServerOwned();
    if (typeof turnId !== "string" || turnId.length < 1 || turnId.length > 256) throw refused();
    const candidates = records().filter(relevant);
    if (candidates.length !== 1) throw refused();
    const record = candidates[0]!;
    if (
      !alive(record) ||
      record.executable !== input.providerNode ||
      JSON.stringify(record.args) !==
        JSON.stringify([
          input.providerNode,
          input.providerScript,
          "-c",
          "mcp_servers.bibcode.url=http://127.0.0.1:4885/mcp",
          "-c",
          'mcp_servers.bibcode.bearer_token_env_var="BIBCODE_MCP_BEARER_TOKEN"',
          "app-server",
        ]) ||
      (provider !== null &&
        (provider.pid !== record.pid ||
          provider.started !== record.started ||
          provider.turnId !== turnId))
    )
      throw refused();
    let parent = record.parent,
      owned = false;
    for (let depth = 0; depth < 16; depth++) {
      if (parent === input.serverPid) {
        owned = true;
        break;
      }
      if (parent < 2) break;
      const ancestor = input.read(parent);
      if (!ancestor || !alive(ancestor)) break;
      parent = ancestor.parent;
    }
    if (!owned) throw refused();
    provider ??= Object.freeze({ pid: record.pid, started: record.started, turnId });
  };
  const verifyProviderReaped = () => {
    verifyServerOwned();
    if (provider === null || input.read(provider.pid) !== null || records().some(relevant))
      throw refused();
  };
  return Object.freeze({ verifyServerOwned, verifyProviderLive, verifyProviderReaped });
}

/** Root supplies its checked CI namespace/server owner; no product runtime is started here. */
export async function prepareProjectLifecycleFixture(input: ProjectLifecycleFixtureInput) {
  await input.admitOwner();
  const directory = (path: string) => {
    const stat = NodeFS.lstatSync(path);
    if (
      !NodePath.isAbsolute(path) ||
      NodeFS.realpathSync(path) !== path ||
      !stat.isDirectory() ||
      stat.isSymbolicLink()
    )
      throw refused();
    return stat;
  };
  directory(input.root);
  directory(input.home);
  directory(input.primaryCheckout);
  if (
    input.root === NodePath.parse(input.root).root ||
    !inside(input.root, input.home) ||
    !inside(input.root, input.primaryCheckout) ||
    !/^[a-f0-9]{40}$/.test(input.source) ||
    !["light", "dark"].includes(input.theme) ||
    input.anchorCheckouts.length > 64
  )
    throw refused();
  const anchors = [...new Set(input.anchorCheckouts)];
  if (!anchors.includes(input.primaryCheckout)) throw refused();
  for (const anchor of anchors) {
    directory(anchor);
    if (!inside(input.root, anchor)) throw refused();
  }
  const planned = input.plannedManagedCheckout;
  if (planned !== undefined) {
    const base = NodePath.join(input.root, "managed-worktrees"),
      parent = NodePath.join(base, NodePath.basename(input.primaryCheckout)),
      expected = NodePath.join(parent, "codex-delivery-retry-" + input.theme);
    if (
      planned !== expected ||
      NodePath.normalize(planned) !== planned ||
      NodeFS.existsSync(planned)
    )
      throw refused();
    for (const path of [base, parent]) {
      const stat = directory(path);
      if (stat.uid !== directory(input.root).uid || (stat.mode & 0o077) !== 0) throw refused();
    }
    // The product must exclusively reserve its configured-base destination.
    try {
      NodeFS.lstatSync(planned);
      throw refused();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw refused();
    }
  }
  for (const executable of [input.nodeExecutable, input.gitExecutable]) {
    if (
      !NodePath.isAbsolute(executable) ||
      NodeFS.realpathSync(executable) !== executable ||
      !NodeFS.lstatSync(executable).isFile()
    )
      throw refused();
  }
  const root = NodePath.join(input.root, "visual-project-lifecycle");
  if (NodeFS.existsSync(root)) throw refused();
  NodeFS.mkdirSync(root, { mode: 0o700 });
  const origin = NodePath.join(root, "lifecycle-origin.git");
  const seed = NodePath.join(root, "seed");
  const cloneParent = NodePath.join(root, "clone-parent");
  const trustCheckout = NodePath.join(root, "visual trust 'checkout");
  for (const path of [origin, seed, cloneParent, trustCheckout])
    NodeFS.mkdirSync(path, { mode: 0o700 });
  const gitConfig = NodePath.join(root, "owned-protected.gitconfig");
  NodeFS.writeFileSync(gitConfig, "", { mode: 0o600, flag: "wx" });
  const environment = (differentOwner = false): NodeJS.ProcessEnv => ({
    HOME: input.home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_COUNT: "0",
    GIT_TEST_ASSUME_DIFFERENT_OWNER: differentOwner ? "1" : "0",
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    CI: "true",
    BIBCODE_UPLOAD_SOURCE: input.source,
  });
  const git = async (
    cwd: string,
    args: readonly string[],
    statuses = [0],
    differentOwner = false,
  ) => {
    await input.admitOwner();
    directory(cwd);
    if (cwd !== root && !inside(root, cwd)) throw refused();
    const result = await input.git(cwd, args, environment(differentOwner));
    if (
      !statuses.includes(result.status) ||
      typeof result.stdout !== "string" ||
      typeof result.stderr !== "string" ||
      Buffer.byteLength(result.stdout) > 2 * 1024 * 1024 ||
      Buffer.byteLength(result.stderr) > 65536
    )
      throw refused();
    return result;
  };
  await git(root, ["init", "--bare", "--initial-branch=main", origin]);
  await git(seed, ["init", "--initial-branch=main"]);
  const bytes = Buffer.concat(
    Array.from({ length: 16_384 }, (_, i) =>
      NodeCrypto.createHash("sha256")
        .update("owned-lifecycle-" + i)
        .digest(),
    ),
  );
  NodeFS.writeFileSync(NodePath.join(seed, "owned-transfer.bin"), bytes, {
    mode: 0o600,
    flag: "wx",
  });
  await git(seed, ["add", "--", "owned-transfer.bin"]);
  await git(seed, [
    "-c",
    "user.name=Owned fixture",
    "-c",
    "user.email=owned@example.invalid",
    "commit",
    "-m",
    "Owned transfer baseline",
  ]);
  await git(seed, ["push", origin, "main"]);
  await git(trustCheckout, ["init", "--initial-branch=main"]);
  const cloneUrl = "https://visual.invalid/lifecycle-origin.git" as const;
  const script = NodePath.join(root, "owned-pack-hook.mjs");
  const manifestPath = NodePath.join(root, "owned-pack-manifest.json");
  const ready = NodePath.join(root, "held-pack.json");
  const release = NodePath.join(root, "release-pack");
  NodeFS.writeFileSync(script, packHook, { mode: 0o600, flag: "wx" });
  const nonce = NodeCrypto.randomBytes(32).toString("hex");
  const manifest = {
    root,
    source: input.source,
    origin,
    git: input.gitExecutable,
    script,
    scriptSha256: digest(packHook),
    ready,
    release,
    nonce,
  };
  NodeFS.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600, flag: "wx" });
  const manifestHash = digest(NodeFS.readFileSync(manifestPath));
  const hook = [input.nodeExecutable, script, manifestPath].map(shellQuote).join(" ");
  const exemptions = [
    ...anchors,
    ...(planned === undefined ? [] : [planned]),
    origin,
    seed,
    trustCheckout,
  ];
  for (const anchor of exemptions)
    await git(root, ["config", "--file", gitConfig, "--add", "safe.directory", anchor]);
  await git(root, [
    "config",
    "--file",
    gitConfig,
    `url.${NodeURL.pathToFileURL(origin).href}.insteadOf`,
    cloneUrl,
  ]);
  await git(root, ["config", "--file", gitConfig, "uploadpack.packObjectsHook", hook]);
  const originalConfig = NodeFS.readFileSync(gitConfig);
  let configHash = digest(originalConfig);
  let trusted = true;
  const originInputs = new Map<string, { dev: number; ino: number; sha256: string }>();
  const retain = (directoryPath: string) => {
    for (const entry of NodeFS.readdirSync(directoryPath, { withFileTypes: true })) {
      const path = NodePath.join(directoryPath, entry.name),
        stat = NodeFS.lstatSync(path);
      if (stat.isSymbolicLink()) throw refused();
      if (stat.isDirectory()) retain(path);
      else if (stat.isFile() && stat.nlink === 1)
        originInputs.set(path, {
          dev: stat.dev,
          ino: stat.ino,
          sha256: digest(NodeFS.readFileSync(path)),
        });
      else throw refused();
      if (originInputs.size > 256) throw refused();
    }
  };
  retain(origin);
  for (const path of [
    NodePath.join(seed, "owned-transfer.bin"),
    NodePath.join(trustCheckout, ".git", "HEAD"),
  ]) {
    const stat = NodeFS.lstatSync(path);
    originInputs.set(path, {
      dev: stat.dev,
      ino: stat.ino,
      sha256: digest(NodeFS.readFileSync(path)),
    });
  }
  const primaryAnchor = directory(input.primaryCheckout);
  const verifyInputBytes = async () => {
    await input.admitOwner();
    verifyFiles();
    const primary = directory(input.primaryCheckout);
    if (primary.dev !== primaryAnchor.dev || primary.ino !== primaryAnchor.ino) throw refused();
    const current: string[] = [];
    const visit = (path: string) => {
      for (const entry of NodeFS.readdirSync(path, { withFileTypes: true })) {
        const next = NodePath.join(path, entry.name);
        if (entry.isDirectory()) visit(next);
        else current.push(next);
        if (current.length > 256) throw refused();
      }
    };
    visit(origin);
    if (current.length !== [...originInputs.keys()].filter((path) => inside(origin, path)).length)
      throw refused();
    for (const [path, expected] of originInputs) {
      const stat = NodeFS.lstatSync(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        NodeFS.realpathSync(path) !== path ||
        stat.dev !== expected.dev ||
        stat.ino !== expected.ino ||
        digest(NodeFS.readFileSync(path)) !== expected.sha256
      )
        throw refused();
    }
  };
  const verifyInputsRetained = async () => {
    await verifyInputBytes();
    if (!trusted || !NodeFS.readFileSync(gitConfig).equals(originalConfig)) throw refused();
  };
  const verifyTargetExemptionRemoved = async () => {
    if (trusted) throw refused();
    await verifyInputBytes();
  };
  const file = (path: string) => {
    const stat = NodeFS.lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.uid !== directory(root).uid ||
      (stat.mode & 0o777) !== 0o600 ||
      NodeFS.realpathSync(path) !== path
    )
      throw refused();
  };
  const verifyFiles = () => {
    for (const path of [script, manifestPath, gitConfig]) file(path);
    if (
      digest(NodeFS.readFileSync(script)) !== manifest.scriptSha256 ||
      digest(NodeFS.readFileSync(manifestPath)) !== manifestHash ||
      digest(NodeFS.readFileSync(gitConfig)) !== configHash
    )
      throw refused();
  };
  const verifyCloneConfiguration = async () => {
    await input.admitOwner();
    verifyFiles();
    const actualHook = await git(root, [
      "config",
      "--global",
      "--get",
      "uploadpack.packObjectsHook",
    ]);
    const rewrite = await git(root, [
      "config",
      "--global",
      "--get",
      `url.${NodeURL.pathToFileURL(origin).href}.insteadOf`,
    ]);
    if (actualHook.stdout.trim() !== hook || rewrite.stdout.trim() !== cloneUrl) throw refused();
  };
  const setTargetTrust = async (target: string, allow: boolean) => {
    await input.admitOwner();
    if (target !== trustCheckout || target === input.primaryCheckout) throw refused();
    directory(target);
    verifyFiles();
    if (allow === trusted) return;
    if (allow) NodeFS.writeFileSync(gitConfig, originalConfig, { mode: 0o600 });
    else
      await git(root, [
        "config",
        "--file",
        gitConfig,
        "--fixed-value",
        "--unset-all",
        "safe.directory",
        trustCheckout,
      ]);
    trusted = allow;
    configHash = digest(NodeFS.readFileSync(gitConfig));
  };
  // Hermetic TempGit test port only; native callers use the server-owned typed status/classifier.
  const verifyTrustRefusal = async () => {
    if (trusted) throw refused();
    verifyFiles();
    const result = await git(trustCheckout, ["status", "--porcelain"], [128], true);
    if (!result.stderr.includes("detected dubious ownership")) throw refused();
  };
  const heldRecord = async () => {
    await verifyCloneConfiguration();
    file(ready);
    if (NodeFS.statSync(ready).size > 4096) throw refused();
    const value = JSON.parse(NodeFS.readFileSync(ready, "utf8"));
    if (
      Object.keys(value).sort().join(" ") !==
        "actorPid delegateReaped forwardedBytes nonce packSha256 phase source totalBytes" ||
      value.source !== input.source ||
      value.nonce !== nonce ||
      value.phase !== "real-pack-held" ||
      value.delegateReaped !== true ||
      value.forwardedBytes !== 4096 ||
      !Number.isInteger(value.totalBytes) ||
      value.totalBytes <= 4096 ||
      value.totalBytes > 2 * 1024 * 1024 ||
      !/^[a-f0-9]{64}$/.test(value.packSha256) ||
      !Number.isInteger(value.actorPid) ||
      value.actorPid < 2
    )
      throw refused();
    return value as { actorPid: number; totalBytes: number; packSha256: string };
  };
  const heldTransferReady = async () => {
    await input.admitOwner();
    verifyFiles();
    try {
      NodeFS.lstatSync(ready);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw refused();
    }
    await heldRecord(); // Existing closed source/nonce/bytes/hash proof; malformed markers never wait.
    return true;
  };
  const readHeldTransfer = async () => {
    const value = await heldRecord();
    return Object.freeze({
      phase: "real-pack-held" as const,
      forwardedBytes: 4096,
      totalBytes: value.totalBytes,
      packSha256: value.packSha256,
      delegateReaped: true as const,
    });
  };
  const readProcess =
    input.readProcess ??
    ((pid: number) => {
      if (input.hostPlatform !== "linux") throw refused();
      const path = NodePath.join("/proc", String(pid));
      let channelObserved = false;
      try {
        const status = NodeFS.readFileSync(NodePath.join(path, "status"), "utf8");
        channelObserved = true;
        const parent = Number(/^PPid:\s+(\d+)$/m.exec(status)?.[1]);
        const uid = Number(/^Uid:\s+(\d+)/m.exec(status)?.[1]);
        const state = /^State:\s+([A-Z])/m.exec(status)?.[1];
        const args = NodeFS.readFileSync(NodePath.join(path, "cmdline"), "utf8")
          .replace(/\0$/, "")
          .split("\0");
        if (!Number.isInteger(parent) || !Number.isInteger(uid) || !state) throw refused();
        return { parent, uid, state, args };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && !channelObserved) return null;
        throw refused();
      }
    });
  const verifyHeldTransferOwner = async (serverPid: number) => {
    const value = await heldRecord();
    if (!Number.isInteger(serverPid) || serverPid < 2 || serverPid === value.actorPid)
      throw refused();
    const actor = readProcess(value.actorPid);
    if (
      !actor ||
      actor.state === "Z" ||
      actor.uid !== directory(root).uid ||
      actor.args[0] !== input.nodeExecutable ||
      actor.args[1] !== script ||
      actor.args[2] !== manifestPath
    )
      throw refused();
    const server = readProcess(serverPid);
    if (!server || server.state === "Z" || server.uid !== actor.uid) throw refused();
    let parent = actor.parent;
    for (let depth = 0; depth < 16; depth++) {
      if (parent === serverPid) return readHeldTransfer();
      if (parent < 2) break;
      const ancestor = readProcess(parent);
      if (!ancestor || ancestor.state === "Z" || ancestor.uid !== actor.uid) break;
      parent = ancestor.parent;
    }
    throw refused();
  };
  const verifyHeldTransferReaped = async () => {
    const value = await heldRecord();
    // Zombie is not joined cleanup; a reused/foreign PID must not be silently accepted.
    if (readProcess(value.actorPid) !== null) throw refused();
    const destination = NodePath.join(cloneParent, "lifecycle-origin");
    if (NodeFS.existsSync(destination)) throw refused();
  };
  const releaseHeldTransfer = async () => {
    await readHeldTransfer();
    NodeFS.writeFileSync(release, nonce, { mode: 0o600, flag: "wx" });
  };
  return Object.freeze({
    root,
    primaryCheckout: input.primaryCheckout,
    origin,
    cloneParent,
    cloneUrl,
    trustCheckout,
    gitConfig,
    serverGitEnvironment: Object.freeze(environment(true)),
    verifyCloneConfiguration,
    verifyInputsRetained,
    verifyTargetExemptionRemoved,
    setTargetTrust,
    verifyTrustRefusal,
    heldTransferReady,
    readHeldTransfer,
    releaseHeldTransfer,
    verifyHeldTransferOwner,
    verifyHeldTransferReaped,
  });
}
