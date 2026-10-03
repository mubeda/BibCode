// @effect-diagnostics nodeBuiltinImport:off - Execute the inert import boundary without a live browser.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { describe, expect, it, vi } from "vite-plus/test";
import { deliveryConfiguration } from "../qualify-delivery-retry.ts";
import { deliveryScenes, deliveryThemes } from "./delivery-retry-evidence.ts";
import { classifyQualificationFailure } from "./chat-upload-evidence.ts";
import { bounded } from "./qualification-owner.ts";

const environment = {
  CI: "true",
  BIBCODE_UPLOAD_SOURCE: "a".repeat(40),
  BIBCODE_UPLOAD_NETNS: "net:[owned]",
  BIBCODE_UPLOAD_FIXTURE: "/owned/fixture",
  BIBCODE_UPLOAD_EVIDENCE: "/owned/evidence",
  BIBCODE_UPLOAD_SERVER: "/owned/bibcode",
  BIBCODE_DELIVERY_UI_WEB: "/owned/web",
  BIBCODE_UPLOAD_CHROME: "/owned/chrome",
  BIBCODE_UPLOAD_DRIVER: "/owned/driver",
};

describe("delivery controller admission", () => {
  it("consumes only explicit owned inputs and has a finite six-image manifest", () => {
    expect(deliveryConfiguration(environment, () => "net:[owned]")).toEqual({
      source: "a".repeat(40),
      fixture: "/owned/fixture",
      evidence: "/owned/evidence",
      binary: "/owned/bibcode",
      assets: "/owned/web",
      chrome: "/owned/chrome",
      driver: "/owned/driver",
    });
    expect(
      deliveryThemes.flatMap((theme) => deliveryScenes.map((scene) => `${scene}-${theme}.png`)),
    ).toEqual([
      "uncertain-light.png",
      "retry-cancelled-light.png",
      "new-conversation-light.png",
      "uncertain-dark.png",
      "retry-cancelled-dark.png",
      "new-conversation-dark.png",
    ]);
  });
  it.each(Object.keys(environment))("refuses missing %s before namespace access", (key) => {
    const missing: NodeJS.ProcessEnv = { ...environment };
    delete missing[key];
    let reads = 0;
    expect(() =>
      deliveryConfiguration(missing, () => {
        reads += 1;
        return "net:[owned]";
      }),
    ).toThrow(/configuration refused/);
    expect(reads).toBe(0);
  });
  it("refuses a different or unavailable namespace with closed errors", () => {
    expect(() => deliveryConfiguration(environment, () => "net:[foreign]")).toThrow(
      "Owned delivery qualification namespace refused.",
    );
    expect(() =>
      deliveryConfiguration(environment, () => {
        throw new Error("private-namespace-path");
      }),
    ).toThrow("Owned delivery qualification namespace refused.");
  });
});

const controller = NodeFS.readFileSync(
  new URL("../qualify-delivery-retry.ts", import.meta.url),
  "utf8",
);
const surface = '[data-center-surface-host][data-visible="true"]';
const composer = `${surface} [data-testid="composer-editor"]`;
const form = `${surface} [data-chat-composer-form="true"]`;
const trigger = `${form} [data-chat-provider-model-picker="true"]`;
const exactModel =
  '[data-model-picker-content="true"] [data-model-picker-instance-id="claudeAgent"][data-model-picker-model-slug="opus"]';
const project = "/private-owned-workspace";

function worktreeOpeningBoundary(
  options: {
    fail?: string;
    focusAfterTabs?: number;
    initiallyFocused?: boolean;
    loseFocusAfterEnabled?: boolean;
    finalCount?: number;
  } = {},
) {
  const calls: string[] = [];
  const phases: string[] = [];
  const keys: string[] = [];
  let tabs = 0;
  let countReads = 0;
  let focused = options.initiallyFocused ?? false;
  let displayed = false;
  let enabled = false;
  const failure = new Error("private-target?token=private-token timed out");
  const hit = async (name: string, args: unknown[] = []) => {
    expect(args).toEqual([]);
    calls.push(name);
    if (name === options.fail) throw failure;
  };
  const browser = {
    $$: (selector: string) => {
      expect(selector).toBe('button[aria-label^="New worktree in "]');
      return {
        length: hit("count").then(() => (++countReads === 1 ? 1 : (options.finalCount ?? 1))),
      };
    },
    $: (selector: string) => {
      expect(selector).toBe('button[aria-label^="New worktree in "]');
      return {
        isFocused: async () => {
          await hit("focused");
          return focused;
        },
        waitForDisplayed: async (...args: unknown[]) => {
          await hit("displayed", args);
          // Actual compiled CSS requires focus-within when hover does not expose this strip.
          if (!focused) throw failure;
          displayed = true;
        },
        waitForEnabled: async (...args: unknown[]) => {
          await hit("enabled", args);
          enabled = true;
          if (options.loseFocusAfterEnabled) focused = false;
        },
      };
    },
    keys: async (key: string) => {
      keys.push(key);
      if (key === "Tab") {
        await hit("tab");
        focused = ++tabs === (options.focusAfterTabs ?? 2);
      } else {
        expect(key).toBe("Enter");
        expect(focused && displayed && enabled).toBe(true);
        await hit("enter");
      }
    },
  };
  const helpersStart = controller.indexOf("  const step =");
  const helpersEnd = controller.indexOf("  const row =", helpersStart);
  const openingStart = controller.indexOf(
    "    const create =",
    controller.indexOf("  async function createOwnedWorkspace("),
  );
  const openingEnd = controller.indexOf('    step("worktree-name");', openingStart);
  expect(openingStart).toBeGreaterThan(0);
  expect(openingEnd).toBeGreaterThan(openingStart);
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      'let phase = "setup"; const theme = "light";\n' +
        controller.slice(helpersStart, helpersEnd) +
        "\nasync function open() {\n" +
        controller.slice(openingStart, openingEnd) +
        "\n}\nopen",
    ),
    {
      browser,
      write: (_name: string, value: { phase: string }) => phases.push(value.phase),
      owner: {
        until: async (read: () => Promise<boolean>, ...options: unknown[]) => {
          expect(options).toEqual([]);
          for (let attempt = 0; attempt < 3; attempt++) if (await read()) return;
          throw failure;
        },
      },
    },
  ) as () => Promise<void>;
  return { run, calls, phases, keys, failure };
}

