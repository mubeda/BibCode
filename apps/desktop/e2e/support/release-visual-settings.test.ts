// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - Inert DOM/driver ports and original synthetic PNGs only.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeVM from "node:vm";
import * as NodeZlib from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import * as SettingsEvidence from "./release-visual-settings.ts";
import {
  captureSettingsVisualScene,
  readSettingsVisualWitness,
  readSettingsAddProviderVisibility,
  runVisualSettings,
  scrollSettingsVisualField,
  validateSettingsVisualWitness,
  settingsVisualScreenshotName,
  projectSettingsVisualCapture,
  projectSettingsVisualAssertion,
  validateSettingsVisualJoins,
  type SettingsVisualCaptureInput,
  type SettingsVisualInput,
  type SettingsVisualObservationInput,
} from "./release-visual-settings.ts";

const observation: SettingsVisualObservationInput = {
  scene: "model-picker",
  theme: "light",
  origin: "http://127.0.0.1:4885",
  threadId: "owned",
  branch: "codex/delivery-retry-light",
};
function locationAt(path: string) {
  vi.stubGlobal("location", { origin: observation.origin, pathname: path, search: "", hash: "" });
}
function page(scene: SettingsVisualObservationInput["scene"]) {
  locationAt(
    scene === "model-picker"
      ? "/local/owned"
      : {
          "settings-keybindings": "/settings/keybindings",
          "settings-source-control": "/settings/source-control",
          "settings-provider-form": "/settings/providers",
        }[scene],
  );
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("innerHeight", 960);
  document.documentElement.className = "";
  const content = {
    "model-picker": `<button data-testid="thread-card-button-owned" aria-current="page" aria-describedby="owned-branch"></button><div id="owned-branch"><span data-slot="tooltip-trigger">codex/delivery-retry-light</span></div><div data-center-surface-host data-visible="true"><div data-testid="composer-editor">Owned visual review draft</div><button data-chat-provider-model-picker="true" aria-label="Claude · Opus 5"></button></div><div data-model-picker-content="true"><input placeholder="Search models..."><div class="model-picker-list"><div style="overscroll-behavior-y:contain"><div role="option" data-model-picker-instance-id="claudeAgent" data-model-picker-model-slug="opus" data-selected>Opus 5 Claude<button aria-label="Add to favorites"></button></div></div></div></div>`,
    "settings-keybindings": `<button data-slot="sidebar-menu-button" data-active="true">Keybindings</button><main data-slot="sidebar-inset"><section><h2>Keybindings</h2><input aria-label="Search keybindings" value="sidebar"><div aria-label="sidebar.toggle">Sidebar: Toggle</div><kbd>Ctrl</kbd><button aria-label="Cancel new keybinding"></button><button disabled>Save</button></section></main><div data-slot="popover-popup"><input aria-label="When expression" value="terminalFocus &amp;&amp; !terminalOpen"><button aria-label="Negate terminalFocus" aria-pressed="false"></button><button aria-label="Negate terminalOpen" aria-pressed="true"></button></div>`,
    "settings-provider-form": `<button data-slot="sidebar-menu-button" data-active="true">Providers</button><main data-slot="sidebar-inset"><section><h2>Providers</h2><input id="provider-instance-claudeAgent-binaryPath" value="claude"><input id="provider-instance-claudeAgent-homePath"><input id="provider-instance-claudeAgent-launchArgs"><div>Models Opus 5</div><input id="provider-instance-claudeAgent-custom-model"><button aria-label="Add Opus 5 to favorites"></button><button aria-label="Move Opus 5 up" disabled></button></section></main>`,
    "settings-source-control": `<button data-slot="sidebar-menu-button" data-active="true">Source Control</button><main data-slot="sidebar-inset"><section><h2>Version Control</h2><button aria-label="Toggle Git details" aria-expanded="true"></button><button aria-label="Git availability" role="switch" aria-checked="true" disabled></button><span>Git</span><code>git version 2.50.0</code><input aria-label="Automatic Git fetch interval in seconds" value="0"></section><section><h2>Source Control Providers</h2><div><span>GitHub</span><p>Not available on this server: Install GitHub CLI.</p><button role="switch" aria-label="GitHub availability" aria-checked="false" disabled></button></div><div><span>GitLab</span><p>Not available on this server: Install GitLab CLI.</p><button role="switch" aria-label="GitLab availability" aria-checked="false" disabled></button></div><button aria-label="Rescan server environment"></button></section><button aria-label="Enable pull requests" role="switch" aria-checked="true"></button></main>`,
  }[scene];
  document.body.innerHTML = `<div data-testid="environment-rail-local" aria-checked="true"><i data-status="connected"></i></div>${content}`;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 10,
    y: 10,
    left: 10,
    top: 10,
    right: 510,
    bottom: 610,
    width: 500,
    height: 600,
    toJSON: () => ({}),
  });
  vi.spyOn(document, "elementFromPoint").mockImplementation(() =>
    document.querySelector(
      scene === "model-picker"
        ? '[data-model-picker-content="true"]'
        : scene === "settings-keybindings"
          ? '[data-slot="popover-popup"]'
          : '[data-slot="sidebar-inset"]',
    ),
  );
  document
    .querySelector<HTMLInputElement>(
      scene === "model-picker"
        ? 'input[placeholder="Search models..."]'
        : 'input[aria-label="When expression"]',
    )
    ?.focus();
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

