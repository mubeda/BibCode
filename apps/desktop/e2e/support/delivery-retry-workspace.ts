// @effect-diagnostics nodeBuiltinImport:off - Read identity only from the private Git fixture.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
export interface DeliveryWorktreeInput {
  readonly root: string;
  readonly project: string;
  readonly home: string;
  readonly git: string;
  readonly branch: string;
}
export interface DeliveryWorktreeIdentity {
  readonly path: string;
  readonly branch: string;
  readonly commonDirectory: string;
}
export function readOwnedDeliveryWorktree(input: DeliveryWorktreeInput): DeliveryWorktreeIdentity {
  try {
    if (
      !/^codex\/delivery-retry-(light|dark)$/.test(input.branch) ||
      !NodePath.isAbsolute(input.git)
    )
      throw new Error();
    const root = NodeFS.realpathSync(input.root);
    const inside = (path: string) => {
      const relative = NodePath.relative(root, path);
      return (
        relative !== "" &&
        relative !== ".." &&
        !relative.startsWith(".." + NodePath.sep) &&
        !NodePath.isAbsolute(relative)
      );
    };
    const directory = (path: string) => {
      if (!NodePath.isAbsolute(path) || !inside(NodePath.resolve(path))) throw new Error();
      const canonical = NodeFS.realpathSync(path);
      if (!inside(canonical) || !NodeFS.statSync(canonical).isDirectory()) throw new Error();
      return canonical;
    };
    const project = directory(input.project),
      home = directory(input.home);
    const primaryGit = NodePath.join(project, ".git");
    if (
      !NodeFS.lstatSync(primaryGit).isDirectory() ||
      NodeFS.lstatSync(primaryGit).isSymbolicLink()
    )
      throw new Error();
    const git = (cwd: string, args: string[]) => {
      const result = NodeChildProcess.spawnSync(
        input.git,
        ["-C", cwd, "-c", "core.fsmonitor=false", ...args],
        {
          encoding: "utf8",
          shell: false,
          timeout: 5_000,
          killSignal: "SIGKILL",
          maxBuffer: 65_536,
          env: {
            HOME: home,
            PATH: NodePath.dirname(input.git),
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_SYSTEM: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
            GIT_OPTIONAL_LOCKS: "0",
            LC_ALL: "C",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      if (result.error || result.status !== 0) throw new Error();
      return result.stdout;
    };
    const inventory = git(project, ["worktree", "list", "--porcelain", "-z"]);
    if (!inventory.endsWith("\0\0")) throw new Error();
    const records = inventory
      .slice(0, -2)
      .split("\0\0")
      .map((record) => record.split("\0"));
    if (records.length < 2 || records.length > 8) throw new Error();
    const matches = records.filter((fields) =>
      fields.includes("branch refs/heads/" + input.branch),
    );
    if (matches.length !== 1) throw new Error();
    const paths = matches[0]!.filter((field) => field.startsWith("worktree "));
    if (paths.length !== 1) throw new Error();
    const path = directory(paths[0]!.slice("worktree ".length));
    if (path === project || !records.some((fields) => fields[0] === "worktree " + project))
      throw new Error();
    // Linked worktrees must point back into this primary's admin directory before
    // any Git command is run from the candidate checkout.
    const gitFile = NodePath.join(path, ".git"),
      metadata = NodeFS.lstatSync(gitFile);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 4096) throw new Error();
    const pointer = /^gitdir: ([^\r\n]+)\n?$/.exec(NodeFS.readFileSync(gitFile, "utf8"));
    if (!pointer) throw new Error();
    const admin = NodeFS.realpathSync(NodePath.resolve(path, pointer[1]!));
    if (NodePath.dirname(admin) !== NodePath.join(primaryGit, "worktrees")) throw new Error();
    const backLink = NodePath.join(admin, "gitdir");
    const backMetadata = NodeFS.lstatSync(backLink);
    if (!backMetadata.isFile() || backMetadata.isSymbolicLink() || backMetadata.size > 4096)
      throw new Error();
    const backPath = NodePath.resolve(admin, NodeFS.readFileSync(backLink, "utf8").trim());
    if (!inside(backPath) || NodeFS.realpathSync(backPath) !== gitFile) throw new Error();
    const commonDirectory = NodeFS.realpathSync(
      git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim(),
    );
    if (commonDirectory !== primaryGit || !NodeFS.statSync(commonDirectory).isDirectory())
      throw new Error();
    return { path, branch: input.branch, commonDirectory };
  } catch {
    // Git stdout/stderr, paths and native causes are private fixture data.
    throw new Error("Owned delivery worktree identity refused.");
  }
}

/** Public rendered-card identity only; no renderer stores, input values or arbitrary URLs. */
export function readSelectedDeliveryWorktree(input: {
  origin: string;
  branch: string;
  boundThreadId: string | null;
}): { threadId: string } | null {
  if (
    input.origin !== "http://127.0.0.1:4885" ||
    location.origin !== input.origin ||
    location.search !== "" ||
    location.hash !== "" ||
    !/^codex\/delivery-retry-(light|dark)$/.test(input.branch) ||
    (input.boundThreadId !== null &&
      (typeof input.boundThreadId !== "string" ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(input.boundThreadId)))
  )
    return null;
  const selected = document.querySelectorAll(
    '[data-testid^="thread-card-button-"][aria-current="page"]',
  );
  if (selected.length !== 1) return null;
  const card = selected[0]!;
  const id = card.getAttribute("data-testid")?.slice("thread-card-button-".length) ?? "";
  if (
    !/^[A-Za-z0-9._:-]{1,128}$/.test(id) ||
    location.pathname !== "/local/" + id ||
    (input.boundThreadId !== null && input.boundThreadId !== id)
  )
    return null;
  const row = document.querySelector(`[data-testid="thread-row-${id}"]`);
  if (
    input.boundThreadId === null &&
    row?.querySelector(`[data-testid="thread-title-${id}"]`)?.textContent?.trim() !==
      input.branch.replaceAll("-", " ")
  )
    return null;
  const descriptions = (card.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter((value) => value.endsWith("-branch"));
  if (
    descriptions.length !== 1 ||
    document
      .getElementById(descriptions[0]!)
      ?.querySelector('[data-slot="tooltip-trigger"]')
      ?.textContent?.trim() !== input.branch
  )
    return null;
  return { threadId: id };
}
