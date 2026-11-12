// @effect-diagnostics nodeBuiltinImport:off - Packaged UI tests read the fixture TUI's size log and retain failure artifacts.
// @effect-diagnostics globalDate:off - The seeded loop stamps its own failure report.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { refreshDesktopUiDocument } from "../support/document-navigation.ts";
import {
  fixtureTuiLogPath,
  openFixtureCodexTerminal,
  openFixtureTerminalThread,
  readFixtureTuiSize,
  settleFixtureTui,
  type FixtureTuiSize,
} from "../support/fixture-terminal.ts";
import { installDesktopUiMotionGuard } from "../support/motion-guard.ts";
import { clearDesktopActivityMarker } from "../support/test-project.ts";
import { setDesktopUiWindowSize } from "../support/ui-state.ts";

/**
 * #348: an agent CLI in a center-panel terminal suddenly loses its bottom lines
 * or its whole footer until a layout change repaints it. This loop drives
 * seeded layout actions around a Codex Terminal running the fixture TUI, which
 * draws a footer on its last three rows and logs every PTY size it is given,
 * and after each step (and again 1.5 s later) checks that:
 *   - the PTY's rows (the TUI's last logged size) equal the rows xterm draws;
 *   - the rows xterm draws equal the rows that fit its mount;
 *   - the last row's bottom edge is inside every clipping ancestor; and
 *   - with the DOM renderer, the footer text is on the last row (or, with
 *     BIBCODE_E2E_FOOTER_LAYOUT=floating, appears exactly once at the current size).
 * BIBCODE_E2E_FOOTER_LAYOUT=cli runs an Ink-like program that rewrites a bottom frame every
 * 100 ms above a long transcript, and also checks that the viewport stays at the bottom.
 * BIBCODE_E2E_FOOTER_RENDERER=dom turns the WebGL renderer off, so every check reads the text.
 * BIBCODE_E2E_FOOTER_CHAT=1 adds chat sends and a growing composer to the actions.
 * BIBCODE_E2E_FOOTER_SEED and BIBCODE_E2E_FOOTER_STEPS replay or lengthen a run.
 */

const artifactDirectory = process.env.BIBCODE_E2E_ARTIFACT_DIR;
const projectPath = process.env.BIBCODE_E2E_PROJECT_PATH;
const shimDirectory = process.env.BIBCODE_E2E_SHIM_DIRECTORY;
if (!artifactDirectory || !projectPath || !shimDirectory) {
  throw new Error("The packaged desktop UI fixture environment was not prepared.");
}
const preparedArtifactDirectory: string = artifactDirectory;
const preparedProjectPath: string = projectPath;
const isWindowsE2e = process.env.BIBCODE_E2E_PLATFORM === "win";
const preparedCodexExecutable = NodePath.join(shimDirectory, isWindowsE2e ? "codex.cmd" : "codex");
const tuiLogPath = fixtureTuiLogPath(preparedProjectPath);

function readPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${raw}.`);
  }
  return value;
}
const seed = readPositiveInteger("BIBCODE_E2E_FOOTER_SEED", 348);
const stepCount = readPositiveInteger("BIBCODE_E2E_FOOTER_STEPS", 40);
/** "floating" runs a frame drawn in the normal buffer (like Claude's CLI), not pinned to the last row. */
const floatingLayout = process.env.BIBCODE_E2E_FOOTER_LAYOUT === "floating";
const cliLayout = process.env.BIBCODE_E2E_FOOTER_LAYOUT === "cli";
const domRenderer = process.env.BIBCODE_E2E_FOOTER_RENDERER === "dom";
const chatActions = process.env.BIBCODE_E2E_FOOTER_CHAT === "1";

/** mulberry32: small, deterministic, and enough to replay a failing sequence. */
function createRandom(initial: number): () => number {
  let state = initial >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type TuiSize = FixtureTuiSize;

function readTuiSize(): TuiSize | null {
  return readFixtureTuiSize(tuiLogPath);
}

interface TerminalGeometry {
  readonly found: boolean;
  readonly renderer: "dom" | "webgl" | "none";
  readonly mountHeight: number;
  readonly mountPaddingY: number;
  readonly screenHeight: number;
  readonly screenBottom: number;
  readonly domRows: number | null;
  readonly lastRows: ReadonlyArray<string>;
  /** Every drawn row that holds the footer's last line, whatever its position. */
  readonly footerRows: ReadonlyArray<string>;
  readonly clippedBy: ReadonlyArray<{ readonly element: string; readonly overflow: number }>;
  readonly notice: boolean;
  /**
   * Pixels between the end of xterm's scrollbar slider and the end of its track, or null when
   * the slider or a track with height is missing (a renamed class must not pass as 0).
   */
  readonly scrollGap: number | null;
  readonly viewport: { readonly width: number; readonly height: number };
}

function readTerminalGeometry(terminalId: string): Promise<TerminalGeometry> {
  return browser.execute((id: string): TerminalGeometry => {
    const empty: TerminalGeometry = {
      found: false,
      renderer: "none",
      mountHeight: 0,
      mountPaddingY: 0,
      screenHeight: 0,
      screenBottom: 0,
      domRows: null,
      lastRows: [],
      footerRows: [],
      clippedBy: [],
      notice: false,
      scrollGap: null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
    const mount = document.querySelector<HTMLElement>(
      `[data-terminal-xterm-mount="${CSS.escape(id)}"]`,
    );
    // A center column collapsed behind a maximized right panel keeps its height but has no
    // width: nothing is shown, and the terminal deliberately keeps its last size (c192a96c7).
    const mountRect = mount?.getBoundingClientRect();
    if (!mount || !mountRect || mountRect.height <= 0 || mountRect.width <= 0) return empty;
    if (mount.closest('[data-visible="false"]') || getComputedStyle(mount).visibility === "hidden")
      return empty;
    // A maximized right panel can also cover a center column that keeps its size: what is
    // drawn at the mount's corner then belongs to the panel, and the terminal is not shown.
    const probe = document.elementFromPoint(
      mountRect.left + Math.min(8, mountRect.width / 2),
      mountRect.top + Math.min(8, mountRect.height / 2),
    );
    if (!probe || !mount.contains(probe)) return empty;
    const xterm = mount.querySelector<HTMLElement>(".xterm");
    const screen = mount.querySelector<HTMLElement>(".xterm-screen");
    if (!xterm || !screen) return empty;
    const rowsElement = mount.querySelector<HTMLElement>(".xterm-rows");
    const webglCanvas = [...screen.querySelectorAll("canvas")].some(
      (canvas) => !canvas.classList.contains("xterm-link-layer") && canvas.style.display !== "none",
    );
    const domRows = !webglCanvas && rowsElement ? rowsElement.children.length : null;
    const xtermStyle = getComputedStyle(xterm);
    const screenRect = screen.getBoundingClientRect();
    const clippedBy: Array<{ element: string; overflow: number }> = [];
    for (
      let element: HTMLElement | null = mount;
      element && element !== document.documentElement;
      element = element.parentElement
    ) {
      const overflowY = getComputedStyle(element).overflowY;
      if (element !== mount && !/(hidden|clip|auto|scroll)/.test(overflowY)) continue;
      const overflow = screenRect.bottom - element.getBoundingClientRect().bottom;
      if (overflow > 0.5) {
        clippedBy.push({
          element: `${element.tagName.toLowerCase()}.${String(element.className).slice(0, 80)}`,
          overflow,
        });
      }
    }
    if (screenRect.bottom - window.innerHeight > 0.5) {
      clippedBy.push({ element: "viewport", overflow: screenRect.bottom - window.innerHeight });
    }
    return {
      found: true,
      renderer: webglCanvas ? "webgl" : rowsElement ? "dom" : "none",
      mountHeight: mount.clientHeight,
      mountPaddingY:
        Number.parseFloat(xtermStyle.paddingTop) + Number.parseFloat(xtermStyle.paddingBottom),
      screenHeight: screenRect.height,
      screenBottom: screenRect.bottom,
      domRows,
      lastRows:
        domRows === null
          ? []
          : [...rowsElement!.children].slice(-3).map((row) => (row.textContent ?? "").trimEnd()),
      footerRows:
        domRows === null
          ? []
          : [...rowsElement!.children]
              .map((row) => (row.textContent ?? "").trimEnd())
              .filter((text) => text.includes("fixture-footer-z")),
      clippedBy,
      notice: (mount.parentElement?.textContent ?? "").includes("Sized for another window"),
      // xterm 6 scrolls a virtual element, not .xterm-viewport: its vertical slider ends at
      // the bottom of its track exactly when the viewport is at the bottom.
      // xterm 6.1 renames the classes to `.xterm-scrollbar` and `.xterm-slider`.
      scrollGap: (() => {
        const slider = mount.querySelector<HTMLElement>(
          ".scrollbar.vertical > .slider, .xterm-scrollbar.vertical > .xterm-slider, .xterm-scrollbar > .xterm-slider",
        );
        const track = slider?.parentElement;
        return slider && track && track.clientHeight > 0
          ? Math.round(track.clientHeight - slider.offsetTop - slider.offsetHeight)
          : null;
      })(),
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  }, terminalId);
}

interface Check {
  readonly at: string;
  readonly tui: TuiSize | null;
  readonly geometry: TerminalGeometry;
  readonly xtermRows: number | null;
  readonly fitRows: number | null;
  readonly violations: ReadonlyArray<string>;
}

/**
 * The cell height is fixed for a session (font, size and scale do not change
 * here), so it is measured once from a settled terminal and then turns screen
 * and mount heights into row counts for either renderer.
 */
let cellHeight: number | null = null;

function evaluate(at: string, tui: TuiSize | null, geometry: TerminalGeometry): Check {
  const violations: string[] = [];
  if (!geometry.found) {
    return { at, tui, geometry, xtermRows: null, fitRows: null, violations };
  }
  const xtermRows =
    geometry.domRows ?? (cellHeight ? Math.round(geometry.screenHeight / cellHeight) : null);
  const fitRows = cellHeight
    ? Math.floor((geometry.mountHeight - geometry.mountPaddingY) / cellHeight + 1e-6)
    : null;
  if (tui === null) violations.push("the fixture TUI never logged a size");
  else if (xtermRows !== null && tui.rows !== xtermRows)
    violations.push(`PTY has ${tui.rows} rows but xterm draws ${xtermRows}`);
  if (xtermRows !== null && fitRows !== null && xtermRows !== fitRows && !geometry.notice)
    violations.push(`xterm draws ${xtermRows} rows but ${fitRows} fit its mount`);
  for (const clip of geometry.clippedBy)
    violations.push(`the last row is ${clip.overflow.toFixed(1)}px below ${clip.element}`);
  // A program writing a transcript keeps the viewport pinned to the bottom.
  if (cliLayout && geometry.scrollGap === null)
    violations.push("xterm's scroll bar slider or its track was not found");
  else if (cliLayout && geometry.scrollGap !== null && geometry.scrollGap > 1)
    violations.push(`the viewport is scrolled up (slider ${geometry.scrollGap}px above its end)`);
  if (floatingLayout) {
    // A frame drawn in the normal buffer sits wherever the cursor was, so only its count is
    // known: the footer must appear exactly once at the current size, never stale or doubled.
    if (geometry.renderer === "dom" && tui !== null) {
      const expected = `fixture-footer-z ${tui.rows}`;
      // A narrow terminal truncates the footer; a cut-off prefix still counts as it.
      const current = geometry.footerRows.filter(
        (text) => text.startsWith(expected) || expected.startsWith(text),
      );
      if (current.length !== 1)
        violations.push(
          `the footer appears ${current.length} times at ${tui.rows} rows: ${JSON.stringify(geometry.footerRows)}`,
        );
    }
  } else if (geometry.renderer === "dom" && tui !== null && tui.rows >= 5) {
    // A narrower terminal wraps the footer's lines (the full-screen TUI; a later reflow then
    // merges rows) or cuts them at the width less one column (the cli program), so the text is
    // checked only where its longest line fits.
    const expected = `fixture-footer-z ${tui.rows}`;
    const longest = `fixture-footer-a ${tui.cols}x${tui.rows}`;
    if (tui.cols > longest.length && !(geometry.lastRows.at(-1) ?? "").startsWith(expected))
      violations.push(`the footer is not on the last row: ${JSON.stringify(geometry.lastRows)}`);
  }
  return { at, tui, geometry, xtermRows, fitRows, violations };
}

async function settle(): Promise<void> {
  await settleFixtureTui(tuiLogPath);
}

interface Session {
  readonly terminalId: string;
  readonly steps: string[];
  readonly checks: Check[];
}

async function failWith(session: Session, check: Check): Promise<never> {
  const stamp = `${seed}-${session.steps.length}-${Date.now()}`;
  const screenshot = NodePath.join(preparedArtifactDirectory, `terminal-footer-${stamp}.png`);
  await browser.saveScreenshot(screenshot).catch(() => undefined);
  const report = {
    seed,
    stepCount,
    stepsSoFar: session.steps,
    failing: check,
    recentChecks: session.checks.slice(-6),
    cellHeight,
    screenshot,
  };
  NodeFS.writeFileSync(
    NodePath.join(preparedArtifactDirectory, `terminal-footer-${stamp}.json`),
    JSON.stringify(report, null, 2),
  );
  throw new Error(
    `#348 footer invariant broke after step ${session.steps.length} (seed ${seed}): ${check.violations.join("; ")}. ` +
      `Steps: ${session.steps.join(" | ")}. Report: ${JSON.stringify(report)}`,
  );
}

