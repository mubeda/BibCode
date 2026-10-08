// @effect-diagnostics nodeBuiltinImport:off - Explicit inert POSIX metadata models; no host ownership or native acceptance claim.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";
import * as NodeEvents from "node:events";
import * as NodeVM from "node:vm";
import { expect, it } from "vite-plus/test";
const read = (name: string) => NodeFS.readFileSync(new URL(name, import.meta.url), "utf8");
const metadata = (directory: boolean, mode: number, uid = 1000) => ({
  dev: 1,
  ino: directory ? 10 : 20,
  uid,
  gid: uid,
  mode,
  nlink: 1,
  size: 16,
  mtimeMs: 1,
  ctimeMs: 1,
  isDirectory: () => directory,
  isFile: () => !directory,
  isSymbolicLink: () => false,
});
it.each(["owned", "permissions", "uid", "alias", "links", "bytes", "inventory"])(
  "actual backup owner keeps private byte/inventory/identity guards on all hosts: %s",
  (fault) => {
    const source = read("./release-visual-native-followups-backup.ts");
    const root = "/owned/data",
      storage = "12345678-1234-1234-1234-123456789abc",
      backup = "22345678-1234-1234-1234-123456789abc";
    const bytes = Buffer.from("inert retained generation");
    const manifest = Buffer.from(
      JSON.stringify({
        backupId: backup,
        storageInstanceId: storage,
        stateKind: "userdata",
        trigger: "pre-update",
        sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
        databaseSizeBytes: bytes.length,
      }),
    );
    let changed = false;
    const filesystem = {
      realpathSync: (value: string) => value,
      lstatSync: (value: string) => {
        const file = /\.(sqlite|json)$/.test(value);
        return {
          ...metadata(
            !file,
            file ? 0o100600 : fault === "permissions" ? 0o40755 : 0o40700,
            fault === "uid" ? 2000 : 1000,
          ),
          nlink: fault === "links" && file ? 2 : 1,
          size: file ? (value.endsWith("state.sqlite") ? bytes.length : manifest.length) : 0,
          isSymbolicLink: () => fault === "alias",
        };
      },
      readdirSync: () =>
        fault === "inventory"
          ? ["manifest.json", "state.sqlite", "unexpected"]
          : ["manifest.json", "state.sqlite"],
      readFileSync: (value: string) =>
        value.endsWith("state.sqlite") ? (changed ? Buffer.from("changed") : bytes) : manifest,
    };
    const pin = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(source.slice(source.indexOf("const uuid"))).replace(
        /^export /gm,
        "",
      ) + "\npinNativeFollowupBackup",
      {
        NodeFS: filesystem,
        NodePath: NodePath.posix,
        NodeCrypto,
        NodeProcess: { getuid: () => 1000 },
        Buffer,
      },
    );
    if (fault === "owned" || fault === "bytes") {
      const value = pin({ root, storage, backup });
      expect(() => value.verify()).not.toThrow();
      changed = fault === "bytes";
      if (changed) expect(() => value.verify()).toThrow();
    } else expect(() => pin({ root, storage, backup })).toThrow();
  },
);
it.each(["owned", "permissions", "uid", "missing-uid", "alias", "file", "long"])(
  "actual Linux session admission remains strict in inert all-host ports: %s",
  (fault) => {
    const source = read("./release-visual-native-followups-session.ts"),
      begin = source.indexOf("function createNativeFollowupsLinuxSessionRoot("),
      end = source.indexOf("export async function withNativeFollowupsLinuxSession", begin);
    let allocations = 0;
    const root = fault === "long" ? "/owned/" + "x".repeat(100) : "/owned/work";
    const filesystem = {
      realpathSync: (value: string) => value,
      lstatSync: () => ({
        ...metadata(
          fault !== "file",
          fault === "permissions" ? 0o40755 : 0o40700,
          fault === "uid" ? 2000 : 1000,
        ),
        isSymbolicLink: () => fault === "alias",
      }),
      mkdtempSync: (prefix: string) => {
        allocations++;
        return prefix + "fixed";
      },
    };
    const create = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(source.slice(begin, end)) +
        "\ncreateNativeFollowupsLinuxSessionRoot",
      {
        NodeFS: filesystem,
        NodePath: NodePath.posix,
        NodeProcess: fault === "missing-uid" ? {} : { getuid: () => 1000 },
        Buffer,
        Error,
      },
    );
    if (fault === "owned") {
      expect(create(root, () => {})).toBe("/owned/work/s-fixed");
      expect(allocations).toBe(1);
    } else {
      expect(() => create(root, () => {})).toThrow();
      expect(allocations).toBe(fault === "long" ? 1 : 0);
    }
  },
);
it.each(["owned", "public", "changed"])(
  "actual Linux installer restores its modeled permissions and exact original error: %s",
  async (fault) => {
    const source = read("./release-visual-native-followups-update.ts"),
      begin = source.indexOf("export async function withNativeFollowupInstallFailure"),
      end = source.indexOf("export interface NativeFollowupPortHold", begin);
    let mode = fault === "public" ? 0o40755 : 0o40700,
      changed = false,
      unsafe = false;
    const original = new Error("inert original callback failure");
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(source.slice(begin, end)).replace(
        "export async function",
        "async function",
      ) + "\nwithNativeFollowupInstallFailure",
      {
        NodePath: NodePath.posix,
        NodeCrypto,
        NodeFS: {
          realpathSync: (value: string) => value,
          lstatSync: () => metadata(true, mode),
          chmodSync: (_value: string, bits: number) => {
            mode = 0o40000 | bits;
          },
          readFileSync: () => Buffer.from(changed ? "changed" : "inert"),
        },
      },
    );
    if (fault === "public")
      await expect(
        run(
          {
            laneRoot: "/owned",
            app: "/owned/installed/BiBCode.AppImage",
            platform: "linux",
            unsafe: () => {
              unsafe = true;
            },
          },
          async () => {},
        ),
      ).rejects.toThrow();
    else {
      await expect(
        run(
          {
            laneRoot: "/owned",
            app: "/owned/installed/BiBCode.AppImage",
            platform: "linux",
            unsafe: () => {
              unsafe = true;
            },
          },
          async () => {
            changed = fault === "changed";
            throw original;
          },
        ),
      ).rejects.toBe(original);
      expect(mode & 0o777).toBe(0o700);
      expect(unsafe).toBe(fault === "changed");
    }
  },
);

