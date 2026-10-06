// @effect-diagnostics nodeBuiltinImport:off - Disposable CI owns the immutable packaged app, private logs and native driver.
// @effect-diagnostics globalFetch:off - Only the owned loopback driver and discovered loopback metadata endpoint are read.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeNet from "node:net";
import { remote } from "webdriverio";
import {
  bounded,
  prepareOwnedNetwork,
  QualificationOwner,
  type QualificationBrowser,
} from "./support/qualification-owner.ts";
import { createNativeSharingHostNetwork } from "./support/release-visual-native-sharing-host.ts";
import { createNativeSharingRoutePorts } from "./support/release-visual-native-sharing-network.ts";
import {
  readNativeSharingRoute,
  withNativeSharingRoute,
} from "./support/release-visual-native-sharing-route.ts";
import { withNativeSharingApplication } from "./support/release-visual-native-sharing-application.ts";
import {
  createNativeSharingBrowserPorts,
  type NativeSharingBrowserPreparationFacts,
} from "./support/release-visual-native-sharing-browser.ts";
import {
  collectNativeSharingIdentity,
  readNativeSharingBridge,
  validateNativeSharingIdentity,
  type NativeSharingIdentityPin,
} from "./support/release-visual-native-sharing-identity.ts";
import { runNativeSharingVisual } from "./support/release-visual-native-sharing.ts";
import { normalizeWebDriverRequest } from "./support/webdriver-request.ts";
import {
  classifyQualificationFailure,
  projectQualificationProcess,
} from "./support/chat-upload-evidence.ts";
import { EnvironmentMetadataHttpApi } from "../../../packages/contracts/src/environmentHttp.ts";

interface NativeSharingAdmissionFacts extends NativeSharingBrowserPreparationFacts {
  windowHandlesArray: boolean;
  windowMainOnly: boolean;
  windowCurrentMain: boolean;
  bridgeReady: boolean;
  initialBridgeReturned: boolean;
  endpointHttp: boolean;
  endpointLoopback: boolean;
  endpointCleanAuthority: boolean;
  endpointCleanQuery: boolean;
  endpointRootPath: boolean;
  descriptorResponseOk: boolean;
  descriptorJsonReturned: boolean;
  identityCollected: boolean;
  descriptorBootPresent: boolean;
  descriptorStoragePresent: boolean;
  originalUrlReturned: boolean;
  originalSizeReturned: boolean;
  initialIdentityVerified: boolean;
  uiWindowSizeSet: boolean;
  uiNavigationCompleted: boolean;
  uiPortsCreated: boolean;
  cleanupPrepareSucceeded: boolean;
  cleanupPrepareFailed: boolean;
  cleanupSessionDeleted: boolean;
  cleanupSessionDeleteFailed: boolean;
  cleanupUnsafe: boolean;
}
export async function closeNativeSharingSession(
  browser: QualificationBrowser,
  observe?: (facts: Partial<NativeSharingAdmissionFacts>) => void,
): Promise<void> {
  let failed = false,
    original: unknown;
  const facts: Partial<NativeSharingAdmissionFacts> = {};
  try {
    const prepared = await bounded(
      browser.execute(async () => {
        const host = window as Window & {
          __TAURI__?: { core?: { invoke?: (command: string) => Promise<unknown> } };
        };
        const invoke = host.__TAURI__?.core?.invoke;
        if (typeof invoke !== "function") return false;
        // Keep the main window alive until its driver session has been joined.
        await invoke("desktop_e2e_prepare_for_exit");
        return true;
      }),
      15000,
    );
    facts.cleanupPrepareSucceeded = prepared === true;
    if (prepared !== true) throw new Error("Owned native backend preparation refused.");
  } catch (error) {
    facts.cleanupPrepareFailed = true;
    failed = true;
    original = error;
  }
  try {
    await bounded(browser.deleteSession(), 15000);
    facts.cleanupSessionDeleted = true;
  } catch (error) {
    facts.cleanupSessionDeleteFailed = true;
    if (!failed) {
      failed = true;
      original = error;
    }
  }
  try {
    observe?.(facts);
  } catch {
    /* Optional attribution cannot replace preparation/deletion. */
  }
  if (failed) throw original;
}

export async function verifyNativeSharingWindow(
  browser: Pick<QualificationBrowser, "getWindowHandles" | "getWindowHandle">,
): Promise<void> {
  const handles = await browser.getWindowHandles();
  if (
    !Array.isArray(handles) ||
    handles.length !== 1 ||
    handles[0] !== "main" ||
    (await browser.getWindowHandle()) !== "main"
  )
    throw new Error("Owned native window identity refused.");
}

