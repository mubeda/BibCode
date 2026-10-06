// @effect-diagnostics nodeBuiltinImport:off - Read-only checksum and physical identity joins for server-verified private pre-update generations.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeProcess from "node:process";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export function pinNativeFollowupBackup(input: { root: string; storage: string; backup: string }) {
  if (
    !uuid.test(input.storage) ||
    !uuid.test(input.backup) ||
    !NodePath.isAbsolute(input.root) ||
    NodeFS.realpathSync(input.root) !== input.root
  )
    throw new Error("Native follow-up backup identity refused.");
  const directory = NodePath.join(input.root, "backups", "userdata", input.storage, input.backup);
  const rootStat = NodeFS.lstatSync(input.root),
    uid = typeof NodeProcess.getuid === "function" ? NodeProcess.getuid() : rootStat.uid,
    directories = new Map<string, string>();
  const verifyAncestors = () => {
    let parent = input.root;
    for (const segment of [null, "backups", "userdata", input.storage, input.backup]) {
      if (segment !== null) parent = NodePath.join(parent, segment);
      const stat = NodeFS.lstatSync(parent),
        identity = [stat.dev, stat.ino, stat.uid, stat.gid, stat.mode].join(":");
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        NodeFS.realpathSync(parent) !== parent ||
        stat.uid !== uid ||
        (stat.mode & 0o077) !== 0 ||
        (directories.has(parent) && directories.get(parent) !== identity)
      )
        throw new Error("Native follow-up backup ancestor refused.");
      directories.set(parent, identity);
    }
    if (NodeFS.readdirSync(directory).sort().join(",") !== "manifest.json,state.sqlite")
      throw new Error("Native follow-up backup inventory changed.");
  };
  verifyAncestors();
  const fileIdentity = (stat: NodeFS.Stats) =>
    [
      stat.dev,
      stat.ino,
      stat.uid,
      stat.gid,
      stat.mode,
      stat.nlink,
      stat.size,
      stat.mtimeMs,
      stat.ctimeMs,
    ].join(":");
  const read = (name: string, limit: number) => {
    verifyAncestors();
    const path = NodePath.join(directory, name),
      stat = NodeFS.lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      NodeFS.realpathSync(path) !== path ||
      stat.uid !== uid ||
      stat.nlink !== 1 ||
      stat.size < 1 ||
      stat.size > limit ||
      (stat.mode & 0o077) !== 0
    )
      throw new Error("Native follow-up backup file refused.");
    const bytes = NodeFS.readFileSync(path);
    verifyAncestors();
    if (fileIdentity(NodeFS.lstatSync(path)) !== fileIdentity(stat))
      throw new Error("Native follow-up backup changed during read.");
    return {
      bytes,
      identity: fileIdentity(stat),
      sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    };
  };
  const initial = {
      database: read("state.sqlite", 256 * 1024 ** 2),
      manifest: read("manifest.json", 65536),
    },
    manifest = JSON.parse(initial.manifest.bytes.toString("utf8"));
  if (
    manifest.backupId !== input.backup ||
    manifest.storageInstanceId !== input.storage ||
    manifest.stateKind !== "userdata" ||
    manifest.trigger !== "pre-update" ||
    manifest.sha256 !== initial.database.sha256 ||
    manifest.databaseSizeBytes !== initial.database.bytes.length ||
    NodeFS.readdirSync(directory).sort().join(",") !== "manifest.json,state.sqlite"
  )
    throw new Error("Native follow-up verified generation mismatch.");
  return {
    databaseSha256: initial.database.sha256,
    manifestSha256: initial.manifest.sha256,
    verify: () => {
      const database = read("state.sqlite", 256 * 1024 ** 2),
        metadata = read("manifest.json", 65536);
      if (
        database.identity !== initial.database.identity ||
        database.sha256 !== initial.database.sha256 ||
        metadata.identity !== initial.manifest.identity ||
        metadata.sha256 !== initial.manifest.sha256
      )
        throw new Error("Native follow-up retained backup changed.");
    },
  };
}
