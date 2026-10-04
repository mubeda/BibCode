// @effect-diagnostics nodeBuiltinImport:off - Finite original PNG evidence in the owned qualification root.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import {
  bounded,
  type QualificationBrowser,
  type QualificationOwner,
} from "./qualification-owner.ts";
import { inspectScreenshot, validateCaptureWitness } from "./remote-ui-evidence.ts";
import { readVisualPageScroll } from "./release-visual-observation.ts";

export const settingsVisualScenes = [
  "model-picker",
  "settings-provider-form",
  "settings-keybindings",
  "settings-source-control",
] as const;
export type SettingsVisualScene = (typeof settingsVisualScenes)[number];
export interface SettingsVisualObservationInput {
  scene: SettingsVisualScene;
  theme: "light" | "dark";
  origin: string;
  threadId: string;
  branch: string;
}
const commonFacts = [
  "themeMatched",
  "selectedMatched",
  "expectedTextMatched",
  "targetInView",
  "credentialAbsent",
  "bootShellAbsent",
] as const;
const sceneFacts: Record<SettingsVisualScene, readonly string[]> = {
  "model-picker": [
    "singlePicker",
    "ownedReadyModel",
    "searchFocused",
    "favoriteControl",
    "draftRetained",
    "selectionRetained",
    "containedScroll",
  ],
  "settings-provider-form": [
    "nonSecretFieldsVisible",
    "ownedConfigOnly",
    "modelsVisible",
    "modelControlsVisible",
    "accountsRedacted",
  ],
  "settings-keybindings": [
    "filteredRow",
    "conditionEditor",
    "conditionFocused",
    "structuredCondition",
    "unsavedCancelableRow",
  ],
  "settings-source-control": [
    "gitAvailable",
    "gitVersionVisible",
    "hostingUnavailable",
    "availabilityReasons",
    "fetchIntervalVisible",
    "scanSettled",
  ],
};

/** Closed already-read failure facts; unsafe context is unavailable, never capture approval. */
export function projectSettingsVisualFailureWitness(
  scene: SettingsVisualScene,
  input: unknown,
): Readonly<Record<string, boolean>> | null {
  try {
    if (
      !settingsVisualScenes.includes(scene) ||
      !input ||
      typeof input !== "object" ||
      NodeUtil.types.isProxy(input) ||
      Array.isArray(input)
    )
      return null;
    const keys = [...commonFacts, ...sceneFacts[scene]];
    const ownKeys = Reflect.ownKeys(input);
    if (
      ownKeys.length !== keys.length ||
      !ownKeys.every((key) => typeof key === "string" && keys.includes(key))
    )
      return null;
    const result: Record<string, boolean> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (
        !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, "value") ||
        typeof descriptor.value !== "boolean"
      )
        return null;
      result[key] = descriptor.value;
    }
    if (
      ["themeMatched", "selectedMatched", "credentialAbsent", "bootShellAbsent"].some(
        (key) => result[key] !== true,
      )
    )
      return null;
    return Object.freeze(result);
  } catch {
    return null;
  }
}
export function settingsVisualScreenshotName(scene: string, theme: string): string {
  if (
    !settingsVisualScenes.some((allowed) => allowed === scene) ||
    !["light", "dark"].includes(theme)
  )
    throw new Error("Unknown settings visual capture.");
  return `${scene}-${theme}.png`;
}
/** Exact data properties only; private values and failed/missing facts never enter receipts. */
export function validateSettingsVisualWitness(
  scene: SettingsVisualScene,
  input: unknown,
): Record<string, true> {
  if (
    !settingsVisualScenes.includes(scene) ||
    !input ||
    typeof input !== "object" ||
    Array.isArray(input)
  )
    throw new Error("Visual settings precondition failed.");
  const keys = [...commonFacts, ...sceneFacts[scene]];
  if (Reflect.ownKeys(input).length !== keys.length)
    throw new Error("Visual settings precondition failed.");
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") || descriptor.value !== true)
      throw new Error("Visual settings precondition failed.");
  }
  validateCaptureWitness(Object.fromEntries(commonFacts.map((key) => [key, true])));
  return Object.fromEntries(keys.map((key) => [key, true]));
}

