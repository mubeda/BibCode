// @effect-diagnostics nodeBuiltinImport:off - Disposable CI browser qualifier owns fixture paths.
// @effect-diagnostics globalFetch:off - Only the owned loopback CLI is probed.
// @effect-diagnostics globalTimers:off - Real bounded negative observation windows.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeNet from "node:net";
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
  type GitProjectVisualSelection,
} from "./support/release-visual-git-project.ts";
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
} from "./support/qualification-owner.ts";
import { prepareDesktopUiTestContext } from "./support/test-project.ts";
import {
  classifyQualificationFailure,
  projectQualificationProcess,
} from "./support/chat-upload-evidence.ts";
import { inspectScreenshot, validateCaptureWitness } from "./support/remote-ui-evidence.ts";
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
import { captureVisualScene, runVisualCore } from "./support/release-visual-core.ts";
import { visualScenes } from "./support/release-visual-evidence.ts";
import {
  runVisualSettings,
  captureSettingsVisualScene,
  settingsVisualScenes,
  projectSettingsVisualCapture,
  projectSettingsVisualAssertion,
  validateSettingsVisualJoins,
  projectSettingsVisualFailureWitness,
  type SettingsVisualObservationInput,
} from "./support/release-visual-settings.ts";
import { readSettingsVisualProviderConfiguration } from "./support/release-visual-settings-preflight.ts";
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

