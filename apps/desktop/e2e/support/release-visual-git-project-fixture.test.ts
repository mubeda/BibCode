// @effect-diagnostics nodeBuiltinImport:off - Inert ports and bounded Git commands use only isolated temporary fixtures.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { expect, it } from "vite-plus/test";
import { prepareGitProjectVisualFixture } from "./release-visual-git-project-fixture.ts";
import { runGitRewritePreview } from "./release-visual-git-project.ts";
import { QualificationOwner } from "./qualification-owner.ts";

it("refuses an unadmitted owner before creating fixture files or invoking Git", async () => {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "visual-gp-")),
  );
  const home = NodePath.join(root, "home");
  NodeFS.mkdirSync(home);
  const original = new Error("owner refused");
  let calls = 0;
  try {
    await expect(
      prepareGitProjectVisualFixture({
        root,
        home,
        theme: "light",
        admitOwner: async () => {
          throw original;
        },
        git: async () => {
          calls++;
          return { status: 0, stdout: "" };
        },
      }),
    ).rejects.toBe(original);
    expect(calls).toBe(0);
    expect(NodeFS.readdirSync(root)).toEqual(["home"]);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});

async function temporaryRewriteFixture() {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "visual-rewrite-")),
  );
  NodeFS.chmodSync(root, 0o700);
  const home = NodePath.join(root, "home");
  NodeFS.mkdirSync(home, { mode: 0o700 });
  const calls: string[][] = [];
  const git = async (cwd: string, args: readonly string[]) => {
    calls.push([...args]);
    const result = NodeChildProcess.spawnSync("git", [...args], {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: NodePath.join(home, "gitconfig"),
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "user.name",
        GIT_CONFIG_VALUE_0: "Owned fixture",
        GIT_CONFIG_KEY_1: "user.email",
        GIT_CONFIG_VALUE_1: "owned@localhost",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "false",
        LANG: "C",
        LC_ALL: "C",
      },
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 65536,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error || result.status === null) throw new Error("Owned temporary Git refused.");
    return { status: result.status, stdout: result.stdout };
  };
  try {
    const fixture = await prepareGitProjectVisualFixture({
      root,
      home,
      theme: "light",
      admitOwner: async () => {},
      git,
    });
    return {
      root,
      fixture,
      git,
      calls,
      close: () => NodeFS.rmSync(root, { recursive: true, force: true }),
    };
  } catch (error) {
    NodeFS.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

it.each(["cancel", "capture-failure", "chooser-failure", "cancel-failure"])(
  "retains exact real temporary refs/index/dirty work when rewrite preview ends at %s",
  async (mode) => {
    const f = await temporaryRewriteFixture();
    const owner = new QualificationOwner(f.root, f.root);
    const original = new Error("Inert original capture failure.");
    const cleanupError = new Error("Inert cancel failure.");
    const actions: string[] = [];
    let title = "",
      displayed = false;
    const popup = '[data-slot="dialog-popup"][role="dialog"]';
    const cancel =
      '//*[@data-slot="dialog-popup" and @role="dialog"]//button[normalize-space()="Cancel"]';
    const element = (selector: string) => ({
      waitForDisplayed: async (options?: { reverse?: boolean }) => {
        if (options?.reverse) expect(displayed).toBe(false);
      },
      waitForEnabled: async () => {},
      isDisplayed: async () => displayed,
      getText: async () => title,
      click: async () => {
        actions.push(selector);
        if (selector.includes("Rebase…")) {
          displayed = true;
          title = "Choose a Branch to Rebase";
        } else if (selector.includes("visual-switch")) {
          if (mode === "chooser-failure") throw original;
          title = "Rewrite Rebase History?";
        } else if (selector === cancel) {
          if (mode === "cancel-failure") throw cleanupError;
          displayed = false;
        } else throw new Error("Unexpected UI action.");
      },
    });
    try {
      const result = runGitRewritePreview({
        browser: {
          $: element,
          $$: () => ({ length: Promise.resolve(1) }),
          keys: async (key: string) => {
            expect(key).toBe("Escape");
            actions.push("Escape");
            displayed = false;
          },
        },
        owner,
        fixture: f.fixture,
        selection: {
          environmentId: "local",
          projectId: "owned-rich",
          threadId: "owned-thread",
          cwd: f.fixture.rich,
          title: "rich",
          branch: "main",
        },
        verifyOwnedIdentity: async () => {},
        step: () => {},
        capture: async () => {
          expect(title).toBe("Rewrite Rebase History?");
          if (mode === "capture-failure" || mode === "cancel-failure") throw original;
        },
      } as never);
      if (mode === "cancel")
        await expect(result).resolves.toEqual({
          rewritePreviewCancelled: true,
          rewriteStateRetained: true,
        });
      else await expect(result).rejects.toBe(original);
      await f.fixture.verifyRewriteRetained();
      expect(owner.failures).toHaveLength(mode === "cancel-failure" ? 1 : 0);
      expect(actions).not.toContain(`${popup} button=Rewrite History`);
      expect(actions.at(-1)).toBe(mode === "chooser-failure" ? "Escape" : cancel);
      expect(f.calls.some((args) => args.includes("rebase") || args.includes("reset"))).toBe(false);
      expect(NodeFS.readFileSync(NodePath.join(f.fixture.rich, "visual-note.txt"), "utf8")).toBe(
        "Owned dirty work must remain.\n",
      );
      const retentionCalls = f.calls.filter((args) => args[0] === "--no-optional-locks");
      expect(retentionCalls.length).toBeGreaterThan(0);
      expect(
        retentionCalls.every((args) =>
          ["rev-parse", "show-ref", "diff", "status"].includes(args[1]!),
        ),
      ).toBe(true);
    } finally {
      f.close();
    }
  },
);

it.each([
  "refs",
  "index",
  "dirty",
  "untracked",
  "rebase-marker",
  "index-symlink",
  "index-overflow",
])("refuses altered real temporary rewrite state: %s", async (mode) => {
  const f = await temporaryRewriteFixture();
  try {
    await f.fixture.beginRewritePreview();
    const admin = NodePath.join(f.fixture.rich, ".git"),
      index = NodePath.join(admin, "index");
    if (mode === "refs") await f.git(f.fixture.rich, ["tag", "owned-unexpected"]);
    if (mode === "index") NodeFS.appendFileSync(index, "changed");
    if (mode === "dirty")
      NodeFS.writeFileSync(
        NodePath.join(f.fixture.rich, "visual-note.txt"),
        "changed dirty work\n",
      );
    if (mode === "untracked")
      NodeFS.writeFileSync(NodePath.join(f.fixture.rich, "owned-extra.txt"), "untracked\n");
    if (mode === "rebase-marker") NodeFS.mkdirSync(NodePath.join(admin, "rebase-merge"));
    if (mode === "index-symlink") {
      NodeFS.renameSync(index, index + "-saved");
      NodeFS.symlinkSync(index + "-saved", index);
    }
    if (mode === "index-overflow") NodeFS.writeFileSync(index, Buffer.alloc(65537));
    await expect(f.fixture.verifyRewriteRetained()).rejects.toThrow(
      "Owned Git/project fixture refused.",
    );
  } finally {
    f.close();
  }
});

it("admits only one pushed, unstaged rewrite baseline and refuses premature verification", async () => {
  const f = await temporaryRewriteFixture();
  try {
    await expect(f.fixture.verifyRewriteRetained()).rejects.toThrow(
      "Owned Git/project fixture refused.",
    );
    await f.fixture.beginRewritePreview();
    await expect(f.fixture.beginRewritePreview()).rejects.toThrow(
      "Owned Git/project fixture refused.",
    );
    await f.fixture.verifyRewriteRetained();
  } finally {
    f.close();
  }
});

it.each(["upstream", "staged"])(
  "refuses a rewrite baseline without its fixed %s precondition",
  async (mode) => {
    const f = await temporaryRewriteFixture();
    try {
      await f.git(
        f.fixture.rich,
        mode === "upstream"
          ? ["branch", "--unset-upstream", "main"]
          : ["add", "--", "visual-note.txt"],
      );
      await expect(f.fixture.beginRewritePreview()).rejects.toThrow(
        "Owned Git/project fixture refused.",
      );
    } finally {
      f.close();
    }
  },
);

it.each(["symlink-root", "outside-home", "preexisting-group"])(
  "refuses unsafe private fixture layout without running Git: %s",
  async (mode) => {
    const actual = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "visual-gp-")),
    );
    const home = NodePath.join(actual, "home");
    NodeFS.mkdirSync(home);
    const alias = NodePath.join(actual, "alias");
    NodeFS.symlinkSync(actual, alias);
    if (mode === "preexisting-group") NodeFS.mkdirSync(NodePath.join(actual, "visual-git-project"));
    let calls = 0;
    try {
      await expect(
        prepareGitProjectVisualFixture({
          root: mode === "symlink-root" ? alias : actual,
          home: mode === "outside-home" ? NodePath.dirname(actual) : home,
          theme: "dark",
          admitOwner: async () => {},
          git: async () => {
            calls++;
            return { status: 0, stdout: "" };
          },
        }),
      ).rejects.toThrow("Owned Git/project fixture refused.");
      expect(calls).toBe(0);
    } finally {
      NodeFS.rmSync(actual, { recursive: true, force: true });
    }
  },
);