/**
 * A settling check only records: a size change is in flight for a moment after
 * a reload, a split, or a reconnect. The check 1.5 s later is the one that fails.
 */
async function assertInvariant(session: Session, at: string, final = true): Promise<void> {
  const check = evaluate(at, readTuiSize(), await readTerminalGeometry(session.terminalId));
  session.checks.push(check);
  if (final && check.violations.length > 0) await failWith(session, check);
}

const terminalTab =
  '//*[@data-center-panel-tab-list]//button[.//span[normalize-space()="Codex Terminal"]]';
const chatTab = '//*[@data-center-panel-tab-list]//button[.//span[normalize-space()="Codex"]]';

async function clickIfUsable(selector: string): Promise<boolean> {
  const element = browser.$(selector);
  if (!(await element.isExisting()) || !(await element.isDisplayed())) return false;
  if (!(await element.isEnabled())) return false;
  await element.click();
  return true;
}

async function showTerminal(): Promise<void> {
  await clickIfUsable(terminalTab);
}

/** Rewrites the persisted center layout for the fixture thread, then reloads to apply it. */
async function setSplit(terminalId: string, split: boolean): Promise<void> {
  await browser.execute(
    (id: string, wantSplit: boolean) => {
      const key = "bibcode:center-panel-state:v1";
      const persisted = JSON.parse(window.localStorage.getItem(key) ?? "{}") as {
        state?: {
          byThreadKey?: Record<
            string,
            {
              surfaces: ReadonlyArray<{ id: string }>;
              groups: unknown;
              layout: unknown;
              focusedGroupId: unknown;
            }
          >;
        };
      };
      const surfaceId = `terminal:${id}`;
      for (const thread of Object.values(persisted.state?.byThreadKey ?? {})) {
        if (!thread.surfaces.some((surface) => surface.id === surfaceId)) continue;
        Object.assign(
          thread,
          wantSplit
            ? {
                groups: [
                  { id: "center:root", surfaceIds: ["chat:host"], activeSurfaceId: "chat:host" },
                  {
                    id: "center-group:footer-split",
                    surfaceIds: [surfaceId],
                    activeSurfaceId: surfaceId,
                  },
                ],
                layout: {
                  type: "split",
                  direction: "horizontal",
                  ratio: 0.5,
                  first: { type: "leaf", groupId: "center:root" },
                  second: { type: "leaf", groupId: "center-group:footer-split" },
                },
                focusedGroupId: "center-group:footer-split",
              }
            : {
                groups: [
                  {
                    id: "center:root",
                    surfaceIds: ["chat:host", surfaceId],
                    activeSurfaceId: surfaceId,
                  },
                ],
                layout: { type: "leaf", groupId: "center:root" },
                focusedGroupId: "center:root",
              },
        );
      }
      window.localStorage.setItem(key, JSON.stringify(persisted));
    },
    terminalId,
    split,
  );
  await reloadDocument();
}

