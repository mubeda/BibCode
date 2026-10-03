// @effect-diagnostics nodeBuiltinImport:off - This disposable CI qualification owns its processes and files.
// @effect-diagnostics globalFetch:off - All requests target owned loopback fixture endpoints.
// @effect-diagnostics globalTimers:off - Bounded qualification polling and child cleanup.
// @effect-diagnostics globalDate:off - Execution evidence records real elapsed time.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { remote } from "webdriverio";
import {
  BrowserConnectivityFailure,
  prepareNetworkBeforeBrowser,
  verifyPreparedBrowserOnline,
  readNetworkCommandResult,
  NetworkSetupFailure,
  type BrowserNetworkProof,
} from "./support/browser-network.ts";
import { EnvironmentMetadataHttpApi } from "../../../packages/contracts/src/environmentHttp.ts";

import { prepareDesktopUiTestContext } from "./support/test-project.ts";
import {
  browserStartupObservationScript,
  projectBrowserStartupObservation,
} from "./support/browser-startup.ts";
import {
  parseQualificationMode,
  projectStartupNetworkLogs,
  runCredentialFreeStartupProbe,
} from "./support/browser-startup-probe.ts";
import {
  createSizedPng,
  instrumentCodexAttachmentLog,
  STAGED_SMOKE_IMAGE_BYTES,
} from "./support/chat-upload-fixture.ts";
import {
  chatUploadObservationScript,
  projectChatUploadObservation,
} from "./support/chat-upload-observer.ts";
import {
  parseChatMatrixCase,
  runChatMatrixCase,
  activateMatrixCancel,
  readChatMatrixDom,
  matrixEditor,
  qualificationScreenSafe,
  type ChatMatrixCase,
  type MatrixBrowser,
} from "./support/chat-upload-matrix.ts";
import { startThrottleProxy } from "../../../scripts/throttle-proxy.ts";
import {
  inlineFallbackObservationScript,
  projectInlineFallbackObservation,
} from "./support/chat-inline-fallback.ts";
import {
  browserInlineMechanicsScript,
  type BrowserInlineAction,
} from "./support/chat-inline-mechanics.ts";
import { startInlineProbeReceiver } from "./support/chat-inline-receiver.ts";
import {
  runRemainingQualification,
  projectBrowserInlineObservation,
  projectOldInlineInput,
} from "./support/chat-remaining-qualification.ts";
import {
  classifyQualificationFailure,
  mayCaptureQualificationFailure,
  projectPairingObservation,
  projectQualificationProcess,
} from "./support/chat-upload-evidence.ts";

const qualificationMode = parseQualificationMode(process.env.BIBCODE_UPLOAD_MODE);
const selectedMatrixCase =
  qualificationMode === "upload-matrix"
    ? parseChatMatrixCase(process.env.BIBCODE_UPLOAD_CASE)
    : null;
const oldInput =
  qualificationMode === "remaining-qualification"
    ? (() => {
        try {
          return projectOldInlineInput(JSON.parse(process.env.BIBCODE_UPLOAD_OLD_INPUT ?? "null"));
        } catch {
          return null;
        }
      })()
    : null;
if (
  (qualificationMode === "remaining-qualification" && oldInput === null) ||
  (qualificationMode !== "remaining-qualification" && process.env.BIBCODE_UPLOAD_OLD_INPUT)
)
  throw new Error("The old inline input is invalid.");
if (qualificationMode !== "upload-matrix" && process.env.BIBCODE_UPLOAD_CASE)
  throw new Error("The upload matrix case is invalid.");

const root = NodePath.resolve(import.meta.dirname, "../../..");
const fixture = process.env.BIBCODE_UPLOAD_FIXTURE;
const evidence = process.env.BIBCODE_UPLOAD_EVIDENCE;
const binary = process.env.BIBCODE_UPLOAD_SERVER;
const chrome = process.env.BIBCODE_UPLOAD_CHROME;
const driver = process.env.BIBCODE_UPLOAD_DRIVER;
if (
  process.env.CI !== "true" ||
  !fixture ||
  !evidence ||
  !binary ||
  !chrome ||
  !driver ||
  NodeFS.readlinkSync("/proc/self/ns/net") !== process.env.BIBCODE_UPLOAD_NETNS
) {
  throw new Error(
    "This qualification requires its owned Linux CI namespace and prepared executables.",
  );
}
const fixtureRoot = fixture;
const evidenceRoot = evidence;
const serverBinary = binary;
const webOrigin = "http://localhost:4901";
const processes: Array<{
  child: NodeChildProcess.ChildProcess;
  done: Promise<void>;
  log: string;
  role: string;
  spawnFailure: ReturnType<typeof classifyQualificationFailure> | null;
}> = [];
const proxies: Array<Awaited<ReturnType<typeof startThrottleProxy>>> = [];
const inlineReceivers: Array<Awaited<ReturnType<typeof startInlineProbeReceiver>>> = [];
let currentPhase = "prepare";
const results: Array<Record<string, unknown>> = [];
const write = (name: string, value: unknown) =>
  NodeFS.writeFileSync(
    NodePath.join(evidenceRoot, name + ".json"),
    JSON.stringify(value, null, 2) + "\n",
    { mode: 0o600 },
  );
