// @effect-diagnostics nodeBuiltinImport:off - Private TempFS and inert proc/command ports never alter host namespaces.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { bindNativeSharingHostNetwork } from "./release-visual-native-sharing-host.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) NodeFS.rmSync(root, { recursive: true, force: true });
});
function fixture(mode = "owned") {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "native-sharing-host-")),
  );
  roots.push(root);
  const evidence = NodePath.join(root, "evidence"),
    fixture = NodePath.join(root, "fixture");
  for (const directory of [evidence, fixture]) NodeFS.mkdirSync(directory, { mode: 0o700 });
  for (const name of ["python", "helper", "ip", "app.AppImage"])
    NodeFS.writeFileSync(NodePath.join(root, name), "inert immutable input " + name, {
      mode: 0o500,
    });
  const environment = {
    CI: "true",
    BIBCODE_UPLOAD_HOST_NETNS: "net:[1]",
    BIBCODE_UPLOAD_NETNS: "net:[2]",
    BIBCODE_UPLOAD_PIDNS: "pid:[3]",
    BIBCODE_UPLOAD_USERNS: "user:[4]",
    BIBCODE_UPLOAD_PYTHON: NodePath.join(root, "python"),
    BIBCODE_UPLOAD_NETWORK_HELPER: NodePath.join(root, "helper"),
    BIBCODE_UPLOAD_IP: NodePath.join(root, "ip"),
    BIBCODE_UPLOAD_EVIDENCE: evidence,
    BIBCODE_UPLOAD_FIXTURE: fixture,
    BIBCODE_UPLOAD_SOURCE: "a".repeat(40),
    BIBCODE_NATIVE_SHARING_APP: NodePath.join(root, "app.AppImage"),
  };
  const argv = [
    environment.BIBCODE_UPLOAD_PYTHON,
    environment.BIBCODE_UPLOAD_NETWORK_HELPER,
    "inner",
    evidence,
    fixture,
    "/owned/node",
    "/owned/server",
    "/owned/chrome",
    "/owned/driver",
    "/owned/git",
    "/owned/dirname",
    "net:[1]",
    "a".repeat(40),
    environment.BIBCODE_UPLOAD_IP,
    "release-visual-native-sharing",
    environment.BIBCODE_NATIVE_SHARING_APP,
  ];
  const calls: string[][] = [];
  let changed = false;
  const ports = {
    readFile: async (path: string): Promise<Buffer> => {
      if (path === "/proc/1/cmdline") return Buffer.from(argv.join("\0") + "\0");
      if (path === "/proc/self/status") return Buffer.from("CapEff:\t0000000000001000\n");
      return NodeFS.readFileSync(path);
    },
    readlink: async (path: string) => {
      const kind = path.split("/").at(-1)!;
      return mode === "namespace-drift" && changed
        ? "net:[9]"
        : ({ net: "net:[2]", pid: "pid:[3]", user: "user:[4]" } as Record<string, string>)[kind]!;
    },
    realpath: async (path: string) => NodeFS.realpathSync(path),
    stat: async (path: string) => NodeFS.lstatSync(path),
    uid: () => process.getuid!(),
    run: async (command: string, args: readonly string[]) => {
      expect(command).toBe(environment.BIBCODE_UPLOAD_IP);
      calls.push([...args]);
      return { exitCode: 0, reaped: true, timedOut: false, stdout: "[]" };
    },
    unsafeCleanup: () => {},
  };
  return {
    root,
    environment,
    argv,
    ports,
    calls,
    change: () => {
      changed = true;
    },
  };
}
it("binds the route adapter to the exact visible PID1, private inputs and pinned ip bytes", async () => {
  const f = fixture();
  const input = await bindNativeSharingHostNetwork(
    { environment: f.environment, platform: "linux" },
    f.ports,
  );
  expect(input.ip).toBe(f.environment.BIBCODE_UPLOAD_IP);
  expect(await input.verifyExecutable()).toBe(true);
  expect(await input.readNamespace("1", "net")).toBe("net:[2]");
  expect(await input.run(["-j", "-4", "route", "show", "table", "main"])).toEqual({
    exitCode: 0,
    reaped: true,
    timedOut: false,
    stdout: "[]",
  });
});
it("binds PID1 interpreter/helper argv through their real canonical files, as the existing owner launches them", async () => {
  const f = fixture();
  f.argv[0] = NodePath.relative(process.cwd(), f.environment.BIBCODE_UPLOAD_PYTHON);
  f.argv[1] = NodePath.relative(process.cwd(), f.environment.BIBCODE_UPLOAD_NETWORK_HELPER);
  const input = await bindNativeSharingHostNetwork(
    { environment: f.environment, platform: "linux" },
    f.ports,
  );
  expect(await input.verifyExecutable()).toBe(true);
});
it.each([
  "foreign-scenario",
  "extra-argument",
  "empty-argument",
  "source",
  "fixture",
  "host-net",
  "ip",
  "app",
])("refuses an unbound visible PID1 before any command: %s", async (mode) => {
  const f = fixture();
  if (mode === "foreign-scenario") f.argv[14] = "release-visual-core";
  else if (mode === "extra-argument") f.argv.push("private");
  else if (mode === "empty-argument") f.argv.push("");
  else
    f.argv[
      ({ source: 12, fixture: 4, "host-net": 11, ip: 13, app: 15 } as Record<string, number>)[mode]!
    ] = "private";
  await expect(
    bindNativeSharingHostNetwork({ environment: f.environment, platform: "linux" }, f.ports),
  ).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});
