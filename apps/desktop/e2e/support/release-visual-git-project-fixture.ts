// @effect-diagnostics nodeBuiltinImport:off - Private fixture filesystem; Git is an existing owner-admitted injected port.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export interface GitProjectFixtureInput {
  root: string;
  home: string;
  theme: "light" | "dark";
  admitOwner: () => Promise<void>;
  /** CI adapter retains the existing isolated environment, process owner and command bound. */
  git: (cwd: string, args: readonly string[]) => Promise<{ status: number; stdout: string }>;
}
export interface GitProjectVisualFixture {
  root: string;
  rich: string;
  merge: string;
  broken: string;
  unborn: string;
  ordinary: string;
  origin: string;
  discovered: string;
  cloneParent: string;
  incomplete: string;
  incompleteSentinel: string;
  cloneUrl: "https://visual.invalid/visual-origin.git";
  cloneGitConfig: string;
  richHead: string;
  breakMetadata: () => Promise<void>;
  restoreMetadata: () => Promise<void>;
  verifyDirtyRetained: () => Promise<void>;
  verifyMergeAborted: () => Promise<void>;
  verifyIncompleteRetained: () => void;
  verifyCloneAlias: () => Promise<void>;
}
const refused = () => new Error("Owned Git/project fixture refused.");

/** Admits one new finite private fixture. No process launch, product state, or network owner is added. */
export async function prepareGitProjectVisualFixture(
  input: GitProjectFixtureInput,
): Promise<GitProjectVisualFixture> {
  await input.admitOwner();
  const canonicalDirectory = (path: string) => {
    if (
      !NodePath.isAbsolute(path) ||
      NodeFS.realpathSync(path) !== path ||
      !NodeFS.lstatSync(path).isDirectory() ||
      NodeFS.lstatSync(path).isSymbolicLink()
    )
      throw refused();
  };
  const inside = (parent: string, path: string) => {
    const relative = NodePath.relative(parent, path);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(".." + NodePath.sep) &&
      !NodePath.isAbsolute(relative)
    );
  };
  try {
    canonicalDirectory(input.root);
    canonicalDirectory(input.home);
    if (
      input.root === NodePath.parse(input.root).root ||
      !inside(input.root, input.home) ||
      !["light", "dark"].includes(input.theme)
    )
      throw refused();
    const root = NodePath.join(input.root, "visual-git-project");
    if (NodeFS.existsSync(root)) throw refused();
    NodeFS.mkdirSync(root, { mode: 0o700 });
    const names = [
      "rich",
      "merge",
      "broken",
      "unborn",
      "ordinary",
      "visual-origin.git",
      "clone-parent",
    ];
    for (const name of names) NodeFS.mkdirSync(NodePath.join(root, name), { mode: 0o700 });
    const [rich, merge, broken, unborn, ordinary, origin, cloneParent] = names.map((name) =>
      NodePath.join(root, name),
    ) as [string, string, string, string, string, string, string];
    const discovered = NodePath.join(root, "visual-discovered");
    const incomplete = NodePath.join(cloneParent, "visual-origin");
    NodeFS.mkdirSync(incomplete, { mode: 0o700 });
    NodeFS.mkdirSync(NodePath.join(ordinary, "nested"), { mode: 0o700 });
    NodeFS.mkdirSync(NodePath.join(ordinary, "nested", "leaf"), { mode: 0o700 });
    NodeFS.mkdirSync(NodePath.join(ordinary, "nested", "nested"), { mode: 0o700 });
    const write = (directory: string, name: string, text: string) => {
      canonicalDirectory(directory);
      if (!inside(root, directory)) throw refused();
      NodeFS.writeFileSync(NodePath.join(directory, name), text, { mode: 0o600, flag: "wx" });
    };
    const git = async (cwd: string, args: readonly string[], statuses = [0]) => {
      canonicalDirectory(cwd);
      if (cwd !== root && !inside(root, cwd)) throw refused();
      const result = await input.git(cwd, args);
      if (
        !statuses.includes(result.status) ||
        typeof result.stdout !== "string" ||
        Buffer.byteLength(result.stdout) > 65536
      )
        throw refused();
      return result.stdout;
    };
    const repository = async (cwd: string) => {
      await git(cwd, ["init", "--initial-branch=main"]);
      write(cwd, "visual-note.txt", "Owned baseline.\n");
      write(cwd, "visual-conflict.txt", "Shared baseline.\n");
      await git(cwd, ["add", "--", "visual-note.txt", "visual-conflict.txt"]);
      await git(cwd, ["commit", "-m", "Visual Git project baseline"]);
    };
    for (const cwd of [rich, merge, broken]) await repository(cwd);
    await git(root, ["init", "--bare", "--initial-branch=main", origin]);
    if ((await git(origin, ["rev-parse", "--is-bare-repository"])).trim() !== "true")
      throw refused();
    await git(rich, ["branch", "visual-switch"]);
    NodeFS.writeFileSync(NodePath.join(rich, "visual-note.txt"), "Owned history second commit.\n", {
      mode: 0o600,
    });
    await git(rich, ["add", "--", "visual-note.txt"]);
    await git(rich, ["commit", "-m", "Visual Git second commit"]);
    await git(rich, ["tag", "visual-local"]);
    await git(rich, ["branch", "visual-discovered"]);
    await git(rich, ["remote", "add", "origin", origin]);
    await git(rich, [
      "push",
      "--set-upstream",
      "origin",
      "main",
      "visual-switch",
      "visual-discovered",
      "--tags",
    ]);
    await git(origin, ["tag", "visual-remote", "refs/heads/main"]);
    await git(rich, ["worktree", "add", discovered, "visual-discovered"]);
    const richHead = (await git(rich, ["rev-parse", "HEAD"])).trim();
    if (!/^[0-9a-f]{40}$/.test(richHead)) throw refused();
    NodeFS.writeFileSync(
      NodePath.join(rich, "visual-note.txt"),
      "Owned dirty work must remain.\n",
      {
        mode: 0o600,
      },
    );

    await git(merge, ["branch", "visual-conflict"]);
    NodeFS.writeFileSync(NodePath.join(merge, "visual-conflict.txt"), "Main conflict side.\n", {
      mode: 0o600,
    });
    await git(merge, ["add", "--", "visual-conflict.txt"]);
    await git(merge, ["commit", "-m", "Main conflict side"]);
    await git(merge, ["switch", "visual-conflict"]);
    NodeFS.writeFileSync(NodePath.join(merge, "visual-conflict.txt"), "Other conflict side.\n", {
      mode: 0o600,
    });
    await git(merge, ["add", "--", "visual-conflict.txt"]);
    await git(merge, ["commit", "-m", "Other conflict side"]);
    await git(merge, ["switch", "main"]);
    await git(merge, ["merge", "visual-conflict"], [1]);
    if (
      (await git(merge, ["diff", "--name-only", "--diff-filter=U"])).trim() !==
      "visual-conflict.txt"
    )
      throw refused();
    await git(unborn, ["init", "--initial-branch=main"]);
    await git(incomplete, ["init", "--initial-branch=main"]);
    const cloneUrl = "https://visual.invalid/visual-origin.git" as const;
    await git(incomplete, ["remote", "add", "origin", cloneUrl]);
    write(incomplete, "owned-sentinel.txt", "Owned incomplete clone must remain.\n");
    const incompleteSentinel = NodePath.join(incomplete, "owned-sentinel.txt");
    const cloneGitConfig = NodePath.join(root, "clone-alias.gitconfig");
    // Root integration passes this private config to the actual guarded server before startup.
    await git(root, ["config", "--file", cloneGitConfig, `url.${origin}.insteadOf`, cloneUrl]);
    const verifyCloneAlias = async () => {
      const stat = NodeFS.lstatSync(cloneGitConfig);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.uid !== NodeFS.lstatSync(root).uid ||
        stat.size < 1 ||
        stat.size > 8192 ||
        NodeFS.realpathSync(cloneGitConfig) !== cloneGitConfig
      )
        throw refused();
      if (
        (
          await git(root, ["config", "--file", cloneGitConfig, "--get", `url.${origin}.insteadOf`])
        ).trim() !== cloneUrl
      )
        throw refused();
    };
    await verifyCloneAlias();
    NodeFS.chmodSync(cloneGitConfig, 0o600);
    const configPath = NodePath.join(broken, ".git/config");
    const regularConfig = () => {
      const stat = NodeFS.lstatSync(configPath);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.size > 8192 ||
        NodeFS.realpathSync(configPath) !== configPath
      )
        throw refused();
    };
    regularConfig();
    const originalConfig = NodeFS.readFileSync(configPath);
    let damaged = false;
    const fixture: GitProjectVisualFixture = {
      root,
      rich,
      merge,
      broken,
      unborn,
      ordinary,
      origin,
      discovered,
      cloneParent,
      incomplete,
      incompleteSentinel,
      cloneUrl,
      cloneGitConfig,
      richHead,
      verifyCloneAlias,
      breakMetadata: async () => {
        await input.admitOwner();
        regularConfig();
        if (damaged || !NodeFS.readFileSync(configPath).equals(originalConfig)) throw refused();
        NodeFS.writeFileSync(configPath, "[owned broken metadata\n", { mode: 0o600 });
        damaged = true;
      },
      restoreMetadata: async () => {
        await input.admitOwner();
        regularConfig();
        if (!damaged || NodeFS.readFileSync(configPath, "utf8") !== "[owned broken metadata\n")
          throw refused();
        NodeFS.writeFileSync(configPath, originalConfig, { mode: 0o600 });
        damaged = false;
      },
      verifyDirtyRetained: async () => {
        if (
          (await git(rich, ["rev-parse", "HEAD"])).trim() !== richHead ||
          NodeFS.readFileSync(NodePath.join(rich, "visual-note.txt"), "utf8") !==
            "Owned dirty work must remain.\n" ||
          (await git(rich, ["status", "--porcelain"])).trim() !== "M visual-note.txt"
        )
          throw refused();
      },
      verifyMergeAborted: async () => {
        if (
          (await git(merge, ["diff", "--name-only", "--diff-filter=U"])).trim() !== "" ||
          NodeFS.existsSync(NodePath.join(merge, ".git/MERGE_HEAD"))
        )
          throw refused();
      },
      verifyIncompleteRetained: () => {
        canonicalDirectory(incomplete);
        if (
          NodeFS.readFileSync(incompleteSentinel, "utf8") !==
          "Owned incomplete clone must remain.\n"
        )
          throw refused();
      },
    };
    await fixture.verifyDirtyRetained();
    fixture.verifyIncompleteRetained();
    return fixture;
  } catch {
    throw refused();
  }
}
