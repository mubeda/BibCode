// @effect-diagnostics nodeBuiltinImport:off - Inspect and execute only inert portions of the QA controller.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import {
  decodeReloadPrimaryWorkspace,
  decodeReloadPrimaryThreadProof,
  projectReloadPrimaryThreadWitness,
  readReloadPrimaryThread,
  readReloadPrimaryWorkspace,
} from "./remote-ui-primary-workspace.ts";
import {
  manualUpdateSteps,
  remoteUpdateConfirmation,
} from "../../../web/src/components/settings/remoteUpdatePresentation.ts";
import {
  remoteUiPlan,
  remoteUiScenes,
  remoteUiThemes,
  screenshotName,
  projectRemoteUiSetupObservation,
  projectRemoteUiCheckAgainObservation,
} from "./remote-ui-evidence.ts";

const controller = NodeFS.readFileSync(
  new URL("../qualify-remote-updates.ts", import.meta.url),
  "utf8",
);

it.each([false, true])(
  "keeps one immutable asset server across fresh theme fixtures and final cleanup (dark failure: %s)",
  async (failDark) => {
    let assetListener = false;
    let webStarts = 0;
    let browserStarts = 0;
    let finalCleanup = false;
    const portChecks: number[] = [];
    const stopped: string[] = [];
    const writes = new Map<string, Record<string, unknown>>();
    const contexts: string[] = [];
    const scope: Record<string, any> = {
      root: "/owned-source",
      fixture: "/owned-fixture",
      assets: "/owned-assets",
      chrome: "/owned-chrome",
      driver: "/owned-driver",
      webOrigin: "http://localhost:4901",
      bundleVersion: "0.7.2",
      NodePath,
      process: { execPath: "/owned-node", env: {}, exitCode: undefined },
      currentTheme: "light",
      currentPhase: "prepare",
      success: false,
      browser: undefined,
      captures: [],
      assertions: [],
      networkProofs: [],
      tunnels: [],
      plan: { flows: ["success"], scenes: ["success"], selection: "core", pendingCases: [] },
      remoteUiThemes,
      browserStartupObservationScript: "",
      prepareOwnedNetwork: async () => ({ proof: {} }),
      terminalExecutable: () => {},
      phase: (name: string) => {
        scope.currentPhase = name;
      },
      unusedPort: async (port: number) => {
        portChecks.push(port);
        // run-local-vp waits synchronously for its preview child. Stopping that
        // launcher does not close the child's listener; PID1 owns final cleanup.
        if (port === 4901 && assetListener) throw new Error("Owned fixture port is occupied.");
      },
      fakeHost: async () => {
        contexts.push(scope.currentTheme);
        return { child: { role: `primary-${scope.currentTheme}` } };
      },
      fetch: async () => ({ ok: true }),
      AbortSignal,
      openOwnedBrowser: async () => {
        browserStarts++;
        if (failDark && scope.currentTheme === "dark") throw new Error("inert dark startup");
        return {
          driver: { role: `driver-${scope.currentTheme}` },
          browser: {
            sendCommandAndGetResult: async () => {},
            url: async () => {},
            $: () => ({ waitForDisplayed: async () => {}, setValue: async () => {} }),
            deleteSession: async () => {},
            execute: async () => {
              throw new Error("inert unavailable observation");
            },
          },
        };
      },
      verifyOwnedBrowserOnline: async () => ({}),
      grant: async () => "inert-credential",
      click: async () => {},
      importProject: async () => {},
      setTheme: async () => {},
      workspace: async () => {},
      successFlow: async () => {
        scope.captures.push({ theme: scope.currentTheme });
      },
      failureFlow: async () => {},
      restartFailures: async () => {},
      queuedFlow: async () => {},
      manualFlow: async () => {},
      reloadFlow: async () => {},
      check: (ok: boolean) => {
        if (!ok) throw new Error("inert acceptance failure");
      },
      bounded: async (promise: Promise<unknown>) => promise,
      BrowserConnectivityFailure: class extends Error {},
      classifyQualificationFailure: () => ({ kind: "inert" }),
      readManualAssertionCode: () => null,
      write: (name: string, value: Record<string, unknown>) => writes.set(name, value),
      owner: {
        processes: [],
        failures: [],
        spawn: (_command: string, _args: string[], _env: unknown, role: string) => {
          expect(role).toBe("web");
          expect(assetListener).toBe(false);
          webStarts++;
          assetListener = true;
          return { role };
        },
        until: async (check: () => Promise<boolean>) => {
          expect(await check()).toBe(true);
        },
        stop: async (entry: { role: string }) => {
          stopped.push(entry.role);
        },
        close: async () => {
          finalCleanup = true;
          assetListener = false;
        },
        childrenClosed: () => finalCleanup,
      },
    };
    const start = controller.indexOf('try {\n  phase("prepare-contained-network");');
    expect(start).toBeGreaterThan(0);
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        "async function run() {" + controller.slice(start) + "}\nrun",
      ),
      scope,
    );
    await run();
    expect(webStarts).toBe(1);
    expect(browserStarts).toBe(2);
    expect(contexts).toEqual(["light", "dark"]);
    expect(portChecks.filter((port) => port === 4901)).toHaveLength(1);
    expect(portChecks.filter((port) => port === 4915)).toHaveLength(2);
    expect(stopped).toEqual(
      failDark
        ? ["driver-light", "primary-light"]
        : ["driver-light", "primary-light", "driver-dark", "primary-dark"],
    );
    expect(finalCleanup).toBe(true);
    expect(assetListener).toBe(false);
    expect(writes.get("result")?.success).toBe(!failDark);
    expect(writes.get("result")?.childProcessesClosed).toBe(true);
    expect(scope.process.exitCode).toBe(failDark ? 1 : 0);
  },
);

it("projects only allowlisted manual checks raised by this controller, without reading error text", () => {
  const start = controller.indexOf("const manualAssertionCodes =");
  const end = controller.indexOf("const required =", start);
  expect(start).toBeGreaterThan(0);
  const own = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      controller.slice(start, end) +
        "\n({ check, readManualAssertionCode, codes: Array.from(manualAssertionCodes) })",
    ),
  );
  expect(own.codes).toHaveLength(10);
  for (const code of own.codes) {
    let caught: unknown;
    try {
      own.check(false, code);
    } catch (error) {
      caught = error;
    }
    expect(own.readManualAssertionCode(caught)).toBe(code);
    const forged = Object.create(Object.getPrototypeOf(caught)) as object;
    Object.defineProperty(forged, "message", {
      get: () => {
        throw new Error("No error-text reads.");
      },
    });
    Object.defineProperty(forged, "code", {
      get: () => {
        throw new Error("No code-property reads.");
      },
    });
    expect(own.readManualAssertionCode(forged)).toBeNull();
    expect(
      own.readManualAssertionCode(new Error(`UI qualification assertion failed: ${code}.`)),
    ).toBeNull();
  }
  for (const code of [
    "manual-private-token",
    "manual-row-clipboard private-value",
    "manual-row-clipboard\n",
    "row-cancel-keeps-draft",
  ]) {
    let caught: unknown;
    try {
      own.check(false, code);
    } catch (error) {
      caught = error;
    }
    expect(own.readManualAssertionCode(caught)).toBeNull();
  }
  for (const value of [null, "manual-row-clipboard", { code: "manual-row-clipboard" }])
    expect(own.readManualAssertionCode(value)).toBeNull();
});

it.each([
  "reveals",
  "never-reveals",
  "wrong-archive",
  "row-clipboard-mismatch",
  "card-clipboard-mismatch",
])("uses real rendered instructions and actual manual flow with %s", async (mode) => {
  let kind: "archive" | "package" | "unknown" = "archive",
    elapsed = 0,
    revealAt = Infinity,
    clipboard = "",
    copies = 0;
  const phases: string[] = [],
    captured: string[] = [],
    receipts: unknown[] = [];
  const declaredChecks = new Set<string>();
  const steps = () =>
    manualUpdateSteps({
      installKind: kind === "package" ? "system-package" : kind,
      os: "linux",
      arch: "x64",
      sshLaunched: false,
      serverVersion: "0.7.2",
    });
  const renderedSteps = () =>
    mode === "wrong-archive" ? "bibcode serve\n# Currently running: v0.7.2" : steps();
  const browser = {
    sendCommandAndGetResult: async () => {},
    $: (selector: string) => ({
      isExisting: async () => false,
      getText: async () =>
        selector === "owned-row//pre"
          ? elapsed >= revealAt
            ? renderedSteps()
            : ""
          : selector === "dialog pre"
            ? renderedSteps()
            : selector === "dialog"
              ? "Update QA manually\nCopied"
              : "Update instructions copied",
    }),
    waitUntil: async (
      read: () => Promise<boolean>,
      options: { timeout: number; interval: number },
    ) => {
      expect(options.timeout).toBe(30_000);
      const deadline = elapsed + options.timeout;
      while (elapsed < deadline) {
        if (await read()) return;
        elapsed += options.interval;
      }
      throw new Error("inert text readiness deadline");
    },
    executeAsync: (
      read: (expected: string, done: (value: boolean) => void) => void,
      expected: string,
    ) => new Promise((resolve) => read(expected, resolve)),
  };
  const start = controller.indexOf("async function manualFlow()");
  const end = controller.indexOf("async function restartPrimaryWithBrowserTransition(", start);
  const textStart = controller.indexOf("const text = async");
  const textEnd = controller.indexOf("const dialog =", textStart);
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      controller.slice(textStart, textEnd) + controller.slice(start, end) + "\nmanualFlow",
    ),
    {
      phase: (name: string) => phases.push(name),
      currentTheme: "light",
      webOrigin: "http://localhost:4901",
      dialog: "dialog",
      required: () => browser,
      manualHost: async (next: typeof kind) => {
        kind = next;
        return { label: "QA", port: 4886 };
      },
      descriptor: async () => ({
        platform: { os: "linux", arch: "x64" },
        remoteUpdateSupport: { installKind: kind === "package" ? "system-package" : kind },
      }),
      addHost: async () => {},
      row: () => "owned-row",
      workspace: async () => {},
      removeHost: async () => {},
      click: async (selector: string) => {
        if (selector.includes('="Show update steps"'))
          revealAt = mode === "never-reveals" ? Infinity : elapsed + 200;
        if (selector.includes('="Copy"') || selector === "dialog button=Copy") {
          copies++;
          clipboard = renderedSteps();
        }
      },
      check: (value: unknown, code: string) => {
        declaredChecks.add(code);
        if (value !== true) throw new Error(code);
      },
      navigator: {
        clipboard: {
          readText: async () =>
            (mode === "row-clipboard-mismatch" && copies === 1) ||
            (mode === "card-clipboard-mismatch" && copies === 2)
              ? "inert clipboard mismatch"
              : clipboard,
        },
      },
      capture: async (scene: string) => captured.push(scene),
      assertions: receipts,
    },
  );
  if (mode === "reveals") {
    await run();
    expect(captured).toEqual(["manual-archive", "manual-package", "manual-unknown"]);
    expect(copies).toBe(6);
    expect(receipts).toHaveLength(3);
    expect(phases).toContain("manual-archive-read-row-steps");
    expect(phases).toContain("manual-package-card-clipboard");
    expect(phases).toContain("manual-unknown-capture");
    const checkStart = controller.indexOf("const manualAssertionCodes =");
    const checkEnd = controller.indexOf("const required =", checkStart);
    const codes = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        controller.slice(checkStart, checkEnd) + "\nArray.from(manualAssertionCodes)",
      ),
    ) as string[];
    expect(codes.toSorted()).toEqual([...declaredChecks].toSorted());
  } else {
    const code =
      mode === "never-reveals"
        ? "inert text readiness deadline"
        : mode === "wrong-archive"
          ? "manual-archive-platform"
          : mode === "row-clipboard-mismatch"
            ? "manual-row-clipboard"
            : "manual-card-clipboard";
    await expect(run()).rejects.toThrow(code);
    expect(captured).toEqual([]);
    expect(copies).toBe(
      mode === "row-clipboard-mismatch" ? 1 : mode === "card-clipboard-mismatch" ? 2 : 0,
    );
  }
});

