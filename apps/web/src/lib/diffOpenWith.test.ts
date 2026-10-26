import { ReviewDiffToolError, type ReviewListDiffToolsResult } from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeDiffToolLaunchFailure,
  describeOpenWithHeading,
  describeOpenWithUnavailable,
  diffToolOpensAllFiles,
  formatDiffToolCommand,
  isUntrackedFile,
  resolveDefaultDiffTool,
} from "./diffOpenWith";

const LIST: ReviewListDiffToolsResult = {
  tools: [
    { id: "bc", label: "Beyond Compare", kind: "builtin" },
    { id: "meld", label: "Meld", kind: "builtin" },
    { id: "mine", label: "mine", kind: "custom" },
  ],
  defaultToolId: null,
  defaultSource: null,
};

describe("Open with availability", () => {
  it("explains a remote thread before an older server", () => {
    expect(
      describeOpenWithUnavailable({
        local: false,
        environmentLabel: "build-box",
        supported: false,
      }),
    ).toBe("Available for threads on this computer. This thread runs on build-box.");
    expect(
      describeOpenWithUnavailable({ local: true, environmentLabel: "Local", supported: false }),
    ).toBe("Update the server to use Open with.");
    expect(
      describeOpenWithUnavailable({ local: true, environmentLabel: "Local", supported: true }),
    ).toBeNull();
  });
});

describe("untracked files", () => {
  it("are working-tree additions without an object ID", () => {
    expect(isUntrackedFile({ type: "new" }, "working-tree")).toBe(true);
    // Staged, so Git compares it against HEAD.
    expect(isUntrackedFile({ type: "new", newObjectId: "a".repeat(40) }, "working-tree")).toBe(
      false,
    );
    expect(isUntrackedFile({ type: "change" }, "working-tree")).toBe(false);
    expect(isUntrackedFile({ type: "new" }, "branch")).toBe(false);
  });
});

describe("the default diff app", () => {
  it("is Git's configured tool, then the last choice, then the first listed", () => {
    expect(resolveDefaultDiffTool({ ...LIST, defaultToolId: "meld" }, "mine")?.id).toBe("meld");
    expect(resolveDefaultDiffTool(LIST, "mine")?.id).toBe("mine");
    // A last choice that is no longer installed is passed over.
    expect(resolveDefaultDiffTool(LIST, "kdiff3")?.id).toBe("bc");
    expect(resolveDefaultDiffTool(LIST, null)?.id).toBe("bc");
    expect(resolveDefaultDiffTool({ ...LIST, tools: [] }, "bc")).toBeNull();
  });

  it("opens all files in anything but VS Code, whose diff takes two files", () => {
    expect(diffToolOpensAllFiles("bc")).toBe(true);
    expect(diffToolOpensAllFiles("vscode")).toBe(false);
  });
});

describe("Open with copy", () => {
  it("names the file or counts the files", () => {
    expect(
      describeOpenWithHeading({
        kind: "file",
        path: "src/lib/foo.ts",
        previousPath: null,
        untracked: false,
      }),
    ).toBe("Open foo.ts in");
    expect(describeOpenWithHeading({ kind: "all", count: 42 })).toBe("Open all 42 files in");
    expect(describeOpenWithHeading({ kind: "all", count: 1 })).toBe("Open all 1 file in");
  });

  it("shows Git's message and the command for a failed launch", () => {
    const failure = describeDiffToolLaunchFailure(
      "Meld",
      new ReviewDiffToolError({
        reason: "launch-failed",
        message: "fatal: external diff died (exit 128)",
        command: ["git", "-C", "/repo", "difftool", "--tool=meld"],
      }),
    );
    expect(failure).toEqual({
      title: "Couldn't open Meld.",
      detail: "fatal: external diff died (exit 128)",
      command: ["git", "-C", "/repo", "difftool", "--tool=meld"],
    });
  });

  it("cannot confirm a launch whose answer never arrived", () => {
    expect(describeDiffToolLaunchFailure("Meld", new Error("The connection closed."))).toEqual({
      title: "Couldn't confirm that Meld opened.",
      detail: "The connection closed.",
      command: null,
    });
  });

  it("quotes only the arguments a shell would split", () => {
    expect(
      formatDiffToolCommand(["git", "-C", "/my repo", "difftool", "--", "it's.ts", "src/a.ts"]),
    ).toBe(`git -C '/my repo' difftool -- 'it'\\''s.ts' src/a.ts`);
  });
});