const settingsUnpictured = [
  "add-provider-instance-dialog",
  "provider-ready-disabled-unavailable-overview",
  "provider-account-and-status-header",
  "model-effort-fast-mode-controls",
  "source-control-azure-bitbucket",
] as const;
function settingsReceipt(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Reflect.ownKeys(input).length !== keys.length
  )
    throw new Error("Owned settings receipt refused.");
  const values: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value"))
      throw new Error("Owned settings receipt refused.");
    values[key] = descriptor.value;
  }
  return values;
}
/** Closed fields are projected before the shared writer sees an owned capture. */
export function projectSettingsVisualCapture(input: unknown) {
  const row = settingsReceipt(input, [
    "scene",
    "theme",
    "file",
    "witness",
    "width",
    "height",
    "nonBlank",
    "sha256",
  ]);
  if (
    typeof row.scene !== "string" ||
    typeof row.theme !== "string" ||
    row.file !== settingsVisualScreenshotName(row.scene, row.theme) ||
    row.width !== 1280 ||
    row.height !== 960 ||
    row.nonBlank !== true ||
    typeof row.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(row.sha256)
  )
    throw new Error("Owned settings receipt refused.");
  const witness = validateSettingsVisualWitness(row.scene as SettingsVisualScene, row.witness);
  return {
    scene: row.scene,
    theme: row.theme,
    file: row.file,
    witness,
    width: 1280,
    height: 960,
    nonBlank: true,
    sha256: row.sha256,
  };
}
/** No dynamic paths, IDs, exception values, or undeclared coverage claims enter assertions. */
export function projectSettingsVisualAssertion(theme: string, input: unknown) {
  const booleans = [
    "managedIdentityMatched",
    "draftRetained",
    "providerSelectionRetained",
    "keybindingCancelled",
    "noSettingsSaved",
  ];
  const row = settingsReceipt(input, [...booleans, "addProviderDialog", "unpictured"]);
  const unpictured = row.unpictured;
  if (
    !["light", "dark"].includes(theme) ||
    !booleans.every((key) => row[key] === true) ||
    typeof row.addProviderDialog !== "string" ||
    !["unsupported-hidden-control", "unpictured-public-dialog"].includes(row.addProviderDialog) ||
    !Array.isArray(unpictured) ||
    unpictured.length !== settingsUnpictured.length ||
    !settingsUnpictured.every((value, index) => unpictured[index] === value)
  )
    throw new Error("Owned settings receipt refused.");
  return {
    theme,
    ...Object.fromEntries(booleans.map((key) => [key, true])),
    addProviderDialog: row.addProviderDialog,
    unpictured: [...settingsUnpictured],
  };
}
export function validateSettingsVisualJoins(captures: unknown[], assertions: unknown[]): void {
  if (captures.length !== 8 || assertions.length !== 2)
    throw new Error("Owned settings joins refused.");
  const names = captures.map((value) => projectSettingsVisualCapture(value).file);
  if (new Set(names).size !== 8) throw new Error("Owned settings joins refused.");
  const themes = assertions.map((value) => {
    const row = settingsReceipt(value, [
      "theme",
      "managedIdentityMatched",
      "draftRetained",
      "providerSelectionRetained",
      "keybindingCancelled",
      "noSettingsSaved",
      "addProviderDialog",
      "unpictured",
    ]);
    const { theme, ...proof } = row;
    if (typeof theme !== "string") throw new Error("Owned settings joins refused.");
    projectSettingsVisualAssertion(theme, proof);
    return theme;
  });
  if (new Set(themes).size !== 2) throw new Error("Owned settings joins refused.");
}

