import { observeOwnedBrowserAlert } from "./support/owned-browser-alert.ts";
import {
  selectLifecycleCodexWorkspace,
  runProjectLifecycleScene,
  captureProjectLifecycleScene,
  createProjectLifecycleSourceJoins,
  createProjectLifecycleBrowserFlows,
  projectLifecycleAssertion,
  validateProjectLifecycleJoins,
  type ProjectLifecycleObservation,
} from "./support/release-visual-project-lifecycle.ts";
import {
  prepareProjectLifecycleFixture,
  createLifecycleProcessProof,
  readLifecycleProcessRecord,
} from "./support/release-visual-project-lifecycle-fixture.ts";
import { withProjectLifecycleApi } from "./support/release-visual-project-lifecycle-api.ts";
import {
  preparePullRequestsHostingFixture,
  type PullRequestsHostingFixture,
} from "./support/release-visual-pull-requests-installer.ts";
import {
  runOwnedPullRequestsSelection,
  validatePullRequestsCallerJoins,
  type PullRequestsHostingRestorationProof,
} from "./support/release-visual-pull-requests-caller.ts";
import {
  runWorkspaceSubstateBatch,
  captureWorkspaceSubstate,
  validateWorkspaceSubstateJoins,
  workspaceSubstates,
} from "./support/release-visual-workspace-substates.ts";
import { runCoreImageDiffOriginal } from "./support/release-visual-core-image.ts";
import {
  runProviderChatVisual,
  qualifiedProviderChatScenes,
  validateProviderChatJoins,
} from "./support/release-visual-provider-chat-producer.ts";
import { captureProviderChatScene } from "./support/release-visual-provider-chat.ts";
import { withOwnedCodexVisualOptionRefusal } from "./support/release-visual-provider-chat-fixture.ts";
import {
  withProviderChatWorkspaceLoss,
  readProviderChatWorkspaceLoss,
} from "./support/release-visual-provider-chat-loss.ts";
import {
  prepareProviderChatFiles,
  configureProviderChatMedia,
  verifyProviderChatMedia,
  type ProviderChatMediaScope,
} from "./support/release-visual-provider-chat-media.ts";
import { readProviderChatInputs } from "./support/release-visual-provider-chat-turns.ts";
import { withProviderChatPublicApi } from "./support/release-visual-provider-chat-api.ts";
// @effect-diagnostics nodeBuiltinImport:off - Disposable CI browser qualifier owns fixture paths.
// @effect-diagnostics globalFetch:off - Only the owned loopback CLI is probed.
// @effect-diagnostics globalTimers:off - Real bounded negative observation windows.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeNet from "node:net";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeUtil from "node:util";
import { OrchestrationReadModel } from "../../../packages/contracts/src/orchestration.ts";
import { ExecutionEnvironmentDescriptor } from "../../../packages/contracts/src/environment.ts";
import {
  EnvironmentOrchestrationHttpApi,
  EnvironmentMetadataHttpApi,
} from "../../../packages/contracts/src/environmentHttp.ts";
import {
  prepareGitProjectVisualFixture,
  type GitProjectVisualFixture,
} from "./support/release-visual-git-project-fixture.ts";
import {
  runGitProjectVisual,
  captureGitProjectVisualScene,
  createGitProjectOwnerAdapters,
  projectGitProjectVisualCapture,
  projectGitProjectVisualAssertion,
  gitProjectVisualScenes,
  gitProjectDirectoryFailureFacts,
  readGitProjectSelection,
  type GitProjectVisualSelection,
} from "./support/release-visual-git-project.ts";
import { gitProjectTabFailureFacts } from "./support/git-project-tab-observation.ts";
import {
  QualificationOwner,
  bounded,
  delay,
  openOwnedBrowser,
  prepareOwnedNetwork,
  verifyOwnedBrowserOnline,
  type QualificationBrowser,
  projectOwnedDriverReadiness,
  type OwnedDriverReadiness,
  projectOwnedBrowserSessionObservation,
  type OwnedBrowserSessionObservation,
} from "./support/qualification-owner.ts";
import { prepareDesktopUiTestContext } from "./support/test-project.ts";
import {
  cursorQuestionFixtureSelection,
  cursorQuestionFixturePrompt,
} from "./support/release-visual-cursor-question-fixture.ts";
import {
  runCursorQuestionVisual,
  captureCursorQuestionVisual,
  readCursorQuestionObservation,
  validateCursorQuestionWitness,
  bindPendingCursorQuestion,
  completedPendingCursorQuestion,
  type PendingCursorQuestionBinding,
} from "./support/release-visual-cursor-question.ts";
import {
  classifyQualificationFailure,
  projectQualificationProcess,
} from "./support/chat-upload-evidence.ts";
import { inspectScreenshot, validateCaptureWitness } from "./support/remote-ui-evidence.ts";
import { projectGitProjectTabInterception } from "./support/git-project-tab-interception.ts";
import {
  deliveryThemes,
  deliveryScenes,
  newConversationNotice,
  readDeliveryReceipts,
  verifyFreshRetry,
  withUnavailableWorkspace,
  type DeliveryTheme,
  type DeliveryScene,
  type DeliveryReceipts,
} from "./support/delivery-retry-evidence.ts";
import { resolveActualRetryPrompt } from "./support/delivery-retry-flow.ts";
import {
  readDeliveryImportObservation,
  projectDeliveryImportObservation,
  type DeliveryImportModelBinding,
} from "./support/delivery-import-observation.ts";
import {
  readOwnedDeliveryWorktree,
  readSelectedDeliveryWorktree,
} from "./support/delivery-retry-workspace.ts";

import {
  prepareVisualProject,
  prepareVisualWorktree,
  visualPartialStageMatches,
} from "./support/release-visual-fixture.ts";
import {
  captureVisualScene,
  runVisualCore,
  createCoreCaptureFailureObserver,
  readCoreCaptureFailureFacts,
  type CoreCaptureFailureRecord,
} from "./support/release-visual-core.ts";
import { visualScenes } from "./support/release-visual-evidence.ts";
import {
  runVisualSettings,
  captureSettingsVisualScene,
  settingsVisualScenes,
  projectSettingsVisualCapture,
  projectSettingsVisualAssertion,
  validateSettingsVisualJoins,
  projectSettingsVisualFailureWitness,
  resolveSettingsVisualFailureScene,
  type SettingsVisualObservationInput,
} from "./support/release-visual-settings.ts";
import { readSettingsVisualProviderConfiguration } from "./support/release-visual-settings-preflight.ts";
import {
  prepareSettingsFollowupCallerUsage,
  runSettingsFollowupCaller,
} from "./support/release-visual-settings-followups-caller.ts";
import {
  settingsFollowupScenes,
  validateSettingsFollowupJoins,
} from "./support/release-visual-settings-followups.ts";
import {
  readVisualViewport,
  readVisualWitness,
  projectVisualNameClearObservation,
  readVisualTextRowFailure,
  projectVisualTextRowFailure,
  type VisualObservationInput,
  type VisualTextRowObservationInput,
} from "./support/release-visual-observation.ts";
import { correctDesktopUiOuterSize } from "./support/window-size.ts";
import {
  prepareBrowserFollowupCaller,
  runBrowserFollowupCaller,
} from "./support/release-visual-browser-followups-caller.ts";
import { validateBrowserFollowupJoins } from "./support/release-visual-browser-followups.ts";
import { fixtureAccessToken } from "./support/remote-ui-rpc.ts";

const root = NodePath.resolve(import.meta.dirname, "../../..");
const contractsRequire = NodeModule.createRequire(
  NodePath.join(root, "packages/contracts/package.json"),
);
const Schema: { decodeUnknownSync: <A>(schema: { readonly Type: A }) => (value: unknown) => A } =
  contractsRequire("effect/Schema");
const DateTime: { nowUnsafe: () => unknown; formatIso: (value: unknown) => string } =
  contractsRequire("effect/DateTime");
const origin = "http://127.0.0.1:4885";
const surface = '[data-center-surface-host][data-visible="true"]';
const composer = `${surface} [data-testid="composer-editor"]`;
const form = `${surface} [data-chat-composer-form="true"]`;

export interface SettingsCaptureFailureRecord {
  readonly ownership: Readonly<SettingsVisualObservationInput>;
  readonly witness: Readonly<Record<string, boolean>>;
}

/** Bound capture ownership stays private; only the already-read closed facts can be retained. */
export function createSettingsCaptureFailureObserver(
  records: WeakMap<object, SettingsCaptureFailureRecord>,
  input: SettingsVisualObservationInput,
) {
  const ownership = NodeUtil.types.isProxy(input) ? null : Object.freeze({ ...input });
  return (error: unknown, value: unknown) => {
    try {
      if (error === null || typeof error !== "object") return;
      records.delete(error);
      if (
        ownership === null ||
        ownership.origin !== origin ||
        !["light", "dark"].includes(ownership.theme) ||
        !/^[A-Za-z0-9._:-]{1,128}$/.test(ownership.threadId) ||
        ownership.branch !== "codex/delivery-retry-" + ownership.theme
      )
        return;
      const witness = projectSettingsVisualFailureWitness(ownership.scene, value);
      if (witness !== null) records.set(error, Object.freeze({ ownership, witness }));
    } catch {
      // Optional failure facts cannot alter the capture outcome.
    }
  };
}

export function readSettingsCaptureFailureFacts(
  records: WeakMap<object, SettingsCaptureFailureRecord>,
  error: unknown,
  phase: string,
  theme: DeliveryTheme,
) {
  const scene = resolveSettingsVisualFailureScene(phase);
  if (scene === null || error === null || typeof error !== "object") return null;
  const record = records.get(error);
  if (record?.ownership.scene !== scene || record.ownership.theme !== theme) return null;
  return { scene: record.ownership.scene, theme, witness: record.witness };
}

/** Existing isolated synchronous Git lifetime: bounded and reaped before returning. */
export function runOwnedGitProjectCommand(
  input: { root: string; fixtureRoot: string; home: string; git: string },
  cwd: string,
  args: readonly string[],
  spawn: (
    command: string,
    args: string[],
    options: NodeChildProcess.SpawnSyncOptionsWithStringEncoding,
  ) => Pick<
    NodeChildProcess.SpawnSyncReturns<string>,
    "error" | "status" | "stdout"
  > = NodeChildProcess.spawnSync,
) {
  const refused = () => new Error("Owned Git/project command refused.");
  try {
    const inside = (parent: string, path: string) => {
      const relative = NodePath.relative(parent, path);
      return (
        relative !== "" &&
        relative !== ".." &&
        !relative.startsWith(".." + NodePath.sep) &&
        !NodePath.isAbsolute(relative)
      );
    };
    for (const path of [input.root, input.fixtureRoot, input.home, cwd]) {
      if (
        !NodePath.isAbsolute(path) ||
        NodeFS.realpathSync(path) !== path ||
        !NodeFS.lstatSync(path).isDirectory() ||
        NodeFS.lstatSync(path).isSymbolicLink()
      )
        throw refused();
    }
    const git = NodeFS.lstatSync(input.git);
    if (
      !inside(input.fixtureRoot, input.root) ||
      !inside(input.root, input.home) ||
      (cwd !== input.root && !inside(input.root, cwd)) ||
      input.git !== NodePath.join(input.fixtureRoot, "bin", "git") ||
      NodeFS.realpathSync(input.git) !== input.git ||
      !git.isFile() ||
      git.isSymbolicLink() ||
      git.nlink !== 1 ||
      git.uid !== NodeFS.lstatSync(input.fixtureRoot).uid ||
      git.size < 1 ||
      git.size > 4096 ||
      (git.mode & 0o111) === 0
    )
      throw refused();
    const result = spawn(
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
    if (
      result.error ||
      !Number.isInteger(result.status) ||
      result.status === null ||
      typeof result.stdout !== "string" ||
      Buffer.byteLength(result.stdout) > 65_536
    )
      throw refused();
    return { status: result.status, stdout: result.stdout };
  } catch {
    throw refused();
  }
}

/** HTTP bodies are decoded by the current public contracts and remain private. */
export async function readOwnedGitProjectSnapshot(accessToken: string) {
  const response = await fetch(origin + EnvironmentOrchestrationHttpApi.endpoints.snapshot.path, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(1000),
  });
  if (!response.ok) throw new Error("Owned Git/project snapshot refused.");
  return Schema.decodeUnknownSync(OrchestrationReadModel)(await response.json());
}
/** A separate one-time Node grant mints one session for this producer's snapshot loop. */
export function createOwnedGitProjectSnapshotReader(issueGrant: () => Promise<unknown>) {
  let accessToken: Promise<string> | undefined;
  return async () => {
    accessToken ??= (async () => {
      const grant = await issueGrant();
      const credential =
        typeof grant === "object" && grant !== null && "credential" in grant
          ? grant.credential
          : null;
      if (typeof credential !== "string" || credential.length < 8 || credential.length > 16384)
        throw new Error("Owned snapshot credential unavailable.");
      return fixtureAccessToken(origin, credential);
    })();
    return readOwnedGitProjectSnapshot(await accessToken);
  };
}
export async function readOwnedGitProjectDescriptor() {
  const response = await fetch(origin + EnvironmentMetadataHttpApi.endpoints.descriptor.path, {
    signal: AbortSignal.timeout(1000),
  });
  if (!response.ok) throw new Error("Owned Git/project descriptor refused.");
  return Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor)(await response.json());
}

export function verifyOwnedGitProjectSource(root: string, selection: GitProjectVisualSelection) {
  const relative = NodePath.relative(root, selection.cwd);
  if (
    !NodePath.isAbsolute(selection.cwd) ||
    relative === "" ||
    relative === ".." ||
    relative.startsWith(".." + NodePath.sep) ||
    NodePath.isAbsolute(relative) ||
    NodeFS.realpathSync(selection.cwd) !== selection.cwd ||
    NodeFS.lstatSync(selection.cwd).isSymbolicLink() ||
    !NodeFS.lstatSync(selection.cwd).isDirectory()
  )
    throw new Error("Owned Git/project source refused.");
  const head = NodePath.join(selection.cwd, ".git", "HEAD");
  if (selection.branch === null) {
    if (NodeFS.existsSync(NodePath.join(selection.cwd, ".git")))
      throw new Error("Owned Git/project source refused.");
    return;
  }
  const admin = NodePath.dirname(head),
    stat = NodeFS.lstatSync(head);
  if (
    NodeFS.realpathSync(admin) !== admin ||
    NodeFS.lstatSync(admin).isSymbolicLink() ||
    !NodeFS.lstatSync(admin).isDirectory() ||
    NodeFS.realpathSync(head) !== head ||
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    stat.uid !== NodeFS.lstatSync(root).uid ||
    stat.size > 256 ||
    selection.branch !== "main" ||
    NodeFS.readFileSync(head, "utf8") !== "ref: refs/heads/" + selection.branch + "\n"
  )
    throw new Error("Owned Git/project source refused.");
}

