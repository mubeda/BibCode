import { describe, expect, it } from "vite-plus/test";
import { validateVisualWitness, visualScreenshotName } from "./release-visual-evidence.ts";
const scenes = {
  "workspace-composite": [
    "completedResponse",
    "draftRetained",
    "managedCard",
    "primaryCard",
    "dirtyStatus",
  ],
  "workspace-card-menu": ["singleMenu", "disabledReason", "focusedDisabledItem", "groupedActions"],
  "worktree-create-ref": [
    "singleDialog",
    "exactRef",
    "derivedName",
    "reuseBlocked",
    "agentControl",
    "advancedControl",
  ],
  "git-changes-diff": ["selectedTextDiff", "stagingGutter", "stagedAndUnstaged", "imageRow"],
  "git-history-stashes": [
    "selectedCommit",
    "decorations",
    "twelveStashes",
    "containedScroll",
    "selectedHistory",
  ],
  "git-branch-menu": ["currentBranch", "remoteBranch", "occupiedBranch", "renameDeleteControls"],
  "files-editor-comment": ["nestedTree", "fileText", "comment", "toolbar"],
  "command-palette": ["singlePalette", "filteredAction", "singleActiveRow", "inputFocused"],
} as const;
const common = {
  themeMatched: true,
  selectedMatched: true,
  expectedTextMatched: true,
  targetInView: true,
  credentialAbsent: true,
  bootShellAbsent: true,
};

describe("finite first visual batch evidence", () => {
  it("admits exactly eight scene pairs and refuses arbitrary file names", () => {
    const filenames = Object.keys(scenes).flatMap((scene) => [
      visualScreenshotName(scene, "light"),
      visualScreenshotName(scene, "dark"),
    ]);
    expect(filenames).toEqual([
      "workspace-composite-light.png",
      "workspace-composite-dark.png",
      "workspace-card-menu-light.png",
      "workspace-card-menu-dark.png",
      "worktree-create-ref-light.png",
      "worktree-create-ref-dark.png",
      "git-changes-diff-light.png",
      "git-changes-diff-dark.png",
      "git-history-stashes-light.png",
      "git-history-stashes-dark.png",
      "git-branch-menu-light.png",
      "git-branch-menu-dark.png",
      "files-editor-comment-light.png",
      "files-editor-comment-dark.png",
      "command-palette-light.png",
      "command-palette-dark.png",
    ]);
    for (const [scene, theme] of [
      ["../secret", "light"],
      ["native-share-refresh", "dark"],
      ["command-palette", "system"],
      ["", "dark"],
    ])
      expect(() => visualScreenshotName(scene!, theme!)).toThrow();
  });
  for (const [scene, keys] of Object.entries(scenes)) {
    const id = scene as keyof typeof scenes;
    const valid = { ...common, ...Object.fromEntries(keys.map((key) => [key, true])) };
    it(`requires every current ${scene} fact without retaining extra inputs`, () => {
      expect(validateVisualWitness(id, valid)).toEqual(valid);
      for (const key of Object.keys(valid)) {
        for (const value of [false, null, "private-secret", undefined])
          expect(() => validateVisualWitness(id, { ...valid, [key]: value })).toThrow();
        const missing = { ...valid };
        delete missing[key as keyof typeof missing];
        expect(() => validateVisualWitness(id, missing)).toThrow();
      }
      expect(() =>
        validateVisualWitness(id, { ...valid, privatePath: "/private/credential" }),
      ).toThrow();
      expect(() => validateVisualWitness(id, null)).toThrow();
    });
  }
});
