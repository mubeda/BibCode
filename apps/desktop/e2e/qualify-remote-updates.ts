// @effect-diagnostics nodeBuiltinImport:off - Disposable CI qualifier owns all paths/processes.
// @effect-diagnostics globalFetch:off - Only owned loopback descriptors are read.
// @effect-diagnostics globalTimers:off - Live qualification uses real bounded waits.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeNet from "node:net";
import { startThrottleProxy } from "../../../scripts/throttle-proxy.ts";
import {
  EnvironmentMetadataHttpApi,
  EnvironmentOrchestrationHttpApi,
} from "../../../packages/contracts/src/environmentHttp.ts";
import { REMOTE_UPDATE_RESTART_BUDGET_MS } from "../../../packages/client-runtime/src/state/remoteUpdateCoordinator.ts";
import type { TerminalOpenInput } from "../../../packages/contracts/src/terminal.ts";
import {
  QualificationOwner,
  bounded,
  delay,
  openOwnedBrowser,
  prepareOwnedNetwork,
  verifyOwnedBrowserOnline,
  type QualificationBrowser,
  type QualificationProcess,
} from "./support/qualification-owner.ts";
import { prepareDesktopUiTestContext } from "./support/test-project.ts";
import {
  classifyQualificationFailure,
  projectQualificationProcess,
} from "./support/chat-upload-evidence.ts";
import { BrowserConnectivityFailure } from "./support/browser-network.ts";
import {
  browserStartupObservationScript,
  projectBrowserStartupObservation,
} from "./support/browser-startup.ts";
import {
  remoteUiThemes,
  remoteUiPlan,
  screenshotName,
  validateCaptureWitness,
  inspectScreenshot,
  countInstallRequests,
  projectRemoteUiSetupObservation,
  projectRemoteUiCheckAgainObservation,
  projectRemoteUiSuccessRemovalObservation,
  projectRemoteUiToastErrorSignature,
  type RemoteUiToastErrorSignature,
  type RemoteUiTheme,
  type RemoteUiScene,
} from "./support/remote-ui-evidence.ts";
import { callFixtureRpc } from "./support/remote-ui-rpc.ts";
import {
  decodeReloadPrimaryWorkspace,
  decodeReloadPrimaryThreadProof,
  projectReloadPrimaryThreadWitness,
  readReloadPrimaryThread,
  readReloadPrimaryWorkspace,
  type ReloadPrimaryWorkspace,
  type ReloadPrimaryThreadWitness,
} from "./support/remote-ui-primary-workspace.ts";

const root = NodePath.resolve(import.meta.dirname, "../../..");
const fixtureRoot = process.env.BIBCODE_UPLOAD_FIXTURE;
const evidenceRoot = process.env.BIBCODE_UPLOAD_EVIDENCE;
const binary = process.env.BIBCODE_UPLOAD_SERVER;
const fakeBinary = process.env.BIBCODE_RELEASE_UI_FAKE_HOST;
const webRoot = process.env.BIBCODE_RELEASE_UI_WEB;
const chrome = process.env.BIBCODE_UPLOAD_CHROME;
const driver = process.env.BIBCODE_UPLOAD_DRIVER;
const sourceHash = process.env.BIBCODE_UPLOAD_SOURCE;
const plan = remoteUiPlan(process.env.BIBCODE_RELEASE_UI_MATRIX);
if (
  process.env.CI !== "true" ||
  !sourceHash ||
  !/^[0-9a-f]{40}$/.test(sourceHash) ||
  !fixtureRoot ||
  !evidenceRoot ||
  !binary ||
  !fakeBinary ||
  !webRoot ||
  !chrome ||
  !driver ||
  NodeFS.readlinkSync("/proc/self/ns/net") !== process.env.BIBCODE_UPLOAD_NETNS
)
  throw new Error(
    "Remote UI qualification requires the owned CI namespace and immutable build inputs.",
  );
const fixture = fixtureRoot,
  evidence = evidenceRoot,
  serverBinary = binary,
  fakeHostBinary = fakeBinary,
  assets = webRoot;
const webOrigin = "http://localhost:4901";
const bundleVersion: string = JSON.parse(
  NodeFS.readFileSync(NodePath.join(root, "apps/web/package.json"), "utf8"),
).version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(bundleVersion))
  throw new Error("UI bundle version is unavailable.");
const owner = new QualificationOwner(root, fixture);
let browser: QualificationBrowser | undefined;
let currentTheme: RemoteUiTheme = "light";
let currentPhase = "prepare";
let success = false;
const captures: Array<Record<string, unknown>> = [];
const assertions: Array<Record<string, unknown>> = [];
const networkProofs: unknown[] = [];
let reloadPrimaryThreadWitness: ReloadPrimaryThreadWitness | null = null;
const tunnels: Array<() => Promise<void>> = [];
const write = (name: "phase" | "result" | "failure" | "assertions", value: unknown) =>
  NodeFS.writeFileSync(
    NodePath.join(evidence, `${name}.json`),
    JSON.stringify(value, null, 2) + "\n",
    { mode: 0o600 },
  );
const phase = (name: string) => {
  currentPhase = name;
  write("phase", { phase: name, theme: currentTheme });
};
const manualAssertionCodes = new Set([
  "manual-observed-platform",
  "manual-observed-install-kind",
  "manual-has-no-install-control",
  "manual-restart-command",
  "manual-archive-platform",
  "manual-package-platform",
  "manual-unknown-platform",
  "manual-row-clipboard",
  "manual-row-card-agree",
  "manual-card-clipboard",
]);
const manualAssertionFailures = new WeakMap<Error, string>();
// Per-run immutable records belong only to the exact original failure object.
const toastErrorSignatureFailures = new WeakMap<object, RemoteUiToastErrorSignature>();
function check(value: unknown, code: string): asserts value {
  if (value !== true) {
    const error = new Error(`UI qualification assertion failed: ${code}.`);
    if (manualAssertionCodes.has(code)) manualAssertionFailures.set(error, code);
    throw error;
  }
}
function readManualAssertionCode(error: unknown): string | null {
  return error instanceof Error ? (manualAssertionFailures.get(error) ?? null) : null;
}
const required = () => {
  if (!browser) throw new Error("Owned browser is unavailable.");
  return browser;
};
const element = (selector: string) => {
  const scopedText = /^(.*) (button=[^\n]+)$/.exec(selector);
  return scopedText ? required().$(scopedText[1]!).$(scopedText[2]!) : required().$(selector);
};
const click = async (
  selector: string,
  observe?: (operation: "displayed" | "clickable" | "click") => void,
) => {
  const target = element(selector);
  observe?.("displayed");
  await target.waitForDisplayed();
  observe?.("clickable");
  await target.waitForClickable();
  observe?.("click");
  await target.click();
};
const text = async (selector: string, expected: string, timeout = 30_000) => {
  await required().waitUntil(
    async () => {
      try {
        return (await required().$(selector).getText()).includes(expected);
      } catch {
        return false;
      }
    },
    { timeout, interval: 250, timeoutMsg: "Expected controlled UI state did not arrive." },
  );
};
const dialog = '[data-slot="dialog-popup"][role="dialog"]';
const card = '[data-testid="environment-context-card"]';
const composer = '[data-center-surface-host][data-visible="true"] [data-testid="composer-editor"]';
const row = (label: string) => `//h3[normalize-space()="${label}"]/../../..`;
const endpoint = (port: number) => `http://127.0.0.1:${port}`;
const descriptorPath = EnvironmentMetadataHttpApi.endpoints.descriptor.path;
let serial = 0;

interface Host {
  readonly label: string;
  readonly port: number;
  readonly clientPort: number;
  readonly base: string;
  readonly project: string;
  readonly env: NodeJS.ProcessEnv;
  readonly child: QualificationProcess;
  readonly closeTunnel?: () => Promise<void>;
  readonly devUrl?: typeof webOrigin;
}

function privateEnvironment(directory: string): NodeJS.ProcessEnv {
  for (const name of ["home", "config", "data", "cache", "runtime"])
    NodeFS.mkdirSync(NodePath.join(directory, name), { recursive: true, mode: 0o700 });
  return {
    ...process.env,
    HOME: NodePath.join(directory, "home"),
    USERPROFILE: NodePath.join(directory, "home"),
    XDG_CONFIG_HOME: NodePath.join(directory, "config"),
    XDG_DATA_HOME: NodePath.join(directory, "data"),
    XDG_CACHE_HOME: NodePath.join(directory, "cache"),
    XDG_RUNTIME_DIR: NodePath.join(directory, "runtime"),
    PATH: NodePath.join(fixture, "bin"),
    BIBCODE_LOG: "warn",
    RUST_LOG: "warn",
  };
}

async function unusedPort(port: number): Promise<void> {
  check(
    [4856, 4858, 4859, 4860, 4886, 4887, 4888, 4889, 4890, 4901, 4915].includes(port),
    "port-allowlist",
  );
  await new Promise<void>((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", () => reject(new Error("Owned fixture port is occupied.")));
    server.listen(port, "127.0.0.1", () =>
      server.close((error) =>
        error ? reject(new Error("Owned port probe did not close.")) : resolve(),
      ),
    );
  });
}

async function descriptor(port: number) {
  const response = await fetch(endpoint(port) + descriptorPath, {
    signal: AbortSignal.timeout(1_000),
  });
  if (!response.ok) throw new Error("Owned descriptor is unavailable.");
  return (await response.json()) as {
    serverVersion?: string;
    bootId?: string;
    platform?: { os?: string; arch?: string };
    remoteUpdateSupport?: { installKind?: string };
  };
}