describe("exact worktree opening attribution", () => {
  it("uses public keyboard focus and Enter when hover does not expose the action", async () => {
    const f = worktreeOpeningBoundary();
    await f.run();
    expect(f.keys).toEqual(["Tab", "Tab", "Enter"]);
    expect(f.calls).toEqual([
      "count",
      "focused",
      "tab",
      "focused",
      "focused",
      "tab",
      "focused",
      "displayed",
      "enabled",
      "count",
      "focused",
      "enter",
    ]);
  });

  it.each([
    ["count", "worktree-open-count"],
    ["focused", "worktree-open-focus"],
    ["tab", "worktree-open-focus"],
    ["displayed", "worktree-open-displayed"],
    ["enabled", "worktree-open-enabled"],
    ["enter", "worktree-open-enter"],
  ])(
    "retains the failing public %s await without retry or private data",
    async (fail, expected) => {
      const f = worktreeOpeningBoundary({ fail });
      await expect(f.run()).rejects.toBe(f.failure);
      expect(f.calls.at(-1)).toBe(fail);
      expect(f.phases.at(-1)).toBe(expected);
      const retained = { phase: f.phases.at(-1), failure: classifyQualificationFailure(f.failure) };
      expect(retained.failure.kind).toBe("timeout");
      expect(JSON.stringify(retained)).not.toMatch(/private|token=/);
      expect(f.keys.filter((key) => key === "Enter")).toHaveLength(fail === "enter" ? 1 : 0);
    },
  );

  it("keeps an already focused action and sends only Enter after readiness", async () => {
    const f = worktreeOpeningBoundary({ initiallyFocused: true });
    await f.run();
    expect(f.keys).toEqual(["Enter"]);
    expect(f.calls).toEqual([
      "count",
      "focused",
      "displayed",
      "enabled",
      "count",
      "focused",
      "enter",
    ]);
  });

  it("stops at the existing focus-search bound without activation", async () => {
    const f = worktreeOpeningBoundary({ focusAfterTabs: 99 });
    await expect(f.run()).rejects.toBe(f.failure);
    expect(f.phases.at(-1)).toBe("worktree-open-focus");
    expect(f.keys).toEqual(["Tab", "Tab", "Tab"]);
    expect(f.calls).not.toContain("displayed");
  });

  it.each([{ loseFocusAfterEnabled: true }, { finalCount: 0 }, { finalCount: 2 }])(
    "refuses stale focus or changed control ownership before Enter: %j",
    async (options) => {
      const f = worktreeOpeningBoundary(options);
      await expect(f.run()).rejects.toThrow("Owned delivery qualification assertion failed.");
      expect(f.phases.at(-1)).toBe("worktree-open-focus-confirm");
      expect(f.keys).toEqual(["Tab", "Tab"]);
    },
  );
});

it("targets the selected managed worktree, preserving the primary Git anchor during loss", async () => {
  const start = controller.indexOf('      step("workspace-loss");');
  const end = controller.indexOf('      step("uncertain");', start);
  expect(start).toBeGreaterThan(0);
  const calls: string[] = [];
  const selected = {
    path: "/private-owned-root/worktrees/selected",
    threadId: "owned-thread",
    branch: "codex/delivery-retry-light",
    commonDirectory: "/private-owned-root/project/.git",
  };
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      "async function loss() {" + controller.slice(start, end) + "}\nloss",
    ),
    {
      step: (name: string) => calls.push(name),
      runRoot: "/private-owned-root",
      context: { projectPath: "/private-owned-root/project" },
      workspace: selected,
      id: "owned-message",
      row: () => "owned-message-row",
      check: (value: unknown) => expect(value).toBe(true),
      NodeFS: {
        statSync: (path: string) => {
          expect(["/private-owned-root/project", selected.commonDirectory]).toContain(path);
          return { isDirectory: () => true };
        },
      },
      withUnavailableWorkspace: async (
        root: string,
        path: string,
        observe: () => Promise<void>,
      ) => {
        expect(root).toBe("/private-owned-root");
        expect(path).toBe(selected.path);
        await observe();
        calls.push("restored");
      },
      owner: {
        until: async (read: () => Promise<boolean>) => {
          expect(await read()).toBe(true);
        },
      },
      browser: {
        $: () => ({
          isExisting: async () => true,
          getText: async () =>
            "Delivery uncertain\nThe worktree directory is missing. Git registration remains.",
        }),
      },
    },
  );
  await run();
  expect(calls).toContain("restored");
});

