// @effect-diagnostics nodeBuiltinImport:off - CI-only owned fixture files and native public contracts.
// @effect-diagnostics globalFetch:off - Fixed owned loopback descriptor endpoints only.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import { ExecutionEnvironmentDescriptor } from "../../../../packages/contracts/src/environment.ts";
import type { ServerConfig } from "../../../../packages/contracts/src/server.ts";
import type { OrchestrationReadModel } from "../../../../packages/contracts/src/orchestration.ts";
import { remoteEnvironmentId } from "../../../../packages/client-runtime/src/connection/remoteIdentity.ts";
import { prepareDesktopUiTestContext, type DesktopUiTestContext } from "./test-project.ts";
import {
  bounded,
  type QualificationOwner,
  type QualificationBrowser,
  type QualificationProcess,
} from "./qualification-owner.ts";
import { fixtureAccessToken } from "./remote-ui-rpc.ts";
import { prepareSettingsFollowupUsageFixture } from "./release-visual-settings-followups-fixture.ts";
import { withSettingsFollowupApi } from "./release-visual-settings-followups-api.ts";
import { withSettingsFollowupSocket } from "./release-visual-settings-followups-socket.ts";
import { runSettingsFollowupProducer } from "./release-visual-settings-followups-producer.ts";
import {
  captureSettingsFollowup,
  projectSettingsFollowupAssertion,
} from "./release-visual-settings-followups.ts";
import {
  verifySettingsFollowupSource,
  type SettingsFollowupTarget,
  type SettingsFollowupPhysicalSource,
} from "./release-visual-settings-followups-source.ts";
const Schema = NodeModule.createRequire(
  new NodeURL.URL("../../../../packages/contracts/package.json", import.meta.url),
)("effect/Schema");
const refused = () => new Error("Owned settings follow-up caller refused.");
const unsafe = (observe: () => void) => {
  try {
    observe();
  } catch {
    /* Preserve the original failure. */
  }
};
const digest = (bytes: Buffer) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** A copied development interpreter belongs to the same private fixture as its inputs. */
export async function prepareSettingsFollowupCallerUsage(input: {
  CI: string | undefined;
  root: string;
  home: string;
  nodeExecutable: string;
  environment: NodeJS.ProcessEnv;
  admitOwner: () => Promise<void>;
  childrenJoined: () => boolean;
  inputsSafeToDelete: () => boolean;
  observeUnsafeCleanup: () => void;
}) {
  if (input.CI !== "true") throw refused();
  await input.admitOwner();
  const relativeHome = NodePath.relative(input.root, input.home);
  if (
    !NodePath.isAbsolute(input.root) ||
    input.root === NodePath.parse(input.root).root ||
    !relativeHome ||
    relativeHome === ".." ||
    relativeHome.startsWith(".." + NodePath.sep) ||
    NodePath.isAbsolute(relativeHome)
  )
    throw refused();
  const source = NodeFS.lstatSync(input.nodeExecutable);
  if (
    !source.isFile() ||
    source.isSymbolicLink() ||
    source.nlink !== 1 ||
    source.size > 256 * 1024 * 1024 ||
    !(source.mode & 0o111) ||
    NodeFS.realpathSync(input.nodeExecutable) !== input.nodeExecutable
  )
    throw refused();
  for (const path of [input.root, input.home]) {
    const stat = NodeFS.lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || NodeFS.realpathSync(path) !== path)
      throw refused();
    NodeFS.chmodSync(path, 0o700);
  }
  const node = NodePath.join(input.root, "owned-settings-node");
  NodeFS.copyFileSync(input.nodeExecutable, node, NodeFS.constants.COPYFILE_EXCL);
  NodeFS.chmodSync(node, 0o500);
  const anchor = NodeFS.lstatSync(node),
    hash = digest(NodeFS.readFileSync(node));
  const verifyNode = () => {
    const stat = NodeFS.lstatSync(node);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      stat.dev !== anchor.dev ||
      stat.ino !== anchor.ino ||
      stat.mode !== anchor.mode ||
      stat.size !== anchor.size ||
      NodeFS.realpathSync(node) !== node ||
      digest(NodeFS.readFileSync(node)) !== hash
    )
      throw refused();
  };
  let usage: Awaited<ReturnType<typeof prepareSettingsFollowupUsageFixture>>;
  let deletionRefused = false;
  const markUnsafe = () => {
    deletionRefused = true;
    unsafe(input.observeUnsafeCleanup);
  };
  try {
    usage = await prepareSettingsFollowupUsageFixture({
      ...input,
      node,
      observeUnsafeCleanup: markUnsafe,
    });
  } catch (error) {
    try {
      if (deletionRefused || !input.inputsSafeToDelete()) throw refused();
      verifyNode();
      NodeFS.unlinkSync(node);
    } catch {
      markUnsafe();
    }
    throw error;
  }
  const environment: NodeJS.ProcessEnv = {
    ...input.environment,
    HOME: input.home,
    CODEX_BIN: usage.executable,
  };
  for (const key of Object.keys(environment))
    if (key.toUpperCase() === "CODEX_HOME") delete environment[key];
  let closed = false;
  return {
    node,
    executable: usage.executable,
    environment,
    verify: () => {
      if (closed) throw refused();
      try {
        verifyNode();
        usage.verify();
      } catch (error) {
        markUnsafe();
        throw error;
      }
    },
    close: () => {
      if (closed) return;
      try {
        if (deletionRefused || !input.inputsSafeToDelete() || !input.childrenJoined())
          throw refused();
        verifyNode();
        usage.verify();
        usage.close();
        NodeFS.unlinkSync(node);
        closed = true;
      } catch (error) {
        markUnsafe();
        throw error;
      }
    },
  };
}

