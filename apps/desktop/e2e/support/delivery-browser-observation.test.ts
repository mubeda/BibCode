// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - Serialized fixed diagnostics and actual caller metadata only.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  projectPrViewportObservation,
  projectModelClickObservation,
  observePrViewportNumbers,
  observePrOuterNumbers,
  readDeliveryModelClickObservation,
} from "./delivery-browser-observation.ts";
const pr = {
  viewportReadReturned: true,
  viewportNumbersFinite: true,
  viewportDimensionsPositive: true,
  viewportScaleOne: true,
  outerReadReturned: true,
  outerDimensionsPositive: true,
  correctionFinitePositive: true,
  resizeReturned: true,
  lastViewportExact: false,
};
const model = {
  modelRowCountOne: true,
  modelRowRoleOption: true,
  modelRowDisplayed: true,
  modelRowCenterInViewport: true,
  modelRowCenterHitsRow: true,
  modelRowCenterHitsFavorite: false,
  composerTriggerCountOne: true,
  triggerLabelExpected: false,
};
it("admits immutable fixed facts and diagnoses only actual primitive SDK fields", () => {
  expect(projectPrViewportObservation(pr)).toEqual(pr);
  expect(Object.isFrozen(projectPrViewportObservation(pr))).toBe(true);
  expect(projectModelClickObservation(model)).toEqual(model);
  expect(observePrViewportNumbers({ width: 1280, height: 960, devicePixelRatio: 1 })).toEqual({
    viewportNumbersFinite: true,
    viewportDimensionsPositive: true,
    viewportScaleOne: true,
  });
  expect(observePrOuterNumbers({ width: 1280, height: 1040 })).toBe(true);
});
it.each(["extra", "missing", "getter", "proxy", "revoked", "array", "type"])(
  "quarantines %s metadata without a getter or proxy trap",
  (mode) => {
    let reads = 0;
    const input: Record<string, unknown> = { ...pr };
    if (mode === "extra") input.private = "inert";
    if (mode === "missing") delete input.resizeReturned;
    if (mode === "type") input.resizeReturned = "inert";
    if (mode === "getter")
      Object.defineProperty(input, "resizeReturned", {
        enumerable: true,
        get() {
          reads++;
          throw new Error("inert");
        },
      });
    const revoked = Proxy.revocable(input, {});
    if (mode === "revoked") revoked.revoke();
    const value =
      mode === "proxy"
        ? new Proxy(input, {
            ownKeys() {
              reads++;
              throw new Error("inert");
            },
          })
        : mode === "revoked"
          ? revoked.proxy
          : mode === "array"
            ? [input]
            : input;
    expect(projectPrViewportObservation(value)).toBeNull();
    expect(reads).toBe(0);
  },
);
it("leaves unsafe SDK values unknown without interpreting a nested object", () => {
  let reads = 0;
  const value = {
    get width() {
      reads++;
      throw new Error("inert");
    },
    height: 960,
    devicePixelRatio: 1,
  };
  expect(observePrViewportNumbers(value)).toBeNull();
  expect(reads).toBe(0);
  expect(observePrOuterNumbers({ width: 1280, height: 960, private: 1 })).toBeNull();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});