it.each(["light", "dark"] as const)("scrolls only the two owned fields natively in %s", (theme) => {
  page("settings-provider-form");
  document.documentElement.classList.toggle("dark", theme === "dark");
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  const value = vi.spyOn(HTMLInputElement.prototype, "value", "get");
  for (const [selector, block] of [
    ["#provider-instance-claudeAgent-binaryPath", "start"],
    ["#provider-instance-claudeAgent-custom-model", "end"],
  ] as const) {
    scrollSettingsVisualField({
      ...observation,
      scene: "settings-provider-form",
      theme,
      branch: `codex/delivery-retry-${theme}`,
      selector,
      block,
    });
    expect(scroll.mock.instances.at(-1)).toBe(document.querySelector(selector));
    expect(scroll.mock.calls.at(-1)).toEqual([{ block, inline: "nearest" }]);
  }
  expect(scroll).toHaveBeenCalledTimes(2);
  expect(value).not.toHaveBeenCalled();
});

it.each([
  "missing",
  "duplicate",
  "wrong-node",
  "route",
  "origin",
  "query",
  "hash",
  "theme",
  "branch",
  "nav",
  "rail",
  "credential",
  "boot",
  "selector",
  "block",
])("refuses unsafe native scroll %s without calling the action or reading field values", (mode) => {
  page("settings-provider-form");
  const selector = "#provider-instance-claudeAgent-custom-model";
  const target = document.querySelector(selector)!;
  const input = {
    ...observation,
    scene: "settings-provider-form" as const,
    selector,
    block: "end" as "start" | "end",
  };
  if (mode === "missing") target.remove();
  if (mode === "duplicate") target.parentElement!.append(target.cloneNode(true));
  if (mode === "wrong-node")
    target.outerHTML = '<div id="provider-instance-claudeAgent-custom-model"></div>';
  if (mode === "route") locationAt("/local/owned");
  if (mode === "origin") input.origin = "http://outside.invalid";
  if (mode === "query") vi.stubGlobal("location", { ...location, search: "?owned" });
  if (mode === "hash") vi.stubGlobal("location", { ...location, hash: "#owned" });
  if (mode === "theme") document.documentElement.classList.add("dark");
  if (mode === "branch") input.branch = "other";
  if (mode === "nav")
    document.querySelector('[data-slot="sidebar-menu-button"]')!.textContent = "General";
  if (mode === "rail")
    document
      .querySelector('[data-testid="environment-rail-local"]')!
      .setAttribute("aria-checked", "false");
  if (mode === "credential")
    document.body.insertAdjacentHTML("beforeend", '<input type="password">');
  if (mode === "boot") document.body.insertAdjacentHTML("beforeend", '<div id="boot-shell"></div>');
  if (mode === "selector") input.selector = "constructor";
  if (mode === "block") input.block = "start";
  const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {});
  const value = vi.spyOn(HTMLInputElement.prototype, "value", "get");
  expect(() => scrollSettingsVisualField(input)).toThrow();
  expect(scroll).not.toHaveBeenCalled();
  expect(value).not.toHaveBeenCalled();
});

it("preserves the original native action failure", () => {
  page("settings-provider-form");
  const original = new Error("Inert original native scroll failure.");
  vi.spyOn(HTMLElement.prototype, "scrollIntoView").mockImplementation(() => {
    throw original;
  });
  try {
    scrollSettingsVisualField({
      ...observation,
      scene: "settings-provider-form",
      selector: "#provider-instance-claudeAgent-custom-model",
      block: "end",
    });
  } catch (error) {
    expect(error).toBe(original);
    return;
  }
  throw new Error("Expected the original failure.");
});