/** A chat action can leave the chat tab active, and the terminal mounts only when shown. */
async function showTerminalAfterChat(): Promise<void> {
  if (!chatActions) return;
  await browser
    .$(terminalTab)
    .waitForExist({ timeout: 15_000 })
    .catch(() => undefined);
  await showTerminal();
}

async function reloadDocument(): Promise<void> {
  await refreshDesktopUiDocument();
  await installDesktopUiMotionGuard();
  await showTerminalAfterChat();
  await browser.$(`[data-terminal-xterm-mount]`).waitForExist({
    timeout: 30_000,
    timeoutMsg: "The terminal did not mount again after a reload.",
  });
}

async function dragRightPanelEdge(dx: number): Promise<boolean> {
  const handle = browser.$('[role="separator"][aria-orientation="vertical"].cursor-col-resize');
  if (!(await handle.isExisting()) || !(await handle.isDisplayed())) return false;
  const location = await handle.getLocation();
  const size = await handle.getSize();
  const x = Math.round(location.x + size.width / 2);
  const y = Math.round(location.y + size.height / 2);
  try {
    // A real pointer drag: the handle captures the pointer, which synthetic events cannot.
    await browser
      .action("pointer", { parameters: { pointerType: "mouse" } })
      .move({ x, y })
      .down()
      .move({ x: x + Math.round(dx / 2), y, duration: 100 })
      .move({ x: x + dx, y, duration: 100 })
      .up()
      .perform();
    return true;
  } catch {
    // The embedded driver may not implement pointer actions; the step is skipped.
    return false;
  }
}

