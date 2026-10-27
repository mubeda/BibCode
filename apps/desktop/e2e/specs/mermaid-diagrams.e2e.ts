// @effect-diagnostics nodeBuiltinImport:off - Packaged UI tests write disposable fixture files and save screenshots.
// @effect-diagnostics globalTimers:off - Page scripts wait and sample on timers inside the packaged webview.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  mermaidFixtureFiles,
  mermaidFixtureKeyboardLastLine,
  mermaidFixturePrompts,
  mermaidFixtureStreamedLastLine,
  prepareMermaidFixtureFiles,
} from "../support/mermaid-fixture.ts";
import { desktopUiFixture } from "../support/test-project.ts";
import {
  ensureMainSidebarOpen,
  mockDesktopUiFolderPicker,
  setDesktopUiWindowSize,
} from "../support/ui-state.ts";

const artifactDirectory = process.env.BIBCODE_E2E_ARTIFACT_DIR;
const projectPath = process.env.BIBCODE_E2E_PROJECT_PATH;
if (!artifactDirectory || !projectPath) {
  throw new Error("The packaged desktop Mermaid fixture environment was not prepared.");
}
const preparedArtifactDirectory: string = artifactDirectory;
const preparedProjectPath: string = projectPath;
const visibleSurfaceSelector = '[data-center-surface-host][data-visible="true"]';
const composerEditorSelector = `${visibleSurfaceSelector} [data-chat-composer-form="true"] [data-testid="composer-editor"]`;
const fileViewSelector = "[data-preview-panel-mode]";

interface EndSample {
  readonly at: number;
  readonly bottom: number | null;
  /** The last line is inside the list's visible area. */
  readonly visible: boolean;
  /** How far the list is scrolled from its end. */
  readonly endGap: number | null;
  readonly evictedDrawn: boolean;
  /**
   * The last line is painted: LegendList keeps its rows transparent until its first layout
   * and its first scroll to the end are done.
   */
  readonly shown: boolean;
}

interface StreamSample {
  readonly at: number;
  /** The streamed reply's first text is shown. */
  readonly streaming: boolean;
  /** Its code block, a diagram or plain source, is shown. */
  readonly fenceShown: boolean;
  /** Its last line is shown. */
  readonly finished: boolean;
  /** How many of its paragraphs after the code block are shown. */
  readonly afterParagraphs: number;
  /** Its last line is shown inside the list's visible area. */
  readonly lastLineInView: boolean;
  /** How far the list is scrolled from its end. */
  readonly endGap: number | null;
  /**
   * How far the timeline's lowest paragraph or code block, the reply's end, lies below the
   * list's usable bottom (its visible bottom or the composer's top, whichever is higher); zero
   * or less when the end is revealed.
   */
  readonly endBelow: number | null;
  readonly diagramDrawn: boolean;
  /** Where the reply's sent row starts below the visible top, or null while it is unmounted. */
  readonly sentRowTop: number | null;
  /**
   * The reply's code block's height as first laid out showing its source, and as first laid out
   * drawn, or null before then. Read when the DOM changes, so a draw that lands in the same
   * painted frame as the source still shows whether it changed the height at the end.
   */
  readonly sourceHeight: number | null;
  readonly drawnHeight: number | null;
}

interface KeyboardSample {
  readonly at: number;
  readonly scrollTop: number;
  readonly clientHeight: number;
  /** How far the list is scrolled from its end. */
  readonly endGap: number;
  /** As in `StreamSample`: the reply's end below the usable bottom, zero or less when shown. */
  readonly endBelow: number | null;
  /** Streamed paragraphs shown, and the last line as one more. */
  readonly delivered: number;
  /** Where the paragraph being read starts, below the visible top, once one is chosen. */
  readonly readingTop: number | null;
  /** Keydowns that reached the timeline's scroller so far. */
  readonly keydowns: number;
}

interface LandingSample {
  readonly at: number;
  /** How far below the visible top the selected message starts. */
  readonly target: number | null;
  /** Where the row holding the evicted diagram ends, relative to the visible top. */
  readonly diagramRowBottom: number | null;
  readonly diagramDrawn: boolean;
}

async function saveEvidence(name: string): Promise<void> {
  await browser.saveScreenshot(NodePath.join(preparedArtifactDirectory, `${name}.png`));
}

/** Records CSP violations from now on; the packaged app runs its production policy. */
async function watchSecurityPolicyViolations(): Promise<void> {
  await browser.execute(() => {
    const record = window as unknown as { __bibcodeCspViolations?: string[] };
    if (record.__bibcodeCspViolations) return;
    record.__bibcodeCspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      record.__bibcodeCspViolations?.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
}

async function securityPolicyViolations(): Promise<string[]> {
  return browser.execute(
    () => (window as unknown as { __bibcodeCspViolations?: string[] }).__bibcodeCspViolations ?? [],
  );
}

async function probeResourceRequests(): Promise<string[]> {
  return browser.execute(() =>
    performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((name) => name.includes("/mermaid-probe/")),
  );
}

async function openFixtureWorkspace(): Promise<void> {
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
  if (!(await primaryWorkspace.isDisplayed())) {
    await project.click();
  }
  await primaryWorkspace.waitForDisplayed();
  await primaryWorkspace.click();
  await browser.$(composerEditorSelector).waitForDisplayed();
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

/** Opens a workspace file from the Files tree, which renders inside a shadow root. */
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
        (viewQuery: string, title: string) =>
          [...document.querySelectorAll(`${viewQuery} .chat-markdown h1`)].some(
            (heading) => heading.textContent === title,
          ),
        fileViewSelector,
        fileName === mermaidFixtureFiles.valid.name
          ? "Valid diagram"
          : fileName === mermaidFixtureFiles.invalid.name
            ? "Invalid diagram"
            : "Hostile diagram",
      ),
    { timeoutMsg: `The rendered Markdown view did not show ${fileName}.` },
  );
}

async function waitForDiagram(scope: string, timeoutMsg: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (scopeQuery: string) =>
          [...document.querySelectorAll(`${scopeQuery} .chat-markdown-mermaid svg`)].some(
            (svg) => svg.getBoundingClientRect().height > 0,
          ),
        scope,
      ),
    { timeoutMsg },
  );
}

async function sendPrompt(prompt: string): Promise<void> {
  const editor = browser.$(composerEditorSelector);
  await editor.click();
  await editor.addValue(prompt);
  await expect(editor).toHaveText(prompt);
  await browser.keys("Enter");
  await expect(editor).toHaveText("");
}

interface ReadingLineGeometry {
  readonly anchorTop: number;
  readonly targetTop: number;
  readonly targetBottom: number;
  readonly targetRowTop: number;
  readonly targetRowBottom: number;
  readonly viewportTop: number;
}

/** Where the anchor paragraph and the diagram block containing `label` are now. */
async function readingLineGeometry(label: string, anchor: string): Promise<ReadingLineGeometry> {
  return browser.execute(
    (surface: string, targetLabel: string, anchorText: string) => {
      const paragraph = [
        ...document.querySelectorAll<HTMLElement>(`${surface} .chat-markdown p`),
      ].find((element) => element.textContent === anchorText);
      const target = [
        ...document.querySelectorAll<HTMLElement>(`${surface} .chat-markdown-codeblock`),
      ].find((element) => element.textContent?.includes(targetLabel));
      const row = target?.closest<HTMLElement>("[data-timeline-root]");
      const viewport = row?.closest<HTMLElement>("[class*='overflow-anchor']")?.parentElement;
      if (!paragraph || !target || !row || !viewport) {
        throw new Error(
          `Reading-line fixture missing: ${JSON.stringify({
            paragraph: !!paragraph,
            target: !!target,
            row: !!row,
            viewport: !!viewport,
          })}`,
        );
      }
      const targetBox = target.getBoundingClientRect();
      const rowBox = row.getBoundingClientRect();
      return {
        anchorTop: paragraph.getBoundingClientRect().top,
        targetTop: targetBox.top,
        targetBottom: targetBox.bottom,
        targetRowTop: rowBox.top,
        targetRowBottom: rowBox.bottom,
        viewportTop: viewport.getBoundingClientRect().top,
      };
    },
    visibleSurfaceSelector,
    label,
    anchor,
  );
}

/**
 * Scrolls the timeline until `anchor` rests 80 px below the visible top. Right after a reply
 * the list can still move itself (the sent-row anchor, end following), so it scrolls again
 * until two readings agree.
 */
async function restAnchorBelowTop(label: string, anchor: string): Promise<ReadingLineGeometry> {
  let previous: number | null = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await browser.execute(
      (surface: string, anchorText: string) => {
        const paragraph = [
          ...document.querySelectorAll<HTMLElement>(`${surface} .chat-markdown p`),
        ].find((element) => element.textContent === anchorText);
        const scroller = paragraph?.closest<HTMLElement>("[class*='overflow-anchor']");
        const viewport = scroller?.parentElement;
        if (!paragraph || !scroller || !viewport) return;
        const offset =
          paragraph.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 80;
        if (Math.abs(offset) <= 0.5) return;
        // A reader scrolls with the wheel, which stops the timeline following a sent turn's
        // end; without it, the turn still being followed would take the view back to its end.
        scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: offset, bubbles: true }));
        scroller.scrollTop += offset;
      },
      visibleSurfaceSelector,
      anchor,
    );
    await browser.pause(300);
    const geometry = await readingLineGeometry(label, anchor);
    const resting = Math.abs(geometry.anchorTop - geometry.viewportTop - 80) <= 1;
    if (resting && previous !== null && Math.abs(previous - geometry.anchorTop) <= 0.5) {
      return geometry;
    }
    previous = resting ? geometry.anchorTop : null;
  }
  throw new Error(`The timeline did not rest with "${anchor}" below its top.`);
}