it.each(["ready", "toast-clears", "backdrop-clears", "covered", "disabled", "click-rejects"])(
  "uses actual pinned clickability readiness before one native click: %s",
  async (mode) => {
    const webdriver = NodeFS.readFileSync(
      new URL("../../node_modules/webdriverio/build/node.js", import.meta.url),
      "utf8",
    );
    const waitStart = webdriver.indexOf("async function waitForClickable(");
    const waitEnd = webdriver.indexOf("// src/commands/element/waitForDisplayed.ts", waitStart);
    expect(waitStart).toBeGreaterThan(0);
    expect(waitEnd).toBeGreaterThan(waitStart);
    const waitSource = webdriver.slice(waitStart, waitEnd);
    const browserReader = /(getBrowserObject\d*)\(this\)/.exec(waitSource)?.[1];
    expect(browserReader).toBeDefined();
    const wait = NodeVM.runInNewContext(waitSource + "\nwaitForClickable", {
      [browserReader!]: () => ({ isMobile: false }),
    });
    const predicateSource = NodeFS.readFileSync(
      new URL(
        "../../node_modules/webdriverio/build/scripts/isElementClickable.js",
        import.meta.url,
      ),
      "utf8",
    );
    let elapsed = 0,
      clicks = 0;
    const overlay = {};
    const nativeFailure = new Error("inert native click failure");
    const elementNode = {
      disabled: mode === "disabled",
      clientWidth: 50,
      clientHeight: 20,
      getBoundingClientRect: () => ({ left: 100, top: 100, width: 50, height: 20 }),
      getClientRects: () => [{ left: 100, top: 100, width: 50, height: 20 }],
      scrollIntoView: () => {},
      contains: (node: unknown) => node === elementNode,
    };
    const clickable = NodeVM.runInNewContext(
      predicateSource.slice(0, predicateSource.indexOf("export {")) + "\nisElementClickable",
      {
        window: { innerHeight: 960, innerWidth: 1280, scrollX: 0, scrollY: 0, scroll: () => {} },
        document: {
          elementFromPoint: () =>
            mode === "covered" ||
            (mode === "toast-clears" && elapsed < 500) ||
            (mode === "backdrop-clears" && elapsed < 1000)
              ? overlay
              : elementNode,
        },
      },
    );
    const target = {
      selector: "owned target",
      options: { waitforTimeout: 30_000, waitforInterval: 250 },
      waitForDisplayed: async () => {},
      waitForEnabled: async () => {
        if (elementNode.disabled) throw new Error("inert readiness deadline");
      },
      waitForClickable: wait,
      isClickable: async () => clickable(elementNode),
      waitUntil: async (
        read: () => Promise<boolean>,
        options: { timeout: number; interval: number },
      ) => {
        expect(options.timeout).toBe(30_000);
        expect(options.interval).toBe(250);
        while (elapsed < options.timeout) {
          if (await read()) return true;
          elapsed += options.interval;
        }
        throw new Error("inert readiness deadline");
      },
      click: async () => {
        clicks++;
        if (!clickable(elementNode) || mode === "click-rejects") throw nativeFailure;
      },
    };
    const start = controller.indexOf("const element = (selector:");
    const end = controller.indexOf("const text = async", start);
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(controller.slice(start, end) + "\nclick"),
      { required: () => ({ $: () => target }) },
    );
    if (mode === "covered" || mode === "disabled") {
      await expect(run("owned-target")).rejects.toThrow("inert readiness deadline");
      expect(clicks).toBe(0);
    } else if (mode === "click-rejects") {
      await expect(run("owned-target")).rejects.toBe(nativeFailure);
      expect(clicks).toBe(1);
    } else {
      await run("owned-target");
      expect(clicks).toBe(1);
    }
    if (mode === "toast-clears") expect(elapsed).toBe(500);
    if (mode === "backdrop-clears") expect(elapsed).toBe(1000);
  },
);

it("reconfirms a wrong-version retry with the restarted host's unknown target and fresh counts", async () => {
  const start = controller.indexOf("async function restartFailures()");
  const end = controller.indexOf("async function queuedFlow()", start);
  const nextCase = new Error("next inert case");
  const host = { label: "QA Wrong Version light" };
  const actions: string[] = [];
  let dialogText: string | null = null;
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(controller.slice(start, end) + "\nrestartFailures"),
    {
      currentTheme: "light",
      dialog: "dialog",
      phase: (value: string) => {
        if (value === "real-no-return-deadline") throw nextCase;
      },
      fakeHost: async () => host,
      addHost: async () => {},
      openConfirmation: async () => {},
      confirm: async () => actions.push("initial-confirm"),
      exactRequests: async (_host: unknown, count: number) => actions.push(`requests:${count}`),
      status: async () => {},
      row: () => "owned-row",
      restart: async () => {
        // The maintained host resets ScriptedStatus to default on restart. A
        // Settings row therefore requests a fresh confirmation with null target.
        const presentation = remoteUpdateConfirmation({
          name: host.label,
          targetVersion: null,
          appVersion: "0.7.2",
          activeWork: { runningTurns: 0, liveTerminals: 0, queuedMessages: 0 },
          counting: false,
        });
        dialogText = [presentation.title, ...presentation.lines].join("\n");
      },
      text: async (selector: string, expected: string) => {
        if (selector === "dialog") {
          if (!dialogText?.includes(expected))
            throw new Error("Expected controlled UI state did not arrive.");
          actions.push(`dialog:${expected}`);
        }
      },
      capture: async (scene: string, _host: unknown, _row: string, expected: string) => {
        expect(scene).toBe("wrong-version");
        expect(expected).toBe("QA Wrong Version light restarted on v9.9.0 instead of v9.9.1.");
        actions.push("wrong-version-capture");
      },
      click: async (selector: string) => {
        expect(selector).toBe('owned-row//button[normalize-space()="Retry"]');
        actions.push("retry");
      },
      cancel: async () => actions.push("cancel"),
      removeHost: async () => actions.push("remove"),
    },
  );
  await expect(run()).rejects.toBe(nextCase);
  expect(actions).toEqual([
    "initial-confirm",
    "requests:1",
    "wrong-version-capture",
    "retry",
    "dialog:Update QA Wrong Version light?",
    "dialog:Nothing is running on it now.",
    "cancel",
    "requests:1",
    "remove",
  ]);
});

it.each(["Dismiss", "Check"])("identifies the final failure-flow %s boundary", async (action) => {
  const start = controller.indexOf("async function failureFlow()");
  const end = controller.indexOf("async function restartFailures()", start);
  const phases: string[] = [];
  const stopped = new Error("inert target failure");
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(controller.slice(start, end) + "\nfailureFlow"),
    {
      phase: (value: string) => phases.push(value),
      currentTheme: "light",
      composer: "composer",
      dialog: "dialog",
      fakeHost: async () => ({ label: "QA Failure light" }),
      addHost: async () => {},
      importProject: async () => {},
      required: () => ({ $: () => ({ setValue: async () => {}, waitForExist: async () => {} }) }),
      openConfirmation: async () => {},
      confirm: async () => {},
      cancel: async () => {},
      exactRequests: async () => {},
      status: async () => {},
      text: async () => {},
      capture: async () => {},
      delay: async () => {},
      row: () => "owned-row",
      click: async (selector: string) => {
        if (selector.startsWith("owned-row") && selector.includes(`="${action}`)) throw stopped;
      },
    },
  );
  await expect(run()).rejects.toBe(stopped);
  expect(phases.at(-1)).toBe(action === "Dismiss" ? "failure-dismiss" : "failure-check-again");
});

it.each(["primary", "update-a", "update-b", "update-c"])(
  "keeps the actual %s host and grant in the same explicitly selected profile",
  async (role) => {
    const spawns: string[][] = [],
      grants: string[][] = [];
    const start = controller.indexOf("async function fakeHost(");
    const end = controller.indexOf("async function offer(", start);
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(controller.slice(start, end) + "\n({ fakeHost, grant })"),
      {
        NodePath,
        fixture: "/owned-fixture",
        currentTheme: "light",
        serial: 0,
        webOrigin: "http://localhost:4901",
        fakeHostBinary: "/owned-fake-host",
        serverBinary: "/owned-server",
        unusedPort: async () => {},
        readyHost: async () => {},
        privateEnvironment: () => ({}),
        prepareDesktopUiTestContext: () => ({ projectPath: "/owned-project" }),
        addOwnedTunnel: async (host: unknown) => host,
        check: (value: unknown) => {
          expect(value).toBe(true);
        },
        owner: {
          spawn: (_binary: string, args: string[]) => {
            spawns.push(args);
            return {};
          },
          json: async (_binary: string, args: string[]) => {
            grants.push(args);
            return { credential: "inert-fixture-credential" };
          },
        },
      },
    );
    const host = await run.fakeHost(role, role === "primary" ? 4887 : 4888, "QA Host");
    await run.grant(host);
    const devArgs = role === "primary" ? ["--dev-url", "http://localhost:4901"] : [];
    expect(spawns).toEqual([[host.base, String(host.port), "9.9.0", "QA Host", ...devArgs]]);
    expect(grants).toEqual([["pairing", "issue", "--base-dir", host.base, ...devArgs, "--json"]]);
  },
);

