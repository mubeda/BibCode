// @effect-diagnostics nodeBuiltinImport:off - Only the admitted disposable managed checkout and Git anchors are read.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import type { OrchestrationThread } from "../../../../packages/contracts/src/orchestration.ts";
import {
  readOwnedDeliveryWorktree,
  type DeliveryWorktreeInput,
  type DeliveryWorktreeIdentity,
} from "./delivery-retry-workspace.ts";
import { withUnavailableWorkspace } from "./delivery-retry-evidence.ts";

/** Separately typed registered-managed-loss proof; ordinary worktree admission remains strict. */
export interface ProviderChatWorkspaceLossScope {
  readonly kind: "provider-chat-registered-managed-loss";
}
export interface ProviderChatLossBinding {
  readonly host: OrchestrationThread;
  readonly target: OrchestrationThread;
}

interface DirectoryAnchor {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}
interface FileAnchor extends DirectoryAnchor {
  readonly bytes: Buffer;
}
interface LossProof {
  readonly input: DeliveryWorktreeInput;
  readonly identity: DeliveryWorktreeIdentity;
  readonly moved: string;
  readonly directories: readonly DirectoryAnchor[];
  readonly selected: DirectoryAnchor;
  readonly pointer: FileAnchor;
  readonly backlink: FileAnchor;
  readonly registration: string;
  readonly threadId: string;
  readonly hostThreadId: string;
  readonly projectId: string;
}
const proofs = new WeakMap<ProviderChatWorkspaceLossScope, LossProof>();
const refused = () => new Error("Owned provider workspace loss refused.");