/**
 * Fails unless the webview paints frames. The list holds the reading line from its resize
 * observers, which run only in a painted frame, and an occluded macOS webview paints none,
 * so there the reading-line checks would measure layout no one sees.
 */
async function expectPaintingWebview(): Promise<void> {
  const painting = await browser.executeAsync((done: (painted: boolean) => void) => {
    const timeout = setTimeout(() => done(false), 3_000);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(timeout);
        done(true);
      }),
    );
  });
  if (!painting) {
    throw new Error(
      "The webview paints no frames (an occluded window); the reading-line checks need it visible.",
    );
  }
}

/** Toggles Show source on the diagram block containing `label`, as a reader would. */
async function toggleDiagramView(label: string): Promise<void> {
  await browser.execute(
    (surface: string, targetLabel: string) => {
      const target = [
        ...document.querySelectorAll<HTMLElement>(`${surface} .chat-markdown-codeblock`),
      ].find((element) => element.textContent?.includes(targetLabel));
      const toggle = target?.querySelector<HTMLButtonElement>(
        'button[aria-label="Show source"], button[aria-label="Show diagram"]',
      );
      if (!toggle) throw new Error("The diagram view toggle is missing.");
      toggle.click();
    },
    visibleSurfaceSelector,
    label,
  );
  await browser.pause(600);
}

/** `CHAT_LIST_ANCHOR_OFFSET` in packages/shared/src/chatList.ts: where a sent row lands. */
const SENT_ROW_ANCHOR_OFFSET = 16;
/** How far apart two separately streamed replies may come to rest: about two lines. */
const STREAMED_REST_SLACK_PX = 48;
/** How long after a reply's first delivery its sent row has settled, on the slowest runner. */
const SENT_ROW_SETTLE_MS = 2_500;
/** How soon a diagram's growth is followed: a size report, two frames and a paint. */
const DRAW_FOLLOW_MS = 200;
/** The `viewOffset` the timeline minimap scrolls a selected message to. */
const MINIMAP_VIEW_OFFSET = 24;

/** How far below the timeline's visible top each rendered user row sent as `prompt` starts. */
async function userRowOffsets(prompt: string): Promise<number[]> {
  return browser.execute(
    (surface: string, text: string) =>
      [...document.querySelectorAll<HTMLElement>(`${surface} [data-message-role="user"]`)]
        .filter((element) => element.textContent?.includes(text))
        .map((row) => {
          const viewport = row
            .closest<HTMLElement>("[class*='overflow-anchor']")
            ?.parentElement?.getBoundingClientRect();
          return viewport ? Math.round(row.getBoundingClientRect().top - viewport.top) : NaN;
        }),
    visibleSurfaceSelector,
    prompt,
  );
}

interface ReadingLineSamples {
  readonly timer: LandingSample[];
  /** Taken once each frame has painted; empty in an occluded webview, which paints none. */
  readonly painted: LandingSample[];
}

/**
 * Samples, on a timer and after each painted frame, where the user row sent as `prompt`
 * starts and where the row holding the diagram labelled `diagramLabel` ends.
 */
async function startReadingLineSamples(prompt: string, diagramLabel: string): Promise<void> {
  await browser.execute(
    (surface: string, targetPrompt: string, label: string) => {
      const record = window as unknown as {
        __bibcodeReadingLineSamples?: { timer: LandingSample[]; painted: LandingSample[] };
        __bibcodeReadingLineStop?: () => void;
      };
      record.__bibcodeReadingLineStop?.();
      const samples = { timer: [] as LandingSample[], painted: [] as LandingSample[] };
      record.__bibcodeReadingLineSamples = samples;
      const started = performance.now();
      const read = (): LandingSample => {
        const viewport = document
          .querySelector(`${surface} [class*='overflow-anchor']`)
          ?.parentElement?.getBoundingClientRect();
        const target = [
          ...document.querySelectorAll<HTMLElement>(`${surface} [data-message-role="user"]`),
        ].find((element) => element.textContent?.includes(targetPrompt));
        const block = [
          ...document.querySelectorAll<HTMLElement>(`${surface} .chat-markdown-codeblock`),
        ].find((element) => element.textContent?.includes(label));
        const blockRow = block?.closest<HTMLElement>("[data-timeline-root]");
        return {
          at: performance.now() - started,
          target: target && viewport ? target.getBoundingClientRect().top - viewport.top : null,
          diagramRowBottom:
            blockRow && viewport ? blockRow.getBoundingClientRect().bottom - viewport.top : null,
          diagramDrawn: block?.querySelector(".chat-markdown-mermaid svg") != null,
        };
      };
      let running = true;
      const timer = setInterval(() => {
        samples.timer.push(read());
        if (performance.now() - started > 60_000) record.__bibcodeReadingLineStop?.();
      }, 5);
      // A message posted from a frame callback is handled once that frame has painted.
      const afterPaint = new MessageChannel();
      afterPaint.port1.addEventListener("message", () => samples.painted.push(read()));
      afterPaint.port1.start();
      const onFrame = () => {
        if (!running) return;
        afterPaint.port2.postMessage(null);
        requestAnimationFrame(onFrame);
      };
      requestAnimationFrame(onFrame);
      record.__bibcodeReadingLineStop = () => {
        running = false;
        clearInterval(timer);
      };
    },
    visibleSurfaceSelector,
    prompt,
    diagramLabel,
  );
}

async function readReadingLineSamples(): Promise<ReadingLineSamples> {
  return browser.execute(
    () =>
      (
        window as unknown as {
          __bibcodeReadingLineSamples?: { timer: LandingSample[]; painted: LandingSample[] };
        }
      ).__bibcodeReadingLineSamples ?? { timer: [], painted: [] },
  );
}

/** The samples where something changed, for a trace artifact that holds no message text. */
function withoutRepeats(samples: ReadingLineSamples): ReadingLineSamples {
  const changes = (list: readonly LandingSample[]) =>
    list.filter(
      (entry, index, all) =>
        index === 0 ||
        entry.target !== all[index - 1]!.target ||
        entry.diagramRowBottom !== all[index - 1]!.diagramRowBottom ||
        entry.diagramDrawn !== all[index - 1]!.diagramDrawn,
    );
  return { timer: changes(samples.timer), painted: changes(samples.painted) };
}

/** Scrolls the timeline to its end and waits until the reply's `lastLine` rests in view. */
async function scrollTimelineToEnd(lastLine: string): Promise<void> {
  await browser.waitUntil(
    () =>
      browser.execute(
        (surface: string, line: string) => {
          const scroller = document.querySelector<HTMLElement>(
            `${surface} [class*='overflow-anchor']`,
          );
          if (!scroller) return false;
          scroller.scrollTop = scroller.scrollHeight;
          const paragraph = [
            ...document.querySelectorAll<HTMLElement>(`${surface} .chat-markdown p`),
          ].find((element) => element.textContent === line);
          const area = scroller.getBoundingClientRect();
          const box = paragraph?.getBoundingClientRect();
          return !!box && box.top >= area.top && box.bottom <= area.bottom;
        },
        visibleSurfaceSelector,
        lastLine,
      ),
    { timeoutMsg: "The timeline never returned to the reply's last line.", interval: 500 },
  );
  await browser.pause(1_000);
}