const phase = (name: string) => {
  currentPhase = name;
  write("phase", { phase: name });
};
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function bounded<A>(promise: Promise<A>, ms: number): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Owned operation exceeded its bound.")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function until(check: () => Promise<boolean>, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    for (const entry of processes)
      if (entry.child.exitCode !== null || entry.child.signalCode !== null) {
        throw new Error("An owned fixture process exited before qualification completed.");
      }
    await delay(100);
  }
  throw new Error("The required live observation did not arrive within its bound.");
}
function spawn(command: string, args: string[], env: NodeJS.ProcessEnv, name: string): void {
  const log = NodePath.join(fixtureRoot, name + ".log");
  const fd = NodeFS.openSync(log, "wx", 0o600);
  const child = NodeChildProcess.spawn(command, args, {
    cwd: root,
    env,
    stdio: ["ignore", fd, fd],
  });
  const entry = {
    child,
    log,
    role: name,
    spawnFailure: null as ReturnType<typeof classifyQualificationFailure> | null,
    done: Promise.resolve(),
  };
  entry.done = new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    child.once("error", (error) => {
      entry.spawnFailure = classifyQualificationFailure(error);
      resolve();
    });
  });
  processes.push(entry);
  NodeFS.closeSync(fd);
}
function prepareEnvironments() {
  const kinds = qualificationMode === "remaining-qualification" ? ["plain"] : ["plain", "noise"];
  return kinds.map((kind, index) => {
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      BIBCODE_E2E_RUN_ROOT: NodePath.join(fixtureRoot, kind),
      BIBCODE_E2E_ARTIFACT_DIR: NodePath.join(fixtureRoot, kind + "-private"),
      BIBCODE_E2E_PLATFORM: "linux",
    };
    const context = prepareDesktopUiTestContext(childEnv);
    const projectPath = NodePath.join(NodePath.dirname(context.projectPath), "Uploads " + kind);
    NodeFS.renameSync(context.projectPath, projectPath);
    childEnv.BIBCODE_E2E_PROJECT_PATH = projectPath;
    childEnv.BIBCODE_UPLOAD_RECEIPTS = NodePath.join(context.runRoot, "upload-receipts.jsonl");
    childEnv.PATH = context.shimDirectory + NodePath.delimiter + NodePath.join(fixtureRoot, "bin");
    childEnv.BIBCODE_E2E_SLOW_TURN_MS = "3600000";
    if (selectedMatrixCase?.action === "stop") childEnv.BIBCODE_E2E_DRIP_MODE = "chat-matrix";
    childEnv.CLAUDE_CONFIG_DIR = NodePath.join(context.fixtureUserHomePath, ".claude");
    childEnv.CODEX_HOME = NodePath.join(context.fixtureUserHomePath, ".codex");
    for (const [key, relative] of [
      ["XDG_CONFIG_HOME", "config"],
      ["XDG_DATA_HOME", "data"],
      ["XDG_CACHE_HOME", "cache"],
    ]) {
      const path = NodePath.join(context.runRoot, relative!);
      NodeFS.mkdirSync(path, { recursive: true, mode: 0o700 });
      childEnv[key!] = path;
    }
    delete childEnv.BIBCODE_HERMETIC_GUARD;
    const state = NodePath.join(context.stateRoot, "dev");
    NodeFS.mkdirSync(state, { recursive: true, mode: 0o700 });
    const providers = Object.fromEntries(
      ["codex", "claudeAgent", "cursor", "grok", "opencode"].map((name) => [
        name,
        {
          enabled: name === "codex",
          binaryPath:
            name === "codex"
              ? NodePath.join(context.shimDirectory, "codex")
              : NodePath.join(context.runRoot, "missing-provider"),
        },
      ]),
    );
    NodeFS.writeFileSync(
      NodePath.join(state, "settings.json"),
      JSON.stringify({
        enableProviderUpdateChecks: false,
        providers,
        providerInstances: {
          cursor: {
            driver: "cursor",
            enabled: false,
            config: { binaryPath: NodePath.join(context.runRoot, "missing-provider") },
          },
        },
      }),
    );
    instrumentCodexAttachmentLog(context.shimDirectory);
    return {
      kind,
      env: childEnv,
      context,
      projectPath,
      serverPort: index === 0 ? 4902 : 4910,
      proxyPort: index === 0 ? 4903 : 4911,
      receipts: childEnv.BIBCODE_UPLOAD_RECEIPTS!,
      route: "",
    };
  });
}
async function matrixImportProject(b: MatrixBrowser, projectPath: string): Promise<void> {
  await b.$('[data-testid="sidebar-add-project-trigger"]').waitForDisplayed();
  await b.$('[data-testid="sidebar-add-project-trigger"]').click();
  await b
    .$("//button[@data-add-project-action='true'][.//span[normalize-space()='Browse folder']]")
    .click();
  await until(
    async () =>
      (await b.$("#add-project-host-path").isDisplayed()) ||
      (await b.$("button=Type a path instead").isDisplayed()),
  );
  if (!(await b.$("#add-project-host-path").isExisting()))
    await b.$("button=Type a path instead").click();
  await b.$("#add-project-host-path").setValue(projectPath);
  await b.$("button=Open project").click();
  await b.$(matrixEditor).waitForDisplayed();
}

