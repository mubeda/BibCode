// @effect-diagnostics nodeBuiltinImport:off - Packaged UI tests read the fixture TUI's size log and retain failure artifacts.
// @effect-diagnostics globalDate:off - The seeded loop stamps its own failure report.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  configureDesktopActivityCodexExecutable,
  materializeDesktopActivitySession,
} from "../support/activity-session.ts";
import { desktopActivityFixture } from "../support/activity-events.ts";
import { refreshDesktopUiDocument } from "../support/document-navigation.ts";
import { installDesktopUiMotionGuard } from "../support/motion-guard.ts";
import { clearDesktopActivityMarker } from "../support/test-project.ts";
import { ensureMainSidebarOpen, setDesktopUiWindowSize } from "../support/ui-state.ts";

/**
 * #348: an agent CLI in a center-panel terminal suddenly loses its bottom lines
 * or its whole footer until a layout change repaints it. This loop drives
 * seeded layout actions around a Codex Terminal running the fixture TUI, which
 * draws a footer on its last three rows and logs every PTY size it is given,
 * and after each step (and again 1.5 s later) checks that:
 *   - the PTY's rows (the TUI's last logged size) equal the rows xterm draws;
 *   - the rows xterm draws equal the rows that fit its mount;
 *   - the last row's bottom edge is inside every clipping ancestor; and
 *   - with the DOM renderer, the footer text is on the last row.
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
const tuiLogPath = NodePath.join(preparedProjectPath, ".git", "bibcode-fixture-tui-sizes.log");

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

interface TuiSize {
  readonly cols: number;
  readonly rows: number;
  readonly bytes: number;
}

function readTuiSize(): TuiSize | null {
  if (!NodeFS.existsSync(tuiLogPath)) return null;
  const log = NodeFS.readFileSync(tuiLogPath);
  const last = log.toString("utf8").trim().split("\n").at(-1);
  const match = last ? /^(\d+)x(\d+)$/.exec(last) : null;
  return match ? { cols: Number(match[1]), rows: Number(match[2]), bytes: log.length } : null;
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
  readonly clippedBy: ReadonlyArray<{ readonly element: string; readonly overflow: number }>;
  readonly notice: boolean;
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
      clippedBy: [],
      notice: false,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
    const mount = document.querySelector<HTMLElement>(
      `[data-terminal-xterm-mount="${CSS.escape(id)}"]`,
    );
    if (!mount || mount.getBoundingClientRect().height <= 0) return empty;
    if (mount.closest('[data-visible="false"]') || getComputedStyle(mount).visibility === "hidden")
      return empty;
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
      clippedBy,
      notice: (mount.parentElement?.textContent ?? "").includes("Sized for another window"),
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
  if (geometry.renderer === "dom" && tui !== null && tui.rows >= 5) {
    if (!geometry.lastRows.at(-1)?.startsWith(`fixture-footer-z ${tui.rows}`))
      violations.push(`the footer is not on the last row: ${JSON.stringify(geometry.lastRows)}`);
  }
  return { at, tui, geometry, xtermRows, fitRows, violations };
}

async function settle(): Promise<void> {
  // The TUI redraws on every SIGWINCH; a size that holds for 400 ms is final.
  const deadline = Date.now() + 5_000;
  let previous = readTuiSize()?.bytes ?? 0;
  while (Date.now() < deadline) {
    await browser.pause(400);
    const current = readTuiSize()?.bytes ?? 0;
    if (current === previous) return;
    previous = current;
  }
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

async function assertInvariant(session: Session, at: string): Promise<void> {
  const check = evaluate(at, readTuiSize(), await readTerminalGeometry(session.terminalId));
  session.checks.push(check);
  if (check.violations.length > 0) await failWith(session, check);
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

async function reloadDocument(): Promise<void> {
  await refreshDesktopUiDocument();
  await installDesktopUiMotionGuard();
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
      await setDesktopUiWindowSize(next.width, next.height);
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

async function openFixtureThread(): Promise<void> {
  await ensureMainSidebarOpen();
  await materializeDesktopActivitySession(preparedProjectPath);
  await configureDesktopActivityCodexExecutable(preparedCodexExecutable);
  await refreshDesktopUiDocument();
  await installDesktopUiMotionGuard();
  const threadRow = `//*[starts-with(@data-testid, "thread-row-") and .//*[normalize-space()="${desktopActivityFixture.thread.title}"]]`;
  if (!(await browser.$(threadRow).isDisplayed())) {
    const project = browser.$(
      `//button[@data-sidebar="menu-button" and .//*[normalize-space()="${desktopActivityFixture.project.title}"]]`,
    );
    await project.waitForDisplayed({ timeoutMsg: "The fixture project did not appear." });
    if ((await project.getAttribute("aria-expanded")) !== "true") await project.click();
  }
  for (const candidate of await browser.$$(threadRow)) {
    if (await candidate.isDisplayed()) {
      await candidate.click();
      break;
    }
  }
  await browser.$('[data-testid="composer-editor"]').waitForDisplayed({
    timeoutMsg: "The fixture thread did not open.",
  });
}

async function openCodexTerminal(): Promise<string> {
  const newPanel = browser.$('button[aria-label="New panel"]');
  await newPanel.waitForDisplayed();
  await newPanel.click();
  const item = browser.$('//*[@role="menuitem"][.//span[normalize-space()="Codex Terminal"]]');
  await item.waitForDisplayed();
  await item.waitForEnabled();
  await item.click();
  const mount = browser.$("[data-terminal-xterm-mount]");
  await mount.waitForExist({ timeoutMsg: "The Codex Terminal did not mount." });
  const terminalId = await mount.getAttribute("data-terminal-xterm-mount");
  if (!terminalId) throw new Error("The Codex Terminal mount has no terminal id.");
  return terminalId;
}

describe("packaged AI terminal footer invariant (#348)", () => {
  it("keeps the PTY, xterm and the visible mount in agreement across seeded layout changes", async () => {
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
      const [name, run] = actions[Math.floor(random() * actions.length)]!;
      const description = await run(session, random);
      session.steps.push(description ?? `${name} (unavailable, skipped)`);
      await settle();
      await assertInvariant(session, `step ${index + 1}`);
      await browser.pause(1_500);
      await assertInvariant(session, `step ${index + 1} +1.5s`);
    }
    NodeFS.writeFileSync(
      NodePath.join(preparedArtifactDirectory, `terminal-footer-${seed}-passed.json`),
      JSON.stringify({ seed, stepCount, steps: session.steps, cellHeight }, null, 2),
    );
  });
});
