// @effect-diagnostics nodeBuiltinImport:off - Packaged reasoning tests save screenshots.
import * as NodePath from "node:path";

import { refreshDesktopUiDocument } from "../support/document-navigation.ts";
import { installDesktopUiMotionGuard } from "../support/motion-guard.ts";
import { desktopUiFixture } from "../support/test-project.ts";
import {
  ensureMainSidebarOpen,
  mockDesktopUiFolderPicker,
  setDesktopUiWindowSize,
} from "../support/ui-state.ts";

/**
 * #173 on the real list: the Claude shim streams a thinking block, a tool call and an answer
 * long enough to overflow the timeline, and the Thinking row must keep scrolling stable in
 * each scroll mode.
 */
const artifactDirectory = process.env.BIBCODE_E2E_ARTIFACT_DIR;
const projectPath = process.env.BIBCODE_E2E_PROJECT_PATH;
if (!artifactDirectory || !projectPath) {
  throw new Error("The packaged desktop reasoning fixture environment was not prepared.");
}
const preparedArtifactDirectory: string = artifactDirectory;
const preparedProjectPath: string = projectPath;
const visibleSurfaceSelector = '[data-center-surface-host][data-visible="true"]';
const visibleComposerFormSelector = `${visibleSurfaceSelector} [data-chat-composer-form="true"]`;
const thoughtHeaderSelector = `${visibleSurfaceSelector} [data-reasoning-id] > button`;
/** A row edge within this many pixels counts as in place. */
const LAYOUT_SLACK_PX = 2;

function composerEditor() {
  return browser.$(visibleComposerFormSelector).$('[data-testid="composer-editor"]');
}

async function waitForComposerDisplayed(): Promise<void> {
  const form = browser.$(visibleComposerFormSelector);
  await form.waitForExist();
  await form.waitForDisplayed();
  await composerEditor().waitForDisplayed();
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

async function openPrimaryWorkspace(): Promise<void> {
  const primaryWorkspace = browser.$(
    '//*[@data-thread-item="true"][.//span[normalize-space()="main"]]',
  );
  if (!(await primaryWorkspace.isDisplayed())) {
    const projectSelector = `//button[@data-sidebar="menu-button"][.//span[normalize-space()="${desktopUiFixture.projectName}"]]`;
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

async function openClaudePanel(): Promise<void> {
  const newPanel = browser.$('[aria-label="New panel"]');
  await newPanel.waitForDisplayed();
  await newPanel.waitForEnabled();
  await newPanel.click();
  const claude = browser.$('//*[@role="menuitem"][.//span[normalize-space()="Claude"]]');
  await claude.waitForDisplayed();
  await claude.waitForEnabled();
  await claude.click();
  await browser.$('button[aria-label="Close Claude"]').waitForExist();
  await waitForComposerDisplayed();
}

async function send(prompt: string): Promise<void> {
  const editor = composerEditor();
  await editor.click();
  await editor.addValue(prompt);
  await expect(editor).toHaveText(prompt);
  await browser.keys("Enter");
  await expect(editor).toHaveText("");
}

interface EndGeometry {
  /** The line's bottom, or null when the line is not rendered. */
  readonly lineBottom: number | null;
  readonly lineTop: number | null;
  /** Where the composer overlay starts: the visible timeline ends there. */
  readonly visibleBottom: number;
  readonly visibleTop: number;
}

/** Where `line` sits against the part of the timeline the composer leaves visible. */
function readEndGeometry(line: string): Promise<EndGeometry> {
  return browser.execute(
    (surfaceSelector: string, text: string) => {
      const surface = document.querySelector<HTMLElement>(surfaceSelector);
      const composer = surface?.querySelector<HTMLElement>('[data-chat-composer-overlay="true"]');
      const lineElement = [...(surface?.querySelectorAll<HTMLElement>("p, li") ?? [])].find(
        (element) => element.textContent?.trim() === text,
      );
      const surfaceRect = surface?.getBoundingClientRect();
      const lineRect = lineElement?.getBoundingClientRect();
      return {
        lineBottom: lineRect?.bottom ?? null,
        lineTop: lineRect?.top ?? null,
        visibleBottom:
          composer?.getBoundingClientRect().top ?? surfaceRect?.bottom ?? window.innerHeight,
        visibleTop: surfaceRect?.top ?? 0,
      };
    },
    visibleSurfaceSelector,
    line,
  );
}

async function expectEndVisible(line: string, context: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      const geometry = await readEndGeometry(line);
      return (
        geometry.lineBottom !== null &&
        geometry.lineTop !== null &&
        geometry.lineBottom <= geometry.visibleBottom + LAYOUT_SLACK_PX &&
        geometry.lineTop >= geometry.visibleTop - LAYOUT_SLACK_PX
      );
    },
    { timeoutMsg: `${context}: the end of the turn was not visible.` },
  );
}

/** Scrolls the visible timeline to its very end, as a reader dragging to the bottom would. */
async function scrollTimelineToEnd(): Promise<void> {
  await browser.execute((surfaceSelector: string) => {
    const row = document.querySelector<HTMLElement>(`${surfaceSelector} [data-timeline-row-id]`);
    let scroller = row?.parentElement ?? null;
    while (scroller && scroller.scrollHeight <= scroller.clientHeight) {
      scroller = scroller.parentElement;
    }
    if (scroller) {
      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event("scroll"));
    }
  }, visibleSurfaceSelector);
}

