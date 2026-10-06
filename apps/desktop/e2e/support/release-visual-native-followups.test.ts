import { expect, it } from "vite-plus/test";
import {
  nativeFollowupScenes,
  validateNativeFollowupWitness,
  projectNativeFollowupResult,
} from "./release-visual-native-followups.ts";

it("keeps blocked native prerequisites unavailable and the original five rows outstanding", () => {
  const result = projectNativeFollowupResult(
    [],
    ["native-system-theme", "native-update-ui", "native-preview", "native-wsl"],
    false,
  );
  expect(result).toEqual({
    schemaVersion: 1,
    selection: "release-visual-native-followups",
    complete: false,
    baseRowCount: 5,
    requiredOriginalCount: 10,
    originalCount: 0,
    outstandingRowCount: 5,
    prerequisiteStatus: "unavailable",
    cleanup: "unsafe",
    visualReview: "pending",
  });
  expect(nativeFollowupScenes).toEqual([
    "native-menu-theme",
    "native-update-protection",
    "native-update-recovery",
    "native-preview-annotations",
    "native-wsl-local",
  ]);
});

it("requires native owner joins and rejects arbitrary witness fields before projection", () => {
  const common = {
    nativeHost: true,
    sourceMatched: true,
    inputMatched: true,
    mainWindowMatched: true,
    storeMatched: true,
    versionMatched: true,
    processOwnerMatched: true,
    themeMatched: true,
    publicEntryMatched: true,
    workPreserved: true,
    pixelsSafe: true,
  };
  const value = {
    ...common,
    backendStopped: true,
    downloadRetained: true,
    protectedBackupRetained: true,
    draftRetained: true,
    portHoldMatched: true,
    restartActionAvailable: true,
    retryExplained: true,
  };
  expect(validateNativeFollowupWitness("native-update-recovery", value)).toEqual(value);
  expect(() =>
    validateNativeFollowupWitness("native-update-recovery", { ...value, backendStopped: false }),
  ).toThrow();
  expect(() =>
    validateNativeFollowupWitness("native-update-recovery", { ...value, privateError: "SECRET" }),
  ).toThrow();
  expect(() => validateNativeFollowupWitness("native-menu-theme", value)).toThrow();
});

it("does not mark ten original names complete when a row is missing or cleanup is unsafe", () => {
  const captures = nativeFollowupScenes.flatMap((scene) =>
    ["light", "dark"].map((theme) => ({
      scene,
      theme,
      file: `${scene}-${theme}.png`,
      sha256: "a".repeat(64),
      width: 1280,
      height: 960,
      nonBlank: true,
    })),
  );
  expect(projectNativeFollowupResult(captures, [], true).complete).toBe(true);
  expect(projectNativeFollowupResult(captures, [], false).complete).toBe(false);
  expect(() =>
    projectNativeFollowupResult([...captures.slice(0, 9), captures[0]!], [], true),
  ).toThrow();
  expect(() =>
    projectNativeFollowupResult(
      captures.map((c) => ({ ...c, privatePath: "SECRET" })),
      [],
      true,
    ),
  ).toThrow();
});
