// @effect-diagnostics nodeBuiltinImport:off - This integration test executes a real shell wrapper.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

const REPOSITORY_ROOT = NodePath.resolve(import.meta.dirname, "..");
const WRAPPER = "linuxdeploy-plugin-gstreamer.sh";
const UPSTREAM = "bibcode-linuxdeploy-gstreamer-upstream.sh";
const SCANNER = "usr/lib/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner";
const HOOK = "apprun-hooks/linuxdeploy-plugin-gstreamer.sh";
// A fake dpkg-query: plugin file names map to binary packages, binary packages to sources.
const DPKG_QUERY = `#!/bin/sh
if [ "$1" = "-S" ]; then
  case "$(basename "$2")" in
    libgstcoreelements.so) echo "libgstreamer1.0-0:arm64: $2" ;;
    libgstplayback.so) echo "gstreamer1.0-plugins-base:arm64: $2" ;;
    libgstwavparse.so) echo "gstreamer1.0-plugins-good:arm64, gstreamer1.0-pulseaudio:arm64: $2" ;;
    libgstx264.so) echo "gstreamer1.0-plugins-ugly:arm64: $2" ;;
    *) exit 1 ;;
  esac
  exit 0
fi
case "$3" in
  libgstreamer1.0-0*) printf gstreamer1.0 ;;
  gstreamer1.0-plugins-base*) printf gst-plugins-base1.0 ;;
  gstreamer1.0-plugins-good* | gstreamer1.0-pulseaudio*) printf gst-plugins-good1.0 ;;
  gstreamer1.0-plugins-ugly*) printf gst-plugins-ugly1.0 ;;
  *) exit 1 ;;
esac
`;
// A fake upstream plugin: records its call, then builds what the real one leaves behind.
const UPSTREAM_SOURCE = `#!/usr/bin/env bash
set -e
printf '%s\\n' "$*" "$GSTREAMER_PLUGINS_DIR" > "$(dirname "$0")/upstream-call"
[ "$1" = "--appdir" ] || { echo "api 0"; exit 0; }
[ -n "$SKIP_SCANNER" ] || { mkdir -p "$2/usr/lib/gstreamer1.0/gstreamer-1.0"; touch "$2/${SCANNER}"; }
mkdir -p "$2/apprun-hooks" "$2/usr/lib"
touch "$2/${HOOK}" "$2/usr/lib/libwayland-client.so.0"
`;
const temporaryDirectories: Array<string> = [];

function setUp(plugins: string[]) {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-linuxdeploy-gst-"));
  temporaryDirectories.push(directory);
  NodeFS.copyFileSync(
    NodePath.join(REPOSITORY_ROOT, "scripts/tauri", WRAPPER),
    NodePath.join(directory, WRAPPER),
  );
  NodeFS.chmodSync(NodePath.join(directory, WRAPPER), 0o755);
  NodeFS.writeFileSync(NodePath.join(directory, UPSTREAM), UPSTREAM_SOURCE, { mode: 0o755 });
  NodeFS.writeFileSync(NodePath.join(directory, "dpkg-query"), DPKG_QUERY, { mode: 0o755 });
  const pluginsDirectory = NodePath.join(directory, "plugins");
  NodeFS.mkdirSync(pluginsDirectory);
  for (const plugin of plugins) NodeFS.writeFileSync(NodePath.join(pluginsDirectory, plugin), "");
  const appdir = NodePath.join(directory, "AppDir");
  NodeFS.mkdirSync(appdir);
  return { directory, pluginsDirectory, appdir };
}

function run(directory: string, args: string[], env: Record<string, string> = {}) {
  return NodeChildProcess.spawnSync(NodePath.join(directory, WRAPPER), args, {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      PATH: `${directory}${NodePath.delimiter}${process.env.PATH ?? ""}`,
    },
    timeout: 10_000,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("BiBCode linuxdeploy GStreamer plugin wrapper", () => {
  it("bundles core, base and good plugins and removes the redeployed Wayland client", () => {
    const { directory, pluginsDirectory, appdir } = setUp([
      "libgstcoreelements.so",
      "libgstplayback.so",
      "libgstwavparse.so",
    ]);

    const result = run(directory, ["--appdir", appdir], {
      GSTREAMER_PLUGINS_DIR: pluginsDirectory,
    });

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(NodeFS.readFileSync(NodePath.join(directory, "upstream-call"), "utf8")).toBe(
      `--appdir ${appdir}\n${pluginsDirectory}\n`,
    );
    expect(NodeFS.existsSync(NodePath.join(appdir, "usr/lib/libwayland-client.so.0"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(appdir, SCANNER))).toBe(true);
  });

  it("refuses a host with a plugin outside the allowed sets before the AppDir changes", () => {
    const { directory, pluginsDirectory, appdir } = setUp(["libgstplayback.so", "libgstx264.so"]);

    const result = run(directory, ["--appdir", appdir], {
      GSTREAMER_PLUGINS_DIR: pluginsDirectory,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `${pluginsDirectory}/libgstx264.so (gstreamer1.0-plugins-ugly:arm64)`,
    );
    expect(result.stderr).not.toContain("libgstplayback.so");
    expect(NodeFS.existsSync(NodePath.join(directory, "upstream-call"))).toBe(false);
  });

  it("refuses a plugin no package owns", () => {
    const { directory, pluginsDirectory, appdir } = setUp(["libgstlocal.so"]);

    const result = run(directory, ["--appdir", appdir], {
      GSTREAMER_PLUGINS_DIR: pluginsDirectory,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("libgstlocal.so (not owned by a package)");
    expect(NodeFS.existsSync(NodePath.join(directory, "upstream-call"))).toBe(false);
  });

  it("refuses an empty plugin folder", () => {
    const { directory, pluginsDirectory, appdir } = setUp([]);

    const result = run(directory, ["--appdir", appdir], {
      GSTREAMER_PLUGINS_DIR: pluginsDirectory,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("plugin folder is empty");
  });

  it("fails when the upstream plugin leaves no plugin scanner", () => {
    const { directory, pluginsDirectory, appdir } = setUp(["libgstplayback.so"]);

    const result = run(directory, ["--appdir", appdir], {
      GSTREAMER_PLUGINS_DIR: pluginsDirectory,
      SKIP_SCANNER: "1",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`did not produce ${appdir}/${SCANNER}`);
  });

  it("passes plugin discovery through to the upstream plugin", () => {
    const { directory } = setUp([]);

    const result = run(directory, ["--plugin-api-version"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("api 0\n");
  });
});
