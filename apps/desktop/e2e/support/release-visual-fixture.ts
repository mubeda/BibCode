// @effect-diagnostics nodeBuiltinImport:off - Bounded Git commands and bytes belong to one disposable QA fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { pierreVisualFixture } from "./pierre-visual-fixture.ts";
import {
  readOwnedDeliveryWorktree,
  type DeliveryWorktreeInput,
  type DeliveryWorktreeIdentity,
} from "./delivery-retry-workspace.ts";

type VisualProjectInput = Omit<DeliveryWorktreeInput, "branch">;
export const visualFixture = {
  file: "src/nested/visual-note.ts",
  image: "visual-swatch.png",
  heldBranch: "visual-held",
  historySubject: "Visual qualification baseline",
  draft: "Owned visual review draft",
  comment: "Review this owned line",
} as const;
// Small, valid 64x64 fixture swatches; these are source inputs, never screenshot evidence.
const swatches = [
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeklEQVR4nO3PUQkAIBTAwBfHsEY0jCH8OITBAtxm7fN1wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWPHYBSIgBeLUco5MAAAAASUVORK5CYII=",
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeklEQVR4nO3PUQkAIBTAwBfH2EY0giH8OITBAtzm7PV1wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWPHYBks2BloRD0lIAAAAASUVORK5CYII=",
] as const;
const refused = () => new Error("Owned visual fixture refused.");

