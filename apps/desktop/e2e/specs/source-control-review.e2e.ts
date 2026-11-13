// @effect-diagnostics nodeBuiltinImport:off - Packaged review tests edit the fixture checkout, read fixture logs and save screenshots.
// @effect-diagnostics globalDate:off - The standalone WDIO spec waits on a host-side fixture file.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { refreshDesktopUiDocument } from "../support/document-navigation.ts";
import { readProviderInputLog } from "../support/provider-input-log.ts";
import { desktopUiFixture } from "../support/test-project.ts";
import {
  ensureMainSidebarOpen,
  mockDesktopUiFolderPicker,
  setDesktopUiWindowSize,
} from "../support/ui-state.ts";

/**
 * Review changes in Source Control (#293, R101): a review opens as a chat panel of the current
 * thread whose first message is the review prompt, and a review that ends in a plan offers no
 * Implement, before and after a reload. The second case is the one the `codeReview` flag
 * decides: without it the same plan offers Implement and an empty Enter implements it.
 */

const artifactDirectory = process.env.BIBCODE_E2E_ARTIFACT_DIR;
const projectPath = process.env.BIBCODE_E2E_PROJECT_PATH;
const providerInputLogPath = process.env.BIBCODE_E2E_PROVIDER_INPUT_LOG;
if (!artifactDirectory || !projectPath || !providerInputLogPath) {
  throw new Error("The packaged desktop review fixture environment was not prepared.");
}
const preparedArtifactDirectory: string = artifactDirectory;
const preparedProjectPath: string = projectPath;
const preparedProviderInputLogPath: string = providerInputLogPath;
const visibleSurfaceSelector = '[data-center-surface-host][data-visible="true"]';
const visibleComposerFormSelector = `${visibleSurfaceSelector} [data-chat-composer-form="true"]`;
const UNCOMMITTED_SCOPE = "Scope: the staged, unstaged and untracked changes in the working tree";
const REVIEW_LEAD_IN = "Code review requested from BiBCode.";

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
  if (await hasVisibleProject()) return;

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

async function openPrimaryThread(): Promise<void> {
  const projectSelector = `//button[@data-sidebar="menu-button"][.//span[normalize-space()="${desktopUiFixture.projectName}"]]`;
  const primaryWorkspace = browser.$(
    '//*[@data-thread-item="true"][.//span[normalize-space()="main"]]',
  );
  if (!(await primaryWorkspace.isDisplayed())) {
    for (const project of await browser.$$(projectSelector)) {
      if (await project.isDisplayed()) {
        await project.click();
        break;
      }
    }
    await primaryWorkspace.waitForDisplayed();
  }
  await primaryWorkspace.click();
  await waitForComposerDisplayed();
}

