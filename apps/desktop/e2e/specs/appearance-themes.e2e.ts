import { refreshDesktopUiDocument } from "../support/document-navigation.ts";
import { desktopUiFixture } from "../support/test-project.ts";
import { ensureMainSidebarOpen, mockDesktopUiFolderPicker } from "../support/ui-state.ts";

const projectPath = process.env.BIBCODE_E2E_PROJECT_PATH;
if (!projectPath) {
  throw new Error("The packaged desktop themes fixture environment was not prepared.");
}
const preparedProjectPath: string = projectPath;
const visibleSurfaceSelector = '[data-center-surface-host][data-visible="true"]';
const composerEditorSelector = `${visibleSurfaceSelector} [data-chat-composer-form="true"] [data-testid="composer-editor"]`;

type Mode = "System" | "Light" | "Dark";

async function openFixtureWorkspace(): Promise<void> {
  // Settings shows its own sidebar; the project list is on the app's start route.
  await browser.execute(() => {
    if (window.location.hash.startsWith("#/settings")) window.location.hash = "#/";
  });
  await ensureMainSidebarOpen();
  const project = browser.$(
    `//button[.//span[normalize-space()="${desktopUiFixture.projectName}"]]`,
  );
  if (!(await project.isDisplayed())) {
    const projectDataLoading = browser.$("//*[normalize-space()='Project data is still loading']");
    if (await projectDataLoading.isExisting()) {
      await projectDataLoading.waitForDisplayed({ reverse: true });
    }
    const addProject = browser.$('[data-testid="sidebar-add-project-trigger"]');
    await addProject.waitForDisplayed();
    await addProject.click();
    const browseFolder = browser.$(
      "//button[@data-add-project-action='true'][.//span[normalize-space()='Browse folder']]",
    );
    await browseFolder.waitForDisplayed();
    await mockDesktopUiFolderPicker(preparedProjectPath);
    await browseFolder.click();
  }
  await project.waitForDisplayed();
  const primaryWorkspace = browser.$(
    '//*[@data-thread-item="true"][.//span[normalize-space()="main"]]',
  );
  if ((await project.getAttribute("aria-expanded")) !== "true") {
    await project.click();
  }
  await primaryWorkspace.waitForDisplayed();
  await primaryWorkspace.click();
  await browser.$(composerEditorSelector).waitForDisplayed();
}

async function openAppearance(): Promise<void> {
  await browser.execute(() => {
    window.location.hash = "#/settings/appearance";
  });
  await browser.$('[role="group"][aria-label="Mode"]').waitForDisplayed();
}

async function setMode(mode: Mode): Promise<void> {
  const button = await browser.$(
    `//*[@role="group" and @aria-label="Mode"]//button[normalize-space()="${mode}"]`,
  );
  await button.scrollIntoView();
  await button.click();
  await waitForMode(mode);
}

async function waitForMode(mode: Mode): Promise<void> {
  await browser.waitUntil(
    async () =>
      (await browser
        .$(`//*[@role="group" and @aria-label="Mode"]//button[normalize-space()="${mode}"]`)
        .getAttribute("aria-pressed")) === "true",
    { timeoutMsg: `The Mode group never showed ${mode} as pressed.` },
  );
}

function themeRow(name: string): ReturnType<typeof browser.$> {
  return browser.$(
    `//li[@data-theme-row]/button[@data-theme-select][.//span[normalize-space()="${name}"]]`,
  );
}

async function selectTheme(name: string): Promise<void> {
  const row = await themeRow(name);
  await row.scrollIntoView();
  await row.click();
  await browser.waitUntil(
    async () => (await themeRow(name).getAttribute("aria-pressed")) === "true",
    {
      timeoutMsg: `The ${name} row never showed as in use.`,
    },
  );
}

async function chooseRowAction(themeName: string, action: string): Promise<void> {
  const more = await browser.$(`button[aria-label="More actions for ${themeName}"]`);
  await more.scrollIntoView();
  await more.click();
  const item = await browser.$(`//*[@role="menuitem" and normalize-space()="${action}"]`);
  await item.waitForDisplayed();
  await item.click();
}

async function rootToken(name: string): Promise<string> {
  return browser.execute(
    (property: string) =>
      getComputedStyle(document.documentElement).getPropertyValue(property).trim(),
    name,
  );
}

async function waitForRootToken(name: string, value: string): Promise<void> {
  await browser.waitUntil(async () => (await rootToken(name)) === value, {
    timeoutMsg: `The root ${name} never became ${value} (last ${await rootToken(name)}).`,
  });
}

async function rootIsDark(): Promise<boolean> {
  return browser.execute(() => document.documentElement.classList.contains("dark"));
}

async function themeField(token: string) {
  const input = await browser.$(`[data-theme-field="ui.${token}"] input:not([type="color"])`);
  await input.scrollIntoView();
  return input;
}

async function editorButton(label: string) {
  const button = await browser.$(`//*[@data-theme-editor]//button[normalize-space()="${label}"]`);
  await button.scrollIntoView();
  return button;
}

async function sidebarLevels(): Promise<{ repo: boolean; checkout: boolean; chat: boolean }> {
  return browser.execute(() => ({
    repo: document.querySelector('[data-sidebar-level="repo"]') !== null,
    checkout: document.querySelector('[data-sidebar-level="checkout"][data-primary]') !== null,
    chat: document.querySelector('[data-sidebar-level="chat"]') !== null,
  }));
}

