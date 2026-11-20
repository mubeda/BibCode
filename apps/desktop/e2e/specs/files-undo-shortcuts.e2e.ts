// @effect-diagnostics nodeBuiltinImport:off - Packaged UI tests write fixture files, record evidence and send native input.
// @effect-diagnostics globalTimers:off - The spec waits out the editors' history grouping delay.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { desktopUiApplicationPid, desktopUiPlatform } from "../support/app-lifecycle.ts";
import { desktopUiFixture } from "../support/test-project.ts";
import {
  ensureMainSidebarOpen,
  mockDesktopUiFolderPicker,
  setDesktopUiWindowSize,
} from "../support/ui-state.ts";

const projectPath = process.env.BIBCODE_E2E_PROJECT_PATH;
const artifactDirectory = process.env.BIBCODE_E2E_ARTIFACT_DIR;
if (!projectPath || !artifactDirectory) {
  throw new Error("The packaged desktop Files undo fixture environment was not prepared.");
}
const preparedProjectPath: string = projectPath;
const evidencePath = NodePath.join(artifactDirectory, "files-undo-matrix.jsonl");
const platform = desktopUiPlatform();
// Native input types into whatever session is in front, so only a lab run turns it on.
const nativeInput = process.env.BIBCODE_E2E_NATIVE_INPUT === "1";
const bundleIdentifier = "com.bibcode.desktop.e2e";

const fileViewSelector = "[data-preview-panel-mode]";
const richEditorSelector = `${fileViewSelector} .rich-markdown-editor [contenteditable="true"]`;
const sourceHostSelector = `${fileViewSelector} diffs-container`;
const composerSelector = '[data-testid="composer-editor"]';

type View = "source" | "rendered";
type Direction = "undo" | "redo";
type InputPath = "driver" | "keystroke" | "menu";
type Chord = "primary+z" | "primary+shift+z" | "ctrl+y";

interface ProbeEvent {
  readonly type: string;
  readonly key: string | null;
  readonly inputType: string | null;
  readonly cancelable: boolean;
  readonly isTrusted: boolean;
  readonly defaultPrevented: boolean;
  readonly target: string;
}

interface EditorState {
  readonly text: string;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

declare global {
  interface Window {
    __bibcodeUndoProbe?: ProbeEvent[];
  }
}

function recordEvidence(entry: Record<string, unknown>): void {
  NodeFS.appendFileSync(evidencePath, `${JSON.stringify({ platform, ...entry })}\n`);
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
  if ((await project.getAttribute("aria-expanded")) !== "true") {
    await project.click();
  }
  await primaryWorkspace.waitForDisplayed();
  await primaryWorkspace.click();
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

/** Writes a fresh file for one case and opens it editable in `view`. */
async function openFreshFile(view: View, name: string): Promise<string> {
  const fileName = view === "source" ? `${name}.txt` : `${name}.md`;
  NodeFS.writeFileSync(NodePath.join(preparedProjectPath, fileName), "Hello world\n");
  await setDesktopUiWindowSize(1_200, 720);
  await openFixtureWorkspace();
  await openFilesSurface();
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
        `${fileViewSelector} file-tree-container`,
        itemSelector,
      ),
    { timeoutMsg: `The Files tree did not list ${fileName}.` },
  );
  await browser.waitUntil(async () => (await readState(view, fileName)).text.includes("Hello"), {
    timeoutMsg: `${fileName} did not open editable in the ${view} view.`,
  });
  return fileName;
}

async function readState(view: View, fileName: string): Promise<EditorState> {
  return browser.execute(
    (sourceView: boolean, hostQuery: string, richQuery: string, label: string) => {
      let text = "";
      if (sourceView) {
        const host = [...document.querySelectorAll<HTMLElement>(hostQuery)].find(
          (candidate) => candidate.getBoundingClientRect().height > 0,
        );
        text =
          host?.shadowRoot?.querySelector(`[role="textbox"][aria-label="${label}"]`)?.textContent ??
          "";
      } else {
        text = document.querySelector(richQuery)?.textContent ?? "";
      }
      const enabled = (name: string) => {
        const button = document.querySelector<HTMLButtonElement>(
          `[data-file-editor-toolbar] button[aria-label="${name}"]`,
        );
        return (
          button !== null && !button.disabled && button.getAttribute("aria-disabled") !== "true"
        );
      };
      return { text, canUndo: enabled("Undo"), canRedo: enabled("Redo") };
    },
    view === "source",
    sourceHostSelector,
    richEditorSelector,
    fileName,
  );
}