it.each(["ci", "platform", "same-host-net", "public-root", "symlink", "writable-ip"])(
  "refuses unsafe admission without spawning or modifying anything: %s",
  async (mode) => {
    const f = fixture();
    let platform = "linux";
    if (mode === "ci") f.environment.CI = "false";
    if (mode === "platform") platform = "darwin";
    if (mode === "same-host-net") f.environment.BIBCODE_UPLOAD_HOST_NETNS = "net:[2]";
    if (mode === "public-root") NodeFS.chmodSync(f.environment.BIBCODE_UPLOAD_FIXTURE, 0o755);
    if (mode === "writable-ip") NodeFS.chmodSync(f.environment.BIBCODE_UPLOAD_IP, 0o777);
    if (mode === "symlink") {
      NodeFS.renameSync(f.environment.BIBCODE_NATIVE_SHARING_APP, NodePath.join(f.root, "other"));
      NodeFS.symlinkSync(NodePath.join(f.root, "other"), f.environment.BIBCODE_NATIVE_SHARING_APP);
    }
    await expect(
      bindNativeSharingHostNetwork({ environment: f.environment, platform }, f.ports),
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  },
);
it.each(["namespace", "owner", "ip-bytes", "app-bytes"])(
  "rechecks live ownership and immutable executable inputs before a route command: %s",
  async (mode) => {
    const f = fixture(mode === "namespace" ? "namespace-drift" : "owned");
    const input = await bindNativeSharingHostNetwork(
      { environment: f.environment, platform: "linux" },
      f.ports,
    );
    if (mode === "namespace") f.change();
    if (mode === "owner") f.argv[14] = "private";
    if (mode === "ip-bytes" || mode === "app-bytes") {
      const path =
        mode === "ip-bytes"
          ? f.environment.BIBCODE_UPLOAD_IP
          : f.environment.BIBCODE_NATIVE_SHARING_APP;
      NodeFS.chmodSync(path, 0o700);
      NodeFS.writeFileSync(path, "changed");
      NodeFS.chmodSync(path, 0o500);
    }
    await expect(
      input.run(["route", "del", "default", "via", "10.254.231.2", "dev", "bcup-in"]),
    ).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
  },
);
it.each([
  ["route", "flush", "table", "main"],
  ["route", "del", "default"],
  ["-j", "link", "show"],
  ["route", "add", "default", "via", "10.0.0.1", "dev", "eth0"],
])("refuses commands outside the finite read/delete/restore contract: %j", async (...args) => {
  const f = fixture();
  const input = await bindNativeSharingHostNetwork(
    { environment: f.environment, platform: "linux" },
    f.ports,
  );
  await expect(input.run(args)).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});