function directory(path: string): DirectoryAnchor {
  const stat = NodeFS.lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || NodeFS.realpathSync(path) !== path)
    throw refused();
  return Object.freeze({ path, dev: stat.dev, ino: stat.ino });
}
function file(path: string): FileAnchor {
  const stat = NodeFS.lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.size < 1 ||
    stat.size > 4096 ||
    NodeFS.realpathSync(path) !== path
  )
    throw refused();
  return Object.freeze({ path, dev: stat.dev, ino: stat.ino, bytes: NodeFS.readFileSync(path) });
}
function sameDirectory(anchor: DirectoryAnchor, path = anchor.path) {
  const current = directory(path);
  if (current.dev !== anchor.dev || current.ino !== anchor.ino) throw refused();
}
function sameFile(anchor: FileAnchor, path = anchor.path) {
  const current = file(path);
  if (
    current.dev !== anchor.dev ||
    current.ino !== anchor.ino ||
    !current.bytes.equals(anchor.bytes)
  )
    throw refused();
}
function registered(input: DeliveryWorktreeInput, identity: DeliveryWorktreeIdentity): string {
  const result = NodeChildProcess.spawnSync(
    input.git,
    ["-C", input.project, "-c", "core.fsmonitor=false", "worktree", "list", "--porcelain", "-z"],
    {
      encoding: "utf8",
      shell: false,
      timeout: 5000,
      killSignal: "SIGKILL",
      maxBuffer: 65536,
      env: {
        HOME: input.home,
        USERPROFILE: input.home,
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
  if (result.error || result.status !== 0 || !result.stdout.endsWith("\0\0")) throw refused();
  const records = result.stdout
    .slice(0, -2)
    .split("\0\0")
    .map((row) => row.split("\0"));
  if (records.length < 2 || records.length > 8) throw refused();
  const matches = records.filter((fields) =>
    fields.includes("branch refs/heads/" + identity.branch),
  );
  const primary = records.filter((fields) => fields[0] === "worktree " + input.project);
  if (
    matches.length !== 1 ||
    primary.length !== 1 ||
    matches[0]![0] !== "worktree " + identity.path
  )
    throw refused();
  const core = (fields: string[]) => {
    const keys = fields.filter(
      (value) =>
        value.startsWith("worktree ") || value.startsWith("HEAD ") || value.startsWith("branch "),
    );
    if (
      keys.length !== 3 ||
      keys.filter((value) => value.startsWith("HEAD ")).length !== 1 ||
      keys.filter((value) => value.startsWith("branch ")).length !== 1
    )
      throw refused();
    return keys.join("\0");
  };
  // Git may append its own prunable observation during loss; the registered
  // primary and selected path/HEAD/branch identities must remain identical.
  return core(primary[0]!) + "\0\0" + core(matches[0]!);
}
function matchedThread(
  binding: ProviderChatLossBinding,
  identity: DeliveryWorktreeIdentity,
  expected?: LossProof,
) {
  const { host, target: thread } = binding;
  if (
    !host ||
    host.kind !== "workspace" ||
    host.deletedAt !== null ||
    host.worktreePath !== identity.path ||
    host.branch !== identity.branch ||
    typeof host.id !== "string" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(host.id) ||
    !thread ||
    thread.deletedAt !== null ||
    thread.kind !== (thread.id === host.id ? "workspace" : "panel") ||
    thread.projectId !== host.projectId ||
    thread.worktreePath !== identity.path ||
    thread.branch !== identity.branch ||
    ![thread.id, thread.projectId].every(
      (value) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value),
    ) ||
    thread.modelSelection.instanceId !== "codex" ||
    thread.session?.providerName !== "codex" ||
    thread.session.threadId !== thread.id ||
    thread.session.providerInstanceId !== thread.modelSelection.instanceId ||
    (expected &&
      (host.id !== expected.hostThreadId ||
        thread.id !== expected.threadId ||
        thread.projectId !== expected.projectId))
  )
    throw refused();
}

/** Captures an opaque proof only while ordinary linked-worktree identity succeeds. */
export function bindProviderChatWorkspaceLoss(
  input: DeliveryWorktreeInput,
  binding: ProviderChatLossBinding,
): ProviderChatWorkspaceLossScope {
  try {
    const identity = Object.freeze(readOwnedDeliveryWorktree(input));
    matchedThread(binding, identity);
    const selected = directory(identity.path),
      pointer = file(NodePath.join(identity.path, ".git"));
    const value = /^gitdir: ([^\r\n]+)\n?$/.exec(pointer.bytes.toString("utf8"));
    if (!value) throw refused();
    const admin = NodeFS.realpathSync(NodePath.resolve(identity.path, value[1]!));
    if (NodePath.dirname(admin) !== NodePath.join(identity.commonDirectory, "worktrees"))
      throw refused();
    const proof: LossProof = Object.freeze({
      input: Object.freeze({ ...input }),
      identity,
      selected,
      pointer,
      moved: identity.path + ".delivery-missing",
      backlink: file(NodePath.join(admin, "gitdir")),
      directories: [
        directory(NodeFS.realpathSync(input.root)),
        directory(input.project),
        directory(input.home),
        directory(identity.commonDirectory),
        directory(admin),
      ],
      registration: registered(input, identity),
      threadId: binding.target.id,
      hostThreadId: binding.host.id,
      projectId: binding.target.projectId,
    });
    if (NodeFS.existsSync(proof.moved)) throw refused();
    const scope: ProviderChatWorkspaceLossScope = Object.freeze({
      kind: "provider-chat-registered-managed-loss",
    });
    proofs.set(scope, proof);
    return scope;
  } catch {
    throw refused();
  }
}

/** Reads only the exact renamed directory; it never realpaths the intentionally absent checkout. */
export function readProviderChatWorkspaceLoss(
  scope: ProviderChatWorkspaceLossScope,
  binding: ProviderChatLossBinding,
) {
  try {
    const proof = proofs.get(scope);
    if (!proof) throw refused();
    matchedThread(binding, proof.identity, proof);
    try {
      NodeFS.lstatSync(proof.identity.path);
      throw refused();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw refused();
    }
    for (const anchor of proof.directories) sameDirectory(anchor);
    sameDirectory(proof.selected, proof.moved);
    sameFile(proof.pointer, NodePath.join(proof.moved, ".git"));
    sameFile(proof.backlink);
    if (registered(proof.input, proof.identity) !== proof.registration) throw refused();
    return Object.freeze({
      registeredManagedLoss: true,
      originalAbsent: true,
      renamedIdentityMatched: true,
      primaryAnchorsRetained: true,
      threadProviderMatched: true,
    });
  } catch {
    throw refused();
  }
}

/** Restore through the existing rename owner; preserve a body error while unsafe cleanup stays fatal. */
export async function withProviderChatWorkspaceLoss<A>(
  input: {
    worktree: DeliveryWorktreeInput;
    readBinding: () => Promise<ProviderChatLossBinding>;
    observeUnsafeCleanup: () => void;
  },
  run: (scope: ProviderChatWorkspaceLossScope) => Promise<A>,
): Promise<A> {
  const scope = bindProviderChatWorkspaceLoss(input.worktree, await input.readBinding());
  const proof = proofs.get(scope)!;
  let bodyFailed = false,
    bodyError: unknown,
    cleanupFailed = false,
    result: A | undefined;
  try {
    await withUnavailableWorkspace(input.worktree.root, proof.identity.path, async () => {
      try {
        result = await run(scope);
      } catch (error) {
        bodyFailed = true;
        bodyError = error;
      }
    });
    const ordinary = readOwnedDeliveryWorktree(input.worktree);
    if (JSON.stringify(ordinary) !== JSON.stringify(proof.identity)) throw refused();
    sameDirectory(proof.selected);
    matchedThread(await input.readBinding(), proof.identity, proof);
  } catch {
    cleanupFailed = true;
    try {
      input.observeUnsafeCleanup();
    } catch {
      /* Closed observation cannot replace the owned failure. */
    }
  } finally {
    proofs.delete(scope);
  }
  if (bodyFailed) throw bodyError;
  if (cleanupFailed) throw refused();
  return result as A;
}
