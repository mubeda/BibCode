// @effect-diagnostics nodeBuiltinImport:off - Inspect and execute only inert portions of the QA controller.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import * as NodeModule from "node:module";
import { expect, it } from "vite-plus/test";
import {
  remoteUiPlan,
  remoteUiScenes,
  remoteUiThemes,
  screenshotName,
} from "./remote-ui-evidence.ts";

const controller = NodeFS.readFileSync(
  new URL("../qualify-remote-updates.ts", import.meta.url),
  "utf8",
);

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