type Action = (session: Session, random: () => number) => Promise<string | null>;

const actions: ReadonlyArray<readonly [string, Action]> = [
  [
    "right panel toggle",
    async () =>
      (await clickIfUsable('button[aria-label="Toggle right panel"]'))
        ? "toggle right panel"
        : null,
  ],
  [
    "right panel maximize",
    async () => {
      if (await clickIfUsable('button[aria-label="Maximize panel"]')) return "maximize right panel";
      if (await clickIfUsable('button[aria-label="Restore panel size"]'))
        return "restore right panel";
      return null;
    },
  ],
  [
    "right panel edge drag",
    async (_session, random) => {
      const dx = Math.round((random() - 0.5) * 400);
      return (await dragRightPanelEdge(dx)) ? `drag right panel edge ${dx}px` : null;
    },
  ],
  [
    "activity panel",
    async (session) => {
      const button = `[data-provider-terminal-activity-host="${session.terminalId}"] [data-testid="activity-dock"] button`;
      return (await clickIfUsable(button)) ? "toggle terminal Activity panel" : null;
    },
  ],
  [
    "center split",
    async (session, random) => {
      const split = random() < 0.5;
      await setSplit(session.terminalId, split);
      return split ? "split center (reload)" : "unsplit center (reload)";
    },
  ],
  [
    "tab switch",
    async () => {
      if (!(await clickIfUsable(chatTab))) return null;
      await browser.pause(300);
      await showTerminal();
      return "switch to chat tab and back";
    },
  ],
  [
    "route switch",
    async () => {
      const current = await browser.getUrl();
      const origin = await browser.execute(() => window.location.origin);
      await browser.url(`${origin}/#/settings/terminal`);
      await browser.pause(500);
      await browser.url(current);
      await showTerminalAfterChat();
      await browser.$(`[data-terminal-xterm-mount]`).waitForExist({ timeout: 15_000 });
      await showTerminal();
      return "open settings and come back";
    },
  ],
  [
    "sidebar",
    async () =>
      (await clickIfUsable('button[aria-label="Toggle main sidebar"]'))
        ? "toggle main sidebar"
        : null,
  ],
  [
    "window resize",
    async (session, random) => {
      const viewport = session.checks.at(-1)?.geometry.viewport ?? { width: 1_200, height: 720 };
      const width = 960 + Math.round(random() * 440);
      const height = 560 + Math.round(random() * 300);
      const mode = random();
      const next =
        mode < 1 / 3
          ? { width: viewport.width, height }
          : mode < 2 / 3
            ? { width, height: viewport.height }
            : { width, height };
      try {
        await setDesktopUiWindowSize(next.width, next.height);
      } catch {
        // Some window managers (GTK under Xvfb) settle near the size but never on it; the
        // invariant holds at whatever size the window reached, so the step records that.
        const reached = await browser.execute(() => `${window.innerWidth}x${window.innerHeight}`);
        return `resize window toward ${next.width}x${next.height} (reached ${reached})`;
      }
      return `resize window to ${next.width}x${next.height}`;
    },
  ],
  [
    "reload",
    async () => {
      await reloadDocument();
      await showTerminal();
      return "reload and reattach";
    },
  ],
];

let chatMessages = 0;
const visibleComposer =
  '[data-center-surface-host][data-visible="true"] [data-testid="composer-editor"]';

