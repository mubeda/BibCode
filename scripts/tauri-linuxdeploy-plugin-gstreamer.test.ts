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
// A fake dpkg-query. It rejects an unescaped glob like the real one would match it, and the
// FAKE_* variables name one plugin whose ownership answer is wrong in a specific way.
const DPKG_QUERY = `#!/usr/bin/env bash
if [ "$1" = "-S" ]; then
  case "$2" in *'\\['*) ;; *'['*) exit 1 ;; esac
  path="$(printf '%s' "$2" | sed 's/\\\\\\(.\\)/\\1/g')"
  name="$(basename "$path")"
  case "$name" in
    "$FAKE_UNOWNED") exit 1 ;;
    "$FAKE_FOREIGN") echo "gstreamer1.0-plugins-bad:arm64: $path"; exit 0 ;;
    "$FAKE_SHARED") echo "gstreamer1.0-plugins-good:arm64, other-package:arm64: $path"; exit 0 ;;
    "$FAKE_OTHER_PATH") echo "gstreamer1.0-plugins-good:arm64: $path.other"; exit 0 ;;
    "$FAKE_TWO_LINES") printf 'gstreamer1.0-plugins-good:arm64: %s\\nother:arm64: %s\\n' "$path" "$path"; exit 0 ;;
    libgstcoreelements.so) echo "libgstreamer1.0-0:arm64: $path" ;;
    libgstalsa.so) echo "gstreamer1.0-alsa:arm64: $path" ;;
    libgstplayback.so | libgsttypefindfunctions.so | libgstapp.so | libgstaudioconvert.so | \\
      libgstaudioresample.so | libgstvolume.so | libgstogg.so | libgstvorbis.so | libgstopus.so)
      echo "gstreamer1.0-plugins-base:arm64: $path" ;;
    *) echo "gstreamer1.0-plugins-good:arm64: $path" ;;
  esac
  exit 0
fi
case "$3" in
  libgstreamer1.0-0*) printf gstreamer1.0 ;;
  gstreamer1.0-plugins-base* | gstreamer1.0-alsa*) printf gst-plugins-base1.0 ;;
  gstreamer1.0-plugins-good*) printf gst-plugins-good1.0 ;;
  gstreamer1.0-plugins-bad*) printf gst-plugins-bad1.0 ;;
  *) exit 1 ;;
esac
`;
// A fake upstream plugin: records its call, then builds what the real one leaves behind.
// The AppRun hook the pinned upstream plugin writes, byte for byte.
const UPSTREAM_HOOK = `#! /bin/bash

export GST_REGISTRY_REUSE_PLUGIN_SCANNER="no"
export GST_PLUGIN_SYSTEM_PATH_1_0="\${APPDIR}/usr/lib/gstreamer-1.0"
export GST_PLUGIN_PATH_1_0="\${APPDIR}/usr/lib/gstreamer-1.0"

export GST_PLUGIN_SCANNER_1_0="\${APPDIR}/usr/lib/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner"
export GST_PTP_HELPER_1_0="\${APPDIR}/usr/lib/gstreamer1.0/gstreamer-1.0/gst-ptp-helper"
`;
const UPSTREAM_SOURCE = `#!/usr/bin/env bash
set -e
printf '%s\\n' "$*" > "$(dirname "$0")/upstream-call"
[ "$1" = "--appdir" ] || { echo "api 0"; exit 0; }
mkdir -p "$2/usr/lib/gstreamer-1.0" "$2/apprun-hooks"
cp "$GSTREAMER_PLUGINS_DIR"/* "$2/usr/lib/gstreamer-1.0/"
[ -z "$EXTRA_PLUGIN" ] || touch "$2/usr/lib/gstreamer-1.0/$EXTRA_PLUGIN"
[ -n "$SKIP_SCANNER" ] || { mkdir -p "$2/usr/lib/gstreamer1.0/gstreamer-1.0"; touch "$2/${SCANNER}"; }
touch "$2/usr/lib/libwayland-client.so.0"
cat > "$2/${HOOK}" <<\\EOF
${UPSTREAM_HOOK}EOF
[ -z "$DRIFT_HOOK" ] || sed -i.bak '/GST_PTP_HELPER_1_0/d' "$2/${HOOK}"
`;
const temporaryDirectories: Array<string> = [];

function allowlist(): string[] {
  const result = NodeChildProcess.spawnSync(
    "bash",
    [NodePath.join(REPOSITORY_ROOT, "scripts/tauri", WRAPPER), "--list-plugins"],
    { encoding: "utf8" },
  );
  return result.stdout.trim().split("\n");
}

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
  // A glob character in the folder name proves the ownership lookup is escaped.
  const pluginsDirectory = NodePath.join(directory, "host plugins [x]");
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