/** Serialized read-only function; deliberately observes the current ready-model list, not a historical rail. */
export function readSettingsVisualWitness(
  input: SettingsVisualObservationInput,
): Record<string, boolean> | null {
  if (
    input.origin !== "http://127.0.0.1:4885" ||
    location.origin !== input.origin ||
    location.search !== "" ||
    location.hash !== "" ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(input.threadId) ||
    input.branch !== `codex/delivery-retry-${input.theme}` ||
    !["light", "dark"].includes(input.theme)
  )
    return null;
  const visible = (element: Element | null): element is HTMLElement => {
    if (!element) return false;
    const box = element.getBoundingClientRect(),
      style = getComputedStyle(element);
    return (
      box.width > 0 &&
      box.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      style.opacity !== "0"
    );
  };
  const all = (selector: string) => Array.from(document.querySelectorAll(selector)).filter(visible);
  const one = (selector: string) => {
    const matches = all(selector);
    return matches.length === 1 ? matches[0]! : null;
  };
  const inView = (element: Element | null) => {
    if (!visible(element)) return false;
    const box = element.getBoundingClientRect();
    if (box.left < 0 || box.top < 0 || box.right > innerWidth || box.bottom > innerHeight)
      return false;
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor),
        clip = ancestor.getBoundingClientRect();
      if (
        ["auto", "scroll", "hidden", "clip"].includes(style.overflowX) &&
        (box.left < clip.left || box.right > clip.right)
      )
        return false;
      if (
        ["auto", "scroll", "hidden", "clip"].includes(style.overflowY) &&
        (box.top < clip.top || box.bottom > clip.bottom)
      )
        return false;
    }
    return true;
  };
  const text = (element: Element | null) => element?.textContent?.trim() ?? "";
  const field = (selector: string) => {
    const element = one(selector);
    return element instanceof HTMLInputElement ? element : null;
  };
  const readonlyAvailability = (element: Element | null) =>
    element !== null &&
    (element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true");
  const surface = '[data-center-surface-host][data-visible="true"]';
  const route = {
    "model-picker": "/local/" + input.threadId,
    "settings-provider-form": "/settings/providers",
    "settings-keybindings": "/settings/keybindings",
    "settings-source-control": "/settings/source-control",
  }[input.scene];
  if (!route || location.pathname !== route) return null;
  let target: Element | null = null,
    facts: Record<string, boolean>;
  let selected = false;
  if (input.scene === "model-picker") {
    const card = one(`[data-testid="thread-card-button-${input.threadId}"][aria-current="page"]`);
    const descriptions = (card?.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter((value) => value.endsWith("-branch"));
    selected =
      card !== null &&
      descriptions.length === 1 &&
      text(
        document.getElementById(descriptions[0]!)?.querySelector('[data-slot="tooltip-trigger"]') ??
          null,
      ) === input.branch;
    target = one('[data-model-picker-content="true"]');
    const search = field(
      '[data-model-picker-content="true"] input[placeholder="Search models..."]',
    );
    const rows = all('[data-model-picker-content="true"] [data-model-picker-instance-id]');
    const opus = one(
      '[data-model-picker-content="true"] [data-model-picker-instance-id="claudeAgent"][data-model-picker-model-slug="opus"]',
    );
    const favorite = opus
      ? Array.from(
          opus.querySelectorAll(
            'button[aria-label="Add to favorites"],button[aria-label="Remove from favorites"]',
          ),
        ).filter(visible)
      : [];
    facts = {
      singlePicker: target !== null,
      ownedReadyModel:
        inView(opus) &&
        text(opus).includes("Opus 5") &&
        text(opus).includes("Claude") &&
        rows.length > 0 &&
        rows.every(
          (row) =>
            row.getAttribute("data-model-picker-instance-id") === "claudeAgent" &&
            row.getAttribute("aria-disabled") !== "true" &&
            !row.hasAttribute("data-disabled"),
        ),
      searchFocused: inView(search) && search?.value === "" && document.activeElement === search,
      favoriteControl:
        favorite.length === 1 &&
        inView(favorite[0]!) &&
        !(favorite[0] instanceof HTMLButtonElement && favorite[0].disabled),
      draftRetained:
        text(one(`${surface} [data-testid="composer-editor"]`)) === "Owned visual review draft",
      selectionRetained:
        one(`${surface} [data-chat-provider-model-picker="true"]`)?.getAttribute("aria-label") ===
        "Claude · Opus 5",
      containedScroll:
        target !== null &&
        all('[data-model-picker-content="true"] .model-picker-list').every((list) =>
          Array.from(list.querySelectorAll("div")).some(
            (element) => getComputedStyle(element).overscrollBehaviorY === "contain",
          ),
        ) &&
        all('[data-model-picker-content="true"] .model-picker-list').length > 0,
    };
  } else {
    const label =
      input.scene === "settings-provider-form"
        ? "Providers"
        : input.scene === "settings-keybindings"
          ? "Keybindings"
          : "Source Control";
    const nav = all('[data-slot="sidebar-menu-button"][data-active="true"]');
    selected = nav.length === 1 && text(nav[0]!) === label;
    target = one('[data-slot="sidebar-inset"]');
    if (input.scene === "settings-provider-form") {
      const binary = field("#provider-instance-claudeAgent-binaryPath"),
        home = field("#provider-instance-claudeAgent-homePath"),
        args = field("#provider-instance-claudeAgent-launchArgs");
      const custom = field("#provider-instance-claudeAgent-custom-model");
      facts = {
        nonSecretFieldsVisible: [binary, home, args].every(inView),
        ownedConfigOnly:
          binary?.value === "claude" &&
          home?.value === "" &&
          args?.value === "" &&
          document.querySelector('input[aria-label^="Environment variable value"]') === null,
        modelsVisible:
          inView(custom) &&
          custom?.value === "" &&
          inView(
            one(
              'button[aria-label="Add Opus 5 to favorites"],button[aria-label="Remove Opus 5 from favorites"]',
            ),
          ),
        modelControlsVisible: inView(one('button[aria-label="Move Opus 5 up"]')),
        accountsRedacted: Array.from(
          document.querySelectorAll('button[aria-label="Toggle account email visibility"]'),
        ).every((account) => getComputedStyle(account).filter.includes("blur(")),
      };
    } else if (input.scene === "settings-keybindings") {
      target = one('[data-slot="popover-popup"]');
      const search = field('input[aria-label="Search keybindings"]'),
        expression = field('input[aria-label="When expression"]');
      const saves = all('[data-slot="sidebar-inset"] button').filter(
        (button) => text(button) === "Save",
      );
      facts = {
        filteredRow:
          search?.value === "sidebar" &&
          inView(one('[aria-label="sidebar.toggle"]')) &&
          all('[data-slot="sidebar-inset"] kbd').length > 0,
        conditionEditor:
          inView(expression) &&
          expression?.value === "terminalFocus && !terminalOpen" &&
          expression.getAttribute("aria-invalid") !== "true",
        conditionFocused: expression !== null && document.activeElement === expression,
        structuredCondition:
          inView(one('[aria-label="Negate terminalFocus"][aria-pressed="false"]')) &&
          inView(one('[aria-label="Negate terminalOpen"][aria-pressed="true"]')),
        unsavedCancelableRow:
          inView(one('button[aria-label="Cancel new keybinding"]')) &&
          saves.length === 1 &&
          saves[0] instanceof HTMLButtonElement &&
          saves[0].disabled,
      };
    } else {
      const git = one('[role="switch"][aria-label="Git availability"]');
      const row = git?.parentElement?.parentElement ?? null;
      const hosts = ["GitHub", "GitLab"].map((host) =>
        one(`[role="switch"][aria-label="${host} availability"]`),
      );
      const scan = one('button[aria-label="Rescan server environment"]');
      facts = {
        gitAvailable:
          inView(git) && git?.getAttribute("aria-checked") === "true" && readonlyAvailability(git),
        gitVersionVisible: Array.from(row?.querySelectorAll("code") ?? []).some(
          (code) => inView(code) && /^git version \d+\.\d+/.test(text(code)),
        ),
        hostingUnavailable:
          hosts.every(
            (host) =>
              inView(host) &&
              host?.getAttribute("aria-checked") === "false" &&
              readonlyAvailability(host),
          ) &&
          document.querySelector(
            'button[aria-label="Toggle source control account visibility"]',
          ) === null,
        availabilityReasons: hosts.every((host) =>
          text(host?.parentElement?.parentElement ?? null).includes(
            "Not available on this server:",
          ),
        ),
        fetchIntervalVisible:
          inView(field('input[aria-label="Automatic Git fetch interval in seconds"]')) &&
          one('button[aria-label="Toggle Git details"]')?.getAttribute("aria-expanded") === "true",
        scanSettled: inView(scan) && scan instanceof HTMLButtonElement && !scan.disabled,
      };
    }
  }
  const box = target?.getBoundingClientRect();
  const unobstructed =
    !!target &&
    !!box &&
    [
      [box.left + box.width / 2, box.top + 2],
      [box.left + box.width / 2, box.top + box.height / 2],
      [box.left + box.width / 2, box.bottom - 2],
    ].every(([x, y]) => {
      const hit = document.elementFromPoint(x!, y!);
      return hit !== null && (hit === target || target.contains(hit));
    });
  return {
    themeMatched: document.documentElement.classList.contains("dark") === (input.theme === "dark"),
    selectedMatched:
      selected &&
      one('[data-testid="environment-rail-local"]')?.getAttribute("aria-checked") === "true" &&
      one('[data-testid="environment-rail-local"] [data-status="connected"]') !== null,
    expectedTextMatched: Object.values(facts).every(Boolean),
    targetInView: innerWidth === 1280 && innerHeight === 960 && inView(target) && unobstructed,
    credentialAbsent:
      document.querySelector(
        '#pairing-token,input[type="password"],input[autocomplete="one-time-code"],textarea[placeholder^="bibcode://pair"]',
      ) === null,
    bootShellAbsent:
      document.getElementById("boot-shell") === null &&
      document.querySelector("vite-error-overlay") === null,
    ...facts,
  };
}

/** No click admission based on `hidden` alone: retain computed geometry/style facts. */
export function readSettingsAddProviderVisibility(input: SettingsVisualObservationInput) {
  if (
    input.origin !== "http://127.0.0.1:4885" ||
    location.origin !== input.origin ||
    location.pathname !== "/settings/providers" ||
    location.search ||
    location.hash
  )
    return null;
  const controls = document.querySelectorAll('button[aria-label="Add provider instance"]');
  if (controls.length !== 1 || !(controls[0] instanceof HTMLButtonElement)) return null;
  const button = controls[0],
    box = button.getBoundingClientRect(),
    style = getComputedStyle(button);
  return {
    oneControl: true,
    visible:
      box.width > 0 &&
      box.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0",
    hidden: button.hidden === true,
    enabled: !button.disabled,
  };
}

export interface SettingsVisualCaptureInput extends SettingsVisualObservationInput {
  browser: QualificationBrowser;
  owner: Pick<QualificationOwner, "until">;
  evidence: string;
  captured: Set<string>;
  verifyOwnedIdentity: () => Promise<void>;
  observeFailure?: (error: unknown, witness: Readonly<Record<string, boolean>> | null) => void;
}
export async function captureSettingsVisualScene(
  input: SettingsVisualCaptureInput,
): Promise<object> {
  let latestWitness: unknown = null;
  let identityVerified = false;
  try {
    const file = settingsVisualScreenshotName(input.scene, input.theme),
      path = NodePath.join(input.evidence, file);
    if (input.captured.has(file) || NodeFS.existsSync(path) || (await input.browser.isAlertOpen()))
      throw new Error("Visual settings capture refused.");
    const observation: SettingsVisualObservationInput = {
      scene: input.scene,
      theme: input.theme,
      origin: input.origin,
      threadId: input.threadId,
      branch: input.branch,
    };
    await input.verifyOwnedIdentity();
    identityVerified = true;
    let witness: Record<string, true> | undefined;
    await input.owner.until(async () => {
      const value = await bounded(
        input.browser.execute(readSettingsVisualWitness, observation),
        2_000,
      );
      latestWitness = value;
      try {
        witness = validateSettingsVisualWitness(input.scene, value);
        return true;
      } catch {
        return false;
      }
    });
    const bytes = Buffer.from(await bounded(input.browser.takeScreenshot(), 5_000), "base64");
    identityVerified = false;
    await input.verifyOwnedIdentity();
    identityVerified = true;
    latestWitness = await bounded(
      input.browser.execute(readSettingsVisualWitness, observation),
      2_000,
    );
    validateSettingsVisualWitness(input.scene, latestWitness);
    const image = inspectScreenshot(bytes);
    if (image.width !== 1280 || image.height !== 960)
      throw new Error("Visual settings viewport refused.");
    NodeFS.writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
    input.captured.add(file);
    return { scene: input.scene, theme: input.theme, file, witness, ...image };
  } catch (error) {
    try {
      input.observeFailure?.(
        error,
        identityVerified ? projectSettingsVisualFailureWitness(input.scene, latestWitness) : null,
      );
    } catch {
      // Optional facts cannot replace the original capture failure.
    }
    throw error;
  }
}

export interface SettingsVisualInput extends Omit<SettingsVisualObservationInput, "scene"> {
  browser: QualificationBrowser;
  owner: Pick<QualificationOwner, "until">;
  step: (phase: string) => void;
  verifyManaged: () => Promise<void>;
  verifyOwnedIdentity: () => Promise<void>;
  capture: (scene: SettingsVisualScene) => Promise<void>;
}
/** Independent four-scene sequence. Unsaved state is discarded through public cancel/back controls. */
export async function runVisualSettings(input: SettingsVisualInput): Promise<object> {
  const { browser, step } = input;
  const composer =
    '[data-center-surface-host][data-visible="true"] [data-testid="composer-editor"]';
  const picker =
    '[data-center-surface-host][data-visible="true"] [data-chat-provider-model-picker="true"]';
  const popup = '[data-slot="popover-popup"]';
  let inSettings = false,
    overlay = false,
    newBinding = false,
    expandedClaude = false;
  let addProviderDialog: "unsupported-hidden-control" | "unpictured-public-dialog";
  type KeybindingsControl = "nav" | "search" | "add" | "when";
  const observeKeybindingsAwait = (
    control: KeybindingsControl | "search-input" | "when-input",
    operation: "lookup" | "displayed" | "enabled" | "click" | "fill",
  ) => {
    try {
      step("visual-settings-keybindings-open-" + control + "-" + operation);
    } catch {
      // Optional attribution cannot replace an existing action or outcome.
    }
  };
  const click = async (selector: string, control?: KeybindingsControl) => {
    const element = browser.$(selector);
    if (control) observeKeybindingsAwait(control, "displayed");
    await element.waitForDisplayed();
    if (control) observeKeybindingsAwait(control, "lookup");
    if ((await (await browser.$$(selector)).length) !== 1)
      throw new Error("Visual settings public control refused.");
    if (control) observeKeybindingsAwait(control, "enabled");
    await element.waitForEnabled();
    if (control) observeKeybindingsAwait(control, "click");
    await element.click();
  };
  const unchanged = async () => {
    await input.verifyManaged();
    if ((await browser.$(composer).getText()).trim() !== "Owned visual review draft")
      throw new Error("Visual settings draft changed.");
    if ((await browser.$(picker).getAttribute("aria-label")) !== "Claude · Opus 5")
      throw new Error("Visual settings provider selection changed.");
  };
  const capture = async (scene: SettingsVisualScene) => {
    step(`visual-${scene}`);
    await input.verifyOwnedIdentity();
    await input.capture(scene);
  };
  const scroll = async (selector: string, block: "start" | "end") => {
    const before = await bounded(browser.execute(readVisualPageScroll), 2_000);
    await browser.$(selector).scrollIntoView({ block });
    const after = await bounded(browser.execute(readVisualPageScroll), 2_000);
    if (before.x !== after.x || before.y !== after.y)
      throw new Error("Visual settings scroll escaped.");
  };
  const closeOverlay = async () => {
    await browser.keys("Escape");
    overlay = false;
  };
  try {
    await unchanged();
    step("visual-settings-model-open");
    overlay = true;
    await click(picker);
    await browser
      .$('[data-model-picker-content="true"] input[placeholder="Search models..."]')
      .waitForDisplayed();
    await capture("model-picker");
    await closeOverlay();
    await browser.$('[data-model-picker-content="true"]').waitForDisplayed({ reverse: true });
    await unchanged();

    step("visual-settings-open");
    inSettings = true;
    await click('[data-testid="environment-rail-manage"]');
    step("visual-settings-keybindings-open");
    await click("button=Keybindings", "nav");
    await click('button[aria-label="Search keybindings"]', "search");
    observeKeybindingsAwait("search-input", "fill");
    await browser.$('input[aria-label="Search keybindings"]').setValue("sidebar");
    await click('button[aria-label="Add keybinding"]', "add");
    newBinding = true;
    await click('button[aria-label="Edit when clause for new keybinding"]', "when");
    overlay = true;
    observeKeybindingsAwait("when-input", "displayed");
    await browser
      .$('[data-slot="popover-popup"][data-open] input[aria-label="When expression"]')
      .waitForDisplayed();
    observeKeybindingsAwait("when-input", "fill");
    await browser
      .$('[data-slot="popover-popup"][data-open] input[aria-label="When expression"]')
      .setValue("terminalFocus && !terminalOpen");
    await capture("settings-keybindings");
    await closeOverlay();
    await browser.$(popup).waitForDisplayed({ reverse: true });
    await click('button[aria-label="Cancel new keybinding"]');
    newBinding = false;

    step("visual-settings-source-control-open");
    await click("button=Source Control");
    await click('button[aria-label="Toggle Git details"]');
    await capture("settings-source-control");

    await click("button=Providers");
    const add = await bounded(
      browser.execute(readSettingsAddProviderVisibility, {
        scene: "settings-provider-form" as const,
        theme: input.theme,
        origin: input.origin,
        threadId: input.threadId,
        branch: input.branch,
      }),
      2_000,
    );
    if (
      !add ||
      add.oneControl !== true ||
      typeof add.visible !== "boolean" ||
      typeof add.hidden !== "boolean" ||
      typeof add.enabled !== "boolean"
    )
      throw new Error("Visual settings Add admission refused.");
    if (!add.visible && add.hidden) addProviderDialog = "unsupported-hidden-control";
    else if (add.visible && add.enabled) {
      step("visual-settings-add-open");
      overlay = true;
      await click('button[aria-label="Add provider instance"]');
      await browser.$('[data-slot="dialog-popup"][role="dialog"]').waitForDisplayed();
      await closeOverlay();
      await browser
        .$('[data-slot="dialog-popup"][role="dialog"]')
        .waitForDisplayed({ reverse: true });
      addProviderDialog = "unpictured-public-dialog";
    } else throw new Error("Visual settings Add admission refused.");
    step("visual-settings-provider-details");
    await click('button[aria-label="Toggle Claude details"]');
    expandedClaude = true;
    await browser.$("#provider-instance-claudeAgent-binaryPath").waitForDisplayed();
    await scroll("#provider-instance-claudeAgent-binaryPath", "start");
    await scroll("#provider-instance-claudeAgent-custom-model", "end");
    await capture("settings-provider-form");
    await click('button[aria-label="Toggle Claude details"]');
    expandedClaude = false;

    step("visual-settings-back");
    await click("button=Back");
    inSettings = false;
    await unchanged();
    return {
      managedIdentityMatched: true,
      draftRetained: true,
      providerSelectionRetained: true,
      keybindingCancelled: true,
      noSettingsSaved: true,
      addProviderDialog,
      unpictured: [
        "add-provider-instance-dialog",
        "provider-ready-disabled-unavailable-overview",
        "provider-account-and-status-header",
        "model-effort-fast-mode-controls",
        "source-control-azure-bitbucket",
      ],
    };
  } catch (failure) {
    // Cleanup failure must not replace the original refusal. Owner still closes the browser/process scope.
    if (overlay) {
      try {
        await closeOverlay();
      } catch {
        /* Owned teardown remains authoritative. */
      }
    }
    if (newBinding) {
      try {
        await click('button[aria-label="Cancel new keybinding"]');
      } catch {
        /* Route teardown discards the local draft. */
      }
    }
    if (expandedClaude) {
      try {
        await click('button[aria-label="Toggle Claude details"]');
      } catch {
        /* Route teardown closes local details. */
      }
    }
    if (inSettings) {
      try {
        await click("button=Back");
      } catch {
        /* The original failure owns cleanup. */
      }
    }
    throw failure;
  }
}
