// @effect-diagnostics nodeBuiltinImport:off - CI-only private D-Bus/GTK portal session, with owned process groups and finite private logs.
// @effect-diagnostics globalTimers:off - Every session child has bounded readiness and joined teardown.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { bounded } from "./qualification-owner.ts";
import { NativeFollowupCommandOwner } from "./release-visual-native-followups-process.ts";
export async function withNativeFollowupsLinuxSession<A>(
  input: { environment: NodeJS.ProcessEnv; root: string; platform: string },
  run: (environment: NodeJS.ProcessEnv) => Promise<A>,
): Promise<A> {
  if (
    input.platform !== "linux" ||
    input.environment.CI !== "true" ||
    input.environment.GITHUB_ACTIONS !== "true" ||
    !input.environment.DISPLAY ||
    !NodePath.isAbsolute(input.root) ||
    NodeFS.existsSync(input.root)
  )
    throw new Error("Native follow-up private OS session refused.");
  NodeFS.mkdirSync(input.root, { mode: 0o700 });
  const home = NodePath.join(input.root, "home"),
    config = NodePath.join(input.root, "config"),
    cache = NodePath.join(input.root, "cache"),
    data = NodePath.join(input.root, "data"),
    runtime = NodePath.join(input.root, "runtime"),
    bus = NodePath.join(runtime, "bus");
  for (const path of [home, config, cache, data, runtime]) NodeFS.mkdirSync(path, { mode: 0o700 });
  const environment = {
    ...input.environment,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: cache,
    XDG_DATA_HOME: data,
    XDG_RUNTIME_DIR: runtime,
    XDG_CURRENT_DESKTOP: "GNOME",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=" + bus,
    NO_AT_BRIDGE: "0",
    GTK_THEME: "",
    APPIMAGE_GTK_THEME: "",
  };
  const children: {
    child: NodeChildProcess.ChildProcess;
    closed: Promise<void>;
    done: boolean;
    overflow: boolean;
    fd: number;
  }[] = [];
  const start = (file: string, args: string[]) => {
    const executable = NodeFS.realpathSync(file),
      stat = NodeFS.statSync(executable);
    if (!stat.isFile() || (stat.mode & 0o022) !== 0)
      throw new Error("Native follow-up session tool refused.");
    const fd = NodeFS.openSync(
        NodePath.join(input.root, "session-" + children.length + ".log"),
        "wx",
        0o600,
      ),
      child = NodeChildProcess.spawn(executable, args, {
        cwd: input.root,
        env: environment,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    let bytes = 0;
    const entry = { child, closed: Promise.resolve(), done: false, overflow: false, fd };
    children.push(entry);
    const read = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= 65536) NodeFS.writeSync(fd, chunk);
      else {
        entry.overflow = true;
        child.kill("SIGKILL");
      }
    };
    child.stdout!.on("data", read);
    child.stderr!.on("data", read);
    child.on("error", () => {
      entry.overflow = true;
    });
    entry.closed = new Promise<void>((resolve) =>
      child.once("close", () => {
        entry.done = true;
        NodeFS.closeSync(fd);
        resolve();
      }),
    );
    return entry;
  };
  let failed = false,
    original: unknown,
    value: A | undefined,
    cleanupSafe = true;
  try {
    start("/usr/bin/dbus-daemon", [
      "--session",
      "--nofork",
      "--address=" + environment.DBUS_SESSION_BUS_ADDRESS,
    ]);
    for (let attempt = 0; !NodeFS.existsSync(bus); attempt++) {
      if (attempt >= 300 || children.some((entry) => entry.done || entry.overflow))
        throw new Error("Native follow-up private bus unavailable.");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Real private settings/accessibility owners are prerequisites, never fabricated portal replies.
    const settings = new NativeFollowupCommandOwner(
      environment,
      input.root,
      () => {
        cleanupSafe = false;
      },
      "linux",
    );
    await settings.command("/usr/bin/gsettings", [
      "set",
      "org.gnome.desktop.interface",
      "toolkit-accessibility",
      "true",
    ]);
    settings.assertClosed();
    start("/usr/bin/openbox", ["--sm-disable"]);
    const xsettings = [
      "/usr/libexec/gsd-xsettings",
      "/usr/lib/gnome-settings-daemon/gsd-xsettings",
    ].find(NodeFS.existsSync);
    const accessibility = [
      "/usr/libexec/at-spi-bus-launcher",
      "/usr/lib/at-spi2-core/at-spi-bus-launcher",
    ].find(NodeFS.existsSync);
    if (!xsettings || !accessibility)
      throw new Error("Native follow-up real desktop services unavailable.");
    start(xsettings, []);
    start(accessibility, ["--launch-immediately"]);
    const backend = ["/usr/libexec/xdg-desktop-portal-gtk", "/usr/lib/xdg-desktop-portal-gtk"].find(
        NodeFS.existsSync,
      ),
      portal = ["/usr/libexec/xdg-desktop-portal", "/usr/lib/xdg-desktop-portal"].find(
        NodeFS.existsSync,
      );
    if (!backend || !portal) throw new Error("Native follow-up real GTK portal unavailable.");
    start(backend, []);
    start(portal, []);
    value = await run(environment);
    if (children.some((entry) => entry.done || entry.overflow))
      throw new Error("Native follow-up private OS session exited early.");
  } catch (error) {
    failed = true;
    original = error;
  } finally {
    for (const entry of children.toReversed()) {
      try {
        if (!entry.done && entry.child.pid) {
          // The process group is newly owned by this still-live direct child.
          const kill = entry.child.kill.bind(entry.child);
          try {
            const processModule = await import("node:process");
            processModule.kill(-entry.child.pid, "SIGTERM");
          } catch {
            kill("SIGTERM");
          }
          try {
            await bounded(entry.closed, 5000);
          } catch {
            const processModule = await import("node:process");
            try {
              processModule.kill(-entry.child.pid, "SIGKILL");
            } catch {
              kill("SIGKILL");
            }
            await bounded(entry.closed, 5000);
          }
        }
        if (!entry.done || entry.overflow) cleanupSafe = false;
      } catch {
        cleanupSafe = false;
      }
    }
    NodeFS.writeFileSync(
      NodePath.join(input.root, "cleanup.json"),
      JSON.stringify({
        childCount: children.length,
        childProcessesClosed: children.every((entry) => entry.done),
        boundedLogs: children.every((entry) => !entry.overflow),
        cleanupSafe,
      }),
      { mode: 0o600 },
    );
  }
  if (failed) throw original;
  if (!cleanupSafe) throw new Error("Native follow-up private OS cleanup unsafe.");
  return value as A;
}