it.each(["before", "native", "after", "escape"])(
  "keeps the actual scrolling error and outer-page guard at %s",
  async (mode) => {
    const source = NodeFS.readFileSync(
      new NodeURL.URL("./release-visual-settings.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf(
      "  const scroll = async",
      source.indexOf("export async function runVisualSettings("),
    );
    const end = source.indexOf("  const closeOverlay", start);
    const original = new Error("Inert original scrolling transport failure.");
    const calls: string[] = [];
    let pages = 0;
    const browser = {
      execute: async (read: unknown) => {
        const operation =
          read === scrollSettingsVisualField ? "native" : ++pages === 1 ? "before" : "after";
        calls.push(operation);
        if (mode === operation) throw original;
        return { x: 0, y: mode === "escape" && operation === "after" ? 1 : 0 };
      },
    };
    const scroll = NodeVM.runInNewContext(
      NodeModule.stripTypeScriptTypes(source.slice(start, end) + "\nscroll"),
      {
        browser,
        input: observation,
        scrollSettingsVisualField,
        readVisualPageScroll: () => {},
        bounded: async (value: Promise<unknown>) => value,
      },
    );
    const operation = scroll("#provider-instance-claudeAgent-custom-model", "end");
    if (mode === "escape")
      await expect(operation).rejects.toThrow("Visual settings scroll escaped.");
    else await expect(operation).rejects.toBe(original);
    const expected = ["before", "native", "after"];
    expect(calls).toEqual(
      mode === "escape" ? expected : expected.slice(0, expected.indexOf(mode) + 1),
    );
  },
);

describe("closed settings DOM witnesses", () => {
  it.each([
    "model-picker",
    "settings-keybindings",
    "settings-provider-form",
    "settings-source-control",
  ] as const)("admits only the actual visible %s state", (scene) => {
    page(scene);
    const proof = readSettingsVisualWitness({ ...observation, scene });
    expect(validateSettingsVisualWitness(scene, proof)).toMatchObject({
      themeMatched: true,
      credentialAbsent: true,
      expectedTextMatched: true,
      targetInView: true,
    });
    expect(JSON.stringify(proof)).not.toMatch(/4885|"owned"|claudeAgent|terminalFocus|2\.50/);
  });
  it.each([
    "secret",
    "hidden-secret",
    "duplicate",
    "wrong-route",
    "wrong-branch",
    "wrong-theme",
    "overlay",
    "disabled-instance",
    "changed-draft",
    "foreign-row",
    "lost-focus",
    "clipped-control",
    "uncontained-scroll",
  ])("refuses model capture after %s", (failure) => {
    page("model-picker");
    if (failure === "secret" || failure === "hidden-secret") {
      const field = document.createElement("input");
      field.type = "password";
      if (failure === "hidden-secret") field.style.display = "none";
      document.body.append(field);
    }
    if (failure === "duplicate")
      document.body.append(
        document.querySelector('[data-model-picker-content="true"]')!.cloneNode(true),
      );
    if (failure === "wrong-route") locationAt("/settings/agents");
    if (failure === "wrong-branch")
      document.querySelector('[data-slot="tooltip-trigger"]')!.textContent = "another-branch";
    if (failure === "wrong-theme") document.documentElement.classList.add("dark");
    if (failure === "overlay") vi.mocked(document.elementFromPoint).mockReturnValue(document.body);
    if (failure === "disabled-instance")
      document.querySelector('[role="option"]')!.setAttribute("aria-disabled", "true");
    if (failure === "changed-draft")
      document.querySelector('[data-testid="composer-editor"]')!.textContent = "Changed";
    if (failure === "foreign-row")
      document
        .querySelector('[role="option"]')!
        .setAttribute("data-model-picker-instance-id", "codex");
    if (failure === "lost-focus") document.querySelector<HTMLInputElement>("input")!.blur();
    if (failure === "uncontained-scroll")
      document.querySelector<HTMLElement>(".model-picker-list > div")!.style.overscrollBehaviorY =
        "auto";
    if (failure === "clipped-control") {
      const list = document.querySelector<HTMLElement>(".model-picker-list")!;
      list.style.overflowY = "hidden";
      Object.defineProperty(list, "getBoundingClientRect", {
        value: () => ({
          x: 10,
          y: 10,
          left: 10,
          top: 10,
          right: 510,
          bottom: 300,
          width: 500,
          height: 290,
          toJSON: () => ({}),
        }),
      });
    }
    expect(() =>
      validateSettingsVisualWitness("model-picker", readSettingsVisualWitness(observation)),
    ).toThrow();
  });
  it("refuses a private provider path, unredacted account and incomplete form", () => {
    for (const failure of ["path", "account", "field"]) {
      page("settings-provider-form");
      if (failure === "path")
        document.querySelector<HTMLInputElement>('input[id$="binaryPath"]')!.value =
          "/private/fixture/claude";
      if (failure === "account")
        document.body.insertAdjacentHTML(
          "beforeend",
          '<button aria-label="Toggle account email visibility">private@example.test</button>',
        );
      if (failure === "field") document.querySelector('input[id$="launchArgs"]')!.remove();
      expect(() =>
        validateSettingsVisualWitness(
          "settings-provider-form",
          readSettingsVisualWitness({ ...observation, scene: "settings-provider-form" }),
        ),
      ).toThrow();
      vi.restoreAllMocks();
    }
  });
  it.each(["auth", "pending"])(
    "refuses %s discovery without masking another failure",
    (failure) => {
      page("settings-source-control");
      if (failure === "auth")
        document
          .querySelector('[aria-label="GitHub availability"]')!
          .setAttribute("aria-checked", "true");
      if (failure === "pending")
        document.querySelector<HTMLButtonElement>(
          '[aria-label="Rescan server environment"]',
        )!.disabled = true;
      const proof = readSettingsVisualWitness({ ...observation, scene: "settings-source-control" });
      if (failure === "pending")
        expect(proof).toEqual({
          themeMatched: true,
          selectedMatched: true,
          expectedTextMatched: false,
          targetInView: true,
          credentialAbsent: true,
          bootShellAbsent: true,
          gitAvailable: true,
          gitVersionVisible: true,
          hostingUnavailable: true,
          availabilityReasons: true,
          fetchIntervalVisible: true,
          scanSettled: false,
        });
      expect(() => validateSettingsVisualWitness("settings-source-control", proof)).toThrow();
    },
  );
  it("reports actual computed Add visibility, including a hidden-attribute CSS override", () => {
    page("settings-provider-form");
    document.body.insertAdjacentHTML(
      "beforeend",
      '<button aria-label="Add provider instance" hidden style="display:none!important"></button>',
    );
    expect(readSettingsAddProviderVisibility(observation)).toEqual({
      oneControl: true,
      visible: false,
      hidden: true,
      enabled: true,
    });
    document.querySelector<HTMLElement>('[aria-label="Add provider instance"]')!.style.display =
      "inline-flex";
    expect(readSettingsAddProviderVisibility(observation)).toMatchObject({
      hidden: true,
      visible: true,
    });
    locationAt("/settings/agents");
    expect(readSettingsAddProviderVisibility(observation)).toBeNull();
  });
  it("refuses extra witness fields and getter-shaped receipts", () => {
    page("model-picker");
    const proof = readSettingsVisualWitness(observation)!;
    expect(() =>
      validateSettingsVisualWitness("model-picker", { ...proof, private: "token" }),
    ).toThrow();
    const read = vi.fn(() => true);
    Object.defineProperty(proof, "themeMatched", { enumerable: true, get: read });
    expect(() => validateSettingsVisualWitness("model-picker", proof)).toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(() => settingsVisualScreenshotName("../escape", "light")).toThrow();
    expect(() => settingsVisualScreenshotName("model-picker", "system")).toThrow();
  });
});

describe("closed settings artifact joins", () => {
  const proof = {
    managedIdentityMatched: true,
    draftRetained: true,
    providerSelectionRetained: true,
    keybindingCancelled: true,
    noSettingsSaved: true,
    addProviderDialog: "unsupported-hidden-control",
    unpictured: [
      "add-provider-instance-dialog",
      "provider-ready-disabled-unavailable-overview",
      "provider-account-and-status-header",
      "model-effort-fast-mode-controls",
      "source-control-azure-bitbucket",
    ],
  };
  function capture(scene: SettingsVisualObservationInput["scene"], theme: "light" | "dark") {
    page(scene);
    if (theme === "dark") {
      document.documentElement.classList.add("dark");
      const branch = document.querySelector('[data-slot="tooltip-trigger"]');
      if (branch) branch.textContent = "codex/delivery-retry-dark";
    }
    return {
      scene,
      theme,
      file: `${scene}-${theme}.png`,
      width: 1280,
      height: 960,
      nonBlank: true,
      sha256: "a".repeat(64),
      witness: readSettingsVisualWitness({
        ...observation,
        scene,
        theme,
        branch: `codex/delivery-retry-${theme}`,
      }),
    };
  }
  it("requires the exact eight named theme/scene joins and two closed assertions without expanding latent coverage", () => {
    const captures = (
      [
        "model-picker",
        "settings-provider-form",
        "settings-keybindings",
        "settings-source-control",
      ] as const
    ).flatMap((scene) => [capture(scene, "light"), capture(scene, "dark")]);
    const assertions = [
      projectSettingsVisualAssertion("light", proof),
      projectSettingsVisualAssertion("dark", proof),
    ];
    expect(() => validateSettingsVisualJoins(captures, assertions)).not.toThrow();
    expect(() => validateSettingsVisualJoins(captures.slice(1), assertions)).toThrow();
    expect(() =>
      validateSettingsVisualJoins([...captures.slice(1), captures[1]!], assertions),
    ).toThrow();
    expect(() => validateSettingsVisualJoins(captures, [assertions[0]!, assertions[0]!])).toThrow();
    expect(JSON.stringify(assertions)).not.toMatch(/owned-thread|4885|credential|private/);
  });
  it("refuses arbitrary capture fields, getter receipts and coerced coverage strings before they can reach the shared writer", () => {
    const valid = capture("model-picker", "light");
    expect(projectSettingsVisualCapture(valid)).toMatchObject({ file: "model-picker-light.png" });
    expect(() => projectSettingsVisualCapture({ ...valid, providerId: "private" })).toThrow();
    expect(() => projectSettingsVisualCapture({ ...valid, file: "../private.png" })).toThrow();
    expect(() => projectSettingsVisualCapture({ ...valid, sha256: "private" })).toThrow();
    const getter = vi.fn(() => "light");
    Object.defineProperty(valid, "theme", { get: getter, enumerable: true });
    expect(() => projectSettingsVisualCapture(valid)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(() => projectSettingsVisualAssertion("light", { ...proof, raw: "private" })).toThrow();
    expect(() =>
      projectSettingsVisualAssertion("light", {
        ...proof,
        addProviderDialog: { toString: () => "unsupported-hidden-control", secret: "private" },
      }),
    ).toThrow();
    expect(() => projectSettingsVisualAssertion("light", { ...proof, unpictured: [] })).toThrow();
  });
});

function png() {
  const chunk = (type: string, data: Buffer) => {
    const bytes = Buffer.alloc(data.length + 12);
    bytes.writeUInt32BE(data.length);
    bytes.write(type, 4);
    data.copy(bytes, 8);
    bytes.writeUInt32BE(NodeZlib.crc32(bytes.subarray(4, -4)), bytes.length - 4);
    return bytes;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1280);
  header.writeUInt32BE(960, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc(3841 * 960);
  for (let y = 0; y < 960; y++) raw.fill(y % 256, y * 3841 + 1, (y + 1) * 3841);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", NodeZlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const sourceControlFailureFacts = {
  themeMatched: true,
  selectedMatched: true,
  expectedTextMatched: false,
  targetInView: false,
  credentialAbsent: true,
  bootShellAbsent: true,
  gitAvailable: true,
  gitVersionVisible: false,
  hostingUnavailable: true,
  availabilityReasons: true,
  fetchIntervalVisible: false,
  scanSettled: true,
};

const providerFormFailureFacts = {
  themeMatched: true,
  selectedMatched: true,
  expectedTextMatched: false,
  targetInView: false,
  credentialAbsent: true,
  bootShellAbsent: true,
  binaryFieldPresent: true,
  binaryFieldVisible: true,
  binaryFieldViewportContained: false,
  binaryFieldAncestorsContained: false,
  nonSecretFieldsVisible: false,
  ownedConfigOnly: true,
  modelsCustomFieldPresent: true,
  modelsCustomFieldVisible: true,
  modelsCustomFieldViewportContained: false,
  modelsCustomFieldAncestorsContained: false,
  modelsCustomFieldInView: false,
  modelsCustomFieldReady: false,
  modelsVisible: false,
  modelControlsVisible: false,
  modelOrderControlPresent: true,
  modelOrderControlVisible: true,
  modelOrderControlViewportContained: false,
  modelOrderControlAncestorsContained: false,
  accountsRedacted: true,
};

it.each([
  ["visual-settings-source-control", "settings-source-control"],
  ["visual-settings-provider-form", "settings-provider-form"],
  ["visual-settings-provider-form-open", null],
  ["visual-settings-provider-details", null],
  ["visual-settings-provider-form-extra", null],
  ["visual-settings-keybindings", null],
  ["visual-model-picker", null],
  ["constructor", null],
])("joins only the exact failure phase %s to its observed scene", (phase, expected) => {
  const resolve = Reflect.get(SettingsEvidence, "resolveSettingsVisualFailureScene") as
    | ((phase: string) => string | null)
    | undefined;
  expect(resolve?.(phase!)).toBe(expected);
});

it.each(["false", "missing", "extra", "unsafe", "getter", "proxy", "non-boolean", "null"])(
  "retains only complete safe provider-form own boolean failure facts: %s",
  (mode) => {
    let reads = 0;
    let value: unknown = { ...providerFormFailureFacts };
    if (mode === "missing") delete (value as Record<string, unknown>).modelsVisible;
    if (mode === "extra") Object.assign(value as object, { raw: "private" });
    if (mode === "unsafe") Object.assign(value as object, { credentialAbsent: false });
    if (mode === "non-boolean") Object.assign(value as object, { accountsRedacted: "private" });
    if (mode === "getter")
      Object.defineProperty(value, "modelControlsVisible", {
        enumerable: true,
        get() {
          reads++;
          throw new Error("private getter");
        },
      });
    if (mode === "proxy")
      value = new Proxy(value as object, {
        ownKeys() {
          reads++;
          throw new Error("private proxy");
        },
      });
    if (mode === "null") value = null;
    const result = SettingsEvidence.projectSettingsVisualFailureWitness(
      "settings-provider-form",
      value,
    );
    expect(result).toEqual(mode === "false" ? providerFormFailureFacts : null);
    expect(reads).toBe(0);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(() => validateSettingsVisualWitness("settings-provider-form", result)).toThrow();
  },
);

it("observes only the existing false capture facts while preserving the original capture error", async () => {
  const evidence = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "settings-failure-facts-"));
  const original = new Error("Original capture observation timeout.");
  const calls: string[] = [];
  const observed: Array<{ error: unknown; witness: unknown }> = [];
  let actualFacts: Record<string, boolean> = sourceControlFailureFacts;
  const input = {
    ...observation,
    scene: "settings-source-control",
    evidence,
    captured: new Set<string>(),
    verifyOwnedIdentity: async () => {
      calls.push("identity");
    },
    browser: {
      ownedIsAlertOpen: async () => {
        calls.push("alert");
        return false;
      },
      execute: async (reader: unknown) => {
        expect(reader).toBe(readSettingsVisualWitness);
        calls.push("read");
        return actualFacts;
      },
      takeScreenshot: async () => {
        throw new Error("No screenshot on failed witness.");
      },
    },
    owner: {
      until: async (read: () => Promise<boolean>) => {
        expect(await read()).toBe(false);
        throw original;
      },
    },
    observeFailure: (error: unknown, witness: unknown) => {
      observed.push({ error, witness });
    },
  } as unknown as SettingsVisualCaptureInput;
  try {
    await expect(captureSettingsVisualScene(input)).rejects.toBe(original);
    expect(observed).toEqual([{ error: original, witness: sourceControlFailureFacts }]);
    expect(calls).toEqual(["alert", "identity", "read"]);
    expect(NodeFS.readdirSync(evidence)).toEqual([]);
    input.scene = "settings-provider-form";
    actualFacts = providerFormFailureFacts;
    const latest = { ...providerFormFailureFacts, modelControlsVisible: true };
    calls.length = 0;
    observed.length = 0;
    input.owner.until = async (read) => {
      expect(await read()).toBe(false);
      actualFacts = latest;
      expect(await read()).toBe(false);
      throw original;
    };
    await expect(captureSettingsVisualScene(input)).rejects.toBe(original);
    expect(observed).toEqual([{ error: original, witness: latest }]);
    expect(calls).toEqual(["alert", "identity", "read", "read"]);
    expect(NodeFS.readdirSync(evidence)).toEqual([]);
  } finally {
    NodeFS.rmSync(evidence, { recursive: true, force: true });
  }
});

it.each(["false", "missing", "extra", "unsafe", "getter", "proxy", "non-boolean"])(
  "projects only complete safe own boolean failure facts: %s",
  (mode) => {
    const project = Reflect.get(SettingsEvidence, "projectSettingsVisualFailureWitness");
    expect(typeof project).toBe("function");
    let input: unknown = { ...sourceControlFailureFacts };
    let reads = 0;
    if (mode === "missing") delete (input as Record<string, unknown>).scanSettled;
    if (mode === "extra") Object.assign(input as object, { raw: "private" });
    if (mode === "unsafe") Object.assign(input as object, { credentialAbsent: false });
    if (mode === "non-boolean") Object.assign(input as object, { scanSettled: "private" });
    if (mode === "getter")
      Object.defineProperty(input, "gitVersionVisible", {
        enumerable: true,
        get() {
          reads++;
          throw new Error("private getter");
        },
      });
    if (mode === "proxy") {
      const revocable = Proxy.revocable(input as object, {});
      revocable.revoke();
      input = revocable.proxy;
    }
    const result = project("settings-source-control", input);
    expect(result).toEqual(mode === "false" ? sourceControlFailureFacts : null);
    expect(reads).toBe(0);
    expect(JSON.stringify(result)).not.toContain("private");
  },
);

it.each(["themeMatched", "selectedMatched", "credentialAbsent", "bootShellAbsent"])(
  "quarantines unsafe %s context without treating it as a failed scene fact",
  (guard) => {
    expect(
      SettingsEvidence.projectSettingsVisualFailureWitness("settings-source-control", {
        ...sourceControlFailureFacts,
        [guard]: false,
      }),
    ).toBeNull();
    expect(
      SettingsEvidence.projectSettingsVisualFailureWitness("settings-provider-form", {
        ...providerFormFailureFacts,
        [guard]: false,
      }),
    ).toBeNull();
  },
);

it.each(["transparent", "spoofing", "throwing", "revoked"])(
  "quarantines native %s failure-witness proxies before any trap",
  (mode) => {
    let traps = 0;
    const target = {
      ...sourceControlFailureFacts,
      credentialAbsent: mode !== "spoofing",
    };
    const handler: ProxyHandler<typeof target> = {
      ownKeys(value) {
        traps++;
        if (mode === "throwing") throw new Error("inert proxy trap");
        return Reflect.ownKeys(value);
      },
      getOwnPropertyDescriptor(value, key) {
        traps++;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return key === "credentialAbsent" && mode === "spoofing"
          ? { ...descriptor, value: true }
          : descriptor;
      },
      get(value, key, receiver) {
        traps++;
        return Reflect.get(value, key, receiver);
      },
    };
    const revocable = Proxy.revocable(target, handler);
    if (mode === "revoked") revocable.revoke();
    expect(
      SettingsEvidence.projectSettingsVisualFailureWitness(
        "settings-source-control",
        revocable.proxy,
      ),
    ).toBeNull();
    expect(traps).toBe(0);
  },
);

it("reports the last actual poll result without adding a diagnostic execution", async () => {
  const evidence = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "settings-latest-facts-"));
  const original = new Error("Original repeated observation timeout.");
  const latest = { ...sourceControlFailureFacts, scanSettled: false };
  let reads = 0;
  const observed: unknown[] = [];
  try {
    await expect(
      captureSettingsVisualScene({
        ...observation,
        scene: "settings-source-control",
        evidence,
        captured: new Set(),
        verifyOwnedIdentity: async () => {},
        browser: {
          ownedIsAlertOpen: async () => false,
          execute: async () => (++reads === 1 ? sourceControlFailureFacts : latest),
          takeScreenshot: async () => {
            throw new Error("No screenshot expected.");
          },
        },
        owner: {
          until: async (read: () => Promise<boolean>) => {
            expect(await read()).toBe(false);
            expect(await read()).toBe(false);
            throw original;
          },
        },
        observeFailure: (error: unknown, witness: unknown) => {
          expect(error).toBe(original);
          observed.push(witness);
        },
      } as unknown as SettingsVisualCaptureInput),
    ).rejects.toBe(original);
    expect(reads).toBe(2);
    expect(observed).toEqual([latest]);
    expect(NodeFS.readdirSync(evidence)).toEqual([]);
  } finally {
    NodeFS.rmSync(evidence, { recursive: true, force: true });
  }
});