it.each([
  "selected",
  "no-project",
  "ambiguous-project",
  "no-selected-card",
  "unsafe-git",
  "wrong-tooltip",
  "selection-changed",
])("creates and binds a real managed-worktree UI flow before delivery: %s", async (mode) => {
  const phases: string[] = [],
    clicks: string[] = [];
  let createFocused = false,
    dialogOpened = false,
    branchHovered = false,
    modelSelected = false,
    created = false,
    named = false;
  const identity = {
    path: "/owned/run/worktrees/selected",
    branch: "codex/delivery-retry-light",
    commonDirectory: "/owned/run/project/.git",
  };
  const selectedReader = () => null;
  const click = async (selector: string) => {
    expect(dialogOpened).toBe(true);
    clicks.push(selector);
    if (selector.includes("starts-with")) {
      expect(named).toBe(true);
      created = true;
    }
  };
  const browser = {
    $$: () => ({
      length: Promise.resolve(mode === "no-project" ? 0 : mode === "ambiguous-project" ? 2 : 1),
    }),
    $: (selector: string) => ({
      moveTo: async () => {
        branchHovered = true;
      },
      isFocused: async () => createFocused,
      waitForDisplayed: async (options?: { reverse?: boolean }) => {
        if (options?.reverse) expect(created).toBe(true);
      },
      waitForEnabled: async () => {},
      click: () => click(selector),
      setValue: async (value: string) => {
        expect(dialogOpened).toBe(true);
        expect(value).toBe(identity.branch);
        named = true;
      },
    }),
    keys: async (key: string) => {
      if (key === "Tab") createFocused = true;
      else {
        expect(key).toBe("Enter");
        expect(createFocused).toBe(true);
        dialogOpened = true;
      }
    },
    execute: async (read: unknown, input: unknown) => {
      if (read === selectedReader) {
        expect(created).toBe(true);
        return mode === "no-selected-card"
          ? null
          : { threadId: modelSelected && mode === "selection-changed" ? "other" : "owned-thread" };
      }
      expect(branchHovered).toBe(true);
      expect(input).toBe("Worktree: selected (codex/delivery-retry-light)");
      return mode !== "wrong-tooltip";
    },
  };
  const start = controller.indexOf("  async function createOwnedWorkspace(");
  const end = controller.indexOf("  async function type(", start);
  expect(start).toBeGreaterThan(0);
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(controller.slice(start, end) + "\ncreateOwnedWorkspace"),
    {
      theme: "light",
      origin: "http://127.0.0.1:4885",
      config: { fixture: "/owned" },
      NodePath: { join: (...parts: string[]) => parts.join("/"), basename: () => "selected" },
      step: (name: string) => phases.push(name),
      b: () => browser,
      check: (value: unknown) => {
        if (!value) throw new Error("Owned refusal.");
      },
      click,
      owner: {
        until: async (read: () => Promise<boolean>) => {
          if (!(await read())) throw new Error("Owned refusal.");
        },
      },
      readSelectedDeliveryWorktree: selectedReader,
      readOwnedDeliveryWorktree: (input: Record<string, unknown>) => {
        expect(input).toMatchObject({
          root: "/owned/run",
          project: "/owned/run/project",
          home: "/owned/run/home",
          git: "/owned/bin/git",
          branch: identity.branch,
        });
        if (mode === "unsafe-git") throw new Error("Owned refusal.");
        return identity;
      },
      selectClaudeModel: async (scope: string) => {
        expect(scope).toBe("worktree");
        modelSelected = true;
      },
    },
  );
  const execute = () =>
    run(
      { projectPath: "/owned/run/project", fixtureUserHomePath: "/owned/run/home" },
      "/owned/run",
    );
  if (mode === "selected") {
    expect(await execute()).toEqual({ ...identity, threadId: "owned-thread" });
    expect(phases.at(-1)).toBe("worktree-ready");
    expect(modelSelected).toBe(true);
    expect(clicks).toHaveLength(1);
  } else {
    await expect(execute()).rejects.toThrow("Owned refusal.");
    if (mode === "no-project" || mode === "ambiguous-project") expect(clicks).toEqual([]);
  }
  expect(phases.every((phase) => /^worktree-[a-z-]+$/.test(phase))).toBe(true);
});

