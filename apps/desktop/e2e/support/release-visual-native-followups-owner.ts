// @effect-diagnostics nodeBuiltinImport:off - Exact owned packaged process, physical data root and frozen source reads.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeProcess from "node:process";
import type { NativeFollowupCommandOwner } from "./release-visual-native-followups-process.ts";
import { inspectNativeFollowupsPreparation } from "./release-visual-native-followups-preparation.ts";
const sha = (bytes: string | Buffer) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
export function readNativeFollowupLinuxBinding(app: string, dataRoot: string, allowClosed = false) {
  const refused = () => new Error("Native follow-up Linux process binding refused."),
    uid = typeof NodeProcess.getuid === "function" ? NodeProcess.getuid() : -1;
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
  const file = (path: string) => {
    const stat = NodeFS.lstatSync(path);
    if (
      !NodePath.isAbsolute(path) ||
      NodeFS.realpathSync(path) !== path ||
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.size < 1 ||
      stat.size > 512 * 1024 ** 2 ||
      (stat.mode & 0o022) !== 0 ||
      (stat.mode & 0o111) === 0
    )
      throw refused();
    const hash = sha(NodeFS.readFileSync(path));
    if (fileIdentity(NodeFS.lstatSync(path)) !== fileIdentity(stat)) throw refused();
    return { stat, identity: fileIdentity(stat), hash };
  };
  const image = file(app),
    home = NodeFS.lstatSync(dataRoot);
  if (
    !Number.isInteger(uid) ||
    uid < 1 ||
    image.stat.uid !== uid ||
    !home.isDirectory() ||
    home.isSymbolicLink() ||
    home.uid !== uid ||
    (home.mode & 0o077) !== 0 ||
    NodeFS.realpathSync(dataRoot) !== dataRoot
  )
    throw refused();
  const text = (path: string, maximum = 65536) => {
    const bytes = NodeFS.readFileSync(path);
    if (bytes.length > maximum) throw refused();
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  };
  const environment = (pid: string) => {
    const raw = text("/proc/" + pid + "/environ", 1024 * 1024);
    if (!raw.endsWith("\0")) throw refused();
    return raw.slice(0, -1).split("\0");
  };
  const field = (rows: readonly string[], key: string) => {
    const matched = rows.filter((value) => value.startsWith(key + "="));
    if (matched.length !== 1) throw refused();
    return matched[0]!.slice(key.length + 1);
  };
  const snapshot = (pid: string) => {
    const raw = text("/proc/" + pid + "/stat"),
      end = raw.lastIndexOf(")"),
      fields = raw.slice(end + 2).split(" "),
      status = text("/proc/" + pid + "/status"),
      match = /^Uid:\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/m.exec(status);
    if (
      !raw.startsWith(pid + " (") ||
      end < 0 ||
      !fields[19] ||
      !/^\d+$/.test(fields[19]) ||
      ["Z", "X", "x"].includes(fields[0]!) ||
      !match ||
      match.slice(1).some((value) => Number(value) !== uid)
    )
      throw refused();
    return {
      pid,
      birth: fields[19],
      uid,
      exe: NodeFS.readlinkSync("/proc/" + pid + "/exe"),
      namespace: NodeFS.readlinkSync("/proc/" + pid + "/ns/mnt"),
    };
  };
  const expectedNamespace = NodeFS.readlinkSync("/proc/self/ns/mnt"),
    processes = NodeFS.readdirSync("/proc").filter((value) => /^\d+$/.test(value));
  if (!/^mnt:\[\d+\]$/.test(expectedNamespace) || processes.length > 65536) throw refused();
  const native: ReturnType<typeof snapshot>[] = [],
    runtime: ReturnType<typeof snapshot>[] = [];
  for (const pid of processes) {
    let rows: string[], exe: string;
    try {
      rows = environment(pid);
      exe = NodeFS.readlinkSync("/proc/" + pid + "/exe");
    } catch {
      continue;
    }
    if (!rows.includes("BIBCODE_HOME=" + dataRoot)) continue;
    if (exe === app) runtime.push(snapshot(pid));
    else if (exe.endsWith("/bibcode-desktop") && exe.includes("/.mount_")) {
      if (field(rows, "APPIMAGE") !== app) throw refused();
      native.push(snapshot(pid));
    }
  }
  const alive = (entry: ReturnType<typeof snapshot>) => {
    try {
      const current = snapshot(entry.pid);
      if (current.birth !== entry.birth) return false;
      if (JSON.stringify(current) !== JSON.stringify(entry)) throw refused();
      return true;
    } catch (error) {
      if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
      throw error;
    }
  };
  if (allowClosed && native.length === 0 && runtime.length === 0) return null;
  if (runtime.length !== 1 || native.length > 1 || (!allowClosed && native.length !== 1))
    throw refused();
  const fuse = runtime[0]!;
  if (fuse.namespace !== expectedNamespace) throw refused();
  const argv = text("/proc/" + fuse.pid + "/cmdline");
  if (!argv.endsWith("\0") || argv.split("\0")[0] !== app) throw refused();
  const runtimeStat = NodeFS.statSync("/proc/" + fuse.pid + "/exe"),
    fds = NodeFS.readdirSync("/proc/" + fuse.pid + "/fd");
  if (runtimeStat.dev !== image.stat.dev || runtimeStat.ino !== image.stat.ino || fds.length > 256)
    throw refused();
  const imageOpen = fds.some((fd) => {
    if (!/^\d+$/.test(fd)) return false;
    try {
      const path = "/proc/" + fuse.pid + "/fd/" + fd,
        stat = NodeFS.statSync(path);
      return (
        NodeFS.readlinkSync(path) === app &&
        stat.dev === image.stat.dev &&
        stat.ino === image.stat.ino
      );
    } catch {
      return false;
    }
  });
  if (!imageOpen) throw refused();
  if (native.length === 0) {
    const after = file(app);
    if (
      after.identity !== image.identity ||
      after.hash !== image.hash ||
      JSON.stringify(snapshot(fuse.pid)) !== JSON.stringify(fuse) ||
      !environment(fuse.pid).includes("BIBCODE_HOME=" + dataRoot)
    )
      throw refused();
    const proof = sha(
      JSON.stringify({ fuse, image: [image.stat.dev, image.stat.ino], imageHash: image.hash }),
    );
    return Object.freeze({
      proof,
      nativePid: null,
      runtimePid: Number(fuse.pid),
      nativeAlive: () => false,
      runtimeAlive: () => alive(fuse),
      verify: () => {
        if (readNativeFollowupLinuxBinding(app, dataRoot, true)?.proof !== proof) throw refused();
      },
    });
  }
  const host = native[0]!,
    rows = environment(host.pid),
    mount = field(rows, "APPDIR"),
    mounted = NodePath.join(mount, "usr/bin/bibcode-desktop");
  if (
    host.namespace !== expectedNamespace ||
    fuse.namespace !== expectedNamespace ||
    !NodePath.isAbsolute(mount) ||
    !NodePath.basename(mount).startsWith(".mount_") ||
    NodeFS.realpathSync(mount) !== mount ||
    host.exe !== mounted ||
    NodeFS.readlinkSync("/proc/" + host.pid + "/fd/1023") !== mount
  )
    throw refused();
  const ownedMount = () => {
    const mountRows = text("/proc/" + host.pid + "/mountinfo", 1024 * 1024)
      .trim()
      .split("\n")
      .filter((row) => {
        const parts = row.split(" "),
          separator = parts.indexOf("-"),
          path = (parts[4] ?? "").replace(/\\([0-7]{3})/g, (_raw, octal: string) =>
            String.fromCharCode(Number.parseInt(octal, 8)),
          );
        return (
          path === mount &&
          separator >= 6 &&
          parts[separator + 1]?.startsWith("fuse") &&
          (parts[5]?.split(",").includes("ro") || parts[separator + 3]?.split(",").includes("ro"))
        );
      });
    if (mountRows.length !== 1) throw refused();
    return mountRows[0]!;
  };
  const mountRow = ownedMount();
  const binary = file(mounted),
    afterImage = file(app),
    afterBinary = file(mounted);
  if (
    image.identity !== afterImage.identity ||
    image.hash !== afterImage.hash ||
    binary.identity !== afterBinary.identity ||
    binary.hash !== afterBinary.hash ||
    JSON.stringify(snapshot(host.pid)) !== JSON.stringify(host) ||
    JSON.stringify(snapshot(fuse.pid)) !== JSON.stringify(fuse) ||
    field(environment(host.pid), "APPIMAGE") !== app ||
    field(environment(host.pid), "APPDIR") !== mount ||
    !environment(fuse.pid).includes("BIBCODE_HOME=" + dataRoot) ||
    NodeFS.readlinkSync("/proc/" + host.pid + "/fd/1023") !== mount ||
    ownedMount() !== mountRow
  )
    throw refused();
  const proof = sha(
    JSON.stringify({
      host,
      fuse,
      image: [image.stat.dev, image.stat.ino],
      imageHash: image.hash,
      binary: [binary.stat.dev, binary.stat.ino],
      binaryHash: binary.hash,
      mount: mountRow,
    }),
  );
  return Object.freeze({
    proof,
    nativePid: Number(host.pid),
    runtimePid: Number(fuse.pid),
    nativeAlive: () => alive(host),
    runtimeAlive: () => alive(fuse),
    verify: () => {
      if (readNativeFollowupLinuxBinding(app, dataRoot)?.proof !== proof) throw refused();
    },
  });
}
export function freezeNativeFollowupSource(root: string, commit: string) {
  if (!/^[a-f0-9]{40}$/.test(commit) || NodeFS.realpathSync(root) !== root)
    throw new Error("Native follow-up source refused.");
  const sources = inspectNativeFollowupsPreparation(root).sources;
  const verify = () => {
    for (const source of sources) {
      const path = NodePath.join(root, source.path),
        stat = NodeFS.lstatSync(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        NodeFS.realpathSync(path) !== path ||
        sha(NodeFS.readFileSync(path)) !== source.sha256
      )
        throw new Error("Native follow-up source changed.");
    }
  };
  verify();
  return { sourceSha: commit, sourceFiles: sources, verify };
}
export function pinNativeFollowupOwnedRoot(root: string, laneRoot: string, platform = "linux") {
  const relative = NodePath.relative(laneRoot, root),
    stat = NodeFS.lstatSync(root);
  if (
    relative !== "data" ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    NodeFS.realpathSync(root) !== root ||
    NodeFS.realpathSync(laneRoot) !== laneRoot ||
    (platform !== "win32" && (stat.mode & 0o077) !== 0)
  )
    throw new Error("Native follow-up physical data root refused.");
  return {
    sha256: sha([stat.dev, stat.ino, root].join(":")),
    verify: () => {
      const next = NodeFS.lstatSync(root);
      if (
        next.dev !== stat.dev ||
        next.ino !== stat.ino ||
        next.isSymbolicLink() ||
        NodeFS.realpathSync(root) !== root
      )
        throw new Error("Native follow-up physical data root changed.");
    },
  };
}
/** The native app is joined by actual OS process identity, never by a renderer-provided PID. */
export async function readNativeFollowupProcess(input: {
  platform: string;
  app: string;
  dataRoot: string;
  commands: NativeFollowupCommandOwner;
  powershell: string | null;
}): Promise<string> {
  if (input.platform === "linux") {
    return readNativeFollowupLinuxBinding(input.app, input.dataRoot)!.proof;
  }
  if (input.platform !== "win32" || !input.powershell)
    throw new Error("Native follow-up process platform unavailable.");
  const escaped = input.app.replaceAll("'", "''"),
    script =
      'Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class NativeFollowupFocus { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p); }\'; $p=@(Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -ieq \'' +
      escaped +
      "'}); if($p.Count -ne 1){throw 'Owned native process unavailable'}; $focused=[uint32]0; [void][NativeFollowupFocus]::GetWindowThreadProcessId([NativeFollowupFocus]::GetForegroundWindow(),[ref]$focused); if($focused -ne $p[0].ProcessId){throw 'Owned native window is not foreground'}; @{pid=$p[0].ProcessId; born=$p[0].CreationDate.ToUniversalTime().Ticks.ToString(); executable=$p[0].ExecutablePath}|ConvertTo-Json -Compress";
  const raw = (
      await input.commands.command(input.powershell, [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        script,
      ])
    ).toString("utf8"),
    value: unknown = JSON.parse(raw);
  if (
    !value ||
    typeof value !== "object" ||
    !("pid" in value) ||
    !Number.isInteger(value.pid) ||
    !("born" in value) ||
    typeof value.born !== "string" ||
    !/^\d{10,20}$/.test(value.born) ||
    !("executable" in value) ||
    typeof value.executable !== "string" ||
    NodePath.win32.normalize(value.executable).toLowerCase() !==
      NodePath.win32.normalize(input.app).toLowerCase()
  )
    throw new Error("Native follow-up process identity refused.");
  return sha(JSON.stringify([value.pid, value.born, input.app]));
}