function bundledPlugins(appdir: string): string[] {
  return NodeFS.readdirSync(NodePath.join(appdir, "usr/lib/gstreamer-1.0")).toSorted();
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

// oxlint-disable-next-line bibcode/no-global-process-runtime -- Requires a Unix shell.
describe.skipIf(process.platform === "win32")(
  "BiBCode linuxdeploy GStreamer plugin wrapper",
  () => {
    it("bundles exactly the allowlist, leaving other host plugins out", () => {
      const plugins = allowlist();
      const { directory, pluginsDirectory, appdir } = setUp([
        ...plugins,
        "libgstx264.so",
        "libgstlame.so",
      ]);

      const result = run(directory, ["--appdir", appdir], {
        GSTREAMER_PLUGINS_DIR: pluginsDirectory,
      });

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(bundledPlugins(appdir)).toEqual(plugins.toSorted());
      expect(NodeFS.readFileSync(NodePath.join(directory, "upstream-call"), "utf8")).toBe(
        `--appdir ${appdir}\n`,
      );
      expect(NodeFS.existsSync(NodePath.join(appdir, "usr/lib/libwayland-client.so.0"))).toBe(
        false,
      );
    });

    it("names a missing allowlisted plugin before the AppDir changes", () => {
      const plugins = allowlist().filter((plugin) => plugin !== "libgstmpg123.so");
      const { directory, pluginsDirectory, appdir } = setUp(plugins);

      const result = run(directory, ["--appdir", appdir], {
        GSTREAMER_PLUGINS_DIR: pluginsDirectory,
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`libgstmpg123.so: missing from ${pluginsDirectory}`);
      expect(NodeFS.existsSync(NodePath.join(directory, "upstream-call"))).toBe(false);
    });

    for (const [variable, message] of [
      ["FAKE_UNOWNED", "libgstflac.so: not owned by exactly one package (no owner)"],
      ["FAKE_OTHER_PATH", "libgstflac.so: not owned by exactly one package"],
      ["FAKE_TWO_LINES", "libgstflac.so: not owned by exactly one package"],
      ["FAKE_SHARED", "libgstflac.so: owned by more than one package"],
      ["FAKE_FOREIGN", "libgstflac.so: from source package 'gst-plugins-bad1.0'"],
    ] as const) {
      it(`refuses an allowlisted plugin with a bad ownership answer (${variable})`, () => {
        const { directory, pluginsDirectory, appdir } = setUp(allowlist());

        const result = run(directory, ["--appdir", appdir], {
          GSTREAMER_PLUGINS_DIR: pluginsDirectory,
          [variable]: "libgstflac.so",
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain(message);
        expect(NodeFS.existsSync(NodePath.join(directory, "upstream-call"))).toBe(false);
      });
    }

    it("fails when the bundled plugin folder differs from the allowlist", () => {
      const { directory, pluginsDirectory, appdir } = setUp(allowlist());

      const result = run(directory, ["--appdir", appdir], {
        GSTREAMER_PLUGINS_DIR: pluginsDirectory,
        EXTRA_PLUGIN: "libgstextra.so",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("differ from the allowlist");
      expect(result.stderr).toContain("libgstextra.so");
    });

    it("fails when the upstream plugin leaves no plugin scanner", () => {
      const { directory, pluginsDirectory, appdir } = setUp(allowlist());

      const result = run(directory, ["--appdir", appdir], {
        GSTREAMER_PLUGINS_DIR: pluginsDirectory,
        SKIP_SCANNER: "1",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`did not produce ${appdir}/${SCANNER}`);
    });

    for (const [label, appdirValue] of [
      ["the AppImage's own APPDIR", "own"],
      ["no APPDIR", undefined],
      ["another AppImage's APPDIR", "/tmp/.mount_otherX"],
    ] as const) {
      it(`roots the GStreamer hook at its own AppDir with ${label}`, () => {
        const { directory, pluginsDirectory, appdir } = setUp(allowlist());
        expect(
          run(directory, ["--appdir", appdir], { GSTREAMER_PLUGINS_DIR: pluginsDirectory }).status,
        ).toBe(0);
        const realAppdir = NodeFS.realpathSync(appdir);
        const env: Record<string, string | undefined> = { ...process.env };
        delete env.APPDIR;
        if (appdirValue !== undefined)
          env.APPDIR = appdirValue === "own" ? realAppdir : appdirValue;

        // Source it the way linuxdeploy's AppRun does, then print what it exported.
        const result = NodeChildProcess.spawnSync(
          "bash",
          [
            "-c",
            'source "$1"; printf "%s\\n" "$GST_PLUGIN_SYSTEM_PATH_1_0" "$GST_PLUGIN_PATH_1_0" "$GST_PLUGIN_SCANNER_1_0" "$GST_PTP_HELPER_1_0" "$GST_REGISTRY_REUSE_PLUGIN_SCANNER" "$APPDIR"',
            "bash",
            NodePath.join(appdir, HOOK),
          ],
          { encoding: "utf8", env },
        );

        expect(result.stderr).toBe("");
        expect(result.stdout.split("\n").slice(0, 6)).toEqual([
          `${realAppdir}/usr/lib/gstreamer-1.0`,
          `${realAppdir}/usr/lib/gstreamer-1.0`,
          `${realAppdir}/usr/lib/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner`,
          `${realAppdir}/usr/lib/gstreamer1.0/gstreamer-1.0/gst-ptp-helper`,
          "no",
          // The hook leaves APPDIR itself alone.
          env.APPDIR ?? "",
        ]);
      });
    }

    it("fails without rewriting when the upstream GStreamer hook drifts", () => {
      const { directory, pluginsDirectory, appdir } = setUp(allowlist());

      const result = run(directory, ["--appdir", appdir], {
        GSTREAMER_PLUGINS_DIR: pluginsDirectory,
        DRIFT_HOOK: "1",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("GST_PTP_HELPER_1_0");
      expect(NodeFS.readFileSync(NodePath.join(appdir, HOOK), "utf8")).toContain("${APPDIR}");
    });

    it("passes plugin discovery through to the upstream plugin", () => {
      const { directory } = setUp([]);

      const result = run(directory, ["--plugin-api-version"]);

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("api 0\n");
    });
  },
);