function importBoundary(
  options: {
    selectedLabel?: string | null;
    delayedLabel?: boolean;
    typePath?: boolean;
    fail?: string;
  } = {},
) {
  const phases: string[] = [];
  const calls: string[] = [];
  let pathReady = !options.typePath;
  let selected = false;
  let labelReads = 0;
  const invoke = (operation: string) => {
    calls.push(operation);
    if (options.fail === operation) throw new Error("private-path?capability=private-token");
  };
  const browser = {
    $: (selector: string) => ({
      waitForDisplayed: async () => invoke(`display:${selector}`),
      waitForEnabled: async () => invoke(`enabled:${selector}`),
      click: async () => {
        invoke(`click:${selector}`);
        if (selector === "button=Type a path instead") pathReady = true;
        if (selector.includes('[data-model-picker-instance-id="claudeAgent"]')) selected = true;
      },
      isDisplayed: async () => {
        invoke(`visible:${selector}`);
        return selector !== "#add-project-host-path" || pathReady;
      },
      isExisting: async () => pathReady,
      setValue: async (value: string) => {
        invoke(`set:${selector}`);
        if (!pathReady || value !== project) throw new Error("Unexpected import input.");
      },
      // Production ProviderModelPicker renders a model-only label. Provider identity
      // is in aria-label; ModelListRow owns the exact instance/slug attributes.
      getText: async () => "Opus 5",
      getAttribute: async (name: string) => {
        invoke(`attribute:${selector}:${name}`);
        if (selector !== trigger || name !== "aria-label" || !selected) return null;
        if (options.delayedLabel && labelReads++ === 0) return "Codex · GPT-5";
        return options.selectedLabel === undefined ? "Claude · Opus 5" : options.selectedLabel;
      },
    }),
  };
  const start = controller.indexOf("  async function importProject(");
  const end = controller.indexOf("  async function type(", start);
  const helpersStart = controller.indexOf("  const step =");
  const helpersEnd = controller.indexOf("  const row =", helpersStart);
  if (start < 0 || end < start || helpersStart < 0 || helpersEnd < helpersStart)
    throw new Error("Missing controller import boundary.");
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      'let phase = "import"; const theme = "light";\n' +
        controller.slice(helpersStart, helpersEnd) +
        controller.slice(start, end) +
        "\nimportProject",
    ),
    {
      browser,
      composer,
      form,
      write: (_name: string, value: { phase: string }) => phases.push(value.phase),
      owner: {
        until: async (probe: () => Promise<boolean>, timeout = 30_000) => {
          expect(timeout).toBe(30_000);
          for (let attempt = 0; attempt < 2; attempt++) if (await probe()) return;
          throw new Error("The required live observation did not arrive within its bound.");
        },
      },
    },
  ) as (project: string) => Promise<void>;
  return { run: () => run(project), phases, calls };
}

describe("delivery import through public controls", () => {
  it("accepts the selected Claude model when its visible text is only the model name", async () => {
    const f = importBoundary();
    await f.run();
    expect(f.calls).toContain(`click:${exactModel}`);
    expect(f.calls).toContain(`attribute:${trigger}:aria-label`);
  });

  it.each([null, "Codex · Opus 5", "Claude · Sonnet 5", "private-unexpected-label"])(
    "refuses missing or different selection: %s",
    async (selectedLabel) => {
      const f = importBoundary({ selectedLabel });
      await expect(f.run()).rejects.toThrow();
      expect(f.phases.at(-1)).toBe("import-verify-claude-opus");
      expect(JSON.stringify(f.phases)).not.toContain("private");
    },
  );

  it("waits for the selected public label and the fallback path input without changing bounds", async () => {
    const f = importBoundary({ delayedLabel: true, typePath: true });
    await f.run();
    expect(f.calls.indexOf("display:#add-project-host-path")).toBeLessThan(
      f.calls.indexOf("set:#add-project-host-path"),
    );
    expect(f.calls.filter((call) => call === `attribute:${trigger}:aria-label`)).toHaveLength(2);
  });

  it.each([
    ['click:[data-testid="sidebar-add-project-trigger"]', "import-open-project-menu"],
    [
      "click://button[@data-add-project-action='true'][.//span[normalize-space()='Browse folder']]",
      "import-browse-folder",
    ],
    ["visible:#add-project-host-path", "import-path-choice"],
    ["click:button=Type a path instead", "import-type-path"],
    ["display:#add-project-host-path", "import-path-ready"],
    ["set:#add-project-host-path", "import-fill-path"],
    ["click:button=Open project", "import-submit-project"],
    [`display:${composer}`, "import-wait-composer"],
    [`click:${trigger}`, "import-open-model-picker"],
    [`click:${exactModel}`, "import-select-claude-opus"],
    [`attribute:${trigger}:aria-label`, "import-verify-claude-opus"],
  ])("retains only the closed failing import subphase: %s", async (fail, expectedPhase) => {
    const f = importBoundary({ fail, typePath: true });
    let error: unknown;
    try {
      await f.run();
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeDefined();
    expect(f.phases.at(-1)).toBe(expectedPhase);
    expect(f.calls.at(-1)).toBe(fail);
    const retained = JSON.stringify({
      phase: f.phases.at(-1),
      failure: classifyQualificationFailure(error),
    });
    expect(retained).not.toMatch(/private|capability|workspace/);
  });
});

function pairingBoundary(
  options: { fail?: string; theme?: "light" | "dark"; grant?: unknown } = {},
) {
  const phases: string[] = [];
  const calls: string[] = [];
  const invoke = (operation: string) => {
    calls.push(operation);
    if (options.fail === operation) throw new Error("private-path?token=private-token timed out");
  };
  const theme = options.theme ?? "light";
  let dark = false;
  const browser = {
    url: async (url: string) => {
      invoke("navigate");
      expect(url).toBe("http://127.0.0.1:4885/pair");
    },
    $: (selector: string) => ({
      waitForDisplayed: async () => invoke(`display:${selector}`),
      waitForEnabled: async () => invoke(`enabled:${selector}`),
      click: async () => {
        invoke(`click:${selector}`);
        if (selector.includes('@role="option"')) dark = theme === "dark";
      },
      setValue: async (value: string) => {
        invoke("fill-token");
        expect(value).toBe("private-one-use-token");
      },
    }),
    execute: async (callback: (dark: boolean) => boolean, value: boolean) => {
      invoke("observe-theme");
      return callback(value);
    },
  };
  const grantStart = controller.indexOf("      const grant =");
  const start = controller.lastIndexOf("      step(", grantStart);
  const end = controller.indexOf('      step("import");', start);
  const themeStart = controller.indexOf("  async function setTheme()");
  const themeEnd = controller.indexOf("  async function importProject(", themeStart);
  const helpersStart = controller.indexOf("  const step =");
  const helpersEnd = controller.indexOf("  const row =", helpersStart);
  if ([grantStart, start, end, themeStart, themeEnd, helpersStart, helpersEnd].some((n) => n < 0))
    throw new Error("Missing controller pairing boundary.");
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      'let phase = "pair";\n' +
        controller.slice(helpersStart, helpersEnd) +
        controller.slice(themeStart, themeEnd) +
        "\nasync function pair(){\n" +
        controller.slice(start, end) +
        "\n}\npair",
    ),
    {
      browser,
      theme,
      origin: "http://127.0.0.1:4885",
      config: { binary: "/private-bibcode" },
      context: { stateRoot: "/private-state" },
      childEnv: { PRIVATE_TOKEN: "private-token" },
      document: { documentElement: { classList: { contains: () => dark } } },
      write: (_name: string, value: { phase: string }) => phases.push(value.phase),
      owner: {
        json: async (_binary: string, args: string[]) => {
          invoke("issue-credential");
          expect(args).toEqual(["pairing", "issue", "--base-dir", "/private-state", "--json"]);
          return options.grant === undefined
            ? { credential: "private-one-use-token" }
            : options.grant;
        },
        until: async (probe: () => Promise<boolean>, timeout = 30_000) => {
          expect(timeout).toBe(30_000);
          if (!(await probe())) throw new Error("Theme did not apply.");
        },
      },
    },
  ) as () => Promise<void>;
  return { run, phases, calls };
}

