// @effect-diagnostics nodeBuiltinImport:off - The spec reads what the server shell wrote.
// Issue 378: Open terminal and Dashboard for a server, from the rail menu and the Repositories
// card. The packaged suite has only this device and no second, remote environment, and the
// Environments view's server card is hidden for this device, so that card's buttons are
// covered by EnvironmentContextCard.test.tsx and the shared command's history by
// serverCommands.history.test.tsx.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { desktopUiPlatform } from "../support/app-lifecycle.ts";
import { refreshDesktopUiDocument } from "../support/document-navigation.ts";
import { installDesktopUiMotionGuard } from "../support/motion-guard.ts";
import { desktopUiFixture } from "../support/test-project.ts";
import { sendTerminalCommand } from "../support/terminal-input.ts";
import { ensureMainSidebarOpen, mockDesktopUiFolderPicker } from "../support/ui-state.ts";

const stateRoot = process.env.BIBCODE_HOME;
if (!stateRoot) throw new Error("BIBCODE_HOME is required.");
const projectPath = process.env.BIBCODE_E2E_PROJECT_PATH;
if (!projectPath) throw new Error("BIBCODE_E2E_PROJECT_PATH is required.");

const dashboardPanel = '[data-testid="host-dashboard-panel"]';
const terminalPanel = '[data-testid="server-terminal-panel"]';
const markerPath = (name: string) => NodePath.join(stateRoot, `server-terminal-${name}.txt`);
// The default shell is PowerShell on Windows and a POSIX shell elsewhere.
const windows = desktopUiPlatform() === "win";
const recordFoldersCommand = windows
  ? // The server's `~` follows USERPROFILE, which the harness points at the fixture home; the
    // shell inherits it from the server.
    `(Get-Location).ProviderPath | Set-Content '${markerPath("pwd")}'; $env:USERPROFILE | Set-Content '${markerPath("home")}'; $env:BIBCODE_E2E_SERVER_SESSION = 'kept'`
  : `pwd -P > '${markerPath("pwd")}'; (cd ~ && pwd -P) > '${markerPath("home")}'; export BIBCODE_E2E_SERVER_SESSION=kept`;
const recordSessionCommand = windows
  ? `$env:BIBCODE_E2E_SERVER_SESSION | Set-Content '${markerPath("session")}'`
  : `echo "$BIBCODE_E2E_SERVER_SESSION" > '${markerPath("session")}'`;

const localRailIcon = '[data-testid="environment-rail-local"]';
const MENU_LABELS = { terminal: "Open terminal", dashboard: "Dashboard" } as const;

/**
 * The native context menu cannot be driven by WebDriver: the next one records the items it
 * was given and answers `choice`. Windows has no native menu (WebView2 renders it in the DOM).
 */
async function answerNextContextMenu(choice: "terminal" | "dashboard"): Promise<void> {
  const menu = await browser.tauri.mock("desktop_bridge_show_context_menu");
  await menu.mockReturnValue(choice);
  const installed = await browser.execute((answer: string) => {
    const host = window as Window & {
      __wdio_mocks__?: Record<string, unknown>;
      __serverCommandMenuItems?: unknown;
    };
    const mocks = (host.__wdio_mocks__ ??= {});
    mocks.desktop_bridge_show_context_menu = async (args: { items?: unknown }) => {
      host.__serverCommandMenuItems = args?.items;
      return answer;
    };
    return typeof mocks.desktop_bridge_show_context_menu === "function";
  }, choice);
  if (!installed) throw new Error("The context-menu mock could not be installed in the page.");
}

async function recordedMenuLabels(): Promise<string[]> {
  return browser.execute(() => {
    const items = (window as Window & { __serverCommandMenuItems?: unknown })
      .__serverCommandMenuItems;
    return Array.isArray(items) ? items.map((item: { label?: string }) => item.label ?? "") : [];
  });
}

async function showView(label: "Environments view" | "Repositories view"): Promise<void> {
  const toggle = browser.$(`button[aria-label="${label}"]`);
  await toggle.waitForDisplayed();
  await toggle.click();
}

/** Picks `choice` from the Local icon's menu and returns the menu's labels, in order. */
async function openFromLocalRail(choice: "terminal" | "dashboard"): Promise<string[]> {
  await showView("Environments view");
  if (!windows) await answerNextContextMenu(choice);
  const local = browser.$(localRailIcon);
  await local.waitForDisplayed();
  // The packaged drivers' right click dispatches untrusted mousedown and mouseup only, and a
  // page gets no contextmenu event from untrusted input, so the spec sends the one a real
  // right click ends with.
  await browser.execute((selector: string) => {
    const element = document.querySelector<HTMLElement>(selector)!;
    const box = element.getBoundingClientRect();
    element.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2,
      }),
    );
  }, localRailIcon);
  if (!windows) {
    await browser.waitUntil(async () => (await recordedMenuLabels()).length > 0, {
      timeoutMsg: "The rail icon did not open its menu.",
    });
    return recordedMenuLabels();
  }
  const item = browser.$(
    `//*[@role="menu"]//*[@role="menuitem"][.//span[normalize-space()="${MENU_LABELS[choice]}"]]`,
  );
  await item.waitForDisplayed();
  const labels: string[] = [];
  for (const row of await browser.$$('//*[@role="menu"]//*[@role="menuitem"]')) {
    labels.push((await row.getText()).trim());
  }
  await item.click();
  return labels;
}

