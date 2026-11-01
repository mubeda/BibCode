// @effect-diagnostics nodeBuiltinImport:off - The packaged huge-thread test reads the app's logs.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { refreshDesktopUiDocument } from "../support/document-navigation.ts";
import { desktopUiFixture } from "../support/test-project.ts";
import {
  ensureMainSidebarOpen,
  mockDesktopUiFolderPicker,
  setDesktopUiWindowSize,
} from "../support/ui-state.ts";

/**
 * #228 on the real list: a few very long replies below many short ones. LegendList estimates an
 * unmeasured row from measured rows of its item type, so if every assistant reply shared one
 * type, the long replies measured first would place each short one far too tall. Scrolling up,
 * each short row that mounted and measured would shrink the list and pull the next one in within
 * the same layout pass, until React threw "Maximum update depth exceeded" (#185). The long
 * replies stream in deltas, so each crosses length buckets while the list measures it.
 */
const artifactDirectory = process.env.BIBCODE_E2E_ARTIFACT_DIR;
const projectPath = process.env.BIBCODE_E2E_PROJECT_PATH;
const stateRoot = process.env.BIBCODE_HOME;
if (!artifactDirectory || !projectPath || !stateRoot) {
  throw new Error("The packaged desktop huge-thread fixture environment was not prepared.");
}
const preparedArtifactDirectory: string = artifactDirectory;
const preparedProjectPath: string = projectPath;
const preparedStateRoot: string = stateRoot;
const visibleSurfaceSelector = '[data-center-surface-host][data-visible="true"]';
const visibleComposerFormSelector = `${visibleSurfaceSelector} [data-chat-composer-form="true"]`;
const SHORT_TURNS = 84;
const LONG_TURNS = 4;
const UPDATE_DEPTH_ERROR = /Maximum update depth exceeded|React error #185/;

const shortPrompt = (turn: number) => `Short turn ${String(turn).padStart(3, "0")}`;

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

/** A Claude panel of its own, so the thread holds only this spec's turns. */
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

/** Sends a prompt and waits for its turn to settle, so the next send starts a turn of its own. */
async function sendAndSettle(prompt: string): Promise<void> {
  const editor = composerEditor();
  await editor.click();
  await editor.addValue(prompt);
  await expect(editor).toHaveText(prompt);
  await browser.keys("Enter");
  await expect(editor).toHaveText("");
  await browser.waitUntil(
    () =>
      browser.execute(
        (surface: string, text: string) =>
          [...document.querySelectorAll(`${surface} [data-message-role="user"]`)].some((row) =>
            row.textContent?.includes(text),
          ) && !document.querySelector(`${surface} [data-timeline-row-kind="working"]`),
        visibleSurfaceSelector,
        prompt,
      ),
    { timeout: 30_000, timeoutMsg: `The turn for "${prompt}" did not settle.` },
  );
}

/** Records update-depth errors the page reports, whether React logs them or throws them. */
async function recordUpdateDepthErrors(): Promise<void> {
  await browser.execute((pattern: string) => {
    const matcher = new RegExp(pattern);
    const record = window as unknown as { __bibcodeUpdateDepthErrors?: string[] };
    const errors: string[] = [];
    record.__bibcodeUpdateDepthErrors = errors;
    const keep = (text: string) => {
      if (matcher.test(text)) errors.push(text.slice(0, 200));
    };
    const consoleError = console.error.bind(console);
    console.error = (...values: unknown[]) => {
      keep(values.map((value) => String(value)).join(" "));
      consoleError(...values);
    };
    window.addEventListener("error", (event) => keep(String(event.message)));
    window.addEventListener("unhandledrejection", (event) => keep(String(event.reason)));
  }, UPDATE_DEPTH_ERROR.source);
}

function readUpdateDepthErrors(): Promise<string[]> {
  return browser.execute(
    () =>
      (window as unknown as { __bibcodeUpdateDepthErrors?: string[] }).__bibcodeUpdateDepthErrors ??
      [],
  );
}

