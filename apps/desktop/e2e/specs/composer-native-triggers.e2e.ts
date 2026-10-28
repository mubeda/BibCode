// @effect-diagnostics nodeBuiltinImport:off - Packaged UI tests read fixture logs and save screenshots.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  allowRpcSockets,
  closeTrackedRpcSocket,
  composerDraftStorageKey,
  dispatchConnectivityEvent,
  installRpcSocketHarness,
  readThreadDraftEntries,
  rpcSocketsOpened,
  typeThrough,
} from "../support/connection-drop.ts";
import {
  readProviderInputLog,
  waitForProviderInputLogEntry,
} from "../support/provider-input-log.ts";
import { composerProviderProfiles, desktopUiFixture } from "../support/test-project.ts";
import {
  ensureMainSidebarOpen,
  mockDesktopUiFolderPicker,
  setDesktopUiWindowSize,
} from "../support/ui-state.ts";

const artifactDirectory = process.env.BIBCODE_E2E_ARTIFACT_DIR;
const projectPath = process.env.BIBCODE_E2E_PROJECT_PATH;
const providerInputLogPath = process.env.BIBCODE_E2E_PROVIDER_INPUT_LOG;
if (!artifactDirectory || !projectPath || !providerInputLogPath) {
  throw new Error("The packaged desktop composer fixture environment was not prepared.");
}

const preparedArtifactDirectory: string = artifactDirectory;
const preparedProjectPath: string = projectPath;
const preparedProviderInputLogPath: string = providerInputLogPath;

type ComposerProvider = keyof typeof composerProviderProfiles;

const composerGroupLabels = {
  bibcode: "BiBCode",
  commands: "Commands",
  skills: "Skills",
  files: "Files",
  agents: "Agents",
} as const;

type ComposerGroupId = keyof typeof composerGroupLabels;

interface ProviderScenario {
  readonly provider: ComposerProvider;
  readonly displayName: string;
  readonly keyboardCommand: string;
  readonly nativePrompt: string;
}

const visibleComposerFormSelector =
  '//*[@data-center-surface-host and @data-visible="true"]//*[@data-chat-composer-form="true"]';

const scenarios: readonly ProviderScenario[] = [
  {
    provider: "codex",
    displayName: "Codex",
    keyboardCommand: "goal",
    nativePrompt: "$refactor",
  },
  {
    provider: "claudeAgent",
    displayName: "Claude",
    keyboardCommand: "compact",
    nativePrompt: "/compact",
  },
  {
    provider: "cursor",
    displayName: "Cursor",
    keyboardCommand: "review",
    nativePrompt: "/review",
  },
  {
    provider: "opencode",
    displayName: "OpenCode",
    keyboardCommand: "init",
    nativePrompt: "@reviewer",
  },
] as const;

const expectedProviderInputs = [
  { provider: "codex", prompt: "$refactor" },
  { provider: "codex", prompt: "@README.md" },
  { provider: "claudeAgent", prompt: "/compact" },
  { provider: "claudeAgent", prompt: "/docs" },
  { provider: "cursor", prompt: "/review" },
  { provider: "opencode", prompt: "@reviewer" },
] as const;

function composerForm() {
  return browser.$(visibleComposerFormSelector);
}

function composerEditor() {
  return composerForm().$('[data-testid="composer-editor"]');
}

async function waitForComposerDisplayed(): Promise<void> {
  const form = browser.$(visibleComposerFormSelector);
  await form.waitForExist();
  await form.waitForDisplayed();
  await form.$('[data-testid="composer-editor"]').waitForDisplayed();
}

async function visibleComposerItemIds(): Promise<string[]> {
  return browser.execute(() =>
    [...document.querySelectorAll<HTMLElement>("[data-composer-item-id]")]
      .filter((element) => {
        const style = window.getComputedStyle(element);
        const rectangle = element.getBoundingClientRect();
        return (
          element.checkVisibility({
            opacityProperty: true,
            visibilityProperty: true,
          }) &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rectangle.width > 0 &&
          rectangle.height > 0
        );
      })
      .map((element) => element.dataset.composerItemId ?? "")
      .filter((id) => id.length > 0),
  );
}

async function visibleComposerGroups(): Promise<Array<{ id: string; label: string }>> {
  return browser.execute(() =>
    [...document.querySelectorAll<HTMLElement>("[data-composer-group]")]
      .filter((element) => {
        const style = window.getComputedStyle(element);
        const rectangle = element.getBoundingClientRect();
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rectangle.width > 0 &&
          rectangle.height > 0
        );
      })
      .map((element) => {
        const id = element.dataset.composerGroup ?? "";
        const label =
          element.querySelector<HTMLElement>(`[data-composer-group-label="${CSS.escape(id)}"]`)
            ?.textContent ?? "";
        return { id, label };
      }),
  );
}

async function assertComposerGroups(expectedIds: readonly ComposerGroupId[]): Promise<void> {
  const expected = expectedIds.map((id) => ({ id, label: composerGroupLabels[id] }));
  await browser.waitUntil(
    async () => JSON.stringify(await visibleComposerGroups()) === JSON.stringify(expected),
    {
      timeoutMsg: `Composer groups did not match ${JSON.stringify(expected)}.`,
    },
  );
  expect(await visibleComposerGroups()).toEqual(expected);
}

async function waitForComposerItem(id: string): Promise<void> {
  await browser.waitUntil(async () => (await visibleComposerItemIds()).includes(id), {
    timeoutMsg: `Composer item did not appear: ${id}`,
  });
}

const composerMenuSelector = '[data-composer-menu="true"]';

/**
 * Waits until the visible composer menu has settled its workspace search for the
 * current query. While a refreshed search is pending the menu keeps its loaded
 * rows mounted and reports `data-composer-menu-loading="true"`; clicking before
 * it settles would target a row the incoming result may still replace.
 */
async function waitForComposerMenuSettled(): Promise<void> {
  const menu = composerForm().$(composerMenuSelector);
  await menu.waitForExist({ timeoutMsg: "The composer menu did not open inside the composer." });
  await browser.waitUntil(
    async () => (await menu.getAttribute("data-composer-menu-loading")) === "false",
    { timeoutMsg: "The composer menu did not settle its workspace search." },
  );
}