/** Native schemas own these values; the client ID is derived only at this boundary. */
export function bindSettingsFollowupTarget(input: {
  ownedRoot: string;
  descriptor: ExecutionEnvironmentDescriptor;
  config: ServerConfig;
  snapshot: OrchestrationReadModel;
  threadId: string;
  workspaceKind: "primary" | "worktree";
  physical: SettingsFollowupPhysicalSource;
  remote: boolean;
}): SettingsFollowupTarget {
  const threads = input.snapshot.threads.filter(
      (value) => value.id === input.threadId && value.deletedAt === null,
    ),
    projects = input.snapshot.projects.filter(
      (value) =>
        threads.length === 1 && value.id === threads[0]!.projectId && value.deletedAt === null,
    );
  if (threads.length !== 1 || projects.length !== 1 || input.descriptor.storageInstanceId === null)
    throw refused();
  const target: SettingsFollowupTarget = {
    environmentId: input.remote ? remoteEnvironmentId(input.descriptor.storageInstanceId) : "local",
    ownedRoot: input.ownedRoot,
    descriptor: input.descriptor,
    projectId: projects[0]!.id,
    projectTitle: projects[0]!.title,
    projectRoot: projects[0]!.workspaceRoot,
    repositoryIdentity: projects[0]!.repositoryIdentity ?? null,
    threadId: input.threadId,
    workspaceKind: input.workspaceKind,
    physical: input.physical,
  };
  verifySettingsFollowupSource({
    target,
    config: input.config,
    snapshot: input.snapshot,
    physical: input.physical,
  });
  return target;
}

export interface SettingsFollowupCallerInput {
  CI: string | undefined;
  root: string;
  binary: string;
  assets: string;
  theme: "light" | "dark";
  owner: QualificationOwner;
  browser: QualificationBrowser;
  primaryContext: DesktopUiTestContext;
  primaryEnvironment: NodeJS.ProcessEnv;
  importProject: (project: string) => Promise<void>;
  primaryServer: QualificationProcess;
  threadId: string;
  usage: Awaited<ReturnType<typeof prepareSettingsFollowupCallerUsage>>;
  evidence: string;
  captured: Set<string>;
  captures: object[];
  assertions: object[];
  admitOwner: () => Promise<void>;
  verifyPrimaryGit: () => void;
  git: (
    context: DesktopUiTestContext,
    cwd: string,
    args: readonly string[],
  ) => { status: number | null; stdout: string };
  step: (phase: string) => void;
  write: (name: string, value: unknown) => void;
  observeUnsafeCleanup: () => void;
}

