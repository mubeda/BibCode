// @effect-diagnostics nodeBuiltinImport:off - Packaged UI tests read the fixture TUI's size log.
// @effect-diagnostics globalDate:off - The size log is polled against a wall-clock deadline.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  configureDesktopActivityCodexExecutable,
  materializeDesktopActivitySession,
} from "./activity-session.ts";
import { desktopActivityFixture } from "./activity-events.ts";
import { refreshDesktopUiDocument } from "./document-navigation.ts";
import { installDesktopUiMotionGuard } from "./motion-guard.ts";
import { ensureMainSidebarOpen } from "./ui-state.ts";

export interface FixtureTuiSize {
  readonly cols: number;
  readonly rows: number;
  readonly bytes: number;
}

/** The fixture TUI appends every PTY size it is given inside `.git`, out of the worktree. */
export function fixtureTuiLogPath(projectPath: string): string {
  return NodePath.join(projectPath, ".git", "bibcode-fixture-tui-sizes.log");
}

export function readFixtureTuiSize(logPath: string): FixtureTuiSize | null {
  if (!NodeFS.existsSync(logPath)) return null;
  const log = NodeFS.readFileSync(logPath);
  const last = log.toString("utf8").trim().split("\n").at(-1);
  const match = last ? /^(\d+)x(\d+)$/.exec(last) : null;
  return match ? { cols: Number(match[1]), rows: Number(match[2]), bytes: log.length } : null;
}

/** The TUI redraws on every SIGWINCH; a size that holds for 400 ms is final. */
export async function settleFixtureTui(logPath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  let previous = readFixtureTuiSize(logPath)?.bytes ?? 0;
  while (Date.now() < deadline) {
    await browser.pause(400);
    const current = readFixtureTuiSize(logPath)?.bytes ?? 0;
    if (current === previous) return;
    previous = current;
  }
}

/** Opens the seeded fixture thread whose Codex executable is the fixture TUI. */
export async function openFixtureTerminalThread(
  projectPath: string,
  codexExecutable: string,
  options: { readonly webglEnabled?: boolean } = {},
): Promise<void> {
  await ensureMainSidebarOpen();
  await materializeDesktopActivitySession(projectPath);
  await configureDesktopActivityCodexExecutable(
    codexExecutable,
    options.webglEnabled === false ? { webglEnabled: false } : {},
  );
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

/** Opens a Codex Terminal in a new center panel and returns its terminal id. */
export async function openFixtureCodexTerminal(): Promise<string> {
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
