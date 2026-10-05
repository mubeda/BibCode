import { projectRemoteUiCheckAgainInterception } from "./remote-ui-evidence.ts";

/** The shared original-error decoder adds no DOM read, action or cause inference. */
export function projectGitProjectTabInterception(
  error: unknown,
  phase: unknown,
  selection: unknown,
) {
  if (selection !== "release-visual-git-project" || typeof phase !== "string") return null;
  const tab =
    phase === "visual-git-project-tab-changes-click"
      ? "changes"
      : phase === "visual-git-project-tab-history-click"
        ? "history"
        : phase === "visual-git-project-tab-tags-click"
          ? "tags"
          : null;
  if (tab === null) return null;
  const receiver = projectRemoteUiCheckAgainInterception(error);
  return receiver === null ? null : { tab, ...receiver };
}