describe("closed pairing and theme attribution", () => {
  it.each([
    ["issue-credential", "pair-issue-credential"],
    ["navigate", "pair-navigate"],
    ["display:#pairing-token", "pair-wait-token"],
    ["fill-token", "pair-fill-token"],
    ["click:button=Continue", "pair-submit"],
    ['display:[data-testid="sidebar-add-project-trigger"]', "pair-wait-sidebar"],
    [
      'display:[data-testid="environment-rail-local"] [data-status="connected"]',
      "pair-wait-connected",
    ],
    ['click:[data-testid="environment-rail-manage"]', "theme-open-settings"],
    ["click:button=General", "theme-open-general"],
    ['click:[aria-label="Theme preference"]', "theme-open-preference"],
    ['click://*[@role="option" and normalize-space()="Light"]', "theme-select"],
    ["observe-theme", "theme-wait-applied"],
    ["click:button=Remote Servers", "theme-open-remote-servers"],
    ["click:button=Back", "theme-back"],
  ])(
    "identifies the last attempted boundary without retaining private errors: %s",
    async (fail, phase) => {
      const f = pairingBoundary({ fail });
      let error: unknown;
      try {
        await f.run();
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeDefined();
      expect(f.calls.at(-1)).toBe(fail);
      expect(f.phases.at(-1)).toBe(phase);
      expect(
        JSON.stringify({ phase: f.phases.at(-1), failure: classifyQualificationFailure(error) }),
      ).not.toMatch(/private|credential=|token=/);
    },
  );

  it("identifies a refused credential shape before any navigation or token entry", async () => {
    const f = pairingBoundary({ grant: null });
    await expect(f.run()).rejects.toThrow("Owned pairing credential unavailable.");
    expect(f.calls).toEqual(["issue-credential"]);
    expect(f.phases.at(-1)).toBe("pair-check-credential");
  });

  it.each(["light", "dark"] as const)(
    "preserves successful public actions and theme observation: %s",
    async (theme) => {
      const f = pairingBoundary({ theme });
      await f.run();
      expect(f.calls).toContain(
        `click://*[@role="option" and normalize-space()="${theme === "light" ? "Light" : "Dark"}"]`,
      );
      expect(f.calls.at(-1)).toBe("click:button=Back");
      expect(f.phases.at(-1)).toBe("theme-back");
    },
  );
});

function startupFailureBoundary(
  options: {
    phase?: string;
    location?: { origin?: string; pathname?: string; search?: string; hash?: string };
    noBrowser?: boolean;
    token?: boolean;
    pending?: boolean;
    themeControl?: boolean;
    dark?: boolean;
    response?: unknown;
    read?: "reject" | "pending";
  } = {},
) {
  const writes: Array<{ startupObservation?: unknown }> = [];
  let reads = 0;
  let queries = 0;
  let finishRead: (value: unknown) => void = () => {
    throw new Error("No pending observation.");
  };
  class Input {
    disabled = false;
    form = {
      querySelector: (selector: string) =>
        selector === 'button[type="submit"]'
          ? new Button()
          : selector === ".text-destructive"
            ? {}
            : null,
    };
    get value(): never {
      throw new Error("Credential value must not be read.");
    }
  }
  class Button {
    disabled = false;
  }
  const browser = {
    execute: async (callback: (origin: string) => unknown, expectedOrigin: string) => {
      reads++;
      if (options.read === "reject")
        throw new Error("private-webdriver-message?token=private-token");
      if (options.read === "pending")
        return new Promise((resolve) => {
          finishRead = resolve;
        });
      if (Object.hasOwn(options, "response")) return options.response;
      return callback(expectedOrigin);
    },
  };
  const start = controller.lastIndexOf("  } catch (error) {");
  const end = controller.indexOf("  } finally {", start);
  const helperStart = controller.indexOf("  async function readStartupFailureObservation()");
  const helperEnd = controller.indexOf("  async function setTheme()", helperStart);
  const projectorStart = controller.indexOf("export function projectDeliveryStartupObservation(");
  const projectorEnd = controller.indexOf("export async function runDeliveryRetryQualification()");
  if (start < 0 || end < start) throw new Error("Missing controller failure boundary.");
  const projector =
    projectorStart < 0 ? "" : controller.slice(projectorStart, projectorEnd).replace("export ", "");
  const helper = helperStart < 0 ? "" : controller.slice(helperStart, helperEnd);
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      projector +
        helper +
        "\nasync function failure(){" +
        controller.slice(start + "  } catch (error) {".length, end) +
        "}\nfailure",
    ),
    {
      browser: options.noBrowser ? undefined : browser,
      phase: options.phase ?? "pair-wait-sidebar",
      theme: "light",
      origin: "http://127.0.0.1:4885",
      error: new Error("private-path?credential=private-token timed out"),
      bounded,
      classifyQualificationFailure,
      write: (_name: string, value: { startupObservation?: unknown }) => writes.push(value),
      location: {
        origin: "http://127.0.0.1:4885",
        pathname: "/pair",
        search: "",
        hash: "",
        ...options.location,
      },
      navigator: { onLine: true },
      HTMLInputElement: Input,
      HTMLButtonElement: Button,
      document: {
        readyState: "complete",
        documentElement: { classList: { contains: () => options.dark === true } },
        querySelector: (selector: string) => {
          queries++;
          if (selector === "#pairing-token") return options.token === false ? null : new Input();
          if (selector === "h1")
            return {
              textContent: options.pending
                ? "Pairing with this environment"
                : "private-unexpected-page-heading",
            };
          if (selector === '[aria-label="Theme preference"]')
            return options.themeControl ? {} : null;
          return null;
        },
      },
    },
  ) as () => Promise<void>;
  return {
    run,
    writes,
    reads: () => reads,
    queries: () => queries,
    finishRead: (value: unknown) => finishRead(value),
  };
}