it("keeps the actual build and preview primary targets coherent with the browser cookie host", () => {
  const yaml = NodeModule.createRequire(
    new URL("../../../../scripts/package.json", import.meta.url),
  )("yaml");
  const workflow = yaml.parse(
    NodeFS.readFileSync(
      new URL("../../../../.github/workflows/qualify-release-ui.yml", import.meta.url),
      "utf8",
    ),
  );
  const configuration = workflow.jobs.remote_ui.steps.find(
    (step: { name: string }) =>
      step.name === "Build the source UI once with owned loopback targets",
  ).env;
  for (const key of ["VITE_HTTP_URL", "VITE_WS_URL"])
    expect(controller).toContain(`${key}: ${JSON.stringify(configuration[key])}`);
  const source = NodeFS.readFileSync(
    new URL("../../../web/src/environments/primary/target.ts", import.meta.url),
    "utf8",
  );
  const read = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      source
        .slice(source.indexOf("const LOOPBACK_HOSTNAMES"))
        .replaceAll("import.meta.env", "configuration")
        .replaceAll("export function ", "function ") +
        "\n(() => ({ target: readPrimaryEnvironmentTarget(), authUrl: resolvePrimaryEnvironmentHttpUrl('/api/auth/browser-session') }))",
    ),
    {
      configuration,
      window: { location: new URL(configuration.VITE_DEV_SERVER_URL + "/pair") },
      URL,
      URLSearchParams,
    },
  );
  const result = read();
  expect(new URL(result.authUrl).origin).toBe(configuration.VITE_DEV_SERVER_URL);
  expect(new URL(result.authUrl).hostname).toBe(new URL(result.target.target.httpBaseUrl).hostname);
  expect(new URL(result.authUrl).hostname).toBe(new URL(result.target.target.wsBaseUrl).hostname);
});

it.each([
  [null, "none"],
  ["Enter a pairing token to continue.", "credential-required"],
  ["Invalid pairing token. Check the token and try again.", "credential-rejected"],
  ["Timed out waiting for authenticated session after bootstrap.", "session-timeout"],
  [
    "Primary environment request failed during exchange-bootstrap-credential (HTTP 403).",
    "request-failed",
  ],
  ["Primary environment request failed during fetch-session-state (HTTP 500).", "request-failed"],
  ["Primary environment request failed during private-value (HTTP 500).", "unknown"],
  ["private-credential /private/path https://private-host", "unknown"],
  ["x".repeat(300), "unknown"],
])(
  "keeps setup error data inside the page and returns only a closed category %#",
  (message, category) => {
    const callback = failureObservationCallbackSource();
    class Button {
      disabled = false;
    }
    const submit = new Button();
    let formPresent = true;
    const token = {
      get value() {
        throw new Error("Input values must never be read.");
      },
      closest: () => ({
        querySelector: (selector: string) =>
          selector.includes("submit") ? submit : message === null ? null : { textContent: message },
      }),
    };
    const read = NodeVM.runInNewContext(NodeModule.stripTypeScriptTypes("(" + callback + ")"), {
      window: {},
      HTMLButtonElement: Button,
      location: {
        pathname: "/pair",
        get search() {
          throw new Error("No query reads.");
        },
        get href() {
          throw new Error("No URL reads.");
        },
      },
      document: {
        readyState: "complete",
        getElementById: (id: string) => (id === "pairing-token" && formPresent ? token : null),
        querySelector: () => null,
      },
    });
    const result = read();
    expect(result.setup.pairingError).toBe(category);
    expect(result.setup.tokenPresent).toBe(true);
    expect(result.setup.submitDisabled).toBe(false);
    expect(projectRemoteUiSetupObservation(result.setup)).toEqual(result.setup);
    expect(JSON.stringify(result)).not.toMatch(/private-|credential \/|HTTP 403|https:\/\//);
    formPresent = false;
    expect(read().setup).toMatchObject({
      tokenPresent: false,
      submitPresent: false,
      submitDisabled: null,
      pairingError: null,
    });
  },
);

it.each([
  [null, "none"],
  ["Enter a project path.", "path-required"],
  ["Host platform information is still loading.", "host-loading"],
  ["Windows-style paths are only supported on Windows.", "unsupported-windows"],
  ["Enter an absolute or home-relative path.", "path-relative"],
  ["private-path https://private-host private-credential", "unknown"],
  ["x".repeat(300), "unknown"],
])("observes only a finite import error and busy flag %#", (message, category) => {
  const callback = failureObservationCallbackSource();
  let present = true;
  let busy = false;
  const input = {
    get value() {
      throw new Error("No project path reads.");
    },
    hasAttribute: (attribute: string) => {
      expect(attribute).toBe("disabled");
      return busy;
    },
    closest: (selector: string) => {
      expect(selector).toBe("form");
      return {
        querySelector: (selector: string) => {
          expect(selector).toBe('[role="alert"]');
          return message === null ? null : { textContent: message };
        },
      };
    },
  };
  const read = NodeVM.runInNewContext(NodeModule.stripTypeScriptTypes("(" + callback + ")"), {
    window: {},
    HTMLButtonElement: class {
      disabled = false;
    },
    location: {
      pathname: "/",
      get href() {
        throw new Error("No URL reads.");
      },
    },
    document: {
      readyState: "complete",
      getElementById: (id: string) => (id === "add-project-host-path" && present ? input : null),
      querySelector: () => null,
    },
  });
  for (const state of [false, true]) {
    busy = state;
    const result = read();
    expect(result.setup).toMatchObject({
      importPathPresent: true,
      importBusy: state,
      importError: category,
    });
    expect(projectRemoteUiSetupObservation(result.setup)).toEqual(result.setup);
    expect(JSON.stringify(result)).not.toMatch(
      /private-|Enter a project|Host platform|Windows-style|home-relative|x{20}/,
    );
  }
  present = false;
  expect(read().setup).toMatchObject({
    importPathPresent: false,
    importBusy: null,
    importError: null,
  });
});

it.each(["unavailable", "no-browser", "write-failure", "manual-assertion"])(
  "retains unavailable setup honestly and still runs joined cleanup on %s",
  async (mode) => {
    const start = controller.indexOf("} catch (error) {", controller.indexOf('phase("complete")'));
    const end = controller.indexOf("\nprocess.exitCode", start);
    const writes: Array<{ name: string; value: Record<string, unknown> }> = [];
    let closed = false;
    const checkStart = controller.indexOf("const manualAssertionCodes =");
    const checkEnd = controller.indexOf("const required =", checkStart);
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        controller.slice(checkStart, checkEnd) +
          "async function fail() { try { " +
          (mode === "manual-assertion"
            ? 'check(false, "manual-row-clipboard"); '
            : 'throw new Error("inert failure"); ') +
          controller.slice(start, end) +
          "}\nfail",
      ),
      {
        BrowserConnectivityFailure: class extends Error {},
        networkProofs: [],
        currentPhase: "primary-pair-submit",
        currentTheme: "light",
        success: false,
        browser:
          mode === "no-browser"
            ? undefined
            : {
                execute: async () => {
                  throw new Error("private-browser-unavailable");
                },
                deleteSession: async () => {},
              },
        bounded: (promise: Promise<unknown>, timeout: number) => {
          expect(timeout).toBe(2_000);
          return promise;
        },
        projectBrowserStartupObservation: () => {
          throw new Error("Unavailable must not be projected.");
        },
        projectRemoteUiSetupObservation,
        projectRemoteUiCheckAgainObservation,
        classifyQualificationFailure: () => ({ kind: "timeout" }),
        owner: {
          processes: [],
          failures: [],
          childrenClosed: () => closed,
          close: async () => {
            closed = true;
          },
        },
        tunnels: [],
        plan: remoteUiPlan("core"),
        captures: [],
        assertions: [],
        bundleVersion: "0.7.2",
        process: { env: {} },
        write: (name: string, value: Record<string, unknown>) => {
          writes.push({ name, value });
          if (name === "failure" && mode === "write-failure")
            throw new Error("inert write failure");
        },
      },
    );
    if (mode === "write-failure") await expect(run()).rejects.toThrow("inert write failure");
    else await run();
    expect(closed).toBe(true);
    expect(writes.find(({ name }) => name === "failure")?.value).toMatchObject({
      startup: null,
      setup: null,
      manualAssertionCode: mode === "manual-assertion" ? "manual-row-clipboard" : null,
    });
    expect(writes.find(({ name }) => name === "result")?.value).toMatchObject({
      success: false,
      childProcessesClosed: true,
    });
    expect(JSON.stringify(writes)).not.toContain("private-");
  },
);

it("separates real primary import/theme waits without relabeling remote host imports", async () => {
  const start = controller.indexOf("async function importProject(");
  const end = controller.indexOf("async function capture(", start);
  const phases: string[] = [];
  const browser = {
    $: () => ({
      isDisplayed: async () => true,
      isExisting: async () => true,
      waitForDisplayed: async () => {},
      setValue: async () => {},
    }),
    waitUntil: async (read: () => Promise<boolean>) => {
      expect(await read()).toBe(true);
    },
    execute: async (read: (dark: boolean) => boolean, dark: boolean) => read(dark),
  };
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      controller.slice(start, end) + "\n({ importProject, setTheme })",
    ),
    {
      phase: (name: string) => phases.push(name),
      required: () => browser,
      workspace: async () => {},
      settings: async () => {},
      click: async () => {},
      owner: { until: browser.waitUntil },
      composer: "owned-composer",
      document: { documentElement: { classList: { contains: () => true } } },
    },
  );
  await run.importProject({ project: "/owned-project", devUrl: "http://localhost:4901" });
  expect(phases).toEqual([
    "primary-import-workspace",
    "primary-import-menu",
    "primary-import-path-mode",
    "primary-import-path-input",
    "primary-import-submit",
    "primary-import-composer",
  ]);
  phases.length = 0;
  await run.importProject({ project: "/owned-project" });
  expect(phases).toEqual([]);
  await run.setTheme("dark");
  expect(phases).toEqual([
    "primary-theme-settings",
    "primary-theme-general",
    "primary-theme-select",
    "primary-theme-applied",
    "primary-theme-remote-servers",
  ]);
});

it.each([
  ["grant", "primary-pair-issue-grant"],
  ["fill", "primary-pair-fill-token"],
  ["submit", "primary-pair-submit"],
  ["sidebar", "primary-pair-wait-sidebar"],
  ["import", "primary-import"],
  ["theme", "primary-theme"],
])("reports the exact primary setup boundary for an inert %s failure", async (failAt, expected) => {
  const start = controller.indexOf(
    "    phase(",
    controller.indexOf("networkProofs.push(await verifyOwnedBrowserOnline("),
  );
  const end = controller.indexOf("    const flows = {", start);
  const observed: string[] = [];
  const stop = async (step: string) => {
    if (step === failAt) throw new Error("inert setup failure");
  };
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      "async function setup() {" + controller.slice(start, end) + "}\nsetup",
    ),
    {
      phase: (value: string) => observed.push(value),
      webOrigin: "http://localhost:4901",
      primary: {},
      plan: { flows: ["success"] },
      theme: "light",
      browser: {
        url: async () => {},
        $: (selector: string) => ({
          waitForDisplayed: () => stop(selector.includes("sidebar") ? "sidebar" : "token"),
          setValue: () => stop("fill"),
        }),
      },
      grant: () => stop("grant").then(() => "inert-credential"),
      click: () => stop("submit"),
      importProject: () => stop("import"),
      setTheme: () => stop("theme"),
      workspace: async () => {},
    },
  );
  await expect(run()).rejects.toThrow("inert setup failure");
  expect(observed.at(-1)).toBe(expected);
});

