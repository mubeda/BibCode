// @effect-diagnostics nodeBuiltinImport:off - Read-only CI source and immutable-input admission; private paths are never projected.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { nativeFollowupScenes } from "./release-visual-native-followups.ts";

export interface NativeFollowupFilePin {
  readonly path: string;
  readonly kind: "source" | "executable";
  readonly identity: string;
  readonly sha256: string;
}
const identity = (stat: NodeFS.Stats) =>
  [stat.dev, stat.ino, stat.uid, stat.mode, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(
    ":",
  );
export function pinNativeFollowupFile(
  path: string,
  kind: NativeFollowupFilePin["kind"],
): NativeFollowupFilePin {
  const stat = NodeFS.lstatSync(path),
    refused = () => new Error("Native follow-up immutable input refused.");
  if (
    !NodePath.isAbsolute(path) ||
    NodeFS.realpathSync(path) !== path ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size < 1 ||
    stat.size > 512 * 1024 ** 2 ||
    (stat.mode & 0o222) !== 0 ||
    (kind === "executable" && (stat.mode & 0o111) === 0)
  )
    throw refused();
  const bytes = NodeFS.readFileSync(path),
    after = NodeFS.lstatSync(path);
  if (identity(stat) !== identity(after)) throw refused();
  return Object.freeze({
    path,
    kind,
    identity: identity(stat),
    sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
  });
}
export function verifyNativeFollowupFile(pin: NativeFollowupFilePin): void {
  const now = pinNativeFollowupFile(pin.path, pin.kind);
  if (now.identity !== pin.identity || now.sha256 !== pin.sha256)
    throw new Error("Native follow-up immutable input changed.");
}
const sourcePaths = [
  "apps/web/src/components/Sidebar.tsx",
  "apps/web/src/components/sidebar/sidebarMenus.logic.ts",
  "apps/desktop/src-tauri/src/context_menu.rs",
  "apps/desktop/src-tauri/src/linux_theme.rs",
  "apps/web/src/components/desktop/UpdateProtectionDialog.tsx",
  "apps/web/src/components/settings/SettingsPanels.tsx",
  "apps/desktop/src-tauri/src/updates.rs",
  "apps/web/src/AppRoot.tsx",
  "apps/web/src/tauriPreviewBridge.ts",
  "apps/web/src/components/preview/PreviewView.tsx",
  "apps/web/src/browser/BrowserDeviceToolbar.tsx",
  "apps/web/src/components/chat/ComposerPendingElementContexts.tsx",
  "apps/web/src/components/chat/ComposerPreviewAnnotationCards.tsx",
  "apps/web/src/components/settings/LocalEnvironmentSettings.tsx",
  "apps/web/src/tauriDesktopBridge.ts",
  "packages/contracts/src/ipc.ts",
  "scripts/seeded-desktop-upgrade-smoke.ts",
  ".github/workflows/desktop-upgrade-smoke.yml",
  ".github/workflows/desktop-ui-smoke.yml",
  "docs/testing/cross-platform-validation.md",
  "docs/testing/linux-desktop.md",
  "docs/testing/windows-desktop.md",
  "docs/testing/macos-desktop.md",
  "docs/operations/release.md",
] as const;
/** Source evidence establishes prerequisites only. It cannot establish a live native pass. */
export function inspectNativeFollowupsPreparation(root: string) {
  if (sourcePaths.some((path) => !NodeFS.existsSync(NodePath.join(root, path))))
    throw new Error("Native follow-up current source inventory incomplete.");
  const sources = sourcePaths.map((path) => ({
    path,
    sha256: NodeCrypto.createHash("sha256")
      .update(NodeFS.readFileSync(NodePath.join(root, path)))
      .digest("hex"),
  }));
  const bridge = NodeFS.readFileSync(
      NodePath.join(root, "apps/web/src/tauriPreviewBridge.ts"),
      "utf8",
    ),
    pickerUnavailable = /pickElement:\s*unsupported/.test(bridge) && /picker:\s*false/.test(bridge);
  return Object.freeze({
    schemaVersion: 1,
    selection: "release-visual-native-followups",
    rowCount: 5,
    originalCount: 10,
    ready: false,
    sources,
    rows: nativeFollowupScenes.map((scene) => ({
      scene,
      status: "unavailable",
      blockers:
        scene === "native-menu-theme"
          ? [
              "native-ci-system-theme-observation-pending",
              "native-ci-original-menu-observation-pending",
            ]
          : scene === "native-update-protection"
            ? ["native-ci-ephemeral-signed-updater-observation-pending"]
            : scene === "native-update-recovery"
              ? ["native-ci-installer-failure-port-hold-observation-pending"]
              : scene === "native-preview-annotations"
                ? [
                    pickerUnavailable
                      ? "production-native-picker-unsupported"
                      : "actual-child-webview-picker-observation-pending",
                  ]
                : ["native-ci-real-mapped-wsl-observation-pending"],
    })),
  });
}