/** The native entry point is invoked only by the existing private Linux PID1 owner. */
export async function qualifyNativeSharing(
  environment: NodeJS.ProcessEnv,
  platform: string,
): Promise<void> {
  const root = NodePath.resolve(import.meta.dirname, "../../.."),
    fixture = environment.BIBCODE_UPLOAD_FIXTURE,
    evidence = environment.BIBCODE_UPLOAD_EVIDENCE,
    app = environment.BIBCODE_NATIVE_SHARING_APP,
    xvfb = environment.BIBCODE_NATIVE_SHARING_XVFB;
  const refused = () => new Error("Owned native sharing qualification refused.");
  if (!fixture || !evidence || !app || !xvfb || environment.BIBCODE_HERMETIC_GUARD !== undefined)
    throw refused();
  const owner = new QualificationOwner(root, fixture),
    captured = new Set<string>(),
    captures: Readonly<Record<string, unknown>>[] = [];
  let unsafe = false,
    phase = "native-admission",
    failed = false,
    failure: unknown;
  const markUnsafe = () => {
    unsafe = true;
  };
  const write = (name: string, value: object) =>
    NodeFS.writeFileSync(NodePath.join(evidence, name + ".json"), JSON.stringify(value), {
      mode: 0o600,
    });
  const observation: Partial<NativeSharingAdmissionFacts> = {};
  const step = (value: string) => {
    phase = value;
    write("phase", { phase, observation });
  };
  const observe = (facts: Partial<NativeSharingAdmissionFacts>) => {
    Object.assign(observation, facts);
    try {
      write("phase", { phase, observation });
    } catch {
      markUnsafe();
    }
  };
  const inputs = new Map<string, { stat: string; sha256: string }>();
  let outcome: object | undefined;
  const pin = (path: string) => {
    const stat = NodeFS.lstatSync(path);
    if (
      !NodePath.isAbsolute(path) ||
      NodeFS.realpathSync(path) !== path ||
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o022) !== 0 ||
      (stat.mode & 0o111) === 0 ||
      stat.size < 1 ||
      stat.size > 512 * 1024 * 1024
    )
      throw refused();
    return {
      stat: [stat.dev, stat.ino, stat.uid, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(
        ":",
      ),
      sha256: NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex"),
    };
  };
  try {
    const networkInput = await createNativeSharingHostNetwork(
      { environment, platform },
      owner,
      markUnsafe,
    );
    for (const path of [app, xvfb]) inputs.set(path, pin(path));
    step("native-network");
    const network = await prepareOwnedNetwork(root),
      routePorts = createNativeSharingRoutePorts(networkInput);
    const guard = async () => {
      if (!(await networkInput.verifyExecutable())) throw refused();
      for (const [path, expected] of inputs) {
        const stat = NodeFS.lstatSync(path);
        if (
          [stat.dev, stat.ino, stat.uid, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs].join(
            ":",
          ) !== expected.stat
        )
          throw refused();
      }
    };
    const dataRoot = NodePath.join(fixture, "native-state"),
      userdata = NodePath.join(dataRoot, "userdata");
    NodeFS.mkdirSync(dataRoot, { mode: 0o700 });
    NodeFS.mkdirSync(userdata, { mode: 0o700 });
    const drivers = ["codex", "claudeAgent", "cursor", "grok", "opencode"];
    NodeFS.writeFileSync(
      NodePath.join(userdata, "settings.json"),
      JSON.stringify({
        enableProviderUpdateChecks: false,
        providers: Object.fromEntries(
          drivers.map((driver) => [
            driver,
            { enabled: false, binaryPath: NodePath.join(fixture, "absent-" + driver) },
          ]),
        ),
        providerInstances: Object.fromEntries(
          drivers.map((driver) => [
            driver,
            {
              driver,
              enabled: false,
              config: { binaryPath: NodePath.join(fixture, "absent-" + driver) },
            },
          ]),
        ),
      }),
      { mode: 0o600, flag: "wx" },
    );
    const childEnvironment = {
      ...environment,
      PATH: NodePath.join(fixture, "bin"),
      DISPLAY: ":99",
      BIBCODE_HOME: dataRoot,
      APPIMAGE_EXTRACT_AND_RUN: "1",
      WDIO_EMBEDDED_SERVER: "true",
      TAURI_WEBDRIVER_PORT: "4445",
      WEBKIT_DISABLE_DMABUF_RENDERER: "1",
    };
    let attached: QualificationBrowser | undefined;
    outcome = await withNativeSharingApplication(
      {
        guard,
        start: async () => {
          // Refuse an existing listener before admitting this app's embedded driver.
          await new Promise<void>((resolve, reject) => {
            const probe = NodeNet.createServer();
            probe.once("error", () => reject(refused()));
            probe.listen(4445, "127.0.0.1", () =>
              probe.close((error) => (error ? reject(refused()) : resolve())),
            );
          });
          step("native-display");
          if (NodeFS.existsSync("/tmp/.X11-unix/X99") || NodeFS.existsSync("/tmp/.X99-lock"))
            throw refused();
          owner.spawn(
            xvfb,
            [":99", "-screen", "0", "1280x960x24", "-nolisten", "tcp"],
            { ...environment },
            "web",
          );
          await owner.until(async () => NodeFS.existsSync("/tmp/.X11-unix/X99"));
          step("native-app-start");
          owner.spawn(app, [], childEnvironment, "primary");
          await owner.until(async () => {
            try {
              const response = await fetch("http://127.0.0.1:4445/status", {
                signal: AbortSignal.timeout(1000),
              });
              if (!response.ok) return false;
              const value: unknown = await response.json();
              return (
                typeof value === "object" &&
                value !== null &&
                "value" in value &&
                typeof value.value === "object" &&
                value.value !== null &&
                "ready" in value.value &&
                value.value.ready === true
              );
            } catch {
              return false;
            }
          });
        },
        connect: async () => {
          step("native-session");
          attached = await bounded(
            remote({
              hostname: "127.0.0.1",
              port: 4445,
              path: "/",
              logLevel: "silent",
              connectionRetryCount: 0,
              connectionRetryTimeout: 30000,
              waitforTimeout: 30000,
              transformRequest: normalizeWebDriverRequest,
              capabilities: {
                browserName: "wry",
                "wdio:enforceWebDriverClassic": true,
                "wdio:tauriServiceOptions": { windowLabel: "main", driverProvider: "embedded" },
              },
            }),
            45000,
          );
          return attached;
        },
        disconnect: async (browser) => {
          await closeNativeSharingSession(browser, observe);
        },
        stop: async () => {
          await owner.close();
          if (owner.failures.length || !owner.childrenClosed()) throw refused();
        },
        unsafeCleanup: () => {
          markUnsafe();
          observe({ cleanupUnsafe: true });
        },
      },
      async (browser) => {
        step("native-bridge-ready");
        step("native-window-handles");
        const handles = await browser.getWindowHandles(),
          mainOnly = JSON.stringify(handles) === JSON.stringify(["main"]);
        observe({ windowHandlesArray: Array.isArray(handles), windowMainOnly: mainOnly });
        if (!mainOnly) throw refused();
        step("native-window-current");
        const current = await browser.getWindowHandle();
        observe({ windowCurrentMain: current === "main" });
        if (current !== "main") throw refused();
        step("native-bridge-ready");
        await owner.until(async () => {
          try {
            const value = await browser.execute(readNativeSharingBridge),
              ready = value.metadata.host === "tauri";
            observe({ bridgeReady: ready });
            return ready;
          } catch {
            return false;
          }
        });
        step("native-bridge-initial");
        const initial = await browser.execute(readNativeSharingBridge),
          endpoint = initial.endpoint;
        observe({ initialBridgeReturned: true });
        step("native-endpoint-admission");
        const address = new URL(endpoint);
        observe({
          endpointHttp: address.protocol === "http:",
          endpointLoopback: address.hostname === "127.0.0.1",
          endpointCleanAuthority: !address.username && !address.password,
          endpointCleanQuery: !address.search && !address.hash,
          endpointRootPath: ["", "/"].includes(address.pathname),
        });
        if (
          address.protocol !== "http:" ||
          address.hostname !== "127.0.0.1" ||
          address.username ||
          address.password ||
          address.search ||
          address.hash ||
          !["", "/"].includes(address.pathname)
        )
          throw refused();
        let firstDescriptor = true;
        const descriptor = async () => {
          await guard();
          if (firstDescriptor) step("native-initial-descriptor");
          const response = await fetch(
            address.origin + EnvironmentMetadataHttpApi.endpoints.descriptor.path,
            { signal: AbortSignal.timeout(1000) },
          );
          if (firstDescriptor) observe({ descriptorResponseOk: response.ok });
          if (!response.ok) throw refused();
          const value = await response.json();
          if (firstDescriptor) observe({ descriptorJsonReturned: true });
          return value;
        };
        step("native-initial-identity-read");
        const first = await collectNativeSharingIdentity({ browser, endpoint, descriptor });
        firstDescriptor = false;
        step("native-initial-identity-admission");
        observe({
          identityCollected: true,
          descriptorBootPresent: typeof first.descriptor.bootId === "string",
          descriptorStoragePresent: typeof first.descriptor.storageInstanceId === "string",
        });
        if (
          typeof first.descriptor.bootId !== "string" ||
          typeof first.descriptor.storageInstanceId !== "string"
        )
          throw refused();
        const identity: NativeSharingIdentityPin = {
          bootId: first.descriptor.bootId,
          storageInstanceId: first.descriptor.storageInstanceId,
          serverVersion: first.descriptor.serverVersion,
          endpoint,
        };
        step("native-original-url");
        const original = await browser.getUrl();
        observe({ originalUrlReturned: true });
        step("native-original-size");
        const originalSize = await browser.getWindowSize();
        observe({ originalSizeReturned: true });
        let route: "owned" | "absent" = "owned";
        const verify = async () => {
          await guard();
          await verifyNativeSharingWindow(browser);
          validateNativeSharingIdentity(
            await collectNativeSharingIdentity({ browser, endpoint, descriptor }),
            identity,
            route,
          );
        };
        step("native-initial-verification");
        await verify();
        observe({ initialIdentityVerified: true });
        let visualFailed = false,
          visualFailure: unknown,
          summary: object | undefined;
        try {
          step("native-ui-window-size");
          await browser.setWindowSize(1280, 960);
          observe({ uiWindowSizeSet: true });
          step("native-ui-navigation");
          await browser.url("tauri://localhost/#/settings/general");
          observe({ uiNavigationCompleted: true });
          step("native-ui-ports");
          const ports = await createNativeSharingBrowserPorts({
            browser,
            owner,
            evidence,
            captured,
            identity: verify,
            unsafeCleanup: markUnsafe,
            onPreparationStage: step,
            onPreparationFacts: observe,
            routeScope: (run) =>
              withNativeSharingRoute(routePorts, async (scope) => {
                route = "absent";
                try {
                  await run(scope);
                } finally {
                  route = "owned";
                }
              }),
            verifyRoute: async (scope, expected) => {
              await readNativeSharingRoute(scope, expected);
              route = expected;
            },
            onCapture: (capture) => {
              captures.push(capture);
              write("assertions", { captures });
            },
            onScene: (scene, theme) => step(scene + "-" + theme),
          });
          observe({ uiPortsCreated: true });
          step("native-sharing-scenes");
          summary = await runNativeSharingVisual(ports);
        } catch (error) {
          visualFailed = true;
          visualFailure = error;
        }
        try {
          await browser.url(original);
          await browser.setWindowSize(originalSize.width, originalSize.height);
          await verify();
        } catch (error) {
          markUnsafe();
          if (!visualFailed) {
            visualFailed = true;
            visualFailure = error;
          }
        }
        if (visualFailed) throw visualFailure;
        if (captured.size !== 4 || captures.length !== 4 || unsafe) throw refused();
        return {
          ...summary,
          captures,
          network: network.proof,
          source: environment.BIBCODE_UPLOAD_SOURCE,
          appSha256: inputs.get(app)!.sha256,
          xvfbSha256: inputs.get(xvfb)!.sha256,
        };
      },
    );
    for (const [path, expected] of inputs)
      if (pin(path).sha256 !== expected.sha256) throw refused();
    if (unsafe) throw refused();
    step("native-complete");
  } catch (error) {
    failed = true;
    failure = error;
    try {
      write("failure", { phase, failure: classifyQualificationFailure(error), observation });
    } catch {
      markUnsafe();
    }
  } finally {
    await owner.close();
    const processes = owner.processes.map((entry) =>
      projectQualificationProcess({
        role: entry.role,
        exitCode: entry.child.exitCode,
        signal: entry.child.signalCode,
        spawnFailure: entry.spawnFailure,
        log: entry.log,
      }),
    );
    if (
      processes.length > 512 ||
      processes.some(
        (entry) => !entry.logReadable || entry.logTruncated || entry.guardRefusals !== 0,
      )
    )
      markUnsafe();
    const closed = owner.childrenClosed() && owner.failures.length === 0 && !unsafe;
    try {
      write("owned-cleanup", {
        processCount: Math.min(processes.length, 512),
        processes: processes.slice(0, 512),
        childProcessesClosed: owner.childrenClosed(),
        cleanupFailures: owner.failures,
        unsafe,
      });
      write("result", {
        ...outcome,
        captures,
        selection: "release-visual-native-sharing",
        source: environment.BIBCODE_UPLOAD_SOURCE,
        complete: !failed && closed && captures.length === 4,
        childProcessesClosed: owner.childrenClosed(),
        cleanupFailures: owner.failures,
        nativeSharingFixtureSafeToDelete: closed && inputs.size === 2,
      });
    } catch (error) {
      markUnsafe();
      if (!failed) {
        failed = true;
        failure = error;
      }
    }
  }
  if (failed) throw failure;
  if (!owner.childrenClosed() || owner.failures.length || unsafe) throw refused();
}

if (import.meta.main) {
  // oxlint-disable-next-line bibcode/no-global-process-runtime -- The standalone CI controller detects its native host once.
  qualifyNativeSharing(process.env, process.platform).catch(() => {
    process.exitCode = 1;
  });
}
