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
/** A row edge within this many pixels counts as in place. */
const LAYOUT_SLACK_PX = 2;
/** Every reasoning id the timeline has shown, so each turn's new thought can be told apart. */
const seenThoughtIds = new Set<string>();
let firstTurnThoughtId: string | null = null;

const thoughtHeaderSelector = (id: string) =>
  `${visibleSurfaceSelector} [data-reasoning-id="${id}"] > button`;

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

function readThoughtIds(): Promise<string[]> {
  return browser.execute(
    (surfaceSelector: string) =>
      [...document.querySelectorAll<HTMLElement>(`${surfaceSelector} [data-reasoning-id]`)].flatMap(
        (row) => (row.dataset.reasoningId ? [row.dataset.reasoningId] : []),
      ),
    visibleSurfaceSelector,
  );
}

/** Sends a reasoning prompt and returns the id of the Thinking row its turn streams. */
async function sendAndAwaitNewThought(prompt: string): Promise<string> {
  for (const id of await readThoughtIds()) seenThoughtIds.add(id);
  await send(prompt);
  let thoughtId: string | null = null;
  await browser.waitUntil(
    async () => {
      thoughtId = (await readThoughtIds()).find((id) => !seenThoughtIds.has(id)) ?? null;
      return thoughtId !== null;
    },
    { timeoutMsg: "The turn's thought did not show as a Thinking row." },
  );
  seenThoughtIds.add(thoughtId!);
  return thoughtId!;
}

async function thoughtHeaderText(id: string): Promise<string> {
  const header = browser.$(thoughtHeaderSelector(id));
  await header.waitForExist();
  return (await header.getText()).trim();
}

/** Clicks a Thinking header through the DOM, then waits for the list to re-measure it. */
async function toggleThought(id: string): Promise<void> {
  const clicked = await browser.execute((selector: string) => {
    const header = document.querySelector<HTMLButtonElement>(selector);
    header?.click();
    return header !== null;
  }, thoughtHeaderSelector(id));
  expect(clicked).toBe(true);
  await browser.executeAsync((done: () => void) => {
    requestAnimationFrame(() => requestAnimationFrame(() => done()));
  });
}

interface EndGeometry {
  /** The element's edges, or null when it is not rendered. */
  readonly bottom: number | null;
  readonly top: number | null;
  /** Where the composer overlay starts: the visible timeline ends there. */
  readonly visibleBottom: number;
  readonly visibleTop: number;
}

/**
 * Where the end of the turn sits against the part of the timeline the composer leaves
 * visible: the paragraph reading `line`, or the working row while the turn runs.
 */
function readEndGeometry(line: string | null): Promise<EndGeometry> {
  return browser.execute(
    (surfaceSelector: string, text: string | null) => {
      const surface = document.querySelector<HTMLElement>(surfaceSelector);
      const composer = surface?.querySelector<HTMLElement>('[data-chat-composer-overlay="true"]');
      const end =
        text === null
          ? surface?.querySelector<HTMLElement>('[data-timeline-row-kind="working"]')
          : [...(surface?.querySelectorAll<HTMLElement>("p, li") ?? [])].find(
              (element) => element.textContent?.trim() === text,
            );
      const surfaceRect = surface?.getBoundingClientRect();
      const endRect = end?.getBoundingClientRect();
      return {
        bottom: endRect?.bottom ?? null,
        top: endRect?.top ?? null,
        visibleBottom:
          composer?.getBoundingClientRect().top ?? surfaceRect?.bottom ?? window.innerHeight,
        visibleTop: surfaceRect?.top ?? 0,
      };
    },
    visibleSurfaceSelector,
    line,
  );
}

async function expectEndVisible(line: string | null, context: string): Promise<void> {
  await browser.waitUntil(
    async () => {
      const geometry = await readEndGeometry(line);
      return (
        geometry.bottom !== null &&
        geometry.top !== null &&
        geometry.bottom <= geometry.visibleBottom + LAYOUT_SLACK_PX &&
        geometry.top >= geometry.visibleTop - LAYOUT_SLACK_PX
      );
    },
    { timeoutMsg: `${context}: the end of the turn was not visible.` },
  );
}