it.each(["observer-fault", "pre-read", "read-reject", "after-read", "after-identity"])(
  "contains failure observation without adding reads or replacing original error: %s",
  async (mode) => {
    const evidence = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "settings-failure-source-"));
    const original = new Error("Original controlled capture failure.");
    let identities = 0,
      reads = 0,
      shots = 0;
    const observed: Array<{ error: unknown; witness: unknown }> = [];
    const good = {
      ...sourceControlFailureFacts,
      expectedTextMatched: true,
      targetInView: true,
      gitVersionVisible: true,
      fetchIntervalVisible: true,
    };
    const input = {
      ...observation,
      scene: "settings-source-control",
      evidence,
      captured: new Set<string>(),
      verifyOwnedIdentity: async () => {
        identities++;
        if (mode === "pre-read" || (mode === "after-identity" && identities === 2)) throw original;
      },
      browser: {
        ownedIsAlertOpen: async () => false,
        execute: async () => {
          reads++;
          if (mode === "read-reject") throw original;
          return ["after-read", "after-identity"].includes(mode) && reads === 1
            ? good
            : sourceControlFailureFacts;
        },
        takeScreenshot: async () => {
          shots++;
          return png().toString("base64");
        },
      },
      owner: {
        until: async (read: () => Promise<boolean>) => {
          if (!(await read())) throw original;
        },
      },
      observeFailure: (error: unknown, witness: unknown) => {
        observed.push({ error, witness });
        if (mode === "observer-fault") throw new Error("Optional observer fault.");
      },
    } as unknown as SettingsVisualCaptureInput;
    try {
      if (mode === "after-read")
        await expect(captureSettingsVisualScene(input)).rejects.toThrow(
          "Visual settings precondition failed.",
        );
      else await expect(captureSettingsVisualScene(input)).rejects.toBe(original);
      expect(observed).toHaveLength(1);
      if (mode !== "after-read") expect(observed[0]!.error).toBe(original);
      expect(observed[0]!.witness).toEqual(
        ["pre-read", "read-reject", "after-identity"].includes(mode)
          ? null
          : sourceControlFailureFacts,
      );
      expect(reads).toBe(mode === "pre-read" ? 0 : mode === "after-read" ? 2 : 1);
      expect(shots).toBe(["after-read", "after-identity"].includes(mode) ? 1 : 0);
      expect(input.captured.size).toBe(0);
      expect(NodeFS.readdirSync(evidence)).toEqual([]);
    } finally {
      NodeFS.rmSync(evidence, { recursive: true, force: true });
    }
  },
);
describe("original settings PNG boundary", () => {
  it.each([
    "ok",
    "before",
    "after",
    "alert",
    "driver",
    "identity",
    "after-identity",
    "existing-file",
  ])(
    "retains original bytes only after both complete witnesses and owned identity pass: %s",
    async (failure) => {
      page("model-picker");
      const evidence = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "settings-visual-test-"));
      const original = png();
      let shots = 0;
      let checks = 0;
      const input = {
        ...observation,
        evidence,
        captured: new Set<string>(),
        owner: {
          until: async (check: () => Promise<boolean>) => {
            if (!(await check())) throw new Error("Owned observation timeout.");
          },
        },
        verifyOwnedIdentity: async () => {
          checks++;
          if (failure === "identity" || (failure === "after-identity" && checks === 2))
            throw new Error("Identity changed.");
        },
        browser: {
          ownedIsAlertOpen: async () => failure === "alert",
          execute: async (
            read: typeof readSettingsVisualWitness,
            args: SettingsVisualObservationInput,
          ) => read(args),
          takeScreenshot: async () => {
            shots++;
            if (failure === "driver") throw new Error("Driver refused.");
            if (failure === "after") locationAt("/local/foreign");
            return original.toString("base64");
          },
        },
      } as unknown as SettingsVisualCaptureInput;
      if (failure === "before")
        document.body.insertAdjacentHTML("beforeend", '<input type="password">');
      if (failure === "existing-file")
        NodeFS.writeFileSync(NodePath.join(evidence, "model-picker-light.png"), "owned original");
      try {
        if (failure === "ok") {
          const receipt = await captureSettingsVisualScene(input);
          expect(receipt).toMatchObject({
            file: "model-picker-light.png",
            width: 1280,
            height: 960,
            nonBlank: true,
          });
          expect(NodeFS.readFileSync(NodePath.join(evidence, "model-picker-light.png"))).toEqual(
            original,
          );
          expect(checks).toBe(2);
          await expect(captureSettingsVisualScene(input)).rejects.toThrow();
          expect(shots).toBe(1);
        } else {
          await expect(captureSettingsVisualScene(input)).rejects.toThrow();
          expect(input.captured.size).toBe(0);
          expect(NodeFS.readdirSync(evidence)).toEqual(
            failure === "existing-file" ? ["model-picker-light.png"] : [],
          );
          if (["before", "alert", "identity", "existing-file"].includes(failure))
            expect(shots).toBe(0);
          if (failure === "existing-file")
            expect(
              NodeFS.readFileSync(NodePath.join(evidence, "model-picker-light.png"), "utf8"),
            ).toBe("owned original");
        }
      } finally {
        NodeFS.rmSync(evidence, { recursive: true, force: true });
      }
    },
  );
});