/** Focuses the editing host and puts the caret at the end of its text. */
async function placeCaretAtEnd(view: View, fileName: string): Promise<void> {
  const placed = await browser.execute(
    (sourceView: boolean, hostQuery: string, richQuery: string, label: string) => {
      let editor: HTMLElement | null = null;
      if (sourceView) {
        const host = [...document.querySelectorAll<HTMLElement>(hostQuery)].find(
          (candidate) => candidate.getBoundingClientRect().height > 0,
        );
        editor =
          host?.shadowRoot?.querySelector<HTMLElement>(`[role="textbox"][aria-label="${label}"]`) ??
          null;
      } else {
        editor = document.querySelector<HTMLElement>(richQuery);
      }
      if (!editor) return false;
      editor.focus();
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
      let last: Text | null = null;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if ((node.textContent ?? "").trim().length > 0) last = node as Text;
      }
      if (!last) return false;
      window.getSelection()?.setBaseAndExtent(last, last.length, last, last.length);
      return true;
    },
    view === "source",
    sourceHostSelector,
    richEditorSelector,
    fileName,
  );
  if (!placed) throw new Error(`Could not place the caret in the ${view} view of ${fileName}.`);
  // Pierre reads the caret on the next selectionchange.
  await new Promise((resolve) => setTimeout(resolve, 200));
}

