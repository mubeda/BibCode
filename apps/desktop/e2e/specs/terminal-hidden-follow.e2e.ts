// @effect-diagnostics nodeBuiltinImport:off - Packaged UI tests resolve the fixture TUI's shim.
import * as NodePath from "node:path";

import {
  fixtureTuiLogPath,
  openFixtureCodexTerminal,
  openFixtureTerminalThread,
  readFixtureTuiSize,
  settleFixtureTui,
} from "../support/fixture-terminal.ts";
import { clearDesktopActivityMarker } from "../support/test-project.ts";
import { setDesktopUiWindowSize } from "../support/ui-state.ts";

/**
 * #348: while xterm's renderer is paused (its screen does not intersect the viewport), xterm 6
 * clamps its scroll position with the canvas height it had before a resize. A row shrink
 * followed by output then moves the view up by itself, the footer ends below it, and the
 * panel, which read "at the bottom" from that view, never returned it.
 *
 * Moves the center surface that holds a Codex Terminal off-screen (the renderer pauses and
 * the mount keeps its size, so the owner still claims), shrinks the window so the PTY's rows
 * shrink, lets the fixture CLI stream, then brings it back without any size change: the view
 * must end at the bottom of its scrollback with the footer on the last row. The first case
 * runs the same shrink while drawing, the premise that the view only drifts while paused.
 *
 * What green proves: the panel repairs a view that drifted while xterm's renderer was paused,
 * for the off-screen route, which pauses it the same way as the release route the real pair
 * measured (a 1000 px window whose right panel collapses the center column to a 0 px mount while
 * another viewer shrinks the rows). This spec cannot drive that route: with a 0 px mount the
 * window itself never claims a size, so the shrink needs a second viewer, which the packaged
 * harness does not have. The release route stays the real pair's check.
 *
 * Needs BIBCODE_E2E_FOOTER_LAYOUT=cli in the runner's environment (the fixture TUI streams a
 * transcript under an Ink-like frame). The DOM renderer is used so the rows can be read;
 * BIBCODE_E2E_FOOTER_RENDERER=webgl keeps WebGL and checks only the scroll position.
 */

const projectPath = process.env.BIBCODE_E2E_PROJECT_PATH;
const shimDirectory = process.env.BIBCODE_E2E_SHIM_DIRECTORY;
if (!projectPath || !shimDirectory) {
  throw new Error("The packaged desktop UI fixture environment was not prepared.");
}
if (process.env.BIBCODE_E2E_FOOTER_LAYOUT !== "cli") {
  throw new Error("Run this spec with BIBCODE_E2E_FOOTER_LAYOUT=cli.");
}
const preparedProjectPath: string = projectPath;
const codexExecutable = NodePath.join(
  shimDirectory,
  process.env.BIBCODE_E2E_PLATFORM === "win" ? "codex.cmd" : "codex",
);
const tuiLogPath = fixtureTuiLogPath(preparedProjectPath);
const domRenderer = process.env.BIBCODE_E2E_FOOTER_RENDERER !== "webgl";

interface FollowView {
  readonly found: boolean;
  /**
   * Pixels between the end of xterm's scrollbar slider and the end of its track, or null when
   * the slider or a track with height is missing (a renamed class must not pass as 0).
   */
  readonly scrollGap: number | null;
  /** The last drawn rows, with the DOM renderer. */
  readonly lastRows: ReadonlyArray<string>;
}

function readFollowView(terminalId: string): Promise<FollowView> {
  return browser.execute((id: string): FollowView => {
    const mount = document.querySelector<HTMLElement>(
      `[data-terminal-xterm-mount="${CSS.escape(id)}"]`,
    );
    if (!mount) return { found: false, scrollGap: null, lastRows: [] };
    // xterm 6 scrolls a virtual element: the slider ends at its track's end at the bottom.
    // xterm 6.1 renames the classes to `.xterm-scrollbar` and `.xterm-slider`.
    const slider = mount.querySelector<HTMLElement>(
      ".scrollbar.vertical > .slider, .xterm-scrollbar.vertical > .xterm-slider, .xterm-scrollbar > .xterm-slider",
    );
    const track = slider?.parentElement;
    const rows = mount.querySelector<HTMLElement>(".xterm-rows");
    return {
      found: true,
      scrollGap:
        slider && track && track.clientHeight > 0
          ? Math.round(track.clientHeight - slider.offsetTop - slider.offsetHeight)
          : null,
      lastRows: rows
        ? [...rows.children].slice(-3).map((row) => (row.textContent ?? "").trimEnd())
        : [],
    };
  }, terminalId);
}