function controller(failure?: string) {
  const actions: string[] = [];
  const captures: string[] = [];
  let route = "chat",
    popup = "",
    newBinding = false,
    details = false;
  const failed = new Error("Owned capture failed.");
  const element = (selector: string) => ({
    waitForDisplayed: async (options?: { reverse?: boolean }) => {
      if (options?.reverse && popup) throw new Error("Popup still open.");
    },
    waitForEnabled: async () => {},
    isDisplayed: async () => selector !== 'button[aria-label="Add provider instance"]',
    click: async () => {
      actions.push(selector);
      if (selector === '[data-testid="environment-rail-manage"]') route = "settings";
      if (selector === "button=Back") {
        route = "chat";
        popup = "";
        newBinding = false;
      }
      if (selector === "button=Providers") route = "providers";
      if (selector === "button=Keybindings") route = "keybindings";
      if (selector === "button=Source Control") route = "source-control";
      if (selector.includes("data-chat-provider-model-picker")) popup = "picker";
      if (selector.includes("Add keybinding")) newBinding = true;
      if (selector.includes("Cancel new keybinding")) newBinding = false;
      if (selector.includes("Edit when clause")) popup = "when";
      if (selector.includes("Toggle Claude details")) details = !details;
    },
    setValue: async (value: string) => {
      actions.push(selector + ":" + value);
    },
    getText: async () =>
      failure === "draft" && route === "chat" && actions.includes("button=Back")
        ? "changed"
        : "Owned visual review draft",
    getAttribute: async () => "Claude · Opus 5",
  });
  const input = {
    browser: {
      $: element,
      $$: async () => [element("unique")],
      keys: async (key: string) => {
        actions.push("key:" + key);
        if (key === "Escape") popup = "";
      },
      execute: async (read: unknown, options?: { selector: string; block: string }) => {
        if (read === scrollSettingsVisualField) {
          expect(route).toBe("providers");
          expect(details).toBe(true);
          expect(options?.block).toBe(options?.selector.endsWith("binaryPath") ? "start" : "end");
          actions.push("scroll:" + options?.selector);
          return;
        }
        if (read === readSettingsAddProviderVisibility)
          return { oneControl: true, visible: false, hidden: true, enabled: true };
        return { x: 0, y: 0 };
      },
    },
    owner: {
      until: async (check: () => Promise<boolean>) => {
        if (!(await check())) throw new Error("Inert wait refused.");
      },
    },
    threadId: "owned",
    branch: observation.branch,
    origin: observation.origin,
    theme: observation.theme,
    step: (phase: string) => actions.push("phase:" + phase),
    verifyManaged: async () => {
      if (route !== "chat") throw new Error("Managed route lost.");
      actions.push("verify-managed");
    },
    verifyOwnedIdentity: async () => {
      actions.push("verify-identity");
    },
    capture: async (scene: string) => {
      if (scene === failure) throw failed;
      captures.push(scene);
    },
  } as unknown as SettingsVisualInput;
  return { input, actions, captures, failed, state: () => ({ route, popup, newBinding, details }) };
}
describe("fixed public settings controller", () => {
  it("uses public actions, cancels the new condition draft, returns to the same chat and labels hidden Add unpictured", async () => {
    const c = controller();
    const receipt = await runVisualSettings(c.input);
    expect(c.captures).toEqual([
      "model-picker",
      "settings-keybindings",
      "settings-source-control",
      "settings-provider-form",
    ]);
    expect(c.state()).toEqual({ route: "chat", popup: "", newBinding: false, details: false });
    expect(receipt).toMatchObject({
      draftRetained: true,
      providerSelectionRetained: true,
      keybindingCancelled: true,
      addProviderDialog: "unsupported-hidden-control",
    });
    expect(
      c.actions.indexOf(
        '[data-slot="popover-popup"][data-open] input[aria-label="When expression"]:terminalFocus && !terminalOpen',
      ),
    ).toBeLessThan(c.actions.indexOf('button[aria-label="Cancel new keybinding"]'));
    expect(c.actions).not.toContain('button[aria-label="Add provider instance"]');
    expect(
      c.actions.some(
        (action) =>
          action.includes("Save") ||
          action.includes("availability") ||
          action.includes("Enable Claude"),
      ),
    ).toBe(false);
  });
  it.each([
    "model-picker",
    "settings-provider-form",
    "settings-keybindings",
    "settings-source-control",
  ])("cleans up public overlays/edits without replacing %s capture failure", async (scene) => {
    const c = controller(scene);
    await expect(runVisualSettings(c.input)).rejects.toBe(c.failed);
    expect(c.state()).toMatchObject({ route: "chat", popup: "", newBinding: false });
    expect(c.captures).not.toContain(scene);
  });
  it("refuses a changed retained draft after returning", async () => {
    const c = controller("draft");
    await expect(runVisualSettings(c.input)).rejects.toThrow("Visual settings draft changed.");
  });
});