function ownedGit(input: VisualProjectInput) {
  const root = NodeFS.realpathSync(input.root);
  if (root !== input.root || !NodePath.isAbsolute(input.git)) throw refused();
  const directory = (path: string) => {
    const relative = NodePath.relative(root, path);
    if (
      !NodePath.isAbsolute(path) ||
      relative === "" ||
      relative === ".." ||
      relative.startsWith(".." + NodePath.sep) ||
      NodePath.isAbsolute(relative) ||
      NodeFS.realpathSync(path) !== path ||
      !NodeFS.statSync(path).isDirectory()
    )
      throw refused();
  };
  directory(input.project);
  directory(input.home);
  const admin = NodePath.join(input.project, ".git");
  if (NodeFS.lstatSync(admin).isSymbolicLink() || !NodeFS.statSync(admin).isDirectory())
    throw refused();
  return (cwd: string, args: string[]) => {
    if (cwd !== root) directory(cwd);
    const result = NodeChildProcess.spawnSync(
      input.git,
      [
        "-C",
        cwd,
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "user.name=BiBCode UI Fixture",
        "-c",
        "user.email=fixture@example.test",
        ...args,
      ],
      {
        encoding: "utf8",
        shell: false,
        timeout: 5_000,
        killSignal: "SIGKILL",
        maxBuffer: 65_536,
        env: {
          HOME: input.home,
          PATH: NodePath.dirname(input.git),
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (result.error || result.status !== 0) throw refused();
    return result.stdout;
  };
}

/** Only a new clean private primary is seeded; reruns and pre-existing seed paths refuse. */
export function prepareVisualProject(input: VisualProjectInput): void {
  try {
    const git = ownedGit(input);
    const project = input.project;
    const origin = NodePath.join(input.root, "visual-origin.git");
    const held = NodePath.join(input.root, "visual-discovered");
    const files = {
      [pierreVisualFixture.diffFileName]: pierreVisualFixture.originalDiffContents,
      [pierreVisualFixture.editFileName]: pierreVisualFixture.originalFileContents,
      [visualFixture.file]:
        'export const review = "Review this owned file";\nexport const count = 2;\n',
      [visualFixture.image]: Buffer.from(swatches[0], "base64"),
      "visual-stash.txt": "Visual stash baseline\n",
    };
    if (
      git(project, ["status", "--porcelain"]) !== "" ||
      git(project, ["branch", "--format=%(refname:short)"]).trim() !== "main" ||
      git(project, ["remote"]) !== "" ||
      git(project, ["stash", "list"]) !== "" ||
      [origin, held, ...Object.keys(files).map((file) => NodePath.join(project, file))].some(
        (path) => NodeFS.existsSync(path),
      )
    )
      throw refused();
    // Reject a pre-existing nested path even when Git ignores it; no symlink traversal.
    if (NodeFS.existsSync(NodePath.join(project, "src"))) throw refused();
    NodeFS.mkdirSync(NodePath.join(project, "src/nested"), { recursive: true, mode: 0o700 });
    for (const [file, bytes] of Object.entries(files))
      NodeFS.writeFileSync(NodePath.join(project, file), bytes, { flag: "wx", mode: 0o600 });
    // The supported commit image view needs both sides. Keep the existing baseline
    // bytes/subject/tag, with one additional owned image-only parent before it.
    NodeFS.writeFileSync(
      NodePath.join(project, visualFixture.image),
      Buffer.from(swatches[1], "base64"),
    );
    git(project, ["add", "--", visualFixture.image]);
    git(project, ["commit", "-m", "Visual image comparison parent"]);
    NodeFS.writeFileSync(
      NodePath.join(project, visualFixture.image),
      Buffer.from(swatches[0], "base64"),
    );
    git(project, ["add", "--", ...Object.keys(files)]);
    git(project, ["commit", "-m", visualFixture.historySubject]);
    git(project, ["branch", "visual-free"]);
    git(project, ["branch", visualFixture.heldBranch]);
    git(project, ["tag", "visual-base"]);
    git(input.root, ["init", "--bare", "--initial-branch=main", origin]);
    git(project, ["remote", "add", "origin", origin]);
    git(project, ["push", "origin", "main", "visual-free", visualFixture.heldBranch, "--tags"]);
    git(project, ["fetch", "origin"]);
    git(project, ["remote", "set-head", "origin", "--delete"]);
    git(project, ["worktree", "add", held, visualFixture.heldBranch]);
    for (let index = 1; index <= 12; index++) {
      NodeFS.writeFileSync(
        NodePath.join(project, "visual-stash.txt"),
        `Owned stash change ${index}\n`,
        { mode: 0o600 },
      );
      git(project, [
        "stash",
        "push",
        "-m",
        `Visual stash ${String(index).padStart(2, "0")}`,
        "--",
        "visual-stash.txt",
      ]);
    }
    if (
      git(project, ["status", "--porcelain"]) !== "" ||
      git(project, ["stash", "list", "--format=%s"]).trim().split("\n").length !== 12
    )
      throw refused();
  } catch {
    throw refused();
  }
}

/** Retain the approved Git identity proof; never write through an unverified UI path. */
export function prepareVisualWorktree(input: DeliveryWorktreeInput): DeliveryWorktreeIdentity {
  const identity = readOwnedDeliveryWorktree(input);
  try {
    const git = ownedGit(input);
    if (git(identity.path, ["status", "--porcelain"]) !== "") throw refused();
    for (const file of [pierreVisualFixture.diffFileName, visualFixture.image]) {
      const metadata = NodeFS.lstatSync(NodePath.join(identity.path, file));
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.nlink !== 1 ||
        metadata.size > 8192
      )
        throw refused();
    }
    if (
      NodeFS.readFileSync(
        NodePath.join(identity.path, pierreVisualFixture.diffFileName),
        "utf8",
      ) !== pierreVisualFixture.originalDiffContents ||
      !NodeFS.readFileSync(NodePath.join(identity.path, visualFixture.image)).equals(
        Buffer.from(swatches[0], "base64"),
      )
    )
      throw refused();
    NodeFS.writeFileSync(
      NodePath.join(identity.path, pierreVisualFixture.diffFileName),
      pierreVisualFixture.modifiedDiffContents,
    );
    NodeFS.writeFileSync(
      NodePath.join(identity.path, visualFixture.image),
      Buffer.from(swatches[1], "base64"),
    );
    return identity;
  } catch {
    throw refused();
  }
}

/** Verify the public staging action without retaining patch contents. */
export function visualPartialStageMatches(input: DeliveryWorktreeInput): boolean {
  const identity = readOwnedDeliveryWorktree(input);
  const git = ownedGit(input);
  const staged = git(identity.path, ["diff", "--cached", "--", pierreVisualFixture.diffFileName]);
  const unstaged = git(identity.path, ["diff", "--", pierreVisualFixture.diffFileName]);
  return (
    staged.includes('first = "changed one"') &&
    !staged.includes('second = "changed two"') &&
    !staged.includes('third = "changed three"') &&
    !unstaged.includes('first = "changed one"') &&
    unstaged.includes('second = "changed two"') &&
    unstaged.includes('third = "changed three"')
  );
}