it.each([
  ["workspace", "reload-open-workspace"],
  ["select-primary", "reload-select-primary"],
  ["composer", "reload-composer-ready"],
  ["draft", "reload-fill-draft"],
  ["document", "reload-document-before"],
])("identifies the actual reload setup failure at %s", async (failed, expectedPhase) => {
  const start = controller.indexOf("async function reloadFlow(");
  const end = controller.indexOf('\ntry {\n  phase("prepare-contained-network");', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const phases: string[] = [];
  const failure = new Error("inert reload boundary");
  const boundary = (name: string) => {
    if (name === failed) throw failure;
  };
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(controller.slice(start, end) + "\nreloadFlow"),
    {
      phase: (value: string) => phases.push(value),
      currentTheme: "light",
      composer: "owned-composer",
      NodePath,
      check: (value: unknown) => {
        if (!value) throw failure;
      },
      decodeReloadPrimaryWorkspace,
      readReloadPrimaryWorkspace,
      readReloadPrimaryThread,
      decodeReloadPrimaryThreadProof,
      EnvironmentOrchestrationHttpApi: {
        endpoints: { snapshot: { path: "/api/orchestration/snapshot" } },
      },
      primaryRead: {
        projectName: "BiBCode UI Fixture",
        environmentId: "primary",
        projectId: "owned-project",
        threadId: "owned-thread",
        sessionLinePresent: true,
        requireSelected: true,
      },
      primaryWorkspace: {
        environmentId: "primary",
        projectId: "owned-project",
        threadId: "owned-thread",
        sessionLinePresent: true,
      },
      owner: {
        until: async (read: () => Promise<boolean>) => {
          expect(await read()).toBe(true);
        },
      },
      workspace: async () => boundary("workspace"),
      click: async () => boundary("select-primary"),
      required: () => ({
        $: () => ({
          waitForDisplayed: async () => boundary("composer"),
          setValue: async () => boundary("draft"),
        }),
        execute: async (read: unknown) =>
          read === readReloadPrimaryWorkspace
            ? {
                environmentId: "primary",
                projectId: "owned-project",
                threadId: "owned-thread",
                sessionLinePresent: true,
              }
            : boundary("document"),
      }),
    },
  );
  await expect(
    run(
      { project: "/owned/BiBCode UI Fixture" },
      {
        environmentId: "primary",
        projectId: "owned-project",
        threadId: "owned-thread",
        sessionLinePresent: true,
      },
    ),
  ).rejects.toBe(failure);
  expect(phases.at(-1)).toBe(expectedPhase);
});

it.each(["stale-connected", "stays-disconnected", "unknown", "reconnected"])(
  "same-version negative control requires this restart's browser transition: %s",
  async (outcome) => {
    const start = controller.indexOf(
      "  const documentBefore =",
      controller.indexOf("async function reloadFlow("),
    );
    const end = controller.indexOf('  await restart(primary, "9.9.1");', start);
    const textStart = controller.indexOf("const text = async");
    const textEnd = controller.indexOf("const dialog =", textStart);
    const helperStart = controller.indexOf("async function restartPrimaryWithBrowserTransition(");
    const helperEnd = controller.indexOf("async function reloadFlow(");
    let elapsed = 0,
      requested = false,
      newBootRead = false,
      negativeChecks = 0;
    const statuses: string[] = [];
    const phases: string[] = [];
    const readStatus = () => {
      const status =
        !requested || outcome === "stale-connected"
          ? "connected"
          : outcome === "unknown"
            ? "unrecognized"
            : outcome === "reconnected" && newBootRead
              ? "connected"
              : "disconnected";
      statuses.push(status);
      return status;
    };
    const browser = {
      $: () => ({ getText: async () => "Disconnected", isDisplayed: async () => false }),
      execute: async (callback: () => unknown) => callback(),
      waitUntil: async (predicate: () => Promise<boolean>, options: { timeout?: number } = {}) => {
        const deadline = elapsed + (options.timeout ?? 30_000);
        while (elapsed < deadline) {
          if (await predicate()) return;
          elapsed += 250;
        }
        throw new Error("Owned browser observation timed out.");
      },
    };
    const helper = helperStart < 0 ? "" : controller.slice(helperStart, helperEnd);
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        controller.slice(textStart, textEnd) +
          helper +
          "\nasync function negativeControl(){" +
          controller.slice(start, end) +
          "}\nnegativeControl",
      ),
      {
        required: () => browser,
        phase: (value: string) => phases.push(value),
        primary: { port: 4887, child: {} },
        bundleVersion: "0.7.2",
        restart: async () => {
          requested = true;
        },
        descriptor: async () => {
          if (requested) newBootRead = true;
          return { bootId: requested ? "new" : "old", serverVersion: "0.7.2" };
        },
        owner: {
          command: async () => {
            requested = true;
          },
          until: (predicate: () => Promise<boolean>, timeout: number) =>
            browser.waitUntil(predicate, { timeout }),
        },
        performance: { now: () => elapsed, timeOrigin: 1000 },
        document: { querySelector: () => ({ getAttribute: readStatus }) },
        delay: async (ms: number) => {
          elapsed += ms;
        },
        bounded: (promise: Promise<unknown>) => promise,
        check: (value: unknown, code: string) => {
          if (code === "same-bundle-no-reload-offer") negativeChecks++;
          if (value !== true) throw new Error(code);
        },
      },
    );
    if (outcome === "reconnected") {
      await run();
      expect(statuses).toContain("disconnected");
      expect(statuses.at(-1)).toBe("connected");
      expect(negativeChecks).toBeGreaterThan(0);
      expect(phases).toContain("reload-same-version-new-boot");
      expect(phases).toContain("reload-same-version-negative-control");
      expect(phases.at(-1)).toBe("reload-changed-version-restart");
    } else {
      await expect(run()).rejects.toThrow();
      expect(negativeChecks).toBe(0);
      expect(phases.at(-1)).toBe(
        outcome === "stays-disconnected"
          ? "reload-same-version-connected"
          : "reload-same-version-disconnected",
      );
    }
  },
);

it.each(["core", "full"])(
  "runs exactly the selected %s controller flows in order",
  async (selection) => {
    const start = controller.indexOf("    const flows = {");
    const end = controller.indexOf("\n    check(", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const plan = remoteUiPlan(selection);
    const called: string[] = [];
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        "async function selected() {" + controller.slice(start, end) + "}\nselected",
      ),
      {
        plan,
        primary: {},
        successFlow: async () => called.push("success"),
        failureFlow: async () => called.push("failure"),
        restartFailures: async () => called.push("restart-failures"),
        queuedFlow: async () => called.push("queued"),
        manualFlow: async () => called.push("manual"),
        reloadFlow: async () => called.push("reload"),
        primaryWorkspace: {
          environmentId: "primary",
          projectId: "owned-project",
          threadId: "owned-thread",
          sessionLinePresent: true,
        },
      },
    );
    await run();
    expect(called).toEqual(plan.flows);
  },
);

it("keeps CI activation limited to its QA branch or manual selection, core by default", () => {
  const yaml = NodeModule.createRequire(
    new URL("../../../../scripts/package.json", import.meta.url),
  )("yaml");
  const workflow = yaml.parse(
    NodeFS.readFileSync(
      new URL("../../../../.github/workflows/qualify-release-ui.yml", import.meta.url),
      "utf8",
    ),
  );
  expect(Object.keys(workflow.on).toSorted()).toEqual(["push", "workflow_dispatch"]);
  expect(workflow.on.push.branches).toEqual(["codex/qualify-release-ui"]);
  expect(workflow.on.workflow_dispatch.inputs.matrix.default).toBe("core");
  expect(workflow.on.workflow_dispatch.inputs.matrix.options).toEqual(["core", "full"]);
  const steps = workflow.jobs.remote_ui.steps as Array<Record<string, unknown>>;
  const helpers = steps.find(
    (step) => step.name === "Check owned helpers and namespace admission",
  )!;
  expect(helpers.run).toContain("apps/desktop/e2e/support/remote-ui-primary-workspace.test.ts");
  const fallback = "${{ inputs.matrix || 'core' }}";
  expect(workflow.jobs.remote_ui.env.BIBCODE_RELEASE_UI_MATRIX).toBe(fallback);
  expect(workflow.jobs.remote_ui.name).toContain(fallback);
  const run = steps.find((step) => step.name === "Run contained remote update UI selection")!;
  expect(run.run).toBe(
    'python3 -B scripts/qualify-chat-uploads.py --scenario remote-updates-ui --matrix "$BIBCODE_RELEASE_UI_MATRIX"',
  );
  const artifact = steps.find((step) => String(step.uses).startsWith("actions/upload-artifact@"))!
    .with as { path: string; name: string };
  expect(artifact.name).toContain(fallback);
  const names = artifact.path
    .trim()
    .split("\n")
    .map((line) => line.slice(line.lastIndexOf("/") + 1));
  const screenshots = remoteUiScenes.flatMap((scene) =>
    remoteUiThemes.map((theme) => screenshotName(theme, scene)),
  );
  expect(names.toSorted()).toEqual(
    [
      "phase.json",
      "failure.json",
      "provenance.json",
      "result.json",
      "assertions.json",
      "namespace-cleanup.json",
      "supervisor.json",
      ...screenshots,
    ].toSorted(),
  );
  expect(artifact.path).not.toMatch(/\*|\.log|profile|credential/);
});

it("reports manual dispatch as unobserved instead of counting a nonexistent fake-host receipt", () => {
  const start = controller.indexOf("async function manualFlow()");
  const end = controller.indexOf("async function reloadFlow(", start);
  const manual = controller.slice(start, end);
  expect(manual).toContain('installDispatch: "unobserved"');
  expect(manual).not.toContain("exactRequests(");
  expect(manual).not.toContain("updater.install");
  expect(manual).toContain("manual-has-no-install-control");
});

