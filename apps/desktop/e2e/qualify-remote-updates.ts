// @effect-diagnostics nodeBuiltinImport:off - Disposable CI qualifier owns all paths/processes.
// @effect-diagnostics globalFetch:off - Only owned loopback descriptors are read.
// @effect-diagnostics globalTimers:off - Live qualification uses real bounded waits.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeNet from "node:net";
import { startThrottleProxy } from "../../../scripts/throttle-proxy.ts";
import { EnvironmentMetadataHttpApi } from "../../../packages/contracts/src/environmentHttp.ts";
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
  type RemoteUiTheme,
  type RemoteUiScene,
} from "./support/remote-ui-evidence.ts";
import { callFixtureRpc } from "./support/remote-ui-rpc.ts";

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
function check(value: unknown, code: string): asserts value {
  if (value !== true) throw new Error(`UI qualification assertion failed: ${code}.`);
}
const required = () => {
  if (!browser) throw new Error("Owned browser is unavailable.");
  return browser;
};
const element = (selector: string) => {
  const scopedText = /^(.*) (button=[^\n]+)$/.exec(selector);
  return scopedText ? required().$(scopedText[1]!).$(scopedText[2]!) : required().$(selector);
};
const click = async (selector: string) => {
  const target = element(selector);
  await target.waitForDisplayed();
  await target.waitForEnabled();
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

async function addHost(host: Host, interactive = true) {
  await settings();
  await click('button[aria-label="Add Server"]');
  await required().$(dialog).waitForDisplayed();
  await required().$(`${dialog} input[placeholder="e.g. Linux workstation"]`).setValue(host.label);
  await required()
    .$(`${dialog} textarea[placeholder="bibcode://pair?code=…"]`)
    .setValue(await offer(host));
  const acknowledgement = required().$(`${dialog} [role="checkbox"]`);
  if (await acknowledgement.isDisplayed().catch(() => false)) {
    check(host.closeTunnel !== undefined, "actual-tunnel-before-acknowledgement");
    await acknowledgement.click();
  }
  await click(`${dialog} button=Add Server`);
  await required().$(dialog).waitForDisplayed({ reverse: true });
  await text(row(host.label), host.label);
  await selectHost(host);
  await settings();
  await click(`${row(host.label)}//button[normalize-space()="Check"]`);
  await text(row(host.label), interactive ? "Update to v9.9.1…" : "Manual updates");
}

async function removeHost(host: Host) {
  await settings();
  await click(`button[aria-label="More actions for ${host.label}"]`);
  await click('//*[@role="menuitem" and normalize-space()="Remove server…"]');
  await click('[role="alertdialog"] button=Remove server');
  await required().$(row(host.label)).waitForExist({ reverse: true });
  await owner.stop(host.child);
  if (host.closeTunnel) await bounded(host.closeTunnel(), 5_000);
  // End a completed fixture case through the real notification controls.
  for (const close of await required().$$('button[data-slot="toast-close"]')) {
    if (await close.isDisplayed().catch(() => false)) await close.click();
  }
}

async function importProject(host: Host) {
  const primaryPhase = (name: string) => {
    if (host.devUrl) phase(name);
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
  phase("success-flow");
  const host = await fakeHost("update-a", 4888, `QA Success ${currentTheme}`);
  await addHost(host);
  await importProject(host);
  const draft = `retained update draft ${currentTheme}`;
  await required().$(composer).setValue(draft);
  await settings();
  await capture("initial-row", host, row(host.label), "Update to v9.9.1…");
  await workspace();
  await capture("initial-card", host, card, host.label);
  await openConfirmation(host, "row");
  await text(dialog, "Nothing is running on it now.");
  await capture("confirm-row", host, dialog, `Update ${host.label} to v9.9.1?`);
  await cancel();
  await exactRequests(host, 0);
  await workspace();
  check((await required().$(composer).getText()).includes(draft), "row-cancel-keeps-draft");
  await openConfirmation(host, "card");
  await capture("confirm-card", host, dialog, `Update ${host.label} to v9.9.1?`);
  await cancel();
  await exactRequests(host, 0);
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
  await removeHost(host);
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
  await click(`${row(host.label)}//button[normalize-space()="Dismiss"]`);
  await required()
    .$(`${row(host.label)}//button[normalize-space()="Dismiss"]`)
    .waitForExist({ reverse: true });
  await status(host, "update-available");
  await click(
    `${row(host.label)}//button[normalize-space()="Check again" or normalize-space()="Check"]`,
  );
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
  await click(`${row(wrong.label)}//button[normalize-space()="Retry"]`);
  await text(dialog, `Update ${wrong.label} to v9.9.1?`);
  await cancel();
  await exactRequests(wrong, 1);
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
  for (const host of hosts) await removeHost(host);
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
    const host = await manualHost(kind);
    const actual = await descriptor(host.port);
    check(
      actual.platform?.os === "linux" && actual.platform.arch === "x64",
      "manual-observed-platform",
    );
    check(
      actual.remoteUpdateSupport?.installKind === (kind === "package" ? "system-package" : kind),
      "manual-observed-install-kind",
    );
    await addHost(host, false);
    check(
      !(await required()
        .$(`${row(host.label)}//button[starts-with(normalize-space(),"Update to v")]`)
        .isExisting()),
      "manual-has-no-install-control",
    );
    await click(`${row(host.label)}//button[normalize-space()="Show update steps"]`);
    const rowSteps = await required()
      .$(`${row(host.label)}//pre`)
      .getText();
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
    await click(`${row(host.label)}//button[normalize-space()="Copy"]`);
    await text("body", "Update instructions copied");
    check(
      await required().executeAsync((expected, done) => {
        navigator.clipboard.readText().then(
          (value) => done(value === expected),
          () => done(false),
        );
      }, rowSteps),
      "manual-row-clipboard",
    );
    await workspace();
    await click('[data-testid="environment-context-card-menu"]');
    await click('//*[@role="menuitem" and normalize-space()="Show update steps"]');
    await text(dialog, `Update ${host.label} manually`);
    const dialogSteps = await required().$(`${dialog} pre`).getText();
    check(dialogSteps === rowSteps, "manual-row-card-agree");
    await click(`${dialog} button=Copy`);
    await text(dialog, "Copied");
    check(
      await required().executeAsync((expected, done) => {
        navigator.clipboard.readText().then(
          (value) => done(value === expected),
          () => done(false),
        );
      }, dialogSteps),
      "manual-card-clipboard",
    );
    await capture(`manual-${kind}`, host, dialog, `Update ${host.label} manually`);
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
    await removeHost(host);
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
  await required().waitUntil(async () => (await read()) === "connected", {
    timeout: 30_000,
    interval: 250,
  });
  const before = await descriptor(primary.port);
  check(typeof before.bootId === "string", "primary-before-restart-identity");
  const startedAt = performance.now(),
    deadline = startedAt + 30_000;
  const remaining = () => Math.max(1, deadline - performance.now());
  await owner.command(primary.child, { restart: { serverVersion: version, afterMs: 2_000 } });
  // Observe loss of the old connection before accepting the replacement's connected state.
  // Connecting/reconnecting show disconnected; missing/error/unknown is not proof.
  await bounded(
    required().waitUntil(async () => (await read()) === "disconnected", {
      timeout: remaining(),
      interval: 250,
    }),
    remaining(),
  );
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

async function reloadFlow(primary: Host) {
  phase("browser-reload");
  await workspace();
  await click('[data-testid="environment-rail-local"]');
  await required().$(composer).waitForDisplayed();
  const draft = `unsent reload draft ${currentTheme}`;
  await required().$(composer).setValue(draft);
  const documentBefore = await required().execute(() => performance.timeOrigin);
  const sameVersionTransition = await restartPrimaryWithBrowserTransition(primary, bundleVersion);
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
  await restart(primary, "9.9.1");
  await text("body", "BiBCode on this server was updated to v9.9.1. Reload to use it.");
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
  await capture("reload-offer", primary, reloadBanner, "Reload to use it.");
  await click(`${reloadBanner}//button[normalize-space()="Reload"]`);
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
  await required().$(composer).waitForDisplayed();
  check((await required().$(composer).getText()).includes(draft), "actual-reload-keeps-draft");
  check(
    !(await required()
      .$("button=Reload")
      .isDisplayed()
      .catch(() => false)),
    "replacement-document-clears-offer",
  );
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
  for (const theme of remoteUiThemes) {
    currentTheme = theme;
    phase("start-theme");
    await unusedPort(4901);
    await unusedPort(4915);
    const primary = await fakeHost("primary", 4887, `QA Primary ${theme}`, bundleVersion);
    const web = owner.spawn(
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
      reload: () => reloadFlow(primary),
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
    await owner.stop(web);
    await owner.stop(primary.child);
  }
  success = true;
  phase("complete");
} catch (error) {
  if (error instanceof BrowserConnectivityFailure) networkProofs.push(error.proof);
  let startup: unknown = null;
  let setup: ReturnType<typeof projectRemoteUiSetupObservation> = null;
  if (browser) {
    try {
      const observed = await bounded(
        browser.execute(() => {
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
          return {
            startup: observer?.read?.() ?? null,
            setup: {
              route:
                location.pathname === "/pair"
                  ? "pair"
                  : location.pathname === "/settings" || location.pathname.startsWith("/settings/")
                    ? "settings"
                    : "other",
              readyState: document.readyState,
              tokenPresent: token !== null,
              submitPresent: submit != null,
              submitDisabled: submit instanceof HTMLButtonElement ? submit.disabled : null,
              sidebarPresent:
                document.querySelector('[data-testid="sidebar-add-project-trigger"]') !== null,
              importPathPresent: document.getElementById("add-project-host-path") !== null,
              themeControlPresent:
                document.querySelector('[aria-label="Theme preference"]') !== null,
              pairingPendingPresent:
                document.querySelector("h1")?.textContent?.trim() ===
                "Pairing with this environment",
              pairingError,
            },
          };
        }),
        2_000,
      );
      startup = projectBrowserStartupObservation(observed.startup);
      setup = projectRemoteUiSetupObservation(observed.setup);
    } catch {
      /* Closed unavailable evidence; no fallback app state. */
    }
  }
  write("failure", {
    phase: currentPhase,
    theme: currentTheme,
    failure: classifyQualificationFailure(error),
    startup,
    setup,
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