it("runs only fixed private Git recipes and preserves config and dirty work across restore/verification", async () => {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "visual-gp-")),
  );
  const home = NodePath.join(root, "home");
  NodeFS.mkdirSync(home);
  const calls: Array<{ cwd: string; args: readonly string[] }> = [];
  const git = async (cwd: string, args: readonly string[]) => {
    calls.push({ cwd, args });
    if (args[0] === "init" && !args.includes("--bare")) {
      NodeFS.mkdirSync(NodePath.join(cwd, ".git"));
      NodeFS.writeFileSync(NodePath.join(cwd, ".git/config"), "[core]\n  bare = false\n");
    }
    if (args[0] === "rev-parse" && args.includes("--is-bare-repository"))
      return { status: 0, stdout: "true\n" };
    if (args[0] === "config" && args.includes("--file")) {
      const path = args[args.indexOf("--file") + 1]!;
      if (args.includes("--get"))
        return { status: 0, stdout: "https://visual.invalid/visual-origin.git\n" };
      NodeFS.writeFileSync(
        path,
        '[url "owned alias"]\n  insteadOf = https://visual.invalid/visual-origin.git\n',
        { mode: 0o600 },
      );
    }
    if (args[0] === "merge") return { status: 1, stdout: "" };
    if (args[0] === "diff" && args.includes("--diff-filter=U"))
      return { status: 0, stdout: "visual-conflict.txt\n" };
    if (args[0] === "rev-parse" && args.includes("HEAD"))
      return { status: 0, stdout: "a".repeat(40) + "\n" };
    if (args[0] === "status")
      return { status: 0, stdout: cwd.endsWith("rich") ? " M visual-note.txt\n" : "" };
    return { status: 0, stdout: "" };
  };
  try {
    const fixture = await prepareGitProjectVisualFixture({
      root,
      home,
      theme: "light",
      admitOwner: async () => {},
      git,
    });
    expect(calls.some((c) => c.args[0] === "init" && c.args.includes("--bare"))).toBe(true);
    expect(NodeFS.statSync(NodePath.join(fixture.ordinary, "nested", "nested")).isDirectory()).toBe(
      true,
    );
    expect(
      calls.some(
        (c) =>
          c.args[0] === "worktree" && c.args[1] === "add" && c.args.at(-1) === "visual-discovered",
      ),
    ).toBe(true);
    expect(
      calls.some(
        (c) => c.args[0] === "remote" && c.args[1] === "add" && c.args.at(-1) === fixture.cloneUrl,
      ),
    ).toBe(true);
    expect(calls.filter((c) => c.args[0] === "merge")).toHaveLength(1);
    const config = NodeFS.readFileSync(NodePath.join(fixture.broken, ".git/config"));
    await fixture.breakMetadata();
    expect(NodeFS.readFileSync(NodePath.join(fixture.broken, ".git/config"))).not.toEqual(config);
    await fixture.restoreMetadata();
    expect(NodeFS.readFileSync(NodePath.join(fixture.broken, ".git/config"))).toEqual(config);
    await fixture.verifyDirtyRetained();
    expect(NodeFS.readFileSync(NodePath.join(fixture.rich, "visual-note.txt"), "utf8")).toBe(
      "Owned dirty work must remain.\n",
    );
    expect(NodeFS.existsSync(fixture.incompleteSentinel)).toBe(true);
    expect(calls.every((c) => c.cwd.startsWith(root + NodePath.sep))).toBe(true);
    expect(
      calls.flatMap((c) => c.args).some((arg) => /https?:/.test(arg) && arg !== fixture.cloneUrl),
    ).toBe(false);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