it("executes the actual read-only capture callback with real modal/toast distinctions and credential refusal", () => {
  const start = controller.indexOf(
    "          (input) => {",
    controller.indexOf("async function capture("),
  );
  const end = controller.indexOf("\n          {\n            selector:", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const callback = controller.slice(start, end).trim().replace(/,$/, "");
  class Element {
    textContent = "Expected owned state";
    getBoundingClientRect() {
      return { x: 10, y: 10, width: 200, height: 100, right: 210, bottom: 110 };
    }
    getAttribute(name: string) {
      return name === "aria-checked" ? "true" : null;
    }
    contains(other: unknown) {
      return other === this;
    }
  }
  const target = new Element(),
    toast = new Element(),
    modal = new Element(),
    obstruction = new Element();
  let credential = false,
    wrongTheme = false,
    blocked = false,
    boot = false,
    unrelatedModal = false;
  const read = NodeVM.runInNewContext(NodeModule.stripTypeScriptTypes("(" + callback + ")"), {
    HTMLElement: Element,
    innerWidth: 1280,
    innerHeight: 960,
    getComputedStyle: () => ({ visibility: "visible" }),
    location: { origin: "http://localhost:4901", search: "", hash: "" },
    document: {
      documentElement: { classList: { contains: () => wrongTheme } },
      querySelector: (selector: string) =>
        selector === ".owned-target" || selector.startsWith('[role="radio"]')
          ? target
          : selector.startsWith("#pairing-token")
            ? credential
              ? new Element()
              : null
            : null,
      querySelectorAll: (selector: string) =>
        selector.includes('data-slot="dialog-popup"') ? (unrelatedModal ? [modal] : []) : [toast],
      getElementById: () => (boot ? new Element() : null),
      elementFromPoint: () => (blocked ? obstruction : target),
    },
  });
  const input = {
    selector: ".owned-target",
    label: "QA",
    expected: "Expected owned state",
    theme: "light",
    origin: "http://localhost:4901",
    primary: false,
  };
  expect(Object.values(read(input)).every((value) => value === true)).toBe(true);
  credential = true;
  expect(read(input).credentialAbsent).toBe(false);
  credential = false;
  wrongTheme = true;
  expect(read(input).themeMatched).toBe(false);
  wrongTheme = false;
  blocked = true;
  expect(read(input).targetInView).toBe(false);
  blocked = false;
  unrelatedModal = true;
  expect(read(input).targetInView).toBe(false);
  unrelatedModal = false;
  boot = true;
  expect(read(input).bootShellAbsent).toBe(false);
});

it.each(["displayed", "clickable", "click", "row"])(
  "identifies the exact Check again failed operation without another action: %s",
  async (failed) => {
    const start = controller.indexOf('  phase("failure-check-again");');
    const end = controller.indexOf('  await capture("dismissed"', start);
    const helperStart = controller.indexOf("const click = async");
    const helperEnd = controller.indexOf("const text = async", helperStart);
    const calls: string[] = [],
      phases: string[] = [];
    const failure = new Error("inert private selector/error/interceptor");
    const operation = async (name: string, args: unknown[]) => {
      expect(args).toEqual([]);
      calls.push(name);
      if (name === failed) throw failure;
    };
    const target = {
      waitForDisplayed: (...args: unknown[]) => operation("displayed", args),
      waitForClickable: (...args: unknown[]) => operation("clickable", args),
      click: (...args: unknown[]) => operation("click", args),
    };
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        controller.slice(helperStart, helperEnd) +
          "async function run() {" +
          controller.slice(start, end) +
          "}\nrun",
      ),
      {
        phase: (value: string) => phases.push(value),
        host: { label: "QA Failure light" },
        row: () => "owned-row",
        element: (selector: string) => {
          expect(selector).toBe(
            'owned-row//button[normalize-space()="Check again" or normalize-space()="Check"]',
          );
          return target;
        },
        text: async (selector: string, expected: string, ...args: unknown[]) => {
          expect(selector).toBe("owned-row");
          expect(expected).toBe("Update to v9.9.1…");
          await operation("row", args);
        },
      },
    );
    await expect(run()).rejects.toBe(failure);
    expect(phases.at(-1)).toBe(`failure-check-again-${failed}`);
    expect(calls).toEqual(
      ["displayed", "clickable", "click", "row"].slice(
        0,
        ["displayed", "clickable", "click", "row"].indexOf(failed) + 1,
      ),
    );
  },
);

function failureObservationCallbackSource() {
  const start = controller.indexOf(
    "browser.execute(",
    controller.indexOf("} catch (error) {", controller.indexOf('phase("complete")')),
  );
  const tail = controller.slice(start);
  const end = tail.search(/\n\s*\},\n\s*\{\n\s*checkAgain:/);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(0);
  return tail.slice("browser.execute(".length, end) + "\n}";
}

it.each(["light", "dark"])(
  "keeps the actual %s failure-row producer closed and scoped",
  (theme) => {
    for (const mode of [
      "ready",
      "toast",
      "dialog",
      "other",
      "none",
      "offscreen",
      "hidden",
      "disabled",
      "checking",
      "missing-control",
      "multiple-controls",
      "unknown-badge",
      "private-label",
      "missing-row",
      "multiple-rows",
      "wrong-origin",
      "wrong-route",
      "search",
      "hash",
      "wrong-theme",
      "inactive",
    ]) {
      class Button {
        readonly textContent: string;
        constructor(textContent: string) {
          this.textContent = textContent;
        }
        disabled = mode === "disabled";
        get value() {
          throw new Error("Input values must not be read.");
        }
        getClientRects() {
          return mode === "hidden" ? [] : [{}];
        }
        getBoundingClientRect() {
          return { left: mode === "offscreen" ? -100 : 10, top: 10, width: 20, height: 20 };
        }
        contains(node: unknown) {
          return node === this;
        }
      }
      const control = new Button(
        mode === "checking"
          ? "Checking…"
          : mode === "private-label"
            ? "private-credential".repeat(8)
            : "Check",
      );
      const update = new Button("Update to v9.9.1…");
      const buttons =
        mode === "missing-control"
          ? [update]
          : mode === "multiple-controls"
            ? [control, new Button("Check again"), update]
            : [control, update];
      const row = {
        querySelectorAll: () => buttons,
        querySelector: () => ({
          getAttribute: () =>
            mode === "unknown-badge" ? "private-credential /private/path" : "update-available",
        }),
      };
      const heading = {
        textContent: `QA Failure ${theme}`,
        parentElement: { parentElement: { parentElement: row } },
      };
      let rowReads = 0;
      const read = NodeVM.runInNewContext(
        NodeModule.stripTypeScriptTypes("(" + failureObservationCallbackSource() + ")"),
        {
          window: { innerWidth: 1280, innerHeight: 960 },
          HTMLButtonElement: Button,
          getComputedStyle: () => ({ visibility: "visible", display: "block" }),
          location: {
            origin: mode === "wrong-origin" ? "http://private-host" : "http://localhost:4901",
            pathname: mode === "wrong-route" ? "/private-path" : "/settings/remote-servers",
            search: mode === "search" ? "?private-credential" : "",
            hash: mode === "hash" ? "#private-credential" : "",
            get href() {
              throw new Error("No arbitrary URL reads.");
            },
          },
          document: {
            readyState: "complete",
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => {
              rowReads++;
              return mode === "missing-row"
                ? []
                : mode === "multiple-rows"
                  ? [heading, heading]
                  : [heading];
            },
            elementFromPoint: () =>
              ["ready", "disabled", "checking", "unknown-badge"].includes(mode)
                ? control
                : mode === "none"
                  ? null
                  : {
                      get textContent() {
                        throw new Error("No interceptor text reads.");
                      },
                      closest: (selector: string) =>
                        (mode === "toast" && selector.includes("toast")) ||
                        (mode === "dialog" && selector.includes("dialog"))
                          ? {}
                          : null,
                    },
          },
        },
      );
      const result = read({
        checkAgain: mode !== "inactive",
        theme: mode === "wrong-theme" ? "private-credential" : theme,
      });
      const projected = projectRemoteUiCheckAgainObservation(result.checkAgain);
      if (mode === "inactive") {
        expect(projected).toBeNull();
        expect(rowReads).toBe(0);
      } else if (["wrong-origin", "wrong-route", "search", "hash", "wrong-theme"].includes(mode)) {
        expect(projected?.safeLocation).toBe(false);
        expect(rowReads).toBe(0);
        expect(Object.values(projected!).slice(1)).toEqual(Array(9).fill(null));
      } else {
        expect(projected?.safeLocation).toBe(true);
        expect(rowReads).toBe(1);
        expect(projected?.rowCount).toBe(
          mode === "missing-row" ? "none" : mode === "multiple-rows" ? "multiple" : "one",
        );
        if (["ready", "toast", "dialog", "other", "none", "offscreen"].includes(mode)) {
          expect(projected?.hitTarget).toBe(
            mode === "ready" ? "target" : mode === "offscreen" ? "outside-viewport" : mode,
          );
          expect(projected?.controlLabel).toBe("check");
          expect(projected?.updateActionPresent).toBe(true);
        }
        if (mode === "hidden")
          expect(projected).toMatchObject({ controlVisible: false, hitTarget: null });
        if (mode === "disabled") expect(projected?.controlDisabled).toBe(true);
        if (mode === "checking") expect(projected?.controlLabel).toBe("checking");
        if (mode === "unknown-badge") expect(result.checkAgain.badgeVariant).toBeNull();
        if (mode === "private-label" || mode === "missing-control")
          expect(projected).toMatchObject({ controlCount: "none", controlLabel: null });
        if (mode === "multiple-controls")
          expect(projected).toMatchObject({
            controlCount: "multiple",
            controlLabel: null,
            controlVisible: null,
            controlDisabled: null,
            hitTarget: null,
          });
      }
      expect(JSON.stringify(result.checkAgain)).not.toMatch(
        /private-|https?:|selector|interceptor/,
      );
      expect(JSON.stringify(projected)).not.toMatch(/private-|https?:|selector|interceptor/);
    }
  },
);

it.each([
  "own",
  "inherited",
  "accessor",
  "throwing-accessor",
  "nonenumerable",
  "throwing-descriptor",
])(
  "keeps refused descriptor evidence local at the actual failure/cleanup seam: %s",
  async (kind) => {
    const known = {
      safeLocation: true,
      rowCount: "one",
      controlCount: "one",
      controlLabel: "check",
      controlVisible: true,
      controlDisabled: false,
      hitTarget: "target",
      updateActionPresent: true,
      badgeVariant: "update-available",
      dismissPresent: false,
    };
    let reads = 0,
      samples = 0,
      joined = false;
    let payload: object = kind === "inherited" ? Object.create(known) : { ...known };
    if (kind === "accessor" || kind === "throwing-accessor")
      Object.defineProperty(payload, "controlLabel", {
        enumerable: true,
        get() {
          reads++;
          if (kind === "throwing-accessor") throw new Error("private accessor/error");
          return "check";
        },
      });
    if (kind === "nonenumerable")
      Object.defineProperty(payload, "controlLabel", { enumerable: false, value: "check" });
    if (kind === "throwing-descriptor")
      payload = new Proxy(payload, {
        getOwnPropertyDescriptor() {
          throw new Error("private descriptor/error");
        },
      });
    const start = controller.indexOf("} catch (error) {", controller.indexOf('phase("complete")'));
    const end = controller.indexOf("\nprocess.exitCode", start);
    const failure = new Error("private intercepted selector/error");
    const writes = new Map<string, Record<string, unknown>>();
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        "async function fail(){ try { throw original; " + controller.slice(start, end) + "}\nfail",
      ),
      {
        original: failure,
        BrowserConnectivityFailure: class extends Error {},
        networkProofs: [],
        currentPhase: "failure-check-again-click",
        currentTheme: "light",
        success: false,
        browser: {
          execute: async (_read: unknown, input: unknown) => {
            samples++;
            expect(input).toEqual({ checkAgain: true, theme: "light" });
            return { startup: {}, setup: null, checkAgain: payload };
          },
          deleteSession: async () => {
            joined = true;
          },
        },
        bounded: (promise: Promise<unknown>, timeout: number) => {
          expect(timeout).toBe(2_000);
          return promise;
        },
        projectBrowserStartupObservation: () => ({ errors: 0 }),
        projectRemoteUiSetupObservation,
        projectRemoteUiCheckAgainObservation,
        classifyQualificationFailure: (error: unknown) => {
          expect(error).toBe(failure);
          return { kind: "click-intercepted" };
        },
        readManualAssertionCode: () => null,
        owner: {
          processes: [],
          failures: [],
          childrenClosed: () => joined,
          close: async (resources: { browser?: () => Promise<void> }) => {
            await resources.browser?.();
          },
        },
        tunnels: [],
        plan: remoteUiPlan("core"),
        captures: [],
        assertions: [],
        bundleVersion: "0.7.2",
        process: { env: {} },
        write: (name: string, value: Record<string, unknown>) => writes.set(name, value),
      },
    );
    await run();
    expect(samples).toBe(1);
    expect(reads).toBe(0);
    expect(joined).toBe(true);
    const observed = writes.get("failure")!;
    expect(observed.phase).toBe("failure-check-again-click");
    expect(observed.failure).toEqual({ kind: "click-intercepted" });
    expect(observed.startup).toEqual({ errors: 0 });
    if (kind === "own") expect(observed.checkAgain).toEqual(known);
    else if (kind === "inherited")
      expect(Object.values(observed.checkAgain as object)).toEqual(Array(10).fill(null));
    else expect(observed.checkAgain).toBeNull();
    expect(JSON.stringify(Array.from(writes.values()))).not.toContain("private");
    expect(writes.get("result")?.childProcessesClosed).toBe(true);
  },
);

