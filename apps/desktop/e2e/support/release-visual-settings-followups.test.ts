// @effect-diagnostics nodeBuiltinImport:off - Closed receipt projection only; no runtime or pixel fabrication.
import { expect, it } from "vite-plus/test";
import {
  settingsFollowupRows,
  settingsFollowupScenes,
  settingsFollowupParentRow,
  settingsFollowupCommonFacts,
  settingsFollowupFacts,
  validateSettingsFollowupWitness,
  projectSettingsFollowupCapture,
  projectSettingsFollowupAssertion,
  validateSettingsFollowupJoins,
} from "./release-visual-settings-followups.ts";
function witness(scene: (typeof settingsFollowupScenes)[number]) {
  return Object.fromEntries(
    [...settingsFollowupCommonFacts, ...settingsFollowupFacts[scene]].map((key) => [key, true]),
  );
}
function capture(scene: (typeof settingsFollowupScenes)[number], theme = "light") {
  return {
    scene,
    parentRow: settingsFollowupParentRow[scene],
    theme,
    file: scene + "-" + theme + ".png",
    width: 1280,
    height: 960,
    nonBlank: true,
    sha256: "a".repeat(64),
    witness: witness(scene),
  };
}
it("keeps eight approved base originals and binds only the ten finite extras to those four rows", () => {
  expect(settingsFollowupRows).toEqual([
    "settings-diagnostics",
    "usage-detail",
    "remote-rename",
    "remote-receiving-settings",
  ]);
  expect(settingsFollowupScenes).toHaveLength(9);
  expect(new Set(Object.values(settingsFollowupParentRow))).toEqual(new Set(settingsFollowupRows));
});
function assertion(theme: "light" | "dark") {
  return {
    theme,
    rows: [...settingsFollowupRows],
    files: settingsFollowupScenes.map((scene) => scene + "-" + theme + ".png"),
    completeGroup: false,
    sourceIdentityRetained: true,
    originalContextRestored: true,
    originalLabelRestored: true,
    originalConfigurationReleased: true,
    unavailableUsageDidNotBorrow: true,
  };
}
it("joins the finite18 originals and two closed four-row assertions without completing the full matrix", () => {
  const captures = ["light", "dark"].flatMap((theme) =>
    settingsFollowupScenes.map((scene) => capture(scene, theme)),
  );
  const assertions = [
    projectSettingsFollowupAssertion("light", assertion("light")),
    projectSettingsFollowupAssertion("dark", assertion("dark")),
  ];
  expect(() => validateSettingsFollowupJoins(captures, assertions)).not.toThrow();
});
it.each(["missing", "duplicate", "new-row", "complete", "private", "false", "proxy"])(
  "refuses a %s final settings join packet",
  (reason) => {
    const captures = ["light", "dark"].flatMap((theme) =>
      settingsFollowupScenes.map((scene) => capture(scene, theme)),
    );
    const light = assertion("light"),
      dark = assertion("dark");
    if (reason === "missing") captures.pop();
    if (reason === "duplicate") captures[17] = captures[0]!;
    if (reason === "new-row") Reflect.set(light, "rows", ["newer-issue"]);
    if (reason === "complete") Reflect.set(light, "completeGroup", true);
    if (reason === "private") Reflect.set(light, "privateToken", "not retained");
    if (reason === "false") light.sourceIdentityRetained = false;
    const value =
      reason === "proxy"
        ? new Proxy(light, {
            ownKeys() {
              throw new Error("Not reflected.");
            },
          })
        : light;
    expect(() => validateSettingsFollowupJoins(captures, [value, dark])).toThrow();
  },
);
it.each(settingsFollowupScenes)("projects a strict original for the existing row: %s", (scene) => {
  expect(projectSettingsFollowupCapture(capture(scene))).toMatchObject({
    scene,
    parentRow: settingsFollowupParentRow[scene],
    theme: "light",
    width: 1280,
    height: 960,
  });
});
it.each(["foreign", "false", "accessor", "proxy", "missing", "size", "question", "hash"])(
  "refuses unsafe or unrelated capture facts: %s",
  (mode) => {
    const source = capture("usage-detail");
    let traps = 0;
    if (mode === "foreign") Reflect.set(source, "privateValue", "hidden");
    if (mode === "false") source.witness.formerUsageAbsent = false;
    if (mode === "missing") delete source.witness.selectedMatched;
    if (mode === "size") source.width = 960;
    if (mode === "question") Reflect.set(source, "scene", "question-multiselect");
    if (mode === "hash") source.sha256 = "invalid";
    if (mode === "accessor")
      Object.defineProperty(source.witness, "usageUnavailable", {
        enumerable: true,
        get() {
          traps++;
          throw new Error("Not evaluated.");
        },
      });
    const value =
      mode === "proxy"
        ? new Proxy(source, {
            ownKeys() {
              traps++;
              throw new Error("Not reflected.");
            },
          })
        : source;
    expect(() => projectSettingsFollowupCapture(value)).toThrow();
    expect(traps).toBe(0);
  },
);
it("does not coerce missing/default witness fields into a successful observation", () => {
  expect(() => validateSettingsFollowupWitness("usage-detail", {})).toThrow();
  expect(() =>
    validateSettingsFollowupWitness("usage-detail", witness("usage-detail")),
  ).not.toThrow();
});
