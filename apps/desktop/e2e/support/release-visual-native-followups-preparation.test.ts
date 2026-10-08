// @effect-diagnostics nodeBuiltinImport:off - Read-only fixture source admission in disposable directories.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { expect, it } from "vite-plus/test";
import {
  inspectNativeFollowupsPreparation,
  pinNativeFollowupFile,
  verifyNativeFollowupFile,
} from "./release-visual-native-followups-preparation.ts";

it("records the existing owners' concrete missing prerequisites without claiming native readiness", () => {
  const report = inspectNativeFollowupsPreparation(
    NodePath.resolve(import.meta.dirname, "../../../.."),
  );
  expect(report.rowCount).toBe(5);
  expect(report.originalCount).toBe(10);
  expect(report.ready).toBe(false);
  expect(report.rows.every((row) => row.status === "unavailable" && row.blockers.length > 0)).toBe(
    true,
  );
  expect(report.rows.find((row) => row.scene === "native-menu-theme")?.blockers).toContain(
    "native-ci-original-menu-observation-pending",
  );
  expect(report.rows.find((row) => row.scene === "native-update-recovery")?.blockers).toContain(
    "native-ci-installer-failure-port-hold-observation-pending",
  );
  expect(report.rows.find((row) => row.scene === "native-wsl-local")?.blockers).toContain(
    "native-ci-real-mapped-wsl-observation-pending",
  );
  const encoded = JSON.stringify(report);
  expect(encoded).not.toContain(NodePath.resolve(import.meta.dirname, "../../../.."));
  expect(encoded).not.toContain("privateKey");
});

