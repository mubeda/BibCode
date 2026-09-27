import { VcsStatusResult } from "@bibcode/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  gitManagerRepositoryUnavailableCopy,
  resolveGitManagerRepositoryUnavailable,
} from "./gitManagerRepositoryUnavailable";

const decodeStatusResult = Schema.decodeUnknownSync(VcsStatusResult);

describe("repository availability from status", () => {
  it("keeps the loading and readable presentations", () => {
    expect(resolveGitManagerRepositoryUnavailable(null)).toBeNull();
    expect(resolveGitManagerRepositoryUnavailable({ isRepo: true })).toBeNull();
    expect(
      resolveGitManagerRepositoryUnavailable({
        isRepo: true,
        repositoryUnavailableReason: "absent",
      }),
    ).toBeNull();
  });

  it.each(["absent", "unreadable", "untrusted"] as const)(
    "preserves the unavailable reason %s",
    (reason) => {
      expect(
        resolveGitManagerRepositoryUnavailable({
          isRepo: false,
          repositoryUnavailableReason: reason,
        }),
      ).toBe(reason);
    },
  );

  it("keeps an older server's missing reason explicitly unavailable", () => {
    expect(resolveGitManagerRepositoryUnavailable({ isRepo: false })).toBe("unknown");
  });

  it("uses generic copy for an unknown reason decoded from a newer server", () => {
    const decoded = decodeStatusResult({
      isRepo: false,
      repositoryUnavailableReason: "futureReason",
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName: null,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    });
    const reason = resolveGitManagerRepositoryUnavailable(decoded);

    expect(reason).toBe("unknown");
    if (reason === null) throw new Error("Expected an unavailable repository");
    expect(gitManagerRepositoryUnavailableCopy(reason, "/opaque/checkout")).toMatchObject({
      shortLabel: "Repository unavailable",
      message:
        "Git can't read this folder as a repository. Run git init to create one, or check its .git folder if it already is one.",
      command: "git init",
    });
  });
});

describe("repository unavailable copy", () => {
  it.each([
    ["absent", "Not a Git repository"],
    ["unreadable", "Repository unreadable"],
    ["untrusted", "Repository not trusted"],
    ["unknown", "Repository unavailable"],
  ] as const)("labels %s in compact rows", (reason, shortLabel) => {
    expect(gitManagerRepositoryUnavailableCopy(reason, "/opaque/checkout")).toMatchObject({
      shortLabel,
    });
  });

  it.each([
    ["absent", "This folder isn't a Git repository. Run git init to create one.", "git init"],
    [
      "unreadable",
      "Git can't read this repository. Check its .git folder, for example a damaged HEAD or config file.",
      null,
    ],
    [
      "untrusted",
      "Git doesn't trust this repository because another user owns it. Run git config --global --add safe.directory /opaque/checkout to trust it.",
      "git config --global --add safe.directory /opaque/checkout",
    ],
    [
      "unknown",
      "Git can't read this folder as a repository. Run git init to create one, or check its .git folder if it already is one.",
      "git init",
    ],
  ] as const)(
    "explains %s with the same words for panels and disabled reasons",
    (reason, message, command) => {
      expect(gitManagerRepositoryUnavailableCopy(reason, "/opaque/checkout")).toMatchObject({
        message,
        command,
      });
    },
  );

  it("uses the selected checkout's opaque path in the trust command", () => {
    expect(gitManagerRepositoryUnavailableCopy("untrusted", "D:\\Work\\project").message).toBe(
      "Git doesn't trust this repository because another user owns it. Run git config --global --add safe.directory D:\\Work\\project to trust it.",
    );
  });

  it.each([
    ["/opaque/checkout", "git config --global --add safe.directory /opaque/checkout"],
    ["/opaque/my checkout", 'git config --global --add safe.directory "/opaque/my checkout"'],
    ["D:\\Work\\my project", 'git config --global --add safe.directory "D:\\Work\\my project"'],
  ])("quotes the trust path when needed: %s", (cwd, command) => {
    expect(gitManagerRepositoryUnavailableCopy("untrusted", cwd)).toMatchObject({
      command,
      message: `Git doesn't trust this repository because another user owns it. Run ${command} to trust it.`,
    });
  });
});
