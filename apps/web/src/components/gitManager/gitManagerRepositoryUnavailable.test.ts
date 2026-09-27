import { describe, expect, it } from "vite-plus/test";

import {
  gitManagerRepositoryUnavailableCopy,
  resolveGitManagerRepositoryUnavailable,
} from "./gitManagerRepositoryUnavailable";

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
});

describe("repository unavailable copy", () => {
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