/** Moves the center surface off-screen (its size kept) or back. */
function moveSurfaceOffScreen(terminalId: string, offScreen: boolean): Promise<boolean> {
  return browser.execute(
    (id: string, away: boolean) => {
      const mount = document.querySelector<HTMLElement>(
        `[data-terminal-xterm-mount="${CSS.escape(id)}"]`,
      );
      const host = mount?.closest<HTMLElement>("[data-center-surface-host]") ?? mount;
      if (!host) return false;
      host.style.transform = away ? "translateX(-100000px)" : "";
      return true;
    },
    terminalId,
    offScreen,
  );
}

async function expectFollowing(terminalId: string, at: string): Promise<void> {
  // A size change and the repaint after it settle within a second.
  await settleFixtureTui(tuiLogPath);
  await browser.pause(1_500);
  const view = await readFollowView(terminalId);
  const problems: string[] = [];
  if (!view.found) problems.push("the terminal is not mounted");
  if (view.scrollGap === null)
    problems.push("xterm's scroll bar slider or its track was not found");
  else if (view.scrollGap > 1) problems.push(`the view is ${view.scrollGap}px above the bottom`);
  if (domRenderer && !(view.lastRows.at(-1) ?? "").startsWith("fixture-footer-z"))
    problems.push(`the footer is not on the last row: ${JSON.stringify(view.lastRows)}`);
  if (problems.length > 0) throw new Error(`#348 ${at}: ${problems.join("; ")}`);
}

describe("packaged AI terminal follows its output across a paused renderer (#348)", () => {
  let terminalId = "";

  before(async () => {
    clearDesktopActivityMarker(preparedProjectPath);
    await setDesktopUiWindowSize(1_200, 760);
    await openFixtureTerminalThread(preparedProjectPath, codexExecutable, {
      webglEnabled: !domRenderer,
    });
    const logStart = readFixtureTuiSize(tuiLogPath)?.bytes ?? 0;
    terminalId = await openFixtureCodexTerminal();
    await browser.waitUntil(async () => (readFixtureTuiSize(tuiLogPath)?.bytes ?? 0) > logStart, {
      timeout: 30_000,
      timeoutMsg: "The fixture TUI never drew in the Codex Terminal.",
    });
    // The Activity dock mounts after the terminal and shrinks it once.
    await browser
      .$(`[data-provider-terminal-activity-host="${terminalId}"] [data-testid="activity-dock"]`)
      .waitForExist({ timeout: 5_000 })
      .catch(() => undefined);
    await expectFollowing(terminalId, "baseline");
  });

  it("stays at the bottom when its rows shrink while it is drawn", async () => {
    const before = readFixtureTuiSize(tuiLogPath);
    await setDesktopUiWindowSize(1_200, 600);
    await browser.waitUntil(
      async () => (readFixtureTuiSize(tuiLogPath)?.rows ?? 0) < (before?.rows ?? 0),
      { timeout: 10_000, timeoutMsg: "The PTY's rows did not shrink." },
    );
    await expectFollowing(terminalId, "after a shrink while drawn");
    await setDesktopUiWindowSize(1_200, 760);
    await expectFollowing(terminalId, "after growing back");
  });

  it("returns to the bottom when shown again after its rows shrank while off-screen", async () => {
    if (!(await moveSurfaceOffScreen(terminalId, true))) {
      throw new Error("The terminal's center surface was not found.");
    }
    try {
      await browser.pause(300);
      const before = readFixtureTuiSize(tuiLogPath);
      await setDesktopUiWindowSize(1_200, 600);
      await browser.waitUntil(
        async () => (readFixtureTuiSize(tuiLogPath)?.rows ?? 0) < (before?.rows ?? 0),
        { timeout: 10_000, timeoutMsg: "The PTY's rows did not shrink while off-screen." },
      );
      // The fixture CLI streams a transcript line every few hundred milliseconds.
      await browser.pause(3_000);
    } finally {
      await moveSurfaceOffScreen(terminalId, false);
    }
    // Shown again with no size change: only the renderer resuming can repair the view.
    await expectFollowing(terminalId, "after showing it again");
  });
});
