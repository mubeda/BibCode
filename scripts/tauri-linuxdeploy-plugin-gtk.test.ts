// @effect-diagnostics nodeBuiltinImport:off - This integration test executes a real shell wrapper.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

const REPOSITORY_ROOT = NodePath.resolve(import.meta.dirname, "..");
const WRAPPER_SOURCE = NodePath.join(REPOSITORY_ROOT, "scripts/tauri/linuxdeploy-plugin-gtk.sh");
const UPSTREAM_FILENAME = "bibcode-linuxdeploy-gtk-upstream.sh";
const UPSTREAM_BACKEND_LINE =
  "export GDK_BACKEND=x11 # Crash with Wayland backend on Wayland - https://github.com/tauri-apps/tauri/issues/8541";
const BACKEND_LINE = 'export GDK_BACKEND="${BIBCODE_GDK_BACKEND:-wayland,x11}"';
const UPSTREAM_HOOK = `#!/usr/bin/env bash
export GTK_DATA_PREFIX="$APPDIR/usr"
${UPSTREAM_BACKEND_LINE}

export GTK_THEME="Adwaita"
`;
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
mkdir -p "$appdir/apprun-hooks"
cat > "$appdir/apprun-hooks/linuxdeploy-plugin-gtk.sh" <<'HOOK'
${UPSTREAM_HOOK}HOOK
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
      const hook = NodeFS.readFileSync(
        NodePath.join(appDirectory, "apprun-hooks/linuxdeploy-plugin-gtk.sh"),
        "utf8",
      );
      expect(hook.split("\n").filter((line) => line === BACKEND_LINE)).toHaveLength(1);
      expect(hook).toBe(UPSTREAM_HOOK.replace(UPSTREAM_BACKEND_LINE, BACKEND_LINE));
    },
  );

  it("rewrites the hook even when the AppDir has no library directories", () => {
    const toolDirectory = makeToolDirectory();
    const appDirectory = NodePath.join(toolDirectory, "BiBCode.AppDir");
    const hookPath = NodePath.join(appDirectory, "apprun-hooks/linuxdeploy-plugin-gtk.sh");
    NodeFS.mkdirSync(NodePath.dirname(hookPath), { recursive: true });
    NodeFS.writeFileSync(hookPath, UPSTREAM_HOOK);
    writeUpstream(toolDirectory, "#!/usr/bin/env bash\nexit 0\n");

    const result = NodeChildProcess.spawnSync(
      NodePath.join(toolDirectory, "linuxdeploy-plugin-gtk.sh"),
      ["--appdir", appDirectory],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(NodeFS.readFileSync(hookPath, "utf8")).toBe(
      UPSTREAM_HOOK.replace(UPSTREAM_BACKEND_LINE, BACKEND_LINE),
    );
  });

  it.each([
    { name: "missing", hook: undefined, diagnostic: "missing GTK AppRun hook" },
    {
      name: "without the X11 export",
      hook: UPSTREAM_HOOK.replace(UPSTREAM_BACKEND_LINE, "# No backend override"),
      diagnostic: "found 0",
    },
    {
      name: "with duplicate X11 exports",
      hook: `${UPSTREAM_HOOK}${UPSTREAM_BACKEND_LINE}\n`,
      diagnostic: "found 2",
    },
  ])("rejects a hook $name without mutating the AppDir", ({ hook, diagnostic }) => {
    const toolDirectory = makeToolDirectory();
    const appDirectory = NodePath.join(toolDirectory, "BiBCode.AppDir");
    const hookPath = NodePath.join(appDirectory, "apprun-hooks/linuxdeploy-plugin-gtk.sh");
    const libraryDirectory = NodePath.join(appDirectory, "usr/lib");
    NodeFS.mkdirSync(libraryDirectory, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(libraryDirectory, "libwayland-client.so.0"), "preexisting");
    NodeFS.symlinkSync(
      "libwayland-client.so.0",
      NodePath.join(libraryDirectory, "libwayland-client.so"),
    );
    NodeFS.writeFileSync(NodePath.join(libraryDirectory, "libunrelated.so.1"), "keep me");
    NodeFS.mkdirSync(NodePath.dirname(hookPath), { recursive: true });
    if (hook !== undefined) NodeFS.writeFileSync(hookPath, hook);
    writeUpstream(toolDirectory, "#!/usr/bin/env bash\nexit 0\n");
    const entriesBefore = NodeFS.readdirSync(appDirectory, { recursive: true }).sort();

    const result = NodeChildProcess.spawnSync(
      NodePath.join(toolDirectory, "linuxdeploy-plugin-gtk.sh"),
      ["--appdir", appDirectory],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("BiBCode AppImage packaging error");
    expect(result.stderr).toContain(diagnostic);
    expect(result.stderr).toContain(hookPath);
    expect(NodeFS.readdirSync(appDirectory, { recursive: true }).sort()).toEqual(entriesBefore);
    expect(
      NodeFS.readFileSync(NodePath.join(libraryDirectory, "libwayland-client.so.0"), "utf8"),
    ).toBe("preexisting");
    expect(NodeFS.readlinkSync(NodePath.join(libraryDirectory, "libwayland-client.so"))).toBe(
      "libwayland-client.so.0",
    );
    expect(NodeFS.readFileSync(NodePath.join(libraryDirectory, "libunrelated.so.1"), "utf8")).toBe(
      "keep me",
    );
    if (hook !== undefined) expect(NodeFS.readFileSync(hookPath, "utf8")).toBe(hook);
  });

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
