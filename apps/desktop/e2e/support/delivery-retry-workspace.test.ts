// @effect-diagnostics nodeBuiltinImport:off - Disposable Git fixtures and inert DOM controls only.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import {
  readOwnedDeliveryWorktree,
  readSelectedDeliveryWorktree,
} from "./delivery-retry-workspace.ts";
import { withUnavailableWorkspace } from "./delivery-retry-evidence.ts";

const git = "/usr/bin/git";
const branch = "codex/delivery-retry-light";
function fixture(primaryBranch = "main", outside = false) {
  const temp = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "delivery-git-")),
  );
  const root = NodePath.join(temp, "owned"),
    home = NodePath.join(root, "home"),
    project = NodePath.join(root, "primary"),
    worktree = NodePath.join(outside ? temp : root, "selected worktree");
  NodeFS.mkdirSync(home, { recursive: true, mode: 0o700 });
  NodeFS.mkdirSync(project, { mode: 0o700 });
  const environment = {
    HOME: home,
    PATH: "/usr/bin:/bin",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  const run = (args: string[]) =>
    NodeChildProcess.execFileSync(
      git,
      [
        "-C",
        project,
        "-c",
        "user.name=Owned Fixture",
        "-c",
        "user.email=fixture@example.test",
        ...args,
      ],
      { env: environment, stdio: ["ignore", "pipe", "pipe"], timeout: 5_000 },
    );
  try {
    run(["init", "--initial-branch=" + primaryBranch]);
    NodeFS.writeFileSync(NodePath.join(project, "owned.txt"), "preserved");
    run(["add", "owned.txt"]);
    run(["commit", "-m", "fixture"]);
    run(["worktree", "add", "-b", primaryBranch === branch ? "codex/other" : branch, worktree]);
  } catch (error) {
    NodeFS.rmSync(temp, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    home,
    project,
    worktree,
    run,
    input: { root, home, project, git, branch },
    close: () => NodeFS.rmSync(temp, { recursive: true, force: true }),
  };
}

// These Linux-qualifier fixtures require this exact POSIX executable, not a
// simulated platform or an ambient Git found through the user's PATH.
describe.skipIf(!NodeFS.existsSync(git))("owned delivery Git identity (Linux qualifier)", () => {
  it("resolves only the registered non-primary worktree with a shared reachable Git anchor", () => {
    const f = fixture();
    try {
      expect(readOwnedDeliveryWorktree(f.input)).toEqual({
        path: f.worktree,
        branch,
        commonDirectory: NodePath.join(f.project, ".git"),
      });
    } finally {
      f.close();
    }
  });
  it.each(["primary", "outside", "absent", "wrong-branch", "ambiguous", "wrong-admin"])(
    "refuses %s without renaming anything",
    (mode) => {
      const f = fixture(mode === "primary" ? branch : "main", mode === "outside");
      try {
        if (mode === "absent") NodeFS.renameSync(f.worktree, f.worktree + ".held");
        if (mode === "ambiguous")
          f.run(["worktree", "add", "--force", NodePath.join(f.root, "duplicate"), branch]);
        if (mode === "wrong-admin") {
          const other = NodePath.join(f.root, "other");
          f.run(["worktree", "add", "-b", "codex/other", other]);
          NodeFS.writeFileSync(
            NodePath.join(f.worktree, ".git"),
            NodeFS.readFileSync(NodePath.join(other, ".git")),
          );
        }
        expect(() =>
          readOwnedDeliveryWorktree({
            ...f.input,
            ...(mode === "wrong-branch" ? { branch: "main" } : {}),
          }),
        ).toThrow("Owned delivery worktree identity refused.");
        expect(NodeFS.existsSync(NodePath.join(f.project, ".git"))).toBe(true);
        expect(NodeFS.existsSync(f.worktree + ".delivery-missing")).toBe(false);
      } finally {
        f.close();
      }
    },
  );
  it("restores the validated worktree after a failed observation while the primary anchor stays available", async () => {
    const f = fixture();
    try {
      const owned = readOwnedDeliveryWorktree(f.input);
      await expect(
        withUnavailableWorkspace(f.root, owned.path, async () => {
          expect(NodeFS.existsSync(owned.path)).toBe(false);
          expect(NodeFS.statSync(owned.commonDirectory).isDirectory()).toBe(true);
          expect(NodeFS.statSync(f.project).isDirectory()).toBe(true);
          throw new Error("inert observation failed");
        }),
      ).rejects.toThrow("inert observation failed");
      expect(readOwnedDeliveryWorktree(f.input)).toEqual(owned);
      expect(NodeFS.readFileSync(NodePath.join(owned.path, "owned.txt"), "utf8")).toBe("preserved");
    } finally {
      f.close();
    }
  });
});

it.each([
  "selected",
  "primary",
  "wrong-route",
  "wrong-title",
  "wrong-branch",
  "multiple",
  "unsafe-location",
])("reads only the public selected managed card: %s", (mode) => {
  const card = {
    getAttribute: (name: string) =>
      name === "data-testid"
        ? "thread-card-button-owned-thread"
        : name === "aria-describedby"
          ? "owned-branch"
          : null,
  };
  const row = {
    querySelector: () => ({ textContent: mode === "wrong-title" ? "private-text" : branch }),
  };
  const read = NodeVM.runInNewContext("(" + readSelectedDeliveryWorktree.toString() + ")", {
    location: {
      origin: "http://127.0.0.1:4885",
      pathname: mode === "wrong-route" ? "/local/other" : "/local/owned-thread",
      search: mode === "unsafe-location" ? "?token=private" : "",
      hash: "",
    },
    document: {
      querySelectorAll: () =>
        mode === "primary" ? [] : mode === "multiple" ? [card, card] : [card],
      querySelector: () => row,
      getElementById: () => ({
        querySelector: () => ({ textContent: mode === "wrong-branch" ? "other" : branch }),
      }),
    },
  });
  expect(read({ origin: "http://127.0.0.1:4885", branch })).toEqual(
    mode === "selected" ? { threadId: "owned-thread" } : null,
  );
});