it.each(["row", "favorite", "foreign", "duplicate", "offscreen"])(
  "serialized pre-click sample preserves original target and returns only bool/null: %s",
  (mode) => {
    vi.stubGlobal("location", {
      origin: "http://127.0.0.1:4885",
      pathname: "/local/owned",
      search: "",
      hash: "",
    });
    vi.stubGlobal("innerWidth", 1280);
    vi.stubGlobal("innerHeight", 960);
    document.body.innerHTML =
      '<div data-center-surface-host data-visible="true"><form data-chat-composer-form="true"><button data-chat-provider-model-picker="true" aria-label="Cursor · Cursor Fixture"></button></form></div><div data-model-picker-content="true"><div role="option" data-model-picker-instance-id="claudeAgent" data-model-picker-model-slug="opus"><span>private model description</span><button aria-label="Add to favorites"><span></span></button></div></div><div id="foreign">private overlay</div>';
    const row = document.querySelector('[role="option"]')!,
      favorite = row.querySelector("button")!;
    if (mode === "duplicate") row.parentElement!.append(row.cloneNode(true));
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 10,
      y: mode === "offscreen" ? 1000 : 10,
      left: 10,
      top: mode === "offscreen" ? 1000 : 10,
      width: 300,
      height: 80,
      right: 310,
      bottom: 90,
      toJSON: () => ({}),
    });
    const hit =
      mode === "favorite"
        ? favorite.firstElementChild
        : mode === "foreign"
          ? document.getElementById("foreign")
          : row.firstElementChild;
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => hit });
    const result = NodeVM.runInNewContext(
      "(" + readDeliveryModelClickObservation.toString() + ')("http://127.0.0.1:4885")',
      { location, document, innerWidth, innerHeight, getComputedStyle, Error },
    ) as Record<string, unknown>;
    expect(result.modelRowCountOne).toBe(mode !== "duplicate");
    if (mode !== "duplicate") {
      expect(result.modelRowRoleOption).toBe(true);
      expect(result.modelRowDisplayed).toBe(true);
      expect(result.modelRowCenterInViewport).toBe(mode !== "offscreen");
    }
    if (mode !== "duplicate" && mode !== "offscreen") {
      expect(result.modelRowCenterHitsRow).toBe(mode !== "foreign");
      expect(result.modelRowCenterHitsFavorite).toBe(mode === "favorite");
    }
    expect(
      Object.values(result).every((value) => value === null || typeof value === "boolean"),
    ).toBe(true);
    expect(projectModelClickObservation(result)).not.toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/private|owned|http|Cursor|Opus/);
  },
);
it("actual qualifier owns passive viewport stages and Settings-only pre-click read", () => {
  const source = NodeFS.readFileSync(
    new NodeURL.URL("../qualify-delivery-retry.ts", import.meta.url),
    "utf8",
  );
  expect(source).toContain('step("visual-pull-requests-viewport-read")');
  expect(source).toContain('step("visual-pull-requests-viewport-settle")');
  expect(source).toContain('config.selection === "release-visual-settings" && scope === "import"');
  expect(source).toContain("readDeliveryModelClickObservation");
  expect(source).toContain("prViewportObservation:");
  expect(source).toContain("modelClickObservation:");
});

it.each(["ordinary", "diagnostic-failure", "click-failure", "other-selection"] as const)(
  "actual model caller preserves click/error/bound semantics with %s",
  async (mode) => {
    const source = NodeFS.readFileSync(
        new NodeURL.URL("../qualify-delivery-retry.ts", import.meta.url),
        "utf8",
      ),
      start = source.indexOf("  async function selectClaudeModel("),
      end = source.indexOf("  async function openWorktreeDialog", start),
      calls: string[] = [],
      original = Object.freeze(new Error("Inert original click refusal."));

    const browser = {
      $: (selector: string) => ({
        waitForDisplayed: async () => {
          calls.push("display");
        },
        waitForEnabled: async () => {
          calls.push("enabled");
        },
        click: async () => {
          calls.push("native-click");
          if (mode === "click-failure") throw original;
        },
        getAttribute: async () => "Claude · Opus 5",
      }),
      execute: async (fn: Function, expected: string) => {
        expect(fn.name).toBe("readDeliveryModelClickObservation");
        expect(expected).toBe("http://127.0.0.1:4885");
        calls.push("one-passive-read");
        if (mode === "diagnostic-failure") throw new Error("Inert diagnostic failure.");
        return model;
      },
    };
    const scope = {
      modelClickObservation: null,
      config: {
        selection: mode === "other-selection" ? "delivery-retry-ui" : "release-visual-settings",
      },
      form: "[data-chat-composer-form]",
      origin: "http://127.0.0.1:4885",
      b: () => browser,
      step: () => {},
      readDeliveryModelClickObservation,
      projectModelClickObservation,
      bounded: async (promise: Promise<unknown>, ms: number) => {
        expect(ms).toBe(2000);
        return promise;
      },
      owner: {
        until: async (read: () => Promise<boolean>) => {
          expect(await read()).toBe(true);
        },
      },
      click: async (selector: string) => {
        calls.push("original-click-helper");
      },
    };
    const run = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(source.slice(start, end)) + "\nselectClaudeModel;",
      scope,
    ) as (context: string) => Promise<void>;
    const outcome = await run("import").catch((error: unknown) => error);
    if (mode === "click-failure") expect(outcome).toBe(original);
    else expect(outcome).toBeUndefined();
    if (mode === "other-selection") {
      expect(calls).toEqual(["original-click-helper", "original-click-helper"]);
      expect(scope.modelClickObservation).toBeNull();
    } else {
      expect(calls).toEqual([
        "original-click-helper",
        "display",
        "enabled",
        "one-passive-read",
        "native-click",
      ]);
      expect(scope.modelClickObservation).toEqual(mode === "diagnostic-failure" ? null : model);
    }
  },
);
