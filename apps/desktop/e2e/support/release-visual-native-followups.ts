export const nativeFollowupScenes = [
  "native-menu-theme",
  "native-update-protection",
  "native-update-recovery",
  "native-preview-annotations",
  "native-wsl-local",
] as const;
export type NativeFollowupScene = (typeof nativeFollowupScenes)[number];
export type NativeFollowupTheme = "light" | "dark";
export const nativeFollowupPrerequisites = [
  "native-system-theme",
  "native-update-ui",
  "native-preview",
  "native-wsl",
] as const;
export type NativeFollowupPrerequisite = (typeof nativeFollowupPrerequisites)[number];

export const nativeFollowupCommonWitness = [
  "nativeHost",
  "sourceMatched",
  "inputMatched",
  "mainWindowMatched",
  "storeMatched",
  "versionMatched",
  "processOwnerMatched",
  "themeMatched",
  "publicEntryMatched",
  "workPreserved",
  "pixelsSafe",
] as const;
export const nativeFollowupSceneWitness: Readonly<Record<NativeFollowupScene, readonly string[]>> =
  {
    "native-menu-theme": [
      "systemPreference",
      "osThemeMatched",
      "nativeMenuGrouped",
      "nativeMenuOriginal",
    ],
    "native-update-protection": [
      "downloadRetained",
      "protectionDefault",
      "cancelAvailable",
      "unsafeBypassAbsent",
    ],
    "native-update-recovery": [
      "backendStopped",
      "downloadRetained",
      "protectedBackupRetained",
      "draftRetained",
      "portHoldMatched",
      "restartActionAvailable",
      "retryExplained",
    ],
    "native-preview-annotations": [
      "childWebviewOwned",
      "contentOwned",
      "deviceToolbar",
      "publicPicker",
      "elementContext",
      "annotationCard",
    ],
    "native-wsl-local": [
      "nativeWindows",
      "wslAvailable",
      "mappedDistro",
      "localSettings",
      "topologyMatched",
    ],
  };
export function validateNativeFollowupWitness(
  scene: NativeFollowupScene,
  raw: unknown,
): Record<string, true> {
  if (
    !nativeFollowupScenes.includes(scene) ||
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw)
  )
    throw new Error("Native follow-up witness refused.");
  const value = raw as Record<string, unknown>,
    keys = [...nativeFollowupCommonWitness, ...nativeFollowupSceneWitness[scene]];
  if (Object.keys(value).length !== keys.length || keys.some((key) => value[key] !== true))
    throw new Error("Native follow-up witness refused.");
  return Object.freeze(Object.fromEntries(keys.map((key) => [key, true as const])));
}
export interface NativeFollowupOriginal {
  readonly scene: NativeFollowupScene;
  readonly theme: NativeFollowupTheme;
  readonly file: string;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly nonBlank: true;
}
export function validateNativeFollowupOriginal(raw: unknown): NativeFollowupOriginal {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Native follow-up original refused.");
  const value = raw as NativeFollowupOriginal,
    keys = ["scene", "theme", "file", "sha256", "width", "height", "nonBlank"];
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    !nativeFollowupScenes.includes(value.scene) ||
    !["light", "dark"].includes(value.theme) ||
    value.file !== value.scene + "-" + value.theme + ".png" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    value.width !== 1280 ||
    value.height !== 960 ||
    value.nonBlank !== true
  )
    throw new Error("Native follow-up original refused.");
  return Object.freeze({
    scene: value.scene,
    theme: value.theme,
    file: value.file,
    sha256: value.sha256,
    width: value.width,
    height: value.height,
    nonBlank: true,
  });
}
/** Capture completion remains separate from the mandatory independent original-pixel review. */
export function projectNativeFollowupResult(
  captures: readonly unknown[],
  unavailable: readonly NativeFollowupPrerequisite[],
  cleanupSafe: boolean,
) {
  if (
    captures.length > 10 ||
    unavailable.some((value) => !nativeFollowupPrerequisites.includes(value))
  )
    throw new Error("Native follow-up result refused.");
  const originals = captures.map(validateNativeFollowupOriginal),
    names = new Set(originals.map((value) => value.file));
  if (names.size !== originals.length) throw new Error("Native follow-up result refused.");
  const outstandingRowCount = nativeFollowupScenes.filter(
    (scene) => !["light", "dark"].every((theme) => names.has(scene + "-" + theme + ".png")),
  ).length;
  return Object.freeze({
    schemaVersion: 1,
    selection: "release-visual-native-followups",
    complete: originals.length === 10 && unavailable.length === 0 && cleanupSafe,
    baseRowCount: 5,
    requiredOriginalCount: 10,
    originalCount: originals.length,
    outstandingRowCount,
    prerequisiteStatus: unavailable.length ? "unavailable" : "observed",
    cleanup: cleanupSafe ? "joined" : "unsafe",
    visualReview: "pending",
  });
}