it.each(["exit-tail-close", "exit-close-tail"])(
  "actual command owner settles only on close under controlled all-host stdio: %s",
  async (order) => {
    const source = NodeFS.readFileSync(
      new URL("../../../../scripts/seeded-desktop-upgrade-smoke.ts", import.meta.url),
      "utf8",
    );
    const begin = source.indexOf("export const runBoundedCommand ="),
      end = source.indexOf("const runCommand = runBoundedCommand", begin);
    expect(begin).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(begin);
    const child = Object.assign(new NodeEvents.EventEmitter(), {
      stdout: new NodeEvents.EventEmitter(),
      stderr: new NodeEvents.EventEmitter(),
    });
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(source.slice(begin, end)).replace(/^export /gm, "") +
        "\nrunBoundedCommand",
      {
        NodeChildProcess: { spawn: () => child },
        observeOwnedChildClose: () => {},
        process: { env: {} },
        NodePath: NodePath.posix,
      },
    );
    let settled = false;
    const pending = run({ command: "inert", args: [], cwd: "/inert" }).then(
      (value: { stdout: string; exitCode: number }) => {
        settled = true;
        return value;
      },
    );
    child.stdout.emit("data", Buffer.from("early|"));
    child.emit("exit", 0);
    await Promise.resolve();
    expect(settled).toBe(false);
    if (order === "exit-tail-close") {
      child.stdout.emit("data", Buffer.from("late-tail"));
      child.emit("close", 0);
    } else {
      child.emit("close", 0);
      child.stdout.emit("data", Buffer.from("late-tail"));
    }
    const result = await pending;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(order === "exit-tail-close" ? "early|late-tail" : "early|");
  },
);