async function clickVisibleComposerItem(id: string): Promise<void> {
  await waitForComposerItem(id);
  await waitForComposerMenuSettled();
  const candidate = composerForm().$(`${composerMenuSelector} [data-composer-item-id="${id}"]`);
  await candidate.waitForExist({ timeoutMsg: `The composer item disappeared: ${id}` });
  await candidate.waitForDisplayed({ timeoutMsg: `The composer item remained hidden: ${id}` });
  await candidate.waitForEnabled({ timeoutMsg: `The composer item remained disabled: ${id}` });
  // Resolve the element once so the ownership script and the click share the
  // same element reference. WebdriverIO only serializes resolved elements into
  // WebDriver element references; an unresolved chainable would reach the
  // page as a plain object.
  const element = await candidate;
  const ownership = await browser.execute(
    (element: HTMLElement, itemId: string) => {
      const menu = element.closest<HTMLElement>('[data-composer-menu="true"]');
      const host = element.closest<HTMLElement>("[data-center-surface-host]");
      return {
        connected: element.isConnected,
        itemId: element.dataset.composerItemId ?? null,
        menuLoading: menu?.dataset.composerMenuLoading ?? null,
        hostVisible: host?.dataset.visible ?? null,
        expectedItemId: itemId,
      };
    },
    element,
    id,
  );
  expect(ownership).toEqual({
    connected: true,
    itemId: id,
    menuLoading: "false",
    hostVisible: "true",
    expectedItemId: id,
  });
  await element.click();
}

async function waitForComposerItemsToClose(): Promise<void> {
  await browser.waitUntil(async () => (await visibleComposerItemIds()).length === 0, {
    timeoutMsg: "The stale composer menu remained open.",
  });
}

async function appendAndSelectComposerItem(input: string, itemId: string): Promise<void> {
  const editor = composerEditor();
  await editor.click();
  await editor.addValue(input);
  await waitForComposerItem(itemId);
  await clickVisibleComposerItem(itemId);
}

async function visibleComposerChipTexts(
  attribute: "data-composer-mention-chip" | "data-composer-skill-chip" | "data-composer-agent-chip",
): Promise<string[]> {
  return browser.execute((chipAttribute) => {
    return [...document.querySelectorAll<HTMLElement>(`[${chipAttribute}="true"]`)]
      .filter((element) => {
        const style = window.getComputedStyle(element);
        const rectangle = element.getBoundingClientRect();
        return (
          !element.closest(".hidden") &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rectangle.width > 0 &&
          rectangle.height > 0
        );
      })
      .map((element) => element.textContent?.trim() ?? "");
  }, attribute);
}