it.each([
  "settings",
  "open",
  "dialog",
  "alias",
  "code",
  "ack-visible",
  "ack-proof",
  "ack",
  "submit",
  "closed",
  "row",
  "select",
  "return-settings",
  "check",
  "status",
])("identifies the actual success Add Server preparation operation: %s", async (failed) => {
  const start = controller.indexOf("async function addHost(");
  const end = controller.indexOf("async function removeHost(", start);
  const operations: string[] = [],
    calls: string[] = [];
  const stopped = new Error("inert preparation failure");
  let settingsCalls = 0;
  const boundary = async (operation: string) => {
    calls.push(operation);
    if (operation === failed) throw stopped;
  };
  const host = {
    label: "QA Success light",
    closeTunnel: failed === "ack-proof" ? undefined : () => {},
  };
  const dialog = '[data-slot="dialog-popup"][role="dialog"]';
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(controller.slice(start, end) + "\naddHost"),
    {
      settings: () => boundary(++settingsCalls === 1 ? "settings" : "return-settings"),
      click: (selector: string) =>
        boundary(
          selector.includes('aria-label="Add Server"')
            ? "open"
            : selector.includes("button=Add Server")
              ? "submit"
              : "check",
        ),
      required: () => ({
        $: (selector: string) => ({
          waitForDisplayed: (options?: { reverse?: boolean }) =>
            boundary(options?.reverse ? "closed" : "dialog"),
          setValue: (value: string) => {
            expect(value).toBe(selector.includes("input[") ? host.label : "inert-offer");
            return boundary(selector.includes("input[") ? "alias" : "code");
          },
          isDisplayed: async () => {
            await boundary("ack-visible");
            return true;
          },
          click: () => boundary("ack"),
        }),
      }),
      dialog,
      offer: async () => "inert-offer",
      check: (value: unknown, code: string) => {
        expect(code).toBe("actual-tunnel-before-acknowledgement");
        calls.push("ack-proof");
        if (!value) throw stopped;
      },
      text: (selector: string, expected: string) => {
        expect(selector).toBe("owned-row");
        return boundary(expected === host.label ? "row" : "status");
      },
      row: () => "owned-row",
      selectHost: () => boundary("select"),
    },
  );
  if (failed === "ack-visible") {
    // Existing catch deliberately treats this read as false.
    await expect(
      run(host, true, (operation: string) => operations.push(operation)),
    ).resolves.toBeUndefined();
    expect(operations).toContain("ack-visible");
    expect(calls).not.toContain("ack");
  } else {
    await expect(run(host, true, (operation: string) => operations.push(operation))).rejects.toBe(
      stopped,
    );
    expect(operations.at(-1)).toBe(failed);
  }
});

it.each([
  "primary-import-workspace",
  "primary-import-menu",
  "primary-import-path-mode",
  "primary-import-path-input",
  "primary-import-submit",
  "primary-import-composer",
])(
  "identifies the actual success project-import operation while preserving primary phases: %s",
  async (failed) => {
    const start = controller.indexOf("async function importProject(");
    const end = controller.indexOf("async function setTheme(", start);
    const observed: string[] = [];
    const stopped = new Error("inert import failure");
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(controller.slice(start, end) + "\nimportProject"),
      {
        phase: () => {
          throw new Error("Remote success import must not become a primary phase.");
        },
        workspace: async () => {
          if (failed === "primary-import-workspace") throw stopped;
        },
        click: async (selector: string) => {
          if (failed === "primary-import-menu" && selector.includes("sidebar-add-project"))
            throw stopped;
          if (failed === "primary-import-submit" && selector === "button=Open project")
            throw stopped;
        },
        owner: {
          until: async (read: () => Promise<boolean>) => {
            if (failed === "primary-import-path-mode") throw stopped;
            expect(await read()).toBe(true);
          },
        },
        required: () => ({
          $: (selector: string) => ({
            isDisplayed: async () => true,
            isExisting: async () => true,
            waitForDisplayed: async () => {
              if (failed === "primary-import-path-input" && selector === "#add-project-host-path")
                throw stopped;
              if (failed === "primary-import-composer" && selector === "owned-composer")
                throw stopped;
            },
            setValue: async (value: string) => expect(value).toBe("/owned/project"),
          }),
        }),
        composer: "owned-composer",
      },
    );
    await expect(
      run({ project: "/owned/project" }, (operation: string) => observed.push(operation)),
    ).rejects.toBe(stopped);
    expect(observed.at(-1)).toBe(failed);
  },
);

it.each(["host", "add-host", "import", "draft", "settings", "initial-row"])(
  "wires only literal success preparation phases before the first capture: %s",
  async (failed) => {
    const start = controller.indexOf("async function successFlow()");
    const end = controller.indexOf(
      "  await workspace();",
      controller.indexOf('  await capture("initial-row"', start),
    );
    const mapsStart = controller.indexOf("const SUCCESS_ADD_HOST_PHASES");
    const mapsEnd = controller.indexOf("async function addHost(", mapsStart);
    const phases: string[] = [];
    const calls: string[] = [];
    const stopped = new Error("inert success preparation failure");
    const boundary = async (name: string) => {
      calls.push(name);
      if (name === failed) throw stopped;
    };
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        controller.slice(mapsStart, mapsEnd) +
          "async function prep(){" +
          controller.slice(controller.indexOf("{", start) + 1, end) +
          "}\nprep",
      ),
      {
        phase: (name: string) => phases.push(name),
        currentTheme: "light",
        composer: "owned-composer",
        fakeHost: async (role: string, port: number, label: string) => {
          expect([role, port, label]).toEqual(["update-a", 4888, "QA Success light"]);
          await boundary("host");
          return { label };
        },
        addHost: async (
          _host: unknown,
          interactive: boolean,
          observe: (operation: string) => void,
        ) => {
          expect(interactive).toBe(true);
          observe("submit");
          await boundary("add-host");
        },
        importProject: async (_host: unknown, observe: (operation: string) => void) => {
          observe("primary-import-submit");
          await boundary("import");
        },
        required: () => ({
          $: (selector: string) => {
            expect(selector).toBe("owned-composer");
            return {
              setValue: async (value: string) => {
                expect(value).toBe("retained update draft light");
                await boundary("draft");
              },
            };
          },
        }),
        settings: () => boundary("settings"),
        row: () => "owned-row",
        capture: async (scene: string, _host: unknown, target: string, expected: string) => {
          expect([scene, target, expected]).toEqual([
            "initial-row",
            "owned-row",
            "Update to v9.9.1…",
          ]);
          await boundary("initial-row");
        },
      },
    );
    await expect(run()).rejects.toBe(stopped);
    const expected: Record<string, string> = {
      host: "success-host-start",
      "add-host": "success-add-host-submit",
      import: "success-import-submit",
      draft: "success-draft",
      settings: "success-settings",
      "initial-row": "success-initial-row",
    };
    expect(phases.at(-1)).toBe(expected[failed]);
    expect(phases[0]).toBe("success-flow");
    expect(phases.every((value) => /^(success-flow|success-[a-z-]+)$/.test(value))).toBe(true);
    expect(calls).toEqual(
      ["host", "add-host", "import", "draft", "settings", "initial-row"].slice(
        0,
        ["host", "add-host", "import", "draft", "settings", "initial-row"].indexOf(failed) + 1,
      ),
    );
  },
);

function preparationObserverReplay(
  throwPhase: string | null = null,
  failOperation: string | null = null,
) {
  const mapsStart = controller.indexOf("const SUCCESS_ADD_HOST_PHASES");
  const addStart = controller.indexOf("async function addHost(");
  const addEnd = controller.indexOf("async function removeHost(", addStart);
  const importStart = controller.indexOf("async function importProject(");
  const importEnd = controller.indexOf("async function setTheme(", importStart);
  const successStart = controller.indexOf("async function successFlow()");
  const successEnd = controller.indexOf(
    "  await workspace();",
    controller.indexOf('  await capture("initial-row"', successStart),
  );
  const calls: unknown[][] = [],
    phases: string[] = [];
  const failure = new Error("inert observer/operation failure");
  const record = async (name: string, ...args: unknown[]) => {
    calls.push([name, ...args]);
    if (name === failOperation) throw failure;
  };
  const host = { label: "QA Success light", project: "/owned/project", closeTunnel: () => {} };
  const code =
    controller.slice(mapsStart, addStart) +
    controller.slice(addStart, addEnd) +
    controller.slice(importStart, importEnd) +
    "async function prep(){" +
    controller.slice(controller.indexOf("{", successStart) + 1, successEnd) +
    "}\n({addHost,importProject,prep,hostKeys:Object.keys(SUCCESS_ADD_HOST_PHASES),importKeys:Object.keys(SUCCESS_IMPORT_PHASES),hostPhases:Object.values(SUCCESS_ADD_HOST_PHASES),importPhases:Object.values(SUCCESS_IMPORT_PHASES)})";
  const run = NodeVM.runInNewContext(NodeModule.stripTypeScriptTypes(code), {
    phase: (name: string) => {
      phases.push(name);
      if (name === throwPhase) throw failure;
    },
    currentTheme: "light",
    dialog: '[data-slot="dialog-popup"][role="dialog"]',
    composer: "owned-composer",
    settings: () => record("settings"),
    workspace: () => record("workspace"),
    click: (selector: string) => record("click", selector),
    offer: async (value: unknown) => {
      expect(value).toBe(host);
      await record("offer");
      return "inert-offer";
    },
    row: () => "owned-row",
    selectHost: () => record("select"),
    check: (value: unknown, code: string) => {
      calls.push(["check", code]);
      if (!value) throw failure;
    },
    text: (selector: string, expected: string, ...rest: unknown[]) =>
      record("text", selector, expected, ...rest),
    owner: {
      until: async (read: () => Promise<boolean>, ...args: unknown[]) => {
        await record("until", ...args);
        expect(await read()).toBe(true);
      },
    },
    required: () => ({
      $: (selector: string) => ({
        waitForDisplayed: (...args: unknown[]) => record("displayed", selector, ...args),
        setValue: (value: string) => record("input", selector, value),
        isDisplayed: async (...args: unknown[]) => {
          await record("visible", selector, ...args);
          return true;
        },
        isExisting: async (...args: unknown[]) => {
          await record("existing", selector, ...args);
          return true;
        },
        click: (...args: unknown[]) => record("ack-click", selector, ...args),
      }),
    }),
    fakeHost: async (role: string, port: number, label: string) => {
      await record("host", role, port, label);
      return host;
    },
    capture: (scene: string, _host: unknown, target: string, expected: string) =>
      record("capture", scene, target, expected),
  });
  return { ...run, host, calls, phases, failure };
}

