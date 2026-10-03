import { validateCaptureWitness } from "./remote-ui-evidence.ts";
export const visualScenes = [
  "workspace-composite",
  "workspace-card-menu",
  "worktree-create-ref",
  "git-changes-diff",
  "git-history-stashes",
  "git-branch-menu",
  "files-editor-comment",
  "command-palette",
] as const;
export type VisualScene = (typeof visualScenes)[number];
const facts: Record<VisualScene, readonly string[]> = {
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
};
export function visualScreenshotName(scene: string, theme: string): string {
  if (!visualScenes.some((allowed) => scene === allowed) || !["light", "dark"].includes(theme))
    throw new Error("Unknown visual capture.");
  return `${scene}-${theme}.png`;
}
/** Finite booleans only: missing, stale, failed, or private fields are not evidence. */
export function validateVisualWitness(scene: VisualScene, input: unknown): Record<string, true> {
  if (!visualScenes.includes(scene) || !input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Visual precondition failed.");
  const value = input as Record<string, unknown>;
  const common = [
    "themeMatched",
    "selectedMatched",
    "expectedTextMatched",
    "targetInView",
    "credentialAbsent",
    "bootShellAbsent",
  ];
  const keys = [...common, ...facts[scene]];
  if (Object.keys(value).length !== keys.length || !keys.every((key) => value[key] === true))
    throw new Error("Visual precondition failed.");
  validateCaptureWitness(Object.fromEntries(common.map((key) => [key, value[key]])));
  return Object.fromEntries(keys.map((key) => [key, true]));
}