async function runMatrix(
  b: MatrixBrowser,
  selection: ChatMatrixCase,
  environments: ReturnType<typeof prepareEnvironments>,
): Promise<void> {
  const targetIndex = selection.transport === "plain" ? 0 : 1;
  const target = environments[targetIndex]!;
  const proxy = proxies[targetIndex]!;
  phase("matrix-public-settings");
  await b.$('[data-testid="environment-rail-manage"]').click();
  await b.$("button=General").waitForDisplayed();
  await b.$("button=General").click();
  await b.$('[aria-label="Theme preference"]').click();
  await b
    .$(
      `//*[@role="option" and normalize-space()="${selection.theme === "light" ? "Light" : "Dark"}"]`,
    )
    .click();
  await until(async () =>
    b.execute(
      (dark) => document.documentElement.classList.contains("dark") === dark,
      selection.theme === "dark",
    ),
  );
  let pinnedNoisePathObserved = false;
  if (selection.transport === "noise") {
    phase("matrix-noise-cli");
    const offerOutput = NodeChildProcess.execFileSync(
      serverBinary,
      [
        "pairing",
        "offer",
        "--base-dir",
        target.context.stateRoot,
        "--dev-url",
        webOrigin,
        "--endpoint",
        "http://127.0.0.1:4911",
        "--reach",
        "this-computer",
        "--name",
        "QA Upload Noise",
        "--json",
      ],
      { env: target.env, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] },
    );
    phase("matrix-noise-json");
    const issued = JSON.parse(offerOutput) as { link?: unknown };
    phase("matrix-noise-link");
    if (typeof issued.link !== "string" || !issued.link.startsWith("bibcode://pair?"))
      throw new Error("Matrix evidence assertion failed.");
    phase("matrix-noise-payload");
    const code = new URL(issued.link).searchParams.get("code");
    const payload = code
      ? (JSON.parse(Buffer.from(code, "base64url").toString("utf8")) as {
          hostKey?: unknown;
          endpoint?: unknown;
        })
      : null;
    phase("matrix-noise-identity");
    const offeredEndpoint =
      typeof payload?.endpoint === "string" ? new URL(payload.endpoint) : null;
    if (
      typeof payload?.hostKey !== "string" ||
      payload.hostKey.length !== 43 ||
      offeredEndpoint?.origin !== "http://127.0.0.1:4911" ||
      offeredEndpoint.pathname !== "/" ||
      offeredEndpoint.search !== "" ||
      offeredEndpoint.hash !== ""
    )
      throw new Error("Matrix evidence assertion failed.");
    phase("matrix-noise-settings");
    await b.$("button=Remote Servers").click();
    phase("matrix-noise-trigger-ready");
    await b.$('button[aria-label="Add Server"]').waitForDisplayed();
    phase("matrix-noise-trigger");
    await b.$('button[aria-label="Add Server"]').click();
    const dialog = '[role="dialog"]';
    phase("matrix-noise-alias");
    await b.$(`${dialog} input[placeholder="e.g. Linux workstation"]`).setValue("QA Upload Noise");
    phase("matrix-noise-code");
    await b.$(`${dialog} textarea[placeholder="bibcode://pair?code=…"]`).setValue(issued.link);
    phase("matrix-noise-acknowledgement");
    const acknowledgement = b.$(`${dialog} [role="checkbox"]`);
    if (await acknowledgement.isDisplayed().catch(() => false)) {
      // This fixture owns the actual bidirectional TCP forwarder into this same private namespace.
      phase("matrix-noise-acknowledgement-click");
      if (proxy.port !== 4911) throw new Error("Matrix evidence assertion failed.");
      await acknowledgement.click();
    }
    phase("matrix-noise-connect");
    await b.$('//*[@role="dialog"]//button[normalize-space()="Add Server"]').click();
    phase("matrix-noise-dialog-closed");
    await b.$(dialog).waitForDisplayed({ reverse: true });
    phase("matrix-noise-environment");
    await b.$('[role="radio"][aria-label="QA Upload Noise"]').click();
    phase("matrix-noise-environment-selected");
    await until(
      async () =>
        (await b.$('[role="radio"][aria-label="QA Upload Noise"]').getAttribute("aria-checked")) ===
        "true",
    );
  }
  if (
    await b
      .$("button=Back")
      .isDisplayed()
      .catch(() => false)
  )
    await b.$("button=Back").click();
  if (selection.transport === "noise") await matrixImportProject(b, target.projectPath);
  await b.$(matrixEditor).waitForDisplayed();
  const observe = async () => {
    const observed = projectChatUploadObservation(
      await bounded(
        b.execute(() => {
          const observer = Reflect.get(window, "__uploadObservations") as
            | { read?: () => unknown }
            | undefined;
          return observer?.read?.() ?? null;
        }),
        5000,
      ),
    );
    if (observed === null) throw new Error("Matrix evidence assertion failed.");
    return observed;
  };
  if (selection.transport === "noise") {
    await until(async () => (await observe()).noise.opened > 0);
    pinnedNoisePathObserved = true;
  }
  proxy.update({ up: selection.upBytesPerSecond, down: 0, frozen: false });
  const beforeMatrixObservation = await observe();
  const beforeMatrixWireBytes = proxy.measurements().up.receivedBytes;
  const pngPath = NodePath.join(fixtureRoot, "upload-matrix.png");
  const png = createSizedPng(10 * 1024 ** 2, "matrix");
  NodeFS.writeFileSync(pngPath, png);
  const digest = NodeCrypto.createHash("sha256").update(png).digest("hex");
  const readUi = () =>
    bounded(
      b.execute(readChatMatrixDom, { outgoing: "upload-matrix", newer: "upload-newer-draft" }),
      5000,
    );
  const send = async (prompt: string) => {
    await b.$(matrixEditor).click();
    await b.$(matrixEditor).addValue(prompt);
    await b.keys("Enter");
  };
  const receipt = async () => {
    if (!NodeFS.existsSync(target.receipts)) return { count: 0, matched: false };
    if (NodeFS.statSync(target.receipts).size > 65536)
      throw new Error("Matrix evidence assertion failed.");
    const matches = NodeFS.readFileSync(target.receipts, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.prompt === "upload-matrix");
    const item = matches[0];
    return {
      count: matches.length,
      matched:
        matches.length === 1 &&
        item.attachments.length === 1 &&
        item.attachments[0].bytes === png.length &&
        item.attachments[0].sha256 === digest,
    };
  };
  const result = await runChatMatrixCase(selection, {
    phase,
    until,
    observe,
    measurements: () => proxy.measurements(),
    clock: () =>
      bounded(
        b.execute(() => performance.now()),
        5000,
      ),
    freeze: (value) => {
      proxy.update({ frozen: value });
    },
    readUi,
    receipt,
    stageAndSend: async () => {
      const input = await b.$('[data-center-surface-host][data-visible="true"] input[type="file"]');
      await input.waitForEnabled();
      await b.elementSendKeys(await input.elementId, pngPath);
      await until(async () => (await readUi()).validPreview);
      await send("upload-matrix");
    },
    editNewer: async () => {
      await b.$(matrixEditor).click();
      await b.$(matrixEditor).addValue("upload-newer-draft");
    },
    startStream: () => send("upload-stream [[slow]] [[drip]]"),
    stopGeneration: async () => {
      await b.$('button[aria-label="Stop generation"]').click();
    },
    activateCancel: () =>
      activateMatrixCancel(
        b,
        selection.action as "cancel-pointer" | "cancel-enter" | "cancel-space",
      ),
    capture: async (name) => {
      const current = await readUi();
      if (
        name === "matrix-cancel-restored.png" &&
        !(
          current.validPreview &&
          current.restoredOutgoing &&
          current.newerPreserved &&
          !current.error
        )
      )
        throw new Error("Matrix evidence assertion failed.");
      if (
        name === "matrix-result.png" &&
        !(
          current.deliveredImage &&
          current.progressUnits === null &&
          !current.reconnecting &&
          !current.error &&
          !current.stopAvailable
        )
      )
        throw new Error("Matrix evidence assertion failed.");
      if (
        name === "matrix-progress.png" ||
        name === "matrix-reconnecting.png" ||
        name === "matrix-stream-stop.png"
      ) {
        await b.$('//button[normalize-space()="Cancel" and ../p[@role="status"]]').scrollIntoView();
      } else if (name === "matrix-result.png") {
        const images = await b
          .$$('[data-center-surface-host][data-visible="true"] [data-message-role="user"] img')
          .getElements();
        if (images.length === 0) throw new Error("Matrix evidence assertion failed.");
        await images.at(-1)!.scrollIntoView();
      }
      const safe = await bounded(
        b.execute(qualificationScreenSafe, { origin: webOrigin, dark: selection.theme === "dark" }),
        5000,
      );
      if (!safe) throw new Error("Matrix evidence assertion failed.");
      await b.saveScreenshot(NodePath.join(evidenceRoot, name));
    },
  });
  if (selection.transport === "noise") {
    const afterMatrixObservation = await observe();
    if (
      afterMatrixObservation.plain.requests.begin !==
        beforeMatrixObservation.plain.requests.begin ||
      proxy.measurements().up.receivedBytes <= beforeMatrixWireBytes
    )
      throw new Error("Matrix evidence assertion failed.");
  }
  results.push({
    ...result,
    pinnedNoisePathObserved,
    providerBytes: selection.action.startsWith("cancel") ? null : png.length,
    providerDigest: selection.action.startsWith("cancel") ? null : digest,
  });
  phase("matrix-case-complete");
}