function appLogsMentionUpdateDepth(): boolean {
  const logDirectory = NodePath.join(preparedStateRoot, "userdata", "logs");
  let names: string[];
  try {
    names = NodeFS.readdirSync(logDirectory).filter((name) => name.endsWith(".log"));
  } catch {
    return false;
  }
  return names.some((name) =>
    UPDATE_DEPTH_ERROR.test(NodeFS.readFileSync(NodePath.join(logDirectory, name), "utf8")),
  );
}

interface TimelineState {
  readonly mounted: boolean;
  readonly scrollTop: number;
  /** Whether the first turn's sent row shows inside the timeline's viewport. */
  readonly firstVisible: boolean;
}

function readTimelineState(firstPrompt: string): Promise<TimelineState> {
  return browser.execute(
    (surface: string, text: string) => {
      const scroller = document.querySelector<HTMLElement>(`${surface} [class*='overflow-anchor']`);
      if (!scroller || !scroller.querySelector("[data-timeline-row-kind]")) {
        return { mounted: false, scrollTop: 0, firstVisible: false };
      }
      const area = scroller.getBoundingClientRect();
      const first = [...scroller.querySelectorAll<HTMLElement>('[data-message-role="user"]')].find(
        (row) => row.textContent?.includes(text),
      );
      const rect = first?.getBoundingClientRect();
      return {
        mounted: true,
        scrollTop: scroller.scrollTop,
        firstVisible: !!rect && rect.bottom > area.top && rect.top < area.bottom,
      };
    },
    visibleSurfaceSelector,
    firstPrompt,
  );
}

function nextFrames(): Promise<void> {
  return browser.executeAsync((done: () => void) => {
    requestAnimationFrame(() => requestAnimationFrame(() => done()));
  });
}

describe("Chat huge thread scroll", () => {
  it("scrolls from the end of long replies to the top of many short ones", async () => {
    await setDesktopUiWindowSize(1280, 760);
    await ensureFixtureProjectImported();
    await openPrimaryWorkspace();
    await openClaudePanel();

    for (let turn = 1; turn <= SHORT_TURNS; turn += 1) {
      await sendAndSettle(shortPrompt(turn));
    }
    // The long replies come last, so reopening at the end measures them first.
    for (let turn = 1; turn <= LONG_TURNS; turn += 1) {
      await sendAndSettle(`Long turn ${turn} ${desktopUiFixture.longReplyTurnMarker}`);
    }

    await refreshDesktopUiDocument();
    await waitForComposerDisplayed();
    await recordUpdateDepthErrors();
    await browser.waitUntil(
      () =>
        browser.execute(
          (surface: string, line: string) =>
            [...document.querySelectorAll(`${surface} p`)].some(
              (paragraph) => paragraph.textContent?.trim() === line,
            ),
          visibleSurfaceSelector,
          desktopUiFixture.longReplyLastLine,
        ),
      { timeoutMsg: "The reopened thread did not show the last long reply's end." },
    );

    // The reader pages up from the composer, which scrolls the timeline, then jumps to the top.
    await composerEditor().click();
    for (let page = 0; page < 30; page += 1) {
      await browser.keys("PageUp");
      await nextFrames();
    }
    const firstPrompt = shortPrompt(1);
    await browser.waitUntil(
      async () => {
        await browser.execute((surface: string) => {
          const scroller = document.querySelector<HTMLElement>(
            `${surface} [class*='overflow-anchor']`,
          );
          if (scroller) scroller.scrollTop = 0;
        }, visibleSurfaceSelector);
        await nextFrames();
        const state = await readTimelineState(firstPrompt);
        return !state.mounted || (state.scrollTop === 0 && state.firstVisible);
      },
      { timeout: 30_000, timeoutMsg: "The timeline never reached its first turn." },
    );
    await browser.saveScreenshot(
      NodePath.join(preparedArtifactDirectory, "huge-thread-scrolled-to-top.png"),
    );

    expect(await readUpdateDepthErrors()).toEqual([]);
    const state = await readTimelineState(firstPrompt);
    expect(state.mounted).toBe(true);
    expect(state.firstVisible).toBe(true);
    expect(appLogsMentionUpdateDepth()).toBe(false);
  }).timeout(900_000);
});