describe("closed failure-only startup observation", () => {
  it("retains known pairing controls and an error-presence boolean without credential/text values", async () => {
    const f = startupFailureBoundary();
    await f.run();
    expect(f.writes[0]?.startupObservation).toEqual({
      safeLocation: true,
      route: "pair",
      readyState: "complete",
      online: true,
      tokenInputPresent: true,
      tokenInputDisabled: false,
      submitPresent: true,
      submitDisabled: false,
      pairingErrorPresent: true,
      pendingHeadingPresent: false,
      sidebarPresent: false,
      primaryConnected: false,
      themeControlPresent: false,
      darkTheme: false,
    });
    expect(f.reads()).toBe(1);
    expect(JSON.stringify(f.writes)).not.toMatch(/private|http|token=/);
  });

  it("distinguishes the actual pending heading and selected theme route using closed facts", async () => {
    const pending = startupFailureBoundary({ token: false, pending: true });
    await pending.run();
    expect(pending.writes[0]?.startupObservation).toMatchObject({
      tokenInputPresent: false,
      pendingHeadingPresent: true,
    });
    const theme = startupFailureBoundary({
      phase: "theme-wait-applied",
      token: false,
      themeControl: true,
      dark: true,
      location: { pathname: "/settings/general" },
    });
    await theme.run();
    expect(theme.writes[0]?.startupObservation).toMatchObject({
      route: "settings-general",
      themeControlPresent: true,
      darkTheme: true,
    });
  });

  it.each([
    { origin: "https://private-host" },
    { search: "?token=private-token" },
    { hash: "#private-token" },
  ])("refuses unexpected locations before any DOM read: %j", async (location) => {
    const f = startupFailureBoundary({ location });
    await f.run();
    expect(f.queries()).toBe(0);
    const observed = f.writes[0]?.startupObservation as Record<string, unknown>;
    expect(observed?.safeLocation).toBe(false);
    expect(
      Object.entries(observed)
        .filter(([key]) => key !== "safeLocation")
        .every(([, value]) => value === null),
    ).toBe(true);
    expect(JSON.stringify(f.writes)).not.toContain("private");
  });

  it.each([{ safeLocation: true }, { safeLocation: false }, { safeLocation: [true] }])(
    "projects malformed or extra WebDriver values to unknown rather than retaining them: %j",
    async ({ safeLocation }) => {
      const f = startupFailureBoundary({
        response: {
          route: "/pair?token=private-token",
          online: "private-token",
          safeLocation,
          readyState: "private-ready",
          extra: "private-body",
        },
      });
      await f.run();
      const observed = f.writes[0]?.startupObservation as Record<string, unknown>;
      expect(observed.safeLocation).toBe(typeof safeLocation === "boolean" ? safeLocation : null);
      expect(
        Object.entries(observed)
          .filter(([key]) => key !== "safeLocation")
          .every(([, value]) => value === null),
      ).toBe(true);
      expect(JSON.stringify(f.writes)).not.toContain("private");
    },
  );

  it.each([{ phase: "baseline" }, { noBrowser: true }, { read: "reject" as const }])(
    "does not let missing or failed diagnostics obstruct failure reporting: %j",
    async (options) => {
      const f = startupFailureBoundary(options);
      await f.run();
      expect(f.writes).toHaveLength(1);
      expect(f.writes[0]?.startupObservation).toBeNull();
      expect(f.reads()).toBe(options.read ? 1 : 0);
      expect(JSON.stringify(f.writes)).not.toContain("private");
    },
  );

  it("bounds the read at two seconds and never publishes its late result", async () => {
    vi.useFakeTimers();
    try {
      const f = startupFailureBoundary({ read: "pending" });
      const running = f.run();
      await vi.advanceTimersByTimeAsync(2000);
      await running;
      expect(f.writes[0]?.startupObservation).toBeNull();
      f.finishRead({ raw: "private-late-body" });
      await Promise.resolve();
      expect(f.writes).toHaveLength(1);
      expect(JSON.stringify(f.writes)).not.toContain("private");
    } finally {
      vi.useRealTimers();
    }
  });
});

