// @effect-diagnostics nodeBuiltinImport:off - CI qualification owns only private fixture/source joins.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import type { ExecutionEnvironmentDescriptor } from "../../../../packages/contracts/src/environment.ts";
import type { OrchestrationReadModel } from "../../../../packages/contracts/src/orchestration.ts";
import { type QualificationBrowser, type QualificationOwner } from "./qualification-owner.ts";
import type { GitProjectVisualSelection } from "./release-visual-git-project.ts";
import { createPullRequestsOwnerAdapters } from "./release-visual-pull-requests-owner.ts";
import {
  withPullRequestsPublicApi,
  type PullRequestsPublicPorts,
} from "./release-visual-pull-requests-api.ts";
import { runPullRequestsVisual } from "./release-visual-pull-requests-producer.ts";
import {
  capturePullRequestsOwnedScene,
  pullRequestsCaptureBindings,
  validatePullRequestsCaptureWitness,
} from "./release-visual-pull-requests.ts";
import type {
  PullRequestsHostingFixture,
  PullRequestsGitPortResult,
} from "./release-visual-pull-requests-installer.ts";
const refused = () => new Error("Owned request caller refused.");
const hash = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
type Git = (cwd: string, args: readonly string[]) => Promise<PullRequestsGitPortResult>;
function ownedDirectory(root: string, path: string) {
  const relative = NodePath.relative(root, path),
    stat = NodeFS.lstatSync(path);
  if (
    !NodePath.isAbsolute(path) ||
    NodePath.normalize(path) !== path ||
    NodeFS.realpathSync(path) !== path ||
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.uid !== NodeFS.lstatSync(root).uid ||
    relative === ".." ||
    relative.startsWith(".." + NodePath.sep) ||
    NodePath.isAbsolute(relative)
  )
    throw refused();
}
function readOwnedFile(root: string, path: string, max: number) {
  const relative = NodePath.relative(root, path),
    stat = NodeFS.lstatSync(path);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(".." + NodePath.sep) ||
    NodePath.isAbsolute(relative) ||
    NodeFS.realpathSync(path) !== path ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== NodeFS.lstatSync(root).uid ||
    stat.size < 1 ||
    stat.size > max
  )
    throw refused();
  const fd = NodeFS.openSync(
    path,
    NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
  );
  try {
    const opened = NodeFS.fstatSync(fd),
      bytes = NodeFS.readFileSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || bytes.length !== stat.size)
      throw refused();
    return bytes;
  } finally {
    NodeFS.closeSync(fd);
  }
}
/** Real filesystem/Git reads; no hosting command, network or canonical state mutation. */
export async function createPullRequestsPhysicalJoins(input: {
  fixture: PullRequestsHostingFixture;
  sourceSha: string;
  originalCwd: string;
  git: Git;
}) {
  const { fixture } = input;
  if (
    !/^[0-9a-f]{40}$/.test(input.sourceSha) ||
    fixture.sourceSha !== input.sourceSha ||
    !/\/(light|dark)$/.test(fixture.root) ||
    (NodeFS.lstatSync(fixture.root).mode & 0o077) !== 0
  )
    throw refused();
  const read = async (cwd: string, args: readonly string[], missing = false) => {
    ownedDirectory(fixture.root, cwd);
    const result = await input.git(cwd, args);
    if (
      (result.status !== 0 && !(missing && result.status === 1)) ||
      typeof result.stdout !== "string" ||
      Buffer.byteLength(result.stdout) > 65536
    )
      throw refused();
    return result.status === 1 ? null : result.stdout.trim();
  };
  const verifySealed = () => {
    ownedDirectory(fixture.root, fixture.root);
    for (const [file, expected] of Object.entries(fixture.hashes)) {
      const bytes = readOwnedFile(fixture.root, file, 1048576),
        mode = NodeFS.lstatSync(file).mode & 0o777;
      if (
        hash(bytes) !== expected ||
        mode !==
          (file === fixture.engine || Object.values(fixture.executables).includes(file)
            ? 0o500
            : 0o600)
      )
        throw refused();
    }
  };
  verifySealed();
  const proof = async (cwd: string) => {
    ownedDirectory(fixture.root, cwd);
    ownedDirectory(fixture.root, NodePath.join(cwd, ".git"));
    const branch = await read(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
      head = await read(cwd, ["rev-parse", "--verify", "HEAD"]),
      origin = await read(cwd, ["config", "--get", "remote.origin.url"], true),
      configSha = hash(readOwnedFile(fixture.root, NodePath.join(cwd, ".git", "config"), 8192));
    if (
      !branch ||
      !head ||
      !/^[0-9a-f]{40}$/.test(head) ||
      readOwnedFile(fixture.root, NodePath.join(cwd, ".git", "HEAD"), 256).toString("utf8") !==
        "ref: refs/heads/" + branch + "\n"
    )
      throw refused();
    if ((await read(cwd, ["status", "--porcelain", "--untracked-files=all"])) !== "")
      throw refused();
    return { branch, head, origin, configSha };
  };
  const original = await proof(input.originalCwd);
  const verifyOriginal = async () => {
    verifySealed();
    if (JSON.stringify(await proof(input.originalCwd)) !== JSON.stringify(original))
      throw refused();
  };
  const verifySource = async (
    provider: "github" | "gitlab",
    selection: GitProjectVisualSelection,
  ) => {
    verifySealed();
    const expected = fixture.projects[provider];
    if (
      selection.cwd !== expected.cwd ||
      selection.environmentId !== "local" ||
      selection.title !== provider ||
      selection.branch !== "visual-request"
    )
      throw refused();
    const actual = await proof(selection.cwd);
    if (
      actual.branch !== "visual-request" ||
      actual.head !== expected.headSha ||
      actual.origin !== expected.origin ||
      actual.configSha !== expected.originConfigSha256
    )
      throw refused();
    ownedDirectory(fixture.root, expected.bareRemote);
    if (
      (await read(expected.bareRemote, ["rev-parse", "--verify", "refs/heads/main"])) !==
        expected.baseSha ||
      (await read(expected.bareRemote, ["rev-parse", "--verify", "refs/heads/visual-create"])) !==
        expected.headSha
    )
      throw refused();
    if (
      (await read(selection.cwd, ["rev-parse", "--verify", "refs/remotes/origin/main"])) !==
        expected.baseSha ||
      (await read(selection.cwd, [
        "rev-parse",
        "--verify",
        "refs/remotes/origin/visual-create",
      ])) !== expected.headSha ||
      (await read(selection.cwd, [
        "diff",
        expected.baseSha,
        expected.headSha,
        "--",
        "visual-request.ts",
      ])) !== expected.patch.trim()
    )
      throw refused();
  };
  const hosting = createHostingRestorationOwner(fixture, verifySealed);
  return { verifySealed, verifySource, verifyOriginal, original, hosting };
}
export interface PullRequestsHostingRestorationProof {
  source: string;
  theme: "light" | "dark";
  baselineRestored: true;
  undoCompleted: true;
  inputsUnchanged: true;
  ownedProcessesJoined: true;
  configSha256: string;
  hostingInputsSha256: string;
  baselineStateSha256: string;
  completionLogSha256: string;
  mutableFilesIdentitySha256: string;
}
function createHostingRestorationOwner(
  fixture: PullRequestsHostingFixture,
  verifySealed: () => void,
) {
  const hosting = NodePath.join(fixture.root, "hosting"),
    uid = NodeFS.lstatSync(fixture.root).uid;
  const configBytes = readOwnedFile(fixture.root, fixture.config, 1048576),
    config = ownRecord(JSON.parse(configBytes.toString("utf8")));
  const state = NodePath.join(hosting, "host-state.json"),
    calls = NodePath.join(hosting, "host-calls.jsonl");
  if (
    Object.keys(config).sort().join("|") !==
      ["root", "sourceSha", "uid", "projects", "exchanges", "state", "calls"].sort().join("|") ||
    config.root !== fixture.root ||
    config.sourceSha !== fixture.sourceSha ||
    config.uid !== uid ||
    config.state !== state ||
    config.calls !== calls
  )
    throw refused();
  const exchanges = ownRecord(config.exchanges),
    policy = (provider: "github" | "gitlab") => {
      const table = exchanges[provider];
      if (!Array.isArray(table)) throw refused();
      return table.map(ownRecord);
    };
  const tables = { github: policy("github"), gitlab: policy("gitlab") };
  const inputHash = () =>
    hash(
      Buffer.from(
        Object.keys(fixture.hashes)
          .sort()
          .map(
            (file) =>
              NodePath.relative(fixture.root, file) +
              "\0" +
              hash(readOwnedFile(fixture.root, file, 1048576)) +
              "\n",
          )
          .join(""),
      ),
    );
  const ownedStat = (file: string, max: number) => {
    const stat = NodeFS.lstatSync(file);
    if (
      NodeFS.realpathSync(file) !== file ||
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== uid ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > max
    )
      throw refused();
    return stat;
  };
  const logIdentity = ownedStat(calls, 65536);
  const readMutable = (file: string, max: number, appendOnly = false): Buffer | null => {
    const stat = ownedStat(file, max);
    if (appendOnly && (stat.dev !== logIdentity.dev || stat.ino !== logIdentity.ino))
      throw refused();
    const fd = NodeFS.openSync(
      file,
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW | NodeFS.constants.O_NONBLOCK,
    );
    try {
      const opened = NodeFS.fstatSync(fd);
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        opened.uid !== uid ||
        (opened.mode & 0o777) !== 0o600 ||
        opened.size > max
      )
        throw refused();
      if (opened.dev !== stat.dev || opened.ino !== stat.ino) return null;
      const bytes = Buffer.alloc(stat.size),
        size = NodeFS.readSync(fd, bytes, 0, bytes.length, 0);
      if (size !== stat.size) return null;
      return bytes;
    } finally {
      NodeFS.closeSync(fd);
    }
  };
  const read = () => {
    verifySealed();
    ownedDirectory(fixture.root, hosting);
    if ((NodeFS.lstatSync(hosting).mode & 0o777) !== 0o700) throw refused();
    const expected = new Set([
      "bin",
      "origins.gitconfig",
      "host-state.json",
      "host-calls.jsonl",
      "hosting-config.json",
    ]);
    let pendingWriter = false;
    for (const name of NodeFS.readdirSync(hosting)) {
      if (expected.has(name)) continue;
      if (!/^host-state\.json\.[0-9a-f-]{36}$/.test(name)) throw refused();
      ownedStat(NodePath.join(hosting, name), 4096);
      pendingWriter = true;
    }
    const stateBytes = readMutable(state, 4096),
      callBytes = readMutable(calls, 65536, true);
    if (!stateBytes || !callBytes || pendingWriter) return null;
    const value = ownRecord(JSON.parse(stateBytes.toString("utf8")));
    if (Object.keys(value).length !== 1 || typeof value.labelApplied !== "boolean") throw refused();
    const text = callBytes.toString("utf8");
    if (text && (!text.endsWith("\n") || text.split("\n").length > 201)) throw refused();
    const records = text
      ? text
          .trimEnd()
          .split("\n")
          .map((line) => ownRecord(JSON.parse(line)))
      : [];
    for (const item of records) {
      if (
        Object.keys(item).sort().join("|") !==
          [
            "kind",
            "provider",
            "number",
            "success",
            "bodySha256",
            "mutation",
            "stateSha256",
            "stateIdentitySha256",
          ]
            .sort()
            .join("|") ||
        (item.provider !== "github" && item.provider !== "gitlab") ||
        typeof item.success !== "boolean" ||
        (item.bodySha256 !== null &&
          (typeof item.bodySha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.bodySha256))) ||
        !tables[item.provider].some(
          (entry) =>
            entry.kind === item.kind &&
            entry.number === item.number &&
            (entry.exitCode === 0) === item.success,
        )
      )
        throw refused();
      if (item.kind === "labels") {
        if (
          item.provider !== "github" ||
          item.number !== 43 ||
          item.success !== true ||
          item.bodySha256 !== null ||
          !["label-add", "label-remove"].includes(String(item.mutation)) ||
          [item.stateSha256, item.stateIdentitySha256].some(
            (value) => typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value),
          )
        )
          throw refused();
      } else if (
        item.mutation !== null ||
        item.stateSha256 !== null ||
        item.stateIdentitySha256 !== null
      )
        throw refused();
    }
    return {
      stateBytes,
      callBytes,
      labelApplied: value.labelApplied,
      mutations: records.filter((item) => item.kind === "labels"),
    };
  };
  const baseline = read();
  if (!baseline || baseline.labelApplied !== false || baseline.mutations.length !== 0)
    throw refused();
  const identityHash = () =>
    hash(
      Buffer.from(
        [state, calls]
          .map((file) => {
            const stat = ownedStat(file, file === state ? 4096 : 65536);
            return (
              NodePath.basename(file) +
              "\0" +
              stat.dev +
              ":" +
              stat.ino +
              ":" +
              stat.uid +
              ":" +
              (stat.mode & 0o777) +
              "\n"
            );
          })
          .join(""),
      ),
    );
  const configSha256 = hash(configBytes),
    hostingInputsSha256 = inputHash(),
    baselineStateSha256 = hash(baseline.stateBytes);
  const restored = () => {
    const current = read();
    if (!current) return null;
    if (!current.callBytes.subarray(0, baseline.callBytes.length).equals(baseline.callBytes))
      throw refused();
    if (current.mutations.length < 2) {
      if (current.mutations.length === 1 && current.mutations[0]!.mutation !== "label-add")
        throw refused();
      return null;
    }
    if (
      current.mutations.length !== 2 ||
      current.mutations[0]!.mutation !== "label-add" ||
      current.mutations[1]!.mutation !== "label-remove" ||
      current.labelApplied !== false ||
      current.mutations[0]!.stateSha256 !==
        hash(Buffer.from(JSON.stringify({ labelApplied: true }))) ||
      current.mutations[1]!.stateSha256 !== baselineStateSha256 ||
      current.mutations[1]!.stateIdentitySha256 !==
        hash(
          Buffer.from(
            (() => {
              const stat = ownedStat(state, 4096);
              return (
                NodePath.basename(state) +
                "\0" +
                stat.dev +
                ":" +
                stat.ino +
                ":" +
                stat.uid +
                ":" +
                (stat.mode & 0o777) +
                "\n"
              );
            })(),
          ),
        ) ||
      hash(current.stateBytes) !== baselineStateSha256 ||
      inputHash() !== hostingInputsSha256
    )
      throw refused();
    return {
      source: fixture.sourceSha,
      theme: NodePath.basename(fixture.root) as "light" | "dark",
      baselineRestored: true as const,
      undoCompleted: true as const,
      inputsUnchanged: true as const,
      configSha256,
      hostingInputsSha256,
      baselineStateSha256,
      completionLogSha256: hash(current.callBytes),
      mutableFilesIdentitySha256: identityHash(),
    };
  };
  return {
    restored,
    afterOwnedClose: (): PullRequestsHostingRestorationProof => {
      const proof = restored();
      if (!proof) throw refused();
      return { ...proof, ownedProcessesJoined: true };
    },
  };
}
function readOriginalPrimary(input: { origin: string; selection: GitProjectVisualSelection }) {
  const cards = document.querySelectorAll(
    '[data-testid="primary-card-button-' + input.selection.projectId + '"]',
  );
  return (
    location.origin === input.origin &&
    location.pathname === "/local/" + input.selection.threadId &&
    location.search === "" &&
    location.hash === "" &&
    cards.length === 1 &&
    cards[0]!.getAttribute("aria-current") === "page" &&
    document.querySelectorAll(
      '[data-testid="environment-rail-local"][aria-checked="true"] [data-status="connected"]',
    ).length === 1 &&
    document.querySelector(
      '#pairing-token,input[type="password"],input[autocomplete="one-time-code"]',
    ) === null
  );
}
export interface PullRequestsCallerInput {
  CI: string | undefined;
  sourceSha: string;
  theme: "light" | "dark";
  origin: string;
  fixture: PullRequestsHostingFixture;
  originalCwd: string;
  git: Git;
  browser: QualificationBrowser;
  owner: Pick<QualificationOwner, "until" | "cleanup">;
  readSnapshot: () => Promise<OrchestrationReadModel>;
  readDescriptor: () => Promise<ExecutionEnvironmentDescriptor>;
  issueContextAccessToken: () => Promise<string>;
  publicPorts?: PullRequestsPublicPorts;
  importProject: (
    cwd: string,
    bindSource?: () => Promise<GitProjectVisualSelection>,
  ) => Promise<void>;
  evidence: string;
  captured: Set<string>;
  captures: object[];
  assertions: object[];
  step: (phase: string) => void;
  write: (name: string, value: unknown) => void;
  unsafe: () => void;
  registerHostingRestorationOwner: (verify: () => PullRequestsHostingRestorationProof) => void;
}
/** Complete normal public caller: original primary, repository imports, typed reads and original bytes. */
async function runOwnedPullRequestsSelectionImpl(input: PullRequestsCallerInput) {
  if (
    input.CI !== "true" ||
    input.origin !== "http://127.0.0.1:4885" ||
    NodePath.basename(input.fixture.root) !== input.theme
  )
    throw refused();
  const physical = await createPullRequestsPhysicalJoins(input),
    descriptor = await input.readDescriptor();
  input.registerHostingRestorationOwner(physical.hosting.afterOwnedClose);
  const requiredCapabilities = [
    "repositoryIdentity",
    "pullRequestsReads",
    "pullRequestsMutations",
    "gitManagerReads",
    "gitManagerPullRequests",
    "gitPullRequestBranchSelection",
    "gitManagerBranchSyncOperations",
  ] as const;
  if (
    descriptor.environmentId !== "local" ||
    !descriptor.bootId ||
    !descriptor.storageInstanceId ||
    requiredCapabilities.some((key) => descriptor.capabilities[key] !== true)
  )
    throw refused();
  const verifyServer = async () => {
    const current = await input.readDescriptor();
    if (
      current.environmentId !== descriptor.environmentId ||
      current.bootId !== descriptor.bootId ||
      current.storageInstanceId !== descriptor.storageInstanceId ||
      current.serverVersion !== descriptor.serverVersion ||
      requiredCapabilities.some((key) => current.capabilities[key] !== true)
    )
      throw refused();
  };
  let original: GitProjectVisualSelection | null = null;
  const readOriginal = (): GitProjectVisualSelection | null => original;
  const sourceOriginal = async () => {
    const selected = readOriginal();
    if (!selected) throw refused();
    await verifyServer();
    await physical.verifyOriginal();
    const snapshot = await input.readSnapshot(),
      projects = snapshot.projects.filter(
        (p) =>
          p.deletedAt === null && (p.id === selected.projectId || p.workspaceRoot === selected.cwd),
      ),
      threads = snapshot.threads.filter(
        (t) => t.deletedAt === null && t.projectId === selected.projectId && t.kind === "default",
      );
    if (
      projects.length !== 1 ||
      projects[0]!.id !== selected.projectId ||
      projects[0]!.workspaceRoot !== selected.cwd ||
      projects[0]!.title !== selected.title ||
      threads.length !== 1 ||
      threads[0]!.id !== selected.threadId ||
      threads[0]!.worktreePath !== null ||
      threads[0]!.session !== null ||
      threads[0]!.latestTurn !== null ||
      threads[0]!.messages.length !== 0
    )
      throw refused();
  };
  input.step("visual-pull-requests-original-import");
  await input.importProject(input.originalCwd, async () => {
    await input.owner.until(async () => {
      const snapshot = await input.readSnapshot(),
        projects = snapshot.projects.filter(
          (p) => p.workspaceRoot === input.originalCwd && p.deletedAt === null,
        );
      if (projects.length === 0) return false;
      if (projects.length !== 1) throw refused();
      const project = projects[0]!,
        threads = snapshot.threads.filter(
          (t) => t.projectId === project.id && t.deletedAt === null && t.kind === "default",
        );
      if (threads.length === 0) return false;
      if (
        threads.length !== 1 ||
        ![project.id, threads[0]!.id].every((id) => /^[A-Za-z0-9._:-]{1,128}$/.test(id))
      )
        throw refused();
      original = Object.freeze({
        projectId: project.id,
        threadId: threads[0]!.id,
        environmentId: "local",
        cwd: input.originalCwd,
        title: project.title,
        branch: physical.original.branch,
      });
      await sourceOriginal();
      return true;
    });
    const selected = readOriginal();
    if (!selected) throw refused();
    return selected;
  });
  await sourceOriginal();
  const restoreOriginal = async () => {
    const selected = readOriginal();
    if (!selected) throw refused();
    await sourceOriginal();
    const selector = '[data-testid="primary-card-button-' + selected.projectId + '"]',
      control = input.browser.$(selector);
    await control.waitForDisplayed();
    if ((await input.browser.$$(selector).length) !== 1) throw refused();
    await control.waitForEnabled();
    await control.click();
  };
  const verifyRestoredIdentity = async () => {
    const selected = readOriginal();
    if (!selected) throw refused();
    await sourceOriginal();
    await input.owner.until(async () =>
      input.browser.execute(readOriginalPrimary, { origin: input.origin, selection: selected }),
    );
  };
  await verifyRestoredIdentity();
  const adapters = createPullRequestsOwnerAdapters({
    ...input,
    verifyServer,
    verifySource: physical.verifySource,
  });
  const accessToken = await input.issueContextAccessToken();
  const proof = await withPullRequestsPublicApi(
    {
      CI: input.CI,
      accessToken,
      ...(input.publicPorts ? { ports: input.publicPorts } : {}),
      bindings: (["github", "gitlab"] as const).map((provider) => ({
        cwd: input.fixture.projects[provider].cwd,
        provider,
        host: provider + ".visual.invalid",
        repository: "owned/requests",
        account: "viewer",
      })),
      observeCleanupFailure: input.unsafe,
    },
    async (api) =>
      runPullRequestsVisual({
        ...input,
        ...adapters,
        readContext: (selection) => api.getContext(selection.cwd),
        restoreOriginal,
        verifyRestoredIdentity,
        verifyHostingBaselineRestored: async () => {
          await input.owner.until(async () => physical.hosting.restored() !== null);
        },
        capture: async (binding, selection) => {
          const receipt = await capturePullRequestsOwnedScene({
            ...input,
            binding,
            selection,
            verifyOwnedIdentity: () => adapters.verifyOwnedIdentity(selection),
            readContext: () => api.getContext(selection.cwd),
          });
          input.captures.push(receipt);
          input.write("assertions", { captures: input.captures, assertions: input.assertions });
          return receipt;
        },
      }),
  );
  await physical.verifyOriginal();
  physical.verifySealed();
  if (!physical.hosting.restored()) throw refused();
  await verifyServer();
  if (
    proof.files.length !==
    pullRequestsCaptureBindings.filter((value) => value.theme === input.theme).length
  )
    throw refused();
  input.assertions.push(proof);
  input.write("assertions", { captures: input.captures, assertions: input.assertions });
  return proof;
}
export async function runOwnedPullRequestsSelection(input: PullRequestsCallerInput) {
  try {
    return await runOwnedPullRequestsSelectionImpl(input);
  } catch (error) {
    try {
      input.unsafe();
    } catch {}
    throw error;
  }
}
function ownRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || NodeUtil.types.isProxy(value))
    throw refused();
  const record: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") throw refused();
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (!field?.enumerable || !Object.hasOwn(field, "value")) throw refused();
    record[key] = field.value;
  }
  return record;
}
export function validatePullRequestsCallerJoins(
  captures: readonly object[],
  assertions: readonly object[],
) {
  if (
    NodeUtil.types.isProxy(captures) ||
    NodeUtil.types.isProxy(assertions) ||
    captures.length !== pullRequestsCaptureBindings.length ||
    assertions.length !== 2
  )
    throw refused();
  const seen = new Set<string>();
  for (const value of captures) {
    const item = ownRecord(value);
    const binding = pullRequestsCaptureBindings.find(
      (entry) =>
        entry.file === item.file &&
        entry.row === item.row &&
        entry.substate === item.substate &&
        entry.theme === item.theme,
    );
    if (
      !binding ||
      seen.has(binding.file) ||
      item.width !== 1280 ||
      item.height !== 960 ||
      typeof item.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(item.sha256)
    )
      throw refused();
    validatePullRequestsCaptureWitness(item.witness);
    seen.add(binding.file);
  }
  const proofs = assertions.map(ownRecord);
  for (const theme of ["light", "dark"]) {
    const values = proofs.filter((value) => value.theme === theme);
    if (values.length !== 1) throw refused();
    const proof = values[0]!;
    if (Array.isArray(proof.files) && !NodeUtil.types.isProxy(proof.files)) {
      const keys = Reflect.ownKeys(proof.files);
      if (
        keys.length !== 25 ||
        !keys.every(
          (key) =>
            key === "length" || (typeof key === "string" && /^(?:[0-9]|1[0-9]|2[0-3])$/.test(key)),
        )
      )
        throw refused();
      for (let index = 0; index < 24; index++) {
        const field = Object.getOwnPropertyDescriptor(proof.files, String(index));
        if (!field?.enumerable || !Object.hasOwn(field, "value") || typeof field.value !== "string")
          throw refused();
      }
    }
    if (
      proof.baseRows !== 5 ||
      proof.supplementalOriginals !== 19 ||
      proof.originalContextRestored !== true ||
      proof.hostingBaselineRestored !== true ||
      !Array.isArray(proof.files) ||
      NodeUtil.types.isProxy(proof.files) ||
      proof.files.length !== 24 ||
      new Set(proof.files).size !== 24 ||
      proof.files.some(
        (file) =>
          !pullRequestsCaptureBindings.some(
            (value) => value.theme === theme && value.file === file,
          ),
      )
    )
      throw refused();
  }
}