/** Real A/B servers, public pairing/import/removal, typed APIs and original-byte gate. */
export async function runSettingsFollowupCaller(input: SettingsFollowupCallerInput) {
  if (input.CI !== "true" || !["light", "dark"].includes(input.theme)) throw refused();
  const { owner, browser } = input,
    alias = "Owned Settings Remote " + input.theme,
    nextAlias = "Renamed Settings Remote " + input.theme,
    remoteRoot = NodePath.join(input.root, "remote-settings"),
    endpoint = "http://127.0.0.1:4888" as const;
  const remoteEnvironment: NodeJS.ProcessEnv = {
    ...input.primaryEnvironment,
    BIBCODE_E2E_RUN_ROOT: remoteRoot,
    BIBCODE_E2E_ARTIFACT_DIR: NodePath.join(remoteRoot, "private"),
  };
  for (const key of Object.keys(remoteEnvironment))
    if (["CODEX_HOME", "CODEX_BIN"].includes(key.toUpperCase())) delete remoteEnvironment[key];
  NodeFS.mkdirSync(remoteRoot, { mode: 0o700 });
  const remoteContext = prepareDesktopUiTestContext(remoteEnvironment);
  remoteEnvironment.PATH =
    remoteContext.shimDirectory +
    NodePath.delimiter +
    input.primaryEnvironment.PATH!.split(NodePath.delimiter).at(-1)!;
  remoteEnvironment.CLAUDE_CONFIG_DIR = NodePath.join(remoteContext.fixtureUserHomePath, ".claude");
  const settingsPath = NodePath.join(remoteContext.stateRoot, "userdata", "settings.json"),
    configured = JSON.parse(NodeFS.readFileSync(settingsPath, "utf8")),
    missing = NodePath.join(remoteRoot, "missing-provider");
  for (const entry of Object.values(configured.providers) as Record<string, unknown>[]) {
    entry.enabled = false;
    entry.binaryPath = missing;
  }
  for (const entry of Object.values(configured.providerInstances) as Record<string, unknown>[]) {
    entry.enabled = false;
    entry.config = { binaryPath: missing };
    entry.environment = [];
  }
  const claude = NodePath.join(remoteContext.shimDirectory, "claude");
  configured.providers.claudeAgent = { enabled: true, binaryPath: claude };
  configured.providerInstances.claudeAgent = {
    driver: "claudeAgent",
    enabled: true,
    config: { binaryPath: claude },
  };
  configured.enableProviderUpdateChecks = false;
  NodeFS.writeFileSync(settingsPath, JSON.stringify(configured), { mode: 0o600 });
  if (NodeFS.existsSync(NodePath.join(remoteContext.fixtureUserHomePath, ".codex", "auth.json")))
    throw refused();
  let server: QualificationProcess | undefined,
    registered = false,
    registrationStarted = false,
    original: unknown,
    failed = false,
    cleanupFailed = false;
  let remoteId: string | undefined;
  const click = async (selector: string) => {
    const value = browser.$(selector);
    await value.waitForDisplayed();
    if ((await browser.$$(selector).length) !== 1) throw refused();
    await value.waitForEnabled();
    await value.click();
  };
  const settings = async () => {
    if (
      !(await browser
        .$("button=Remote Servers")
        .isDisplayed()
        .catch(() => false))
    )
      await click('[data-testid="environment-rail-manage"]');
    else await click("button=Remote Servers");
  };
  const remove = async () => {
    if (!registrationStarted) return;
    await settings();
    const labels = [alias, nextAlias],
      found: string[] = [];
    for (const label of labels)
      if (await browser.$(`[aria-label="More actions for ${label}"]`).isExisting())
        found.push(label);
    if (found.length === 0 && !registered) {
      registrationStarted = false;
      return;
    }
    if (found.length !== 1 || !remoteId) throw refused();
    await click(`[aria-label="More actions for ${found[0]}"]`);
    await click('//*[@role="menuitem" and normalize-space()="Remove server…"]');
    await click('//*[@role="alertdialog"]//button[normalize-space()="Remove server"]');
    await browser
      .$(`[data-testid="environment-rail-entry-${remoteId}"]`)
      .waitForExist({ reverse: true });
    for (const label of labels)
      if (await browser.$(`[aria-label="More actions for ${label}"]`).isExisting()) throw refused();
    for (let count = 0; count < 8; count++) {
      const controls = await browser.$$('button[data-slot="toast-close"]');
      const visible = [];
      for (const value of controls) if (await value.isDisplayed()) visible.push(value);
      if (visible.length === 0) break;
      for (const value of visible) await value.click();
      if (count === 7) throw refused();
    }
    registered = false;
    registrationStarted = false;
  };
  const descriptor = async (origin: "http://127.0.0.1:4885" | "http://127.0.0.1:4888") => {
    const response = await fetch(origin + "/.well-known/bibcode/environment", {
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) throw refused();
    const bytes = await bounded(response.text(), 2000);
    if (Buffer.byteLength(bytes) > 32768) throw refused();
    const value: ExecutionEnvironmentDescriptor = Schema.decodeUnknownSync(
      ExecutionEnvironmentDescriptor,
    )(JSON.parse(bytes));
    if (
      value.environmentId !== "local" ||
      value.bootId === null ||
      value.storageInstanceId === null ||
      value.platform?.os !== "linux"
    )
      throw refused();
    return value;
  };
  const physical = async (
    context: DesktopUiTestContext,
    path: string,
  ): Promise<SettingsFollowupPhysicalSource> => {
    const administration = NodePath.join(context.projectPath, ".git"),
      metadata = NodeFS.lstatSync(administration);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      NodeFS.realpathSync(administration) !== administration
    )
      throw refused();
    const read = (args: readonly string[]) => {
      const result = input.git(context, path, args);
      if (result.status !== 0) throw refused();
      return result.stdout.trim();
    };
    if (read(["rev-parse", "--show-toplevel"]) !== path) throw refused();
    return {
      path,
      branch: read(["symbolic-ref", "--quiet", "--short", "HEAD"]),
      commonDirectory: read(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      headSha: read(["rev-parse", "HEAD"]),
    };
  };
  const grant = async (
    context: DesktopUiTestContext,
    environment: NodeJS.ProcessEnv,
    origin: "http://127.0.0.1:4885" | "http://127.0.0.1:4888",
  ) => {
    const value = await owner.json(
      input.binary,
      ["pairing", "issue", "--base-dir", context.stateRoot, "--json"],
      environment,
    );
    if (
      !value ||
      typeof value !== "object" ||
      !("credential" in value) ||
      typeof value.credential !== "string"
    )
      throw refused();
    return fixtureAccessToken(origin, value.credential);
  };
  try {
    input.step("settings-followups-server-B");
    await new Promise<void>((resolve, reject) => {
      const probe = NodeNet.createServer();
      probe.once("error", () => reject(refused()));
      probe.listen(4888, "127.0.0.1", () =>
        probe.close((error) => (error ? reject(refused()) : resolve())),
      );
    });
    server = owner.spawn(
      input.binary,
      [
        "serve",
        "--mode",
        "web",
        "--host",
        "127.0.0.1",
        "--port",
        "4888",
        "--base-dir",
        remoteContext.stateRoot,
        "--static-dir",
        input.assets,
        "--no-browser",
        "--no-startup-pairing-offer",
      ],
      remoteEnvironment,
      "primary",
    );
    await owner.until(async () => {
      try {
        await descriptor(endpoint);
        return true;
      } catch {
        return false;
      }
    });
    const primaryDescriptor = await descriptor("http://127.0.0.1:4885"),
      remoteDescriptor = await descriptor(endpoint);
    remoteId = remoteEnvironmentId(remoteDescriptor.storageInstanceId!);
    if (primaryDescriptor.storageInstanceId === remoteDescriptor.storageInstanceId) throw refused();
    const verifyNative = async () => {
      await input.admitOwner();
      input.usage.verify();
      input.verifyPrimaryGit();
      for (const [origin, expected] of [
        ["http://127.0.0.1:4885", primaryDescriptor],
        [endpoint, remoteDescriptor],
      ] as const) {
        const current = await descriptor(origin);
        if (
          current.environmentId !== expected.environmentId ||
          current.bootId !== expected.bootId ||
          current.storageInstanceId !== expected.storageInstanceId ||
          current.label !== expected.label
        )
          throw refused();
      }
      if (
        !server ||
        server.child.exitCode !== null ||
        server.child.signalCode !== null ||
        input.primaryServer.child.exitCode !== null ||
        input.primaryServer.child.signalCode !== null ||
        NodeFS.existsSync(NodePath.join(remoteContext.fixtureUserHomePath, ".codex", "auth.json"))
      )
        throw refused();
    };
    const aToken = await grant(
        input.primaryContext,
        input.primaryEnvironment,
        "http://127.0.0.1:4885",
      ),
      bToken = await grant(remoteContext, remoteEnvironment, endpoint);
    await withSettingsFollowupSocket(
      {
        CI: input.CI,
        platform: "linux",
        admitOwner: verifyNative,
        observeUnsafeCleanup: input.observeUnsafeCleanup,
      },
      async (socket) => {
        await withSettingsFollowupApi(
          {
            CI: input.CI,
            origin: "http://127.0.0.1:4885",
            ownedRoot: input.root,
            accessToken: aToken,
            descriptor: primaryDescriptor,
            verifyTarget: verifyNative,
            observeUnsafeCleanup: input.observeUnsafeCleanup,
          },
          async (a) => {
            await withSettingsFollowupApi(
              {
                CI: input.CI,
                origin: endpoint,
                ownedRoot: input.root,
                accessToken: bToken,
                descriptor: remoteDescriptor,
                verifyTarget: verifyNative,
                observeUnsafeCleanup: input.observeUnsafeCleanup,
              },
              async (b) => {
                const initial = await a.snapshot(),
                  hostThreads = initial.threads.filter((value) => value.id === input.threadId),
                  hostProjects = initial.projects.filter(
                    (value) => hostThreads.length === 1 && value.id === hostThreads[0]!.projectId,
                  );
                if (
                  hostThreads.length !== 1 ||
                  hostProjects.length !== 1 ||
                  hostThreads[0]!.worktreePath === null
                )
                  throw refused();
                const aPath = hostThreads[0]!.worktreePath!,
                  aPhysical = await physical(input.primaryContext, aPath),
                  primary = bindSettingsFollowupTarget({
                    ownedRoot: input.root,
                    descriptor: primaryDescriptor,
                    config: await a.config(),
                    snapshot: initial,
                    threadId: input.threadId,
                    workspaceKind: "worktree",
                    physical: aPhysical,
                    remote: false,
                  });
                const modelBefore = await browser
                  .$('[data-chat-composer-form="true"] [data-chat-provider-model-picker="true"]')
                  .getText();
                await settings();
                await click('button[aria-label="Add Server"]');
                const dialog = '[data-slot="dialog-popup"][role="dialog"]';
                await browser.$(dialog).waitForDisplayed();
                await browser
                  .$(`${dialog} input[placeholder="e.g. Linux workstation"]`)
                  .setValue(alias);
                const offer = await owner.json(
                  input.binary,
                  [
                    "pairing",
                    "offer",
                    "--base-dir",
                    remoteContext.stateRoot,
                    "--endpoint",
                    "http://127.0.0.1:4889",
                    "--reach",
                    "this-computer",
                    "--name",
                    alias,
                    "--json",
                  ],
                  remoteEnvironment,
                );
                if (
                  !offer ||
                  typeof offer !== "object" ||
                  !("link" in offer) ||
                  typeof offer.link !== "string" ||
                  !offer.link.startsWith("bibcode://pair?")
                )
                  throw refused();
                await browser
                  .$(`${dialog} textarea[placeholder="bibcode://pair?code=…"]`)
                  .setValue(offer.link);
                const acknowledgement = browser.$(`${dialog} [role="checkbox"]`);
                if (await acknowledgement.isDisplayed().catch(() => false)) {
                  if (socket.observation().closed) throw refused();
                  await acknowledgement.click();
                }
                registrationStarted = true;
                await click(
                  '//*[@data-slot="dialog-popup" and @role="dialog"]//button[normalize-space()="Add Server"]',
                );
                await browser.$(dialog).waitForDisplayed({ reverse: true });
                registered = true;
                await click(`[data-testid="environment-rail-entry-${remoteId}"]`);
                await browser
                  .$(`[data-testid="environment-rail-entry-${remoteId}"] [data-status="connected"]`)
                  .waitForDisplayed();
                await click("button=Back");
                await input.importProject(remoteContext.projectPath);
                let importedSnapshot: OrchestrationReadModel | undefined,
                  importedThread: string | undefined;
                await owner.until(async () => {
                  await verifyNative();
                  const snapshot = await b.snapshot(),
                    projects = snapshot.projects.filter(
                      (value) =>
                        value.workspaceRoot === remoteContext.projectPath &&
                        value.deletedAt === null,
                    );
                  if (projects.length > 1) throw refused();
                  const threads = snapshot.threads.filter(
                    (value) =>
                      projects.length === 1 &&
                      value.projectId === projects[0]!.id &&
                      value.worktreePath === null &&
                      value.deletedAt === null &&
                      value.archivedAt === null &&
                      (value.kind ?? "workspace") === "workspace",
                  );
                  if (threads.length > 1) throw refused();
                  if (projects.length !== 1 || threads.length !== 1) return false;
                  importedSnapshot = snapshot;
                  importedThread = threads[0]!.id;
                  return true;
                });
                if (!importedSnapshot || !importedThread) throw refused();
                const remote = bindSettingsFollowupTarget({
                  ownedRoot: input.root,
                  descriptor: remoteDescriptor,
                  config: await b.config(),
                  snapshot: importedSnapshot,
                  threadId: importedThread,
                  workspaceKind: "primary",
                  physical: await physical(remoteContext, remoteContext.projectPath),
                  remote: true,
                });
                await click('[data-testid="environment-rail-local"]');
                await click(`[data-testid="thread-card-button-${input.threadId}"]`);
                const missingPath = NodePath.join(input.root, "owned-settings-missing-directory");
                if (NodeFS.existsSync(missingPath)) throw refused();
                const proof = await runSettingsFollowupProducer({
                  browser,
                  owner,
                  origin: "http://127.0.0.1:4885",
                  theme: input.theme,
                  primary: {
                    target: primary,
                    api: a,
                    readPhysical: () => physical(input.primaryContext, aPath),
                  },
                  remote: {
                    target: remote,
                    api: b,
                    readPhysical: () => physical(remoteContext, remoteContext.projectPath),
                  },
                  originalRemoteLabel: alias,
                  nextRemoteLabel: nextAlias,
                  ownedPrimaryServerPid: input.primaryServer.child.pid!,
                  ownedMissingPath: missingPath,
                  socket,
                  admitOwner: verifyNative,
                  capture: async (observation, verifyOwnedIdentity) => {
                    input.captures.push(
                      await captureSettingsFollowup({
                        ...observation,
                        browser,
                        owner,
                        evidence: input.evidence,
                        captured: input.captured,
                        verifyOwnedIdentity,
                      }),
                    );
                    input.write("assertions", {
                      captures: input.captures,
                      assertions: input.assertions,
                    });
                  },
                  removeOwnedRemoteRegistration: remove,
                  verifyOriginalRestored: async () => {
                    if (
                      (
                        await browser
                          .$('[data-chat-composer-form="true"] [data-testid="composer-editor"]')
                          .getText()
                      ).trim() !== "Owned visual review draft" ||
                      (await browser
                        .$(
                          '[data-chat-composer-form="true"] [data-chat-provider-model-picker="true"]',
                        )
                        .getText()) !== modelBefore
                    )
                      throw refused();
                  },
                  observeUnsafeCleanup: input.observeUnsafeCleanup,
                  step: input.step,
                });
                input.assertions.push(projectSettingsFollowupAssertion(input.theme, proof));
                input.write("assertions", {
                  captures: input.captures,
                  assertions: input.assertions,
                });
              },
            );
          },
        );
      },
    );
  } catch (error) {
    failed = true;
    original = error;
  }
  try {
    await remove();
  } catch {
    cleanupFailed = true;
  }
  if (server) {
    try {
      await owner.stop(server);
    } catch {
      cleanupFailed = true;
    }
  }
  if (cleanupFailed) unsafe(input.observeUnsafeCleanup);
  if (failed) throw original;
  if (cleanupFailed) throw refused();
}
