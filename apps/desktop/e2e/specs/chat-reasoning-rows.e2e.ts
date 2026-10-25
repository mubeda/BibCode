// @effect-diagnostics nodeBuiltinImport:off - Packaged reasoning tests save screenshots.
import * as NodePath from "node:path";

import { refreshDesktopUiDocument } from "../support/document-navigation.ts";
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
  // A same-document hash change: a WebDriver navigation can replace the document, and a
  // script sent while it loads can be lost.
  await browser.execute(() => {
    window.location.hash = "#/";
  });
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

/**
 * Presses a Thinking header as a pointer does, so the press reaches the timeline's listeners
 * before the click, then waits for the list to re-measure it.
 */
async function toggleThought(id: string): Promise<void> {
  const clicked = await browser.execute((selector: string) => {
    const header = document.querySelector<HTMLButtonElement>(selector);
    const press = { bubbles: true, cancelable: true, isPrimary: true, pointerType: "mouse" };
    header?.dispatchEvent(new PointerEvent("pointerdown", press));
    header?.dispatchEvent(new PointerEvent("pointerup", press));
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

/** Anchored mode, right after a send: the thought streams and the turn's end stays in view. */
async function streamThoughtInAnchoredTurn(): Promise<string> {
  const thoughtId = await sendAndAwaitNewThought(
    `Explain the parser ${desktopUiFixture.reasoningTurnMarker}`,
  );
  expect(await thoughtHeaderText(thoughtId)).toMatch(/^Thinking - Fixture thinking step 1/);
  await browser.saveScreenshot(
    NodePath.join(preparedArtifactDirectory, "reasoning-thinking-row-streaming.png"),
  );
  const answerEnd = desktopUiFixture.reasoningAnswerLastLine("Explain the parser");
  await waitForAnswer(answerEnd);
  await expectEndVisible(answerEnd, "Anchored new turn");
  return thoughtId;
}

/** The finished thought folds under Worked for and shows once the fold opens. */
async function openFoldedThought(thoughtId: string): Promise<void> {
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
}

/** Expanded away from the end, the thought keeps its header in place. */
async function expandThoughtAwayFromEnd(thoughtId: string): Promise<void> {
  // A scroll the timeline does not see as the reader's own, as a wheel it misses would be:
  // the toggle must still keep the reader's place rather than reveal the turn's end.
  await browser.execute((selector: string) => {
    document.querySelector<HTMLElement>(selector)?.scrollIntoView({ block: "center" });
  }, thoughtHeaderSelector(thoughtId));
  await browser.executeAsync((done: () => void) => {
    requestAnimationFrame(() => requestAnimationFrame(() => done()));
  });
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
  // A late correction, such as a pass that reveals the end, lands within a few frames.
  await browser.pause(300);
  const after = await headerTop();
  expect(Math.abs((after ?? Number.NaN) - (before ?? 0))).toBeLessThanOrEqual(LAYOUT_SLACK_PX);
  await browser.saveScreenshot(
    NodePath.join(preparedArtifactDirectory, "reasoning-thought-expanded.png"),
  );
  await toggleThought(thoughtId);
}

/** A prompt long enough to fold its message, so the turn overflows once the trace opens. */
const LONG_PROMPT_LABEL = `Think it over. ${"Weigh every rule of the parser against the fixture. ".repeat(14).trim()}`;

/**
 * The newest thought, still streaming just above the working row, expands at the end. The
 * expanded trace then grows the anchored turn past the visible timeline, and the turn's end
 * stays in view while the thought streams on.
 */
async function expandStreamingThoughtAtEnd(): Promise<void> {
  const thoughtId = await sendAndAwaitNewThought(
    `${LONG_PROMPT_LABEL} ${desktopUiFixture.slowReasoningTurnMarker}`,
  );
  await expectEndVisible(null, "Before the toggle");
  const headerTop = () =>
    browser.execute(
      (selector: string) => document.querySelector(selector)?.getBoundingClientRect().top ?? null,
      thoughtHeaderSelector(thoughtId),
    );
  const traceLength = () =>
    browser.execute(
      (selector: string) => document.querySelector(selector)?.textContent?.length ?? 0,
      `${visibleSurfaceSelector} [data-reasoning-id="${thoughtId}"]`,
    );
  const headerTopBefore = await headerTop();
  await toggleThought(thoughtId);
  expect(await browser.$(thoughtHeaderSelector(thoughtId)).getAttribute("aria-expanded")).toBe(
    "true",
  );
  await expectEndVisible(null, "Expanded at the end");
  for (let check = 1; check <= 3; check += 1) {
    const streamed = await traceLength();
    await browser.waitUntil(async () => (await traceLength()) > streamed, {
      timeoutMsg: "The expanded thought stopped streaming before the turn's end was checked.",
    });
    await expectEndVisible(null, `Expanded at the end while thinking (${check})`);
  }
  // The turn outgrew the visible timeline: the list scrolled to keep its end in view.
  const headerTopAfter = await headerTop();
  expect((headerTopBefore ?? 0) - (headerTopAfter ?? 0)).toBeGreaterThan(LAYOUT_SLACK_PX);
  await browser.saveScreenshot(
    NodePath.join(preparedArtifactDirectory, "reasoning-thinking-row-expanded-at-end.png"),
  );
  await waitForAnswer(desktopUiFixture.reasoningAnswerLastLine(LONG_PROMPT_LABEL, true));
}

/** Reopening the thread drops the send's anchor: the list follows its end while the turn runs. */
async function followThoughtInReopenedThread(): Promise<void> {
  await sendAndAwaitNewThought(`Keep going ${desktopUiFixture.slowReasoningTurnMarker}`);
  await refreshDesktopUiDocument();
  await waitForComposerDisplayed();
  await expectEndVisible(null, "Following the end while thinking");
  const answerEnd = desktopUiFixture.reasoningAnswerLastLine("Keep going", true);
  await waitForAnswer(answerEnd);
  await expectEndVisible(answerEnd, "Following the end");
}

// One test, as in the other packaged specs: the harness resets the connection catalog and
// reloads the document before each test, so setup in a `before` hook meets a stale catalog
// and its state would not survive into the next test.
describe("Chat reasoning rows", () => {
  it("streams, folds, expands and follows Thinking rows in each scroll mode", async () => {
    await setDesktopUiWindowSize(1280, 760);
    await ensureFixtureProjectImported();
    await openPrimaryWorkspace();
    await openClaudePanel();

    const thoughtId = await streamThoughtInAnchoredTurn();
    await openFoldedThought(thoughtId);
    await expandThoughtAwayFromEnd(thoughtId);
    await expandStreamingThoughtAtEnd();
    await followThoughtInReopenedThread();
  });
});