/** Types `marker` through the page: a `beforeinput` the source editor handles, or WebDriver text. */
async function seedThroughPage(view: View, fileName: string, marker: string): Promise<void> {
  await placeCaretAtEnd(view, fileName);
  if (view === "rendered") {
    await browser.$(richEditorSelector).addValue(marker);
    return;
  }
  await browser.execute(
    (hostQuery: string, label: string, data: string) => {
      const host = [...document.querySelectorAll<HTMLElement>(hostQuery)].find(
        (candidate) => candidate.getBoundingClientRect().height > 0,
      );
      const editor = host?.shadowRoot?.querySelector<HTMLElement>(
        `[role="textbox"][aria-label="${label}"]`,
      );
      editor?.dispatchEvent(
        new InputEvent("beforeinput", {
          inputType: "insertText",
          data,
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
    },
    sourceHostSelector,
    fileName,
    marker,
  );
}

function runNative(command: string, args: readonly string[]): string {
  return NodeChildProcess.execFileSync(command, args, { encoding: "utf8" }).trim();
}

function macSystemEvents(lines: readonly string[]): string {
  return runNative("osascript", [
    "-e",
    [
      `tell application id "${bundleIdentifier}" to activate`,
      'tell application "System Events"',
      ...lines.map((line) => `  ${line}`),
      "end tell",
    ].join("\n"),
  ]);
}

function powershell(script: string): string {
  return runNative("powershell", ["-NoProfile", "-NonInteractive", "-Command", script]);
}

/** Types plain letters as real operating-system key events. */
function typeNative(letters: string): void {
  if (platform === "mac") macSystemEvents([`keystroke "${letters}"`]);
  else if (platform === "win") {
    powershell(
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${letters}')`,
    );
  } else runNative("xdotool", ["type", "--delay", "40", letters]);
}

function sendNativeChord(chord: Chord): void {
  if (platform === "mac") {
    const using =
      chord === "primary+z"
        ? "{command down}"
        : chord === "primary+shift+z"
          ? "{command down, shift down}"
          : "{control down}";
    macSystemEvents([`keystroke "${chord === "ctrl+y" ? "y" : "z"}" using ${using}`]);
  } else if (platform === "win") {
    const keys = chord === "primary+z" ? "^z" : chord === "primary+shift+z" ? "^+z" : "^y";
    powershell(
      `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${keys}')`,
    );
  } else {
    const keys =
      chord === "primary+z" ? "ctrl+z" : chord === "primary+shift+z" ? "ctrl+shift+z" : "ctrl+y";
    runNative("xdotool", ["key", "--clearmodifiers", keys]);
  }
}

/** Chooses Edit > Undo or Redo in the native menu bar. Returns whether the item existed and was enabled. */
function chooseNativeEditItem(item: "Undo" | "Redo"): { exists: boolean; enabled: boolean } {
  if (platform === "mac") {
    const reply = macSystemEvents([
      `tell (first application process whose bundle identifier is "${bundleIdentifier}")`,
      "    set frontmost to true",
      `    set target to menu item "${item}" of menu 1 of menu bar item "Edit" of menu bar 1`,
      "    set isEnabled to enabled of target",
      "    if isEnabled then click target",
      "    return isEnabled as text",
      "  end tell",
    ]);
    return { exists: true, enabled: reply === "true" };
  }
  if (platform === "win") {
    const pid = desktopUiApplicationPid();
    const reply = powershell(
      [
        "Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes",
        "$A = [System.Windows.Automation.AutomationElement]",
        "$S = [System.Windows.Automation.TreeScope]::Descendants",
        `$window = $A::FromHandle((Get-Process -Id ${pid}).MainWindowHandle)`,
        '$named = { param($root, $name) $root.FindAll($S, [System.Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.Name -like "$name*" -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::MenuItem } | Select-Object -First 1 }',
        "$edit = & $named $window 'Edit'",
        "if (-not $edit) { 'missing-edit'; exit }",
        "$edit.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()",
        "Start-Sleep -Milliseconds 400",
        `$entry = & $named $A::RootElement '${item}'`,
        "if (-not $entry) { 'missing-item'; exit }",
        "if (-not $entry.Current.IsEnabled) { 'disabled'; exit }",
        "$entry.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()",
        "'invoked'",
      ].join("; "),
    );
    return { exists: !reply.startsWith("missing"), enabled: reply === "invoked" };
  }
  // The pinned menu library creates no predefined Undo or Redo item on GTK.
  return { exists: false, enabled: false };
}

async function startProbe(): Promise<void> {
  await browser.execute(() => {
    const events: ProbeEvent[] = [];
    window.__bibcodeUndoProbe = events;
    const label = (event: Event) => {
      const target = event.composedPath()[0];
      return target instanceof Element
        ? `${target.tagName.toLowerCase()}${target.getAttribute("role") ? `[role=${target.getAttribute("role")}]` : ""}`
        : String(target);
    };
    for (const type of ["keydown", "beforeinput"]) {
      window.addEventListener(type, (event) => {
        events.push({
          type,
          key: event instanceof KeyboardEvent ? event.key : null,
          inputType: event instanceof InputEvent ? event.inputType : null,
          cancelable: event.cancelable,
          isTrusted: event.isTrusted,
          defaultPrevented: event.defaultPrevented,
          target: label(event),
        });
      });
    }
  });
}

async function readProbe(): Promise<ProbeEvent[]> {
  return browser.execute(() => window.__bibcodeUndoProbe ?? []);
}

async function sendChord(path: InputPath, chord: Chord, direction: Direction) {
  if (path === "keystroke") {
    sendNativeChord(chord);
    return { menu: null };
  }
  if (path === "menu") {
    return { menu: chooseNativeEditItem(direction === "undo" ? "Undo" : "Redo") };
  }
  const primary = platform === "mac" ? "Meta" : "Control";
  const keys =
    chord === "primary+z"
      ? [primary, "z"]
      : chord === "primary+shift+z"
        ? [primary, "Shift", "z"]
        : ["Control", "y"];
  await browser.keys(keys);
  return { menu: null };
}

async function clickToolbar(label: "Undo" | "Redo"): Promise<void> {
  const button = await browser.$(`[data-file-editor-toolbar] button[aria-label="${label}"]`);
  await button.waitForEnabled();
  await button.click();
}

interface Cell {
  readonly view: View;
  readonly direction: Direction;
  readonly path: InputPath;
  readonly chord: Chord;
}

function cellName({ view, direction, path, chord }: Cell): string {
  return `${view}-${direction}-${path}-${chord.replaceAll("+", "-")}`;
}

/**
 * Seeds one fresh edit, sends the chord or menu item, and checks that the history moved one step:
 * the marker leaves on undo and returns on redo, and the toolbar agrees.
 */
async function measureCell(cell: Cell): Promise<void> {
  const name = `undo-${cellName(cell)}`;
  const marker = cell.view === "source" ? "kq" : "kqv";
  const fileName = await openFreshFile(cell.view, name);
  if (cell.path === "driver") await seedThroughPage(cell.view, fileName, marker);
  else {
    await placeCaretAtEnd(cell.view, fileName);
    typeNative(marker);
  }
  await browser.waitUntil(
    async () => (await readState(cell.view, fileName)).text.includes(marker),
    {
      timeoutMsg: `The seeded edit "${marker}" never reached ${fileName}.`,
    },
  );
  // Past both editors' history grouping delay, so the edit is one closed step.
  await new Promise((resolve) => setTimeout(resolve, 800));
  if (cell.direction === "redo") {
    await clickToolbar("Undo");
    await browser.waitUntil(
      async () => !(await readState(cell.view, fileName)).text.includes(marker),
      { timeoutMsg: "The toolbar Undo did not remove the seeded edit." },
    );
  }
  const before = await readState(cell.view, fileName);
  await startProbe();
  const sent = await sendChord(cell.path, cell.chord, cell.direction);
  await new Promise((resolve) => setTimeout(resolve, 800));
  const after = await readState(cell.view, fileName);
  const events = await readProbe();
  const expectMarker = cell.direction === "redo";
  const passed =
    after.text.includes(marker) === expectMarker &&
    after.canUndo === expectMarker &&
    after.canRedo === !expectMarker;
  recordEvidence({ cell: cellName(cell), ...cell, passed, before, after, sent, events });
  expect({
    text: after.text.includes(marker),
    canUndo: after.canUndo,
    canRedo: after.canRedo,
  }).toEqual({ text: expectMarker, canUndo: expectMarker, canRedo: !expectMarker });
}

const views: readonly View[] = ["source", "rendered"];
const redoChords: readonly Chord[] =
  platform === "mac" ? ["primary+shift+z"] : ["primary+shift+z", "ctrl+y"];

describe("packaged Files undo and redo (#398)", () => {
  for (const view of views) {
    it(`driver: the undo chord undoes one step in the ${view} view`, async () => {
      await measureCell({ view, direction: "undo", path: "driver", chord: "primary+z" });
    });
    for (const chord of redoChords) {
      it(`driver: ${chord} redoes one step in the ${view} view`, async () => {
        await measureCell({ view, direction: "redo", path: "driver", chord });
      });
    }
  }

  it("driver: the save chord still saves the source view", async () => {
    const fileName = await openFreshFile("source", "undo-save-chord");
    await seedThroughPage("source", fileName, "kq");
    await browser.keys([platform === "mac" ? "Meta" : "Control", "s"]);
    await browser.waitUntil(
      () =>
        NodeFS.readFileSync(NodePath.join(preparedProjectPath, fileName), "utf8").includes("kq"),
      { timeoutMsg: "The save chord never wrote the edit to disk." },
    );
  });

  it("driver: the undo chord still undoes in the chat composer", async () => {
    await openFixtureWorkspace();
    const composer = browser.$(composerSelector);
    await composer.waitForDisplayed();
    await composer.click();
    await composer.addValue("composer undo marker");
    await expect(composer).toHaveText(expect.stringContaining("composer undo marker"));
    await new Promise((resolve) => setTimeout(resolve, 800));
    await startProbe();
    await browser.keys([platform === "mac" ? "Meta" : "Control", "z"]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const text = await composer.getText();
    recordEvidence({ cell: "composer-undo-driver", text, events: await readProbe() });
    expect(text).not.toContain("composer undo marker");
  });

  describe("native input (BIBCODE_E2E_NATIVE_INPUT=1)", function () {
    before(function () {
      if (!nativeInput) this.skip();
    });

    for (const path of ["keystroke", "menu"] as const) {
      for (const view of views) {
        it(`${path}: undo moves the ${view} view one step`, async function () {
          if (path === "menu" && platform === "linux") this.skip();
          await measureCell({ view, direction: "undo", path, chord: "primary+z" });
        });
        const chords: readonly Chord[] = path === "menu" ? ["primary+shift+z"] : redoChords;
        for (const chord of chords) {
          it(`${path}: ${path === "menu" ? "Redo" : chord} redoes the ${view} view one step`, async function () {
            if (path === "menu" && platform === "linux") this.skip();
            await measureCell({ view, direction: "redo", path, chord });
          });
        }
      }
    }

    it("keystroke: the undo chord still undoes in the chat composer", async () => {
      await openFixtureWorkspace();
      const composer = browser.$(composerSelector);
      await composer.waitForDisplayed();
      await composer.click();
      typeNative("cmpq");
      await expect(composer).toHaveText(expect.stringContaining("cmpq"));
      await new Promise((resolve) => setTimeout(resolve, 800));
      await startProbe();
      sendNativeChord("primary+z");
      await new Promise((resolve) => setTimeout(resolve, 500));
      const text = await composer.getText();
      recordEvidence({ cell: "composer-undo-keystroke", text, events: await readProbe() });
      expect(text).not.toContain("cmpq");
    });
  });
});
