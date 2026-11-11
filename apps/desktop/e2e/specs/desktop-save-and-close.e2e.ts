// @effect-diagnostics nodeBuiltinImport:off - Packaged UI tests write disposable fixture files and read them back.
// @effect-diagnostics globalFetch:off - The spec checks that the stopped server no longer answers.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  chooseDesktopUiQuit,
  desktopUiApplicationPid,
  desktopUiListeningPorts,
  desktopUiPlatform,
  isDesktopUiApplicationRunning,
  isProcessAlive,
  relaunchDesktopUiApplication,
  requestDesktopUiWindowClose,
  waitForDesktopUiApplicationExit,
} from "../support/app-lifecycle.ts";
import { desktopUiFixture } from "../support/test-project.ts";
import {
  ensureMainSidebarOpen,
  mockDesktopUiFolderPicker,
  setDesktopUiWindowSize,
} from "../support/ui-state.ts";

const projectPath = process.env.BIBCODE_E2E_PROJECT_PATH;
const savedTextPath = process.env.BIBCODE_E2E_SAVE_TEXT_PATH;
if (!projectPath || !savedTextPath) {
  throw new Error("The packaged desktop save-and-close fixture environment was not prepared.");
}
const preparedProjectPath: string = projectPath;
const preparedSavedTextPath: string = savedTextPath;
const fileViewSelector = "[data-preview-panel-mode]";
const richEditorSelector = `${fileViewSelector} .rich-markdown-editor [contenteditable="true"]`;
const leaveDialogSelector =
  '//*[@role="alertdialog"][.//*[starts-with(normalize-space(), "Save your changes before")]]';
const originalContents = "# Close fixture\n\nHello world\n";
/** The close, quit and exit checks wait at most this long for the app to end. */
const EXIT_TIMEOUT_MS = 15_000;

function writeFixture(fileName: string): string {
  const path = NodePath.join(preparedProjectPath, fileName);
  NodeFS.writeFileSync(path, originalContents);
  return path;
}

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
}

async function openFilesSurface(): Promise<void> {
  const rightPanel = browser.$("[data-right-panel-tabbar]");
  if (!(await rightPanel.isDisplayed())) {
    const toggle = browser.$('button[aria-label^="Toggle right panel"]');
    await toggle.waitForDisplayed();
    await toggle.click();
    await rightPanel.waitForDisplayed();
  }
  const existingTab = browser.$(
    '//*[@data-right-panel-tab-list]//button[normalize-space()="Files"]',
  );
  if (await existingTab.isDisplayed()) {
    await existingTab.click();
    return;
  }
  const emptyStateAction = browser.$(
    '//button[.//span[normalize-space()="Files"] and not(@aria-disabled="true")]',
  );
  if (await emptyStateAction.isDisplayed()) {
    await emptyStateAction.click();
    return;
  }
  const addSurface = browser.$('button[aria-label="Add panel surface"]');
  await addSurface.waitForDisplayed();
  await addSurface.click();
  const menuItem = browser.$('//*[@role="menuitem" and normalize-space()="Files"]');
  await menuItem.waitForDisplayed();
  await menuItem.click();
}

async function openWorkspaceFile(fileName: string): Promise<void> {
  const treeHostSelector = `${fileViewSelector} file-tree-container`;
  const itemSelector = `[role="treeitem"][data-item-path="${fileName}"]`;
  await browser.waitUntil(
    () =>
      browser.execute(
        (hostQuery: string, targetQuery: string) => {
          const host = [...document.querySelectorAll<HTMLElement>(hostQuery)].find(
            (candidate) => candidate.getBoundingClientRect().height > 0,
          );
          const target = host?.shadowRoot?.querySelector<HTMLElement>(targetQuery);
          if (!target) return false;
          target.click();
          return true;
        },
        treeHostSelector,
        itemSelector,
      ),
    { timeoutMsg: `The Files tree did not list ${fileName}.` },
  );
  await browser.waitUntil(
    () =>
      browser.execute(
        (editorQuery: string) =>
          [...document.querySelectorAll(editorQuery)].some((editor) =>
            editor.textContent?.includes("Hello world"),
          ),
        richEditorSelector,
      ),
    { timeoutMsg: `The rendered Markdown view did not show ${fileName} as editable.` },
  );
}