async function thoughtHeaderText(): Promise<string> {
  const header = browser.$(thoughtHeaderSelector);
  await header.waitForExist();
  return (await header.getText()).trim();
}

/** Clicks the Thinking header through the DOM, wherever the list keeps it. */
async function toggleThought(): Promise<void> {
  await browser.execute((selector: string) => {
    document.querySelector<HTMLButtonElement>(selector)?.click();
  }, thoughtHeaderSelector);
  // Two frames: the row re-renders, then the list re-measures it.
  await browser.executeAsync((done: () => void) => {
    requestAnimationFrame(() => requestAnimationFrame(() => done()));
  });
}

describe("Chat reasoning rows", () => {
  before(async () => {
    await installDesktopUiMotionGuard();
    await setDesktopUiWindowSize(1280, 760);
    await ensureFixtureProjectImported();
    await openPrimaryWorkspace();
    await openClaudePanel();
  });

  it("streams a Thinking row right after a send and keeps the anchored turn's end visible", async () => {
    await send(`Explain the parser ${desktopUiFixture.reasoningTurnMarker}`);
    await browser.waitUntil(
      async () =>
        (await thoughtHeaderText()).startsWith(
          `Thinking - ${desktopUiFixture.reasoningThoughtStart}`,
        ),
      { timeoutMsg: "The streaming thought did not show as a Thinking row." },
    );
    await browser.saveScreenshot(
      NodePath.join(preparedArtifactDirectory, "reasoning-thinking-row-streaming.png"),
    );
    await expectEndVisible(desktopUiFixture.reasoningAnswerLastLine, "Anchored new turn");
  });

  it("folds the finished thought under Worked for and shows it when the fold opens", async () => {
    const fold = browser.$(`${visibleSurfaceSelector} [data-timeline-row-kind="turn-fold"] button`);
    await fold.waitForDisplayed({ timeoutMsg: "The finished turn did not fold." });
    expect(await browser.$(thoughtHeaderSelector).isExisting()).toBe(false);
    await fold.click();
    const previousSteps = browser.$(
      `//*[@data-center-surface-host and @data-visible="true"]//button[contains(normalize-space(), "previous step")]`,
    );
    await previousSteps.waitForDisplayed({
      timeoutMsg: "The opened fold did not offer the thought as a previous step.",
    });
    await previousSteps.click();
    expect(await thoughtHeaderText()).toMatch(
      new RegExp(`^Thought - ${desktopUiFixture.reasoningThoughtStart.replaceAll(".", "\\.")}`),
    );
    await browser.saveScreenshot(
      NodePath.join(preparedArtifactDirectory, "reasoning-thought-row-in-fold.png"),
    );
  });

  it("keeps the end visible when the thought is expanded at the end", async () => {
    await scrollTimelineToEnd();
    await expectEndVisible(desktopUiFixture.reasoningAnswerLastLine, "Before the toggle");
    await toggleThought();
    expect(await browser.$(thoughtHeaderSelector).getAttribute("aria-expanded")).toBe("true");
    await expectEndVisible(desktopUiFixture.reasoningAnswerLastLine, "Expanded at the end");
    await toggleThought();
  });

  it("keeps the thought's header in place when it is expanded away from the end", async () => {
    await browser.execute((selector: string) => {
      document.querySelector<HTMLElement>(selector)?.scrollIntoView({ block: "center" });
    }, thoughtHeaderSelector);
    const headerTop = () =>
      browser.execute(
        (selector: string) => document.querySelector(selector)?.getBoundingClientRect().top ?? null,
        thoughtHeaderSelector,
      );
    const before = await headerTop();
    expect(before).not.toBeNull();
    await toggleThought();
    expect(await browser.$(thoughtHeaderSelector).getAttribute("aria-expanded")).toBe("true");
    const after = await headerTop();
    expect(Math.abs((after ?? Number.NaN) - (before ?? 0))).toBeLessThanOrEqual(LAYOUT_SLACK_PX);
    await browser.saveScreenshot(
      NodePath.join(preparedArtifactDirectory, "reasoning-thought-expanded.png"),
    );
    await toggleThought();
  });

  it("keeps the end visible while a thought streams into a thread reopened at its end", async () => {
    await send(`Keep going ${desktopUiFixture.slowReasoningTurnMarker}`);
    await browser.waitUntil(async () => (await thoughtHeaderText()).startsWith("Thinking - "), {
      timeoutMsg: "The slow thought did not start streaming.",
    });
    // Reopening the thread drops the anchor: the list follows its end while the turn runs.
    await refreshDesktopUiDocument();
    await waitForComposerDisplayed();
    await expectEndVisible(desktopUiFixture.slowReasoningAnswerLastLine, "Following the end");
  });
});
