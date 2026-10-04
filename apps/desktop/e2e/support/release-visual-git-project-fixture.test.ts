// @effect-diagnostics nodeBuiltinImport:off - Private filesystem and inert Git ports only; never starts Git.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import { expect, it } from "vite-plus/test";
import { prepareGitProjectVisualFixture } from "./release-visual-git-project-fixture.ts";

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
