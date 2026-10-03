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