const root = NodePath.resolve(import.meta.dirname, "../../..");
const contractsRequire = NodeModule.createRequire(
  NodePath.join(root, "packages/contracts/package.json"),
);
const Schema: { decodeUnknownSync: <A>(schema: { readonly Type: A }) => (value: unknown) => A } =
  contractsRequire("effect/Schema");
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
  if (phase !== "visual-settings-source-control" || error === null || typeof error !== "object")
    return null;
  const record = records.get(error);
  if (record?.ownership.scene !== "settings-source-control" || record.ownership.theme !== theme)
    return null;
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
export async function readOwnedGitProjectSnapshot(credential: string) {
  const response = await fetch(origin + EnvironmentOrchestrationHttpApi.endpoints.snapshot.path, {
    headers: { authorization: `Bearer ${credential}` },
    signal: AbortSignal.timeout(1000),
  });
  if (!response.ok) throw new Error("Owned Git/project snapshot refused.");
  return Schema.decodeUnknownSync(OrchestrationReadModel)(await response.json());
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
  credential: string;
  evidence: string;
  captured: Set<string>;
  captures: object[];
  assertions: object[];
  importProject: (cwd: string) => Promise<void>;
  step: (phase: string) => void;
  write: (name: string, value: unknown) => void;
  readBranch: (cwd: string) => string | null;
}) {
  const initial = await readOwnedGitProjectDescriptor();
  if (initial.environmentId !== "local" || !initial.bootId || !initial.storageInstanceId)
    throw new Error("Owned Git/project server identity refused.");
  const adapters = createGitProjectOwnerAdapters({
    browser: input.browser,
    owner: input.owner,
    origin,
    fixture: input.fixture,
    importProject: input.importProject,
    readSnapshot: () => readOwnedGitProjectSnapshot(input.credential),
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
      "release-visual-git-project",
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
      | "release-visual-git-project";
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
  const assertions: object[] = [];
  const captures: object[] = [];
  const capturedVisuals = new Set<string>();
  const settingsCaptureFailures = new WeakMap<object, SettingsCaptureFailureRecord>();
  let createRefObservationInput: VisualObservationInput | null = null;
  let textRowObservationInput: VisualTextRowObservationInput | null = null;
  let createRefClearObservation: ReturnType<typeof projectVisualNameClearObservation> = null;
  let browserDriverReadiness: OwnedDriverReadiness | null = null;
  let browserReadinessStage: "driver-readiness" | "session-create" | "online-proof" | null = null;
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
        await bounded(browser!.execute(readDeliveryImportObservation, origin), 2_000),
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

  async function importProject(project: string) {
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
    await selectClaudeModel("import");
  }

  async function selectClaudeModel(scope: "import" | "worktree") {
    step(`${scope}-open-model-picker`);
    await click(`${form} [data-chat-provider-model-picker="true"]`);
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
          .$(`${form} [data-chat-provider-model-picker="true"]`)
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
    await selectClaudeModel("worktree");
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

  async function capture(scene: DeliveryScene, id: string, prompt: string, draft: string) {
    check(!(await b().isAlertOpen()));
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
      const env = {
        ...process.env,
        BIBCODE_E2E_RUN_ROOT: runRoot,
        BIBCODE_E2E_ARTIFACT_DIR: NodePath.join(runRoot, "private"),
        BIBCODE_E2E_PLATFORM: "linux",
      };
      const context = prepareDesktopUiTestContext(env);
      const control = NodePath.join(runRoot, "delivery-retry");
      if (config.selection === "delivery-retry-ui") NodeFS.mkdirSync(control, { mode: 0o700 });
      if (config.selection === "release-visual-core") {
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
      configured.enableProviderUpdateChecks = false;
      configured.worktreeBaseDirectory = NodePath.join(runRoot, "managed-worktrees");
      NodeFS.mkdirSync(configured.worktreeBaseDirectory, { mode: 0o700 });
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
      await new Promise<void>((resolve, reject) => {
        const probe = NodeNet.createServer();
        probe.once("error", () => reject(new Error("Owned delivery port unavailable.")));
        probe.listen(4885, "127.0.0.1", () =>
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
          "4885",
          "--base-dir",
          context.stateRoot,
          "--static-dir",
          config.assets,
          "--no-browser",
          "--no-startup-pairing-offer",
        ],
        childEnv,
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
          credential,
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
      step("import");
      await importProject(context.projectPath);
      const workspace = await createOwnedWorkspace(context, runRoot);
      const visualInput = {
        root: runRoot,
        project: context.projectPath,
        home: context.fixtureUserHomePath,
        git: NodePath.join(config.fixture, "bin", "git"),
        branch: workspace.branch,
      };
      if (config.selection === "release-visual-core") {
        step("visual-fixture-managed");
        check(prepareVisualWorktree(visualInput).path === workspace.path);
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
      } else if (config.selection === "release-visual-settings") {
        step("visual-settings-viewport");
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
      const baseline = `delivery baseline ${theme}`;
      const prompt = `delivery held message ${theme}`;
      const draft = `delivery preserved draft ${theme}`;
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
      if (config.selection === "release-visual-core") {
        await type("Owned visual review draft");
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
            check(
              JSON.stringify(readOwnedDeliveryWorktree(visualInput)) ===
                JSON.stringify({
                  path: workspace.path,
                  branch: workspace.branch,
                  commonDirectory: workspace.commonDirectory,
                }),
            );
            textRowObservationInput = {
              theme,
              origin,
              threadId: workspace.threadId,
              branch: workspace.branch,
            };
          },
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
              }),
            );
            write("assertions", { captures, assertions });
          },
        });
        assertions.push({ theme, ...proof });
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
        const dismissed = await resolveActualRetryPrompt(browser, retry, "dismiss");
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
        const accepted = await resolveActualRetryPrompt(browser, retry, "accept");
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
      await owner.stop(opened.driver);
      await owner.stop(server);
      check(owner.failures.length === 0);
    }
    if (config.selection === "release-visual-settings")
      validateSettingsVisualJoins(captures, assertions);
    check(
      captures.length ===
        deliveryThemes.length *
          (config.selection === "release-visual-core"
            ? visualScenes.length
            : config.selection === "release-visual-settings"
              ? settingsVisualScenes.length
              : config.selection === "release-visual-git-project"
                ? gitProjectVisualScenes.length - 1
                : deliveryScenes.length) && assertions.length === 2,
    );
    success = true;
  } catch (error) {
    const textRowObservation =
      browser && phase === "visual-partial-stage-text-row-displayed"
        ? await readTextRowFailureObservation()
        : null;
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
      startupObservation,
      importObservation,
      worktreeObservation,
      createRefObservation,
      textRowObservation,
      settingsCaptureFailureFacts:
        phase === "visual-settings-source-control"
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
    await owner.close(
      browser ? { browser: () => browser!.deleteSession().then(() => undefined) } : {},
    );
    if (owner.failures.length > 0 || !owner.childrenClosed()) success = false;
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
      scope:
        config.selection === "release-visual-core"
          ? "First eight Linux Chromium scene pairs only. Original PNGs require independent review; unpictured surfaces and the remaining issue29 matrix are unqualified. No Playwright, Tauri or final-release acceptance claim."
          : config.selection === "release-visual-settings"
            ? "Four Linux Chromium settings scene pairs only. Add instance wizard and declared unpictured substates remain unqualified. Original light/dark PNGs require independent review; no native or full-matrix qualification claim."
            : config.selection === "release-visual-git-project"
              ? "Ten fixed Git/project originals per theme; Tags groups/names partial and rewrite unbound. completeGroup remains false. Full82/164 originals and unpictured substates remain obligatory and unqualified; independent original-pixel review required."
              : "Real Linux Chromium Retry prompt and rendered notices only; not Tauri native-dialog or final issue29 qualification.",
    });
  }
  return success ? 0 : 1;
}

if (import.meta.main) process.exitCode = await runDeliveryRetryQualification();
