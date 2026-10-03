// @effect-diagnostics nodeBuiltinImport:off - Inspect and execute only inert portions of the QA controller.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import {
  remoteUiPlan,
  remoteUiScenes,
  remoteUiThemes,
  screenshotName,
  projectRemoteUiSetupObservation,
} from "./remote-ui-evidence.ts";

const controller = NodeFS.readFileSync(
  new URL("../qualify-remote-updates.ts", import.meta.url),
  "utf8",
);

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
    const start = controller.indexOf(
      "browser.execute(() => {",
      controller.indexOf("} catch (error) {", controller.indexOf('phase("complete")')),
    );
    const tail = controller.slice(start);
    const end = tail.search(/\n\s*\}\),\n\s*2_000,/);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(0);
    const callback = tail.slice("browser.execute(".length, end) + "\n}";
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

it.each(["unavailable", "no-browser", "write-failure"])(
  "retains unavailable setup honestly and still runs joined cleanup on %s",
  async (mode) => {
    const start = controller.indexOf("} catch (error) {", controller.indexOf('phase("complete")'));
    const end = controller.indexOf("\nprocess.exitCode", start);
    const writes: Array<{ name: string; value: Record<string, unknown> }> = [];
    let closed = false;
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(
        'async function fail() { try { throw new Error("inert failure"); ' +
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
    } else {
      await expect(run()).rejects.toThrow();
      expect(negativeChecks).toBe(0);
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