async function waitForAnswer(line: string): Promise<void> {
  await browser.waitUntil(async () => (await readEndGeometry(line)).bottom !== null, {
    timeout: 30_000,
    timeoutMsg: `The answer ending "${line}" did not arrive.`,
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
    const thoughtId = await sendAndAwaitNewThought(
      `Explain the parser ${desktopUiFixture.reasoningTurnMarker}`,
    );
    firstTurnThoughtId = thoughtId;
    expect(await thoughtHeaderText(thoughtId)).toMatch(/^Thinking - Fixture thinking step 1/);
    await browser.saveScreenshot(
      NodePath.join(preparedArtifactDirectory, "reasoning-thinking-row-streaming.png"),
    );
    const answerEnd = desktopUiFixture.reasoningAnswerLastLine("Explain the parser");
    await waitForAnswer(answerEnd);
    await expectEndVisible(answerEnd, "Anchored new turn");
  });

  it("folds the finished thought under Worked for and shows it when the fold opens", async () => {
    const thoughtId = firstTurnThoughtId!;
    const fold = browser.$(`${visibleSurfaceSelector} [data-timeline-row-kind="turn-fold"] button`);
    await fold.waitForDisplayed({ timeoutMsg: "The finished turn did not fold." });
    expect(await browser.$(thoughtHeaderSelector(thoughtId)).isExisting()).toBe(false);
    await fold.click();
    const previousSteps = browser.$(
      `//*[@data-center-surface-host and @data-visible="true"]//button[contains(normalize-space(), "previous step")]`,
    );
    await previousSteps.waitForDisplayed({
      timeoutMsg: "The opened fold did not offer the thought as a previous step.",
    });
    await previousSteps.click();
    // The finished thought previews its whole first sentence.
    expect(
      (await thoughtHeaderText(thoughtId)).startsWith(
        `Thought - ${desktopUiFixture.reasoningThoughtStart}`,
      ),
    ).toBe(true);
    await browser.saveScreenshot(
      NodePath.join(preparedArtifactDirectory, "reasoning-thought-row-in-fold.png"),
    );
  });

  it("keeps the thought's header in place when it is expanded away from the end", async () => {
    const thoughtId = firstTurnThoughtId!;
    await browser.execute((selector: string) => {
      document.querySelector<HTMLElement>(selector)?.scrollIntoView({ block: "center" });
    }, thoughtHeaderSelector(thoughtId));
    const headerTop = () =>
      browser.execute(
        (selector: string) => document.querySelector(selector)?.getBoundingClientRect().top ?? null,
        thoughtHeaderSelector(thoughtId),
      );
    const before = await headerTop();
    expect(before).not.toBeNull();
    await toggleThought(thoughtId);
    expect(await browser.$(thoughtHeaderSelector(thoughtId)).getAttribute("aria-expanded")).toBe(
      "true",
    );
    const after = await headerTop();
    expect(Math.abs((after ?? Number.NaN) - (before ?? 0))).toBeLessThanOrEqual(LAYOUT_SLACK_PX);
    await browser.saveScreenshot(
      NodePath.join(preparedArtifactDirectory, "reasoning-thought-expanded.png"),
    );
    await toggleThought(thoughtId);
  });

  it("keeps the end visible when a streaming thought is expanded at the end", async () => {
    // The newest thought, still streaming, sits just above the working row at the end.
    const thoughtId = await sendAndAwaitNewThought(
      `Think it over ${desktopUiFixture.slowReasoningTurnMarker}`,
    );
    await expectEndVisible(null, "Before the toggle");
    await toggleThought(thoughtId);
    expect(await browser.$(thoughtHeaderSelector(thoughtId)).getAttribute("aria-expanded")).toBe(
      "true",
    );
    await expectEndVisible(null, "Expanded at the end");
    await waitForAnswer(desktopUiFixture.reasoningAnswerLastLine("Think it over", true));
  });

  it("keeps the end visible while a thought streams into a thread reopened at its end", async () => {
    await sendAndAwaitNewThought(`Keep going ${desktopUiFixture.slowReasoningTurnMarker}`);
    // Reopening the thread drops the send's anchor: the list follows its end while the turn runs.
    await refreshDesktopUiDocument();
    await waitForComposerDisplayed();
    await expectEndVisible(null, "Following the end while thinking");
    const answerEnd = desktopUiFixture.reasoningAnswerLastLine("Keep going", true);
    await waitForAnswer(answerEnd);
    await expectEndVisible(answerEnd, "Following the end");
  });
});