/** Opens `fileName` in the rendered view and types an edit that is not saved. */
async function leaveUnsavedEdit(fileName: string): Promise<void> {
  await setDesktopUiWindowSize(1_200, 720);
  await openFixtureWorkspace();
  await openFilesSurface();
  await openWorkspaceFile(fileName);
  await browser.execute((editorQuery: string) => {
    const editor = document.querySelector<HTMLElement>(editorQuery);
    const paragraph = [...(editor?.querySelectorAll("p") ?? [])].find(
      (candidate) => candidate.textContent === "Hello world",
    );
    if (!editor || !paragraph) throw new Error("The fixture paragraph is missing.");
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    range.collapse(false);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  }, richEditorSelector);
  const editor = await browser.$(richEditorSelector);
  await editor.addValue(" edited");
  await browser.waitUntil(
    async () =>
      (await browser.$("[data-file-editor-toolbar] [aria-live='polite']").getText()) ===
      "Unsaved changes",
    { timeoutMsg: "The edit never showed as unsaved." },
  );
}

async function leaveDialogButton(label: string) {
  const button = await browser.$(`${leaveDialogSelector}//button[normalize-space()="${label}"]`);
  await button.waitForDisplayed();
  return button;
}

async function waitForLeaveDialog(fileName: string): Promise<void> {
  const dialog = browser.$(leaveDialogSelector);
  await dialog.waitForDisplayed({ timeoutMsg: "The close request never showed the leave dialog." });
  await expect(dialog).toHaveText(expect.stringContaining(fileName));
}

async function focusedElement(): Promise<string> {
  return browser.execute(() => {
    const active = document.activeElement;
    return `${active?.tagName ?? "none"} "${active?.textContent?.slice(0, 40) ?? ""}" in ${
      active?.closest("[role]")?.getAttribute("role") ?? "page"
    }`;
  });
}

function skipUnlessMac(context: Mocha.Context): void {
  // Native close and quit go through the macOS menu bar; other systems have no driver for it.
  if (desktopUiPlatform() !== "mac") context.skip();
}

