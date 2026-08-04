// @effect-diagnostics nodeBuiltinImport:off - This integration test executes a real shell wrapper.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

const REPOSITORY_ROOT = NodePath.resolve(import.meta.dirname, "..");
const WRAPPER_SOURCE = NodePath.join(REPOSITORY_ROOT, "scripts/tauri/linuxdeploy-plugin-gtk.sh");
const UPSTREAM_FILENAME = "bibcode-linuxdeploy-gtk-upstream.sh";
const temporaryDirectories: Array<string> = [];

function makeToolDirectory(): string {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bibcode-linuxdeploy-gtk-"));
  temporaryDirectories.push(directory);
  NodeFS.copyFileSync(WRAPPER_SOURCE, NodePath.join(directory, "linuxdeploy-plugin-gtk.sh"));
  NodeFS.chmodSync(NodePath.join(directory, "linuxdeploy-plugin-gtk.sh"), 0o755);
  return directory;
}

function writeUpstream(directory: string, source: string): void {
  const path = NodePath.join(directory, UPSTREAM_FILENAME);
  NodeFS.writeFileSync(path, source, { mode: 0o755 });
  NodeFS.chmodSync(path, 0o755);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

// oxlint-disable-next-line bibcode/no-global-process-runtime -- This integration test runs a Linux shell wrapper.
describe.runIf(process.platform === "linux")("linuxdeploy GTK wrapper", () => {
  it.each(["separate", "equals"] as const)(
    "normalizes the %s AppDir argument form before deployment and cleans the AppDir",
    (argumentForm) => {
      const toolDirectory = makeToolDirectory();
      const appDirectory = NodePath.join(toolDirectory, "BiBCode.AppDir");
      const markerPath = NodePath.join(toolDirectory, "upstream-arguments.txt");
      writeUpstream(
        toolDirectory,
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" > "$FAKE_PLUGIN_MARKER"
appdir=""
while (( $# > 0 )); do
  case "$1" in
    --appdir)
      if (( $# < 2 )); then
        printf '%s\\n' 'missing --appdir path' >&2
        exit 64
      fi
      appdir="$2"
      shift 2
      ;;
    --appdir=*)
      printf '%s\\n' 'unsupported --appdir=<path> argument' >&2
      exit 64
      ;;
    *)
      shift
      ;;
  esac
done
mkdir -p "$appdir/usr/lib/x86_64-linux-gnu"
printf 'bundled wayland' > "$appdir/usr/lib/x86_64-linux-gnu/libwayland-client.so.0"
ln -s libwayland-client.so.0 "$appdir/usr/lib/x86_64-linux-gnu/libwayland-client.so"
printf 'keep me' > "$appdir/usr/lib/x86_64-linux-gnu/libunrelated.so.1"
`,
      );
      const appdirArguments =
        argumentForm === "separate" ? ["--appdir", appDirectory] : [`--appdir=${appDirectory}`];

      const result = NodeChildProcess.spawnSync(
        NodePath.join(toolDirectory, "linuxdeploy-plugin-gtk.sh"),
        [...appdirArguments, "--output", "appimage"],
        {
          encoding: "utf8",
          env: { ...process.env, FAKE_PLUGIN_MARKER: markerPath },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(NodeFS.readFileSync(markerPath, "utf8")).toBe(
        `--appdir\n${appDirectory}\n--output\nappimage\n`,
      );
      expect(
        NodeFS.existsSync(
          NodePath.join(appDirectory, "usr/lib/x86_64-linux-gnu/libwayland-client.so.0"),
        ),
      ).toBe(false);
      expect(
        NodeFS.existsSync(
          NodePath.join(appDirectory, "usr/lib/x86_64-linux-gnu/libwayland-client.so"),
        ),
      ).toBe(false);
      expect(
        NodeFS.readFileSync(
          NodePath.join(appDirectory, "usr/lib/x86_64-linux-gnu/libunrelated.so.1"),
          "utf8",
        ),
      ).toBe("keep me");
    },
  );

  it("preserves plugin discovery output when no AppDir argument is present", () => {
    const toolDirectory = makeToolDirectory();
    writeUpstream(
      toolDirectory,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "--plugin-api-version" ]]; then
  printf '0\\n'
  exit 0
fi
exit 91
`,
    );

    const result = NodeChildProcess.spawnSync(
      NodePath.join(toolDirectory, "linuxdeploy-plugin-gtk.sh"),
      ["--plugin-api-version"],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("0\n");
  });

  it("propagates an upstream failure without mutating the AppDir", () => {
    const toolDirectory = makeToolDirectory();
    const appDirectory = NodePath.join(toolDirectory, "BiBCode.AppDir");
    const libraryPath = NodePath.join(appDirectory, "usr/lib/libwayland-client.so.0");
    NodeFS.mkdirSync(NodePath.dirname(libraryPath), { recursive: true });
    NodeFS.writeFileSync(libraryPath, "preexisting");
    writeUpstream(toolDirectory, "#!/usr/bin/env bash\nexit 23\n");

    const result = NodeChildProcess.spawnSync(
      NodePath.join(toolDirectory, "linuxdeploy-plugin-gtk.sh"),
      [`--appdir=${appDirectory}`],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(23);
    expect(NodeFS.readFileSync(libraryPath, "utf8")).toBe("preexisting");
  });
});