function worktreeFailureBoundary(
  options: {
    count?: number;
    noHeader?: boolean;
    hidden?: boolean;
    disabled?: boolean;
    covered?: boolean;
    notHovered?: boolean;
    dialog?: boolean;
    picker?: boolean;
    visibilityUnavailable?: boolean;
    location?: { origin?: string; search?: string; hash?: string };
    phase?: string;
    noBrowser?: boolean;
    response?: unknown;
    read?: "reject" | "pending";
  } = {},
) {
  const writes: Array<{ worktreeObservation?: unknown; failure?: { kind: string } }> = [];
  let reads = 0,
    queries = 0;
  let finishRead: (value: unknown) => void = () => {
    throw new Error("No pending read.");
  };
  class Element {
    readonly kind: string;
    constructor(kind: string) {
      this.kind = kind;
    }
    get textContent(): never {
      throw new Error("No page text reads.");
    }
    checkVisibility(input: unknown) {
      expect(input).toEqual({
        contentVisibilityAuto: true,
        opacityProperty: true,
        visibilityProperty: true,
      });
      return !options.hidden;
    }
    getBoundingClientRect() {
      return { left: this.kind === "header" ? 0 : 100, top: 0, width: 20, height: 20 };
    }
    contains(value: unknown) {
      return value === this;
    }
    matches(selector: string) {
      expect(selector).toBe(":hover");
      return !options.notHovered;
    }
  }
  const header = new Element("header");
  class Button extends Element {
    disabled = options.disabled === true;
    get value(): never {
      throw new Error("No input value reads.");
    }
    closest(selector: string) {
      expect(selector).toBe('div[class~="group/project-header"]');
      return options.noHeader ? null : header;
    }
  }
  const button = new Button("create");
  const dialog = new Element("dialog"),
    picker = new Element("picker");
  if (options.visibilityUnavailable)
    for (const node of [header, button, dialog, picker])
      Object.defineProperty(node, "checkVisibility", { value: undefined });
  const browser = {
    execute: async (callback: (origin: string) => unknown, expectedOrigin: string) => {
      reads++;
      if (options.read === "reject") throw new Error("private-driver-error");
      if (options.read === "pending")
        return new Promise((resolve) => {
          finishRead = resolve;
        });
      if (Object.hasOwn(options, "response")) return options.response;
      return callback(expectedOrigin);
    },
  };
  const projectorStart = controller.indexOf("export function projectDeliveryWorktreeObservation(");
  const projectorEnd = controller.indexOf("export function projectDeliveryStartupObservation(");
  const helperStart = controller.indexOf("  async function readWorktreeFailureObservation()");
  const helperEnd = controller.indexOf("  async function setTheme()", helperStart);
  const catchStart = controller.lastIndexOf("  } catch (error) {");
  const catchEnd = controller.indexOf("  } finally {", catchStart);
  const projector =
    projectorStart < 0 ? "" : controller.slice(projectorStart, projectorEnd).replace("export ", "");
  const helper = helperStart < 0 ? "" : controller.slice(helperStart, helperEnd);
  const run = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      projector +
        helper +
        "\nasync function fail() {" +
        controller.slice(catchStart + "  } catch (error) {".length, catchEnd) +
        "\n}\nfail",
    ),
    {
      browser: options.noBrowser ? undefined : browser,
      phase: options.phase ?? "worktree-open-displayed",
      theme: "light",
      origin: "http://127.0.0.1:4885",
      error: new Error("private-original-error timed out"),
      bounded,
      classifyQualificationFailure,
      write: (_name: string, value: { worktreeObservation?: unknown }) => writes.push(value),
      HTMLButtonElement: Button,
      location: {
        origin: "http://127.0.0.1:4885",
        search: "",
        hash: "",
        ...options.location,
        get href(): never {
          throw new Error("No URL reads.");
        },
        get pathname(): never {
          throw new Error("No route reads.");
        },
      },
      document: {
        get body(): never {
          throw new Error("No body reads.");
        },
        querySelectorAll: (selector: string) => {
          queries++;
          if (selector === 'button[aria-label^="New worktree in "]')
            return Array.from({ length: options.count ?? 1 }, () => button);
          if (selector === '[data-slot="dialog-popup"][role="dialog"]')
            return options.dialog ? [dialog] : [];
          if (selector === '[data-model-picker-content="true"]')
            return options.picker ? [picker] : [];
          throw new Error("Unexpected DOM query.");
        },
        elementFromPoint: (x: number) => {
          queries++;
          return options.covered ? {} : x < 50 ? header : button;
        },
      },
    },
  ) as () => Promise<void>;
  return {
    run,
    writes,
    reads: () => reads,
    queries: () => queries,
    finishRead: (value: unknown) => finishRead(value),
  };
}

