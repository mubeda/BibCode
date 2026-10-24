/**
 * The Diff panel's **Open with**, as pure data: whether a target can open in a diff app, which
 * app is the default, and what a failed launch tells the user.
 */
import {
  ReviewDiffToolError,
  type ReviewDiffTool,
  type ReviewListDiffToolsResult,
} from "@bibcode/contracts";
import type { FileDiffMetadata } from "@pierre/diffs";
import * as Schema from "effect/Schema";

import type { DiffCompareScope } from "./diffCompareModel";

/** One file of the patch, or every file of the scope. */
export type DiffOpenWithTarget =
  | {
      readonly kind: "file";
      readonly path: string;
      readonly previousPath: string | null;
      /** Git does not track it yet, so `git difftool` has nothing to compare. */
      readonly untracked: boolean;
    }
  | { readonly kind: "all"; readonly count: number };

/** Why nothing in the menu can open, before any tool is listed; null when something can. */
export function describeOpenWithUnavailable(input: {
  /** The thread's environment is the primary one, whose server runs on this computer. */
  readonly local: boolean;
  readonly environmentLabel: string | null;
  /** The server has `review.listDiffTools` and `review.openDiffTool`. */
  readonly supported: boolean;
}): string | null {
  if (!input.local) {
    return `Available for threads on this computer. This thread runs on ${
      input.environmentLabel ?? "another computer"
    }.`;
  }
  if (!input.supported) return "Update the server to use Open with.";
  return null;
}

/**
 * A working-tree file Git does not track: the server appends it to the patch without an `index`
 * line, so it has no object ID, and `git difftool HEAD` would not see it.
 */
export function isUntrackedFile(
  fileDiff: Pick<FileDiffMetadata, "type" | "newObjectId">,
  scope: DiffCompareScope,
): boolean {
  return scope === "working-tree" && fileDiff.type === "new" && !fileDiff.newObjectId;
}

export const UNTRACKED_FILE_REASON = "Untracked file. Stage it to compare it in a diff app.";
export const NO_DIFF_TOOL_REASON = "No diff app found. Install one, or set git config diff.tool.";

/**
 * The tools in the order Git lists them, with the default: the one Git is configured to use,
 * then the last one chosen here, then the first listed.
 */
export function resolveDefaultDiffTool(
  list: ReviewListDiffToolsResult,
  lastChoice: string | null,
): ReviewDiffTool | null {
  const byId = (id: string | null) =>
    id === null ? undefined : list.tools.find((tool) => tool.id === id);
  return byId(list.defaultToolId) ?? byId(lastChoice) ?? list.tools[0] ?? null;
}

/** VS Code's `--diff` takes exactly two files, so it cannot open a folder comparison. */
export function diffToolOpensAllFiles(toolId: string): boolean {
  return toolId !== "vscode";
}

export function describeOpenWithHeading(target: DiffOpenWithTarget): string {
  if (target.kind === "all") {
    return `Open all ${target.count} ${target.count === 1 ? "file" : "files"} in`;
  }
  const name = target.path.split("/").at(-1) ?? target.path;
  return `Open ${name} in`;
}

/** A launch that did not open, as the alert under the toolbar shows it. */
export interface DiffToolLaunchFailure {
  readonly title: string;
  /** Git's message with its exit code, or what else went wrong. */
  readonly detail: string | null;
  /** The `git difftool` command to run by hand; null when the server never answered. */
  readonly command: ReadonlyArray<string> | null;
}

const isReviewDiffToolError = Schema.is(ReviewDiffToolError);

/**
 * Git's own failure names the tool and carries the command. Anything else, such as a lost
 * connection, leaves it unknown whether the app opened.
 */
export function describeDiffToolLaunchFailure(
  toolLabel: string,
  failure: unknown,
): DiffToolLaunchFailure {
  if (isReviewDiffToolError(failure)) {
    return {
      title: `Couldn't open ${toolLabel}.`,
      detail: failure.message.length > 0 ? failure.message : null,
      command: failure.command.length > 0 ? failure.command : null,
    };
  }
  const message =
    typeof failure === "object" && failure !== null && "message" in failure
      ? String((failure as { readonly message: unknown }).message)
      : null;
  return {
    title: `Couldn't confirm that ${toolLabel} opened.`,
    detail: message !== null && message.length > 0 ? message : null,
    command: null,
  };
}

/** One shell line a user can paste: each argument quoted when it needs to be. */
export function formatDiffToolCommand(command: ReadonlyArray<string>): string {
  return command
    .map((argument) =>
      /^[A-Za-z0-9_./:=@%+-]+$/.test(argument)
        ? argument
        : `'${argument.replaceAll("'", `'\\''`)}'`,
    )
    .join(" ");
}