it("preserves the actual Add Server baseline actions with successful or throwing observers at every position", async () => {
  const baseline = preparationObserverReplay();
  await baseline.addHost(baseline.host);
  const normal = preparationObserverReplay();
  const seen: string[] = [];
  await normal.addHost(normal.host, true, (operation: string) => seen.push(operation));
  expect(normal.calls).toEqual(baseline.calls);
  expect(seen).toEqual(normal.hostKeys);
  for (const failed of normal.hostKeys) {
    const probe = preparationObserverReplay();
    const observed: string[] = [];
    await expect(
      probe.addHost(probe.host, true, (operation: string) => {
        observed.push(operation);
        if (operation === failed) throw probe.failure;
      }),
    ).resolves.toBeUndefined();
    expect(probe.calls).toEqual(baseline.calls);
    expect(observed).toEqual(normal.hostKeys);
  }
});

it("preserves the actual import baseline and primary phases with observers throwing at every position", async () => {
  for (const primary of [false, true]) {
    const baseline = preparationObserverReplay();
    const baselineHost = { ...baseline.host, ...(primary ? { devUrl: "owned" } : {}) };
    await baseline.importProject(baselineHost);
    for (const failed of baseline.importKeys) {
      const probe = preparationObserverReplay();
      const observed: string[] = [];
      const host = { ...probe.host, ...(primary ? { devUrl: "owned" } : {}) };
      await expect(
        probe.importProject(host, (operation: string) => {
          observed.push(operation);
          if (operation === failed) throw probe.failure;
        }),
      ).resolves.toBeUndefined();
      expect(probe.calls).toEqual(baseline.calls);
      expect(probe.phases).toEqual(baseline.phases);
      expect(observed).toEqual(baseline.importKeys);
    }
  }
});

it("keeps real success wiring running when any optional mapped phase callback throws", async () => {
  const baseline = preparationObserverReplay();
  await baseline.prep();
  for (const failed of [...baseline.hostPhases, ...baseline.importPhases]) {
    const probe = preparationObserverReplay(failed);
    await expect(probe.prep()).resolves.toBeUndefined();
    expect(probe.calls).toEqual(baseline.calls);
    expect(probe.phases).toEqual(baseline.phases);
  }
});

it("keeps broad phases, original operations and capture failures fail-closed", async () => {
  for (const failed of [
    "success-flow",
    "success-host-start",
    "success-draft",
    "success-settings",
    "success-initial-row",
  ]) {
    const probe = preparationObserverReplay(failed);
    await expect(probe.prep()).rejects.toBe(probe.failure);
    expect(probe.calls.some((call: readonly unknown[]) => call[0] === "capture")).toBe(false);
  }
  for (const failed of ["settings", "click", "input", "capture"]) {
    const probe = preparationObserverReplay(null, failed);
    await expect(probe.prep()).rejects.toBe(probe.failure);
    expect(probe.calls.at(-1)?.[0]).toBe(failed);
  }
  const primary = preparationObserverReplay("primary-import-workspace");
  await expect(primary.importProject({ ...primary.host, devUrl: "owned" }, () => {})).rejects.toBe(
    primary.failure,
  );
  expect(primary.calls).toEqual([]);
});

it.each(["empty-index", "removed-thread", "already-primary"])(
  "requires public bound primary-card navigation before the Reload composer: %s",
  async (initial) => {
    const start = controller.indexOf(
      '  phase("reload-open-workspace");',
      controller.indexOf("async function reloadFlow("),
    );
    const end = controller.indexOf("  const draft =", start);
    let proofReads = 0;
    const phases: string[] = [],
      actions: string[] = [];
    const binding = {
      environmentId: "primary",
      projectId: "owned-project",
      threadId: "owned-thread",
      sessionLinePresent: true,
    };
    let route =
      initial === "already-primary"
        ? "/primary/owned-thread"
        : initial === "empty-index"
          ? "/"
          : "/removed-remote/old-thread";
    const browser = {
      $: () => ({
        waitForDisplayed: async () => {
          if (route !== "/primary/owned-thread") throw new Error("Owned composer absent.");
        },
      }),
      execute: async (read: unknown, input: Record<string, unknown>) => {
        if (read === readReloadPrimaryThread) {
          proofReads++;
          return { matched: true, witness: null };
        }
        if (input.requireSelected === false) return true;
        return route === "/primary/owned-thread" ? binding : null;
      },
    };
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        "async function prep(){" + controller.slice(start, end) + "}\nprep",
      ),
      {
        phase: (value: string) => phases.push(value),
        workspace: async () => actions.push("workspace"),
        click: async (selector: string) => {
          actions.push(selector);
          if (selector === '[data-testid="primary-card-button-owned-project"]')
            route = "/primary/owned-thread";
          else expect(selector).toBe('[data-testid="environment-rail-local"]');
        },
        required: () => browser,
        composer: "owned-composer",
        primary: { project: "/owned/BiBCode UI Fixture" },
        primaryWorkspace: binding,
        readReloadPrimaryWorkspace,
        readReloadPrimaryThread,
        decodeReloadPrimaryThreadProof,
        EnvironmentOrchestrationHttpApi: {
          endpoints: { snapshot: { path: "/api/orchestration/snapshot" } },
        },
        decodeReloadPrimaryWorkspace,
        NodePath,
        primaryRead: { projectName: "BiBCode UI Fixture", ...binding, requireSelected: true },
        owner: { until: async (read: () => Promise<boolean>) => expect(await read()).toBe(true) },
        check: (value: unknown) => {
          if (value !== true) throw new Error("Owned primary identity refused.");
        },
      },
    );
    await expect(run()).resolves.toBeUndefined();
    expect(route).toBe("/primary/owned-thread");
    expect(actions).toEqual(
      initial === "already-primary"
        ? ["workspace", '[data-testid="environment-rail-local"]']
        : [
            "workspace",
            '[data-testid="environment-rail-local"]',
            '[data-testid="primary-card-button-owned-project"]',
          ],
    );
    expect(phases.at(-1)).toBe("reload-composer-ready");
    expect(proofReads).toBe(initial === "already-primary" ? 0 : 1);
  },
);

it.each(["core", "full", "malformed"])(
  "captures the initial owned primary only for full Reload: %s",
  async (mode) => {
    const start = controller.indexOf("    let primaryWorkspace: ReloadPrimaryWorkspace");
    const end = controller.indexOf('    phase("primary-theme");', start);
    let calls = 0;
    const phases: string[] = [];
    const refusal = new Error("Owned initial identity refused.");
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        "async function bind(){" + controller.slice(start, end) + "return primaryWorkspace;}\nbind",
      ),
      {
        plan: { flows: mode === "core" ? ["success"] : ["reload"] },
        primary: { project: "/owned/BiBCode UI Fixture" },
        NodePath,
        phase: (value: string) => phases.push(value),
        decodeReloadPrimaryWorkspace,
        readReloadPrimaryWorkspace,
        readReloadPrimaryThread,
        decodeReloadPrimaryThreadProof,
        EnvironmentOrchestrationHttpApi: {
          endpoints: { snapshot: { path: "/api/orchestration/snapshot" } },
        },
        owner: {
          until: async (read: () => Promise<boolean>) => {
            if (!(await read())) throw refusal;
          },
        },
        required: () => ({
          execute: async (read: unknown, input: unknown) => {
            calls++;
            expect(read).toBe(readReloadPrimaryWorkspace);
            expect(input).toEqual({
              projectName: "BiBCode UI Fixture",
              environmentId: null,
              projectId: null,
              threadId: null,
              sessionLinePresent: null,
              requireSelected: true,
            });
            return mode === "malformed"
              ? { environmentId: "primary", projectId: "owned-project" }
              : {
                  environmentId: "primary",
                  projectId: "owned-project",
                  threadId: "owned-thread",
                  sessionLinePresent: true,
                };
          },
        }),
      },
    );
    if (mode === "malformed") await expect(run()).rejects.toBe(refusal);
    else
      expect(await run()).toEqual(
        mode === "core"
          ? null
          : {
              environmentId: "primary",
              projectId: "owned-project",
              threadId: "owned-thread",
              sessionLinePresent: true,
            },
      );
    expect(calls).toBe(mode === "core" ? 0 : 1);
  },
);