describe("closed worktree-opening failure facts", () => {
  it.each([
    "worktree-open-focus",
    "worktree-open-focus-confirm",
    "worktree-open-enter",
    "worktree-open-displayed",
  ])("samples closed DOM facts once after %s", async (phase) => {
    const f = worktreeFailureBoundary({
      phase,
      hidden: true,
      disabled: true,
      covered: true,
      notHovered: true,
      dialog: true,
      picker: true,
    });
    await f.run();
    expect(f.writes[0]?.worktreeObservation).toEqual({
      safeLocation: true,
      createCount: "one",
      headerHovered: false,
      headerVisible: false,
      headerHitTarget: false,
      createVisible: false,
      createEnabled: false,
      createHitTarget: false,
      dialogVisible: false,
      modelPickerVisible: false,
    });
    expect(f.reads()).toBe(1);
    expect(f.writes[0]?.failure?.kind).toBe("timeout");
    expect(JSON.stringify(f.writes)).not.toMatch(/private|http|token=|new-worktree/);
  });

  it("distinguishes a visible public dialog and picker from absent controls", async () => {
    const f = worktreeFailureBoundary({ dialog: true, picker: true, noHeader: true });
    await f.run();
    expect(f.writes[0]?.worktreeObservation).toMatchObject({
      createCount: "one",
      headerHovered: null,
      headerVisible: null,
      headerHitTarget: null,
      createVisible: true,
      createEnabled: true,
      createHitTarget: true,
      dialogVisible: true,
      modelPickerVisible: true,
    });
  });

  it.each([
    [0, "none"],
    [2, "multiple"],
  ] as const)("does not choose an arbitrary button from count %s", async (count, category) => {
    const f = worktreeFailureBoundary({ count });
    await f.run();
    expect(f.writes[0]?.worktreeObservation).toEqual({
      safeLocation: true,
      createCount: category,
      headerHovered: null,
      headerVisible: null,
      headerHitTarget: null,
      createVisible: null,
      createEnabled: null,
      createHitTarget: null,
      dialogVisible: false,
      modelPickerVisible: false,
    });
  });

  it("keeps unavailable visibility unknown instead of substituting WebDriver state", async () => {
    const f = worktreeFailureBoundary({ visibilityUnavailable: true, dialog: true, picker: true });
    await f.run();
    expect(f.writes[0]?.worktreeObservation).toMatchObject({
      headerVisible: null,
      createVisible: null,
      dialogVisible: null,
      modelPickerVisible: null,
    });
  });

  it.each([{ origin: "https://private" }, { search: "?private" }, { hash: "#private" }])(
    "refuses foreign or credential-bearing locations before DOM reads: %j",
    async (location) => {
      const f = worktreeFailureBoundary({ location });
      await f.run();
      expect(f.queries()).toBe(0);
      const value = f.writes[0]?.worktreeObservation as Record<string, unknown>;
      expect(value?.safeLocation).toBe(false);
      expect(
        Object.entries(value)
          .filter(([key]) => key !== "safeLocation")
          .every(([, value]) => value === null),
      ).toBe(true);
      expect(JSON.stringify(f.writes)).not.toContain("private");
    },
  );

  it.each([true, false, "private"] as const)(
    "projects only finite types for safe location %s",
    async (safeLocation) => {
      const f = worktreeFailureBoundary({
        response: {
          safeLocation,
          createCount: "private",
          headerHovered: "private",
          createEnabled: "private",
          extra: "private",
        },
      });
      await f.run();
      const value = f.writes[0]?.worktreeObservation as Record<string, unknown>;
      expect(value?.safeLocation).toBe(typeof safeLocation === "boolean" ? safeLocation : null);
      expect(
        Object.entries(value)
          .filter(([key]) => key !== "safeLocation")
          .every(([, value]) => value === null),
      ).toBe(true);
      expect(JSON.stringify(f.writes)).not.toContain("private");
    },
  );

  it.each([
    { noBrowser: true },
    { phase: "worktree-git-identity" },
    { phase: "worktree-open-model-picker" },
    { read: "reject" as const },
  ])("preserves failure without missing/non-opening/failed observations: %j", async (options) => {
    const f = worktreeFailureBoundary(options);
    await f.run();
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]?.worktreeObservation).toBeNull();
    expect(f.writes[0]?.failure?.kind).toBe("timeout");
    expect(f.reads()).toBe(options.read ? 1 : 0);
  });

  it("uses the existing two-second bound and never republishes a late observation", async () => {
    vi.useFakeTimers();
    try {
      const f = worktreeFailureBoundary({ read: "pending" });
      const running = f.run();
      await vi.advanceTimersByTimeAsync(1999);
      expect(f.writes).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await running;
      expect(f.writes[0]?.worktreeObservation).toBeNull();
      expect(f.writes[0]?.failure?.kind).toBe("timeout");
      f.finishRead({ raw: "private-late-data" });
      await Promise.resolve();
      expect(f.writes).toHaveLength(1);
      expect(JSON.stringify(f.writes)).not.toContain("private");
    } finally {
      vi.useRealTimers();
    }
  });
});