async function ensureFixtureProject(): Promise<void> {
  const project = browser.$(
    `//button[.//span[normalize-space()="${desktopUiFixture.projectName}"]]`,
  );
  if (await project.isDisplayed()) return;
  const addProject = browser.$('[data-testid="sidebar-add-project-trigger"]');
  await addProject.waitForDisplayed();
  await addProject.click();
  const browseFolder = browser.$(
    "//button[@data-add-project-action='true'][.//span[normalize-space()='Browse folder']]",
  );
  await browseFolder.waitForDisplayed();
  await mockDesktopUiFolderPicker(projectPath!);
  await browseFolder.click();
  await expect(project).toBeDisplayed();
}

async function waitForCpuFigure(): Promise<void> {
  const cpu = browser.$(`${dashboardPanel} [data-testid="host-dashboard-cpu"]`);
  await browser.waitUntil(async () => /^\d+(\.\d)?%$/.test((await cpu.getText()).trim()), {
    timeoutMsg: "The center dashboard never showed a CPU percentage.",
  });
}

/** Open terminal focuses the shell itself; the click after the check only keeps it there. */
async function focusTerminal(): Promise<void> {
  const screen = browser.$(`${terminalPanel} .xterm-screen`);
  await expect(screen).toBeDisplayed();
  await browser.waitUntil(
    () =>
      browser.execute(
        (panel: string) =>
          document.activeElement?.closest(panel) !== null &&
          document.activeElement?.classList.contains("xterm-helper-textarea") === true,
        terminalPanel,
      ),
    { timeoutMsg: "Open terminal did not focus the terminal." },
  );
  await screen.click();
}

async function terminalRoute(): Promise<boolean> {
  return /^#\/environment\/[^/]+\/terminal/.test(await browser.execute(() => window.location.hash));
}

/**
 * The server canonicalises the folder it opens, while USERPROFILE may name a temporary folder in
 * 8.3 short form and Windows paths ignore case: compare the long path the file system reports.
 */
function canonicalFolder(path: string): string {
  const long = NodeFS.realpathSync.native(path);
  return windows ? long.toLowerCase() : long;
}

async function waitForMarker(name: string): Promise<string> {
  const path = markerPath(name);
  await browser.waitUntil(
    () => NodeFS.existsSync(path) && NodeFS.readFileSync(path, "utf8").trim().length > 0,
    { timeout: 10_000, timeoutMsg: `The server shell did not write ${name}.` },
  );
  return NodeFS.readFileSync(path, "utf8").trim();
}

describe("packaged server commands", () => {
  it("opens the dashboard and the home-folder terminal from the rail and the card", async () => {
    for (const name of ["pwd", "home", "session"]) NodeFS.rmSync(markerPath(name), { force: true });
    await ensureMainSidebarOpen();

    // Rail menu: both commands, in order, then Dashboard for this device.
    const labels = await openFromLocalRail("dashboard");
    await browser.$(dashboardPanel).waitForDisplayed();
    expect(labels).toEqual(["Open terminal", "Dashboard"]);
    expect(await browser.$(`${dashboardPanel} h1`).getText()).toBe("Local");
    await waitForCpuFigure();

    // A reload restores the panel from its URL, after this device registers again.
    await refreshDesktopUiDocument();
    await installDesktopUiMotionGuard();
    await browser.$(dashboardPanel).waitForDisplayed();
    expect(await browser.execute(() => window.location.hash)).toMatch(
      /^#\/environment\/[^/]+\/dashboard/,
    );
    await waitForCpuFigure();

    // Rail menu: Open terminal starts a shell in the server user's home folder.
    await ensureMainSidebarOpen();
    await openFromLocalRail("terminal");
    await browser.$(terminalPanel).waitForDisplayed();
    await focusTerminal();
    await sendTerminalCommand(recordFoldersCommand);
    expect(canonicalFolder(await waitForMarker("pwd"))).toBe(
      canonicalFolder(await waitForMarker("home")),
    );

    // Repositories card: the same commands, and Open terminal reuses the running session.
    await showView("Repositories view");
    await ensureFixtureProject();
    const cardDashboard = browser.$('button[aria-label="Dashboard for Local"]');
    await cardDashboard.waitForDisplayed();
    await cardDashboard.click();
    await browser.$(dashboardPanel).waitForDisplayed();
    await waitForCpuFigure();

    const cardTerminal = browser.$('button[aria-label="Open terminal on Local"]');
    await cardTerminal.waitForDisplayed();
    await cardTerminal.click();
    await browser.$(terminalPanel).waitForDisplayed();
    await focusTerminal();
    await sendTerminalCommand(recordSessionCommand);
    expect(await waitForMarker("session")).toBe("kept");

    // A reload restores the terminal panel and its session.
    await refreshDesktopUiDocument();
    await installDesktopUiMotionGuard();
    await browser.$(terminalPanel).waitForDisplayed();
    NodeFS.rmSync(markerPath("session"), { force: true });
    await focusTerminal();
    await sendTerminalCommand(recordSessionCommand);
    expect(await waitForMarker("session")).toBe("kept");

    // Open terminal on the terminal shown refocuses it in place: when the shell exits, the
    // panel goes Back to the view before it (the card's Local dashboard), not into another
    // copy of the terminal that would open it again.
    await ensureMainSidebarOpen();
    await showView("Repositories view");
    await cardTerminal.waitForDisplayed();
    await cardTerminal.click();
    await focusTerminal();
    await sendTerminalCommand("exit");
    await browser.$(dashboardPanel).waitForDisplayed({
      timeoutMsg: "The exited terminal did not go back to the Local dashboard.",
    });
    expect(await browser.$(`${dashboardPanel} h1`).getText()).toBe("Local");
    await browser.pause(1_000);
    expect(await terminalRoute()).toBe(false);
    await expect(browser.$(dashboardPanel)).toBeDisplayed();
  });
});