async function runRemaining(
  b: MatrixBrowser,
  plain: ReturnType<typeof prepareEnvironments>[number],
  proof: BrowserNetworkProof,
): Promise<void> {
  if (!oldInput) throw new Error("Remaining qualification evidence refused.");
  const png = createSizedPng(10 * 1024 ** 2, "inline-fallback");
  const pngPath = NodePath.join(fixtureRoot, "upload-inline-fallback.png");
  NodeFS.writeFileSync(pngPath, png, { mode: 0o600 });
  const digest = NodeCrypto.createHash("sha256").update(png).digest("hex");
  const readUi = () =>
    bounded(
      b.execute(readChatMatrixDom, {
        outgoing: "upload-inline-fallback",
        newer: "unused-newer-draft",
      }),
      5000,
    );
  const observe = async () => {
    const observed = projectInlineFallbackObservation(
      await bounded(
        b.execute(() => {
          const observer = Reflect.get(window, "__inlineFallbackObservations") as
            | { read?: () => unknown }
            | undefined;
          return observer?.read?.() ?? null;
        }),
        5000,
      ),
    );
    if (!observed) throw new Error("Remaining qualification evidence refused.");
    return observed;
  };
  const capability = async () => {
    const observed = projectChatUploadObservation(
      await bounded(
        b.execute(() => {
          const observer = Reflect.get(window, "__uploadObservations") as
            | { read?: () => unknown }
            | undefined;
          return observer?.read?.() ?? null;
        }),
        5000,
      ),
    );
    return observed?.plain.capability ?? null;
  };
  const receipt = async () => {
    if (!NodeFS.existsSync(plain.receipts)) return { count: 0, matched: false };
    if (NodeFS.statSync(plain.receipts).size > 65536)
      throw new Error("Remaining qualification evidence refused.");
    const entries = NodeFS.readFileSync(plain.receipts, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.prompt === "upload-inline-fallback");
    return {
      count: entries.length,
      matched:
        entries.length === 1 &&
        entries[0].attachments.length === 1 &&
        entries[0].attachments[0].bytes === png.length &&
        entries[0].attachments[0].sha256 === digest,
    };
  };
  const result = await runRemainingQualification({
    until,
    capability,
    inline: observe,
    receipt,
    sendImage: async () => {
      phase("remaining-inline-image");
      const input = b.$('[data-center-surface-host][data-visible="true"] input[type="file"]');
      await input.waitForEnabled();
      await b.elementSendKeys(await input.elementId, pngPath);
      await until(async () => (await readUi()).validPreview);
      await b.$(matrixEditor).click();
      await b.$(matrixEditor).addValue("upload-inline-fallback");
      await b.keys("Enter");
    },
    ui: async () => {
      const ui = await readUi();
      const extra = await bounded(
        b.execute(() => {
          const view = document.querySelector('[data-center-surface-host][data-visible="true"]');
          const input = view?.querySelector('input[type="file"]');
          return {
            uploadNotice: Array.from(view?.querySelectorAll('p[role="status"]') ?? []).some(
              (node) =>
                node.parentElement?.querySelector("button")?.textContent?.trim() === "Cancel",
            ),
            composerUsable: input instanceof HTMLInputElement && !input.disabled,
          };
        }),
        5000,
      );
      return { deliveredImage: ui.deliveredImage, error: ui.error, ...extra };
    },
    captureTheme: async (theme) => {
      phase("remaining-inline-" + theme);
      await b.$('[data-testid="environment-rail-manage"]').click();
      await b.$("button=General").waitForDisplayed();
      await b.$("button=General").click();
      await b.$('[aria-label="Theme preference"]').click();
      await b
        .$(`//*[@role="option" and normalize-space()="${theme === "light" ? "Light" : "Dark"}"]`)
        .click();
      if (
        await b
          .$("button=Back")
          .isDisplayed()
          .catch(() => false)
      )
        await b.$("button=Back").click();
      await b.$(matrixEditor).waitForDisplayed();
      await until(async () =>
        b.execute(
          (dark) => document.documentElement.classList.contains("dark") === dark,
          theme === "dark",
        ),
      );
      if (
        !(await readUi()).deliveredImage ||
        !(await bounded(
          b.execute(qualificationScreenSafe, { origin: webOrigin, dark: theme === "dark" }),
          5000,
        ))
      )
        throw new Error("Remaining qualification evidence refused.");
      await b.saveScreenshot(NodePath.join(evidenceRoot, "inline-fallback-" + theme + ".png"));
    },
    transport: async (action: BrowserInlineAction) => {
      phase("remaining-" + action);
      const receiver = await startInlineProbeReceiver(action, proof);
      inlineReceivers.push(receiver);
      const proxy = await startThrottleProxy({
        listenHost: "127.0.0.1",
        listenPort: 4917,
        targetHost: "127.0.0.1",
        targetPort: 4916,
      });
      proxies.push(proxy);
      proxy.update({ up: 16384, down: 0, frozen: false });
      await b.url("http://127.0.0.1:4916/");
      await bounded(
        b.execute((selected) => {
          const observer = Reflect.get(window, "__inlineMechanics") as
            | { start?: (action: string) => void }
            | undefined;
          if (!observer?.start) throw new Error("Inline probe unavailable.");
          observer.start(selected);
        }, action),
        5000,
      );
      let browserObservation: ReturnType<typeof projectBrowserInlineObservation> = null;
      await until(async () => {
        const raw = await bounded(
          b.execute(() => {
            const observer = Reflect.get(window, "__inlineMechanics") as
              | { read?: () => unknown }
              | undefined;
            return observer?.read?.() ?? null;
          }),
          5000,
        );
        if (raw === null) return false;
        browserObservation = projectBrowserInlineObservation(raw);
        if (!browserObservation) throw new Error("Remaining qualification evidence refused.");
        return true;
      }, 250000);
      await until(async () => receiver.read().closeFrameReceived, 5000);
      await bounded(proxy.close(), 5000);
      await bounded(receiver.close(), 5000);
      const native = receiver.read();
      if (
        !native.upgraded ||
        native.upgradeCount !== 1 ||
        native.messageDigest !== native.expectedDigest ||
        native.expectedBytes !== 3145728 ||
        !native.complete ||
        !browserObservation
      )
        throw new Error("Remaining qualification evidence refused.");
      return { browser: browserObservation, native, ownedCleanupJoined: true };
    },
  });
  results.push({ ...result, oldInput, providerBytes: png.length, providerDigest: digest });
  phase("remaining-qualification-complete");
}