/** The fixed producer's real owner adapters; credentials and identities stay in this call. */
export async function runOwnedGitProjectSelection(input: {
  browser: QualificationBrowser;
  owner: QualificationOwner;
  theme: "light" | "dark";
  fixture: GitProjectVisualFixture;
  issueSnapshotGrant: () => Promise<unknown>;
  evidence: string;
  captured: Set<string>;
  captures: object[];
  assertions: object[];
  importProject: (
    cwd: string,
    bindSource?: () => Promise<GitProjectVisualSelection>,
  ) => Promise<void>;
  step: (phase: string) => void;
  write: (name: string, value: unknown) => void;
  readBranch: (cwd: string) => string | null;
}) {
  const initial = await readOwnedGitProjectDescriptor();
  if (initial.environmentId !== "local" || !initial.bootId || !initial.storageInstanceId)
    throw new Error("Owned Git/project server identity refused.");
  input.step("visual-git-project-viewport");
  const observed = await bounded(input.browser.execute(readVisualViewport), 2_000);
  const outer = await input.browser.getWindowSize();
  const corrected = correctDesktopUiOuterSize(
    outer,
    { width: 1280, height: 960 },
    observed,
    observed.devicePixelRatio,
  );
  await input.browser.setWindowSize(corrected.width, corrected.height);
  await input.owner.until(async () => {
    const viewport = await bounded(input.browser.execute(readVisualViewport), 2_000);
    return viewport.width === 1280 && viewport.height === 960;
  });
  const adapters = createGitProjectOwnerAdapters({
    browser: input.browser,
    owner: input.owner,
    origin,
    fixture: input.fixture,
    importProject: input.importProject,
    readSnapshot: createOwnedGitProjectSnapshotReader(input.issueSnapshotGrant),
    verifyServer: async () => {
      const current = await readOwnedGitProjectDescriptor();
      if (
        current.environmentId !== initial.environmentId ||
        current.bootId !== initial.bootId ||
        current.storageInstanceId !== initial.storageInstanceId ||
        current.serverVersion !== initial.serverVersion
      )
        throw new Error("Owned Git/project server identity refused.");
    },
    readBranch: input.readBranch,
    verifySource: (selection) => verifyOwnedGitProjectSource(input.fixture.root, selection),
  });
  const proof = await runGitProjectVisual({
    browser: input.browser,
    owner: input.owner,
    theme: input.theme,
    origin,
    fixture: input.fixture,
    step: input.step,
    ...adapters,
    capture: async (scene, selection, coverage) => {
      const receipt = projectGitProjectVisualCapture(
        await captureGitProjectVisualScene({
          scene,
          selection,
          coverage,
          theme: input.theme,
          origin,
          directory: NodePath.join(input.fixture.ordinary, "nested"),
          cloneUrl: input.fixture.cloneUrl,
          cloneParent: input.fixture.cloneParent,
          browser: input.browser,
          owner: input.owner,
          evidence: input.evidence,
          captured: input.captured,
          verifyOwnedIdentity: adapters.verifyOwnedIdentity,
        }),
      );
      input.captures.push(receipt);
      input.write("assertions", { captures: input.captures, assertions: input.assertions });
    },
  });
  input.assertions.push(projectGitProjectVisualAssertion(input.theme, proof));
  input.write("assertions", { captures: input.captures, assertions: input.assertions });
}

export function deliveryConfiguration(
  environment: NodeJS.ProcessEnv,
  readNamespace = () => NodeFS.readlinkSync("/proc/self/ns/net"),
) {
  const selection = environment.BIBCODE_DELIVERY_UI_SELECTION ?? "delivery-retry-ui";
  const values = {
    fixture: environment.BIBCODE_UPLOAD_FIXTURE,
    evidence: environment.BIBCODE_UPLOAD_EVIDENCE,
    binary: environment.BIBCODE_UPLOAD_SERVER,
    assets: environment.BIBCODE_DELIVERY_UI_WEB,
    chrome: environment.BIBCODE_UPLOAD_CHROME,
    driver: environment.BIBCODE_UPLOAD_DRIVER,
  };
  if (
    ![
      "delivery-retry-ui",
      "release-visual-core",
      "release-visual-settings",
      "release-visual-settings-followups",
      "release-visual-git-project",
      "release-visual-cursor-question",
      "release-visual-workspace-substates",
      "release-visual-provider-chat",
      "release-visual-project-lifecycle",
      "release-visual-pull-requests",
      "release-visual-browser-followups",
    ].includes(selection) ||
    environment.CI !== "true" ||
    !/^[0-9a-f]{40}$/.test(environment.BIBCODE_UPLOAD_SOURCE ?? "") ||
    Object.values(values).some((value) => !value || !NodePath.isAbsolute(value)) ||
    !environment.BIBCODE_UPLOAD_NETNS
  )
    throw new Error("Owned delivery qualification configuration refused.");
  try {
    if (readNamespace() !== environment.BIBCODE_UPLOAD_NETNS) throw new Error();
  } catch {
    throw new Error("Owned delivery qualification namespace refused.");
  }
  return { ...values, selection, source: environment.BIBCODE_UPLOAD_SOURCE! } as {
    selection:
      | "delivery-retry-ui"
      | "release-visual-core"
      | "release-visual-settings"
      | "release-visual-settings-followups"
      | "release-visual-git-project"
      | "release-visual-cursor-question"
      | "release-visual-workspace-substates"
      | "release-visual-provider-chat"
      | "release-visual-project-lifecycle"
      | "release-visual-pull-requests"
      | "release-visual-browser-followups";
    fixture: string;
    evidence: string;
    binary: string;
    assets: string;
    chrome: string;
    driver: string;
    source: string;
  };
}

/** Sampled DOM facts only; never a substitute for a completed WebDriver command. */
export function projectDeliveryWorktreeObservation(input: unknown) {
  const value =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const rawSafeLocation = value.safeLocation;
  const safeLocation = typeof rawSafeLocation === "boolean" ? rawSafeLocation : null;
  const source = safeLocation === true ? value : {};
  const boolean = (key: string): boolean | null => {
    const field = source[key];
    return typeof field === "boolean" ? field : null;
  };
  const count = source.createCount;
  return {
    safeLocation,
    createCount:
      typeof count === "string" && ["none", "one", "multiple"].includes(count) ? count : null,
    headerHovered: boolean("headerHovered"),
    headerVisible: boolean("headerVisible"),
    headerHitTarget: boolean("headerHitTarget"),
    createVisible: boolean("createVisible"),
    createEnabled: boolean("createEnabled"),
    createHitTarget: boolean("createHitTarget"),
    dialogVisible: boolean("dialogVisible"),
    modelPickerVisible: boolean("modelPickerVisible"),
  };
}

/** Failure attribution only: closed facts, never page values or driver payloads. */
export function projectDeliveryStartupObservation(input: unknown) {
  const value =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const safeLocation = typeof value.safeLocation === "boolean" ? value.safeLocation : null;
  const source = safeLocation === true ? value : {};
  const boolean = (key: string): boolean | null =>
    typeof source[key] === "boolean" ? source[key] : null;
  return {
    safeLocation,
    route:
      typeof source.route === "string" &&
      [
        "pair",
        "root",
        "workspace",
        "settings-general",
        "settings-remote-servers",
        "other",
      ].includes(source.route)
        ? source.route
        : null,
    readyState:
      typeof source.readyState === "string" &&
      ["loading", "interactive", "complete"].includes(source.readyState)
        ? source.readyState
        : null,
    online: boolean("online"),
    tokenInputPresent: boolean("tokenInputPresent"),
    tokenInputDisabled: boolean("tokenInputDisabled"),
    submitPresent: boolean("submitPresent"),
    submitDisabled: boolean("submitDisabled"),
    pairingErrorPresent: boolean("pairingErrorPresent"),
    pendingHeadingPresent: boolean("pendingHeadingPresent"),
    sidebarPresent: boolean("sidebarPresent"),
    primaryConnected: boolean("primaryConnected"),
    themeControlPresent: boolean("themeControlPresent"),
    darkTheme: boolean("darkTheme"),
  };
}

/** Exact create-ref failure facts only; false is diagnostic, never capture approval. */
export function projectVisualCreateRefObservation(input: unknown) {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
    const keys = [
      "themeMatched",
      "selectedMatched",
      "expectedTextMatched",
      "targetInView",
      "credentialAbsent",
      "bootShellAbsent",
      "singleDialog",
      "exactRef",
      "derivedName",
      "reuseBlocked",
      "agentControl",
      "advancedControl",
    ];
    const ownKeys = Reflect.ownKeys(input);
    if (
      ownKeys.length !== keys.length ||
      !ownKeys.every((key) => typeof key === "string" && keys.includes(key))
    )
      return null;
    const entries: Array<[string, boolean]> = [];
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return null;
      const value = descriptor.value;
      if (typeof value !== "boolean") return null;
      entries.push([key, value]);
    }
    return Object.fromEntries(entries);
  } catch {
    return null;
  }
}