async function setComposerValue(value: string): Promise<void> {
  const editor = composerEditor();
  await expect(editor).toBeDisplayed();
  await editor.click();
  await browser.execute(() => {
    const editor = document.activeElement;
    if (!(editor instanceof HTMLElement) || editor.dataset.testid !== "composer-editor") {
      throw new Error("The composer editor did not receive focus.");
    }
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(editor);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await browser.keys("Backspace");
  if (value.length === 0) {
    await browser.waitUntil(
      async () => {
        if ((await editor.getText()) === "") return true;
        await editor.click();
        await browser.keys("Backspace");
        return (await editor.getText()) === "";
      },
      {
        timeout: 3_000,
        interval: 100,
        timeoutMsg: "Composer chips did not clear before entering a new value.",
      },
    );
  }
  if (value.length > 0) {
    await editor.addValue(value);
  }
  await waitForComposerValue(value);
}

let composerValueTimeouts = 0;

/**
 * Waits for the visible composer to show `value`. On a timeout it first writes what the
 * composer and its connection looked like, so a CI failure names the state it met (#199).
 */
async function waitForComposerValue(value: string): Promise<void> {
  try {
    await browser.waitUntil(async () => (await composerEditor().getText()) === value);
  } catch (error) {
    const diagnostics = await browser.execute(
      (expected: string, draftStorageKey: string) => {
        const form = document.querySelector<HTMLElement>(
          '[data-center-surface-host][data-visible="true"] [data-chat-composer-form="true"]',
        );
        const editor = form?.querySelector<HTMLElement>('[data-testid="composer-editor"]') ?? null;
        const send = form?.querySelector<HTMLButtonElement>('button[type="submit"]') ?? null;
        const active = document.activeElement as HTMLElement | null;
        return {
          expected,
          text: editor?.textContent ?? null,
          editable: editor?.contentEditable ?? null,
          editorFocused: editor !== null && active === editor,
          activeElement: active
            ? { tagName: active.tagName, testId: active.dataset.testid ?? null }
            : null,
          placeholder: editor?.getAttribute("aria-placeholder") ?? null,
          send: send ? { label: send.getAttribute("aria-label"), disabled: send.disabled } : null,
          composerText: form?.innerText.slice(0, 2_000) ?? null,
          toasts: [...document.querySelectorAll<HTMLElement>('[data-slot="toast-title"]')].map(
            (title) => title.textContent,
          ),
          onLine: navigator.onLine,
          hash: window.location.hash,
          drafts: window.localStorage.getItem(draftStorageKey),
        };
      },
      value,
      composerDraftStorageKey,
    );
    composerValueTimeouts += 1;
    NodeFS.writeFileSync(
      NodePath.join(
        preparedArtifactDirectory,
        `composer-value-timeout-${composerValueTimeouts}.json`,
      ),
      JSON.stringify(diagnostics, null, 2),
      "utf8",
    );
    throw new Error(`Composer did not contain ${JSON.stringify(value)}.`, { cause: error });
  }
}

async function ensureFixtureProjectImported(): Promise<void> {
  const appOrigin = await browser.execute(() => window.location.origin);
  await browser.url(`${appOrigin}/#/`);
  await ensureMainSidebarOpen();
  const projectSelector = `//button[@data-sidebar="menu-button"][.//span[normalize-space()="${desktopUiFixture.projectName}"]]`;
  const hasVisibleProject = async () => {
    for (const candidate of await browser.$$(projectSelector)) {
      if (await candidate.isDisplayed()) return true;
    }
    return false;
  };
  if (await hasVisibleProject()) {
    return;
  }

  const projectDataLoading = browser.$("//*[normalize-space()='Project data is still loading']");
  if (await projectDataLoading.isExisting()) {
    await projectDataLoading.waitForDisplayed({
      reverse: true,
      timeoutMsg: "The primary project catalog did not become ready for fixture import.",
    });
  }

  const addProject = browser.$('[data-testid="sidebar-add-project-trigger"]');
  await expect(addProject).toBeDisplayed();
  await addProject.click();
  await browser.$('[role="dialog"]').waitForExist();
  const browseFolder = browser.$(
    "//button[@data-add-project-action='true'][.//span[normalize-space()='Browse folder']]",
  );
  await browseFolder.waitForDisplayed();
  await mockDesktopUiFolderPicker(preparedProjectPath);
  await browseFolder.click();
  await browser.waitUntil(hasVisibleProject, {
    timeoutMsg: "The imported fixture project did not become visible in the main sidebar.",
  });
}

async function openInitialCodexDraft(): Promise<void> {
  const projectSelector = `//button[@data-sidebar="menu-button"][.//span[normalize-space()="${desktopUiFixture.projectName}"]]`;
  const primaryWorkspace = browser.$(
    '//*[@data-thread-item="true"][.//span[normalize-space()="main"]]',
  );
  if (!(await primaryWorkspace.isDisplayed())) {
    let projectClicked = false;
    for (const project of await browser.$$(projectSelector)) {
      if (await project.isDisplayed()) {
        await project.click();
        projectClicked = true;
        break;
      }
    }
    expect(projectClicked).toBe(true);
    await primaryWorkspace.waitForDisplayed();
  }
  await primaryWorkspace.click();
  await waitForComposerDisplayed();
}

async function openProviderPanel(displayName: string): Promise<void> {
  const newPanelSelector = '[aria-label="New panel"]';
  await browser.waitUntil(
    async () => {
      for (const candidate of await browser.$$(newPanelSelector)) {
        if ((await candidate.isDisplayed()) && (await candidate.isEnabled())) {
          return true;
        }
      }
      return false;
    },
    {
      timeoutMsg: "The provider panel menu did not become available.",
    },
  );
  for (const candidate of await browser.$$(newPanelSelector)) {
    if ((await candidate.isDisplayed()) && (await candidate.isEnabled())) {
      await candidate.click();
      break;
    }
  }
  const provider = browser.$(`//*[@role="menuitem"][.//span[normalize-space()="${displayName}"]]`);
  await provider.waitForDisplayed();
  await provider.waitForEnabled();
  await provider.click();
  await browser.waitUntil(
    async () => {
      for (const candidate of await browser.$$(
        `//*[@role="menuitem"][.//span[normalize-space()="${displayName}"]]`,
      )) {
        if (await candidate.isDisplayed()) return false;
      }
      return true;
    },
    {
      timeoutMsg: `The ${displayName} panel menu did not close.`,
    },
  );
  const activeProviderTab = browser.$(
    `//*[contains(concat(" ", normalize-space(@class), " "), " bg-accent ") and ` +
      `.//button[@aria-label="Close ${displayName}"] and ` +
      `.//span[normalize-space()="${displayName}"]]`,
  );
  try {
    await activeProviderTab.waitForDisplayed();
  } catch (error) {
    const diagnostics = await browser.execute(() => {
      const centerPanelStorage = Object.fromEntries(
        Array.from({ length: window.localStorage.length }, (_, index) =>
          window.localStorage.key(index),
        )
          .filter((key): key is string => key !== null && /center|panel/i.test(key))
          .map((key) => [key, window.localStorage.getItem(key)]),
      );
      return {
        href: window.location.href,
        centerPanelStorage,
        tabs: [...document.querySelectorAll<HTMLElement>("[data-center-panel-tab-id]")].map(
          (tab) => ({
            id: tab.dataset.centerPanelTabId ?? null,
            groupId: tab.dataset.centerPanelGroupId ?? null,
            active: tab.dataset.activeTab ?? null,
            text: tab.textContent,
          }),
        ),
        notifications: [...document.querySelectorAll<HTMLElement>('[aria-label="Notifications"]')]
          .map((region) => region.textContent)
          .filter((text): text is string => text !== null && text.length > 0),
      };
    });
    NodeFS.writeFileSync(
      NodePath.join(
        preparedArtifactDirectory,
        `provider-panel-${displayName.toLowerCase()}-failure.json`,
      ),
      JSON.stringify(diagnostics, null, 2),
      "utf8",
    );
    throw error;
  }
  await waitForComposerDisplayed();
}

async function activateProviderPanel(displayName: string): Promise<void> {
  const closeSelector = `button[aria-label="Close ${displayName}"]`;
  const closeButton = browser.$(closeSelector);
  await closeButton.waitForExist();
  const activated = await browser.execute((selector) => {
    const close = document.querySelector<HTMLButtonElement>(selector);
    const tab = close?.closest<HTMLElement>("[data-active-tab]");
    const activate = [...(tab?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
      (button) => button !== close,
    );
    if (!tab || !activate) return false;
    if (tab.dataset.activeTab !== "true") {
      activate.click();
    }
    return true;
  }, closeSelector);
  expect(activated).toBe(true);
  await browser.waitUntil(
    () =>
      browser.execute(
        (selector) =>
          document
            .querySelector(selector)
            ?.closest<HTMLElement>("[data-active-tab]")
            ?.getAttribute("data-active-tab") === "true",
        closeSelector,
      ),
    {
      timeoutMsg: `The ${displayName} provider panel did not become active.`,
    },
  );
  await waitForComposerDisplayed();
}

async function assertUnifiedModelPicker(scenario: ProviderScenario): Promise<void> {
  const pickerTrigger = composerForm().$('[data-chat-provider-model-picker="true"]');
  await expect(pickerTrigger).toBeEnabled();
  await pickerTrigger.click();

  await browser.waitUntil(
    async () => {
      for (const content of await browser.$$('[data-model-picker-content="true"]')) {
        if (await content.isDisplayed()) return true;
      }
      return false;
    },
    { timeoutMsg: `The ${scenario.displayName} model picker did not open.` },
  );
  const readVisibleModelRows = () =>
    browser.execute(() =>
      [
        ...document.querySelectorAll<HTMLElement>(
          '[data-model-picker-content="true"] [data-slot="combobox-item"]',
        ),
      ]
        .filter((element) => {
          const style = window.getComputedStyle(element);
          const rectangle = element.getBoundingClientRect();
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rectangle.width > 0 &&
            rectangle.height > 0
          );
        })
        .map((element) => ({
          instanceId: element.dataset.modelPickerInstanceId ?? "",
          modelSlug: element.dataset.modelPickerModelSlug ?? "",
          label: element.innerText.trim(),
        })),
    );
  await browser.waitUntil(
    async () => {
      return (await readVisibleModelRows()).length > 0;
    },
    {
      timeoutMsg: `The ${scenario.displayName} model picker did not render any models.`,
    },
  );
  const modelRows = await readVisibleModelRows();
  expect(modelRows.every((row) => row.instanceId.length > 0 && row.modelSlug.length > 0)).toBe(
    true,
  );
  expect(modelRows.some((row) => row.instanceId === scenario.provider)).toBe(true);
  expect(new Set(modelRows.map((row) => `${row.instanceId}:${row.modelSlug}`)).size).toBe(
    modelRows.length,
  );
  if (scenario.provider === "claudeAgent") {
    const claudeRows = modelRows.filter(({ instanceId }) => instanceId === "claudeAgent");
    expect(claudeRows.map(({ modelSlug }) => modelSlug)).toEqual(["opus", "sonnet"]);
    expect(claudeRows[0]?.label).toContain("Opus 5");
    await browser.saveScreenshot(
      NodePath.join(preparedArtifactDirectory, "claude-opus-5-model-picker.png"),
    );
  }
  if (scenario.provider === "codex") {
    await browser.saveScreenshot(
      NodePath.join(preparedArtifactDirectory, "composer-unified-model-picker.png"),
    );
  }
  await browser.keys("Escape");
  await browser.waitUntil(
    async () => {
      for (const content of await browser.$$('[data-model-picker-content="true"]')) {
        if (await content.isDisplayed()) return false;
      }
      return true;
    },
    { timeoutMsg: `The ${scenario.displayName} model picker did not close.` },
  );
  if (scenario.provider === "claudeAgent") {
    await expect(composerForm().$('button[aria-label="Reasoning effort: High"]')).toBeDisplayed();
  }
}

async function assertColonMenu(provider: ComposerProvider): Promise<void> {
  await setComposerValue(":");
  await waitForComposerItem("bibcode-action:default");
  await assertComposerGroups(["bibcode"]);
  const ids = await visibleComposerItemIds();
  expect(ids.length).toBeGreaterThan(0);
  expect(ids.every((id) => id.startsWith("bibcode-action:"))).toBe(true);
  if (provider === "codex") {
    await browser.saveScreenshot(
      NodePath.join(preparedArtifactDirectory, "composer-colon-menu.png"),
    );
  }
  await clickVisibleComposerItem("bibcode-action:default");
  await waitForComposerValue("");
}

async function assertSlashMenu(scenario: ProviderScenario): Promise<void> {
  const profile = composerProviderProfiles[scenario.provider];
  await setComposerValue("/");
  await waitForComposerItem(`provider-command:${scenario.provider}:${scenario.keyboardCommand}`);
  await assertComposerGroups([
    "commands",
    ...(profile.slashSkills.length > 0 ? (["skills"] as const) : []),
  ]);
  const ids = await visibleComposerItemIds();
  const expectedIds = [
    ...profile.commands.map((command) => `provider-command:${scenario.provider}:${command}`),
    ...profile.slashSkills.map((skill) => `provider-skill:${scenario.provider}:slash:${skill}`),
  ].toSorted();
  expect(ids.toSorted()).toEqual(expectedIds);
  if (scenario.provider === "claudeAgent") {
    await browser.saveScreenshot(
      NodePath.join(preparedArtifactDirectory, "composer-slash-groups.png"),
    );
  }

  await setComposerValue(`/${scenario.keyboardCommand}`);
  await waitForComposerItem(`provider-command:${scenario.provider}:${scenario.keyboardCommand}`);
  await composerEditor().click();
  await browser.keys("ArrowDown");
  await expect(
    browser.$(
      `[data-composer-item-id="provider-command:${scenario.provider}:${scenario.keyboardCommand}"][data-composer-item-active="true"]`,
    ),
  ).toBeDisplayed();
  await browser.keys("Enter");
  await waitForComposerValue(`/${scenario.keyboardCommand} `);
  await setComposerValue("");
}

async function assertDollarMenu(provider: ComposerProvider): Promise<void> {
  const profile = composerProviderProfiles[provider];
  await setComposerValue("$");
  if (profile.dollarSkills.length === 0) {
    await waitForComposerItemsToClose();
    await assertComposerGroups([]);
    return;
  }
  await assertComposerGroups(["skills"]);
  for (const skill of profile.dollarSkills) {
    await waitForComposerItem(`provider-skill:${provider}:dollar:${skill}`);
  }
  const ids = await visibleComposerItemIds();
  expect(ids.toSorted()).toEqual(
    profile.dollarSkills.map((skill) => `provider-skill:${provider}:dollar:${skill}`).toSorted(),
  );
  await setComposerValue("");
}

async function assertReferenceMenu(provider: ComposerProvider): Promise<void> {
  const expectedAgents = composerProviderProfiles[provider].mentionableAgents;
  await setComposerValue("@");
  await waitForComposerItem("file-reference:file:README.md");
  await assertComposerGroups([
    "files",
    ...(expectedAgents.length > 0 ? (["agents"] as const) : []),
  ]);
  const ids = await visibleComposerItemIds();
  expect(ids.some((id) => id.startsWith("file-reference:"))).toBe(true);
  const agentIds = ids.filter((id) => id.startsWith("agent-reference:")).toSorted();
  expect(agentIds).toEqual(
    expectedAgents.map((agent) => `agent-reference:${provider}:${agent}`).toSorted(),
  );
  if (provider === "opencode") {
    await browser.saveScreenshot(
      NodePath.join(preparedArtifactDirectory, "composer-reference-groups.png"),
    );
  }

  await setComposerValue("@README");
  await waitForComposerItem("file-reference:file:README.md");
  await clickVisibleComposerItem("file-reference:file:README.md");
  await expect(composerForm().$('[data-composer-mention-chip="true"]')).toBeDisplayed();
  await setComposerValue("");
}

async function clickSendWhenLive(): Promise<void> {
  // The primary action swaps between Send, Sending and Stop while the previous turn starts,
  // and the embedded WebDriver's click reports success on a button React has just replaced
  // or disabled, so a send right after Claude's /compact could be lost (#177). Checking and
  // clicking in one page task leaves no gap for that swap; until Send is live, this waits.
  // Only an explicit "not live yet" is retried: a script error may come after the click, so
  // it fails the step instead of clicking a second time. waitUntil retries a condition that
  // throws, so the error stops the wait and is thrown after it.
  let clickFailure: unknown = null;
  await browser.waitUntil(
    async () => {
      try {
        return await browser.execute(() => {
          const send = document.querySelector<HTMLButtonElement>(
            '[data-center-surface-host][data-visible="true"] [data-chat-composer-form="true"] button[aria-label="Send message"]',
          );
          if (!send || send.disabled) return false;
          send.click();
          return true;
        });
      } catch (error) {
        clickFailure = error;
        return true;
      }
    },
    {
      timeout: 20_000,
      interval: 100,
      timeoutMsg: "The composer's Send button never became available in 20 seconds.",
    },
  );
  if (clickFailure !== null) throw clickFailure;
}

async function sendCurrentComposerPrompt(
  provider: ComposerProvider,
  prompt: string,
  initialLogLength: number,
): Promise<void> {
  await clickSendWhenLive();
  await waitForProviderInputLogEntry(
    preparedProviderInputLogPath,
    initialLogLength,
    { provider, prompt },
    { timeoutMs: 20_000 },
  );
  // A new chat's first send swaps its draft route for the thread's route once the thread
  // starts; waiting for that makes the next step act on the thread's composer. The primary
  // workspace's chat is already a server thread, so on its route this returns at once.
  // In one macOS x64 run "@README", typed right after this send, never appeared; the server
  // saw the client close its connection in the same half second (#199). Back then every phase
  // but connected made the editor read-only and dropped keys, which a packaged loop
  // reproduces; the editor now stays editable. What closed that runner's connection is not
  // known, and a timeout in waitForComposerValue writes the composer's state for the next one.
  await waitForDraftRouteToGiveWay();
}

async function isOnDraftRoute(): Promise<boolean> {
  return browser.execute(() => window.location.hash.includes("/draft/"));
}

async function waitForDraftRouteToGiveWay(): Promise<void> {
  await browser.waitUntil(async () => !(await isOnDraftRoute()), {
    timeoutMsg: "The new chat's draft route never gave way to its thread.",
  });
}

async function sendAndAssertNativePrompt(scenario: ProviderScenario): Promise<void> {
  const initialLogLength = readProviderInputLog(preparedProviderInputLogPath).length;
  await setComposerValue(scenario.nativePrompt);
  await sendCurrentComposerPrompt(scenario.provider, scenario.nativePrompt, initialLogLength);
}

async function selectAndSendReadmeReference(): Promise<void> {
  const initialLogLength = readProviderInputLog(preparedProviderInputLogPath).length;
  await setComposerValue("@README");
  await waitForComposerItem("file-reference:file:README.md");
  await clickVisibleComposerItem("file-reference:file:README.md");
  await expect(composerForm().$('[data-composer-mention-chip="true"]')).toBeDisplayed();
  await sendCurrentComposerPrompt("codex", "@README.md", initialLogLength);
}

async function selectAndSendClaudeDocsSkill(): Promise<void> {
  const initialLogLength = readProviderInputLog(preparedProviderInputLogPath).length;
  await setComposerValue("/doc");
  await waitForComposerItem("provider-skill:claudeAgent:slash:docs");
  await clickVisibleComposerItem("provider-skill:claudeAgent:slash:docs");
  await waitForComposerValue("/docs ");
  await sendCurrentComposerPrompt("claudeAgent", "/docs", initialLogLength);
}

async function openProviderPanelWithStaleMenu(
  current: ProviderScenario,
  next: ProviderScenario,
): Promise<void> {
  await setComposerValue(`/${current.keyboardCommand}`);
  const staleItemId = `provider-command:${current.provider}:${current.keyboardCommand}`;
  await waitForComposerItem(staleItemId);
  await composerEditor().click();
  await browser.keys("ArrowDown");
  await expect(
    browser.$(`[data-composer-item-id="${staleItemId}"][data-composer-item-active="true"]`),
  ).toBeDisplayed();

  await openProviderPanel(next.displayName);
  await waitForComposerValue("");
  await waitForComposerItemsToClose();
  await setComposerValue("/");
  await waitForComposerItem(`provider-command:${next.provider}:${next.keyboardCommand}`);
  expect((await visibleComposerItemIds()).some((id) => id.includes(`:${current.provider}:`))).toBe(
    false,
  );
  await setComposerValue("");
}

async function persistedDraftMatches(
  panelThreadId: string,
  expectedPrompt: string,
): Promise<boolean> {
  return browser.execute(
    (threadId, prompt, draftStorageKey) => {
      const rawStore = window.localStorage.getItem(draftStorageKey);
      if (!rawStore) return false;
      const parsed = JSON.parse(rawStore) as {
        state?: {
          draftsByThreadKey?: Record<string, { prompt?: string }>;
        };
      };
      return Object.entries(parsed.state?.draftsByThreadKey ?? {}).some(
        ([threadKey, draft]) => threadKey.endsWith(`:${threadId}`) && draft.prompt === prompt,
      );
    },
    panelThreadId,
    expectedPrompt,
    composerDraftStorageKey,
  );
}

async function draftSessionPersisted(threadId: string): Promise<boolean> {
  return browser.execute(
    (threadId, draftStorageKey) => {
      const rawStore = window.localStorage.getItem(draftStorageKey);
      if (!rawStore) return false;
      const parsed = JSON.parse(rawStore) as {
        state?: { draftThreadsByThreadKey?: Record<string, { threadId?: string }> };
      };
      return Object.values(parsed.state?.draftThreadsByThreadKey ?? {}).some(
        (draftThread) => draftThread.threadId === threadId,
      );
    },
    threadId,
    composerDraftStorageKey,
  );
}

async function currentThreadId(): Promise<string> {
  const threadId = await browser.execute(() => {
    const match = window.location.hash.match(/\/(?:primary|threads)\/([^/?#]+)/);
    return match?.[1] ? decodeURIComponent(match[1]) : "";
  });
  expect(threadId.length).toBeGreaterThan(0);
  return threadId;
}

/** Opens a new chat in the active project; it lives on the draft route until its first send. */
async function openNewChatFromCommandPalette(): Promise<void> {
  await browser.$('[data-testid="command-palette-trigger"]').click();
  const palette = browser.$('[data-testid="command-palette"]');
  await palette.waitForDisplayed();
  await palette.$("input").addValue("New thread");
  const newThreadInProject = palette.$(
    `.//*[@data-slot="command-item"][starts-with(normalize-space(), "New thread in ${desktopUiFixture.projectName}")]`,
  );
  await newThreadInProject.waitForDisplayed();
  await newThreadInProject.click();
  await browser.waitUntil(isOnDraftRoute, {
    timeoutMsg: "The command palette did not open a new chat.",
  });
  await waitForComposerDisplayed();
  await waitForComposerValue("");
}

interface SendThenTypeResult {
  readonly sent: boolean;
  readonly typed: boolean;
  readonly routeAtTyping: string;
}

/**
 * Clicks Send and types into the cleared composer within one page task, so no WebDriver
 * round trip lets a new chat's route switch happen before the typing starts (#189). It
 * reports the route as it was when typing began.
 */
async function sendThenTypeInOnePageTask(text: string): Promise<SendThenTypeResult> {
  // Only an explicit "Send not live yet" is retried. A script error may come after the click,
  // so it fails the step instead of clicking, and sending, a second time; waitUntil retries a
  // condition that throws, so the error stops the wait and is thrown after it.
  let result = null as SendThenTypeResult | null;
  let pageTaskFailure: unknown = null;
  await browser.waitUntil(
    async () => {
      try {
        result = await browser.execute(async (text: string): Promise<SendThenTypeResult> => {
          const form =
            '[data-center-surface-host][data-visible="true"] [data-chat-composer-form="true"]';
          const send = document.querySelector<HTMLButtonElement>(
            `${form} button[aria-label="Send message"]`,
          );
          if (!send || send.disabled) return { sent: false, typed: false, routeAtTyping: "" };
          send.click();
          const editor = () =>
            document.querySelector<HTMLElement>(`${form} [data-testid="composer-editor"]`);
          // The send clears the composer; wait frames, not WebDriver calls, until it shows that.
          for (let frame = 0; frame < 120 && (editor()?.textContent ?? "") !== ""; frame += 1) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          }
          const target = editor();
          const routeAtTyping = window.location.hash;
          if (!target || (target.textContent ?? "") !== "") {
            return { sent: true, typed: false, routeAtTyping };
          }
          target.focus();
          const range = document.createRange();
          range.selectNodeContents(target);
          range.collapse(false);
          window.getSelection()?.removeAllRanges();
          window.getSelection()?.addRange(range);
          return {
            sent: true,
            typed: document.execCommand("insertText", false, text),
            routeAtTyping,
          };
        }, text);
      } catch (error) {
        pageTaskFailure = error;
        return true;
      }
      return result.sent;
    },
    {
      timeout: 20_000,
      interval: 100,
      timeoutMsg: "The composer's Send button never became available in 20 seconds.",
    },
  );
  if (pageTaskFailure !== null) throw pageTaskFailure;
  if (result === null) throw new Error("The Send-and-type page task never ran.");
  return result;
}

async function providerReceivedPrompt(logBaseline: number, prompt: string): Promise<boolean> {
  return readProviderInputLog(preparedProviderInputLogPath)
    .slice(logBaseline)
    .some((entry) => entry.prompt === prompt);
}

async function openCodeDraftChipsAreValid(): Promise<boolean> {
  const mentionChips = await visibleComposerChipTexts("data-composer-mention-chip");
  const skillChips = await visibleComposerChipTexts("data-composer-skill-chip");
  const agentChips = await visibleComposerChipTexts("data-composer-agent-chip");
  return (
    mentionChips.includes("README.md") && agentChips.includes("reviewer") && skillChips.length === 0
  );
}

async function codexDraftChipsAreValid(): Promise<boolean> {
  const mentionChips = await visibleComposerChipTexts("data-composer-mention-chip");
  const skillChips = await visibleComposerChipTexts("data-composer-skill-chip");
  const agentChips = await visibleComposerChipTexts("data-composer-agent-chip");
  return mentionChips.length === 0 && agentChips.length === 0 && skillChips.includes("Refactor");
}

async function persistProviderDraftsAndRestart(): Promise<void> {
  const hostThreadId = await currentThreadId();
  const persistedThreadSelector =
    '//*[@data-thread-item="true" and .//span[normalize-space()="main"]]';
  const openCodePanelThreadId = await browser.execute((hostThreadId) => {
    const rawStore = window.localStorage.getItem("bibcode:center-panel-state:v1");
    if (!rawStore) return null;
    const parsed = JSON.parse(rawStore) as {
      state?: {
        byThreadKey?: Record<
          string,
          {
            surfaces?: Array<{
              kind?: string;
              providerLabel?: string;
              threadId?: string;
            }>;
          }
        >;
      };
    };
    const hostPanels = Object.entries(parsed.state?.byThreadKey ?? {}).find(([threadKey]) =>
      threadKey.endsWith(`:${hostThreadId}`),
    )?.[1];
    return (
      hostPanels?.surfaces?.find(
        (surface) => surface.kind === "chat" && surface.providerLabel === "OpenCode",
      )?.threadId ?? null
    );
  }, hostThreadId);
  if (!openCodePanelThreadId) {
    throw new Error("The active host did not retain an OpenCode provider panel.");
  }

  const codexPrompt = "$refactor ";
  await activateProviderPanel("Codex");
  await setComposerValue("");
  await appendAndSelectComposerItem("$ref", "provider-skill:codex:dollar:refactor");
  await browser.waitUntil(() => persistedDraftMatches(hostThreadId, codexPrompt), {
    timeoutMsg: "The Codex panel draft was not flushed to storage.",
  });
  await browser.waitUntil(codexDraftChipsAreValid, {
    timeoutMsg: "The Codex dollar skill did not render as a skill chip.",
  });

  const openCodePrompt = "opencode @README.md @reviewer $refactor ";
  await activateProviderPanel("OpenCode");
  await setComposerValue("opencode ");
  await appendAndSelectComposerItem("@README", "file-reference:file:README.md");
  await appendAndSelectComposerItem("@rev", "agent-reference:opencode:reviewer");
  await composerEditor().addValue("$refactor ");
  await browser.waitUntil(() => persistedDraftMatches(openCodePanelThreadId, openCodePrompt), {
    timeoutMsg: "The OpenCode panel draft was not flushed to storage.",
  });
  await browser.waitUntil(openCodeDraftChipsAreValid, {
    timeoutMsg:
      "The OpenCode draft did not render file and agent chips while leaving $refactor plain.",
  });

  await browser.reloadSession();
  await setDesktopUiWindowSize(1_100, 760);
  await expect(browser.$("#root")).toBeDisplayed();
  await ensureMainSidebarOpen();
  const restoredThread = browser.$(persistedThreadSelector);
  await restoredThread.waitForDisplayed();
  await restoredThread.click();
  await waitForComposerDisplayed();

  await activateProviderPanel("OpenCode");
  expect(await persistedDraftMatches(openCodePanelThreadId, openCodePrompt)).toBe(true);
  await browser.waitUntil(openCodeDraftChipsAreValid, {
    timeoutMsg: "The persisted OpenCode file and agent chips were not restored.",
  });
  await browser.saveScreenshot(
    NodePath.join(preparedArtifactDirectory, "composer-restored-chips.png"),
  );

  await activateProviderPanel("Codex");
  expect(await persistedDraftMatches(hostThreadId, codexPrompt)).toBe(true);
  await browser.waitUntil(codexDraftChipsAreValid, {
    timeoutMsg: "The persisted Codex dollar-skill chip was not restored.",
  });
  await browser.saveScreenshot(
    NodePath.join(preparedArtifactDirectory, "composer-restored-codex-skill-chip.png"),
  );
}

function assertCompleteProviderInputLog(composerLogBaseline: number): void {
  const actualProviderInputs = readProviderInputLog(preparedProviderInputLogPath)
    .slice(composerLogBaseline)
    .map(({ provider, prompt }) => ({ provider, prompt }));
  expect(actualProviderInputs).toEqual(expectedProviderInputs);
  expect(actualProviderInputs.some(({ prompt }) => prompt.startsWith(":"))).toBe(false);
}

describe("packaged native composer triggers", () => {
  it("normalizes every ready provider, sends exact native syntax, closes stale menus, and restores chips", async () => {
    const composerLogBaseline = readProviderInputLog(preparedProviderInputLogPath).length;
    await setDesktopUiWindowSize(1_100, 760);
    await ensureFixtureProjectImported();
    await openInitialCodexDraft();

    for (const [index, scenario] of scenarios.entries()) {
      await assertUnifiedModelPicker(scenario);
      await assertColonMenu(scenario.provider);
      await assertSlashMenu(scenario);
      await assertDollarMenu(scenario.provider);
      await assertReferenceMenu(scenario.provider);
      await sendAndAssertNativePrompt(scenario);
      if (scenario.provider === "codex") {
        await selectAndSendReadmeReference();
      }
      if (scenario.provider === "claudeAgent") {
        await selectAndSendClaudeDocsSkill();
      }

      const next = scenarios[index + 1];
      if (next) {
        await openProviderPanelWithStaleMenu(scenario, next);
      }
    }

    assertCompleteProviderInputLog(composerLogBaseline);
    await setComposerValue("/");
    await waitForComposerItem("provider-command:opencode:init");
    await persistProviderDraftsAndRestart();
  });

  it("keeps text typed into a new chat while its first send creates the thread", async () => {
    await ensureFixtureProjectImported();
    await openInitialCodexDraft();
    await openNewChatFromCommandPalette();
    const logBaseline = readProviderInputLog(preparedProviderInputLogPath).length;
    const firstPrompt = "start the new chat";
    const typedDuringSend = "typed while the chat was created";
    await setComposerValue(firstPrompt);

    // Type in the gap between the first send and the thread replacing the draft (#189).
    const { typed, routeAtTyping } = await sendThenTypeInOnePageTask(typedDuringSend);
    if (!typed) throw new Error("The composer did not take text right after the first send.");
    if (!routeAtTyping.includes("/draft/")) {
      throw new Error(
        `Typing began after the new chat's route switch (${routeAtTyping}), so the gap was not exercised.`,
      );
    }

    await browser.waitUntil(() => providerReceivedPrompt(logBaseline, firstPrompt), {
      timeout: 20_000,
      timeoutMsg: "The new chat's first prompt never reached its provider.",
    });
    await waitForDraftRouteToGiveWay();
    // The thread's route retired the draft; the text is the thread's draft, on screen and stored.
    const threadId = await currentThreadId();
    await browser.waitUntil(
      async () =>
        (await persistedDraftMatches(threadId, typedDuringSend)) &&
        !(await draftSessionPersisted(threadId)),
      { timeoutMsg: "Text typed during the first send was not kept as the thread's draft." },
    );
    await waitForComposerValue(typedDuringSend);
    expect(await providerReceivedPrompt(logBaseline, typedDuringSend)).toBe(false);
  });

  it("keeps text typed through a connection drop and sends it only when asked", async () => {
    await ensureFixtureProjectImported();
    await openInitialCodexDraft();
    const threadId = await currentThreadId();
    await installRpcSocketHarness();
    await setComposerValue("");

    // Offline lands between two keystrokes; then the socket is lost and the app retries.
    await typeThroughDropAndSend({
      threadId,
      text: "kept through offline",
      expectedState: "Offline",
      drop: () => dispatchConnectivityEvent("offline"),
      restore: () => dispatchConnectivityEvent("online"),
    });
    // The harness only tracks sockets the app opens after it is installed; the offline
    // round trip above made the one the lost-socket drop closes.
    const opened = await rpcSocketsOpened();
    if (opened === 0) {
      throw new Error(
        "The offline round trip opened no RPC socket through the harness, so there is no tracked socket to lose.",
      );
    }
    await typeThroughDropAndSend({
      threadId,
      text: "kept through a lost socket",
      expectedState: "Reconnecting…",
      drop: closeTrackedRpcSocket,
      restore: async () => {
        await allowRpcSockets();
        await browser.waitUntil(async () => (await rpcSocketsOpened()) > opened, {
          timeout: 30_000,
          timeoutMsg: "The app never reopened its RPC socket after it was lost.",
        });
      },
    });
  });
});

/** How a blocked Send names itself before the state (`formatUnavailableActionLabel`). */
const sendUnavailablePrefix = "Send unavailable. ";

interface TypeThroughDropInput {
  readonly threadId: string;
  readonly text: string;
  /** The connection state the composer banner names while the drop lasts. */
  readonly expectedState: string;
  readonly drop: () => Promise<void>;
  readonly restore: () => Promise<void>;
}

/**
 * Types through a drop, checks that nothing was lost or sent while the environment was away,
 * then sends explicitly and requires exactly one delivery of the whole text (#199).
 */
async function typeThroughDropAndSend(input: TypeThroughDropInput): Promise<void> {
  const logBaseline = readProviderInputLog(preparedProviderInputLogPath).length;
  await composerEditor().click();
  await typeThrough(input.text, 3, input.drop);

  // Every key is on screen at once, and in this thread's own persisted draft after the
  // store's write debounce (300 ms).
  expect(await composerEditor().getText()).toBe(input.text);
  await browser.waitUntil(
    async () => {
      const entries = await readThreadDraftEntries(input.threadId);
      return entries.length === 1 && entries[0]?.prompt === input.text;
    },
    { timeout: 5_000, timeoutMsg: "The text typed through the drop was not persisted." },
  );

  // Send is blocked yet focusable (aria-disabled), still names itself, and names the state the
  // banner shows.
  const sendLabel = await browser.waitUntil(
    () =>
      browser.execute(
        (expectedState: string, prefix: string) => {
          const send = document.querySelector<HTMLButtonElement>(
            '[data-center-surface-host][data-visible="true"] [data-chat-composer-form="true"] button[type="submit"]',
          );
          const label = send?.getAttribute("aria-label") ?? "";
          return send?.getAttribute("aria-disabled") === "true" &&
            !send.disabled &&
            label.startsWith(prefix) &&
            label.endsWith(`: ${expectedState}`)
            ? label
            : false;
        },
        input.expectedState,
        sendUnavailablePrefix,
      ),
    { timeout: 10_000, timeoutMsg: `Send did not name the ${input.expectedState} state.` },
  );
  // Enter is refused with the banner's words, and the draft and focus stay. The state can
  // move on between reading the label and the toast (a retry, say), so the toast is matched
  // by the environment's name, which every state's title starts with.
  expect(sendLabel.startsWith(sendUnavailablePrefix)).toBe(true);
  const environmentPrefix = `${sendLabel.slice(sendUnavailablePrefix.length).split(": ")[0]}: `;
  await browser.keys("Enter");
  await browser.waitUntil(
    () =>
      browser.execute(
        (prefix: string) =>
          [...document.querySelectorAll<HTMLElement>('[data-slot="toast-title"]')].some(
            (title) => title.textContent?.startsWith(prefix) === true,
          ),
        environmentPrefix,
      ),
    { timeout: 5_000, timeoutMsg: "Enter while disconnected did not say why it was refused." },
  );
  expect(await composerEditor().getText()).toBe(input.text);
  expect(
    await browser.execute(
      () => (document.activeElement as HTMLElement | null)?.dataset.testid ?? null,
    ),
  ).toBe("composer-editor");

  await input.restore();
  await browser.waitUntil(
    () =>
      browser.execute(() => {
        const send = document.querySelector<HTMLButtonElement>(
          '[data-center-surface-host][data-visible="true"] [data-chat-composer-form="true"] button[aria-label="Send message"]',
        );
        return send !== null && !send.disabled;
      }),
    { timeout: 30_000, timeoutMsg: "Send did not come back after the connection returned." },
  );
  // Reconnecting keeps the text and does not send it.
  expect(await composerEditor().getText()).toBe(input.text);
  expect(readProviderInputLog(preparedProviderInputLogPath).slice(logBaseline)).toEqual([]);

  // The settle is the real "nothing was sent on its own" proof: the wait fails on a second
  // appended input (a resend on reconnect would be one) at any point in its 1.5 s settle, and
  // the check above only covers the moment before this Send.
  await clickSendWhenLive();
  await waitForProviderInputLogEntry(
    preparedProviderInputLogPath,
    logBaseline,
    { provider: "codex", prompt: input.text },
    { timeoutMs: 20_000, settleMs: 1_500 },
  );
  await waitForComposerValue("");
}