async function readyHost(port: number, version?: string) {
  await owner.until(async () => {
    try {
      const value = await descriptor(port);
      return (
        typeof value.bootId === "string" &&
        (version === undefined || value.serverVersion === version)
      );
    } catch {
      return false;
    }
  });
}

async function addOwnedTunnel(host: Host): Promise<Host> {
  const ports = new Map([
    [4886, 4856],
    [4888, 4858],
    [4889, 4859],
    [4890, 4860],
  ]);
  const clientPort = ports.get(host.port);
  check(clientPort !== undefined, "tunnel-port-allowlist");
  await unusedPort(clientPort);
  const proxy = await startThrottleProxy({
    listenHost: "127.0.0.1",
    listenPort: clientPort,
    targetHost: "127.0.0.1",
    targetPort: host.port,
  });
  let closing: Promise<void> | undefined;
  const closeTunnel = () => (closing ??= proxy.close());
  tunnels.push(closeTunnel);
  const [direct, forwarded] = await Promise.all([descriptor(host.port), descriptor(clientPort)]);
  check(direct.bootId === forwarded.bootId, "real-tunnel-descriptor-identity");
  return { ...host, clientPort, closeTunnel };
}

async function fakeHost(
  role: "primary" | "update-a" | "update-b" | "update-c",
  port: number,
  label: string,
  version = "9.9.0",
): Promise<Host> {
  check(/^[A-Za-z0-9 -]{1,64}$/.test(label), "fixed-host-label");
  await unusedPort(port);
  const directory = NodePath.join(fixture, `${currentTheme}-${role}-${++serial}`),
    base = NodePath.join(directory, "state");
  const env = privateEnvironment(directory);
  const setup = {
    ...env,
    BIBCODE_E2E_RUN_ROOT: NodePath.join(directory, "project-fixture"),
    BIBCODE_E2E_ARTIFACT_DIR: NodePath.join(directory, "private"),
    BIBCODE_E2E_PLATFORM: "linux",
  };
  const project = prepareDesktopUiTestContext(setup).projectPath;
  const devArgs = role === "primary" ? ["--dev-url", webOrigin] : [];
  const child = owner.spawn(
    fakeHostBinary,
    [base, String(port), version, label, ...devArgs],
    env,
    role,
    true,
  );
  await readyHost(port, version);
  const host: Host = {
    label,
    port,
    clientPort: port,
    base,
    env,
    child,
    project,
    ...(role === "primary" ? { devUrl: webOrigin } : {}),
  };
  return role === "primary" ? host : addOwnedTunnel(host);
}

async function grant(host: Host): Promise<string> {
  const value = (await owner.json(
    serverBinary,
    [
      "pairing",
      "issue",
      "--base-dir",
      host.base,
      ...(host.devUrl ? ["--dev-url", host.devUrl] : []),
      "--json",
    ],
    host.env,
  )) as { credential?: unknown };
  if (typeof value.credential !== "string" || value.credential.length < 8)
    throw new Error("Owned grant is unavailable.");
  return value.credential;
}

async function offer(host: Host): Promise<string> {
  const value = (await owner.json(
    serverBinary,
    [
      "pairing",
      "offer",
      "--base-dir",
      host.base,
      ...(host.devUrl ? ["--dev-url", host.devUrl] : []),
      "--endpoint",
      endpoint(host.clientPort),
      "--reach",
      "this-computer",
      "--name",
      host.label,
      "--json",
    ],
    host.env,
  )) as { link?: unknown };
  if (typeof value.link !== "string" || !value.link.startsWith("bibcode://pair?"))
    throw new Error("Owned pairing offer is unavailable.");
  return value.link;
}

function requests(host: Host): number {
  const size = NodeFS.statSync(host.child.log).size;
  if (size > 65536) throw new Error("Private host log exceeded the receipt bound.");
  return countInstallRequests(NodeFS.readFileSync(host.child.log, "utf8"));
}

async function exactRequests(host: Host, count: number) {
  await owner.until(async () => requests(host) === count);
  assertions.push({
    theme: currentTheme,
    kind: "install-request-count",
    expected: count,
    observed: requests(host),
  });
}

async function settings() {
  if (
    await required()
      .$("button=Remote Servers")
      .isDisplayed()
      .catch(() => false)
  )
    await click("button=Remote Servers");
  else await click('[data-testid="environment-rail-manage"]');
  await required().$('button[aria-label="Add Server"]').waitForDisplayed();
}
async function workspace() {
  if (
    await required()
      .$("button=Back")
      .isDisplayed()
      .catch(() => false)
  )
    await click("button=Back");
}
async function selectHost(host: Host) {
  await click(`[role="radio"][aria-label="${host.label}"]`);
  await required().waitUntil(
    async () =>
      (await required()
        .$(`[role="radio"][aria-label="${host.label}"]`)
        .getAttribute("aria-checked")) === "true",
  );
}

const SUCCESS_ADD_HOST_PHASES = {
  settings: "success-add-host-settings",
  open: "success-add-host-open",
  dialog: "success-add-host-dialog",
  alias: "success-add-host-alias",
  code: "success-add-host-code",
  "ack-visible": "success-add-host-ack-visible",
  "ack-proof": "success-add-host-ack-proof",
  ack: "success-add-host-ack",
  submit: "success-add-host-submit",
  closed: "success-add-host-closed",
  row: "success-add-host-row",
  select: "success-add-host-select",
  "return-settings": "success-add-host-return-settings",
  check: "success-add-host-check",
  status: "success-add-host-status",
} as const;
const SUCCESS_IMPORT_PHASES = {
  "primary-import-workspace": "success-import-workspace",
  "primary-import-menu": "success-import-menu",
  "primary-import-path-mode": "success-import-path-mode",
  "primary-import-path-input": "success-import-path-input",
  "primary-import-submit": "success-import-submit",
  "primary-import-composer": "success-import-composer",
} as const;

async function addHost(
  host: Host,
  interactive = true,
  observe?: (operation: keyof typeof SUCCESS_ADD_HOST_PHASES) => void,
) {
  const observeStep = (operation: keyof typeof SUCCESS_ADD_HOST_PHASES) => {
    try {
      observe?.(operation);
    } catch {
      // Optional attribution cannot skip the original UI actions.
    }
  };
  observeStep("settings");
  await settings();
  observeStep("open");
  await click('button[aria-label="Add Server"]');
  observeStep("dialog");
  await required().$(dialog).waitForDisplayed();
  observeStep("alias");
  await required().$(`${dialog} input[placeholder="e.g. Linux workstation"]`).setValue(host.label);
  observeStep("code");
  await required()
    .$(`${dialog} textarea[placeholder="bibcode://pair?code=…"]`)
    .setValue(await offer(host));
  const acknowledgement = required().$(`${dialog} [role="checkbox"]`);
  observeStep("ack-visible");
  if (await acknowledgement.isDisplayed().catch(() => false)) {
    observeStep("ack-proof");
    check(host.closeTunnel !== undefined, "actual-tunnel-before-acknowledgement");
    observeStep("ack");
    await acknowledgement.click();
  }
  observeStep("submit");
  await click(`${dialog} button=Add Server`);
  observeStep("closed");
  await required().$(dialog).waitForDisplayed({ reverse: true });
  observeStep("row");
  await text(row(host.label), host.label);
  observeStep("select");
  await selectHost(host);
  observeStep("return-settings");
  await settings();
  observeStep("check");
  await click(`${row(host.label)}//button[normalize-space()="Check"]`);
  observeStep("status");
  await text(row(host.label), interactive ? "Update to v9.9.1…" : "Manual updates");
}

type RemoveHostOperation =
  | "settings"
  | "more"
  | "remove"
  | "confirm"
  | `${"more" | "remove" | "confirm"}-${"displayed" | "clickable" | "click"}`
  | "row-removed"
  | "child-stop"
  | "tunnel-close"
  | "toast-list"
  | "toast-displayed"
  | "toast-clickable"
  | "toast-click"
  | "toast-click-inspect"
  | "toast-click-unavailable"
  | "toast-click-unrecognized"
  | "toast-click-matched"
  | "toast-recheck-list"
  | "toast-recheck-displayed"
  | "toast-recheck-visible"
  | "toast-recheck-empty";

const SUCCESS_REMOVE_PHASES = {
  settings: "success-remove-settings",
  more: "success-remove-more",
  remove: "success-remove-remove",
  confirm: "success-remove-confirm",
  "more-displayed": "success-remove-more-displayed",
  "more-clickable": "success-remove-more-clickable",
  "more-click": "success-remove-more-click",
  "remove-displayed": "success-remove-remove-displayed",
  "remove-clickable": "success-remove-remove-clickable",
  "remove-click": "success-remove-remove-click",
  "confirm-displayed": "success-remove-confirm-displayed",
  "confirm-clickable": "success-remove-confirm-clickable",
  "confirm-click": "success-remove-confirm-click",
  "row-removed": "success-remove-row-removed",
  "child-stop": "success-remove-child-stop",
  "tunnel-close": "success-remove-tunnel-close",
  "toast-list": "success-remove-toast-list",
  "toast-displayed": "success-remove-toast-displayed",
  "toast-clickable": "success-remove-toast-clickable",
  "toast-click": "success-remove-toast-click",
  "toast-click-inspect": "success-remove-toast-click-inspect",
  "toast-click-unavailable": "success-remove-toast-click-unavailable",
  "toast-click-unrecognized": "success-remove-toast-click-unrecognized",
  "toast-click-matched": "success-remove-toast-click-matched",
  "toast-recheck-list": "success-remove-toast-recheck-list",
  "toast-recheck-displayed": "success-remove-toast-recheck-displayed",
  "toast-recheck-visible": "success-remove-toast-recheck-visible",
  "toast-recheck-empty": "success-remove-toast-recheck-empty",
} as const satisfies Record<RemoveHostOperation, string>;

