// @effect-diagnostics nodeBuiltinImport:off - Only admitted private fixture input files are created/restored.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
/** Native app-server input fixture only; production usage mapping owns the UI state. */
export function settingsFollowupUsageSource(): string {
  return String.raw`import { createInterface } from "node:readline";
if (process.env.CI !== "true" || JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["-s","read-only","-a","untrusted","app-server"])) throw new Error("Owned usage fixture admission refused.");
const reader = createInterface({ input: process.stdin });
let initialized = false, ready = false, read = false, count = 0;
const refused = () => new Error("Owned usage fixture request refused.");
reader.on("line", line => {
  if (Buffer.byteLength(line) > 16384 || ++count > 8) throw refused();
  const request = JSON.parse(line);
  if (!request || typeof request !== "object" || Array.isArray(request) || typeof request.method !== "string" || request.params === null || typeof request.params !== "object" || Array.isArray(request.params)) throw refused();
  const keys = Object.keys(request);
  if (keys.some(key => !["jsonrpc","id","method","params"].includes(key))) throw refused();
  if (request.method === "initialize" && request.id === 1 && !initialized) {
    initialized = true; process.stdout.write(JSON.stringify({id:1,result:{}}) + "\n"); return;
  }
  if (request.method === "initialized" && request.id === undefined && initialized && !ready) { ready = true; return; }
  if (request.method === "account/rateLimits/read" && request.id === 2 && ready && !read) {
    read = true;
    const now = Math.floor(Date.now() / 1000);
    process.stdout.write(JSON.stringify({id:2,result:{rateLimits:{primary:{usedPercent:7,resetsAt:now+3600},secondary:{usedPercent:41,resetsAt:now+604800}}}}) + "\n"); return;
  }
  throw refused();
});
`;
}
export interface SettingsFollowupUsageFixture {
  readonly executable: string;
  verify: () => void;
  close: () => void;
}
export async function prepareSettingsFollowupUsageFixture(input: {
  CI: string | undefined;
  root: string;
  home: string;
  node: string;
  admitOwner: () => Promise<void>;
  observeUnsafeCleanup?: () => void;
}): Promise<SettingsFollowupUsageFixture> {
  const refused = () => new Error("Owned usage fixture files refused.");
  if (input.CI !== "true") throw refused();
  await input.admitOwner();
  for (const path of [input.root, input.home, input.node])
    if (
      !NodePath.isAbsolute(path) ||
      NodePath.normalize(path) !== path ||
      NodeFS.realpathSync(path) !== path
    )
      throw refused();
  if (input.root === NodePath.parse(input.root).root || /[\s\x00]/.test(input.node))
    throw refused();
  const inside = (path: string) => {
    const value = NodePath.relative(input.root, path);
    if (
      !value ||
      value === ".." ||
      value.startsWith(".." + NodePath.sep) ||
      NodePath.isAbsolute(value)
    )
      throw refused();
  };
  inside(input.home);
  inside(input.node);
  const directory = (path: string) => {
    const stat = NodeFS.lstatSync(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      NodeFS.realpathSync(path) !== path
    )
      throw refused();
    return stat;
  };
  const root = directory(input.root),
    home = directory(input.home),
    node = NodeFS.lstatSync(input.node);
  if (!node.isFile() || node.isSymbolicLink() || (node.mode & 0o111) === 0) throw refused();
  const codex = NodePath.join(input.home, ".codex"),
    auth = NodePath.join(codex, "auth.json"),
    executable = NodePath.join(input.home, "owned-settings-usage.mjs");
  let createdDirectory = false,
    codexStat: NodeFS.Stats;
  if (!NodeFS.existsSync(codex)) {
    NodeFS.mkdirSync(codex, { mode: 0o700 });
    createdDirectory = true;
  }
  codexStat = directory(codex);
  interface File {
    path: string;
    bytes: Buffer;
    dev: number;
    ino: number;
    mode: number;
  }
  const files: File[] = [];
  const sameDirectories = () => {
    for (const [path, anchor] of [
      [input.root, root],
      [input.home, home],
      [codex, codexStat],
    ] as const) {
      const stat = directory(path);
      if (stat.dev !== anchor.dev || stat.ino !== anchor.ino) throw refused();
    }
    const current = NodeFS.lstatSync(input.node);
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.dev !== node.dev ||
      current.ino !== node.ino ||
      current.size !== node.size ||
      current.mode !== node.mode
    )
      throw refused();
  };
  const verify = () => {
    sameDirectories();
    for (const file of files) {
      const stat = NodeFS.lstatSync(file.path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.dev !== file.dev ||
        stat.ino !== file.ino ||
        (stat.mode & 0o777) !== file.mode ||
        stat.size !== file.bytes.length ||
        NodeFS.realpathSync(file.path) !== file.path ||
        !NodeFS.readFileSync(file.path).equals(file.bytes)
      )
        throw refused();
    }
  };
  const cleanup = () => {
    try {
      verify();
      if (createdDirectory && NodeFS.readdirSync(codex).some((value) => value !== "auth.json"))
        throw refused();
      for (const file of files) NodeFS.unlinkSync(file.path);
      if (createdDirectory) NodeFS.rmdirSync(codex);
    } catch {
      try {
        input.observeUnsafeCleanup?.();
      } catch {
        /* Preserve filesystem refusal. */
      }
      throw refused();
    }
  };
  const write = (path: string, bytes: Buffer, mode: number) => {
    NodeFS.writeFileSync(path, bytes, { flag: "wx", mode });
    const stat = NodeFS.lstatSync(path);
    files.push({ path, bytes, dev: stat.dev, ino: stat.ino, mode });
  };
  try {
    write(auth, Buffer.from("{}\n"), 0o600);
    write(executable, Buffer.from("#!" + input.node + "\n" + settingsFollowupUsageSource()), 0o700);
    verify();
  } catch (error) {
    try {
      cleanup();
    } catch {
      /* Original preparation failure stays primary; unsafe cleanup is observed. */
    }
    throw error;
  }
  let closed = false;
  return {
    executable,
    verify: () => {
      if (closed) throw refused();
      verify();
    },
    close: () => {
      if (closed) return;
      cleanup();
      closed = true;
    },
  };
}