const webEnv = {
  ...process.env,
  PORT: "4901",
  HOST: "127.0.0.1",
  VITE_DEV_SERVER_URL: webOrigin,
  BIBCODE_PORT: "4903",
  VITE_HTTP_URL: "http://localhost:4903",
  VITE_WS_URL: "ws://localhost:4903",
};

const observationScript =
  browserStartupObservationScript +
  chatUploadObservationScript +
  (qualificationMode === "remaining-qualification"
    ? inlineFallbackObservationScript + browserInlineMechanicsScript
    : "");

let browser: Awaited<ReturnType<typeof remote>> | undefined;
let networkProof: BrowserNetworkProof | null = null;
let onlineAfterPairFailure: boolean | null = null;
let pairingCompleted = false;
let credentialEntryAttempted = false;
let pairingObservation: ReturnType<typeof projectPairingObservation> | null = null;
let startupObservation: ReturnType<typeof projectBrowserStartupObservation> | null = null;
let startupNetworkObservation: ReturnType<typeof projectStartupNetworkLogs> | null = null;
let success = false;
const cleanupFailures: Array<{
  role: string;
  failure: ReturnType<typeof classifyQualificationFailure>;
}> = [];
let beforeCleanup: ReturnType<typeof projectQualificationProcess>[] = [];
try {
  const networkStartedAt = performance.now();
  phase("prepare-contained-network");
  networkProof = await prepareNetworkBeforeBrowser({
    now: () => performance.now(),
    setup: () =>
      new Promise((resolve, reject) => {
        const python = process.env.BIBCODE_UPLOAD_PYTHON;
        const helper = process.env.BIBCODE_UPLOAD_NETWORK_HELPER;
        if (
          !python ||
          !NodePath.isAbsolute(python) ||
          helper !== NodePath.join(root, "scripts/qualify-chat-uploads.py")
        ) {
          reject(
            new NetworkSetupFailure({
              stage: "helper-config",
              attemptedMutations: 0,
              completedMutations: 0,
              netAdminEffective: null,
              lastCommand: null,
            }),
          );
          return;
        }
        // execFile joins the short-lived helper; PID1 retains authority over all command descendants.
        NodeChildProcess.execFile(
          python,
          [helper, "network"],
          {
            env: process.env,
            timeout: 30_000,
            killSignal: "SIGTERM",
            maxBuffer: 4096,
            encoding: "utf8",
          },
          (error, stdout) => {
            try {
              resolve(readNetworkCommandResult(error !== null, stdout));
            } catch (failure) {
              reject(failure);
            }
          },
        );
      }),
  });
  const environments = prepareEnvironments();
  phase("start-owned-servers");
  for (const environment of environments) {
    spawn(
      serverBinary,
      [
        "serve",
        "--mode",
        "web",
        "--host",
        "127.0.0.1",
        "--port",
        String(environment.serverPort),
        "--base-dir",
        environment.context.stateRoot,
        "--dev-url",
        webOrigin,
        "--no-browser",
        "--no-startup-pairing-offer",
      ],
      environment.env,
      environment.kind,
    );
    await until(async () => {
      try {
        return (
          await fetch(
            "http://127.0.0.1:" +
              environment.serverPort +
              EnvironmentMetadataHttpApi.endpoints.descriptor.path,
            {
              signal: AbortSignal.timeout(1000),
            },
          )
        ).ok;
      } catch {
        return false;
      }
    });
    proxies.push(
      await startThrottleProxy({
        listenHost: "127.0.0.1",
        listenPort: environment.proxyPort,
        targetHost: "127.0.0.1",
        targetPort: environment.serverPort,
      }),
    );
  }
  phase("start-web");
  spawn(
    process.execPath,
    [
      NodePath.join(root, "scripts/run-local-vp.mjs"),
      "dev",
      "--config",
      "apps/web/vite.config.app.mjs",
      "apps/web",
      "--host",
      "127.0.0.1",
      "--port",
      "4901",
      "--strictPort",
    ],
    webEnv,
    "web",
  );
  await until(async () => {
    try {
      return (await fetch(webOrigin, { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      return false;
    }
  });
  phase("start-browser-driver");
  // Own the driver before session creation so a failed handshake cannot leave
  // its process outside the harness's joined cleanup.
  spawn(
    driver,
    ["--port=4915", "--allowed-ips=127.0.0.1", "--allowed-origins=" + webOrigin],
    process.env,
    "driver",
  );
  await until(async () => {
    try {
      const response = await fetch("http://127.0.0.1:4915/status", {
        signal: AbortSignal.timeout(1000),
      });
      if (!response.ok) return false;
      const status = (await response.json()) as { value?: { ready?: boolean } };
      return status.value?.ready === true;
    } catch {
      return false;
    }
  });
  phase("launch-browser");
  browser = await bounded(
    remote({
      hostname: "127.0.0.1",
      port: 4915,
      path: "/",
      logLevel: "silent",
      connectionRetryCount: 0,
      connectionRetryTimeout: 30_000,
      waitforTimeout: 30_000,
      // WDIO 9's explicit length is rejected by Node 26's dispatcher adapter.
      // Let fetch compute the length from the unchanged request body.
      transformRequest: (options) => {
        const headers = new Headers(options.headers);
        headers.delete("Content-Length");
        return { ...options, headers };
      },
      capabilities: {
        browserName: "chrome",
        webSocketUrl: false,
        "wdio:enforceWebDriverClassic": true,
        ...(qualificationMode === "startup-only"
          ? { "goog:loggingPrefs": { performance: "ALL" } }
          : {}),
        "goog:chromeOptions": {
          binary: chrome,
          ...(qualificationMode === "startup-only"
            ? { perfLoggingPrefs: { enableNetwork: true, enablePage: false } }
            : {}),
          args: [
            "--headless=new",
            "--disable-dev-shm-usage",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-background-networking",
            "--disable-component-update",
            "--window-size=1280,960",
            "--user-data-dir=" + NodePath.join(fixtureRoot, "browser-profile"),
          ],
        },
      },
    }),
    45_000,
  );
  const b = browser;
  phase("install-browser-observer");
  await b.sendCommandAndGetResult("Page.addScriptToEvaluateOnNewDocument", {
    source: observationScript,
  });
  phase("observe-browser-connectivity");
  networkProof = await verifyPreparedBrowserOnline(networkProof, {
    readOnline: () =>
      bounded(
        b.execute(() => navigator.onLine),
        2_000,
      ),
    now: () => performance.now(),
    startedAt: networkStartedAt,
  });
  const plain = environments[0]!;
  if (qualificationMode === "startup-only") {
    phase("startup-only-probe");
    const probe = await runCredentialFreeStartupProbe({
      readPerformanceLogs: () => bounded(b.getLogs("performance"), 2_000),
      navigate: async () => {
        phase("pair-navigate");
        await b.url(webOrigin + "/pair");
      },
      waitForPairingControl: async () => {
        phase("pair-wait-token");
        await b.$("#pairing-token").waitForDisplayed();
      },
    });
    startupNetworkObservation = probe.network;
    try {
      startupObservation = projectBrowserStartupObservation(
        await bounded(
          b.execute(() => {
            const observer = Reflect.get(window, "__browserStartupObservation") as
              | { read?: () => unknown }
              | undefined;
            return observer?.read?.() ?? null;
          }),
          2_000,
        ),
      );
    } catch {
      /* Unknown observation cannot lead to credential entry. */
    }
    if (!probe.reachedPairingControl || !probe.network.available)
      throw new Error("The credential-free startup probe did not reach observable readiness.");
    phase("startup-only-complete");
    success = true;
  } else {
    phase("pair-issue-token");
    const credential = JSON.parse(
      NodeChildProcess.execFileSync(
        serverBinary,
        [
          "pairing",
          "issue",
          "--base-dir",
          plain.context.stateRoot,
          "--dev-url",
          webOrigin,
          "--json",
        ],
        { env: plain.env, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] },
      ),
    ).credential;
    if (typeof credential !== "string" || credential.length < 8)
      throw new Error("Owned pairing command returned no credential.");
    phase("pair-navigate");
    await b.url(webOrigin + "/pair");
    phase("pair-wait-token");
    await b.$("#pairing-token").waitForDisplayed();
    phase("pair-fill-token");
    credentialEntryAttempted = true;
    await b.$("#pairing-token").setValue(credential);
    phase("pair-submit");
    await b.$("button=Continue").click();
    phase("pair-wait-sidebar");
    await b.$('[data-testid="sidebar-add-project-trigger"]').waitForDisplayed();
    pairingCompleted = true;

    phase("wait-primary-connected");
    await b
      .$('[data-testid="environment-rail-local"] [data-status="connected"]')
      .waitForDisplayed();
    phase("open-project-menu");
    await b.$('[data-testid="sidebar-add-project-trigger"]').click();
    phase("choose-project-browse");
    const browseFolder = b.$(
      "//button[@data-add-project-action='true'][.//span[normalize-space()='Browse folder']]",
    );
    await browseFolder.waitForDisplayed();
    await browseFolder.click();
    phase("choose-project-path-entry");
    await until(
      async () =>
        (await b.$("#add-project-host-path").isDisplayed()) ||
        (await b.$("button=Type a path instead").isDisplayed()),
    );
    if (!(await b.$("#add-project-host-path").isExisting())) {
      await b.$("button=Type a path instead").waitForDisplayed();
      await b.$("button=Type a path instead").click();
    }
    phase("submit-project-path");
    await b.$("#add-project-host-path").waitForDisplayed();
    await b.$("#add-project-host-path").setValue(plain.projectPath);
    await b.$("button=Open project").click();
    phase("wait-project-composer");
    const editorSelector =
      '[data-center-surface-host][data-visible="true"] [data-testid="composer-editor"]';
    await b.$(editorSelector).waitForDisplayed();
    plain.route = await b.getUrl();

    if (qualificationMode === "remaining-qualification") {
      await runRemaining(b, plain, networkProof);
      success = true;
    } else if (selectedMatrixCase) {
      await runMatrix(b, selectedMatrixCase, environments);
      success = true;
    } else {
      const pngPath = NodePath.join(fixtureRoot, "upload-smoke.png");
      const png = createSizedPng(STAGED_SMOKE_IMAGE_BYTES, "smoke");
      NodeFS.writeFileSync(pngPath, png);
      const digest = NodeCrypto.createHash("sha256").update(png).digest("hex");
      phase("wait-composer-file-enabled");
      const input = await b.$('[data-center-surface-host][data-visible="true"] input[type="file"]');
      await input.waitForEnabled();
      phase("select-composer-file");
      // The real input is hidden. Send the file through WebDriver's native upload command;
      // setValue first sends Element Clear, which requires an interactable control.
      await b.elementSendKeys(await input.elementId, pngPath);
      phase("wait-composer-image-preview");
      await until(async () =>
        b.execute(() =>
          Array.from(document.querySelectorAll('[data-chat-composer-form="true"] img')).some(
            (element) =>
              element instanceof HTMLImageElement &&
              element.complete &&
              element.naturalWidth === 1 &&
              element.naturalHeight === 1,
          ),
        ),
      );
      phase("enter-composer-message");
      await b.$(editorSelector).click();
      await b.$(editorSelector).addValue("upload-smoke");
      phase("send-composer-message");
      await b.keys("Enter");
      phase("wait-provider-attachment");
      await until(
        async () =>
          NodeFS.existsSync(plain.receipts) &&
          NodeFS.readFileSync(plain.receipts, "utf8").includes('"prompt":"upload-smoke"'),
      );
      phase("verify-provider-attachment");
      const receipts = NodeFS.readFileSync(plain.receipts, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const received = receipts.find((entry) => entry.prompt === "upload-smoke");
      if (
        received.attachments.length !== 1 ||
        received.attachments[0].bytes !== png.length ||
        received.attachments[0].sha256 !== digest
      ) {
        throw new Error("The provider did not receive the exact composer attachment.");
      }
      const observations = projectChatUploadObservation(
        await b.execute(() => {
          const observer = Reflect.get(window, "__uploadObservations") as
            | { read?: () => unknown }
            | undefined;
          return observer?.read?.() ?? null;
        }),
      );
      if (observations === null || observations.plain.requests.begin === 0) {
        throw new Error("The actual browser did not exercise staged uploads.");
      }
      await b.saveScreenshot(NodePath.join(evidenceRoot, "plain-smoke.png"));
      results.push({
        scenario: "plain-staged-image-512kib",
        providerBytes: png.length,
        providerDigest: digest,
        observations,
      });
      phase("smoke-complete");
      success = true;
    }
  }
} catch (error) {
  if (error instanceof BrowserConnectivityFailure) networkProof = error.proof;
  if (browser && currentPhase.startsWith("pair-")) {
    try {
      const observed: unknown = await bounded(
        browser.execute(
          (includeStartup: boolean) => {
            const token = document.getElementById("pairing-token");
            const form = token?.closest("form");
            const submit = form?.querySelector('button[type="submit"]');
            const transport = Reflect.get(window, "__uploadObservations") as
              | {
                  read?: () => {
                    available?: boolean;
                    plain?: { created?: number; opened?: number };
                  };
                }
              | undefined;
            let observedTransport: ReturnType<
              NonNullable<NonNullable<typeof transport>["read"]>
            > | null = null;
            try {
              observedTransport = transport?.read?.() ?? null;
            } catch {
              /* Missing evidence stays unknown. */
            }
            let startup: unknown = null;
            if (includeStartup) {
              try {
                const observer = Reflect.get(window, "__browserStartupObservation") as
                  | { read?: () => unknown }
                  | undefined;
                startup = observer?.read?.() ?? null;
              } catch {
                /* The existing pairing receipt remains available. */
              }
            }
            return {
              startup,
              route:
                location.pathname === "/pair"
                  ? "pair"
                  : location.pathname === "/"
                    ? "root"
                    : location.pathname.startsWith("/local/")
                      ? "local-project"
                      : "other",
              readyState: document.readyState,
              tokenInputPresent: token instanceof HTMLInputElement,
              tokenInputDisabled: token instanceof HTMLInputElement ? token.disabled : null,
              submitPresent: submit instanceof HTMLButtonElement,
              submitDisabled: submit instanceof HTMLButtonElement ? submit.disabled : null,
              errorNoticePresent: form?.querySelector(".text-destructive") !== null && form != null,
              pendingHeadingPresent: Array.from(document.querySelectorAll("h1")).some(
                (heading) => heading.textContent?.trim() === "Pairing with this environment",
              ),
              sidebarPresent:
                document.querySelector('[data-testid="sidebar-add-project-trigger"]') !== null,
              observerPresent: observedTransport?.available === true,
              plainSocketCreated: observedTransport?.plain?.created ?? null,
              plainSocketOpened: observedTransport?.plain?.opened ?? null,
            };
          },
          currentPhase === "pair-wait-token" && credentialEntryAttempted === false,
        ),
        2_000,
      );
      pairingObservation = projectPairingObservation(observed);
      if (currentPhase === "pair-wait-token" && credentialEntryAttempted === false) {
        startupObservation = projectBrowserStartupObservation(
          typeof observed === "object" && observed !== null && "startup" in observed
            ? observed.startup
            : null,
        );
      }
    } catch {
      /* Missing diagnostics remain unknown and cannot interrupt owned cleanup. */
    }
  }
  if (browser && pairingCompleted) {
    try {
      const value: unknown = await bounded(
        browser.execute(() => navigator.onLine),
        2_000,
      );
      onlineAfterPairFailure = typeof value === "boolean" ? value : null;
    } catch {
      /* Diagnostic reads cannot bypass cleanup. */
    }
  }
  write("failure", {
    phase: currentPhase,
    failure: classifyQualificationFailure(error),
    networkProof,
    onlineAfterPairFailure,
    pairingObservation,
    startupObservation,
    startupNetworkObservation,
    qualificationMode,
  });
  // Retain passive transport observations after a completed pairing.
  if (browser && pairingCompleted) {
    try {
      const observations = projectChatUploadObservation(
        await bounded(
          browser.execute(() => {
            const observer = Reflect.get(window, "__uploadObservations") as
              | { read?: () => unknown }
              | undefined;
            return observer?.read?.() ?? null;
          }),
          5_000,
        ),
      );
      write("failure", {
        phase: currentPhase,
        failure: classifyQualificationFailure(error),
        observations,
        networkProof,
        onlineAfterPairFailure,
        pairingObservation,
        startupObservation,
        startupNetworkObservation,
        qualificationMode,
      });
    } catch {
      // Diagnostic capture cannot skip the owned process cleanup below.
    }
  }
  // Before pairing, only the wait preceding any credential entry is eligible.
  // A failed/partial entry remains ineligible even if the form subsequently disappears.
  if (
    browser &&
    mayCaptureQualificationFailure({
      phase: currentPhase,
      credentialEntryAttempted,
      pairingCompleted,
      screenSafe: true,
    })
  ) {
    try {
      const safe = await bounded(
        browser.execute(qualificationScreenSafe, { origin: webOrigin, dark: null }),
        5_000,
      );
      if (
        mayCaptureQualificationFailure({
          phase: currentPhase,
          credentialEntryAttempted,
          pairingCompleted,
          screenSafe: safe === true,
        })
      )
        await bounded(
          browser.saveScreenshot(
            NodePath.join(
              evidenceRoot,
              pairingCompleted ? "failure-after-pair.png" : "failure-before-credential.png",
            ),
          ),
          5_000,
        );
    } catch {
      // Diagnostic capture cannot skip the owned process cleanup below.
    }
  }
} finally {
  beforeCleanup = processes.map(({ child, log, role, spawnFailure }) =>
    projectQualificationProcess({
      role,
      log,
      spawnFailure,
      exitCode: child.exitCode,
      signal: child.signalCode,
    }),
  );
  const cleanup = async (role: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (error) {
      success = false;
      cleanupFailures.push({ role, failure: classifyQualificationFailure(error) });
    }
  };
  if (browser)
    await cleanup("browser", () =>
      bounded(
        browser!.deleteSession().then(() => undefined),
        15_000,
      ),
    );
  for (const proxy of proxies) await cleanup("proxy", () => bounded(proxy.close(), 5_000));
  for (const receiver of inlineReceivers)
    await cleanup("inline-receiver", () => bounded(receiver.close(), 5_000));
  for (const { child, done, role } of processes.toReversed()) {
    await cleanup(role, async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await bounded(done, 5_000).catch(async () => {
        child.kill("SIGKILL");
        await bounded(done, 5_000);
      });
    });
  }
  write("result", {
    success: success && qualificationMode !== "startup-only",
    matrixCase: selectedMatrixCase?.case ?? null,
    fullMatrixComplete: false,
    qualificationMode,
    startupProbePassed: qualificationMode === "startup-only" ? success : null,
    phase: currentPhase,
    source: process.env.BIBCODE_UPLOAD_SOURCE,
    oldInput,
    results,
    networkProof,
    onlineAfterPairFailure,
    pairingObservation,
    startupObservation,
    startupNetworkObservation,
    beforeCleanup,
    cleanupFailures,
    scope:
      qualificationMode === "startup-only"
        ? "Credential-free startup-only observation; no pairing grant, project import or upload qualification."
        : qualificationMode === "remaining-qualification"
          ? "Actual immutable old-source inline fallback and plain Chromium native transport probes; WebKitGTK not measured."
          : qualificationMode === "upload-matrix"
            ? "One selected Chromium upload matrix case; retention, fallback, max batch, admission/remount, heartbeat and WebKitGTK remain unmeasured."
            : "Chromium staged-upload smoke only; full slow-link matrix and WebKitGTK remain unmeasured.",
    childProcessesClosed: processes.every(
      ({ child }) => child.exitCode !== null || child.signalCode !== null,
    ),
  });
}
process.exitCode = success ? 0 : 1;