async function removeHost(host: Host, observe?: (operation: RemoveHostOperation) => void) {
  const observeStep = (operation: RemoveHostOperation) => {
    try {
      observe?.(operation);
    } catch {
      // Optional removal attribution cannot change the original action or failure.
    }
  };
  observeStep("settings");
  await settings();
  observeStep("more");
  await click(`button[aria-label="More actions for ${host.label}"]`, (operation) =>
    observeStep(`more-${operation}`),
  );
  observeStep("remove");
  await click('//*[@role="menuitem" and normalize-space()="Remove server…"]', (operation) =>
    observeStep(`remove-${operation}`),
  );
  observeStep("confirm");
  await click('[role="alertdialog"] button=Remove server', (operation) =>
    observeStep(`confirm-${operation}`),
  );
  observeStep("row-removed");
  await required().$(row(host.label)).waitForExist({ reverse: true });
  observeStep("child-stop");
  await owner.stop(host.child);
  if (host.closeTunnel) {
    observeStep("tunnel-close");
    await bounded(host.closeTunnel(), 5_000);
  }
  // End a completed fixture case through the real notification controls.
  const toastClose = 'button[data-slot="toast-close"]';
  await owner.until(async () => {
    observeStep("toast-list");
    let visibleCloseRemains = false;
    for (const close of await required().$$(toastClose)) {
      observeStep("toast-displayed");
      if (!(await close.isDisplayed())) continue;
      visibleCloseRemains = true;
      observeStep("toast-clickable");
      if (!(await close.isClickable())) continue;
      observeStep("toast-click");
      try {
        await close.click();
      } catch (error) {
        try {
          observeStep("toast-click-inspect");
          const descriptor =
            error !== null && typeof error === "object"
              ? Object.getOwnPropertyDescriptor(error, "message")
              : undefined;
          const message =
            descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : null;
          if (typeof message !== "string") {
            observeStep("toast-click-unavailable");
            throw error;
          }
          // The pinned middleware can return owned-close HTML after its wait
          // fails. Recognize only that bounded SDK frame and own data name.
          let sdkInteractableClose = false;
          const frame =
            message.length <= 1024 && message.endsWith("</button> did not become interactable")
              ? /^Element <button\b([^<>]*)>(?:(?!<\/?[bB][uU][tT][tT][oO][nN]\b)[\s\S])*<\/button> did not become interactable$/.exec(
                  message,
                )
              : null;
          if (frame) {
            const header = frame[1]!;
            const attribute =
              /\s+([A-Za-z_:][A-Za-z0-9_.:-]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/y;
            let offset = 0,
              slots = 0,
              ownedSlot = false,
              valid = true;
            while (header.slice(offset).trim() !== "") {
              attribute.lastIndex = offset;
              const token = attribute.exec(header);
              if (!token) {
                valid = false;
                break;
              }
              offset = attribute.lastIndex;
              if (token[1]!.toLowerCase() === "data-slot") {
                slots++;
                ownedSlot = token[1] === "data-slot" && token[2] === '"toast-close"';
              }
            }
            if (valid && slots === 1 && ownedSlot) {
              const name = Object.getOwnPropertyDescriptor(error, "name");
              sdkInteractableClose =
                name !== undefined &&
                Object.hasOwn(name, "value") &&
                name.value === "webdriverio(middleware): element did not become interactable";
            }
          }
          if (
            !sdkInteractableClose &&
            !/^(?:no such element|stale element reference)(?::|$)/.test(message) &&
            // The pinned SDK wraps response errors with this command/method suffix.
            // Bound verbatim details (including line breaks) and ID; refuse args/other operations.
            !/^WebDriverError: (?:no such element|stale element reference)(?::[\s\S]{0,1024})? when running "element\/[A-Za-z0-9._:-]{1,256}\/click" with method "POST"$/.test(
              message,
            ) &&
            message !==
              `Can't call click on element with selector "${toastClose}" because element wasn't found` &&
            message !==
              `Can't call scrollIntoView on element with selector "${toastClose}" because element wasn't found` &&
            message !==
              `Can't call getHTML on element with selector "${toastClose}" because element wasn't found`
          ) {
            observeStep("toast-click-unrecognized");
            try {
              const signature = projectRemoteUiToastErrorSignature(message, error);
              if (signature !== null && error !== null && typeof error === "object")
                toastErrorSignatureFailures.set(error, signature);
            } catch {
              // Optional string-shape attribution cannot change the original error.
            }
            throw error;
          }
          observeStep("toast-click-matched");
          // There is no stable public toast ID. Accept only concrete absence of
          // every visible close, preserving the original click error on refusal.
          observeStep("toast-recheck-list");
          for (const current of await required().$$(toastClose)) {
            observeStep("toast-recheck-displayed");
            if (await current.isDisplayed()) {
              observeStep("toast-recheck-visible");
              throw error;
            }
          }
          observeStep("toast-recheck-empty");
        } catch {
          throw error;
        }
        return true;
      }
      // Re-fetch after each dismissal; later controls may have re-rendered.
      return false;
    }
    return !visibleCloseRemains;
  });
}

async function importProject(
  host: Host,
  observe?: (operation: keyof typeof SUCCESS_IMPORT_PHASES) => void,
) {
  const primaryPhase = (name: keyof typeof SUCCESS_IMPORT_PHASES) => {
    if (host.devUrl) phase(name);
    try {
      observe?.(name);
    } catch {
      // Optional attribution cannot skip the original UI actions.
    }
  };
  primaryPhase("primary-import-workspace");
  await workspace();
  primaryPhase("primary-import-menu");
  await click('[data-testid="sidebar-add-project-trigger"]');
  await click(
    "//button[@data-add-project-action='true'][.//span[normalize-space()='Browse folder']]",
  );
  primaryPhase("primary-import-path-mode");
  await owner.until(
    async () =>
      (await required().$("#add-project-host-path").isDisplayed()) ||
      (await required().$("button=Type a path instead").isDisplayed()),
  );
  if (!(await required().$("#add-project-host-path").isExisting()))
    await click("button=Type a path instead");
  primaryPhase("primary-import-path-input");
  await required().$("#add-project-host-path").waitForDisplayed();
  await required().$("#add-project-host-path").setValue(host.project);
  primaryPhase("primary-import-submit");
  await click("button=Open project");
  primaryPhase("primary-import-composer");
  await required().$(composer).waitForDisplayed();
}

async function setTheme(theme: RemoteUiTheme) {
  phase("primary-theme-settings");
  await settings();
  phase("primary-theme-general");
  await click("button=General");
  phase("primary-theme-select");
  await click('[aria-label="Theme preference"]');
  await click(
    `//*[@role="option" and normalize-space()="${theme === "light" ? "Light" : "Dark"}"]`,
  );
  phase("primary-theme-applied");
  await required().waitUntil(
    async () =>
      await required().execute(
        (dark) => document.documentElement.classList.contains("dark") === dark,
        theme === "dark",
      ),
  );
  phase("primary-theme-remote-servers");
  await click("button=Remote Servers");
}

async function capture(scene: RemoteUiScene, host: Host, target: string, expected: string) {
  await text(target, expected);
  await required().$(target).scrollIntoView({ block: "center" });
  await required().performActions([
    {
      type: "pointer",
      id: "qualification-pointer",
      parameters: { pointerType: "mouse" },
      actions: [{ type: "pointerMove", duration: 0, x: 1, y: 1, origin: "viewport" }],
    },
  ]);
  let witness: unknown = null;
  await required().waitUntil(
    async () => {
      witness = await bounded(
        required().execute(
          (input) => {
            const target = input.selector.startsWith("//")
              ? document.evaluate(
                  input.selector,
                  document,
                  null,
                  XPathResult.FIRST_ORDERED_NODE_TYPE,
                  null,
                ).singleNodeValue
              : document.querySelector(input.selector);
            const element = target instanceof HTMLElement ? target : null;
            const bounds = element?.getBoundingClientRect();
            const selected = document.querySelector(`[role="radio"][aria-label="${input.label}"]`);
            const primary = document.querySelector('[data-testid="environment-rail-local"]');
            const visible = (candidate: Element) => {
              const rectangle = candidate.getBoundingClientRect();
              return (
                rectangle.width > 0 &&
                rectangle.height > 0 &&
                getComputedStyle(candidate).visibility !== "hidden"
              );
            };
            const unobstructed =
              element !== null &&
              bounds !== undefined &&
              [
                [bounds.x + bounds.width / 2, bounds.y + bounds.height / 2],
                [bounds.x + bounds.width / 2, bounds.y + 2],
                [bounds.x + bounds.width / 2, bounds.bottom - 2],
              ].every(([x, y]) => {
                const hit = document.elementFromPoint(x!, y!);
                return hit !== null && (hit === element || element.contains(hit));
              });
            const noOtherDialog = Array.from(
              document.querySelectorAll(
                '[data-slot="dialog-popup"],[data-slot="alert-dialog-popup"]',
              ),
            ).every((popup) => !visible(popup) || popup === element || popup.contains(element));
            return {
              themeMatched:
                document.documentElement.classList.contains("dark") === (input.theme === "dark"),
              selectedMatched:
                (input.primary ? primary : selected)?.getAttribute("aria-checked") === "true",
              expectedTextMatched: element?.textContent?.includes(input.expected) === true,
              targetInView:
                bounds !== undefined &&
                bounds.width > 0 &&
                bounds.height > 0 &&
                bounds.x >= 0 &&
                bounds.y >= 0 &&
                bounds.right <= innerWidth &&
                bounds.bottom <= innerHeight &&
                unobstructed &&
                noOtherDialog,
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
          {
            selector: target,
            label: host.label,
            expected,
            theme: currentTheme,
            origin: webOrigin,
            primary: host.port === 4887,
          },
        ),
        2_000,
      );
      try {
        validateCaptureWitness(witness);
        return true;
      } catch {
        return false;
      }
    },
    { timeout: 30_000, interval: 250, timeoutMsg: "Screenshot conditions did not become valid." },
  );
  const proof = validateCaptureWitness(witness);
  const bytes = Buffer.from(await bounded(required().takeScreenshot(), 5_000), "base64");
  const image = inspectScreenshot(bytes),
    file = screenshotName(currentTheme, scene);
  NodeFS.writeFileSync(NodePath.join(evidence, file), bytes, { mode: 0o600, flag: "wx" });
  captures.push({ theme: currentTheme, scene, file, ...proof, ...image });
  write("assertions", { captures, assertions });
}

async function openConfirmation(host: Host, location: "row" | "card") {
  await selectHost(host);
  if (location === "row") {
    await settings();
    await click(`${row(host.label)}//button[normalize-space()="Update to v9.9.1…"]`);
  } else {
    await workspace();
    await click(`${card} button=Update to v9.9.1…`);
  }
  await text(dialog, `Update ${host.label} to v9.9.1?`);
  await text(dialog, `Updating ${host.label} restarts BiBCode there.`);
  await text(dialog, `v9.9.1 is newer than this app (v${bundleVersion}). Update this app too.`);
}

async function confirm(host: Host) {
  await click(`${dialog} button=Update ${host.label}`);
  await required().$(dialog).waitForDisplayed({ reverse: true });
}
async function cancel() {
  await click(`${dialog} button=Cancel`);
  await required().$(dialog).waitForDisplayed({ reverse: true });
}
async function status(host: Host, state: string, extras: Record<string, unknown> = {}) {
  await owner.command(host.child, {
    status: { state, latestVersion: "9.9.1", targetVersion: "9.9.1", ...extras },
  });
}
async function restart(host: Host, version: string) {
  const before = await descriptor(host.port);
  await owner.command(host.child, { restart: { serverVersion: version, afterMs: 2_000 } });
  await owner.until(async () => {
    try {
      const after = await descriptor(host.port);
      return after.bootId !== before.bootId && after.serverVersion === version;
    } catch {
      return false;
    }
  });
}

function processIdentity(pid: number): string | null {
  try {
    const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] ?? null;
  } catch {
    return null;
  }
}

function terminalExecutable(): string {
  const file = NodePath.join(fixture, "bin", "owned-ui-terminal");
  if (!NodeFS.existsSync(file)) {
    check(!/[\s\0]/.test(process.execPath), "pinned-terminal-interpreter");
    const source = `#!${process.execPath}\nprocess.stdout.write('Owned qualification terminal ready\\r\\n');process.stdin.resume();\n`;
    NodeFS.writeFileSync(file, source, { mode: 0o700, flag: "wx" });
  }
  return file;
}

async function freshTerminalCounts(host: Host) {
  await workspace();
  const location = new URL(await required().getUrl());
  check(
    location.origin === webOrigin && location.search === "" && location.hash === "",
    "terminal-owned-route",
  );
  // Terminal sessions accept a client-owned key before a persisted conversation exists.
  // A /draft route suffix is a DraftId, so it must not be misrepresented as a ThreadId.
  const threadId = `qa-remote-update-terminal-${currentTheme}`;
  const input: TerminalOpenInput = {
    threadId,
    terminalId: "term-ui-qualification",
    cwd: host.project,
    cols: 80,
    rows: 24,
    env: { HOME: host.env.HOME!, USERPROFILE: host.env.HOME!, PATH: NodePath.join(fixture, "bin") },
    command: {
      executable: terminalExecutable(),
      args: [],
      label: "Owned UI qualification terminal",
    },
  };
  const started = await callFixtureRpc(
    required(),
    endpoint(host.port),
    await grant(host),
    "terminal.open",
    input,
  );
  check(started.running === true && typeof started.pid === "number", "real-terminal-running");
  const pid = started.pid,
    identity = processIdentity(pid);
  check(identity !== null, "real-terminal-process-present");
  try {
    await openConfirmation(host, "row");
    await text(dialog, "1 terminal will stop.");
    await text(dialog, "Conversations and queued messages are kept");
    await capture("terminal-warning", host, dialog, "1 terminal will stop.");
    await cancel();
    await exactRequests(host, 0);
  } finally {
    const closed = await callFixtureRpc(
      required(),
      endpoint(host.port),
      await grant(host),
      "terminal.close",
      { threadId, terminalId: "term-ui-qualification" },
    );
    check(closed.closed === true, "real-terminal-close-returned");
    await owner.until(async () => processIdentity(pid) !== identity, 5_000);
  }
  await openConfirmation(host, "row");
  await text(dialog, "Nothing is running on it now.");
  await cancel();
  assertions.push({
    theme: currentTheme,
    kind: "fresh-active-work",
    creation: "authenticated-public-rpc",
    terminalScope: "owned-fixture-session-key",
    realTerminal: true,
    uiCountOne: true,
    closedAndReaped: true,
    uiCountZero: true,
  });
}

async function successFlow() {
  const observeConfirmation = (
    stage:
      | "initial-card-workspace"
      | "initial-card"
      | "row-confirmation"
      | "row-idle-proof"
      | "confirm-row"
      | "row-cancel"
      | "row-requests"
      | "row-workspace"
      | "row-draft"
      | "card-confirmation"
      | "confirm-card"
      | "card-cancel"
      | "card-requests"
      | "card-draft",
  ) => {
    try {
      phase(`success-${stage}`);
    } catch {
      // Optional attribution cannot skip an action or replace its original failure.
    }
  };
  phase("success-flow");
  phase("success-host-start");
  const host = await fakeHost("update-a", 4888, `QA Success ${currentTheme}`);
  await addHost(host, true, (operation) => phase(SUCCESS_ADD_HOST_PHASES[operation]));
  await importProject(host, (operation) => phase(SUCCESS_IMPORT_PHASES[operation]));
  phase("success-draft");
  const draft = `retained update draft ${currentTheme}`;
  await required().$(composer).setValue(draft);
  phase("success-settings");
  await settings();
  phase("success-initial-row");
  await capture("initial-row", host, row(host.label), "Update to v9.9.1…");
  observeConfirmation("initial-card-workspace");
  await workspace();
  observeConfirmation("initial-card");
  await capture("initial-card", host, card, host.label);
  observeConfirmation("row-confirmation");
  await openConfirmation(host, "row");
  observeConfirmation("row-idle-proof");
  await text(dialog, "Nothing is running on it now.");
  observeConfirmation("confirm-row");
  await capture("confirm-row", host, dialog, `Update ${host.label} to v9.9.1?`);
  observeConfirmation("row-cancel");
  await cancel();
  observeConfirmation("row-requests");
  await exactRequests(host, 0);
  observeConfirmation("row-workspace");
  await workspace();
  observeConfirmation("row-draft");
  check((await required().$(composer).getText()).includes(draft), "row-cancel-keeps-draft");
  observeConfirmation("card-confirmation");
  await openConfirmation(host, "card");
  observeConfirmation("confirm-card");
  await capture("confirm-card", host, dialog, `Update ${host.label} to v9.9.1?`);
  observeConfirmation("card-cancel");
  await cancel();
  observeConfirmation("card-requests");
  await exactRequests(host, 0);
  observeConfirmation("card-draft");
  check((await required().$(composer).getText()).includes(draft), "card-cancel-keeps-draft");
  await freshTerminalCounts(host);
  await openConfirmation(host, "row");
  await confirm(host);
  await exactRequests(host, 1);
  await status(host, "downloading", { downloadPercent: 42 });
  await text(row(host.label), "Downloading 42%");
  check(
    !(await required()
      .$(`${row(host.label)}//button[normalize-space()="Update to v9.9.1…"]`)
      .isExisting()),
    "progress-replaces-update",
  );
  await capture("downloading-row", host, row(host.label), "Downloading 42%");
  await workspace();
  await capture("downloading-card", host, card, "Downloading 42%");
  check((await required().$(composer).getText()).includes(draft), "progress-keeps-draft");
  await settings();
  await capture("downloading-remounted", host, row(host.label), "Downloading 42%");
  await exactRequests(host, 1);
  await status(host, "installing", { installStage: "creating-verified-backup" });
  await capture("backup", host, row(host.label), "Backing up project data…");
  await status(host, "installing", { installStage: "stopping-backend" });
  await capture("restarting", host, row(host.label), "Restarting…");
  await restart(host, "9.9.1");
  await text("body", `${host.label} updated to v9.9.1`);
  await capture("success", host, row(host.label), "9.9.1");
  await exactRequests(host, 1);
  await workspace();
  check((await required().$(composer).getText()).includes(draft), "success-keeps-draft");
  assertions.push({
    theme: currentTheme,
    kind: "confirmation-and-progress",
    rowCancel: true,
    cardCancel: true,
    remountPreservedRun: true,
    exactInstallRequests: 1,
    draftRetained: true,
    newVersionObserved: "9.9.1",
  });
  await removeHost(host, (operation) => phase(SUCCESS_REMOVE_PHASES[operation]));
}

async function failureFlow() {
  phase("failure-retry-dismiss");
  const host = await fakeHost("update-a", 4888, `QA Failure ${currentTheme}`);
  await addHost(host);
  await importProject(host);
  const draft = `retained failure draft ${currentTheme}`;
  await required().$(composer).setValue(draft);
  await openConfirmation(host, "row");
  await confirm(host);
  await exactRequests(host, 1);
  await status(host, "error", { error: "Controlled fixture install failure" });
  await text(row(host.label), "Nothing was installed; it runs v9.9.0 again.");
  // Use each real transient toast when it arrives; do not extend its lifetime.
  const toast = `//*[@data-slot="toast-viewport"]/*[(@role="dialog" or @role="alertdialog") and .//*[@data-slot="toast-description" and contains(.,"${host.label}")]]`;
  await click(`${toast}//button[normalize-space()="Retry"]`);
  await text(dialog, `Update ${host.label} to v9.9.1?`);
  await text(dialog, "Nothing is running on it now.");
  await capture("toast-retry", host, dialog, `Update ${host.label} to v9.9.1?`);
  await cancel();
  await exactRequests(host, 1);
  await capture("failure", host, row(host.label), "Controlled fixture install failure");
  await delay(2_000);
  await exactRequests(host, 1);
  await click(`${row(host.label)}//button[normalize-space()="Retry"]`);
  await text(dialog, `Update ${host.label} to v9.9.1?`);
  await text(dialog, "Nothing is running on it now.");
  await capture("row-retry", host, dialog, `Update ${host.label} to v9.9.1?`);
  await cancel();
  await exactRequests(host, 1);
  await status(host, "update-available");
  await click(`${row(host.label)}//button[normalize-space()="Retry"]`);
  await confirm(host);
  await exactRequests(host, 2);
  await status(host, "error", { error: "Controlled fixture install failure" });
  await text(row(host.label), "Nothing was installed");
  await status(host, "update-available");
  await click(`${toast}//button[normalize-space()="Retry"]`);
  await text(dialog, "Nothing is running on it now.");
  await confirm(host);
  await exactRequests(host, 3);
  await status(host, "error", { error: "Controlled fixture install failure" });
  await text(row(host.label), "Nothing was installed");
  phase("failure-dismiss");
  await click(`${row(host.label)}//button[normalize-space()="Dismiss"]`);
  await required()
    .$(`${row(host.label)}//button[normalize-space()="Dismiss"]`)
    .waitForExist({ reverse: true });
  await status(host, "update-available");
  phase("failure-check-again");
  await click(
    `${row(host.label)}//button[normalize-space()="Check again" or normalize-space()="Check"]`,
    (operation) => {
      if (operation === "displayed") phase("failure-check-again-displayed");
      else if (operation === "clickable") phase("failure-check-again-clickable");
      else phase("failure-check-again-click");
    },
  );
  phase("failure-check-again-row");
  await text(row(host.label), "Update to v9.9.1…");
  await capture("dismissed", host, row(host.label), "Update to v9.9.1…");
  await workspace();
  check(
    (await required().$(composer).getText()).includes(draft),
    "failure-retry-dismiss-keeps-draft",
  );
  assertions.push({
    theme: currentTheme,
    kind: "failure-retry-dismiss",
    oldVersionObserved: "9.9.0",
    noAutomaticRetry: true,
    canceledRetryKeepsCount: true,
    explicitRetryCount: 3,
    rowAndToastConfirmed: true,
    draftRetained: true,
  });
  await removeHost(host);
}

async function restartFailures() {
  phase("wrong-version");
  const wrong = await fakeHost("update-a", 4888, `QA Wrong Version ${currentTheme}`);
  await addHost(wrong);
  await openConfirmation(wrong, "row");
  await confirm(wrong);
  await exactRequests(wrong, 1);
  await status(wrong, "installing", { installStage: "stopping-backend" });
  await text(row(wrong.label), "Restarting…");
  await restart(wrong, "9.9.0");
  await capture(
    "wrong-version",
    wrong,
    row(wrong.label),
    `${wrong.label} restarted on v9.9.0 instead of v9.9.1.`,
  );
  phase("wrong-version-retry");
  await click(`${row(wrong.label)}//button[normalize-space()="Retry"]`);
  phase("wrong-version-reconfirmation");
  // Restart resets the scripted updater's latest version. Settings requests a
  // fresh confirmation, so its target is unknown until another check succeeds.
  await text(dialog, `Update ${wrong.label}?`);
  await text(dialog, "Nothing is running on it now.");
  phase("wrong-version-cancel");
  await cancel();
  phase("wrong-version-request-count");
  await exactRequests(wrong, 1);
  phase("wrong-version-remove");
  await removeHost(wrong);
  phase("real-no-return-deadline");
  const absent = await fakeHost("update-a", 4888, `QA No Return ${currentTheme}`);
  await addHost(absent);
  await openConfirmation(absent, "row");
  await confirm(absent);
  await exactRequests(absent, 1);
  const started = performance.now();
  await status(absent, "installing", { installStage: "stopping-backend" });
  await text(row(absent.label), "Restarting…");
  await owner.command(absent.child, { stop: true });
  await text(
    row(absent.label),
    `${absent.label} hasn't come back after the update.`,
    REMOTE_UPDATE_RESTART_BUDGET_MS + 30_000,
  );
  const elapsedMs = Math.round(performance.now() - started);
  check(elapsedMs >= REMOTE_UPDATE_RESTART_BUDGET_MS, "real-reconnect-budget");
  await capture("not-back", absent, row(absent.label), "Check BiBCode on");
  await required()
    .$(`${row(absent.label)}//button[normalize-space()="Retry"]`)
    .waitForDisplayed();
  await required()
    .$(`${row(absent.label)}//button[normalize-space()="Dismiss"]`)
    .waitForDisplayed();
  assertions.push({
    theme: currentTheme,
    kind: "real-reconnect-deadline",
    elapsedMs,
    requiredMs: REMOTE_UPDATE_RESTART_BUDGET_MS,
    retryAndDismissRetained: true,
  });
  await removeHost(absent);
}

async function queuedFlow() {
  phase("bounded-parallel");
  const hosts = [
    await fakeHost("update-a", 4888, `QA Queue A ${currentTheme}`),
    await fakeHost("update-b", 4889, `QA Queue B ${currentTheme}`),
    await fakeHost("update-c", 4890, `QA Queue C ${currentTheme}`),
  ];
  for (const host of hosts) await addHost(host);
  for (const host of hosts.slice(0, 2)) {
    await openConfirmation(host, "row");
    await confirm(host);
    await exactRequests(host, 1);
    await status(host, "downloading", { downloadPercent: 42 });
    await text(row(host.label), "Downloading 42%");
  }
  const third = hosts[2]!;
  await openConfirmation(third, "row");
  await confirm(third);
  await text(row(third.label), "Queued");
  await exactRequests(third, 0);
  await capture("queued", third, row(third.label), "Queued");
  await workspace();
  await settings();
  await text(row(third.label), "Queued");
  await exactRequests(third, 0);
  await status(hosts[0]!, "error", { error: "Controlled queue release" });
  await exactRequests(third, 1);
  await status(third, "downloading", { downloadPercent: 42 });
  await text(row(third.label), "Downloading 42%");
  await click(`${row(hosts[0]!.label)}//button[normalize-space()="Dismiss"]`);
  await text(row(hosts[1]!.label), "Downloading 42%");
  await text(row(third.label), "Downloading 42%");
  for (const host of hosts.slice(1)) {
    await status(host, "error", { error: "Controlled queue release" });
    await text(row(host.label), "Nothing was installed");
    await exactRequests(host, 1);
  }
  assertions.push({
    theme: currentTheme,
    kind: "bounded-parallel",
    activeBeforeRelease: 2,
    queuedBeforeRelease: 1,
    thirdRequestsBefore: 0,
    thirdRequestsAfter: 1,
    remountPreservedQueue: true,
    dismissDidNotCancelOtherRuns: true,
  });
  for (const [index, host] of hosts.entries()) {
    const slot = (["a", "b", "c"] as const)[index]!;
    await removeHost(host, (operation) => phase(`queued-remove-${slot}-${operation}`));
  }
}

async function manualHost(kind: "archive" | "package" | "unknown"): Promise<Host> {
  await unusedPort(4886);
  const role = `manual-${kind}` as const,
    directory = NodePath.join(fixture, `${currentTheme}-${role}-${++serial}`);
  const env = privateEnvironment(directory);
  const context = prepareDesktopUiTestContext({
    ...env,
    BIBCODE_E2E_RUN_ROOT: NodePath.join(directory, "context"),
    BIBCODE_E2E_ARTIFACT_DIR: NodePath.join(directory, "private"),
    BIBCODE_E2E_PLATFORM: "linux",
  });
  const base = context.stateRoot,
    settingsPath = NodePath.join(base, "userdata", "settings.json");
  const configured = JSON.parse(NodeFS.readFileSync(settingsPath, "utf8"));
  const absent = NodePath.join(base, "userdata", "missing-fixture-provider");
  for (const settings of Object.values(configured.providers) as Array<Record<string, unknown>>) {
    settings.enabled = false;
    settings.binaryPath = absent;
  }
  for (const instance of Object.values(configured.providerInstances ?? {}) as Array<
    Record<string, unknown>
  >) {
    instance.enabled = false;
    instance.config = { binaryPath: absent };
    instance.environment = [];
  }
  configured.enableProviderUpdateChecks = false;
  NodeFS.writeFileSync(settingsPath, JSON.stringify(configured), { mode: 0o600 });
  const distribution = NodePath.join(directory, "distribution"),
    executable = NodePath.join(distribution, "bin", "bibcode");
  NodeFS.mkdirSync(NodePath.dirname(executable), { recursive: true, mode: 0o700 });
  NodeFS.copyFileSync(serverBinary, executable);
  NodeFS.chmodSync(executable, 0o700);
  const staticRoot =
    kind === "archive"
      ? NodePath.join(distribution, "bin", "web")
      : kind === "package"
        ? NodePath.join(distribution, "share", "bibcode", "web")
        : NodePath.join(directory, "explicit-web");
  NodeFS.cpSync(assets, staticRoot, { recursive: true });
  const label = `QA Manual ${kind} ${currentTheme}`;
  const args = [
    "serve",
    "--mode",
    "web",
    "--host",
    "127.0.0.1",
    "--port",
    "4886",
    "--base-dir",
    base,
    "--no-browser",
    "--no-startup-pairing-offer",
    ...(kind === "unknown" ? ["--static-dir", staticRoot] : []),
  ];
  const child = owner.spawn(executable, args, env, role);
  await readyHost(4886);
  return addOwnedTunnel({
    label,
    port: 4886,
    clientPort: 4886,
    base,
    env,
    child,
    project: context.projectPath,
  });
}

async function manualFlow() {
  phase("manual-instructions");
  await required().sendCommandAndGetResult("Browser.grantPermissions", {
    origin: webOrigin,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
  for (const kind of ["archive", "package", "unknown"] as const) {
    phase(`manual-${kind}-start-host`);
    const host = await manualHost(kind);
    phase(`manual-${kind}-descriptor`);
    const actual = await descriptor(host.port);
    check(
      actual.platform?.os === "linux" && actual.platform.arch === "x64",
      "manual-observed-platform",
    );
    check(
      actual.remoteUpdateSupport?.installKind === (kind === "package" ? "system-package" : kind),
      "manual-observed-install-kind",
    );
    phase(`manual-${kind}-add-host`);
    await addHost(host, false);
    phase(`manual-${kind}-no-install-control`);
    check(
      !(await required()
        .$(`${row(host.label)}//button[starts-with(normalize-space(),"Update to v")]`)
        .isExisting()),
      "manual-has-no-install-control",
    );
    phase(`manual-${kind}-show-row-steps`);
    await click(`${row(host.label)}//button[normalize-space()="Show update steps"]`);
    phase(`manual-${kind}-read-row-steps`);
    await text(`${row(host.label)}//pre`, "# Currently running:");
    const rowSteps = await required()
      .$(`${row(host.label)}//pre`)
      .getText();
    phase(`manual-${kind}-validate-row-steps`);
    check(
      rowSteps.includes("bibcode serve") ||
        (kind === "package" && rowSteps.includes("sudo apt install")),
      "manual-restart-command",
    );
    if (kind === "archive")
      check(
        rowSteps.includes("linux-x86_64.tar.gz") && rowSteps.includes("sha256sum --check"),
        "manual-archive-platform",
      );
    if (kind === "package")
      check(
        rowSteps.includes("_amd64.deb") && rowSteps.includes(".x86_64.rpm"),
        "manual-package-platform",
      );
    if (kind === "unknown")
      check(
        rowSteps.includes("Install the new bibcode distribution for this host."),
        "manual-unknown-platform",
      );
    phase(`manual-${kind}-copy-row`);
    await click(`${row(host.label)}//button[normalize-space()="Copy"]`, (operation) =>
      phase(`manual-${kind}-copy-row-${operation}`),
    );
    phase(`manual-${kind}-copy-row-toast`);
    await text("body", "Update instructions copied");
    phase(`manual-${kind}-row-clipboard`);
    check(
      await required().executeAsync((expected, done) => {
        navigator.clipboard.readText().then(
          (value) => done(value === expected),
          () => done(false),
        );
      }, rowSteps),
      "manual-row-clipboard",
    );
    phase(`manual-${kind}-open-card`);
    await workspace();
    await click('[data-testid="environment-context-card-menu"]');
    await click('//*[@role="menuitem" and normalize-space()="Show update steps"]');
    await text(dialog, `Update ${host.label} manually`);
    phase(`manual-${kind}-read-card-steps`);
    await text(`${dialog} pre`, "# Currently running:");
    const dialogSteps = await required().$(`${dialog} pre`).getText();
    phase(`manual-${kind}-compare-row-card`);
    check(dialogSteps === rowSteps, "manual-row-card-agree");
    phase(`manual-${kind}-copy-card`);
    await click(`${dialog} button=Copy`);
    await text(dialog, "Copied");
    phase(`manual-${kind}-card-clipboard`);
    check(
      await required().executeAsync((expected, done) => {
        navigator.clipboard.readText().then(
          (value) => done(value === expected),
          () => done(false),
        );
      }, dialogSteps),
      "manual-card-clipboard",
    );
    phase(`manual-${kind}-capture`);
    await capture(`manual-${kind}`, host, dialog, `Update ${host.label} manually`);
    phase(`manual-${kind}-close-card`);
    await click(`${dialog} button=Close`);
    assertions.push({
      theme: currentTheme,
      kind: "manual-instructions",
      installKind: kind === "package" ? "system-package" : kind,
      actualPlatform: "linux-x64",
      rowAndCardAgree: true,
      actualClipboardMatched: true,
      installDispatch: "unobserved",
      interactiveInstallControlAbsent: true,
      instructionsExecuted: false,
    });
    phase(`manual-${kind}-remove-host`);
    await removeHost(host, (operation) => phase(`manual-${kind}-remove-${operation}`));
  }
}

async function restartPrimaryWithBrowserTransition(primary: Host, version: string) {
  const read = () =>
    required().execute(() => {
      const status = document
        .querySelector('[data-testid="environment-rail-local"] [data-status]')
        ?.getAttribute("data-status");
      return status === "connected" || status === "disconnected" ? status : null;
    });
  phase("reload-same-version-before-connected");
  await required().waitUntil(async () => (await read()) === "connected", {
    timeout: 30_000,
    interval: 250,
  });
  phase("reload-same-version-old-boot");
  const before = await descriptor(primary.port);
  check(typeof before.bootId === "string", "primary-before-restart-identity");
  const startedAt = performance.now(),
    deadline = startedAt + 30_000;
  const remaining = () => Math.max(1, deadline - performance.now());
  phase("reload-same-version-command");
  await owner.command(primary.child, { restart: { serverVersion: version, afterMs: 2_000 } });
  // Observe loss of the old connection before accepting the replacement's connected state.
  // Connecting/reconnecting show disconnected; missing/error/unknown is not proof.
  phase("reload-same-version-disconnected");
  await bounded(
    required().waitUntil(async () => (await read()) === "disconnected", {
      timeout: remaining(),
      interval: 250,
    }),
    remaining(),
  );
  phase("reload-same-version-new-boot");
  await owner.until(async () => {
    try {
      const after = await descriptor(primary.port);
      return (
        typeof after.bootId === "string" &&
        after.bootId !== before.bootId &&
        after.serverVersion === version
      );
    } catch {
      return false;
    }
  }, remaining());
  phase("reload-same-version-connected");
  await bounded(
    required().waitUntil(async () => (await read()) === "connected", {
      timeout: remaining(),
      interval: 250,
    }),
    remaining(),
  );
  check(performance.now() <= deadline, "primary-browser-transition-deadline");
  return {
    before: "connected",
    during: "disconnected",
    after: "connected",
    newBoot: true,
    elapsedMs: Math.round(performance.now() - startedAt),
  } as const;
}

async function reloadFlow(primary: Host, primaryWorkspace: ReloadPrimaryWorkspace | null) {
  reloadPrimaryThreadWitness = null;
  check(primaryWorkspace !== null, "owned-primary-workspace-bound");
  const primaryRead = {
    projectName: NodePath.basename(primary.project),
    ...primaryWorkspace,
    requireSelected: true,
  };
  phase("browser-reload");
  phase("reload-open-workspace");
  await workspace();
  phase("reload-select-primary");
  await click('[data-testid="environment-rail-local"]');
  const selected = decodeReloadPrimaryWorkspace(
    await required().execute(readReloadPrimaryWorkspace, primaryRead),
    primaryWorkspace,
  );
  if (selected === null) {
    phase("reload-primary-card-ready");
    await owner.until(
      async () =>
        (await required().execute(readReloadPrimaryWorkspace, {
          ...primaryRead,
          requireSelected: false,
        })) === true,
    );
    phase("reload-primary-thread-proof");
    const proof = decodeReloadPrimaryThreadProof(
      await required().execute(readReloadPrimaryThread, {
        ...primaryWorkspace,
        snapshotPath: EnvironmentOrchestrationHttpApi.endpoints.snapshot.path,
      }),
    );
    reloadPrimaryThreadWitness = proof?.witness ?? null;
    check(proof?.matched === true, "owned-primary-thread-exists");
    phase("reload-primary-card-select");
    await click(`[data-testid="primary-card-button-${primaryWorkspace.projectId}"]`);
  }
  phase("reload-primary-identity");
  await owner.until(
    async () =>
      decodeReloadPrimaryWorkspace(
        await required().execute(readReloadPrimaryWorkspace, primaryRead),
        primaryWorkspace,
      ) !== null,
  );
  phase("reload-composer-ready");
  await required().$(composer).waitForDisplayed();
  const draft = `unsent reload draft ${currentTheme}`;
  phase("reload-fill-draft");
  await required().$(composer).setValue(draft);
  phase("reload-document-before");
  const documentBefore = await required().execute(() => performance.timeOrigin);
  const sameVersionTransition = await restartPrimaryWithBrowserTransition(primary, bundleVersion);
  phase("reload-same-version-negative-control");
  const controlStart = performance.now();
  while (performance.now() - controlStart < 10_000) {
    check(
      !(await required()
        .$("button=Reload")
        .isDisplayed()
        .catch(() => false)),
      "same-bundle-no-reload-offer",
    );
    check(
      (await required().execute(() => performance.timeOrigin)) === documentBefore,
      "no-automatic-same-version-navigation",
    );
    await delay(250);
  }
  const controlElapsedMs = Math.round(performance.now() - controlStart);
  phase("reload-changed-version-restart");
  await restart(primary, "9.9.1");
  phase("reload-offer-ready");
  await text("body", "BiBCode on this server was updated to v9.9.1. Reload to use it.");
  phase("reload-offer-preserves-document");
  const offerStart = performance.now();
  while (performance.now() - offerStart < 10_000) {
    check(
      (await required().execute(() => performance.timeOrigin)) === documentBefore,
      "no-automatic-changed-version-navigation",
    );
    check((await required().$(composer).getText()).includes(draft), "reload-offer-keeps-draft");
    await delay(250);
  }
  const reloadBanner =
    '//*[@role="status" and contains(.,"BiBCode on this server was updated to v9.9.1.")]';
  phase("reload-offer-capture");
  await capture("reload-offer", primary, reloadBanner, "Reload to use it.");
  phase("reload-activate");
  await click(`${reloadBanner}//button[normalize-space()="Reload"]`);
  phase("reload-replacement-document");
  await required().waitUntil(
    async () => {
      try {
        return (await required().execute(() => performance.timeOrigin)) !== documentBefore;
      } catch {
        return false;
      }
    },
    { timeout: 30_000 },
  );
  phase("reload-restored-composer");
  await required().$(composer).waitForDisplayed();
  phase("reload-restored-primary-identity");
  check(
    decodeReloadPrimaryWorkspace(
      await required().execute(readReloadPrimaryWorkspace, primaryRead),
      primaryWorkspace,
    ) !== null,
    "actual-reload-keeps-primary-identity",
  );
  check((await required().$(composer).getText()).includes(draft), "actual-reload-keeps-draft");
  check(
    !(await required()
      .$("button=Reload")
      .isDisplayed()
      .catch(() => false)),
    "replacement-document-clears-offer",
  );
  phase("reload-result-capture");
  await capture(
    "reload-complete",
    primary,
    '[data-center-surface-host][data-visible="true"]',
    draft,
  );
  assertions.push({
    theme: currentTheme,
    kind: "actual-browser-reload",
    sameVersionTransition,
    sameVersionControlObservedMs: controlElapsedMs,
    automaticNavigation: false,
    actualUserReloadNavigation: true,
    draftRetained: true,
    observedVersion: "9.9.1",
  });
}

try {
  phase("prepare-contained-network");
  const preparedNetwork = await prepareOwnedNetwork(root);
  networkProofs.push(preparedNetwork.proof);
  terminalExecutable();
  // The immutable preview belongs to the whole run. Its launcher may exit
  // before a preview descendant, so do not stop and rebind it between themes.
  phase("start-web");
  await unusedPort(4901);
  owner.spawn(
    process.execPath,
    [
      NodePath.join(root, "scripts/run-local-vp.mjs"),
      "preview",
      "--config",
      "apps/web/vite.config.app.mjs",
      "apps/web",
      "--host",
      "127.0.0.1",
      "--port",
      "4901",
      "--strictPort",
      "--outDir",
      assets,
    ],
    {
      ...process.env,
      VITE_WS_URL: "ws://localhost:4887",
      VITE_HTTP_URL: "http://localhost:4887",
      VITE_DEV_SERVER_URL: webOrigin,
    },
    "web",
  );
  await owner.until(async () => {
    try {
      return (await fetch(webOrigin, { signal: AbortSignal.timeout(1_000) })).ok;
    } catch {
      return false;
    }
  });
  for (const theme of remoteUiThemes) {
    currentTheme = theme;
    phase("theme-driver-port");
    await unusedPort(4915);
    phase("theme-primary-start");
    const primary = await fakeHost("primary", 4887, `QA Primary ${theme}`, bundleVersion);
    phase("theme-browser-start");
    const startedBrowser = await openOwnedBrowser(
      owner,
      chrome,
      driver,
      webOrigin,
      NodePath.join(fixture, `profile-${theme}`),
    );
    browser = startedBrowser.browser;
    await browser.sendCommandAndGetResult("Page.addScriptToEvaluateOnNewDocument", {
      source: browserStartupObservationScript,
    });
    networkProofs.push(await verifyOwnedBrowserOnline(browser, preparedNetwork));
    phase("primary-pair-navigate");
    await browser.url(webOrigin + "/pair");
    phase("primary-pair-wait-token");
    await browser.$("#pairing-token").waitForDisplayed();
    phase("primary-pair-issue-grant");
    const credential = await grant(primary);
    phase("primary-pair-fill-token");
    await browser.$("#pairing-token").setValue(credential);
    phase("primary-pair-submit");
    await click("button=Continue");
    phase("primary-pair-wait-sidebar");
    await browser.$('[data-testid="sidebar-add-project-trigger"]').waitForDisplayed();
    phase("primary-import");
    await importProject(primary);
    let primaryWorkspace: ReloadPrimaryWorkspace | null = null;
    if (plan.flows.some((flow) => flow === "reload")) {
      phase("primary-bind-reload-workspace");
      await owner.until(async () => {
        primaryWorkspace = decodeReloadPrimaryWorkspace(
          await required().execute(readReloadPrimaryWorkspace, {
            projectName: NodePath.basename(primary.project),
            environmentId: null,
            projectId: null,
            threadId: null,
            sessionLinePresent: null,
            requireSelected: true,
          }),
        );
        return primaryWorkspace !== null;
      });
    }
    phase("primary-theme");
    await setTheme(theme);
    phase("primary-return-workspace");
    await workspace();
    const flows = {
      success: successFlow,
      failure: failureFlow,
      "restart-failures": restartFailures,
      queued: queuedFlow,
      manual: manualFlow,
      reload: () => reloadFlow(primary, primaryWorkspace),
    };
    for (const flow of plan.flows) await flows[flow]();
    check(
      captures.filter((capture) => capture.theme === theme).length === plan.scenes.length,
      "complete-theme-manifest",
    );
    await bounded(
      browser.deleteSession().then(() => undefined),
      15_000,
    );
    browser = undefined;
    await owner.stop(startedBrowser.driver);
    await owner.stop(primary.child);
  }
  success = true;
  phase("complete");
} catch (error) {
  if (error instanceof BrowserConnectivityFailure) networkProofs.push(error.proof);
  let startup: unknown = null;
  let setup: ReturnType<typeof projectRemoteUiSetupObservation> = null;
  let checkAgain: ReturnType<typeof projectRemoteUiCheckAgainObservation> = null;
  let successRemoval: ReturnType<typeof projectRemoteUiSuccessRemovalObservation> = null;
  if (browser) {
    try {
      const observed = await bounded(
        browser.execute(
          (input?: { checkAgain: boolean; successRemoval: boolean; theme: string }) => {
            const observer = Reflect.get(window, "__browserStartupObservation") as
              | { read?: () => unknown }
              | undefined;
            const token = document.getElementById("pairing-token");
            const form = token?.closest("form");
            const submit = form?.querySelector('button[type="submit"]');
            const error = form?.querySelector(".text-destructive");
            // Compare one bounded error surface locally; no text or input value leaves the page.
            const content = error?.textContent ?? "";
            const message = content.length <= 256 ? content.trim() : null;
            const pairingError = !form
              ? null
              : !error
                ? "none"
                : message === "Enter a pairing token to continue."
                  ? "credential-required"
                  : message === "Invalid pairing token. Check the token and try again."
                    ? "credential-rejected"
                    : message === "Timed out waiting for authenticated session after bootstrap."
                      ? "session-timeout"
                      : message !== null &&
                          /^Primary environment request failed during (exchange-bootstrap-credential|fetch-session-state|fetch-environment-descriptor) \(HTTP [1-5]\d{2}\)\.$/.test(
                            message,
                          )
                        ? "request-failed"
                        : "unknown";
            const importPath = document.getElementById("add-project-host-path");
            const importForm = importPath?.closest("form");
            const importAlert = importForm?.querySelector('[role="alert"]');
            const importContent = importAlert?.textContent ?? "";
            const importMessage = importContent.length <= 256 ? importContent.trim() : null;
            const importError = !importForm
              ? null
              : !importAlert
                ? "none"
                : importMessage === "Enter a project path."
                  ? "path-required"
                  : importMessage === "Host platform information is still loading."
                    ? "host-loading"
                    : importMessage === "Windows-style paths are only supported on Windows."
                      ? "unsupported-windows"
                      : importMessage === "Enter an absolute or home-relative path."
                        ? "path-relative"
                        : "unknown";
            // One failure-only sample. No page values, selectors or hit-test details leave it.
            const readCheckAgain = () => {
              if (input?.checkAgain !== true) return null;
              const safeLocation =
                (input.theme === "light" || input.theme === "dark") &&
                location.origin === "http://localhost:4901" &&
                location.pathname === "/settings/remote-servers" &&
                location.search === "" &&
                location.hash === "";
              if (!safeLocation) return { safeLocation: false };
              const count = (size: number) =>
                size === 0 ? "none" : size === 1 ? "one" : "multiple";
              const headings = Array.from(document.querySelectorAll("h3")).filter((heading) => {
                const content = heading.textContent ?? "";
                return content.length <= 64 && content.trim() === `QA Failure ${input.theme}`;
              });
              const rowCount = count(headings.length);
              if (headings.length !== 1) return { safeLocation, rowCount };
              const targetRow = headings[0]?.parentElement?.parentElement?.parentElement;
              if (!targetRow) return { safeLocation, rowCount: "none" };
              const buttons = Array.from(targetRow.querySelectorAll("button"));
              const label = (button: Element) => {
                const content = button.textContent ?? "";
                return content.length <= 32 ? content.trim() : null;
              };
              const controls = buttons.filter((button) =>
                ["Check", "Check again", "Checking…"].includes(label(button) ?? ""),
              );
              const control = controls.length === 1 ? controls[0]! : null;
              const visible =
                control === null
                  ? null
                  : control.getClientRects().length > 0 &&
                    getComputedStyle(control).visibility !== "hidden" &&
                    getComputedStyle(control).display !== "none";
              let hitTarget: string | null = null;
              if (control !== null && visible && typeof document.elementFromPoint === "function") {
                const rect = control.getBoundingClientRect();
                const x = rect.left + rect.width / 2,
                  y = rect.top + rect.height / 2;
                if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) {
                  hitTarget = "outside-viewport";
                } else {
                  const hit = document.elementFromPoint(x, y);
                  hitTarget =
                    hit === null
                      ? "none"
                      : control === hit || control.contains(hit)
                        ? "target"
                        : hit.closest('[data-slot="toast-viewport"]')
                          ? "toast"
                          : hit.closest(
                                '[data-slot="dialog-popup"], [data-slot="dialog-backdrop"], [data-slot="alert-dialog-popup"], [data-slot="alert-dialog-backdrop"]',
                              )
                            ? "dialog"
                            : "other";
                }
              }
              const controlLabel = control === null ? null : label(control);
              const badge =
                targetRow.querySelector("[data-variant]")?.getAttribute("data-variant") ?? null;
              return {
                safeLocation,
                rowCount,
                controlCount: count(controls.length),
                controlLabel:
                  controlLabel === "Check"
                    ? "check"
                    : controlLabel === "Check again"
                      ? "check-again"
                      : controlLabel === "Checking…"
                        ? "checking"
                        : null,
                controlVisible: visible,
                controlDisabled: control instanceof HTMLButtonElement ? control.disabled : null,
                hitTarget,
                updateActionPresent: buttons.some(
                  (button) => label(button) === "Update to v9.9.1…",
                ),
                badgeVariant:
                  badge !== null &&
                  [
                    "checking",
                    "not-checked",
                    "unreachable",
                    "check-failed",
                    "up-to-date",
                    "update-available",
                    "busy",
                    "manual",
                    "error",
                  ].includes(badge)
                    ? badge
                    : null,
                dismissPresent: buttons.some((button) => label(button) === "Dismiss"),
              };
            };
            const readSuccessRemoval = () => {
              if (input?.successRemoval !== true) return null;
              const safeLocation =
                (input.theme === "light" || input.theme === "dark") &&
                location.origin === "http://localhost:4901" &&
                location.pathname === "/settings/remote-servers" &&
                location.search === "" &&
                location.hash === "" &&
                document.documentElement.classList.contains("dark") === (input.theme === "dark") &&
                document.querySelector(
                  '#pairing-token,input[type="password"],input[autocomplete="one-time-code"],textarea[placeholder^="bibcode://pair"]',
                ) === null;
              if (!safeLocation) return { safeLocation: false };
              const count = (size: number) =>
                size === 0 ? "none" : size === 1 ? "one" : "multiple";
              const rows = Array.from(document.querySelectorAll("h3")).filter((heading) => {
                const content = heading.textContent ?? "";
                return content.length <= 64 && content.trim() === `QA Success ${input.theme}`;
              });
              const closes = Array.from(
                document.querySelectorAll('button[data-slot="toast-close"]'),
              );
              const visibleCloses = closes.filter((close) => {
                const style = getComputedStyle(close);
                return (
                  close.getClientRects().length > 0 &&
                  style.visibility !== "hidden" &&
                  style.display !== "none"
                );
              });
              const endingToasts = new Set(
                closes
                  .map((close) => close.closest("[data-ending-style]"))
                  .filter((toast) => toast !== null),
              );
              return {
                safeLocation,
                rowCount: count(rows.length),
                toastCloseCount: count(closes.length),
                visibleToastCloseCount: count(visibleCloses.length),
                endingToastCount: count(endingToasts.size),
                removalDialogPresent: document.querySelector('[role="alertdialog"]') !== null,
              };
            };
            return {
              startup: observer?.read?.() ?? null,
              checkAgain: readCheckAgain(),
              successRemoval: readSuccessRemoval(),
              setup: {
                route:
                  location.pathname === "/pair"
                    ? "pair"
                    : location.pathname === "/settings" ||
                        location.pathname.startsWith("/settings/")
                      ? "settings"
                      : "other",
                readyState: document.readyState,
                tokenPresent: token !== null,
                submitPresent: submit != null,
                submitDisabled: submit instanceof HTMLButtonElement ? submit.disabled : null,
                sidebarPresent:
                  document.querySelector('[data-testid="sidebar-add-project-trigger"]') !== null,
                importPathPresent: importPath !== null,
                importBusy: importPath?.hasAttribute("disabled") ?? null,
                importError,
                themeControlPresent:
                  document.querySelector('[aria-label="Theme preference"]') !== null,
                pairingPendingPresent:
                  document.querySelector("h1")?.textContent?.trim() ===
                  "Pairing with this environment",
                pairingError,
              },
            };
          },
          {
            checkAgain: [
              "failure-check-again",
              "failure-check-again-displayed",
              "failure-check-again-clickable",
              "failure-check-again-click",
              "failure-check-again-row",
            ].includes(currentPhase),
            successRemoval: Object.values(SUCCESS_REMOVE_PHASES).some(
              (value) => value === currentPhase,
            ),
            theme: currentTheme,
          },
        ),
        2_000,
      );
      startup = projectBrowserStartupObservation(observed.startup);
      setup = projectRemoteUiSetupObservation(observed.setup);
      checkAgain = projectRemoteUiCheckAgainObservation(observed.checkAgain);
      successRemoval = projectRemoteUiSuccessRemovalObservation(observed.successRemoval);
    } catch {
      /* Closed unavailable evidence; no fallback app state. */
    }
  }
  write("failure", {
    phase: currentPhase,
    theme: currentTheme,
    failure: classifyQualificationFailure(error),
    manualAssertionCode: readManualAssertionCode(error),
    startup,
    setup,
    checkAgain,
    successRemoval,
    toastErrorSignature:
      [
        "success-remove-toast-click-unrecognized",
        "manual-archive-remove-toast-click-unrecognized",
        "manual-package-remove-toast-click-unrecognized",
        "manual-unknown-remove-toast-click-unrecognized",
      ].includes(currentPhase) &&
      error !== null &&
      typeof error === "object"
        ? (toastErrorSignatureFailures.get(error) ?? null)
        : null,
    reloadPrimaryThreadProof:
      currentPhase === "reload-primary-thread-proof"
        ? projectReloadPrimaryThreadWitness(reloadPrimaryThreadWitness)
        : null,
  });
} finally {
  const beforeCleanup = owner.processes.map(({ child, role, log, spawnFailure }) =>
    projectQualificationProcess({
      role,
      log,
      spawnFailure,
      exitCode: child.exitCode,
      signal: child.signalCode,
    }),
  );
  if (
    beforeCleanup.some(
      (entry) => !entry.logReadable || entry.logTruncated || entry.guardRefusals !== 0,
    )
  )
    success = false;
  await owner.close({
    ...(browser ? { browser: () => browser!.deleteSession().then(() => undefined) } : {}),
    proxies: tunnels,
  });
  if (owner.failures.length > 0 || !owner.childrenClosed()) success = false;
  write("result", {
    success,
    phase: currentPhase,
    theme: currentTheme,
    source: process.env.BIBCODE_UPLOAD_SOURCE,
    bundleVersion,
    selection: plan.selection,
    completeBrowserMatrix: success && plan.selection === "full",
    pendingCases: plan.pendingCases,
    captures,
    assertions,
    networkProofs,
    beforeCleanup,
    cleanupFailures: owner.failures,
    childProcessesClosed: owner.childrenClosed(),
    scope:
      "Linux Chromium remote-update UI only; native host toast is tests-only; final issue29 sweep is not qualified.",
  });
}
process.exitCode = success ? 0 : 1;