const keybindingsAwaitCalls = [
  "nav-displayed",
  "nav-lookup",
  "nav-enabled",
  "nav-click",
  "search-displayed",
  "search-lookup",
  "search-enabled",
  "search-click",
  "search-input-fill",
  "add-displayed",
  "add-lookup",
  "add-enabled",
  "add-click",
  "when-displayed",
  "when-lookup",
  "when-enabled",
  "when-click",
  "when-input-displayed",
  "when-input-fill",
];

function keybindingsAwaitReplay(failed?: string, observerThrows = false, matchCount = 1) {
  const source = NodeFS.readFileSync(
    NodePath.join(import.meta.dirname, "release-visual-settings.ts"),
    "utf8",
  );
  const start = source.indexOf(
    "  const { browser, step } = input;",
    source.indexOf("export async function runVisualSettings"),
  );
  const end = source.indexOf("  const unchanged = async", start);
  const bodyStart = source.indexOf('    step("visual-settings-keybindings-open");', end);
  const bodyEnd = source.indexOf('    await capture("settings-keybindings");', bodyStart);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  expect(bodyEnd).toBeGreaterThan(bodyStart);
  const replay = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(
      "async function replay(input) {\n" +
        source.slice(start, end) +
        source.slice(bodyStart, bodyEnd) +
        "\n}\nreplay",
    ),
  ) as (input: unknown) => Promise<void>;
  const calls: string[] = [],
    phases: string[] = [],
    values: string[] = [];
  const error = new Error("Inert original keybindings await failure.");
  const action = (operation: string) => {
    calls.push(operation);
    if (operation === failed) throw error;
  };
  const controls: Record<string, string> = {
    "button=Keybindings": "nav",
    'button[aria-label="Search keybindings"]': "search",
    'input[aria-label="Search keybindings"]': "search-input",
    'button[aria-label="Add keybinding"]': "add",
    'button[aria-label="Edit when clause for new keybinding"]': "when",
    '[data-slot="popover-popup"][data-open] input[aria-label="When expression"]': "when-input",
  };
  const controlFor = (selector: string) => {
    const control = controls[selector];
    expect(control).toBeDefined();
    return control;
  };
  return {
    calls,
    phases,
    values,
    error,
    run: () =>
      replay({
        browser: {
          $$: async (selector: string) => {
            action(controlFor(selector) + "-lookup");
            return Array.from({ length: matchCount }, () => ({}));
          },
          $: (selector: string) => {
            const control = controlFor(selector);
            return {
              waitForDisplayed: async () => action(control + "-displayed"),
              waitForEnabled: async () => action(control + "-enabled"),
              click: async () => action(control + "-click"),
              setValue: async (value: string) => {
                action(control + "-fill");
                values.push(value);
              },
            };
          },
        },
        step: (phase: string) => {
          phases.push(phase);
          if (observerThrows && phase.startsWith("visual-settings-keybindings-open-"))
            throw new Error("Inert optional attribution failure.");
        },
      }),
  };
}