describe("packaged Mermaid diagrams", () => {
  it("draws, refuses and sanitizes diagrams in the rendered Markdown view", async () => {
    prepareMermaidFixtureFiles(preparedProjectPath);
    await setDesktopUiWindowSize(1_600, 1_000);
    await watchSecurityPolicyViolations();
    await openFixtureWorkspace();
    await openFilesSurface();

    await openWorkspaceFile(mermaidFixtureFiles.valid.name);
    await waitForDiagram(fileViewSelector, "The valid fixture diagram never drew.");
    await expect(browser.$(`${fileViewSelector} .chat-markdown-mermaid`)).toHaveText(
      expect.stringContaining("Fixture draw"),
    );
    await saveEvidence("mermaid-file-valid");

    // A theme switch recolors the drawn diagram without drawing or replacing it. Timers, not
    // animation frames, wait for React: frames can stop in an occluded macOS webview.
    const themeSwitch = await browser.executeAsync(
      (
        viewQuery: string,
        done: (result: { before: string; after: string; replaced: boolean; same: boolean }) => void,
      ) => {
        const svg = document.querySelector(`${viewQuery} .chat-markdown-mermaid svg`);
        const shape = svg?.querySelector(".pele-node rect, .pele-node polygon, .pele-node path");
        if (!svg || !shape) throw new Error("The drawn fixture diagram has no node shape.");
        let replaced = false;
        const observer = new MutationObserver(() => {
          replaced = true;
        });
        observer.observe(svg.parentElement!, { childList: true });
        const before = getComputedStyle(shape).fill;
        const next = document.documentElement.classList.contains("dark") ? "light" : "dark";
        window.localStorage.setItem("bibcode:theme", next);
        window.dispatchEvent(new StorageEvent("storage", { key: "bibcode:theme", newValue: next }));
        setTimeout(() => {
          observer.disconnect();
          done({
            before,
            after: getComputedStyle(shape).fill,
            replaced,
            same: document.querySelector(`${viewQuery} .chat-markdown-mermaid svg`) === svg,
          });
        }, 500);
      },
      fileViewSelector,
    );
    expect(themeSwitch.after).not.toBe(themeSwitch.before);
    expect(themeSwitch.replaced).toBe(false);
    expect(themeSwitch.same).toBe(true);
    await saveEvidence("mermaid-file-valid-other-theme");

    await openWorkspaceFile(mermaidFixtureFiles.invalid.name);
    const error = browser.$(`${fileViewSelector} .chat-markdown-mermaid-error`);
    await error.waitForDisplayed({ timeoutMsg: "The invalid fixture diagram showed no error." });
    await expect(error).toHaveText("Can't draw this diagram: line 3, Unrecognized text.");
    await saveEvidence("mermaid-file-invalid");

    await openWorkspaceFile(mermaidFixtureFiles.hostile.name);
    await waitForDiagram(fileViewSelector, "The hostile fixture diagram never drew.");
    const hostile = await browser.execute(
      (viewQuery: string) =>
        document.querySelectorAll(
          `${viewQuery} .chat-markdown-mermaid :is(a, image, foreignObject, style, use, script)`,
        ).length,
      fileViewSelector,
    );
    expect(hostile).toBe(0);
    await browser.pause(500);
    // Same-origin loads raise no CSP event, so the resource list is the evidence.
    expect(await probeResourceRequests()).toEqual([]);
    expect(await securityPolicyViolations()).toEqual([]);
    await saveEvidence("mermaid-file-hostile");
  });

  it("keeps the reading line in place when a diagram above it swaps", async () => {
    await setDesktopUiWindowSize(1_400, 900);
    await openFixtureWorkspace();
    await sendPrompt(mermaidFixturePrompts.rows);
    await waitForDiagram(visibleSurfaceSelector, "The fixture reply's diagram never drew.");
    await sendPrompt(mermaidFixturePrompts.long);
    await browser.waitUntil(
      () =>
        browser.execute(
          (surface: string) =>
            [...document.querySelectorAll(`${surface} .chat-markdown p`)].some(
              (paragraph) =>
                paragraph.textContent ===
                "Following reply paragraph 60 keeps the reading position measurable.",
            ),
          visibleSurfaceSelector,
        ),
      { timeoutMsg: "The long fixture reply never arrived." },
    );

    await expectPaintingWebview();
    // Inside the first visible row, above the top edge: the reading anchor compensates.
    const inRowAnchor = "Below the diagram paragraph 20 keeps the reading position measurable.";
    const inRow = await restAnchorBelowTop("Fixture draw", inRowAnchor);
    expect(inRow.targetTop).toBeLessThan(inRow.viewportTop);
    expect(inRow.targetRowTop).toBeLessThanOrEqual(inRow.viewportTop);
    expect(inRow.targetRowBottom).toBeGreaterThan(inRow.viewportTop);
    await toggleDiagramView("Fixture draw");
    const inRowAfter = await readingLineGeometry("Fixture draw", inRowAnchor);
    // The swap changed the block's height, so a fixed line below it would have moved.
    expect(
      Math.abs(
        inRowAfter.targetBottom - inRowAfter.targetTop - (inRow.targetBottom - inRow.targetTop),
      ),
    ).toBeGreaterThan(1);
    expect(Math.abs(inRowAfter.anchorTop - inRow.anchorTop)).toBeLessThanOrEqual(1);
    await saveEvidence("mermaid-timeline-first-row");

    // A row wholly above the viewport: the list's size anchoring holds the next row.
    const aboveAnchor = "Following reply paragraph 2 keeps the reading position measurable.";
    const above = await restAnchorBelowTop("Fixture draw", aboveAnchor);
    expect(above.targetRowBottom).toBeLessThanOrEqual(above.viewportTop);
    await toggleDiagramView("Fixture draw");
    const aboveAfter = await readingLineGeometry("Fixture draw", aboveAnchor);
    expect(Math.abs(aboveAfter.anchorTop - above.anchorTop)).toBeLessThanOrEqual(1);
    await saveEvidence("mermaid-timeline-row-above");

    // The sent-row anchor still holds a sent message at its offset, below the replies above
    // it, once the diagram in a reply shorter than the timeline has drawn under it, with the
    // list's size anchoring on. (A reply taller than the timeline scrolls on to reveal its end
    // instead, and a first message has nothing above it to scroll past.)
    await sendPrompt(mermaidFixturePrompts.short);
    await browser.waitUntil(
      () =>
        browser.execute(
          (surface: string) =>
            [...document.querySelectorAll(`${surface} .chat-markdown-mermaid svg`)].some((svg) =>
              svg.textContent?.includes("Kept at the top"),
            ),
          visibleSurfaceSelector,
        ),
      { timeoutMsg: "The short fixture reply's diagram never drew." },
    );
    await browser.pause(600);
    const sentRows = await userRowOffsets(mermaidFixturePrompts.short);
    expect(sentRows).toHaveLength(1);
    const sentRowOff = sentRows[0]! - SENT_ROW_ANCHOR_OFFSET;
    // Labelled, so a failure says where the row rested and how far off (#191).
    expect({
      top: sentRows[0],
      expected: SENT_ROW_ANCHOR_OFFSET,
      withinPx: Math.abs(sentRowOff) <= 1,
    }).toEqual({
      top: sentRows[0],
      expected: SENT_ROW_ANCHOR_OFFSET,
      withinPx: true,
    });
    await saveEvidence("mermaid-timeline-sent-row");

    // Minimap navigation still lands where the minimap puts it, past the diagrams above.
    const minimapLabel = () =>
      browser.execute((surface: string) => {
        const button = document.querySelector<HTMLButtonElement>(
          `${surface} [data-testid="timeline-minimap"] button[aria-label^="Jump to message"]`,
        );
        if (!button || button.getBoundingClientRect().height === 0) {
          throw new Error("The timeline minimap is not shown.");
        }
        return button.getAttribute("aria-label") ?? "";
      }, visibleSurfaceSelector);
    const pressMinimapKey = (key: string | null) =>
      browser.execute(
        (surface: string, pressed: string | null) => {
          const button = document.querySelector<HTMLButtonElement>(
            `${surface} [data-testid="timeline-minimap"] button[aria-label^="Jump to message"]`,
          )!;
          if (pressed === null) button.focus();
          else button.dispatchEvent(new KeyboardEvent("keydown", { key: pressed, bubbles: true }));
        },
        visibleSurfaceSelector,
        key,
      );
    // From the end, so the jump passes the short reply's diagram. The keyboard selects a
    // message exactly; earlier specs may have sent messages before these.
    await scrollTimelineToEnd("After the short diagram.");
    await minimapLabel();
    await pressMinimapKey(null);
    // Not the first message, which the list cannot scroll below its top.
    for (let step = 0; !(await minimapLabel()).includes(mermaidFixturePrompts.long); step += 1) {
      if (step > 50) throw new Error("The minimap never offered the long reply's message.");
      await pressMinimapKey("ArrowDown");
    }
    await startReadingLineSamples(mermaidFixturePrompts.long, "Fixture draw");
    await pressMinimapKey("Enter");
    let landing: ReadingLineSamples = { timer: [], painted: [] };
    const landedAt = (entries: readonly LandingSample[]) =>
      entries.findIndex(
        (entry) => entry.target !== null && Math.abs(entry.target - MINIMAP_VIEW_OFFSET) <= 1,
      );
    try {
      await browser.waitUntil(
        async () => {
          landing = await readReadingLineSamples();
          const landed = landedAt(landing.timer);
          return landed >= 0 && landing.timer.at(-1)!.at - landing.timer[landed]!.at > 1_500;
        },
        { timeoutMsg: "The minimap never landed on the long reply's message.", interval: 500 },
      );
    } finally {
      NodeFS.writeFileSync(
        NodePath.join(preparedArtifactDirectory, "mermaid-timeline-minimap-landing.json"),
        JSON.stringify(withoutRepeats(landing), null, 2),
      );
    }
    expect(
      landing.timer
        .slice(landedAt(landing.timer))
        .every(
          (entry) => entry.target !== null && Math.abs(entry.target - MINIMAP_VIEW_OFFSET) <= 1,
        ),
    ).toBe(true);
    await browser.execute(() =>
      (window as unknown as { __bibcodeReadingLineStop?: () => void }).__bibcodeReadingLineStop?.(),
    );
    await saveEvidence("mermaid-timeline-minimap-landing");
  });

  // Each of the two batches of 101 draws may wait 240 s in an occluded webview, the remount up
  // to 60 s more and the cold draw's step-by-step scroll over a minute, so the slowest runners
  // need well past the suite's 120 s default. WebdriverIO races a test against the timeout it
  // had when it started, so the timeout is set on the test, not inside it.
  it("draws an evicted diagram again on remount and settles at the end", async () => {
    await setDesktopUiWindowSize(1_400, 900);
    await openFixtureWorkspace();
    await sendPrompt(mermaidFixturePrompts.many);
    // One render per task: an occluded macOS webview throttles timers to about one a second.
    await browser.waitUntil(
      () =>
        browser.execute(
          (surface: string) =>
            [
              ...document.querySelectorAll(
                `${surface} .chat-markdown-codeblock[data-language="mermaid"] .chat-markdown-mermaid svg`,
              ),
            ].filter((svg) => svg.textContent?.includes("Many ")).length >= 101,
          visibleSurfaceSelector,
        ),
      { timeoutMsg: "The 101 fixture diagrams never drew.", timeout: 240_000, interval: 1_000 },
    );
    // The remount runs first, while only the reply's last diagram is evicted.
    // Sample on a timer while the chat is left and reopened (an in-page navigation keeps the
    // diagram cache): the last line's position and whether the evicted diagram is drawn. The
    // queue draws the most recently mounted block first, so the reply's last diagram was the
    // first one drawn and, once 100 others followed it, the one the cache evicted.
    // Timer samples can also see layout no frame painted (between a task that changed sizes
    // and the frame's resize observers), so the trace also samples once after each painted
    // frame; an occluded webview runs no frames and leaves that list empty.
    await browser.execute((surface: string) => {
      const record = window as unknown as {
        __bibcodeMermaidSamples?: EndSample[];
        __bibcodeMermaidFrameSamples?: EndSample[];
      };
      const samples: EndSample[] = [];
      const frameSamples: EndSample[] = [];
      record.__bibcodeMermaidSamples = samples;
      record.__bibcodeMermaidFrameSamples = frameSamples;
      const started = performance.now();
      const read = (): EndSample => {
        const paragraph = [
          ...document.querySelectorAll<HTMLElement>(`${surface} .chat-markdown p`),
        ].find((element) => element.textContent === "Last line after the diagrams.");
        const evictedBlock = [
          ...(paragraph?.closest(".chat-markdown")?.querySelectorAll(".chat-markdown-codeblock") ??
            []),
        ].at(-1);
        return {
          at: performance.now() - started,
          bottom: paragraph?.getBoundingClientRect().bottom ?? null,
          visible: (() => {
            const scroller = paragraph?.closest<HTMLElement>("[class*='overflow-anchor']");
            if (!paragraph || !scroller) return false;
            const line = paragraph.getBoundingClientRect();
            const area = scroller.getBoundingClientRect();
            return line.top >= area.top && line.bottom <= area.bottom;
          })(),
          endGap: (() => {
            const scroller = paragraph?.closest<HTMLElement>("[class*='overflow-anchor']");
            return scroller
              ? Math.round(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop)
              : null;
          })(),
          evictedDrawn: evictedBlock?.querySelector(".chat-markdown-mermaid svg") != null,
          shown: (() => {
            const scroller = paragraph?.closest<HTMLElement>("[class*='overflow-anchor']");
            if (!paragraph || !scroller) return false;
            for (let node: HTMLElement | null = paragraph; node && node !== scroller;) {
              if (getComputedStyle(node).opacity === "0") return false;
              node = node.parentElement;
            }
            return true;
          })(),
        };
      };
      // The first sample is where the reply ends before the chat is left; an occluded webview
      // can delay the first timer past the navigation.
      samples.push(read());
      const timer = setInterval(() => {
        samples.push(read());
        if (performance.now() - started > 60_000) clearInterval(timer);
      }, 5);
      // A message posted from a frame callback is handled once that frame has painted.
      const afterPaint = new MessageChannel();
      afterPaint.port1.addEventListener("message", () => frameSamples.push(read()));
      afterPaint.port1.start();
      const onFrame = () => {
        afterPaint.port2.postMessage(null);
        if (performance.now() - started < 60_000) requestAnimationFrame(onFrame);
      };
      requestAnimationFrame(onFrame);
    }, visibleSurfaceSelector);
    await browser.url(`${await browser.execute(() => window.location.origin)}/#/`);
    await openFixtureWorkspace();
    const readSamples = () =>
      browser.execute(
        () =>
          (window as unknown as { __bibcodeMermaidSamples?: EndSample[] })
            .__bibcodeMermaidSamples ?? [],
      );
    let samples: EndSample[] = [];
    await browser.waitUntil(
      async () => {
        samples = await readSamples();
        const gone = samples.findIndex((entry) => entry.bottom === null);
        const redrawn = samples.findIndex(
          (entry, index) => gone >= 0 && index > gone && entry.evictedDrawn,
        );
        return redrawn >= 0 && samples.at(-1)!.at - samples[redrawn]!.at > 1_500;
      },
      { timeoutMsg: "The evicted diagram never drew again.", timeout: 60_000, interval: 500 },
    );
    const left = samples.findIndex((entry) => entry.bottom === null);
    const mounted = samples.findIndex((entry, index) => index > left && entry.bottom !== null);
    const drawn = samples.findIndex((entry, index) => index > mounted && entry.evictedDrawn);
    // The remounted evicted diagram showed its source before it drew again through the queue.
    expect(left).toBeGreaterThan(0);
    expect(mounted).toBeGreaterThan(left);
    expect(samples[mounted]?.evictedDrawn).toBe(false);
    expect(drawn).toBeGreaterThan(mounted);
    const changes = (list: readonly EndSample[]) =>
      list.filter(
        (entry, index, all) =>
          index === 0 ||
          entry.bottom !== all[index - 1]!.bottom ||
          entry.visible !== all[index - 1]!.visible ||
          entry.endGap !== all[index - 1]!.endGap ||
          entry.evictedDrawn !== all[index - 1]!.evictedDrawn ||
          entry.shown !== all[index - 1]!.shown,
      );
    const frameSamples = await browser.execute(
      () =>
        (window as unknown as { __bibcodeMermaidFrameSamples?: EndSample[] })
          .__bibcodeMermaidFrameSamples ?? [],
    );
    // The per-sample traces hold no message text.
    NodeFS.writeFileSync(
      NodePath.join(preparedArtifactDirectory, "mermaid-timeline-evicted-remount.json"),
      JSON.stringify(
        {
          timerSamples: changes(samples.slice(Math.max(0, left - 1))),
          paintedFrameSamples: changes(frameSamples),
        },
        null,
        2,
      ),
    );
    // The reopened chat settles at its end, with the reply's last line in view, and stays
    // there for the last second of samples.
    const final = samples.at(-1)!;
    expect(final.visible).toBe(true);
    expect(final.endGap).toBeLessThanOrEqual(1);
    const lastSecond = samples.filter((entry) => entry.at >= final.at - 1_000);
    expect(lastSecond.every((entry) => Math.abs(entry.bottom! - final.bottom!) <= 1)).toBe(true);
    // From the first painted frame of the reopened chat on, every frame shows the last line
    // where it rests: the evicted diagram keeps its drawn height while it draws again, so the
    // end does not step as it redraws.
    const leftFrame = frameSamples.findIndex((entry) => entry.bottom === null);
    const reopenedFrame = frameSamples.findIndex(
      (entry, index) => leftFrame >= 0 && index > leftFrame && entry.shown,
    );
    expect(reopenedFrame).toBeGreaterThan(leftFrame);
    const unsettledFrames = frameSamples
      .slice(reopenedFrame)
      .filter(
        (entry) =>
          !entry.visible ||
          entry.bottom === null ||
          Math.abs(entry.bottom - final.bottom!) > 1 ||
          entry.endGap === null ||
          entry.endGap > 1,
      );
    expect(unsettledFrames).toEqual([]);
    await saveEvidence("mermaid-timeline-evicted-remount");

    // A cold first draw above the line being read. The rows reply's diagram was evicted by
    // these 101 and its row, far above, unmounted. Scrolling up a step at a time remounts that
    // row in the list's buffer above the viewport, where it shows its source and then draws
    // through the queue; the message sent after it, the line being read, stays put on every
    // painted frame from the remount on. The reopened list may have mounted, and drawn, rows
    // from its top, so 101 further diagrams evict every earlier one first, and the case waits,
    // at the end, until the rows reply's row is unmounted.
    await sendPrompt(mermaidFixturePrompts.manyAgain);
    await browser.waitUntil(
      () =>
        browser.execute(
          (surface: string) =>
            [...document.querySelectorAll(`${surface} .chat-markdown-mermaid svg`)].filter((svg) =>
              svg.textContent?.includes("Again "),
            ).length >= 101,
          visibleSurfaceSelector,
        ),
      { timeoutMsg: "The second 101 diagrams never drew.", timeout: 240_000, interval: 1_000 },
    );
    await expectPaintingWebview();
    await browser.waitUntil(
      () =>
        browser.execute(
          (surface: string, diagramLabel: string) => {
            const scroller = document.querySelector<HTMLElement>(
              `${surface} [class*='overflow-anchor']`,
            );
            if (scroller) scroller.scrollTop = scroller.scrollHeight;
            return ![
              ...document.querySelectorAll<HTMLElement>(`${surface} .chat-markdown-codeblock`),
            ].some((element) => element.textContent?.includes(diagramLabel));
          },
          visibleSurfaceSelector,
          "Fixture draw",
        ),
      { timeoutMsg: "The rows reply's diagram never unmounted.", timeout: 15_000, interval: 500 },
    );
    await startReadingLineSamples(mermaidFixturePrompts.long, "Fixture draw");
    for (let step = 0; ; step += 1) {
      // Two replies of 101 diagrams lie between the end and the rows reply.
      if (step > 300) throw new Error("Scrolling up never reached the rows reply.");
      const reached = await browser.execute(
        (surface: string, diagramLabel: string) => {
          const reachedBlock = [
            ...document.querySelectorAll<HTMLElement>(`${surface} .chat-markdown-codeblock`),
          ].some((element) => element.textContent?.includes(diagramLabel));
          if (reachedBlock) return true;
          const scroller = document.querySelector<HTMLElement>(
            `${surface} [class*='overflow-anchor']`,
          );
          if (scroller) scroller.scrollTop -= 300;
          return false;
        },
        visibleSurfaceSelector,
        "Fixture draw",
      );
      if (reached) break;
      await browser.pause(250);
    }
    await browser.pause(1_500);
    const coldDraw = await readReadingLineSamples();
    NodeFS.writeFileSync(
      NodePath.join(preparedArtifactDirectory, "mermaid-timeline-cold-draw.json"),
      JSON.stringify(withoutRepeats(coldDraw), null, 2),
    );
    // Timer samples can see layout no frame painted, so the check reads the painted frames.
    expect(coldDraw.painted.length).toBeGreaterThan(0);
    const appeared = coldDraw.painted.findIndex((entry) => entry.diagramRowBottom !== null);
    const drew = coldDraw.painted.findIndex((entry) => entry.diagramDrawn);
    // A row remounted in the buffer can draw from the cache before its first painted frame, so
    // the check needs the diagram drawn by the end, not a frame of its source first.
    expect(appeared).toBeGreaterThanOrEqual(0);
    expect(drew).toBeGreaterThanOrEqual(appeared);
    const readingLine = coldDraw.painted[appeared]!.target!;
    // The diagram's row ends where the read row begins. A display scaled 200% lays the two out
    // a fraction of a pixel apart, so the row counts as above within the same 1 px as below.
    expect(coldDraw.painted[drew]!.diagramRowBottom!).toBeLessThanOrEqual(readingLine + 1);
    expect(
      coldDraw.painted
        .slice(appeared)
        .every((entry) => entry.target !== null && Math.abs(entry.target - readingLine) <= 1),
    ).toBe(true);
    await saveEvidence("mermaid-timeline-cold-draw");
  }).timeout(900_000);

  it("follows the end while a streamed reply's diagram draws", async () => {
    await setDesktopUiWindowSize(1_400, 900);
    await openFixtureWorkspace();
    await expectPaintingWebview();
    // The same reply streams twice, first with the diagram's source in a plain code block as
    // the baseline, then as a diagram that draws while the list follows the end and more text
    // streams after it. Each is taller than the timeline before the fence.
    const plain = await streamAndSampleEnd(mermaidFixturePrompts.streamedPlain);
    const diagram = await streamAndSampleEnd(mermaidFixturePrompts.streamed);
    NodeFS.writeFileSync(
      NodePath.join(preparedArtifactDirectory, "mermaid-timeline-streaming-follow.json"),
      JSON.stringify(
        {
          plain: streamChanges(plain),
          diagram: streamChanges(diagram),
          // Diagnostic only: painted frames from each delivery's first to its end revealed.
          framesToReveal: { plain: framesToReveal(plain), diagram: framesToReveal(diagram) },
        },
        null,
        2,
      ),
    );
    expect(plain.some((entry) => entry.diagramDrawn)).toBe(false);
    const drew = diagram.findIndex((entry) => entry.diagramDrawn);
    const firstStreamed = diagram.findIndex((entry) => entry.streaming);
    // The diagram drew while the reply streamed, after its first text was shown, and its
    // source was laid out at the end first, so the draw changed the height at the end. A busy
    // webview can lay the source out and draw it before painting a frame of it, so the source is
    // read from the DOM as it changes rather than from a painted frame.
    expect(firstStreamed).toBeGreaterThanOrEqual(0);
    expect(drew).toBeGreaterThan(firstStreamed);
    const drawnBlock = diagram.at(-1)!;
    expect({
      sourceLaidOut: drawnBlock.sourceHeight !== null,
      drawChangedHeight:
        drawnBlock.sourceHeight !== null &&
        drawnBlock.drawnHeight !== null &&
        drawnBlock.sourceHeight !== drawnBlock.drawnHeight,
      sourceHeight: drawnBlock.sourceHeight,
      drawnHeight: drawnBlock.drawnHeight,
    }).toEqual({
      sourceLaidOut: true,
      drawChangedHeight: true,
      sourceHeight: drawnBlock.sourceHeight,
      drawnHeight: drawnBlock.drawnHeight,
    });
    expect(diagram.slice(drew).some((entry) => !entry.finished)).toBe(true);
    // The list keeps following the end: it ends resting about where the plain reply rests, with
    // the last streamed line in view. The two replies stream separately, and on slow runners
    // their final rests differed by 2, 12, 13 and 26 px with both followed throughout (the
    // plain one alternating between two rests a frame apart), so the rests are compared within
    // two lines, which still catches a scroll past the end. The trace records both gaps.
    expect(diagram.some((entry) => entry.fenceShown)).toBe(true);
    expect(plain.some((entry) => entry.fenceShown)).toBe(true);
    expect(Math.abs(diagram.at(-1)!.endGap! - plain.at(-1)!.endGap!)).toBeLessThanOrEqual(
      STREAMED_REST_SLACK_PX,
    );
    expect(diagram.at(-1)!.lastLineInView).toBe(true);
    // Following waits while the sent row glides into place, so on a slow webview the first
    // deliveries, and the draw, can land before the list first catches up with the end. The
    // glide settles within its 750 ms positioning timer and a few frames, so each reply is
    // checked from the earlier of its catch-up and SENT_ROW_SETTLE_MS after its first delivery;
    // a list that catches up late fails on the deliveries in between.
    //
    // The plain reply is bounded on its own: from there on, every delivery comes to rest with
    // the reply's end revealed. Each of those deliveries must have painted a resting frame, so
    // a webview that painted none, or a reply that stayed hidden and caught up only at its end,
    // fails instead of passing on what it did not show.
    const plainRests = restingEnds(plain);
    const plainFrom = settledFrom(plain, () => REVEALED_PX);
    const plainSettled = settledRests(plain, plainFrom);
    expect(missingDeliveries("plain", plain, plainFrom, plainSettled)).toEqual([]);
    expect(hiddenRests("plain", plain, plainFrom, plainSettled, () => REVEALED_PX)).toEqual([]);
    // The diagram's own growth is followed too: after each delivery from the one the diagram
    // drew in, before the next one lands, the reply's end is revealed as far as the plain
    // reply's is, which the check above holds within REVEALED_PX. A delivery the plain reply
    // painted no rest for, before its settling, must simply be revealed. The growth itself is
    // followed once LegendList reports the size and two frames pass, so on a slow runner the
    // next delivery can land first; the draw's delivery then passes when the end shows within
    // DRAW_FOLLOW_MS of the draw.
    const diagramRests = restingEnds(diagram);
    const revealedBelow = (delivered: number) =>
      Math.max(plainRests.get(delivered) ?? 0, 0) + REVEALED_PX;
    const checkedFrom = settledFrom(diagram, revealedBelow);
    const drewAfter = diagram[drew]!.afterParagraphs;
    const drawAt = diagram[drew]!.at;
    const drawFollowed = diagram
      .filter((entry) => entry.at >= drawAt && entry.at <= drawAt + DRAW_FOLLOW_MS)
      .some(
        (entry) =>
          entry.endBelow !== null && entry.endBelow <= revealedBelow(entry.afterParagraphs),
      );
    const diagramSettled = settledRests(diagram, checkedFrom);
    expect(missingDeliveries("diagram", diagram, checkedFrom, diagramSettled)).toEqual([]);
    // The draw's grace covers only a delivery that rested within that time, when the next one
    // landed before the follow; a later rest of that delivery is checked like the others.
    const endsHidden = hiddenRests(
      "diagram",
      diagram,
      checkedFrom,
      new Map(
        [...diagramSettled].filter(
          ([delivered, index]) =>
            delivered >= drewAfter &&
            !(
              delivered === drewAfter &&
              drawFollowed &&
              diagram[index]!.at <= drawAt + DRAW_FOLLOW_MS
            ),
        ),
      ),
      revealedBelow,
    );
    expect(diagramRests.has(drewAfter)).toBe(true);
    expect(endsHidden).toEqual([]);
    // Once settled, neither reply's sent row rests below its offset (#191): a turn taller than
    // the view follows its end, which takes the row above it.
    expect([
      ...sentRowsBelowOffset("plain", plain, plainFrom),
      ...sentRowsBelowOffset("diagram", diagram, checkedFrom),
    ]).toEqual([]);
    await saveEvidence("mermaid-timeline-streaming-follow");
  }).timeout(240_000);

  it("hands the timeline to the reader's keyboard and resumes at the end", async () => {
    await setDesktopUiWindowSize(1_400, 900);
    await openFixtureWorkspace();
    await expectPaintingWebview();
    // A reply with a code block, whose Copy button is the control the reader's keys start from.
    // Focusing it is no pointer press, so it does not stop following by itself.
    await sendPrompt(mermaidFixturePrompts.short);
    await browser.waitUntil(
      () =>
        browser.execute(
          (surface: string) =>
            [...document.querySelectorAll(`${surface} .chat-markdown-mermaid svg`)].some((svg) =>
              svg.textContent?.includes("Kept at the top"),
            ),
          visibleSurfaceSelector,
        ),
      { timeoutMsg: "The short fixture reply's diagram never drew." },
    );
    await scrollTimelineToEnd("After the short diagram.");
    // Page scripts run in the webview, so each looks the button up itself: the lowest short
    // reply's code block's Copy code button.
    const copyMounted = await browser.execute((surface: string) => {
      const button = [
        ...document.querySelectorAll<HTMLElement>(`${surface} .chat-markdown-codeblock`),
      ]
        .filter((block) => block.textContent?.includes("Kept at the top"))
        .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0]
        ?.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]');
      return !!button && button.getBoundingClientRect().height > 0;
    }, visibleSurfaceSelector);
    if (!copyMounted) {
      throw new Error("The short reply's code block shows no mounted Copy code button.");
    }

    await startKeyboardSamples();
    const editor = browser.$(composerEditorSelector);
    await editor.click();
    await editor.addValue(mermaidFixturePrompts.keyboard);
    await expect(editor).toHaveText(mermaidFixturePrompts.keyboard);
    await browser.keys("Enter");
    // As soon as the sent row shows, while it glides into place, the reader moves focus into
    // the timeline and pages up with the keyboard. The packaged driver sends keys as dispatched
    // events, which scroll nothing, so the spec dispatches the keydown on the focused control
    // and then makes the scroll that key's default action makes, as a real key press does
    // (the runbook's manual check covers a real key's ordering against these listeners).
    await browser.waitUntil(
      () =>
        browser.execute(
          (surface: string, prompt: string) =>
            [...document.querySelectorAll(`${surface} [data-message-role="user"]`)].some((row) =>
              row.textContent?.includes(prompt),
            ),
          visibleSurfaceSelector,
          mermaidFixturePrompts.keyboard,
        ),
      { timeoutMsg: "The keyboard prompt's sent row never showed.", interval: 20 },
    );
    // Wait, briefly, for the glide to be under way, so the key lands mid-glide; the trace
    // records whether it did.
    const glideMovingAtKey = await browser.executeAsync(
      (surface: string, prompt: string, done: (moving: boolean) => void) => {
        const top = () => {
          const row = [
            ...document.querySelectorAll<HTMLElement>(`${surface} [data-message-role="user"]`),
          ].find((element) => element.textContent?.includes(prompt));
          return row?.getBoundingClientRect().top ?? null;
        };
        const first = top();
        const started = performance.now();
        const check = () => {
          const now = top();
          if (first !== null && now !== null && Math.abs(now - first) > 4) return done(true);
          if (performance.now() - started > 1_500) return done(false);
          requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      },
      visibleSurfaceSelector,
      mermaidFixturePrompts.keyboard,
    );
    const focused = await browser.execute((surface: string) => {
      const button = [
        ...document.querySelectorAll<HTMLElement>(`${surface} .chat-markdown-codeblock`),
      ]
        .filter((block) => block.textContent?.includes("Kept at the top"))
        .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0]
        ?.querySelector<HTMLButtonElement>('button[aria-label="Copy code"]');
      button?.focus({ preventScroll: true });
      return !!button && document.activeElement === button;
    }, visibleSurfaceSelector);
    if (!focused) throw new Error("The short reply's Copy code button did not take focus.");
    const paged = await pressTimelineKey("PageUp");
    const keyAt = (await readKeyboardSamples()).keyAt;
    if (keyAt === null) {
      throw new Error("The PageUp keydown never reached the timeline's scroller.");
    }
    if (paged.defaultPrevented || paged.before - paged.after < paged.clientHeight / 2) {
      throw new Error(`PageUp did not page the timeline up: ${JSON.stringify(paged)}.`);
    }

    // Once the view has rested, nothing ChatView asked LegendList for moves it again.
    let samples: KeyboardSample[] = [];
    await browser.waitUntil(
      async () => {
        samples = (await readKeyboardSamples()).samples;
        const after = samples.filter((entry) => entry.at > keyAt);
        return (
          after.length >= 4 &&
          after.slice(-4).every((entry) => entry.scrollTop === after.at(-1)!.scrollTop)
        );
      },
      { timeoutMsg: "The timeline never came to rest after PageUp.", interval: 100 },
    );

    // The reader reads a paragraph near the top. It holds within a pixel on every painted frame
    // for three seconds, through the glide's 750 ms settle timer and LegendList's 800 ms wait for
    // rows to settle, either of which would move it if a request ChatView made before the key
    // were still held, and through the deliveries that keep streaming below.
    const readingChosen = await chooseKeyboardReadingLine();
    await browser.pause(3_000);
    samples = (await readKeyboardSamples()).samples;
    const reading = samples.filter(
      (entry) => entry.at >= readingChosen && entry.readingTop !== null,
    );
    const readingLine = reading[0]?.readingTop ?? null;
    expect(readingLine).not.toBeNull();
    const readingMoved = reading
      .filter((entry) => Math.abs(entry.readingTop! - readingLine!) > 1)
      .map((entry) => ({ at: Math.round(entry.at), readingTop: entry.readingTop }));
    const deliveredWhileReading = reading.at(-1)!.delivered - reading[0]!.delivered;
    expect(deliveredWhileReading).toBeGreaterThanOrEqual(5);
    expect(readingMoved).toEqual([]);

    // End returns to the end, and following resumes: every later delivery rests revealed.
    const endAt = (await readKeyboardSamples()).samples.at(-1)!.at;
    const ended = await pressTimelineKey("End");
    if (ended.defaultPrevented)
      throw new Error(`End did not reach the end: ${JSON.stringify(ended)}.`);
    await browser.waitUntil(
      async () => {
        samples = (await readKeyboardSamples()).samples;
        const last = samples.at(-1)!;
        return last.delivered >= 31 && last.at - endAt > 1_500;
      },
      { timeoutMsg: "The keyboard reply never finished after End.", timeout: 30_000 },
    );
    await browser.execute(() =>
      (window as unknown as { __bibcodeKeyboardStop?: () => void }).__bibcodeKeyboardStop?.(),
    );
    NodeFS.writeFileSync(
      NodePath.join(preparedArtifactDirectory, "mermaid-timeline-keyboard-takeover.json"),
      JSON.stringify(
        {
          glideMovingAtKey,
          keyAt: Math.round(keyAt),
          readingChosen: Math.round(readingChosen),
          endAt: Math.round(endAt),
          samples: samples.filter(
            (entry, index, all) =>
              index === 0 ||
              entry.scrollTop !== all[index - 1]!.scrollTop ||
              entry.delivered !== all[index - 1]!.delivered ||
              entry.readingTop !== all[index - 1]!.readingTop ||
              entry.keydowns !== all[index - 1]!.keydowns,
          ),
        },
        null,
        2,
      ),
    );
    const reachedEnd = samples.find((entry) => entry.at > endAt && entry.endGap <= 1);
    expect(reachedEnd).toBeDefined();
    const restsAfterEnd = new Map<number, KeyboardSample>();
    for (const entry of samples) {
      if (entry.at > reachedEnd!.at) restsAfterEnd.set(entry.delivered, entry);
    }
    // The delivery the list reached the end in can rest before following resumes on the next.
    restsAfterEnd.delete(reachedEnd!.delivered);
    expect(restsAfterEnd.size).toBeGreaterThanOrEqual(3);
    const hiddenAfterEnd = [...restsAfterEnd.values()]
      .filter((entry) => entry.endBelow === null || entry.endBelow > REVEALED_PX)
      .map((entry) => ({
        delivered: entry.delivered,
        at: Math.round(entry.at),
        endBelow: entry.endBelow,
      }));
    expect(hiddenAfterEnd).toEqual([]);
    await saveEvidence("mermaid-timeline-keyboard-takeover");
  }).timeout(240_000);
});