describe("packaged desktop export and the close dialog", () => {
  afterEach(async () => {
    // Each closing case runs in its own app session.
    if (!(await isDesktopUiApplicationRunning())) await relaunchDesktopUiApplication();
  });

  it("exports a custom theme through the real save command", async () => {
    NodeFS.rmSync(preparedSavedTextPath, { force: true });
    await browser.execute(() => {
      window.location.hash = "#/settings/appearance";
    });
    await (await browser.$("button=New theme")).click();
    await (await browser.$('input[name="theme-base"][value="dark"]')).click();
    await (await browser.$('input[name="theme-name"]')).setValue("Export Fixture");
    await (await browser.$("button=Create theme")).click();
    const save = await browser.$('//*[@data-theme-editor]//button[normalize-space()="Save"]');
    await save.scrollIntoView();
    await save.click();
    const more = await browser.$('button[aria-label="More actions for Export Fixture"]');
    await more.scrollIntoView();
    await more.click();
    const exportItem = await browser.$('//*[@role="menuitem" and normalize-space()="Export"]');
    await exportItem.waitForDisplayed();
    await exportItem.click();

    await browser.waitUntil(() => NodeFS.existsSync(preparedSavedTextPath), {
      timeoutMsg: "Export never wrote the file through saveTextFile.",
    });
    const exported = JSON.parse(NodeFS.readFileSync(preparedSavedTextPath, "utf8")) as {
      readonly version: number;
      readonly id: string;
      readonly name: string;
      readonly base: string;
    };
    expect(exported).toMatchObject({
      version: 1,
      id: "export-fixture",
      name: "Export Fixture",
      base: "dark",
    });
  });

  it("the leave dialog takes focus over the update dialog and Cancel returns it", async () => {
    writeFixture("close-update.md");
    await leaveUnsavedEdit("close-update.md");
    // No install may start: the e2e updater is disabled, and the install command is mocked.
    const install = await browser.tauri.mock("desktop_bridge_install_update");
    await install.mockImplementation(() => {
      throw new Error("The packaged test never installs an update.");
    });
    await browser.execute(async () => {
      const tauri = (
        window as unknown as {
          __TAURI__: { event: { emit: (event: string, payload: unknown) => Promise<void> } };
        }
      ).__TAURI__;
      await tauri.event.emit("desktop:update-state", {
        enabled: true,
        status: "downloaded",
        currentVersion: "0.0.1",
        hostArch: "arm64",
        appArch: "arm64",
        runningUnderArm64Translation: false,
        availableVersion: "99.0.0",
        downloadedVersion: "99.0.0",
        downloadPercent: null,
        checkedAt: null,
        message: null,
        errorContext: null,
        canRetry: false,
        requestedBy: null,
      });
    });
    const pill = await browser.$("button.update-main");
    await pill.waitForDisplayed({ timeoutMsg: "The injected update state showed no update." });
    await pill.click();
    const updateDialog = browser.$(
      '//*[@role="dialog"][.//*[normalize-space()="Protect projects before updating"]]',
    );
    await updateDialog.waitForDisplayed();
    const installButton = await browser.$(
      '//*[@role="dialog"]//button[normalize-space()="Protect projects and install"]',
    );
    // Focused in the page, not by the driver's click: a driver click need not move focus, and the
    // question returns focus to the element that had it when it opened.
    await browser.execute((button: HTMLElement) => {
      button.focus();
      button.click();
    }, installButton);

    await waitForLeaveDialog("close-update.md");
    await browser
      .waitUntil(() =>
        browser.execute(
          () =>
            document.activeElement?.closest('[role="alertdialog"]') !== null &&
            document.activeElement?.textContent === "Save all",
        ),
      )
      .catch(async () => {
        throw new Error(
          `The leave dialog did not take focus over the update dialog (focus: ${await focusedElement()}).`,
        );
      });
    await (await leaveDialogButton("Cancel")).click();
    await browser.$(leaveDialogSelector).waitForDisplayed({ reverse: true });
    await browser.waitUntil(
      () =>
        browser.execute((button: HTMLElement) => document.activeElement === button, installButton),
      { timeoutMsg: "Cancel did not return focus to the button that asked." },
    );
    await expect(updateDialog).toBeDisplayed();
    await expect(browser.$("[data-file-editor-toolbar] [aria-live='polite']")).toHaveText(
      "Unsaved changes",
    );
  });

  it("Cancel keeps the window, the server and the edit, and Save all saves and exits", async function () {
    skipUnlessMac(this);
    const path = writeFixture("close-save.md");
    await leaveUnsavedEdit("close-save.md");
    const pid = desktopUiApplicationPid();
    const ports = desktopUiListeningPorts(pid);

    await requestDesktopUiWindowClose();
    await waitForLeaveDialog("close-save.md");
    await (await leaveDialogButton("Cancel")).click();
    await browser.$(leaveDialogSelector).waitForDisplayed({ reverse: true });
    expect(isProcessAlive(pid)).toBe(true);
    expect(desktopUiListeningPorts(pid)).toEqual(ports);
    await expect(browser.$(richEditorSelector)).toHaveText(
      expect.stringContaining("Hello world edited"),
    );
    await expect(browser.$("[data-file-editor-toolbar] [aria-live='polite']")).toHaveText(
      "Unsaved changes",
    );
    expect(NodeFS.readFileSync(path, "utf8")).toBe(originalContents);

    await requestDesktopUiWindowClose();
    await waitForLeaveDialog("close-save.md");
    await (await leaveDialogButton("Save all")).click();
    await waitForDesktopUiApplicationExit(pid, EXIT_TIMEOUT_MS);
    expect(NodeFS.readFileSync(path, "utf8")).toBe("# Close fixture\n\nHello world edited\n");
  });

  it("Discard exits and leaves the file on disk unchanged", async function () {
    skipUnlessMac(this);
    const path = writeFixture("close-discard.md");
    await leaveUnsavedEdit("close-discard.md");
    const pid = desktopUiApplicationPid();

    await requestDesktopUiWindowClose();
    await waitForLeaveDialog("close-discard.md");
    await (await leaveDialogButton("Discard")).click();
    await waitForDesktopUiApplicationExit(pid, EXIT_TIMEOUT_MS);
    expect(NodeFS.readFileSync(path, "utf8")).toBe(originalContents);
  });

  it("Quit from the menu with nothing unsaved exits promptly and stops the server", async function () {
    skipUnlessMac(this);
    await openFixtureWorkspace();
    const pid = desktopUiApplicationPid();
    const ports = desktopUiListeningPorts(pid);
    expect(ports.length).toBeGreaterThan(1);

    await chooseDesktopUiQuit();
    const elapsed = await waitForDesktopUiApplicationExit(pid, EXIT_TIMEOUT_MS);
    expect(elapsed).toBeLessThan(5_000);
    expect(desktopUiListeningPorts(pid)).toEqual([]);
    for (const port of ports) {
      await expect(
        fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) }),
      ).rejects.toThrow();
    }
  });

  it("with nothing unsaved, a close exits at once", async function () {
    skipUnlessMac(this);
    await openFixtureWorkspace();
    const pid = desktopUiApplicationPid();

    await requestDesktopUiWindowClose();
    const elapsed = await waitForDesktopUiApplicationExit(pid, EXIT_TIMEOUT_MS);
    expect(elapsed).toBeLessThan(5_000);
  });
});