export async function runDeliveryRetryQualification() {
  const config = deliveryConfiguration(process.env);
  const owner = new QualificationOwner(root, config.fixture);
  let browser: QualificationBrowser | undefined;
  let phase = "prepare-network";
  let theme: DeliveryTheme = "light";
  let success = false;
  let providerChatFixtureSafeToDelete = true;
  let projectLifecycleFixtureSafeToDelete = true;
  let settingsFollowupFixtureSafeToDelete = true;
  let pullRequestsFixtureSafeToDelete = true;
  let browserFollowupFixtureSafeToDelete = true;
  const browserFollowupResources: Array<Awaited<ReturnType<typeof prepareBrowserFollowupCaller>>> =
    [];
  const pullRequestsHostingOwners: Array<() => PullRequestsHostingRestorationProof> = [];
  const pullRequestsHostingRestorationProofs: PullRequestsHostingRestorationProof[] = [];
  const settingsFollowupUsageFixtures: Array<
    Awaited<ReturnType<typeof prepareSettingsFollowupCallerUsage>>
  > = [];
  const assertions: object[] = [];
  const captures: object[] = [];
  const capturedVisuals = new Set<string>();
  const coreCaptureFailures = new WeakMap<object, CoreCaptureFailureRecord>();
  const settingsCaptureFailures = new WeakMap<object, SettingsCaptureFailureRecord>();
  let createRefObservationInput: VisualObservationInput | null = null;
  let textRowObservationInput: VisualTextRowObservationInput | null = null;
  let importModelBinding: DeliveryImportModelBinding | null | undefined;
  let cursorOriginalFailure: { readonly error: unknown; readonly phase: string } | null = null;
  let cursorTurnObservation: Readonly<Record<string, boolean>> | null = null;
  const readCursorOriginalFailure = (): {
    readonly error: unknown;
    readonly phase: string;
  } | null => cursorOriginalFailure;
  const cursorOriginalFailurePhases = new Set([
    "visual-cursor-question-select",
    "visual-cursor-question-turn-before",
    "visual-cursor-question-send",
    "visual-cursor-question-turn-running",
    "visual-cursor-question-first-choice",
    "visual-cursor-question-later-tests",
    "visual-cursor-question-later-docs",
    "visual-cursor-question-capture",
    "visual-cursor-question-submit",
  ]);
  let createRefClearObservation: ReturnType<typeof projectVisualNameClearObservation> = null;
  let browserDriverReadiness: OwnedDriverReadiness | null = null;
  let browserReadinessStage: "driver-readiness" | "session-create" | "online-proof" | null = null;
  let browserSessionObservation: OwnedBrowserSessionObservation | null = null;
  const networkProofs: object[] = [];
  const write = (name: string, value: unknown) =>
    NodeFS.writeFileSync(
      NodePath.join(config.evidence, name + ".json"),
      JSON.stringify(value, null, 2) + "\n",
      { mode: 0o600 },
    );
  const step = (name: string) => {
    phase = name;
    write("phase", { phase, theme });
  };
  const check = (value: unknown) => {
    if (!value) throw new Error("Owned delivery qualification assertion failed.");
  };
  const b = () => {
    if (!browser) throw new Error("Owned browser unavailable.");
    return browser;
  };
  const click = async (selector: string) => {
    const button = b().$(selector);
    await button.waitForDisplayed();
    await button.waitForEnabled();
    await button.click();
  };
  const row = (id: string) => {
    check(/^[A-Za-z0-9._:-]{1,128}$/.test(id));
    return `${surface} [data-message-id="${id}"]`;
  };
  const readMessage = async (prompt: string) =>
    b().execute((input) => {
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-center-surface-host][data-visible="true"] [data-message-role="user"]',
        ),
      );
      const matches = rows.filter(
        (entry) =>
          entry.querySelector('[data-user-message-body="true"]')?.textContent?.trim() === input,
      );
      if (matches.length !== 1) return null;
      return {
        id: matches[0]!.dataset.messageId ?? "",
        text: matches[0]!.querySelector('[data-user-message-body="true"]')!.textContent!.trim(),
      };
    }, prompt);
  const draftIs = async (draft: string) => (await b().$(composer).getText()).trim() === draft;
  const unchanged = (before: DeliveryReceipts, after: DeliveryReceipts) =>
    check(after.complete && JSON.stringify(after.entries) === JSON.stringify(before.entries));

  async function readStartupFailureObservation() {
    try {
      return projectDeliveryStartupObservation(
        await bounded(
          browser!.execute((expectedOrigin) => {
            if (
              location.origin !== expectedOrigin ||
              location.search !== "" ||
              location.hash !== ""
            )
              return { safeLocation: false };
            const token = document.querySelector("#pairing-token");
            const pairingForm = token instanceof HTMLInputElement ? token.form : null;
            const submit = pairingForm?.querySelector('button[type="submit"]');
            return {
              safeLocation: true,
              route:
                location.pathname === "/pair"
                  ? "pair"
                  : location.pathname === "/"
                    ? "root"
                    : location.pathname === "/settings/general"
                      ? "settings-general"
                      : location.pathname === "/settings/remote-servers"
                        ? "settings-remote-servers"
                        : location.pathname.startsWith("/local/")
                          ? "workspace"
                          : "other",
              readyState: document.readyState,
              online: navigator.onLine,
              tokenInputPresent: token instanceof HTMLInputElement,
              tokenInputDisabled: token instanceof HTMLInputElement ? token.disabled : null,
              submitPresent: submit instanceof HTMLButtonElement,
              submitDisabled: submit instanceof HTMLButtonElement ? submit.disabled : null,
              pairingErrorPresent: pairingForm?.querySelector(".text-destructive") != null,
              pendingHeadingPresent:
                document.querySelector("h1")?.textContent?.trim() ===
                "Pairing with this environment",
              sidebarPresent:
                document.querySelector('[data-testid="sidebar-add-project-trigger"]') !== null,
              primaryConnected:
                document.querySelector(
                  '[data-testid="environment-rail-local"] [data-status="connected"]',
                ) !== null,
              themeControlPresent:
                document.querySelector('[aria-label="Theme preference"]') !== null,
              darkTheme: document.documentElement.classList.contains("dark"),
            };
          }, origin),
          2000,
        ),
      );
    } catch {
      // Unavailable diagnostics stay unknown; original failure and owned cleanup still run.
      return null;
    }
  }

  async function readCreateRefFailureObservation() {
    if (createRefObservationInput === null) return null;
    try {
      return projectVisualCreateRefObservation(
        await bounded(browser!.execute(readVisualWitness, createRefObservationInput), 2_000),
      );
    } catch {
      // The bounded diagnostic never replaces the original failure.
      return null;
    }
  }

  async function readTextRowFailureObservation() {
    if (textRowObservationInput === null) return null;
    try {
      return projectVisualTextRowFailure(
        await bounded(browser!.execute(readVisualTextRowFailure, textRowObservationInput), 2_000),
      );
    } catch {
      // This sample cannot replace the original wait failure or owned cleanup.
      return null;
    }
  }

  async function readImportFailureObservation() {
    try {
      return projectDeliveryImportObservation(
        await bounded(
          phase === "import-verify-claude-opus" && importModelBinding !== undefined
            ? browser!.execute(readDeliveryImportObservation, {
                origin,
                binding: importModelBinding,
              })
            : browser!.execute(readDeliveryImportObservation, origin),
          2_000,
        ),
      );
    } catch {
      // Failure-only observation cannot replace the import error or owned cleanup.
      return null;
    }
  }

  async function readWorktreeFailureObservation() {
    try {
      return projectDeliveryWorktreeObservation(
        await bounded(
          browser!.execute((expectedOrigin) => {
            if (
              location.origin !== expectedOrigin ||
              location.search !== "" ||
              location.hash !== ""
            )
              return { safeLocation: false };
            const controls = document.querySelectorAll('button[aria-label^="New worktree in "]');
            const create = controls.length === 1 ? controls[0]! : null;
            const header = create?.closest('div[class~="group/project-header"]') ?? null;
            const visible = (element: Element | null): boolean | null =>
              element && typeof element.checkVisibility === "function"
                ? element.checkVisibility({
                    contentVisibilityAuto: true,
                    opacityProperty: true,
                    visibilityProperty: true,
                  })
                : null;
            const hitTarget = (element: Element | null): boolean | null => {
              if (!element) return null;
              const rect = element.getBoundingClientRect();
              if (rect.width <= 0 || rect.height <= 0) return false;
              const hit = document.elementFromPoint(
                rect.left + rect.width / 2,
                rect.top + rect.height / 2,
              );
              return hit !== null && (hit === element || element.contains(hit));
            };
            const anyVisible = (selector: string): boolean | null => {
              const observations = new Set(
                Array.from(document.querySelectorAll(selector), visible),
              );
              return observations.has(true) ? true : observations.has(null) ? null : false;
            };
            return {
              safeLocation: true,
              createCount:
                controls.length === 0 ? "none" : controls.length === 1 ? "one" : "multiple",
              headerHovered: header?.matches(":hover") ?? null,
              headerVisible: visible(header),
              headerHitTarget: hitTarget(header),
              createVisible: visible(create),
              createEnabled: create instanceof HTMLButtonElement ? !create.disabled : null,
              createHitTarget: hitTarget(create),
              dialogVisible: anyVisible('[data-slot="dialog-popup"][role="dialog"]'),
              modelPickerVisible: anyVisible('[data-model-picker-content="true"]'),
            };
          }, origin),
          2000,
        ),
      );
    } catch {
      // The original failure survives unavailable/late diagnostics and owns cleanup.
      return null;
    }
  }

  async function setTheme() {
    step("theme-open-settings");
    await click('[data-testid="environment-rail-manage"]');
    step("theme-open-general");
    await click("button=General");
    step("theme-open-preference");
    await click('[aria-label="Theme preference"]');
    step("theme-select");
    await click(
      `//*[@role="option" and normalize-space()="${theme === "light" ? "Light" : "Dark"}"]`,
    );
    step("theme-wait-applied");
    await owner.until(async () =>
      b().execute(
        (dark) => document.documentElement.classList.contains("dark") === dark,
        theme === "dark",
      ),
    );
    step("theme-open-remote-servers");
    await click("button=Remote Servers");
    step("theme-back");
    await click("button=Back");
  }

  async function importProject(
    project: string,
    bindSource?: () => Promise<GitProjectVisualSelection>,
  ) {
    importModelBinding = bindSource ? null : undefined;
    step("import-open-project-menu");
    await click('[data-testid="sidebar-add-project-trigger"]');
    step("import-browse-folder");
    await click(
      "//button[@data-add-project-action='true'][.//span[normalize-space()='Browse folder']]",
    );
    step("import-path-choice");
    await owner.until(
      async () =>
        (await b().$("#add-project-host-path").isDisplayed()) ||
        (await b().$("button=Type a path instead").isDisplayed()),
    );
    if (!(await b().$("#add-project-host-path").isExisting())) {
      step("import-type-path");
      await click("button=Type a path instead");
    }
    step("import-path-ready");
    await b().$("#add-project-host-path").waitForDisplayed();
    step("import-fill-path");
    await b().$("#add-project-host-path").setValue(project);
    step("import-submit-project");
    await click("button=Open project");
    step("import-wait-composer");
    await b().$(composer).waitForDisplayed();
    if (bindSource) {
      step("import-bind-source");
      const selected = await bindSource();
      check(
        selected.environmentId === "local" &&
          [selected.projectId, selected.threadId].every((value) =>
            /^[A-Za-z0-9._:-]{1,128}$/.test(value),
          ),
      );
      importModelBinding = {
        environmentId: selected.environmentId,
        projectId: selected.projectId,
        threadId: selected.threadId,
      };
    }
    await selectClaudeModel("import", importModelBinding ?? undefined);
  }

  async function selectClaudeModel(
    scope: "import" | "worktree",
    binding?: DeliveryImportModelBinding,
  ) {
    const modelForm = binding
      ? '[data-center-surface-host="chat:host"][data-visible="true"] [data-chat-composer-form="true"]'
      : form;
    step(`${scope}-open-model-picker`);
    await click(`${modelForm} [data-chat-provider-model-picker="true"]`);
    const model =
      '[data-model-picker-content="true"] [data-model-picker-instance-id="claudeAgent"][data-model-picker-model-slug="opus"]';
    step(`${scope}-select-claude-opus`);
    await click(model);
    step(`${scope}-verify-claude-opus`);
    // The visible trigger text is model-only; its accessible label includes the
    // actual selected provider and full model name from the owned Claude fixture.
    await owner.until(
      async () =>
        (await b()
          .$(`${modelForm} [data-chat-provider-model-picker="true"]`)
          .getAttribute("aria-label")) === "Claude · Opus 5",
    );
  }

  async function openWorktreeDialog() {
    const create = 'button[aria-label^="New worktree in "]';
    step("worktree-open-count");
    check((await b().$$(create).length) === 1);
    const createButton = b().$(create);
    step("worktree-open-focus");
    // The existing focus-within action strip does not depend on hover capability.
    await owner.until(async () => {
      if (await createButton.isFocused()) return true;
      await b().keys("Tab");
      return createButton.isFocused();
    });
    step("worktree-open-displayed");
    await createButton.waitForDisplayed();
    step("worktree-open-enabled");
    await createButton.waitForEnabled();
    step("worktree-open-focus-confirm");
    check((await b().$$(create).length) === 1 && (await createButton.isFocused()));
    step("worktree-open-enter");
    await b().keys("Enter");
  }

  async function createOwnedWorkspace(
    context: ReturnType<typeof prepareDesktopUiTestContext>,
    runRoot: string,
    lifecycleSnapshot?: () => Promise<unknown>,
  ) {
    const branch = `codex/delivery-retry-${theme}`;
    const popup = '[data-slot="dialog-popup"][role="dialog"]';
    await openWorktreeDialog();
    step("worktree-name");
    const name = b().$(`${popup} input[placeholder="Worktree name"]`);
    await name.waitForDisplayed();
    // Keep the title distinct so the actual card retains its branch/path hint.
    await name.setValue(branch.replaceAll("-", " "));
    step("worktree-create");
    await click(
      '//*[@data-slot="dialog-popup"]//button[starts-with(normalize-space(.),"Create worktree")]',
    );
    await b().$(popup).waitForDisplayed({ reverse: true });
    step("worktree-select-identity");
    let selected: { threadId: string } | null = null;
    await owner.until(async () => {
      selected = await b().execute(readSelectedDeliveryWorktree, {
        origin,
        branch,
        boundThreadId: null,
      });
      return selected !== null;
    });
    check(selected !== null);
    const threadId = (selected as { threadId: string } | null)!.threadId;
    step("worktree-git-identity");
    const identity = readOwnedDeliveryWorktree({
      root: runRoot,
      project: context.projectPath,
      home: context.fixtureUserHomePath,
      git: NodePath.join(config.fixture, "bin", "git"),
      branch,
    });
    step("worktree-visible-path");
    await b()
      .$(`[data-testid="thread-row-${threadId}"] [id$="-branch"] [data-slot="tooltip-trigger"]`)
      .moveTo();
    await owner.until(async () =>
      b().execute(
        (expected) =>
          Array.from(document.querySelectorAll('[data-slot="tooltip-popup"]')).some(
            (element) =>
              element.getClientRects().length > 0 && element.textContent?.trim() === expected,
          ),
        `Worktree: ${NodePath.basename(identity.path)} (${branch})`,
      ),
    );
    if (config.selection === "release-visual-project-lifecycle") {
      if (!lifecycleSnapshot) throw new Error("Owned lifecycle snapshot unavailable.");
      await selectLifecycleCodexWorkspace({
        browser: b(),
        owner,
        readSnapshot: lifecycleSnapshot,
        projectPath: context.projectPath,
        threadId,
        cwd: identity.path,
        branch,
        step,
        verifyOwnedIdentity: async () => {
          check(
            (
              await b().execute(readSelectedDeliveryWorktree, {
                origin,
                branch,
                boundThreadId: threadId,
              })
            )?.threadId === threadId,
          );
        },
      });
    } else await selectClaudeModel("worktree");
    step("worktree-ready");
    check(
      (await b().execute(readSelectedDeliveryWorktree, { origin, branch, boundThreadId: threadId }))
        ?.threadId === threadId,
    );
    return { ...identity, threadId };
  }

  async function type(text: string) {
    check((await b().$(composer).getText()).trim() === "");
    await b().$(composer).click();
    await b().keys(text);
    check(await draftIs(text));
  }
  async function send(text: string) {
    await type(text);
    await click(`${form} button[aria-label="Send message"]`);
    await owner.until(async () => (await b().$(composer).getText()).trim() === "");
  }

  function retryDialogBrowser() {
    const browser = b();
    return {
      isAlertOpen: () => observeOwnedBrowserAlert(browser),
      getAlertText: () => browser.getAlertText(),
      dismissAlert: () => browser.dismissAlert(),
      acceptAlert: () => browser.acceptAlert(),
      waitUntil: (
        probe: () => Promise<boolean>,
        options: { timeout: number; interval: number; timeoutMsg: string },
      ) => browser.waitUntil(probe, options),
    };
  }

  async function capture(scene: DeliveryScene, id: string, prompt: string, draft: string) {
    check(!(await observeOwnedBrowserAlert(b())));
    const selector = row(id);
    const expected = scene === "new-conversation" ? newConversationNotice : "Delivery uncertain";
    await b().$(selector).scrollIntoView({ block: "center" });
    await b().performActions([
      {
        type: "pointer",
        id: "delivery-pointer",
        parameters: { pointerType: "mouse" },
        actions: [{ type: "pointerMove", duration: 0, x: 1, y: 1, origin: "viewport" }],
      },
    ]);
    let witness: unknown;
    await owner.until(async () => {
      witness = await bounded(
        b().execute(
          (input) => {
            const target = document.querySelector<HTMLElement>(input.selector);
            const rect = target?.getBoundingClientRect();
            const visible = (element: Element) => {
              const box = element.getBoundingClientRect();
              return (
                box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== "hidden"
              );
            };
            const cleanOverlays = Array.from(
              document.querySelectorAll(
                '[data-slot="dialog-popup"],[data-slot="alert-dialog-popup"]',
              ),
            ).every((element) => !visible(element));
            const unobstructed =
              !!target &&
              !!rect &&
              [
                [rect.x + rect.width / 2, rect.y + 2],
                [rect.x + rect.width / 2, rect.y + rect.height / 2],
                [rect.x + rect.width / 2, rect.bottom - 2],
              ].every(([x, y]) => {
                const hit = document.elementFromPoint(x!, y!);
                return !!hit && (hit === target || target.contains(hit));
              });
            const notice = target?.querySelector<HTMLElement>('[role="status"]');
            return {
              themeMatched:
                document.documentElement.classList.contains("dark") === (input.theme === "dark"),
              selectedMatched:
                document
                  .querySelector('[data-testid="environment-rail-local"]')
                  ?.getAttribute("aria-checked") === "true" &&
                target?.querySelector('[data-user-message-body="true"]')?.textContent?.trim() ===
                  input.prompt &&
                document.querySelector(input.composer)?.textContent?.trim() === input.draft,
              expectedTextMatched:
                target?.textContent?.includes(input.expected) === true &&
                (input.scene !== "new-conversation" ||
                  (notice?.classList.contains("text-muted-foreground") === true &&
                    parseFloat(getComputedStyle(notice).fontSize) >= 12)),
              targetInView:
                !!target &&
                !!rect &&
                rect.width > 0 &&
                rect.height > 0 &&
                rect.x >= 0 &&
                rect.y >= 0 &&
                rect.right <= innerWidth &&
                rect.bottom <= innerHeight &&
                unobstructed &&
                cleanOverlays,
              credentialAbsent:
                location.origin === input.origin &&
                location.search === "" &&
                location.hash === "" &&
                document.querySelector(
                  '#pairing-token,input[type="password"],input[autocomplete="one-time-code"],textarea[placeholder^="bibcode://pair"]',
                ) === null,
              bootShellAbsent:
                document.getElementById("boot-shell") === null &&
                document.querySelector("vite-error-overlay") === null,
            };
          },
          { selector, theme, scene, expected, prompt, draft, composer, origin },
        ),
        2000,
      );
      try {
        validateCaptureWitness(witness);
        return true;
      } catch {
        return false;
      }
    });
    const proof = validateCaptureWitness(witness);
    const bytes = Buffer.from(await bounded(b().takeScreenshot(), 5000), "base64");
    const image = inspectScreenshot(bytes);
    const file = `${scene}-${theme}.png`;
    NodeFS.writeFileSync(NodePath.join(config.evidence, file), bytes, { mode: 0o600, flag: "wx" });
    captures.push({ scene, theme, file, ...proof, ...image });
    write("assertions", { captures, assertions });
  }

  try {
    const network = await prepareOwnedNetwork(root);
    for (const nextTheme of deliveryThemes) {
      theme = nextTheme;
      step("prepare-fixture");
      const runRoot = NodePath.join(config.fixture, theme);
      if (
        config.selection === "release-visual-pull-requests" ||
        config.selection === "release-visual-browser-followups"
      ) {
        const outer = NodeFS.lstatSync(config.fixture);
        if (
          !outer.isDirectory() ||
          outer.isSymbolicLink() ||
          NodeFS.realpathSync(config.fixture) !== config.fixture ||
          (outer.mode & 0o777) !== 0o700 ||
          typeof process.getuid !== "function" ||
          outer.uid !== process.getuid() ||
          NodePath.dirname(runRoot) !== config.fixture ||
          !["light", "dark"].includes(NodePath.basename(runRoot))
        )
          throw new Error("Owned request themed root refused.");
        // Exclusive creation refuses every collision; never repair an existing root's permissions.
        NodeFS.mkdirSync(runRoot, { mode: 0o700 });
        const themed = NodeFS.lstatSync(runRoot);
        if (
          !themed.isDirectory() ||
          themed.isSymbolicLink() ||
          NodeFS.realpathSync(runRoot) !== runRoot ||
          (themed.mode & 0o777) !== 0o700 ||
          themed.uid !== outer.uid
        )
          throw new Error("Owned request themed root refused.");
      }
      const env = {
        ...process.env,
        BIBCODE_E2E_RUN_ROOT: runRoot,
        BIBCODE_E2E_ARTIFACT_DIR: NodePath.join(runRoot, "private"),
        BIBCODE_E2E_PLATFORM: "linux",
      };
      const context =
        config.selection === "release-visual-cursor-question"
          ? prepareDesktopUiTestContext(env, undefined, cursorQuestionFixtureSelection)
          : config.selection === "release-visual-provider-chat"
            ? prepareDesktopUiTestContext(env, undefined, undefined, "provider-chat-v1")
            : prepareDesktopUiTestContext(env);
      const control = NodePath.join(runRoot, "delivery-retry");
      if (config.selection === "delivery-retry-ui") NodeFS.mkdirSync(control, { mode: 0o700 });
      if (
        config.selection === "release-visual-core" ||
        config.selection === "release-visual-browser-followups" ||
        config.selection === "release-visual-workspace-substates" ||
        config.selection === "release-visual-provider-chat"
      ) {
        // This selector witnesses a genuine installation without an editor.
        // Cursor's editor launcher is distinct from the cursor-agent provider.
        NodeFS.unlinkSync(NodePath.join(context.shimDirectory, "cursor"));
        prepareVisualProject({
          root: runRoot,
          project: context.projectPath,
          home: context.fixtureUserHomePath,
          git: NodePath.join(config.fixture, "bin", "git"),
        });
      }
      const childEnv: NodeJS.ProcessEnv = {
        ...env,
        ...(config.selection === "delivery-retry-ui" ? { BIBCODE_E2E_CLAUDE_RETRY: "1" } : {}),
        PATH: context.shimDirectory + NodePath.delimiter + NodePath.join(config.fixture, "bin"),
        CLAUDE_CONFIG_DIR: NodePath.join(context.fixtureUserHomePath, ".claude"),
        RUST_LOG: "warn",
        BIBCODE_LOG: "warn",
      };
      delete childEnv.BIBCODE_HERMETIC_GUARD;
      let browserFollowup: Awaited<ReturnType<typeof prepareBrowserFollowupCaller>> | null = null;
      if (config.selection === "release-visual-browser-followups") {
        step("visual-browser-followups-resource-prepare");
        browserFollowup = await prepareBrowserFollowupCaller({
          CI: childEnv.CI,
          root: runRoot,
          primaryAssets: config.assets,
          hostedAssets: NodePath.join(NodePath.dirname(config.assets), "hosted-web"),
          source: config.source,
          repository: root,
          binary: config.binary,
          admitOwner: async () => {
            const admitted = deliveryConfiguration(process.env);
            check(
              admitted.selection === config.selection &&
                admitted.fixture === config.fixture &&
                admitted.source === config.source &&
                admitted.assets === config.assets &&
                admitted.binary === config.binary,
            );
          },
          verifyInputs: async () => {
            check(
              NodeFS.realpathSync(config.binary) === config.binary &&
                !NodeFS.lstatSync(config.binary).isSymbolicLink(),
            );
          },
          observeUnsafeCleanup: () => {
            browserFollowupFixtureSafeToDelete = false;
          },
        });
        browserFollowupResources.push(browserFollowup);
      }
      let settingsFollowupUsage: Awaited<
        ReturnType<typeof prepareSettingsFollowupCallerUsage>
      > | null = null;
      if (config.selection === "release-visual-settings-followups") {
        step("settings-followups-usage-inputs");
        settingsFollowupUsage = await prepareSettingsFollowupCallerUsage({
          CI: childEnv.CI,
          root: runRoot,
          home: context.fixtureUserHomePath,
          nodeExecutable: NodeFS.realpathSync(process.execPath),
          environment: childEnv,
          admitOwner: async () => {
            const admitted = deliveryConfiguration(process.env);
            check(
              admitted.selection === config.selection &&
                admitted.fixture === config.fixture &&
                admitted.source === config.source,
            );
          },
          childrenJoined: () => owner.childrenClosed(),
          inputsSafeToDelete: () => settingsFollowupFixtureSafeToDelete,
          observeUnsafeCleanup: () => {
            settingsFollowupFixtureSafeToDelete = false;
          },
        });
        settingsFollowupUsageFixtures.push(settingsFollowupUsage);
        Object.assign(childEnv, settingsFollowupUsage.environment);
        for (const key of Object.keys(childEnv))
          if (key.toUpperCase() === "CODEX_HOME") delete childEnv[key];
      }
      let gitProjectFixture: GitProjectVisualFixture | null = null;
      const gitProjectCommand = (cwd: string, args: readonly string[]) =>
        runOwnedGitProjectCommand(
          {
            root: runRoot,
            fixtureRoot: config.fixture,
            home: context.fixtureUserHomePath,
            git: NodePath.join(config.fixture, "bin", "git"),
          },
          cwd,
          args,
        );
      let pullRequestsFixture: PullRequestsHostingFixture | null = null;
      if (config.selection === "release-visual-pull-requests") {
        step("visual-pull-requests-fixture");
        pullRequestsFixture = await preparePullRequestsHostingFixture({
          root: runRoot,
          sourceSha: config.source,
          node: NodeFS.realpathSync(process.execPath),
          ci: childEnv.CI === "true",
          git: async (cwd, args) => gitProjectCommand(cwd, args),
        });
        childEnv.PATH = pullRequestsFixture.binDirectory + NodePath.delimiter + childEnv.PATH;
        childEnv.GIT_CONFIG_GLOBAL = pullRequestsFixture.gitConfig;
        delete childEnv.NODE_OPTIONS;
        delete childEnv.NODE_PATH;
      }
      if (config.selection === "release-visual-git-project") {
        step("visual-git-project-fixture");
        gitProjectFixture = await prepareGitProjectVisualFixture({
          root: runRoot,
          home: context.fixtureUserHomePath,
          theme,
          admitOwner: async () => {
            const admitted = deliveryConfiguration(process.env);
            check(
              admitted.selection === config.selection &&
                admitted.fixture === config.fixture &&
                admitted.source === config.source,
            );
          },
          git: async (cwd, args) => gitProjectCommand(cwd, args),
        });
        await gitProjectFixture.verifyCloneAlias();
        childEnv.GIT_CONFIG_GLOBAL = gitProjectFixture.cloneGitConfig;
      }
      const settingsPath = NodePath.join(context.stateRoot, "userdata", "settings.json");
      const configured = JSON.parse(NodeFS.readFileSync(settingsPath, "utf8"));
      const ownedCursorInstance =
        config.selection === "release-visual-cursor-question"
          ? structuredClone(configured.providerInstances.cursor)
          : null;
      const missing = NodePath.join(runRoot, "missing-provider");
      for (const entry of Object.values(configured.providers) as Record<string, unknown>[]) {
        entry.enabled = false;
        entry.binaryPath = missing;
      }
      for (const entry of Object.values(configured.providerInstances ?? {}) as Record<
        string,
        unknown
      >[]) {
        entry.enabled = false;
        entry.config = { binaryPath: missing };
        entry.environment = [];
      }
      const claude = NodePath.join(context.shimDirectory, "claude");
      configured.providers.claudeAgent = { enabled: true, binaryPath: claude };
      configured.providerInstances.claudeAgent = {
        driver: "claudeAgent",
        enabled: true,
        config: { binaryPath: claude },
      };
      if (
        config.selection === "release-visual-provider-chat" ||
        config.selection === "release-visual-project-lifecycle"
      ) {
        const codex = NodePath.join(context.shimDirectory, "codex");
        configured.providers.codex = { enabled: true, binaryPath: codex };
        configured.providerInstances.codex = {
          driver: "codex",
          enabled: true,
          config: { binaryPath: codex },
        };
      }
      if (config.selection === "release-visual-cursor-question") {
        check(
          ownedCursorInstance !== null &&
            ownedCursorInstance.driver === "cursor" &&
            ownedCursorInstance.environment.some(
              (entry: { name: string; value: string; sensitive: boolean }) =>
                entry.name === "BIBCODE_E2E_CURSOR_QUESTION_FIXTURE" &&
                entry.value === cursorQuestionFixtureSelection &&
                entry.sensitive === false,
            ),
        );
        const cursor = NodePath.join(context.shimDirectory, "cursor-agent");
        configured.providers.cursor = { enabled: true, binaryPath: cursor };
        configured.providerInstances.cursor = {
          ...ownedCursorInstance,
          enabled: true,
          config: { binaryPath: cursor },
        };
      }
      configured.enableProviderUpdateChecks = false;
      configured.worktreeBaseDirectory = NodePath.join(runRoot, "managed-worktrees");
      NodeFS.mkdirSync(configured.worktreeBaseDirectory, { mode: 0o700 });
      let projectLifecycleFixture: Awaited<
        ReturnType<typeof prepareProjectLifecycleFixture>
      > | null = null;
      if (config.selection === "release-visual-project-lifecycle") {
        step("visual-project-lifecycle-fixture");
        const managedParent = NodePath.join(
          configured.worktreeBaseDirectory,
          NodePath.basename(context.projectPath),
        );
        NodeFS.mkdirSync(managedParent, { mode: 0o700 });
        NodeFS.chmodSync(context.providerInputLogPath, 0o600);
        projectLifecycleFixture = await prepareProjectLifecycleFixture({
          root: runRoot,
          home: context.fixtureUserHomePath,
          primaryCheckout: context.projectPath,
          anchorCheckouts: [context.projectPath],
          plannedManagedCheckout: NodePath.join(managedParent, "codex-delivery-retry-" + theme),
          source: config.source,
          theme,
          hostPlatform: "linux",
          nodeExecutable: NodeFS.realpathSync(process.execPath),
          gitExecutable: NodePath.join(config.fixture, "bin", "git"),
          admitOwner: async () => {
            const admitted = deliveryConfiguration(process.env);
            check(
              admitted.selection === config.selection &&
                admitted.fixture === config.fixture &&
                admitted.source === config.source,
            );
          },
          git: async (cwd, args, environment) => {
            let stderr = "";
            const output = runOwnedGitProjectCommand(
              {
                root: runRoot,
                fixtureRoot: config.fixture,
                home: context.fixtureUserHomePath,
                git: NodePath.join(config.fixture, "bin", "git"),
              },
              cwd,
              args,
              (command, argv, options) => {
                const result = NodeChildProcess.spawnSync(command, argv, {
                  ...options,
                  env: { ...options.env, ...environment },
                });
                stderr = result.stderr;
                return result;
              },
            );
            return { ...output, stderr };
          },
        });
      }
      const serverEnvironment = projectLifecycleFixture
        ? { ...childEnv, ...projectLifecycleFixture.serverGitEnvironment }
        : childEnv;
      let settingsForWrite = configured;
      if (config.selection === "release-visual-settings") {
        step("visual-settings-provider-fixture");
        settingsForWrite = readSettingsVisualProviderConfiguration({
          fixtureRoot: config.fixture,
          runRoot,
          theme,
          shimDirectory: context.shimDirectory,
          home: context.fixtureUserHomePath,
          binDirectory: NodePath.join(config.fixture, "bin"),
          childEnv,
          binary: config.binary,
          source: config.source,
          evidence: config.evidence,
          configured,
        });
      }
      NodeFS.writeFileSync(settingsPath, JSON.stringify(settingsForWrite), { mode: 0o600 });
      const primaryPort = config.selection === "release-visual-browser-followups" ? 4897 : 4885;
      await new Promise<void>((resolve, reject) => {
        const probe = NodeNet.createServer();
        probe.once("error", () => reject(new Error("Owned delivery port unavailable.")));
        probe.listen(primaryPort, "127.0.0.1", () =>
          probe.close((error) => (error ? reject(error) : resolve())),
        );
      });
      const server = owner.spawn(
        config.binary,
        [
          "serve",
          "--mode",
          "web",
          "--host",
          "127.0.0.1",
          "--port",
          String(primaryPort),
          "--base-dir",
          context.stateRoot,
          "--static-dir",
          config.assets,
          "--no-browser",
          "--no-startup-pairing-offer",
        ],
        serverEnvironment,
        "primary",
      );
      await owner.until(async () => {
        try {
          return (
            await fetch(origin + "/.well-known/bibcode/environment", {
              signal: AbortSignal.timeout(1000),
            })
          ).ok;
        } catch {
          return false;
        }
      });
      step("browser");
      browserDriverReadiness = null;
      browserReadinessStage = null;
      browserSessionObservation = null;
      const opened = await openOwnedBrowser(
        owner,
        config.chrome,
        config.driver,
        origin,
        NodePath.join(runRoot, "profile"),
        (value) => {
          browserDriverReadiness = projectOwnedDriverReadiness(value);
        },
        (value) => {
          browserReadinessStage =
            value === "driver-readiness" || value === "session-create" ? value : null;
        },
        (value) => {
          browserSessionObservation = projectOwnedBrowserSessionObservation(value);
        },
      );
      browser = opened.browser;
      browserReadinessStage = "online-proof";
      networkProofs.push(await verifyOwnedBrowserOnline(browser, network));
      step("pair-issue-credential");
      const grant = await owner.json(
        config.binary,
        ["pairing", "issue", "--base-dir", context.stateRoot, "--json"],
        childEnv,
      );
      step("pair-check-credential");
      const credential =
        typeof grant === "object" && grant !== null && "credential" in grant
          ? grant.credential
          : null;
      if (typeof credential !== "string" || credential.length < 8)
        throw new Error("Owned pairing credential unavailable.");
      step("pair-navigate");
      await browser.url(origin + "/pair");
      step("pair-wait-token");
      await browser.$("#pairing-token").waitForDisplayed();
      step("pair-fill-token");
      await browser.$("#pairing-token").setValue(credential);
      step("pair-submit");
      await click("button=Continue");
      step("pair-wait-sidebar");
      await browser.$('[data-testid="sidebar-add-project-trigger"]').waitForDisplayed();
      step("pair-wait-connected");
      await browser
        .$('[data-testid="environment-rail-local"] [data-status="connected"]')
        .waitForDisplayed();
      await setTheme();
      if (config.selection === "release-visual-git-project") {
        check(gitProjectFixture !== null);
        if (gitProjectFixture === null) throw new Error("Owned Git/project fixture unavailable.");
        const fixture = gitProjectFixture;
        await runOwnedGitProjectSelection({
          browser,
          owner,
          theme,
          fixture: gitProjectFixture,
          issueSnapshotGrant: () =>
            owner.json(
              config.binary,
              ["pairing", "issue", "--base-dir", context.stateRoot, "--json"],
              childEnv,
            ),
          evidence: config.evidence,
          captured: capturedVisuals,
          captures,
          assertions,
          importProject,
          step,
          write,
          readBranch: (cwd) => {
            if (cwd === fixture.ordinary) return null;
            const result = gitProjectCommand(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
            check(result.status === 0 && result.stdout.trim() === "main");
            return result.stdout.trim();
          },
        });
        step("theme-cleanup");
        await owner.cleanup("browser", () =>
          bounded(
            browser!.deleteSession().then(() => undefined),
            15_000,
          ),
        );
        browser = undefined;
        await owner.stop(opened.driver);
        await owner.stop(server);
        check(owner.failures.length === 0);
        continue;
      }
      if (config.selection === "release-visual-pull-requests") {
        if (!pullRequestsFixture) throw new Error("Owned request fixture unavailable.");
        const issueGrant = () =>
          owner.json(
            config.binary,
            ["pairing", "issue", "--base-dir", context.stateRoot, "--json"],
            childEnv,
          );
        step("visual-pull-requests-viewport");
        const viewport = await bounded(browser.execute(readVisualViewport), 2000),
          outer = await browser.getWindowSize(),
          corrected = correctDesktopUiOuterSize(
            outer,
            { width: 1280, height: 960 },
            viewport,
            viewport.devicePixelRatio,
          );
        await browser.setWindowSize(corrected.width, corrected.height);
        await owner.until(async () => {
          const current = await bounded(browser!.execute(readVisualViewport), 2000);
          return current.width === 1280 && current.height === 960;
        });
        await runOwnedPullRequestsSelection({
          CI: childEnv.CI,
          sourceSha: config.source,
          theme,
          origin,
          fixture: pullRequestsFixture,
          registerHostingRestorationOwner: (verify) => {
            pullRequestsHostingOwners.push(verify);
          },
          originalCwd: context.projectPath,
          git: async (cwd, args) => gitProjectCommand(cwd, args),
          browser,
          owner,
          readSnapshot: createOwnedGitProjectSnapshotReader(issueGrant),
          readDescriptor: readOwnedGitProjectDescriptor,
          issueContextAccessToken: async () => {
            const grant = await issueGrant(),
              credential =
                typeof grant === "object" && grant !== null && "credential" in grant
                  ? grant.credential
                  : null;
            if (
              typeof credential !== "string" ||
              credential.length < 8 ||
              credential.length > 16384
            )
              throw new Error("Owned request context credential refused.");
            return fixtureAccessToken(origin, credential);
          },
          importProject,
          evidence: config.evidence,
          captured: capturedVisuals,
          captures,
          assertions,
          step,
          write,
          unsafe: () => {
            pullRequestsFixtureSafeToDelete = false;
          },
        });
        step("theme-cleanup");
        await owner.cleanup("browser", () =>
          bounded(
            browser!.deleteSession().then(() => undefined),
            15000,
          ),
        );
        browser = undefined;
        await owner.stop(opened.driver);
        await owner.stop(server);
        if (owner.failures.length > 0 || !owner.childrenClosed()) {
          pullRequestsFixtureSafeToDelete = false;
          throw new Error("Owned request cleanup refused.");
        }
        continue;
      }
      step("import");
      await importProject(context.projectPath);
      const lifecycleSnapshot =
        config.selection === "release-visual-project-lifecycle"
          ? createOwnedGitProjectSnapshotReader(() =>
              owner.json(
                config.binary,
                ["pairing", "issue", "--base-dir", context.stateRoot, "--json"],
                childEnv,
              ),
            )
          : undefined;
      const workspace = await createOwnedWorkspace(context, runRoot, lifecycleSnapshot);
      const visualInput = {
        root: runRoot,
        project: context.projectPath,
        home: context.fixtureUserHomePath,
        git: NodePath.join(config.fixture, "bin", "git"),
        branch: workspace.branch,
      };
      if (
        config.selection === "release-visual-core" ||
        config.selection === "release-visual-browser-followups" ||
        config.selection === "release-visual-workspace-substates" ||
        config.selection === "release-visual-provider-chat"
      ) {
        step("visual-fixture-managed");
        check(prepareVisualWorktree(visualInput).path === workspace.path);
        if (config.selection !== "release-visual-browser-followups") {
          step("visual-viewport");
          const observed = await bounded(browser.execute(readVisualViewport), 2_000);
          const outer = await browser.getWindowSize();
          const corrected = correctDesktopUiOuterSize(
            outer,
            { width: 1280, height: 960 },
            observed,
            observed.devicePixelRatio,
          );
          await browser.setWindowSize(corrected.width, corrected.height);
          await owner.until(async () => {
            const viewport = await bounded(browser!.execute(readVisualViewport), 2_000);
            return viewport.width === 1280 && viewport.height === 960;
          });
        }
      } else if (
        config.selection === "release-visual-settings" ||
        config.selection === "release-visual-settings-followups" ||
        config.selection === "release-visual-cursor-question" ||
        config.selection === "release-visual-project-lifecycle"
      ) {
        step(
          config.selection === "release-visual-cursor-question"
            ? "visual-cursor-question-viewport"
            : config.selection === "release-visual-project-lifecycle"
              ? "visual-project-lifecycle-viewport"
              : "visual-settings-viewport",
        );
        const observed = await bounded(browser.execute(readVisualViewport), 2_000);
        const outer = await browser.getWindowSize();
        const corrected = correctDesktopUiOuterSize(
          outer,
          { width: 1280, height: 960 },
          observed,
          observed.devicePixelRatio,
        );
        await browser.setWindowSize(corrected.width, corrected.height);
        await owner.until(async () => {
          const viewport = await bounded(browser!.execute(readVisualViewport), 2_000);
          return viewport.width === 1280 && viewport.height === 960;
        });
      }
      const providerSnapshot =
        config.selection === "release-visual-provider-chat"
          ? createOwnedGitProjectSnapshotReader(() =>
              owner.json(
                config.binary,
                ["pairing", "issue", "--base-dir", context.stateRoot, "--json"],
                childEnv,
              ),
            )
          : null;
      let providerMedia: ProviderChatMediaScope | null = null;
      let providerDescriptor: Awaited<ReturnType<typeof readOwnedGitProjectDescriptor>> | null =
        null;
      if (providerSnapshot !== null) {
        step("visual-provider-chat-media-seed");
        providerDescriptor = await readOwnedGitProjectDescriptor();
        check(
          providerDescriptor.environmentId === "local" &&
            !!providerDescriptor.bootId &&
            !!providerDescriptor.storageInstanceId,
        );
        const initial = await providerSnapshot();
        const hosts = initial.threads.filter(
          (value) =>
            value.id === workspace.threadId &&
            value.deletedAt === null &&
            value.kind === "workspace" &&
            value.worktreePath === workspace.path &&
            value.branch === workspace.branch,
        );
        check(hosts.length === 1);
        providerMedia = prepareProviderChatFiles(visualInput, hosts[0]!);
      }
      const baseline = `delivery baseline ${theme}`;
      const prompt = `delivery held message ${theme}`;
      const draft = `delivery preserved draft ${theme}`;
      if (
        config.selection !== "release-visual-cursor-question" &&
        config.selection !== "release-visual-project-lifecycle"
      ) {
        step("baseline");
        await send(baseline);
        await owner.until(
          async () =>
            (await browser!.$(surface).getText()).includes(
              "BiBCode deterministic streamed fixture response.",
            ) &&
            !(await browser!.$(`${form} button[aria-label="Stop generation"]`).isDisplayed()) &&
            !(await browser!.$(`${surface} [data-timeline-row-kind="working"]`).isDisplayed()),
        );
        await browser.$(`${form} button[aria-label="Send message"]`).waitForDisplayed();
        check(!(await browser.$(surface).getText()).includes(newConversationNotice));
      }
      if (config.selection === "release-visual-project-lifecycle") {
        step("visual-project-lifecycle-bind");
        if (!projectLifecycleFixture || !lifecycleSnapshot || server.child.pid === undefined)
          throw new Error("Owned lifecycle fixture unavailable.");
        const fixture = projectLifecycleFixture;
        step("visual-project-lifecycle-bind-snapshot");
        const initial = await lifecycleSnapshot();
        step("visual-project-lifecycle-bind-descriptor");
        const descriptor = await readOwnedGitProjectDescriptor();
        check(
          descriptor.environmentId === "local" &&
            !!descriptor.bootId &&
            !!descriptor.storageInstanceId &&
            descriptor.capabilities.vcsCloneReattach === true,
        );
        step("visual-project-lifecycle-bind-path");
        check(
          workspace.path ===
            NodePath.join(
              configured.worktreeBaseDirectory,
              NodePath.basename(context.projectPath),
              "codex-delivery-retry-" + theme,
            ),
        );
        step("visual-project-lifecycle-bind-checkout");
        const retained = NodeFS.lstatSync(workspace.path),
          gitPointer = NodeFS.readFileSync(NodePath.join(workspace.path, ".git"));
        const verifyCheckoutRetained = async () => {
          const current = NodeFS.lstatSync(workspace.path);
          check(
            current.isDirectory() &&
              !current.isSymbolicLink() &&
              current.dev === retained.dev &&
              current.ino === retained.ino &&
              NodeFS.readFileSync(NodePath.join(workspace.path, ".git")).equals(gitPointer),
          );
          check(
            JSON.stringify(readOwnedDeliveryWorktree(visualInput)) ===
              JSON.stringify({
                path: workspace.path,
                branch: workspace.branch,
                commonDirectory: workspace.commonDirectory,
              }),
          );
        };
        step("visual-project-lifecycle-bind-process");
        const processProof = createLifecycleProcessProof({
          CI: childEnv.CI,
          uid: NodeFS.lstatSync(config.fixture).uid,
          serverPid: server.child.pid,
          serverExecutable: config.binary,
          serverArgs: server.child.spawnargs,
          serverCwd: root,
          namespace: {
            net: childEnv.BIBCODE_UPLOAD_NETNS!,
            pid: childEnv.BIBCODE_UPLOAD_PIDNS!,
            user: childEnv.BIBCODE_UPLOAD_USERNS!,
          },
          providerNode: NodeFS.realpathSync(process.execPath),
          providerScript: NodePath.join(context.shimDirectory, "codex-fixture.mjs"),
          providerCwd: workspace.path,
          read: readLifecycleProcessRecord,
          pids: () =>
            NodeFS.readdirSync("/proc")
              .filter((name) => /^[0-9]+$/.test(name) && Number(name) > 1)
              .map(Number),
        });
        const verifyTarget = async () => {
          processProof.verifyServerOwned();
          const current = await readOwnedGitProjectDescriptor();
          check(
            current.environmentId === descriptor.environmentId &&
              current.bootId === descriptor.bootId &&
              current.storageInstanceId === descriptor.storageInstanceId &&
              current.capabilities.vcsCloneReattach === true,
          );
        };
        step("visual-project-lifecycle-bind-decode");
        const models: OrchestrationReadModel =
          Schema.decodeUnknownSync(OrchestrationReadModel)(initial);
        step("visual-project-lifecycle-bind-workspace");
        const hosts = models.threads.filter(
          (thread) =>
            thread.id === workspace.threadId &&
            thread.kind === "workspace" &&
            thread.worktreePath === workspace.path &&
            thread.branch === workspace.branch &&
            thread.deletedAt === null &&
            thread.archivedAt === null,
        );
        check(hosts.length === 1);
        const host = hosts[0]!;
        step("visual-project-lifecycle-bind-project");
        const projects = models.projects.filter(
          (project) =>
            project.id === host.projectId &&
            project.deletedAt === null &&
            project.workspaceRoot === context.projectPath,
        );
        check(projects.length === 1);
        const primaryProject = projects[0]!;
        const bind = async (
          scene: ProjectLifecycleObservation["scene"],
          cwd: string,
        ): Promise<ProjectLifecycleObservation> => {
          const model = await lifecycleSnapshot(),
            projects = model.projects.filter(
              (project) => project.workspaceRoot === cwd && project.deletedAt === null,
            );
          check(projects.length === 1);
          const project = projects[0]!,
            threads = model.threads.filter(
              (thread) =>
                thread.projectId === project.id &&
                thread.kind === "default" &&
                thread.worktreePath === null &&
                thread.branch === null &&
                thread.deletedAt === null &&
                thread.archivedAt === null,
            );
          check(threads.length === 1);
          return Object.freeze({
            scene,
            theme,
            origin,
            projectId: project.id,
            threadId: threads[0]!.id,
            cwd,
            branch: "main",
            title: project.title,
            cloneUrl: fixture.cloneUrl,
            cloneParent: fixture.cloneParent,
          });
        };
        const busy: ProjectLifecycleObservation = Object.freeze({
          scene: "worktree-remove-busy",
          theme,
          origin,
          projectId: host.projectId,
          threadId: host.id,
          cwd: workspace.path,
          branch: workspace.branch,
          title: host.title,
          cloneUrl: fixture.cloneUrl,
          cloneParent: fixture.cloneParent,
        });
        step("visual-project-lifecycle-bind-grant");
        const grant = await owner.json(
          config.binary,
          ["pairing", "issue", "--base-dir", context.stateRoot, "--json"],
          childEnv,
        );
        const credential =
          typeof grant === "object" && grant !== null && "credential" in grant
            ? grant.credential
            : null;
        if (typeof credential !== "string" || credential.length < 8 || credential.length > 16384)
          throw new Error("Owned lifecycle credential refused.");
        step("visual-project-lifecycle-bind-token");
        const accessToken = await fixtureAccessToken(origin, credential),
          rows: object[] = [];
        const unsafe = () => {
          projectLifecycleFixtureSafeToDelete = false;
        };
        step("visual-project-lifecycle-bind-api");
        await withProjectLifecycleApi(
          {
            CI: childEnv.CI,
            ownedRoot: runRoot,
            accessToken,
            projectId: host.projectId,
            threadId: host.id,
            managedCheckout: workspace.path,
            trustCheckout: fixture.trustCheckout,
            cloneUrl: fixture.cloneUrl,
            cloneParent: fixture.cloneParent,
            verifyTarget,
            observeUnsafeCleanup: unsafe,
          },
          async (api) => {
            const execute = async (binding: ProjectLifecycleObservation) => {
              const verifyOwnedIdentity = async () => {
                await verifyTarget();
                if (binding.scene === "worktree-remove-busy") {
                  await verifyCheckoutRetained();
                  check(
                    (
                      await b().execute(readSelectedDeliveryWorktree, {
                        origin,
                        branch: workspace.branch,
                        boundThreadId: workspace.threadId,
                      })
                    )?.threadId === workspace.threadId,
                  );
                } else {
                  check(
                    await b().execute(readGitProjectSelection, {
                      origin,
                      selection: {
                        environmentId: "local",
                        projectId: binding.projectId,
                        threadId: binding.threadId,
                        cwd: binding.cwd,
                        branch: binding.branch,
                        title: binding.title,
                      },
                    }),
                  );
                }
              };
              const source = createProjectLifecycleSourceJoins({
                owner,
                binding,
                fixture,
                serverPid: server.child.pid!,
                rpc: api,
                newCommandId: () => NodeCrypto.randomUUID(),
                nowIsoDate: () => DateTime.formatIso(DateTime.nowUnsafe()),
                readNativeInputs: () => readProviderChatInputs(context.providerInputLogPath),
                verifyProviderLive: async (turn) => processProof.verifyProviderLive(turn),
                verifyProviderReaped: async () =>
                  owner.until(async () => {
                    try {
                      processProof.verifyProviderReaped();
                      return true;
                    } catch {
                      return false;
                    }
                  }),
                verifyCheckoutRetained,
                verifyFixtureInputsRetained: () => fixture.verifyInputsRetained(),
                verifyServerOwned: verifyTarget,
              });
              const flows = createProjectLifecycleBrowserFlows({
                browser: b(),
                owner,
                binding,
                fixture,
                source,
                verifyOwnedIdentity,
                selectTrustProject: async () => {
                  check(binding.scene === "git-trust-refusal");
                  await click('[data-testid="primary-card-button-' + binding.projectId + '"]');
                },
              });
              const verifySource =
                binding.scene === "worktree-remove-busy"
                  ? () => source.verifyRunningAndRefused()
                  : binding.scene === "project-clone-progress"
                    ? () => source.verifySingleHeldTransfer()
                    : () => source.refreshAndVerifyUntrusted();
              rows.push(
                await runProjectLifecycleScene({
                  scene: binding.scene,
                  theme,
                  verifyOwnedIdentity,
                  step,
                  ...flows,
                  capture: async () => {
                    captures.push(
                      await captureProjectLifecycleScene({
                        ...binding,
                        browser: b(),
                        owner,
                        evidence: config.evidence,
                        captured: capturedVisuals,
                        verifyOwnedIdentity,
                        verifySource,
                      }),
                    );
                    write("assertions", { captures, assertions });
                  },
                  observeCleanupFailure: (role, error) => {
                    unsafe();
                    owner.failures.push({ role, failure: classifyQualificationFailure(error) });
                  },
                }),
              );
            };
            await execute(busy);
            step("visual-project-lifecycle-trust-import");
            await importProject(fixture.trustCheckout);
            const trust = await bind("git-trust-refusal", fixture.trustCheckout);
            await execute(trust);
            step("visual-project-lifecycle-primary-restore");
            await click('[data-testid="primary-card-button-' + primaryProject.id + '"]');
            const clone = await bind("project-clone-progress", context.projectPath);
            await execute(clone); // Clone is last: Cancel retains its visible form values until browser teardown.
          },
        );
        await fixture.verifyInputsRetained();
        assertions.push(projectLifecycleAssertion(theme, rows));
        write("assertions", { captures, assertions });
      } else if (config.selection === "release-visual-workspace-substates") {
        step("visual-workspace-substates-open");
        step("visual-workspace-substates-draft");
        await type("Owned visual review draft");
        step("visual-workspace-substates-descriptor-read");
        const descriptor = await readOwnedGitProjectDescriptor();
        step("visual-workspace-substates-descriptor-identity");
        check(
          descriptor.environmentId === "local" &&
            !!descriptor.bootId &&
            !!descriptor.storageInstanceId,
        );
        const readSnapshot = createOwnedGitProjectSnapshotReader(() =>
          owner.json(
            config.binary,
            ["pairing", "issue", "--base-dir", context.stateRoot, "--json"],
            childEnv,
          ),
        );
        step("visual-workspace-substates-snapshot-read");
        const initial = await readSnapshot();
        const threads = initial.threads.filter(
          (thread) => thread.id === workspace.threadId && thread.deletedAt === null,
        );
        step("visual-workspace-substates-thread-count");
        check(threads.length === 1);
        const boundThread = threads[0]!;
        step("visual-workspace-substates-thread-binding");
        check(
          boundThread.kind === "workspace" &&
            boundThread.branch === workspace.branch &&
            boundThread.worktreePath === workspace.path,
        );
        const projects = initial.projects.filter(
          (project) => project.id === boundThread.projectId && project.deletedAt === null,
        );
        step("visual-workspace-substates-project-binding");
        check(projects.length === 1 && projects[0]!.workspaceRoot === context.projectPath);
        const binding = Object.freeze({
          origin,
          theme,
          threadId: workspace.threadId,
          projectId: boundThread.projectId,
          branch: workspace.branch,
        });
        const verifyManaged = async () => {
          const currentDescriptor = await readOwnedGitProjectDescriptor();
          check(
            currentDescriptor.environmentId === descriptor.environmentId &&
              currentDescriptor.bootId === descriptor.bootId &&
              currentDescriptor.storageInstanceId === descriptor.storageInstanceId,
          );
          check(
            JSON.stringify(readOwnedDeliveryWorktree(visualInput)) ===
              JSON.stringify({
                path: workspace.path,
                branch: workspace.branch,
                commonDirectory: workspace.commonDirectory,
              }),
          );
          const snapshot = await readSnapshot();
          const currentThreads = snapshot.threads.filter(
            (thread) => thread.id === binding.threadId && thread.deletedAt === null,
          );
          const currentProjects = snapshot.projects.filter(
            (project) => project.id === binding.projectId && project.deletedAt === null,
          );
          check(
            currentThreads.length === 1 &&
              currentProjects.length === 1 &&
              currentProjects[0]!.workspaceRoot === context.projectPath &&
              currentThreads[0]!.kind === "workspace" &&
              currentThreads[0]!.projectId === binding.projectId &&
              currentThreads[0]!.branch === binding.branch &&
              currentThreads[0]!.worktreePath === workspace.path,
          );
          // Before choosing Worktree, bind the public project route; the strict
          // substate reader separately requires the chosen exact branch at admission/capture.
          check(
            await bounded(
              b().execute((input) => {
                if (
                  location.origin !== input.origin ||
                  location.search ||
                  location.hash ||
                  document.documentElement.classList.contains("dark") !==
                    (input.theme === "dark") ||
                  document.querySelector(
                    '[data-testid="environment-rail-local"][aria-checked="true"] [data-status="connected"]',
                  ) === null ||
                  document.querySelector(
                    '#pairing-token,input[type="password"],input[autocomplete="one-time-code"],textarea[placeholder^="bibcode://pair"]',
                  ) !== null ||
                  document.getElementById("boot-shell") !== null ||
                  document.querySelector("vite-error-overlay") !== null
                )
                  return false;
                if (location.pathname === "/local/" + input.threadId) {
                  return (
                    document.querySelectorAll(
                      '[data-testid="thread-card-button-' +
                        input.threadId +
                        '"][aria-current="page"]',
                    ).length === 1
                  );
                }
                const headers = document.querySelectorAll(
                  "header[data-environment-id][data-project-id]",
                );
                return (
                  location.pathname === "/project/local/" + input.projectId + "/git" &&
                  headers.length === 1 &&
                  headers[0]!.getAttribute("data-environment-id") === "local" &&
                  headers[0]!.getAttribute("data-project-id") === input.projectId
                );
              }, binding),
              2_000,
            ),
          );
        };
        step("visual-workspace-substates-batch-entry");
        const proof = await runWorkspaceSubstateBatch({
          ...binding,
          step,
          browser: b(),
          owner,
          verifyManaged,
          observeCleanupFailure: () => {
            success = false;
          },
          capture: async (substate) => {
            step("visual-workspace-substate-" + substate);
            captures.push(
              await captureWorkspaceSubstate({
                ...binding,
                substate,
                browser: b(),
                owner,
                evidence: config.evidence,
                captured: capturedVisuals,
                verifyManaged,
              }),
            );
            write("assertions", { captures, assertions });
          },
        });
        assertions.push({ theme, ...proof });
      } else if (config.selection === "release-visual-core") {
        await type("Owned visual review draft");
        const verifyVisualOwnedSource = async () => {
          check(
            JSON.stringify(readOwnedDeliveryWorktree(visualInput)) ===
              JSON.stringify({
                path: workspace.path,
                branch: workspace.branch,
                commonDirectory: workspace.commonDirectory,
              }),
          );
        };
        const proof = await runVisualCore({
          browser,
          owner,
          threadId: workspace.threadId,
          branch: workspace.branch,
          step,
          openWorktreeDialog,
          verifyManaged: async () => {
            textRowObservationInput = null;
            await owner.until(
              async () =>
                (
                  await b().execute(readSelectedDeliveryWorktree, {
                    origin,
                    branch: workspace.branch,
                    boundThreadId: workspace.threadId,
                  })
                )?.threadId === workspace.threadId,
            );
            await verifyVisualOwnedSource();
            textRowObservationInput = {
              theme,
              origin,
              threadId: workspace.threadId,
              branch: workspace.branch,
            };
          },
          captureImageOriginal: (capture) =>
            runCoreImageDiffOriginal({
              browser: b(),
              owner,
              theme,
              origin,
              threadId: workspace.threadId,
              branch: workspace.branch,
              verifyOwnedSource: verifyVisualOwnedSource,
              capture,
              step,
            }),
          partialStageMatches: () => visualPartialStageMatches(visualInput),
          recordClearObservation: (value) => {
            createRefClearObservation = projectVisualNameClearObservation(value);
          },
          capture: async (scene) => {
            if (scene === "worktree-create-ref")
              createRefObservationInput = {
                scene,
                theme,
                origin,
                threadId: workspace.threadId,
                branch: workspace.branch,
              };
            captures.push(
              await captureVisualScene({
                browser: b(),
                owner,
                evidence: config.evidence,
                captured: capturedVisuals,
                scene,
                theme,
                origin,
                threadId: workspace.threadId,
                branch: workspace.branch,
                ...(scene === "git-image-diff"
                  ? { verifyOwnedSource: verifyVisualOwnedSource }
                  : {}),
                ...(scene === "git-branch-menu" || scene === "command-palette"
                  ? {
                      observeFailure: createCoreCaptureFailureObserver(
                        coreCaptureFailures,
                        {
                          source: config.source,
                          scene,
                          theme,
                          origin,
                          threadId: workspace.threadId,
                          branch: workspace.branch,
                        },
                        textRowObservationInput,
                      ),
                    }
                  : {}),
              }),
            );
            write("assertions", { captures, assertions });
          },
        });
        assertions.push({ theme, ...proof });
      } else if (config.selection === "release-visual-provider-chat") {
        if (providerSnapshot === null || providerMedia === null || providerDescriptor === null)
          throw new Error("Owned provider context unavailable.");
        const rawSnapshot = providerSnapshot,
          media = providerMedia,
          descriptor = providerDescriptor;
        const snapshot = async () => {
          const current = await readOwnedGitProjectDescriptor();
          check(
            current.environmentId === descriptor.environmentId &&
              current.bootId === descriptor.bootId &&
              current.storageInstanceId === descriptor.storageInstanceId,
          );
          return rawSnapshot();
        };
        const unsafe = () => {
          providerChatFixtureSafeToDelete = false;
        };
        step("visual-provider-chat-baseline-checkpoint");
        await owner.until(async () => {
          const current = (await snapshot()).threads.filter(
            (value) => value.id === workspace.threadId && value.deletedAt === null,
          );
          check(current.length === 1);
          const host = current[0]!;
          return (
            host.latestTurn?.state === "completed" &&
            host.checkpoints.some(
              (value) => value.turnId === host.latestTurn?.turnId && value.status === "ready",
            )
          );
        });
        step("visual-provider-chat-public-asset");
        const assetGrant = await owner.json(
          config.binary,
          ["pairing", "issue", "--base-dir", context.stateRoot, "--json"],
          childEnv,
        );
        const assetCredential =
          typeof assetGrant === "object" && assetGrant !== null && "credential" in assetGrant
            ? assetGrant.credential
            : null;
        if (
          typeof assetCredential !== "string" ||
          assetCredential.length < 8 ||
          assetCredential.length > 16384
        )
          throw new Error("Owned provider asset credential unavailable.");
        const accessToken = await fixtureAccessToken(origin, assetCredential);
        await withProviderChatPublicApi(
          { CI: childEnv.CI, accessToken, observeCleanupFailure: unsafe },
          async (api) => {
            await configureProviderChatMedia(
              media,
              await api.createAssetUrl(workspace.threadId),
              async (url) => {
                const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
                if (!response.ok) throw new Error("Owned provider asset refused.");
                const bytes = Buffer.from(await bounded(response.arrayBuffer(), 2000));
                if (bytes.length > 8192) throw new Error("Owned provider asset refused.");
                return bytes;
              },
            );
          },
        );
        const proof = await runProviderChatVisual({
          browser,
          owner,
          theme,
          origin,
          hostThreadId: workspace.threadId,
          projectPath: context.projectPath,
          workspace,
          snapshot,
          readInputs: () => readProviderChatInputs(context.providerInputLogPath),
          verifyWorktree: () =>
            check(
              JSON.stringify(readOwnedDeliveryWorktree(visualInput)) ===
                JSON.stringify({
                  path: workspace.path,
                  branch: workspace.branch,
                  commonDirectory: workspace.commonDirectory,
                }),
            ),
          verifyMedia: (changed) => verifyProviderChatMedia(media, changed),
          withRefusedModel: (run) =>
            withOwnedCodexVisualOptionRefusal(
              {
                selection: "provider-chat-v1",
                fixtureRoot: config.fixture,
                runRoot,
                childEnv,
                observeUnsafeCleanup: unsafe,
              },
              run,
            ),
          withManagedWorkspaceLoss: (readBinding, run) =>
            withProviderChatWorkspaceLoss(
              { worktree: visualInput, readBinding, observeUnsafeCleanup: unsafe },
              run,
            ),
          verifyLoss: (scope, binding) => {
            readProviderChatWorkspaceLoss(scope, binding);
          },
          capture: async (scene, verifyOwnedIdentity) => {
            captures.push(
              await captureProviderChatScene({
                browser: b(),
                owner,
                theme,
                origin,
                threadId: workspace.threadId,
                branch: workspace.branch,
                scene,
                evidence: config.evidence,
                captured: capturedVisuals,
                verifyOwnedIdentity,
              }),
            );
            write("assertions", { captures, assertions });
          },
          observeUnsafeCleanup: unsafe,
          step,
        });
        assertions.push(proof);
        write("assertions", { captures, assertions });
      } else if (config.selection === "release-visual-cursor-question") {
        const snapshot = createOwnedGitProjectSnapshotReader(() =>
          owner.json(
            config.binary,
            ["pairing", "issue", "--base-dir", context.stateRoot, "--json"],
            childEnv,
          ),
        );
        const currentThread = async () => {
          const model = await snapshot();
          const matching = model.threads.filter(
            (entry) =>
              entry.id === workspace.threadId &&
              entry.deletedAt === null &&
              entry.archivedAt === null &&
              entry.worktreePath === workspace.path,
          );
          check(matching.length === 1);
          return matching[0]!;
        };
        step("visual-cursor-question-bind-context");
        const initial = await snapshot();
        const questionThreads = initial.threads.filter(
          (entry) =>
            entry.id === workspace.threadId &&
            entry.deletedAt === null &&
            entry.archivedAt === null &&
            entry.kind === "workspace" &&
            entry.branch === workspace.branch &&
            entry.worktreePath === workspace.path,
        );
        check(questionThreads.length === 1);
        const questionThread = questionThreads[0]!;
        check(
          questionThread.session === null &&
            questionThread.latestTurn === null &&
            questionThread.messages.length === 0,
        );
        const projects = initial.projects.filter(
          (entry) =>
            entry.id === questionThread.projectId &&
            entry.deletedAt === null &&
            entry.workspaceRoot === context.projectPath,
        );
        check(projects.length === 1);
        const primaryThreads = initial.threads.filter(
          (entry) =>
            entry.projectId === questionThread.projectId &&
            entry.kind === "default" &&
            entry.worktreePath === null &&
            entry.archivedAt === null &&
            entry.deletedAt === null,
        );
        check(primaryThreads.length === 1 && primaryThreads[0]!.id !== questionThread.id);
        const originalContext: GitProjectVisualSelection = Object.freeze({
          environmentId: "local",
          projectId: questionThread.projectId,
          threadId: primaryThreads[0]!.id,
          cwd: context.projectPath,
          branch: primaryThreads[0]!.branch,
          title: projects[0]!.title,
        });
        const verifyRestoredIdentity = async () => {
          check(
            JSON.stringify(readOwnedDeliveryWorktree(visualInput)) ===
              JSON.stringify({
                path: workspace.path,
                branch: workspace.branch,
                commonDirectory: workspace.commonDirectory,
              }),
          );
          await owner.until(
            async () =>
              (await bounded(
                b().execute(readGitProjectSelection, { origin, selection: originalContext }),
                2_000,
              )) &&
              (await b()
                .$(`${form} [data-chat-provider-model-picker="true"]`)
                .getAttribute("aria-label")) === "Claude · Opus 5",
          );
        };
        let originalTurnId: string | null = null;
        let pendingCursorBinding: PendingCursorQuestionBinding | null = null;
        const verifyOwnedIdentity = async () => {
          check(
            JSON.stringify(readOwnedDeliveryWorktree(visualInput)) ===
              JSON.stringify({
                path: workspace.path,
                branch: workspace.branch,
                commonDirectory: workspace.commonDirectory,
              }),
          );
          check(
            (
              await b().execute(readSelectedDeliveryWorktree, {
                origin,
                branch: workspace.branch,
                boundThreadId: workspace.threadId,
              })
            )?.threadId === workspace.threadId,
          );
        };
        cursorTurnObservation = null;
        cursorOriginalFailure = null;
        const proof = await runCursorQuestionVisual({
          browser: b(),
          owner,
          verifyOwnedIdentity,
          verifyRestoredIdentity,
          step,
          observeFailure: (error) => {
            if (cursorOriginalFailurePhases.has(phase)) cursorOriginalFailure = { error, phase };
          },
          selectCursor: async () => {
            await click(`${form} [data-chat-provider-model-picker="true"]`);
            await click(
              '[data-model-picker-content="true"] [data-model-picker-instance-id="cursor"][data-model-picker-model-slug="cursor-fixture"]',
            );
            await owner.until(
              async () =>
                (await b()
                  .$(`${form} [data-chat-provider-model-picker="true"]`)
                  .getAttribute("aria-label")) === "Cursor · Cursor Fixture",
            );
          },
          restoreOriginal: async () => {
            await b().keys("Escape");
            await click(`[data-testid="primary-card-button-${originalContext.projectId}"]`);
          },
          send: async (text) => {
            step("visual-cursor-question-turn-before");
            const beforeThread = await currentThread();
            const before = beforeThread.latestTurn?.turnId ?? null;
            const beforeCursor = {
              messageIds: beforeThread.messages.map((message) => message.id),
              activityIds: beforeThread.activities.map((activity) => activity.id),
            };
            step("visual-cursor-question-send");
            await send(text);
            step("visual-cursor-question-turn-running");
            await owner.until(async () => {
              const thread = await currentThread(),
                turn = thread.latestTurn;
              cursorTurnObservation = Object.freeze({
                modelCursor: thread.modelSelection.instanceId === "cursor",
                turnPresent: turn !== null,
                newTurn: turn !== null && turn.turnId !== before,
                turnRunning: turn?.state === "running",
                sessionPresent: thread.session !== null,
                sessionCursor: thread.session?.providerName === "cursor",
                activeTurnMatches: turn !== null && thread.session?.activeTurnId === turn.turnId,
                sessionError:
                  thread.session?.status === "error" || thread.session?.lastError != null,
                promptRecorded: thread.messages.some(
                  (message) =>
                    message.role === "user" && message.text === cursorQuestionFixturePrompt,
                ),
              });
              const binding = bindPendingCursorQuestion(thread, beforeCursor);
              if (binding === null) return false;
              pendingCursorBinding = binding;
              originalTurnId = binding.turnId;
              return true;
            });
          },
          capture: async () => {
            captures.push(
              await captureCursorQuestionVisual({
                browser: b(),
                owner,
                theme,
                origin,
                threadId: workspace.threadId,
                branch: workspace.branch,
                evidence: config.evidence,
                captured: capturedVisuals,
                verifyOwnedIdentity,
              }),
            );
            write("assertions", { captures, assertions });
          },
          waitOriginalTurnCompleted: () =>
            owner.until(async () => {
              if (
                originalTurnId === null ||
                pendingCursorBinding === null ||
                pendingCursorBinding.turnId !== originalTurnId ||
                !completedPendingCursorQuestion(await currentThread(), pendingCursorBinding)
              )
                return false;
              const observed = await bounded(
                b().execute(readCursorQuestionObservation, {
                  phase: "quiescent" as const,
                  theme,
                  origin,
                  threadId: workspace.threadId,
                  branch: workspace.branch,
                }),
                2000,
              );
              try {
                validateCursorQuestionWitness("quiescent", observed);
                return true;
              } catch {
                return false;
              }
            }),
        });
        assertions.push({ theme, ...proof });
        write("assertions", { captures, assertions });
      } else if (config.selection === "release-visual-browser-followups") {
        if (!browserFollowup) throw new Error("Owned browser follow-up resources unavailable.");
        await type("Owned visual review draft");
        const grant = await owner.json(
          config.binary,
          ["pairing", "issue", "--base-dir", context.stateRoot, "--json"],
          childEnv,
        );
        const credential =
          typeof grant === "object" && grant !== null && "credential" in grant
            ? grant.credential
            : null;
        if (typeof credential !== "string" || credential.length < 8)
          throw new Error("Owned browser follow-up grant unavailable.");
        const accessToken = await fixtureAccessToken("http://127.0.0.1:4887", credential);
        await runBrowserFollowupCaller({
          CI: childEnv.CI,
          prepared: browserFollowup,
          browser,
          owner,
          theme,
          accessToken,
          threadId: workspace.threadId,
          cwd: workspace.path,
          branch: workspace.branch,
          projectPath: context.projectPath,
          readDescriptor: readOwnedGitProjectDescriptor,
          readSnapshot: () => readOwnedGitProjectSnapshot(accessToken),
          verifyPhysical: async () => {
            check(
              JSON.stringify(readOwnedDeliveryWorktree(visualInput)) ===
                JSON.stringify({
                  path: workspace.path,
                  branch: workspace.branch,
                  commonDirectory: workspace.commonDirectory,
                }),
            );
          },
          patch: () =>
            runOwnedGitProjectCommand(
              {
                root: runRoot,
                fixtureRoot: config.fixture,
                home: context.fixtureUserHomePath,
                git: NodePath.join(config.fixture, "bin", "git"),
              },
              workspace.path,
              ["diff", "--no-ext-diff", "--patch", "--minimal", "HEAD", "--"],
            ).stdout,
          viewport: async (target, width, height) => {
            const measured = await bounded(target.execute(readVisualViewport), 2000),
              outer = await target.getWindowSize(),
              corrected = correctDesktopUiOuterSize(
                outer,
                { width, height },
                measured,
                measured.devicePixelRatio,
              );
            await target.setWindowSize(corrected.width, corrected.height);
            await owner.until(async () => {
              const current = await bounded(target.execute(readVisualViewport), 2000);
              return current.width === width && current.height === height;
            });
          },
          evidence: config.evidence,
          captured: capturedVisuals,
          captures: captures as never,
          publish: () => write("assertions", { captures, assertions }),
          step,
          observeUnsafeCleanup: () => {
            browserFollowupFixtureSafeToDelete = false;
          },
        });
        assertions.push({
          theme,
          rows: 6,
          baseOriginals: 6,
          supplements: 1,
          producerSourceJoined: true,
          bootstrapReplayJoined: true,
          completeGroup: false,
        });
      } else if (config.selection === "release-visual-settings-followups") {
        if (!settingsFollowupUsage || server.child.pid === undefined)
          throw new Error("Owned settings follow-up fixture unavailable.");
        await type("Owned visual review draft");
        await runSettingsFollowupCaller({
          CI: childEnv.CI,
          root: runRoot,
          binary: config.binary,
          assets: config.assets,
          theme,
          owner,
          browser,
          primaryContext: context,
          primaryEnvironment: childEnv,
          importProject: (project) => importProject(project),
          primaryServer: server,
          threadId: workspace.threadId,
          usage: settingsFollowupUsage,
          evidence: config.evidence,
          captured: capturedVisuals,
          captures,
          assertions,
          admitOwner: async () => {
            const admitted = deliveryConfiguration(process.env);
            check(
              admitted.selection === config.selection &&
                admitted.fixture === config.fixture &&
                admitted.source === config.source,
            );
          },
          verifyPrimaryGit: () =>
            check(
              JSON.stringify(readOwnedDeliveryWorktree(visualInput)) ===
                JSON.stringify({
                  path: workspace.path,
                  branch: workspace.branch,
                  commonDirectory: workspace.commonDirectory,
                }),
            ),
          git: (sourceContext, cwd, args) =>
            runOwnedGitProjectCommand(
              {
                root: runRoot,
                fixtureRoot: config.fixture,
                home: sourceContext.fixtureUserHomePath,
                git: NodePath.join(config.fixture, "bin", "git"),
              },
              cwd,
              args,
            ),
          step,
          write,
          observeUnsafeCleanup: () => {
            settingsFollowupFixtureSafeToDelete = false;
          },
        });
      } else if (config.selection === "release-visual-settings") {
        await type("Owned visual review draft");
        const verifyOwnedIdentity = async () => {
          check(
            JSON.stringify(readOwnedDeliveryWorktree(visualInput)) ===
              JSON.stringify({
                path: workspace.path,
                branch: workspace.branch,
                commonDirectory: workspace.commonDirectory,
              }),
          );
        };
        const proof = await runVisualSettings({
          browser,
          owner,
          origin,
          theme,
          threadId: workspace.threadId,
          branch: workspace.branch,
          step,
          verifyOwnedIdentity,
          verifyManaged: async () => {
            await owner.until(
              async () =>
                (
                  await b().execute(readSelectedDeliveryWorktree, {
                    origin,
                    branch: workspace.branch,
                    boundThreadId: workspace.threadId,
                  })
                )?.threadId === workspace.threadId,
            );
            await verifyOwnedIdentity();
          },
          capture: async (scene) => {
            captures.push(
              projectSettingsVisualCapture(
                await captureSettingsVisualScene({
                  browser: b(),
                  owner,
                  evidence: config.evidence,
                  captured: capturedVisuals,
                  scene,
                  theme,
                  origin,
                  threadId: workspace.threadId,
                  branch: workspace.branch,
                  verifyOwnedIdentity,
                  observeFailure: createSettingsCaptureFailureObserver(settingsCaptureFailures, {
                    scene,
                    theme,
                    origin,
                    threadId: workspace.threadId,
                    branch: workspace.branch,
                  }),
                }),
              ),
            );
            write("assertions", { captures, assertions });
          },
        });
        assertions.push(projectSettingsVisualAssertion(theme, proof));
        write("assertions", { captures, assertions });
      } else {
        step("hold-input");
        NodeFS.writeFileSync(NodePath.join(control, "withhold-next"), "hold", {
          mode: 0o600,
          flag: "wx",
        });
        await send(prompt);
        await owner.until(async () => {
          const value = readDeliveryReceipts(control);
          return (
            value.complete &&
            value.entries.some(
              (entry) => entry.kind === "input" && entry.prompt === prompt && entry.withheld,
            )
          );
        });
        const message = await readMessage(prompt);
        check(message && message.text === prompt);
        const id = message!.id;
        await type(draft);
        step("workspace-verify-identity");
        check(
          (
            await browser.execute(readSelectedDeliveryWorktree, {
              origin,
              branch: workspace.branch,
              boundThreadId: workspace.threadId,
            })
          )?.threadId === workspace.threadId,
        );
        check(
          JSON.stringify(
            readOwnedDeliveryWorktree({
              root: runRoot,
              project: context.projectPath,
              home: context.fixtureUserHomePath,
              git: NodePath.join(config.fixture, "bin", "git"),
              branch: workspace.branch,
            }),
          ) ===
            JSON.stringify({
              path: workspace.path,
              branch: workspace.branch,
              commonDirectory: workspace.commonDirectory,
            }),
        );
        step("workspace-loss");
        await withUnavailableWorkspace(runRoot, workspace.path, async () => {
          step("workspace-wait-loss");
          await owner.until(async () => {
            check(
              NodeFS.statSync(context.projectPath).isDirectory() &&
                NodeFS.statSync(workspace.commonDirectory).isDirectory(),
            );
            const warning = browser!.$(
              `[data-testid="worktree-availability-${workspace.threadId}"]`,
            );
            return (
              (await warning.isExisting()) &&
              (await warning.getText()).includes(
                "The worktree directory is missing. Git registration remains.",
              ) &&
              (await browser!.$(row(id)).getText()).includes("Delivery uncertain")
            );
          });
        });
        step("uncertain");
        const before = readDeliveryReceipts(control);
        check(before.complete);
        const holdStarted = performance.now();
        while (performance.now() - holdStarted < 10_000) {
          unchanged(before, readDeliveryReceipts(control));
          await delay(100);
        }
        unchanged(before, readDeliveryReceipts(control));
        const uncertaintyWindowMs = Math.floor(performance.now() - holdStarted);
        step("workspace-wait-recovered");
        await owner.until(
          async () =>
            (
              await browser!.execute(readSelectedDeliveryWorktree, {
                origin,
                branch: workspace.branch,
                boundThreadId: workspace.threadId,
              })
            )?.threadId === workspace.threadId &&
            !(await browser!
              .$(`[data-testid="worktree-availability-${workspace.threadId}"]`)
              .isExisting()),
        );
        check(
          readOwnedDeliveryWorktree({
            root: runRoot,
            project: context.projectPath,
            home: context.fixtureUserHomePath,
            git: NodePath.join(config.fixture, "bin", "git"),
            branch: workspace.branch,
          }).path === workspace.path,
        );
        unchanged(before, readDeliveryReceipts(control));
        step("uncertain");
        check((await readMessage(prompt))?.id === id && (await draftIs(draft)));
        await capture("uncertain", id, prompt, draft);
        step("dismiss-prompt");
        const retry = () => click(`${row(id)} button[aria-label="Retry message delivery"]`);
        const dismissed = await resolveActualRetryPrompt(retryDialogBrowser(), retry, "dismiss");
        const cancelStarted = performance.now();
        while (performance.now() - cancelStarted < 1000) {
          unchanged(before, readDeliveryReceipts(control));
          await delay(100);
        }
        unchanged(before, readDeliveryReceipts(control));
        const cancelWindowMs = Math.floor(performance.now() - cancelStarted);
        check(
          (await browser.$(row(id)).getText()).includes("Delivery uncertain") &&
            (await draftIs(draft)),
        );
        await capture("retry-cancelled", id, prompt, draft);
        step("accept-prompt");
        const accepted = await resolveActualRetryPrompt(retryDialogBrowser(), retry, "accept");
        await owner.until(async () =>
          (await browser!.$(row(id)).getText()).includes(newConversationNotice),
        );
        const proof = verifyFreshRetry(before, readDeliveryReceipts(control), prompt);
        check((await readMessage(prompt))?.id === id && (await draftIs(draft)));
        assertions.push({
          theme,
          ordinaryDeliveredHasNoNotice: true,
          selectedManagedWorktree: true,
          registeredGitIdentityMatched: true,
          primaryGitAnchorPreserved: true,
          catalogLossObserved: true,
          workspaceRestoredBeforeRetry: true,
          uncertaintyWindowMs,
          cancelWindowMs,
          noAutomaticResend: true,
          dismissed,
          accepted,
          cancelNoDispatch: true,
          sameMessage: true,
          exactText: true,
          draftRetained: true,
          ...proof,
        });
        await capture("new-conversation", id, prompt, draft);
      }
      step("theme-cleanup");
      await owner.cleanup("browser", () =>
        bounded(
          browser!.deleteSession().then(() => undefined),
          15_000,
        ),
      );
      browser = undefined;
      if (browserFollowup) await browserFollowup.close();
      await owner.stop(opened.driver);
      await owner.stop(server);
      if (settingsFollowupUsage && settingsFollowupFixtureSafeToDelete)
        settingsFollowupUsage.close();
      check(owner.failures.length === 0);
    }
    if (config.selection === "release-visual-settings")
      validateSettingsVisualJoins(captures, assertions);
    if (config.selection === "release-visual-settings-followups")
      validateSettingsFollowupJoins(captures, assertions);
    if (config.selection === "release-visual-workspace-substates")
      validateWorkspaceSubstateJoins(captures, assertions);
    if (config.selection === "release-visual-provider-chat")
      validateProviderChatJoins(captures, assertions);
    if (config.selection === "release-visual-project-lifecycle")
      validateProjectLifecycleJoins(captures, assertions);
    if (config.selection === "release-visual-browser-followups")
      validateBrowserFollowupJoins(captures as never);
    if (config.selection === "release-visual-pull-requests")
      validatePullRequestsCallerJoins(captures, assertions);
    check(
      captures.length ===
        deliveryThemes.length *
          (config.selection === "release-visual-browser-followups"
            ? 7
            : config.selection === "release-visual-pull-requests"
              ? 24
              : config.selection === "release-visual-core"
                ? visualScenes.length
                : config.selection === "release-visual-settings"
                  ? settingsVisualScenes.length
                  : config.selection === "release-visual-settings-followups"
                    ? settingsFollowupScenes.length
                    : config.selection === "release-visual-git-project"
                      ? gitProjectVisualScenes.length
                      : config.selection === "release-visual-cursor-question"
                        ? 1
                        : config.selection === "release-visual-workspace-substates"
                          ? workspaceSubstates.length
                          : config.selection === "release-visual-project-lifecycle"
                            ? 3
                            : config.selection === "release-visual-provider-chat"
                              ? qualifiedProviderChatScenes.length
                              : deliveryScenes.length) && assertions.length === 2,
    );
    success = true;
  } catch (error) {
    const originalCursorFailure = readCursorOriginalFailure();
    if (originalCursorFailure !== null && originalCursorFailure.error === error) {
      phase = originalCursorFailure.phase;
      try {
        write("phase", { phase, theme });
      } catch {
        // The original failure still owns its receipt and joined cleanup.
      }
    }
    const textRowObservation =
      browser && phase === "visual-partial-stage-text-row-displayed"
        ? await readTextRowFailureObservation()
        : null;
    if (config.selection === "release-visual-pull-requests")
      pullRequestsFixtureSafeToDelete = false;
    const createRefObservation =
      browser && phase === "visual-worktree-create-ref"
        ? await readCreateRefFailureObservation()
        : null;
    const startupObservation =
      browser && (phase.startsWith("pair-") || phase.startsWith("theme-"))
        ? await readStartupFailureObservation()
        : null;
    const importObservation =
      browser && phase.startsWith("import-") ? await readImportFailureObservation() : null;
    const worktreeObservation =
      browser &&
      [
        "worktree-open-count",
        "worktree-open-focus",
        "worktree-open-displayed",
        "worktree-open-enabled",
        "worktree-open-focus-confirm",
        "worktree-open-enter",
      ].includes(phase)
        ? await readWorktreeFailureObservation()
        : null;
    write("failure", {
      phase,
      theme,
      failure: classifyQualificationFailure(error),
      cursorTurnObservation:
        config.selection === "release-visual-cursor-question" &&
        phase === "visual-cursor-question-turn-running" &&
        originalCursorFailure?.error === error
          ? cursorTurnObservation
          : null,
      startupObservation,
      importObservation,
      worktreeObservation,
      createRefObservation,
      textRowObservation,
      gitProjectDirectoryFailureFacts: gitProjectDirectoryFailureFacts(error, phase),
      gitProjectTabFailureFacts:
        config.selection === "release-visual-git-project"
          ? gitProjectTabFailureFacts(error, phase)
          : null,
      gitProjectTabInterception:
        phase === "visual-git-project-tab-changes-click" ||
        phase === "visual-git-project-tab-history-click" ||
        phase === "visual-git-project-tab-tags-click"
          ? projectGitProjectTabInterception(error, phase, config.selection)
          : null,
      coreCaptureFailureFacts:
        phase === "visual-git-branch-menu" || phase === "visual-command-palette"
          ? readCoreCaptureFailureFacts(coreCaptureFailures, error, {
              source: config.source,
              scene: phase === "visual-git-branch-menu" ? "git-branch-menu" : "command-palette",
              phase,
              theme,
              origin,
              threadId:
                (textRowObservationInput as VisualTextRowObservationInput | null)?.threadId ?? "",
              branch:
                (textRowObservationInput as VisualTextRowObservationInput | null)?.branch ?? "",
            })
          : null,
      settingsCaptureFailureFacts:
        resolveSettingsVisualFailureScene(phase) !== null
          ? readSettingsCaptureFailureFacts(settingsCaptureFailures, error, phase, theme)
          : null,
      createRefClearObservation:
        phase === "visual-worktree-create-ref" ? createRefClearObservation : null,
      browserDriverReadiness:
        phase === "browser" ? projectOwnedDriverReadiness(browserDriverReadiness) : null,
      browserReadinessStage:
        phase === "browser" &&
        ["driver-readiness", "session-create", "online-proof"].includes(browserReadinessStage ?? "")
          ? browserReadinessStage
          : null,
      browserSessionObservation:
        phase === "browser"
          ? projectOwnedBrowserSessionObservation(browserSessionObservation)
          : null,
    });
  } finally {
    const processes = owner.processes.map(({ child, role, log, spawnFailure }) =>
      projectQualificationProcess({
        role,
        log,
        spawnFailure,
        exitCode: child.exitCode,
        signal: child.signalCode,
      }),
    );
    if (
      processes.some(
        (entry) => !entry.logReadable || entry.logTruncated || entry.guardRefusals !== 0,
      )
    )
      success = false;
    await owner.close({
      ...(browser ? { browser: () => browser!.deleteSession().then(() => undefined) } : {}),
      proxies: browserFollowupResources.map((resource) => resource.close),
    });
    for (const fixture of settingsFollowupUsageFixtures) {
      if (!settingsFollowupFixtureSafeToDelete) break;
      try {
        fixture.close();
      } catch {
        settingsFollowupFixtureSafeToDelete = false;
      }
    }
    if (owner.failures.length > 0 || !owner.childrenClosed()) success = false;
    if (config.selection === "release-visual-pull-requests" && success) {
      try {
        if (
          owner.failures.length !== 0 ||
          !owner.childrenClosed() ||
          pullRequestsHostingOwners.length !== 2
        )
          throw new Error("Owned request hosting cleanup refused.");
        for (const verify of pullRequestsHostingOwners)
          pullRequestsHostingRestorationProofs.push(verify());
      } catch (hostingError) {
        pullRequestsFixtureSafeToDelete = false;
        success = false;
        owner.failures.push({
          role: "visual-owned-pull-requests-hosting",
          failure: classifyQualificationFailure(hostingError),
        });
      }
    }
    if (
      config.selection === "release-visual-pull-requests" &&
      (!success || owner.failures.length > 0 || !owner.childrenClosed())
    )
      pullRequestsFixtureSafeToDelete = false;
    if (
      config.selection === "release-visual-browser-followups" &&
      !browserFollowupFixtureSafeToDelete
    )
      success = false;
    if (config.selection === "release-visual-provider-chat" && !providerChatFixtureSafeToDelete)
      success = false;
    if (
      config.selection === "release-visual-settings-followups" &&
      !settingsFollowupFixtureSafeToDelete
    )
      success = false;
    if (
      config.selection === "release-visual-project-lifecycle" &&
      !projectLifecycleFixtureSafeToDelete
    )
      success = false;
    write("result", {
      success,
      phase,
      theme,
      source: config.source,
      selection: config.selection,
      captures,
      assertions,
      networkProofs,
      processes,
      cleanupFailures: owner.failures,
      childProcessesClosed: owner.childrenClosed(),
      ...(config.selection === "release-visual-browser-followups"
        ? { browserFollowupFixtureSafeToDelete }
        : {}),
      ...(config.selection === "release-visual-provider-chat"
        ? { providerChatFixtureSafeToDelete }
        : {}),
      ...(config.selection === "release-visual-settings-followups"
        ? { settingsFollowupFixtureSafeToDelete }
        : {}),
      ...(config.selection === "release-visual-project-lifecycle"
        ? { projectLifecycleFixtureSafeToDelete }
        : {}),
      ...(config.selection === "release-visual-pull-requests"
        ? { pullRequestsFixtureSafeToDelete, pullRequestsHostingRestorationProofs }
        : {}),
      scope:
        config.selection === "release-visual-browser-followups"
          ? "Six existing browser rows in fourteen source-bound originals through genuine staging/cancellation, same-terminal reconnect/Fit, real Git diff, unchanged slow diagnostics and immutable hosted entry. completeGroup false; original82/164, independent original pixel review and native/final acceptance remain required."
          : config.selection === "release-visual-pull-requests"
            ? "Five existing PR/MR rows in forty-eight source-bound originals through real private Git, fake hosting protocol and public typed UI. Independent original pixel review and native/full82 acceptance remain unqualified."
            : config.selection === "release-visual-core"
              ? "First nine Linux Chromium scene pairs only. Original PNGs require independent review; unpictured surfaces and the remaining issue29 matrix are unqualified. No Playwright, Tauri or final-release acceptance claim."
              : config.selection === "release-visual-settings"
                ? "Four Linux Chromium settings scene pairs only. Add instance wizard and declared unpictured substates remain unqualified. Original light/dark PNGs require independent review; no native or full-matrix qualification claim."
                : config.selection === "release-visual-settings-followups"
                  ? "Four existing Settings rows in eighteen Linux Chromium originals through native A/B APIs and public controls. completeGroup false; full82/164 scope, independent original pixel review and native/final acceptance remain required."
                  : config.selection === "release-visual-git-project"
                    ? "Eleven fixed Git/project originals per theme; Tags groups/names remain partial. completeGroup remains false. Full82/164 originals and unpictured substates remain obligatory and unqualified; independent original-pixel review required."
                    : config.selection === "release-visual-cursor-question"
                      ? "One fixed Cursor later-multiselect question pair only through native ACP and public choices/Submit. completeGroup remains false; full82/164 and independent original pixel review remain required. No Tauri or final-product acceptance claim."
                      : config.selection === "release-visual-workspace-substates"
                        ? "Three existing-row substates in six extra originals only: selected stash diff, owned Files item menu and public terminal/activity/more-chat lines. Core nine and full82/164 remain unchanged; completeGroup false, independent original pixel review and native/final acceptance remain required."
                        : config.selection === "release-visual-project-lifecycle"
                          ? "Three existing project lifecycle rows in six Linux Chromium originals only through maintained Codex, real owned Git transfer and server Git trust policy. completeGroup false; full82/164 and independent original pixel review remain required. No native or final-product acceptance claim."
                          : config.selection === "release-visual-provider-chat"
                            ? "Seven existing provider/chat rows in fourteen originals only through native Codex/Claude and public controls. Cursor owns the separate question pair. completeGroup false; full82/164 and independent original pixel review remain required. No Tauri or final-product acceptance claim."
                            : "Real Linux Chromium Retry prompt and rendered notices only; not Tauri native-dialog or final issue29 qualification.",
    });
  }
  return success ? 0 : 1;
}

if (import.meta.main) process.exitCode = await runDeliveryRetryQualification();