it("refuses linked, writable or changed immutable inputs and retains private paths internally", () => {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "native-followups-")),
  );
  try {
    const path = NodePath.join(root, "source.ts");
    NodeFS.writeFileSync(path, "owned source", { mode: 0o400 });
    const pin = pinNativeFollowupFile(path, "source");
    expect(() => verifyNativeFollowupFile(pin)).not.toThrow();
    NodeFS.chmodSync(path, 0o600);
    expect(() => verifyNativeFollowupFile(pin)).toThrow();
    NodeFS.writeFileSync(path, "mutated source");
    NodeFS.chmodSync(path, 0o400);
    expect(() => verifyNativeFollowupFile(pin)).toThrow();
    const link = NodePath.join(root, "alias.ts");
    NodeFS.symlinkSync(path, link);
    expect(() => pinNativeFollowupFile(link, "source")).toThrow();
    NodeFS.chmodSync(path, 0o666);
    expect(() => pinNativeFollowupFile(path, "source")).toThrow();
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

function processProbe(fault = "owned") {
  const app = "/owned/installed/BiBCode.AppImage",
    dataRoot = "/owned/data",
    mount = "/tmp/.mount_BiBCod123456",
    executable = mount + "/usr/bin/bibcode-desktop";
  let nativeBirthReads = 0,
    executableChanged = false;
  const imageBytes = Buffer.from("inert immutable AppImage source"),
    nativeBytes = () =>
      Buffer.from(
        executableChanged ? "changed mounted native bytes" : "inert mounted native bytes",
      );
  const fileStat = (kind: string) => ({
    dev: 1,
    ino: kind === "app" ? 10 : kind === "data" ? 20 : 30,
    uid: kind === "native" ? 0 : 1000,
    gid: 1000,
    mode: kind === "data" ? 0o40700 : 0o100555,
    nlink: 1,
    size: kind === "app" ? imageBytes.length : nativeBytes().length,
    mtimeMs: executableChanged && kind === "native" ? 2 : 1,
    ctimeMs: executableChanged && kind === "native" ? 2 : 1,
    isFile: () => kind !== "data",
    isDirectory: () => kind === "data",
    isSymbolicLink: () => false,
  });
  const rawStat = (pid: string, birth: string) => {
    const fields = Array<string>(30).fill("0");
    fields[19] = birth;
    return pid + " (inert) " + fields.join(" ");
  };
  const readFileSync = (path: string, encoding?: string) => {
    let bytes: Buffer;
    if (path === app || path === "/proc/201/exe") bytes = imageBytes;
    else if (path === executable || path === "/proc/101/exe") {
      bytes = nativeBytes();
      if (fault === "executable-drift") executableChanged = true;
    } else if (path.endsWith("/environ"))
      bytes = Buffer.from(
        "BIBCODE_HOME=" +
          dataRoot +
          "\0" +
          (path.includes("/101/")
            ? "APPIMAGE=" +
              (fault === "foreign-image" ? "/foreign/AppImage" : app) +
              "\0APPDIR=" +
              mount +
              "\0"
            : ""),
      );
    else if (path.endsWith("/status"))
      bytes = Buffer.from(
        "Uid:\t" + (fault === "uid" ? "2000\t2000\t2000\t2000" : "1000\t1000\t1000\t1000") + "\n",
      );
    else if (path.endsWith("/stat")) {
      const pid = path.includes("/101/") ? "101" : "201";
      const birth =
        fault === "birth-drift" && pid === "101" && nativeBirthReads++ > 0 ? "12346" : "12345";
      bytes = Buffer.from(rawStat(pid, birth));
    } else if (path.endsWith("/cmdline")) bytes = Buffer.from(app + "\0");
    else if (path.endsWith("/mountinfo"))
      bytes = Buffer.from(
        "29 20 0:42 / " +
          mount +
          " " +
          (fault === "writable-mount" ? "rw" : "ro") +
          " - fuse.squashfuse " +
          app +
          " " +
          (fault === "writable-mount" ? "rw" : "ro") +
          "\n",
      );
    else throw new Error("Inert file port refused.");
    return encoding ? bytes.toString("utf8") : bytes;
  };
  const ports = {
    readdirSync: (path: string) =>
      path === "/proc"
        ? fault === "native-closed"
          ? ["201"]
          : ["101", "201"]
        : path === "/proc/201/fd"
          ? ["3"]
          : [],
    readFileSync,
    realpathSync: (path: string) => path,
    lstatSync: (path: string) =>
      fileStat(path === app ? "app" : path === dataRoot ? "data" : "native"),
    statSync: (path: string) =>
      fileStat(path.includes("/201/") ? (fault === "runtime-file" ? "native" : "app") : "native"),
    readlinkSync: (path: string) => {
      if (path.endsWith("/ns/mnt"))
        return fault === "namespace" && path.includes("/201/") ? "mnt:[2]" : "mnt:[1]";
      if (path === "/proc/101/fd/1023") return fault === "mount-lease" ? "/foreign/mount" : mount;
      if (path === "/proc/201/fd/3") return fault === "runtime-file" ? "/foreign/AppImage" : app;
      return path.includes("/101/")
        ? executable
        : fault === "runtime-origin"
          ? "/foreign/AppImage"
          : app;
    },
  };
  const source = NodeFS.readFileSync(
    NodePath.join(import.meta.dirname, "release-visual-native-followups-owner.ts"),
    "utf8",
  );
  const functions = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(source.slice(source.indexOf("const sha =")))
      .replaceAll("export function", "function")
      .replaceAll("export async function", "async function") +
      "\n({ readNativeFollowupProcess, readNativeFollowupLinuxBinding })",
    {
      NodeFS: ports,
      NodePath: NodePath.posix,
      NodeCrypto,
      NodeProcess: { getuid: () => 1000 },
      Buffer,
      TextDecoder,
      process: { getuid: () => 1000 },
    },
  );
  return {
    read: () =>
      functions.readNativeFollowupProcess({
        platform: "linux",
        app,
        dataRoot,
        powershell: null,
        commands: {
          command: () => {
            throw new Error("No native command permitted.");
          },
        },
      }) as Promise<string>,
    cleanupBinding: () => functions.readNativeFollowupLinuxBinding(app, dataRoot, true),
    changeExecutable: () => {
      executableChanged = true;
    },
  };
}
it("joins the actual Linux process probe to one immutable input, FUSE runtime and mount lease", async () => {
  const p = processProbe();
  expect(await p.read()).toMatch(/^[a-f0-9]{64}$/);
  expect(await p.read()).toBe(await p.read());
});
it("admits only the already-owned image runtime for cleanup after its main process closed", async () => {
  const p = processProbe("native-closed");
  await expect(p.read()).rejects.toThrow();
  const binding = p.cleanupBinding();
  expect(binding.nativePid).toBeNull();
  expect(binding.nativeAlive()).toBe(false);
  expect(binding.runtimeAlive()).toBe(true);
});
it.each([
  "foreign-image",
  "uid",
  "birth-drift",
  "namespace",
  "writable-mount",
  "mount-lease",
  "runtime-origin",
  "runtime-file",
  "executable-drift",
])("refuses the actual Linux process probe's %s identity gap", async (fault) => {
  await expect(processProbe(fault).read()).rejects.toThrow();
});
it("changes the opaque process proof when the mounted executable changes between capture checks", async () => {
  const p = processProbe(),
    initial = await p.read();
  p.changeExecutable();
  expect(await p.read()).not.toBe(initial);
});