/**
 * A chat level row shows for another chat panel in a checkout ("1 more chat") or a worktree row.
 * A fresh fixture has neither, so open a chat panel in the primary checkout and send to it.
 */
async function ensureChatLevelRow(): Promise<void> {
  if ((await sidebarLevels()).chat) return;
  const newPanel = await browser.$('button[aria-label="New panel"]');
  await newPanel.waitForEnabled();
  await newPanel.click();
  // Exist, not displayed: a menu's opening transition ends on an animation frame, and an
  // occluded macOS webview may run none.
  const codex = await browser.$('//*[@role="menuitem"][.//span[normalize-space()="Codex"]]');
  await codex.waitForExist();
  await browser.execute((item: HTMLElement) => item.click(), codex);
  await browser.$('button[aria-label="Close Codex"]').waitForExist();
  const editor = browser.$(composerEditorSelector);
  await editor.waitForDisplayed();
  await editor.click();
  await editor.addValue("Second fixture chat");
  await expect(editor).toHaveText("Second fixture chat");
  await browser.keys("Enter");
  await browser.waitUntil(async () => (await sidebarLevels()).chat, {
    timeoutMsg: "The sidebar never showed a chat level row.",
  });
}

async function expectSidebarLevels(): Promise<void> {
  await browser.waitUntil(
    async () => {
      const levels = await sidebarLevels();
      return levels.repo && levels.checkout && levels.chat;
    },
    {
      timeoutMsg: `The sidebar levels are not all marked: ${JSON.stringify(await sidebarLevels())}`,
    },
  );
}

describe("packaged appearance themes", () => {
  it("the left panel marks its levels", async () => {
    await openAppearance();
    await setMode("Light");
    await openFixtureWorkspace();
    await ensureChatLevelRow();
    expect(await rootIsDark()).toBe(false);
    await expectSidebarLevels();

    await openAppearance();
    await setMode("Dark");
    await selectTheme("Tokyo Night");
    await waitForRootToken("--background", "#1a1b26");
    await openFixtureWorkspace();
    expect(await rootIsDark()).toBe(true);
    await expectSidebarLevels();
  });

  it("a dark theme row clicked in Light mode switches to Dark, and Undo restores Light", async () => {
    await openAppearance();
    await setMode("Light");
    expect(await themeRow("Dark").getAttribute("aria-pressed")).toBe("true");

    await (await themeRow("Matrix Dark")).click();
    await waitForMode("Dark");
    expect(await rootIsDark()).toBe(true);
    const undo = await browser.$(
      '//*[@role="group" and @aria-label="Dark themes"]//*[@role="status"]//button[normalize-space()="Undo"]',
    );
    await undo.waitForDisplayed();
    await expect(
      browser.$('//*[@role="group" and @aria-label="Dark themes"]//*[@role="status"]'),
    ).toHaveText(expect.stringContaining("Switched to dark mode to show Matrix Dark."));

    await undo.click();
    await waitForMode("Light");
    expect(await rootIsDark()).toBe(false);
    expect(await themeRow("Dark").getAttribute("aria-pressed")).toBe("true");
    expect(await themeRow("Matrix Dark").getAttribute("aria-pressed")).toBe("false");
  });

  it("Tokyo Night repaints the app and Dark restores it", async () => {
    await openAppearance();
    await setMode("Dark");
    await selectTheme("Tokyo Night");
    await waitForRootToken("--background", "#1a1b26");

    await selectTheme("Dark");
    await browser.waitUntil(
      () =>
        browser.execute(
          () => document.documentElement.style.getPropertyValue("--background") === "",
        ),
      { timeoutMsg: "Dark left an inline --background on the root element." },
    );
    expect(await rootToken("--background")).not.toBe("#1a1b26");
  });

  it("a duplicated theme can be edited with live preview and cancelled", async () => {
    await openAppearance();
    await setMode("Dark");
    await chooseRowAction("Tokyo Night", "Duplicate");
    await themeRow("Tokyo Night copy").waitForDisplayed();
    await selectTheme("Tokyo Night copy");
    await waitForRootToken("--primary", "#7aa2f7");

    await chooseRowAction("Tokyo Night copy", "Edit");
    await browser.$('[data-theme-editor][aria-label="Edit Tokyo Night copy"]').waitForDisplayed();
    const primary = await themeField("primary");
    await primary.setValue("#ff0000");
    await waitForRootToken("--primary", "#ff0000");

    await (await editorButton("Cancel")).click();
    await themeRow("Tokyo Night copy").waitForDisplayed();
    await waitForRootToken("--primary", "#7aa2f7");
  });

  it("a saved custom theme is painted again after a reload", async () => {
    await openAppearance();
    await setMode("Dark");
    await (await browser.$("button=New theme")).click();
    await (await browser.$('input[name="theme-base"][value="dark"]')).click();
    await (await browser.$('input[name="theme-name"]')).setValue("Fixture Dark");
    await (await browser.$("button=Create theme")).click();
    await browser.$('[data-theme-editor][aria-label="Edit Fixture Dark"]').waitForDisplayed();
    await (await themeField("background")).setValue("#101820");
    await (await editorButton("Save")).click();

    await selectTheme("Fixture Dark");
    await waitForRootToken("--background", "#101820");

    await refreshDesktopUiDocument();
    await waitForRootToken("--background", "#101820");
    expect(await rootIsDark()).toBe(true);
  });
});