/** Uses the chat beside (or instead of) the terminal: a send, or a composer that grows and empties. */
function chatAction(kind: "send" | "grow"): Action {
  return async (_session, random) => {
    let composer = browser.$(visibleComposer);
    let switched = false;
    if (!(await composer.isExisting()) || !(await composer.isDisplayed())) {
      if (!(await clickIfUsable(chatTab))) return null;
      switched = true;
      composer = browser.$(visibleComposer);
      if (!(await composer.isDisplayed().catch(() => false))) return null;
    }
    await composer.click();
    if (kind === "send") {
      chatMessages += 1;
      await composer.addValue(`fixture message ${chatMessages}`);
      await browser.keys("Enter");
      await browser.pause(400 + Math.round(random() * 1_200));
    } else {
      for (let line = 0; line < 6; line += 1) {
        await composer.addValue(`grow line ${line}`);
        await browser.keys(["Shift", "Enter"]);
      }
      await browser.pause(600);
      // Select the draft without a platform shortcut (Control+A is not select-all on macOS).
      await browser.execute(() => {
        const editor = document.activeElement;
        if (!(editor instanceof HTMLElement)) return;
        const range = document.createRange();
        range.selectNodeContents(editor);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
      });
      await browser.keys("Backspace");
    }
    if (switched && random() < 0.7) await showTerminal();
    return `chat ${kind}${switched ? " via the chat tab" : " beside the terminal"}`;
  };
}

const actionList: ReadonlyArray<readonly [string, Action]> = chatActions
  ? [
      ...actions,
      ["chat send", chatAction("send")],
      ["chat send", chatAction("send")],
      // The center split already puts the chat beside the terminal.
      ["composer grow", chatAction("grow")],
    ]
  : actions;

async function openFixtureThread(): Promise<void> {
  await openFixtureTerminalThread(preparedProjectPath, preparedCodexExecutable, {
    webglEnabled: !domRenderer,
  });
}

async function openCodexTerminal(): Promise<string> {
  return await openFixtureCodexTerminal();
}

describe("packaged AI terminal footer invariant (#348)", () => {
  it("keeps the PTY, xterm and the visible mount in agreement across seeded layout changes", async function () {
    // Each step takes about 3 s; the configured case timeout alone ends the loop near step 40.
    // Setup and the chat mode's turns add up to a minute on a loaded host before the first step.
    this.timeout(Math.max(this.timeout(), 120_000 + stepCount * 20_000));
    clearDesktopActivityMarker(preparedProjectPath);
    await setDesktopUiWindowSize(1_200, 720);
    await openFixtureThread();
    const logStart = readTuiSize()?.bytes ?? 0;
    const terminalId = await openCodexTerminal();
    await browser.waitUntil(async () => (readTuiSize()?.bytes ?? 0) > logStart, {
      timeout: 30_000,
      timeoutMsg: "The fixture TUI never drew in the Codex Terminal.",
    });
    await settle();
    // The Activity dock mounts 0.4 s or so after the terminal and shrinks it, and the refit
    // lands about 100 ms later: the baseline waits for the dock, then for that size to hold.
    const dockMounted = await browser
      .$(`[data-provider-terminal-activity-host="${terminalId}"] [data-testid="activity-dock"]`)
      .waitForExist({ timeout: 5_000 })
      .then(
        () => true,
        () => false,
      );
    if (dockMounted) await settle();

    const baseline = await readTerminalGeometry(terminalId);
    const baselineTui = readTuiSize();
    if (!baseline.found || baselineTui === null) {
      throw new Error(`The terminal did not settle: ${JSON.stringify({ baseline, baselineTui })}`);
    }
    // The first settled frame defines the cell height every later check uses.
    cellHeight = baseline.screenHeight / (baseline.domRows ?? baselineTui.rows);

    const session: Session = { terminalId, steps: [], checks: [] };
    await assertInvariant(session, "baseline");

    const random = createRandom(seed);
    for (let index = 0; index < stepCount; index += 1) {
      const [name, run] = actionList[Math.floor(random() * actionList.length)]!;
      const description = await run(session, random);
      session.steps.push(description ?? `${name} (unavailable, skipped)`);
      await settle();
      await assertInvariant(session, `step ${index + 1}`, false);
      await browser.pause(1_500);
      await assertInvariant(session, `step ${index + 1} +1.5s`);
    }
    NodeFS.writeFileSync(
      NodePath.join(preparedArtifactDirectory, `terminal-footer-${seed}-passed.json`),
      JSON.stringify(
        {
          seed,
          stepCount,
          steps: session.steps,
          cellHeight,
          // Settling checks that disagreed and cleared within 1.5 s, and the renderers seen.
          transients: session.checks.filter((check) => check.violations.length > 0),
          renderers: [...new Set(session.checks.map((check) => check.geometry.renderer))],
        },
        null,
        2,
      ),
    );
  });
});