it.each(["missing-card", "foreign-thread", "missing-primary-thread"])(
  "refuses lost primary proof before draft/restart: %s",
  async (mode) => {
    const start = controller.indexOf(
      '  phase("reload-open-workspace");',
      controller.indexOf("async function reloadFlow("),
    );
    const end = controller.indexOf("  const draft =", start);
    const binding = {
      environmentId: "primary",
      projectId: "owned-project",
      threadId: "owned-thread",
      sessionLinePresent: true,
    };
    const phases: string[] = [],
      clicks: string[] = [];
    const refusal = new Error("Owned selection refused.");
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        "async function prep(){" + controller.slice(start, end) + "}\nprep",
      ),
      {
        phase: (value: string) => phases.push(value),
        workspace: async () => {},
        primaryWorkspace: binding,
        primaryRead: { projectName: "BiBCode UI Fixture", ...binding, requireSelected: true },
        decodeReloadPrimaryWorkspace,
        readReloadPrimaryWorkspace,
        readReloadPrimaryThread,
        decodeReloadPrimaryThreadProof,
        EnvironmentOrchestrationHttpApi: {
          endpoints: { snapshot: { path: "/api/orchestration/snapshot" } },
        },
        composer: "owned-composer",
        check: (value: unknown) => {
          if (value !== true) throw refusal;
        },
        click: async (selector: string) => clicks.push(selector),
        required: () => ({
          execute: async (_read: unknown, input: { requireSelected: boolean }) =>
            _read === readReloadPrimaryThread
              ? { matched: mode !== "missing-primary-thread", witness: null }
              : input.requireSelected
                ? { ...binding, threadId: "foreign-thread" }
                : mode === "missing-card"
                  ? null
                  : true,
          $: () => ({
            waitForDisplayed: async () => {
              throw new Error("Composer must not be reached.");
            },
          }),
        }),
        owner: {
          until: async (read: () => Promise<boolean>) => {
            if (!(await read())) throw refusal;
          },
        },
      },
    );
    await expect(run()).rejects.toBe(refusal);
    expect(phases.at(-1)).toBe(
      mode === "missing-card"
        ? "reload-primary-card-ready"
        : mode === "missing-primary-thread"
          ? "reload-primary-thread-proof"
          : "reload-primary-identity",
    );
    expect(clicks).toEqual(
      mode !== "foreign-thread"
        ? ['[data-testid="environment-rail-local"]']
        : [
            '[data-testid="environment-rail-local"]',
            '[data-testid="primary-card-button-owned-project"]',
          ],
    );
  },
);

it("checks the same captured identity again after real replacement document/composer", async () => {
  const start = controller.indexOf('  phase("reload-restored-composer");');
  const end = controller.indexOf("  check((await required().$(composer).getText())", start);
  const binding = {
    environmentId: "primary",
    projectId: "owned-project",
    threadId: "owned-thread",
    sessionLinePresent: true,
  };
  for (const threadId of ["owned-thread", "replacement-thread"]) {
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        "async function restored(){" + controller.slice(start, end) + "}\nrestored",
      ),
      {
        phase: () => {},
        composer: "owned-composer",
        primaryWorkspace: binding,
        primaryRead: { projectName: "BiBCode UI Fixture", ...binding, requireSelected: true },
        decodeReloadPrimaryWorkspace,
        readReloadPrimaryWorkspace,
        readReloadPrimaryThread,
        decodeReloadPrimaryThreadProof,
        EnvironmentOrchestrationHttpApi: {
          endpoints: { snapshot: { path: "/api/orchestration/snapshot" } },
        },
        check: (value: unknown, code: string) => {
          expect(code).toBe("actual-reload-keeps-primary-identity");
          if (value !== true) throw new Error("Restored identity refused.");
        },
        required: () => ({
          $: () => ({ waitForDisplayed: async () => {} }),
          execute: async () => ({ ...binding, threadId }),
        }),
      },
    );
    if (threadId === "owned-thread") await expect(run()).resolves.toBeUndefined();
    else await expect(run()).rejects.toThrow("Restored identity refused.");
  }
});

it("retains only the same-read closed primary witness at the exact failed proof phase", () => {
  const start = controller.indexOf('  write("failure", {');
  const end = controller.indexOf("\n} finally {", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  for (const currentPhase of [
    "reload-primary-thread-proof",
    "reload-primary-card-ready",
    "reload-primary-card-select",
    "primary-import",
  ]) {
    const records: Array<{ name: string; value: Record<string, unknown> }> = [];
    NodeVM.runInNewContext(NodeModule.stripTypeScriptTypes(controller.slice(start, end)), {
      currentPhase,
      currentTheme: "light",
      error: new Error("private-error"),
      classifyQualificationFailure: () => ({ kind: "unclassified", errorClass: "Error" }),
      readManualAssertionCode: () => null,
      startup: null,
      setup: null,
      checkAgain: null,
      reloadPrimaryThreadWitness: {
        requestAdmitted: true,
        httpStatus: "forbidden",
        private: "private-snapshot",
      },
      projectReloadPrimaryThreadWitness,
      write: (name: string, value: Record<string, unknown>) => records.push({ name, value }),
      fetch: () => {
        throw new Error("No additional request is authorized.");
      },
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.name).toBe("failure");
    expect(records[0]?.value.failure).toEqual({ kind: "unclassified", errorClass: "Error" });
    expect(records[0]?.value.reloadPrimaryThreadProof).toEqual(
      currentPhase === "reload-primary-thread-proof"
        ? projectReloadPrimaryThreadWitness({ requestAdmitted: true, httpStatus: "forbidden" })
        : null,
    );
    expect(JSON.stringify(records)).not.toMatch(/private|snapshot|http:\/\/|credential/);
  }
});

function removalReplay(failed: string | null = null) {
  const start = controller.indexOf("async function removeHost(");
  const end = controller.indexOf("async function importProject(", start);
  const clickStart = controller.indexOf("const click = async");
  const clickEnd = controller.indexOf("const text = async", clickStart);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const calls: unknown[][] = [];
  const failure = new Error("inert private missing element");
  const action = async (operation: string, args: unknown[] = []) => {
    calls.push([operation, ...args]);
    if (operation === failed) throw failure;
  };
  const control = (prefix: string) => ({
    waitForDisplayed: (...args: unknown[]) => action(prefix + "-displayed", args),
    waitForClickable: (...args: unknown[]) => action(prefix + "-clickable", args),
    click: (...args: unknown[]) => action(prefix + "-click", args),
  });
  const host = {
    label: "inert-private-label",
    child: { role: "owned-child" },
    closeTunnel: () => action("tunnel-close"),
  };
  const browser = {
    $: (selector: string) => {
      expect(selector).toBe("owned-row");
      return { waitForExist: (...args: unknown[]) => action("row-removed", args) };
    },
    $$: async (selector: string) => {
      expect(selector).toBe('button[data-slot="toast-close"]');
      await action("toast-list", [selector]);
      return [
        {
          isDisplayed: async () => {
            await action("toast-displayed");
            return true;
          },
          click: () => action("toast-click"),
        },
      ];
    },
  };
  const remove = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      controller.slice(clickStart, clickEnd) + controller.slice(start, end) + "\nremoveHost",
    ),
    {
      required: () => browser,
      settings: () => action("settings"),
      row: (label: string) => {
        expect(label).toBe(host.label);
        return "owned-row";
      },
      owner: { stop: (child: unknown) => action("child-stop", [child]) },
      bounded: (promise: Promise<unknown>, budget: number) => {
        calls.push(["bound", budget]);
        return promise;
      },
      element: (selector: string) => {
        calls.push(["resolve", selector]);
        if (selector === 'button[aria-label="More actions for inert-private-label"]')
          return control("more");
        if (selector === '//*[@role="menuitem" and normalize-space()="Remove server…"]')
          return control("remove");
        if (selector === '[role="alertdialog"] button=Remove server') return control("confirm");
        throw new Error("Unexpected public control.");
      },
    },
  );
  return { remove, host, calls, failure };
}

it("adds removal markers without changing existing control selectors, argument defaults or joins", async () => {
  const baseline = removalReplay();
  await baseline.remove(baseline.host);
  expect(baseline.calls).toEqual([
    ["settings"],
    ["resolve", 'button[aria-label="More actions for inert-private-label"]'],
    ["more-displayed"],
    ["more-clickable"],
    ["more-click"],
    ["resolve", '//*[@role="menuitem" and normalize-space()="Remove server…"]'],
    ["remove-displayed"],
    ["remove-clickable"],
    ["remove-click"],
    ["resolve", '[role="alertdialog"] button=Remove server'],
    ["confirm-displayed"],
    ["confirm-clickable"],
    ["confirm-click"],
    ["row-removed", { reverse: true }],
    ["child-stop", baseline.host.child],
    ["tunnel-close"],
    ["bound", 5_000],
    ["toast-list", 'button[data-slot="toast-close"]'],
    ["toast-displayed"],
    ["toast-click"],
  ]);
  const stages: string[] = [];
  const observed = removalReplay();
  await observed.remove(observed.host, (operation: string) => stages.push(operation));
  expect(observed.calls).toEqual(baseline.calls);
  expect(stages).toEqual([
    "settings",
    "more",
    "more-displayed",
    "more-clickable",
    "more-click",
    "remove",
    "remove-displayed",
    "remove-clickable",
    "remove-click",
    "confirm",
    "confirm-displayed",
    "confirm-clickable",
    "confirm-click",
    "row-removed",
    "child-stop",
    "tunnel-close",
    "toast-list",
    "toast-displayed",
    "toast-click",
  ]);
  for (const failed of stages) {
    const probe = removalReplay();
    await probe.remove(probe.host, (operation: string) => {
      if (operation === failed) throw new Error("inert observer failure");
    });
    expect(probe.calls).toEqual(baseline.calls);
  }
});

it.each([
  "settings",
  "more-displayed",
  "more-clickable",
  "more-click",
  "remove-displayed",
  "remove-clickable",
  "remove-click",
  "confirm-displayed",
  "confirm-clickable",
  "confirm-click",
  "row-removed",
  "child-stop",
  "tunnel-close",
  "toast-list",
  "toast-click",
])(
  "keeps the original removal failure and identifies its existing boundary: %s",
  async (failed) => {
    const baseline = removalReplay(failed);
    await expect(baseline.remove(baseline.host)).rejects.toBe(baseline.failure);
    const probe = removalReplay(failed);
    const stages: string[] = [];
    await expect(
      probe.remove(probe.host, (operation: string) => {
        stages.push(operation);
        throw new Error("inert diagnostic failure");
      }),
    ).rejects.toBe(probe.failure);
    expect(probe.calls).toEqual(baseline.calls);
    expect(stages.at(-1)).toBe(failed);
  },
);

it("binds only fixed queue removal slot/stage markers after the unchanged core assertion", async () => {
  const start = controller.indexOf(
    "  for (const [index, host] of hosts.entries())",
    controller.indexOf("async function queuedFlow()"),
  );
  const end = controller.indexOf("\n}\n\nasync function manualHost", start);
  expect(start).toBeGreaterThan(
    controller.indexOf(
      'kind: "bounded-parallel"',
      controller.indexOf("async function queuedFlow()"),
    ),
  );
  expect(end).toBeGreaterThan(start);
  const hosts = [{ label: "private-a" }, { label: "private-b" }, { label: "private-c" }];
  const phases: string[] = [];
  const removed: unknown[] = [];
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      "async function removeQueued(){" + controller.slice(start, end) + "}\nremoveQueued",
    ),
    {
      hosts,
      phase: (value: string) => phases.push(value),
      removeHost: async (host: unknown, observe: (operation: string) => void) => {
        removed.push(host);
        observe("settings");
        observe("toast-click");
      },
    },
  );
  await run();
  expect(removed).toEqual(hosts);
  expect(phases).toEqual([
    "queued-remove-a-settings",
    "queued-remove-a-toast-click",
    "queued-remove-b-settings",
    "queued-remove-b-toast-click",
    "queued-remove-c-settings",
    "queued-remove-c-toast-click",
  ]);
  expect(JSON.stringify(phases)).not.toMatch(/private|label|http/);
});