/**
 * Samples the timeline after each painted frame for the keyboard case, and counts the keydowns
 * that reach its scroller.
 */
async function startKeyboardSamples(): Promise<void> {
  await browser.execute(
    (surface: string, lastLine: string) => {
      const record = window as unknown as {
        __bibcodeKeyboard?: {
          samples: KeyboardSample[];
          keyAt: number | null;
          reading: HTMLElement | null;
        };
        __bibcodeKeyboardStop?: () => void;
      };
      record.__bibcodeKeyboardStop?.();
      const scroller = document.querySelector<HTMLElement>(`${surface} [class*='overflow-anchor']`);
      if (!scroller) throw new Error("The timeline scroller is missing.");
      const state = {
        samples: [] as KeyboardSample[],
        keyAt: null as number | null,
        reading: null as HTMLElement | null,
      };
      record.__bibcodeKeyboard = state;
      const started = performance.now();
      let keydowns = 0;
      const onKeyDown = (event: KeyboardEvent) => {
        keydowns += 1;
        if (event.key === "PageUp") state.keyAt ??= performance.now() - started;
      };
      // Capture, so the count holds whatever the timeline's own listeners do with the key.
      scroller.addEventListener("keydown", onKeyDown, { capture: true });
      const read = (): KeyboardSample => {
        const paragraphs = [
          ...document.querySelectorAll<HTMLElement>(`${surface} .chat-markdown p`),
        ];
        const area = scroller.getBoundingClientRect();
        const reading = state.reading?.isConnected ? state.reading : null;
        const blocks = [
          ...document.querySelectorAll<HTMLElement>(
            `${surface} .chat-markdown p, ${surface} .chat-markdown-codeblock`,
          ),
        ];
        const end = Math.max(...blocks.map((block) => block.getBoundingClientRect().bottom));
        const composerTop = document
          .querySelector(`${surface} [data-chat-composer-form="true"]`)
          ?.getBoundingClientRect().top;
        return {
          at: performance.now() - started,
          scrollTop: scroller.scrollTop,
          clientHeight: scroller.clientHeight,
          endGap: Math.round(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop),
          endBelow:
            blocks.length === 0
              ? null
              : Math.round(end - Math.min(area.bottom, composerTop ?? area.bottom)),
          delivered:
            paragraphs.filter((element) =>
              element.textContent?.startsWith("Keyboard streamed paragraph"),
            ).length + (paragraphs.some((element) => element.textContent === lastLine) ? 1 : 0),
          readingTop: reading ? reading.getBoundingClientRect().top - area.top : null,
          keydowns,
        };
      };
      let running = true;
      // A message posted from a frame callback is handled once that frame has painted.
      const afterPaint = new MessageChannel();
      afterPaint.port1.addEventListener("message", () => state.samples.push(read()));
      afterPaint.port1.start();
      const onFrame = () => {
        if (!running || performance.now() - started > 60_000) return;
        afterPaint.port2.postMessage(null);
        requestAnimationFrame(onFrame);
      };
      requestAnimationFrame(onFrame);
      record.__bibcodeKeyboardStop = () => {
        running = false;
        scroller.removeEventListener("keydown", onKeyDown, { capture: true });
      };
    },
    visibleSurfaceSelector,
    mermaidFixtureKeyboardLastLine,
  );
}