describe("keybindings last-await attribution", () => {
  it.each([0, 2])("still refuses %s controls after the existing displayed wait", async (count) => {
    const replay = keybindingsAwaitReplay(undefined, true, count);
    await expect(replay.run()).rejects.toThrow("Visual settings public control refused.");
    expect(replay.calls).toEqual(["nav-displayed", "nav-lookup"]);
    expect(replay.phases.at(-1)).toBe("visual-settings-keybindings-open-nav-lookup");
    expect(replay.values).toEqual([]);
  });
  it.each(keybindingsAwaitCalls)(
    "preserves the original %s failure at its exact existing boundary",
    async (failed) => {
      const replay = keybindingsAwaitReplay(failed, true);
      await expect(replay.run()).rejects.toBe(replay.error);
      expect(replay.calls).toEqual(
        keybindingsAwaitCalls.slice(0, keybindingsAwaitCalls.indexOf(failed) + 1),
      );
      expect(replay.phases.at(-1)).toBe("visual-settings-keybindings-open-" + failed);
    },
  );
  it.each([false, true])(
    "keeps original actions, input arguments and success with throwing attribution=%s",
    async (throws) => {
      const replay = keybindingsAwaitReplay(undefined, throws);
      await expect(replay.run()).resolves.toBeUndefined();
      expect(replay.calls).toEqual(keybindingsAwaitCalls);
      expect(replay.values).toEqual(["sidebar", "terminalFocus && !terminalOpen"]);
      expect(replay.phases[0]).toBe("visual-settings-keybindings-open");
      expect(replay.phases.at(-1)).toBe("visual-settings-keybindings-open-when-input-fill");
    },
  );
});
