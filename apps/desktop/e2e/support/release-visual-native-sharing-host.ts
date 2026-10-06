// @effect-diagnostics nodeBuiltinImport:off - CI-only native qualification reads its own visible PID1 and immutable inputs.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { bounded, type QualificationOwner } from "./qualification-owner.ts";
import type { NativeSharingNetworkInput } from "./release-visual-native-sharing-network.ts";
export interface NativeSharingHostInput {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly platform: string;
}
export interface NativeSharingHostPorts {
  readonly readFile: (path: string) => Promise<Buffer>;
  readonly readlink: (path: string) => Promise<string>;
  readonly realpath: (path: string) => Promise<string>;
  readonly stat: (path: string) => Promise<NodeFS.Stats>;
  readonly uid: () => number;
  readonly run: (
    command: string,
    args: readonly string[],
  ) => ReturnType<NativeSharingNetworkInput["run"]>;
  readonly unsafeCleanup: () => void;
}
const refused = () => new Error("Owned native sharing host binding refused.");
const commands = [
  ["-j", "-d", "link", "show"],
  ["-j", "address", "show"],
  ["-j", "-4", "route", "show", "table", "main"],
  ["-j", "-6", "route", "show", "table", "main"],
  ["route", "del", "default", "via", "10.254.231.2", "dev", "bcup-in"],
  ["route", "add", "default", "via", "10.254.231.2", "dev", "bcup-in"],
] as const;
function fingerprint(stat: NodeFS.Stats): string {
  return [stat.dev, stat.ino, stat.uid, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}
/** Bind the existing network adapter before any command can affect a route. */
export async function bindNativeSharingHostNetwork(
  input: NativeSharingHostInput,
  ports: NativeSharingHostPorts,
): Promise<NativeSharingNetworkInput> {
  const env = { ...input.environment };
  if (input.platform !== "linux" || env.CI !== "true") throw refused();
  const required = (key: string): string => {
    const value = env[key];
    if (!value || value.includes("\0") || /[\r\n]/.test(value)) throw refused();
    return value;
  };
  const hostNet = required("BIBCODE_UPLOAD_HOST_NETNS"),
    namespaces = Object.freeze({
      net: required("BIBCODE_UPLOAD_NETNS"),
      pid: required("BIBCODE_UPLOAD_PIDNS"),
      user: required("BIBCODE_UPLOAD_USERNS"),
    });
  if (!/^net:\[\d+\]$/.test(hostNet) || hostNet === namespaces.net) throw refused();
  for (const kind of ["net", "pid", "user"] as const)
    if (!new RegExp("^" + kind + ":\\[\\d+\\]$").test(namespaces[kind])) throw refused();
  const python = required("BIBCODE_UPLOAD_PYTHON"),
    helper = required("BIBCODE_UPLOAD_NETWORK_HELPER"),
    ip = required("BIBCODE_UPLOAD_IP"),
    evidence = required("BIBCODE_UPLOAD_EVIDENCE"),
    fixture = required("BIBCODE_UPLOAD_FIXTURE"),
    source = required("BIBCODE_UPLOAD_SOURCE"),
    app = required("BIBCODE_NATIVE_SHARING_APP");
  if (!/^[a-f0-9]{40}$/.test(source) || !app.endsWith(".AppImage")) throw refused();
  const canonical = async (path: string) => {
    if (
      !NodePath.posix.isAbsolute(path) ||
      NodePath.posix.normalize(path) !== path ||
      (await ports.realpath(path)) !== path
    )
      throw refused();
    const stat = await ports.stat(path);
    if (stat.isSymbolicLink()) throw refused();
    return stat;
  };
  const directories = new Map<string, string>();
  for (const path of [fixture, evidence]) {
    const stat = await canonical(path);
    if (!stat.isDirectory() || stat.uid !== ports.uid() || (stat.mode & 0o777) !== 0o700)
      throw refused();
    // Directories may gain owned files; their identity and permissions must stay fixed.
    directories.set(path, [stat.dev, stat.ino, stat.uid, stat.mode].join(":"));
  }
  const files = new Map<string, string>();
  for (const path of [python, helper, ip, app]) {
    const stat = await canonical(path);
    if (
      !stat.isFile() ||
      stat.size < 1 ||
      stat.size > 512 * 1024 * 1024 ||
      (stat.mode & 0o022) !== 0
    )
      throw refused();
    if (path !== helper && (stat.mode & 0o111) === 0) throw refused();
    files.set(path, fingerprint(stat));
  }
  const ipBytes = await ports.readFile(ip);
  if (ipBytes.length > 4 * 1024 * 1024) throw refused();
  const ipHash = NodeCrypto.createHash("sha256").update(ipBytes).digest("hex");
  const owner = async () => {
    const bytes = await ports.readFile("/proc/1/cmdline");
    if (bytes.length > 32768 || bytes.length === 0 || bytes.at(-1) !== 0) throw refused();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const argv = text.slice(0, -1).split("\0");
    if (
      argv.length !== 16 ||
      argv.some((value) => value === "") ||
      (await ports.realpath(argv[0]!)) !== python ||
      (await ports.realpath(argv[1]!)) !== helper ||
      argv[2] !== "inner" ||
      argv[3] !== evidence ||
      argv[4] !== fixture ||
      argv[11] !== hostNet ||
      argv[12] !== source ||
      argv[13] !== ip ||
      argv[14] !== "release-visual-native-sharing" ||
      argv[15] !== app
    )
      throw refused();
    for (const kind of ["net", "pid", "user"] as const)
      for (const actor of ["self", "1"] as const)
        if ((await ports.readlink("/proc/" + actor + "/ns/" + kind)) !== namespaces[kind])
          throw refused();
    for (const [path, pin] of directories) {
      const stat = await canonical(path);
      if (!stat.isDirectory() || [stat.dev, stat.ino, stat.uid, stat.mode].join(":") !== pin)
        throw refused();
    }
    for (const [path, pin] of files)
      if (fingerprint(await canonical(path)) !== pin) throw refused();
  };
  await owner();
  return {
    CI: "true",
    platform: "linux",
    hostNet,
    namespaces,
    ip,
    readNamespace: async (actor, kind) => {
      await owner();
      return ports.readlink("/proc/" + actor + "/ns/" + kind);
    },
    readCapabilities: async () => {
      await owner();
      const bytes = await ports.readFile("/proc/self/status");
      if (bytes.length > 8192) throw refused();
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    },
    verifyExecutable: async () => {
      await owner();
      const bytes = await ports.readFile(ip);
      return (
        bytes.length <= 4 * 1024 * 1024 &&
        NodeCrypto.createHash("sha256").update(bytes).digest("hex") === ipHash
      );
    },
    run: async (args) => {
      if (
        !commands.some(
          (command) =>
            command.length === args.length &&
            command.every((value, index) => value === args[index]),
        )
      )
        throw refused();
      await owner();
      const result = await ports.run(ip, args);
      await owner();
      return result;
    },
    unsafeCleanup: ports.unsafeCleanup,
  };
}

/** Actual procfs/filesystem/child binding; called only by the private CI native owner. */
export async function createNativeSharingHostNetwork(
  input: NativeSharingHostInput,
  owner: QualificationOwner,
  unsafeCleanup: () => void,
): Promise<NativeSharingNetworkInput> {
  return bindNativeSharingHostNetwork(input, {
    readFile: (path) => NodeFS.promises.readFile(path),
    readlink: (path) => NodeFS.promises.readlink(path),
    realpath: (path) => NodeFS.promises.realpath(path),
    stat: (path) => NodeFS.promises.lstat(path),
    uid: () => {
      if (typeof process.getuid !== "function") throw refused();
      return process.getuid();
    },
    run: async (command, args) => {
      const entry = owner.spawn(command, [...args], { ...input.environment }, "pairing");
      let timedOut = false;
      try {
        try {
          await bounded(entry.done, 5000);
        } catch {
          timedOut = true;
        }
      } finally {
        await owner.stop(entry);
      }
      const stat = NodeFS.lstatSync(entry.log);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw refused();
      return {
        exitCode: entry.child.exitCode ?? -1,
        reaped: entry.child.exitCode !== null || entry.child.signalCode !== null,
        timedOut,
        stdout: NodeFS.readFileSync(entry.log, "utf8"),
      };
    },
    unsafeCleanup,
  });
}
