// @effect-diagnostics nodeBuiltinImport:off - Execute the inert import boundary without a live browser.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import { deliveryConfiguration } from "../qualify-delivery-retry.ts";
import { deliveryScenes, deliveryThemes } from "./delivery-retry-evidence.ts";
import { classifyQualificationFailure } from "./chat-upload-evidence.ts";

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