async function replaceComposerText(text: string): Promise<void> {
  const editor = composerEditor();
  await editor.click();
  await browser.execute(() => {
    const editor = document.activeElement;
    if (!(editor instanceof HTMLElement) || editor.dataset.testid !== "composer-editor") {
      throw new Error("The composer editor did not receive focus.");
    }
    const range = document.createRange();
    range.selectNodeContents(editor);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await browser.keys("Backspace");
  if (text.length > 0) await editor.addValue(text);
  await expect(composerEditor()).toHaveText(text);
}

/** A draft has no panel host, so the thread gets a first message and becomes a server thread. */
async function sendFirstMessage(): Promise<void> {
  const baseline = readProviderInputLog(preparedProviderInputLogPath).length;
  const prompt = "get ready for a review";
  await replaceComposerText(prompt);
  await browser.keys("Enter");
  await browser.waitUntil(
    () =>
      readProviderInputLog(preparedProviderInputLogPath)
        .slice(baseline)
        .some((entry) => entry.kind === "start" && entry.prompt === prompt),
    { timeoutMsg: "The primary thread's first message did not reach its provider." },
  );
  await expect(browser.$(visibleSurfaceSelector)).toHaveText(
    expect.stringContaining(desktopUiFixture.streamedResponse),
  );
}

/** One tracked file differs from HEAD, so the review scope is the uncommitted changes. */
function modifyTrackedFile(): void {
  NodeFS.appendFileSync(
    NodePath.join(preparedProjectPath, "README.md"),
    `\nReview fixture change ${Date.now()}.\n`,
  );
}

async function openSourceControl(): Promise<void> {
  const rightPanel = browser.$("[data-right-panel-tabbar]");
  if (!(await rightPanel.isDisplayed())) {
    const toggle = browser.$('button[aria-label^="Toggle right panel"]');
    await toggle.waitForDisplayed();
    await toggle.click();
    await rightPanel.waitForDisplayed();
  }
  const existingTab = browser.$(
    '//*[@data-right-panel-tab-list]//button[normalize-space()="Source Control"]',
  );
  if (await existingTab.isDisplayed()) {
    await existingTab.click();
  } else {
    const emptyStateAction = browser.$(
      '//button[.//span[normalize-space()="Source Control"] and not(@aria-disabled="true")]',
    );
    if (await emptyStateAction.isDisplayed()) {
      await emptyStateAction.click();
    } else {
      const addSurface = browser.$('button[aria-label="Add panel surface"]');
      await addSurface.waitForDisplayed();
      await addSurface.click();
      const menuItem = browser.$('//*[@role="menuitem" and normalize-space()="Source Control"]');
      await menuItem.waitForExist();
      await browser.execute((item: HTMLElement) => item.click(), await menuItem);
    }
  }
  // Enabled once the status sees the modified file and the thread can host a panel.
  await browser.$('button[aria-label="Review changes"][aria-disabled="false"]').waitForDisplayed({
    timeout: 30_000,
    timeoutMsg: "Review changes did not become enabled for the modified fixture checkout.",
  });
}

function reviewTab(provider: string) {
  return browser.$(`//button[@role="tab"][.//span[normalize-space()="Code review · ${provider}"]]`);
}

async function waitForReviewStart(provider: "codex" | "claudeAgent", baseline: number) {
  let prompt: string | undefined;
  await browser.waitUntil(
    () => {
      prompt = readProviderInputLog(preparedProviderInputLogPath)
        .slice(baseline)
        .find(
          (entry) =>
            entry.provider === provider &&
            entry.kind === "start" &&
            entry.prompt.startsWith(REVIEW_LEAD_IN),
        )?.prompt;
      return prompt !== undefined;
    },
    { timeoutMsg: `The review's first message did not reach ${provider}.` },
  );
  return prompt!;
}

/** No Implement, Refine or "Implement in a new thread", and an empty Enter sends nothing. */
async function expectNoImplementActions(): Promise<void> {
  const surface = () => browser.$(visibleSurfaceSelector);
  await expect(surface().$('[data-chat-composer-implement-actions="true"]')).not.toExist();
  await expect(surface().$('button[aria-label^="Implementation actions"]')).not.toExist();
  await expect(surface().$('//button[normalize-space()="Implement"]')).not.toExist();
  await expect(surface()).not.toHaveText(expect.stringContaining("Implement in a new thread"));

  // Refine replaces Implement once the composer holds text.
  await replaceComposerText("tighten the wording");
  await expect(surface().$('//button[normalize-space()="Refine"]')).not.toExist();
  await replaceComposerText("");

  const before = readProviderInputLog(preparedProviderInputLogPath).length;
  await composerEditor().click();
  await browser.keys("Enter");
  // Nothing to wait for when nothing is sent: give a send time to reach the provider.
  await browser.pause(2_000);
  expect(readProviderInputLog(preparedProviderInputLogPath).length).toBe(before);
  await expect(composerEditor()).toHaveText("");
}

async function expectReviewFindings(): Promise<void> {
  // The plan card's text first, so a missing flag fails at the Implement check below.
  await expect(browser.$(visibleSurfaceSelector)).toHaveText(
    expect.stringContaining(desktopUiFixture.codeReviewFinding),
    { wait: 30_000 },
  );
  await expectNoImplementActions();
  await expect(browser.$(visibleSurfaceSelector)).toHaveText(
    expect.stringContaining("Review findings"),
  );
}

// Each test sets itself up: the harness resets the connection catalog and reloads the document
// before each one.
describe("packaged Source Control review", () => {
  it("opens a Codex review panel whose first message is the review prompt", async () => {
    await setDesktopUiWindowSize(1_280, 900);
    await ensureFixtureProjectImported();
    await openPrimaryThread();
    await sendFirstMessage();
    modifyTrackedFile();
    await openSourceControl();

    const baseline = readProviderInputLog(preparedProviderInputLogPath).length;
    // The saved reviewer is the default, chat Codex.
    await browser.$('button[aria-label="Review changes"]').click();
    const tab = reviewTab("Codex");
    await tab.waitForDisplayed({ timeoutMsg: "The Codex review tab did not open." });
    const prompt = await waitForReviewStart("codex", baseline);
    expect(prompt).toContain(UNCOMMITTED_SCOPE);

    // The review starts supervised (approval required), the Codex read-only sandbox.
    await waitForComposerDisplayed();
    await expect(composerForm().$('[aria-label="Supervised"]')).toExist();
    await browser.saveScreenshot(
      NodePath.join(preparedArtifactDirectory, "review-codex-panel.png"),
    );
  });

  it("shows a Claude review's plan as Review findings with no Implement, also after a reload", async () => {
    await setDesktopUiWindowSize(1_280, 900);
    await ensureFixtureProjectImported();
    await openPrimaryThread();
    await sendFirstMessage();
    modifyTrackedFile();
    await openSourceControl();

    // A one-off Claude chat review from the review menu; the saved reviewer stays chat Codex.
    const baseline = readProviderInputLog(preparedProviderInputLogPath).length;
    await browser.$('button[aria-label="Review options"]').click();
    const claude = browser.$(
      '//*[@role="menuitem"][.//span[normalize-space()="Claude"]][not(@aria-disabled="true")]',
    );
    await claude.waitForExist();
    await browser.execute((item: HTMLElement) => item.click(), await claude);
    await reviewTab("Claude").waitForDisplayed({
      timeoutMsg: "The Claude review tab did not open.",
    });
    const prompt = await waitForReviewStart("claudeAgent", baseline);
    expect(prompt).toContain(UNCOMMITTED_SCOPE);
    await waitForComposerDisplayed();
    // Claude reviews start in plan mode.
    await expect(composerForm().$('button[aria-label="Disable plan mode"]')).toExist();

    await expectReviewFindings();
    await browser.saveScreenshot(
      NodePath.join(preparedArtifactDirectory, "review-claude-findings.png"),
    );

    await refreshDesktopUiDocument();
    const restoredTab = reviewTab("Claude");
    await restoredTab.waitForExist({
      timeoutMsg: "The Claude review tab did not survive a reload.",
    });
    if ((await restoredTab.getAttribute("aria-selected")) !== "true") {
      await browser.execute((tab: HTMLElement) => tab.click(), await reviewTab("Claude"));
    }
    await waitForComposerDisplayed();
    await expectReviewFindings();
    await browser.saveScreenshot(
      NodePath.join(preparedArtifactDirectory, "review-claude-findings-after-reload.png"),
    );
  });
});