/**
 * Presses `key` on the focused control inside the timeline: dispatches its keydown, which
 * bubbles to the timeline's own listeners, and then, unless a listener prevented it, makes the
 * scroll the key's default action makes (PageUp: 87.5% of the visible height up; End: to the
 * end). Returns the scroller's offset before and after.
 */
async function pressTimelineKey(
  key: "PageUp" | "End",
): Promise<{ before: number; after: number; clientHeight: number; defaultPrevented: boolean }> {
  return browser.execute(
    (surface: string, pressed: string) => {
      const scroller = document.querySelector<HTMLElement>(`${surface} [class*='overflow-anchor']`);
      const target = document.activeElement;
      if (!scroller || !(target instanceof HTMLElement) || !scroller.contains(target)) {
        throw new Error("No control inside the timeline has focus for the key.");
      }
      const before = scroller.scrollTop;
      const event = new KeyboardEvent("keydown", { key: pressed, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      if (!event.defaultPrevented) {
        if (pressed === "PageUp") scroller.scrollBy({ top: -scroller.clientHeight * 0.875 });
        else scroller.scrollTo({ top: scroller.scrollHeight });
      }
      target.dispatchEvent(new KeyboardEvent("keyup", { key: pressed, bubbles: true }));
      return {
        before,
        after: scroller.scrollTop,
        clientHeight: scroller.clientHeight,
        defaultPrevented: event.defaultPrevented,
      };
    },
    visibleSurfaceSelector,
    key,
  );
}

async function readKeyboardSamples(): Promise<{ samples: KeyboardSample[]; keyAt: number | null }> {
  return browser.execute(() => {
    const state = (
      window as unknown as {
        __bibcodeKeyboard?: { samples: KeyboardSample[]; keyAt: number | null };
      }
    ).__bibcodeKeyboard;
    return { samples: state?.samples ?? [], keyAt: state?.keyAt ?? null };
  });
}

/**
 * Picks the paragraph nearest the visible top that shows whole, as the line being read, and
 * returns the sample time from which it is tracked.
 */
async function chooseKeyboardReadingLine(): Promise<number> {
  return browser.execute((surface: string) => {
    const record = window as unknown as {
      __bibcodeKeyboard?: { samples: Array<{ at: number }>; reading: HTMLElement | null };
    };
    const scroller = document.querySelector<HTMLElement>(`${surface} [class*='overflow-anchor']`)!;
    const area = scroller.getBoundingClientRect();
    const paragraph = [...document.querySelectorAll<HTMLElement>(`${surface} .chat-markdown p`)]
      .map((element) => ({ element, box: element.getBoundingClientRect() }))
      .filter((entry) => entry.box.top >= area.top + 40 && entry.box.bottom <= area.bottom - 160)
      .sort((a, b) => a.box.top - b.box.top)[0];
    if (!paragraph) throw new Error("No paragraph shows whole in the timeline to read.");
    record.__bibcodeKeyboard!.reading = paragraph.element;
    return record.__bibcodeKeyboard!.samples.at(-1)?.at ?? 0;
  }, visibleSurfaceSelector);
}

/**
 * Scrolls the timeline to its end, sends `prompt`, and samples after each painted frame how
 * far the list is from its end until the streamed reply has finished and rested.
 */
async function streamAndSampleEnd(prompt: string): Promise<StreamSample[]> {
  await browser.execute((surface: string) => {
    const scroller = document.querySelector<HTMLElement>(`${surface} [class*='overflow-anchor']`);
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, visibleSurfaceSelector);
  await browser.pause(1_000);
  await browser.execute(
    (surface: string, lastLine: string, sentPrompt: string) => {
      const record = window as unknown as {
        __bibcodeStreamSamples?: StreamSample[];
        __bibcodeStreamStop?: () => void;
      };
      const count = (text: string) =>
        [...document.querySelectorAll<HTMLElement>(`${surface} .chat-markdown p`)].filter(
          (element) => element.textContent === text,
        ).length;
      const fences = () =>
        [...document.querySelectorAll<HTMLElement>(`${surface} .chat-markdown-codeblock`)].filter(
          (element) => element.textContent?.includes("Streamed draw"),
        ).length;
      const drawn = () =>
        [...document.querySelectorAll(`${surface} .chat-markdown-mermaid svg`)].filter((svg) =>
          svg.textContent?.includes("Streamed draw"),
        ).length;
      const afterParagraphs = () =>
        [...document.querySelectorAll<HTMLElement>(`${surface} .chat-markdown p`)].filter(
          (element) => element.textContent?.startsWith("Streamed after paragraph"),
        ).length;
      const introsBefore = count("Streamed reply intro.");
      const afterParagraphsBefore = afterParagraphs();
      const lastLinesBefore = count(lastLine);
      const fencesBefore = fences();
      const drawnBefore = drawn();
      const samples: StreamSample[] = [];
      record.__bibcodeStreamSamples = samples;
      const started = performance.now();
      let running = true;
      // The block this reply streams is the one that was not there before it.
      const blocksBefore = new Set(
        document.querySelectorAll(`${surface} .chat-markdown-codeblock`),
      );
      let sourceHeight: number | null = null;
      let drawnHeight: number | null = null;
      const observeBlock = () => {
        for (const block of document.querySelectorAll<HTMLElement>(
          `${surface} .chat-markdown-codeblock`,
        )) {
          if (blocksBefore.has(block) || !block.textContent?.includes("Streamed draw")) continue;
          const height = Math.round(block.getBoundingClientRect().height);
          if (block.querySelector(".chat-markdown-mermaid svg")) drawnHeight ??= height;
          else sourceHeight ??= height;
        }
      };
      const blockObserver = new MutationObserver(observeBlock);
      blockObserver.observe(document.body, { childList: true, subtree: true });
      const read = (): StreamSample => {
        const scroller = document.querySelector<HTMLElement>(
          `${surface} [class*='overflow-anchor']`,
        );
        return {
          at: performance.now() - started,
          streaming: count("Streamed reply intro.") > introsBefore,
          fenceShown: fences() > fencesBefore,
          finished: count(lastLine) > lastLinesBefore,
          afterParagraphs: afterParagraphs() - afterParagraphsBefore,
          lastLineInView: (() => {
            // Both replies end with the same line, and the list does not keep its rows in DOM
            // order, so the newest reply's line is the lowest one, not the last in the DOM.
            const line = [...document.querySelectorAll<HTMLElement>(`${surface} .chat-markdown p`)]
              .filter((element) => element.textContent === lastLine)
              .map((element) => element.getBoundingClientRect())
              .reduce<DOMRect | undefined>(
                (lowest, rect) => (lowest === undefined || rect.top > lowest.top ? rect : lowest),
                undefined,
              );
            const area = scroller?.getBoundingClientRect();
            return !!line && !!area && line.top >= area.top && line.bottom <= area.bottom;
          })(),
          endGap: scroller
            ? Math.round(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop)
            : null,
          endBelow: (() => {
            // The reply ends with the lowest of its paragraphs and code blocks.
            const blocks = [
              ...document.querySelectorAll<HTMLElement>(
                `${surface} .chat-markdown p, ${surface} .chat-markdown-codeblock`,
              ),
            ];
            const area = scroller?.getBoundingClientRect();
            if (blocks.length === 0 || !area) return null;
            const end = Math.max(...blocks.map((block) => block.getBoundingClientRect().bottom));
            const composerTop = document
              .querySelector(`${surface} [data-chat-composer-form="true"]`)
              ?.getBoundingClientRect().top;
            return Math.round(end - Math.min(area.bottom, composerTop ?? area.bottom));
          })(),
          diagramDrawn: drawn() > drawnBefore,
          sourceHeight,
          drawnHeight,
          sentRowTop: (() => {
            // Both replies' prompts differ; the newest row sent with this one is the lowest.
            const rows = [
              ...document.querySelectorAll<HTMLElement>(`${surface} [data-message-role="user"]`),
            ].filter((row) => row.textContent?.includes(sentPrompt));
            const area = scroller?.getBoundingClientRect();
            if (rows.length === 0 || !area) return null;
            return Math.round(
              Math.max(...rows.map((row) => row.getBoundingClientRect().top)) - area.top,
            );
          })(),
        };
      };
      // A message posted from a frame callback is handled once that frame has painted.
      const afterPaint = new MessageChannel();
      afterPaint.port1.addEventListener("message", () => samples.push(read()));
      afterPaint.port1.start();
      const onFrame = () => {
        if (!running || performance.now() - started > 60_000) return;
        afterPaint.port2.postMessage(null);
        requestAnimationFrame(onFrame);
      };
      requestAnimationFrame(onFrame);
      record.__bibcodeStreamStop = () => {
        running = false;
        blockObserver.disconnect();
      };
    },
    visibleSurfaceSelector,
    mermaidFixtureStreamedLastLine,
    prompt,
  );
  await sendPrompt(prompt);
  await browser.waitUntil(
    () =>
      browser.execute(
        () =>
          (
            window as unknown as { __bibcodeStreamSamples?: StreamSample[] }
          ).__bibcodeStreamSamples?.at(-1)?.finished === true,
      ),
    { timeoutMsg: `The streamed reply to "${prompt}" never finished.`, timeout: 60_000 },
  );
  await browser.pause(1_500);
  return browser.execute(() => {
    const record = window as unknown as {
      __bibcodeStreamSamples?: StreamSample[];
      __bibcodeStreamStop?: () => void;
    };
    record.__bibcodeStreamStop?.();
    return record.__bibcodeStreamSamples ?? [];
  });
}

/**
 * Where the reply's end rests after each delivery once its code block shows: how far it ends
 * below the usable bottom in the last frame before the next delivery, by how many paragraphs
 * after the block were shown then (the last line counts as one more).
 */
function restingEnds(samples: readonly StreamSample[]): Map<number, number> {
  const rests = new Map<number, number>();
  for (const entry of samples) {
    if (!entry.fenceShown || entry.endBelow === null) continue;
    rests.set(entry.afterParagraphs + (entry.finished ? 1 : 0), entry.endBelow);
  }
  return rests;
}

/** The painted frames from `from` on whose sent row starts more than 1 px below its offset. */
function sentRowsBelowOffset(
  reply: string,
  samples: readonly StreamSample[],
  from: number,
): Array<{ reply: string; at: number; sentRowTop: number; expectedAtMost: number }> {
  return samples
    .filter(
      (entry) =>
        entry.at >= from &&
        entry.sentRowTop !== null &&
        entry.sentRowTop > SENT_ROW_ANCHOR_OFFSET + 1,
    )
    .map((entry) => ({
      reply,
      at: Math.round(entry.at),
      sentRowTop: entry.sentRowTop!,
      expectedAtMost: SENT_ROW_ANCHOR_OFFSET + 1,
    }));
}

/** A reply's end counts as revealed this far below the usable bottom: a pixel of rounding. */
const REVEALED_PX = 1;

/** The delivery a sample shows: paragraphs after the code block, and the last line as one more. */
function deliveryOf(entry: StreamSample): number {
  return entry.afterParagraphs + (entry.finished ? 1 : 0);
}

/**
 * When a reply's sent row has settled for the follow checks: the earlier of the first frame
 * whose end is revealed (within `revealedBelow` for its delivery) once its code block shows,
 * and SENT_ROW_SETTLE_MS after its first delivery.
 */
function settledFrom(
  samples: readonly StreamSample[],
  revealedBelow: (delivered: number) => number,
): number {
  const firstStreamed = samples.find((entry) => entry.streaming);
  const caughtUp = samples.find(
    (entry) =>
      entry.fenceShown &&
      entry.endBelow !== null &&
      entry.endBelow <= revealedBelow(entry.afterParagraphs),
  );
  return Math.min(
    caughtUp?.at ?? Number.POSITIVE_INFINITY,
    (firstStreamed?.at ?? Number.POSITIVE_INFINITY) + SENT_ROW_SETTLE_MS,
  );
}

/**
 * Each delivery's resting frame, the last painted frame before the next delivery, for the
 * deliveries that rested at or after `from`, by delivery.
 */
function settledRests(samples: readonly StreamSample[], from: number): Map<number, number> {
  const rests = new Map<number, number>();
  for (const [index, entry] of samples.entries()) {
    if (!entry.fenceShown || entry.endBelow === null) continue;
    rests.set(deliveryOf(entry), index);
  }
  return new Map([...rests].filter(([, index]) => samples[index]!.at >= from));
}

/**
 * The deliveries from the first one shown after the reply settled through its last line that
 * have no resting frame, so nothing showed where their end came to rest. A reply that never
 * settled or finished counts as one missing delivery.
 */
function missingDeliveries(
  reply: string,
  samples: readonly StreamSample[],
  from: number,
  rests: ReadonlyMap<number, number>,
): Array<{ reply: string; delivered: number; settledFrom: number }> {
  const finished = samples.find((entry) => entry.finished);
  if (!Number.isFinite(from) || !finished) {
    return [{ reply, delivered: Number.NaN, settledFrom: from }];
  }
  const firstSettled = samples.find((entry) => entry.fenceShown && entry.at >= from);
  if (!firstSettled) {
    return [{ reply, delivered: Number.NaN, settledFrom: Math.round(from) }];
  }
  const first = deliveryOf(firstSettled);
  const last = deliveryOf(finished);
  const missing: Array<{ reply: string; delivered: number; settledFrom: number }> = [];
  for (let delivered = first; delivered <= last; delivered += 1) {
    if (!rests.has(delivered)) missing.push({ reply, delivered, settledFrom: Math.round(from) });
  }
  return missing;
}

/** The resting frames in `rests` whose reply's end lies further below than `revealedBelow`. */
function hiddenRests(
  reply: string,
  samples: readonly StreamSample[],
  from: number,
  rests: ReadonlyMap<number, number>,
  revealedBelow: (delivered: number) => number,
): Array<{
  reply: string;
  delivered: number;
  at: number;
  endBelow: number;
  allowed: number;
  settledFrom: number;
}> {
  return [...rests]
    .map(([delivered, index]) => ({
      reply,
      delivered,
      at: Math.round(samples[index]!.at),
      endBelow: samples[index]!.endBelow!,
      allowed: revealedBelow(delivered),
      settledFrom: Math.round(from),
    }))
    .filter((rest) => rest.endBelow > rest.allowed);
}

/**
 * For each delivery once the code block shows, how many painted frames passed from its first
 * frame until the reply's end was revealed, or null when it was not revealed before the next.
 */
function framesToReveal(samples: readonly StreamSample[]): Record<number, number | null> {
  const frames: Record<number, number | null> = {};
  let current: number | null = null;
  let count = 0;
  for (const entry of samples) {
    if (!entry.fenceShown || entry.endBelow === null) continue;
    const delivered = deliveryOf(entry);
    if (delivered !== current) {
      current = delivered;
      count = 0;
      frames[delivered] = null;
    }
    if (frames[delivered] === null && entry.endBelow <= REVEALED_PX) frames[delivered] = count;
    count += 1;
  }
  return frames;
}

/** The samples where something changed, for a trace artifact that holds no message text. */
function streamChanges(samples: readonly StreamSample[]): StreamSample[] {
  return samples.filter(
    (entry, index, all) =>
      index === 0 ||
      entry.streaming !== all[index - 1]!.streaming ||
      entry.fenceShown !== all[index - 1]!.fenceShown ||
      entry.finished !== all[index - 1]!.finished ||
      entry.afterParagraphs !== all[index - 1]!.afterParagraphs ||
      entry.endGap !== all[index - 1]!.endGap ||
      entry.endBelow !== all[index - 1]!.endBelow ||
      entry.diagramDrawn !== all[index - 1]!.diagramDrawn ||
      entry.sentRowTop !== all[index - 1]!.sentRowTop,
  );
}
