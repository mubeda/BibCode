// @effect-diagnostics nodeBuiltinImport:off - Packaged UI tests write fixture files, record evidence and send native input.
// @effect-diagnostics globalTimers:off - The spec waits out the editors' history grouping delay.
// @effect-diagnostics globalDate:off - Preview waits run on timers while WebDriver cannot see the window.
// @effect-diagnostics globalFetch:off - The page reports the preview to the spec while WebDriver cannot.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodePath from "node:path";

import { desktopUiPlatform } from "../support/app-lifecycle.ts";
import { refreshDesktopUiDocument } from "../support/document-navigation.ts";
import { openCenterTerminal } from "../support/terminal-input.ts";
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
  readonly modifiers: string;
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
  const filesButton = browser.$(
    '[data-right-panel-icon-bar] button[aria-label="Files"]:not([aria-disabled="true"])',
  );
  await filesButton.waitForDisplayed();
  await filesButton.click();
}

/** Writes a fresh file for one case and opens it editable in `view`. */
async function openFreshFile(
  view: View,
  name: string,
  own?: { readonly extension: string; readonly content: string },
): Promise<string> {
  const fileName = own
    ? `${name}.${own.extension}`
    : view === "source"
      ? `${name}.txt`
      : `${name}.md`;
  NodeFS.writeFileSync(
    NodePath.join(preparedProjectPath, fileName),
    own?.content ?? "Hello world\n",
  );
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
    // The first file of a session waits for the editor bundle to load.
    timeout: 30_000,
    timeoutMsg: `${fileName} did not open editable in the ${view} view.`,
  });
  return fileName;
}

/** The focused element, looking through shadow roots, as `tag[role]`. */
async function focusedElement(): Promise<string> {
  return browser.execute(() => {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    if (!active) return "none";
    const role = active.getAttribute("role");
    return `${active.tagName.toLowerCase()}${role ? `[role=${role}]` : ""}`;
  });
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

/** Focuses the editing host and puts the caret at the end, or the start, of its text. */
async function placeCaretAtEnd(view: View, fileName: string, atStart = false): Promise<void> {
  const placed = await browser.execute(
    (sourceView: boolean, hostQuery: string, richQuery: string, label: string, start: boolean) => {
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
      let first: Text | null = null;
      let last: Text | null = null;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if ((node.textContent ?? "").trim().length > 0) {
          first ??= node as Text;
          last = node as Text;
        }
      }
      if (!first || !last) return false;
      if (start) window.getSelection()?.setBaseAndExtent(first, 0, first, 0);
      else window.getSelection()?.setBaseAndExtent(last, last.length, last, last.length);
      return true;
    },
    view === "source",
    sourceHostSelector,
    richEditorSelector,
    fileName,
    atStart,
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

/** Presses Return as a real operating-system key event. */
function typeNativeReturn(): void {
  if (platform === "mac") macSystemEvents(["keystroke return"]);
  else if (platform === "win") {
    powershell(
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')",
    );
  } else runNative("xdotool", ["key", "--clearmodifiers", "Return"]);
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
function chooseNativeEditItem(item: "Undo" | "Redo"): {
  exists: boolean;
  enabled: boolean;
  reply?: string;
} {
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
    const reply = powershell(
      [
        "Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes",
        "$A = [System.Windows.Automation.AutomationElement]",
        "$S = [System.Windows.Automation.TreeScope]::Descendants",
        // The packaged app is the one process of that executable with a main window.
        `$window = $A::FromHandle((Get-Process -Name "${NodePath.parse(process.env.BIBCODE_E2E_APP_PATH ?? "bibcode-desktop").name}" | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowHandle)`,
        '$named = { param($root, $name) $root.FindAll($S, [System.Windows.Automation.Condition]::TrueCondition) | Where-Object { $_.Current.Name -like "$name*" -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::MenuItem } | Select-Object -First 1 }',
        "$edit = & $named $window 'Edit'",
        // The window's own Win32 menu bar, read through user32, decides whether the item exists.
        'Add-Type -Namespace LabWin -Name User32 -MemberDefinition \'[DllImport("user32.dll")] public static extern System.IntPtr GetMenu(System.IntPtr hWnd); [DllImport("user32.dll")] public static extern int GetMenuItemCount(System.IntPtr hMenu);\'',
        `$hwnd = (Get-Process -Name "${NodePath.parse(process.env.BIBCODE_E2E_APP_PATH ?? "bibcode-desktop").name}" | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowHandle`,
        "$menuCount = [LabWin.User32]::GetMenuItemCount([LabWin.User32]::GetMenu($hwnd))",
        // Without a UI Automation item, open Edit from the keyboard as a person can: F10, Right, Down.
        `if (-not $edit) { Add-Type -AssemblyName System.Windows.Forms; if ($menuCount -le 0) { "missing-menu count=$menuCount"; exit }; [System.Windows.Forms.SendKeys]::SendWait("{F10}"); Start-Sleep -Milliseconds 300; [System.Windows.Forms.SendKeys]::SendWait("{RIGHT}{DOWN}"); Start-Sleep -Milliseconds 300; [System.Windows.Forms.SendKeys]::SendWait("${item === "Redo" ? "{DOWN}" : ""}{ENTER}"); "keyboard count=$menuCount"; exit }`,
        "$edit.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand()",
        "Start-Sleep -Milliseconds 400",
        `$entry = & $named $A::RootElement '${item}'`,
        "if (-not $entry) { 'missing-item'; exit }",
        "if (-not $entry.Current.IsEnabled) { 'disabled'; exit }",
        "$entry.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()",
        "'invoked'",
      ].join("; "),
    );
    return {
      exists: !reply.startsWith("missing"),
      enabled: reply === "invoked" || reply.startsWith("keyboard"),
      reply,
    };
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
    // The focused element inside a shadow root also listens, in case an event does not cross it.
    let focused = document.activeElement;
    while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
    const listeners: [EventTarget, string, boolean, string][] = [];
    for (const [type, capture] of [
      ["keydown", true],
      ["keydown", false],
      ["beforeinput", true],
      ["beforeinput", false],
      ["input", false],
    ] as const) {
      listeners.push([window, type, capture, capture ? `${type}:capture` : type]);
    }
    if (focused && focused.getRootNode() !== document) {
      for (const type of ["keydown", "beforeinput"]) {
        listeners.push([focused, type, true, `${type}:focused-in-shadow`]);
      }
    }
    for (const [listenerTarget, type, capture, name] of listeners) {
      listenerTarget.addEventListener(
        type,
        (event) => {
          events.push({
            type: name,
            key: event instanceof KeyboardEvent ? `${event.key} keyCode=${event.keyCode}` : null,
            modifiers:
              event instanceof KeyboardEvent
                ? `${event.metaKey ? "meta+" : ""}${event.ctrlKey ? "ctrl+" : ""}${event.shiftKey ? "shift+" : ""}${event.altKey ? "alt+" : ""}`
                : "",
            inputType: event instanceof InputEvent ? event.inputType : null,
            cancelable: event.cancelable,
            isTrusted: event.isTrusted,
            defaultPrevented: event.defaultPrevented,
            target: label(event),
          });
        },
        capture,
      );
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
  await dispatchPageChord(chord);
  return { menu: null };
}

/**
 * Dispatches the chord as a page `keydown` at the focused element, as a browser delivers it. The
 * embedded driver's own keys land on the shadow host and carry the character code as `keyCode`
 * (122 for "z"), so neither editor reads them as the chord.
 */
async function dispatchPageChord(chord: Chord | "primary+s"): Promise<void> {
  const primaryIsMeta = platform === "mac";
  await browser.execute(
    (name: string, macPrimary: boolean) => {
      let target = document.activeElement;
      while (target?.shadowRoot?.activeElement) target = target.shadowRoot.activeElement;
      const letter = name.endsWith("y") ? "y" : name.endsWith("s") ? "s" : "z";
      const primary = name.startsWith("primary");
      const shift = name.includes("shift");
      (target ?? document.body).dispatchEvent(
        new KeyboardEvent("keydown", {
          key: shift ? letter.toUpperCase() : letter,
          code: `Key${letter.toUpperCase()}`,
          keyCode: letter.toUpperCase().charCodeAt(0),
          metaKey: primary && macPrimary,
          ctrlKey: (primary && !macPrimary) || name === "ctrl+y",
          shiftKey: shift,
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
    },
    chord,
    primaryIsMeta,
  );
}

async function renderedHtml(): Promise<string> {
  return browser.execute(
    (query: string) => document.querySelector(query)?.innerHTML ?? "",
    richEditorSelector,
  );
}

async function clickToolbar(label: "Undo" | "Redo" | "Heading 2" | "Link"): Promise<void> {
  const button = await browser.$(`[data-file-editor-toolbar] button[aria-label="${label}"]`);
  await button.waitForEnabled();
  await button.click();
}

interface Cell {
  readonly view: View;
  readonly direction: Direction;
  readonly path: InputPath;
  readonly chord: Chord;
  /** How the redo case's step was undone first: by the same path, or by the toolbar button. */
  readonly redoAfter?: "path" | "toolbar";
  /** The seeded step: typed text, or a toolbar formatting change (rendered view only). */
  readonly edit?: "typing" | "format";
}

function cellName({ view, direction, path, chord, redoAfter, edit }: Cell): string {
  return [
    view,
    direction,
    path,
    chord.replaceAll("+", "-"),
    redoAfter ? `after-${redoAfter}-undo` : null,
    edit === "format" ? "format" : null,
  ]
    .filter(Boolean)
    .join("-");
}

/**
 * Seeds one fresh edit, sends the chord or menu item, and checks that the history moved one step:
 * the marker leaves on undo and returns on redo, and the toolbar agrees.
 */
async function measureCell(cell: Cell): Promise<void> {
  const name = `undo-${cellName(cell)}`;
  const fileName = await openFreshFile(cell.view, name);
  if (cell.path !== "driver") await giveNativeFocus(editorQuery(cell.view));
  const unseededText = (await readState(cell.view, fileName)).text;
  // A formatting step shows in the text as the heading's own block, so it is read from the HTML.
  const marker = cell.edit === "format" ? "<h2" : cell.view === "source" ? "kq" : "kqv";
  const holdsStep = async () =>
    cell.edit === "format"
      ? (await renderedHtml()).includes(marker)
      : (await readState(cell.view, fileName)).text.includes(marker);
  if (cell.edit === "format") {
    await placeCaretAtEnd(cell.view, fileName);
    await clickToolbar("Heading 2");
    await placeCaretAtEnd(cell.view, fileName);
  } else if (cell.path === "driver") await seedThroughPage(cell.view, fileName, marker);
  else {
    await placeCaretAtEnd(cell.view, fileName);
    typeNative(marker);
  }
  await browser.waitUntil(holdsStep, {
    timeoutMsg: `The seeded ${cell.edit ?? "typing"} step never reached ${fileName}.`,
  });
  // Past both editors' history grouping delay, so the edit is one closed step.
  await new Promise((resolve) => setTimeout(resolve, 800));
  const seededText = (await readState(cell.view, fileName)).text;
  // A native redo gets two pending redo entries, so a redo that runs twice shows: the second
  // step is typed away from the first, which keeps the two steps apart in both editors.
  const secondMarker = "wv";
  const twoRedoEntries =
    cell.direction === "redo" && cell.path !== "driver" && cell.edit !== "format";
  if (twoRedoEntries) {
    await placeCaretAtEnd(cell.view, fileName, true);
    typeNative(secondMarker);
    await browser.waitUntil(
      async () => (await readState(cell.view, fileName)).text.includes(secondMarker),
      { timeoutMsg: `The second seeded step never reached ${fileName}.` },
    );
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  const holdsSecond = async () =>
    (await readState(cell.view, fileName)).text.includes(secondMarker);
  if (cell.direction === "redo") {
    if (cell.redoAfter === "path") {
      if (twoRedoEntries) {
        await sendChord(cell.path, "primary+z", "undo");
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
      await sendChord(cell.path, "primary+z", "undo");
      await new Promise((resolve) => setTimeout(resolve, 800));
      if ((await holdsStep()) || (twoRedoEntries && (await holdsSecond()))) {
        recordEvidence({
          cell: cellName(cell),
          ...cell,
          passed: false,
          note: "this path did not undo",
        });
        throw new Error("This path cannot undo, so its redo is not measured.");
      }
    } else {
      if (twoRedoEntries) {
        await clickToolbar("Undo");
        await browser.waitUntil(async () => !(await holdsSecond()), {
          timeoutMsg: "The toolbar Undo did not remove the second seeded step.",
        });
      }
      await clickToolbar("Undo");
      await browser.waitUntil(async () => !(await holdsStep()), {
        timeoutMsg: "The toolbar Undo did not remove the seeded edit.",
      });
      // The click moved focus to the toolbar; a person clicks back into the text before redoing.
      await placeCaretAtEnd(cell.view, fileName);
    }
  }
  const before = await readState(cell.view, fileName);
  const focus = await focusedElement();
  await startProbe();
  const sent = await sendChord(cell.path, cell.chord, cell.direction);
  await new Promise((resolve) => setTimeout(resolve, 800));
  const after = await readState(cell.view, fileName);
  const events = await readProbe();
  const expectMarker = cell.direction === "redo";
  const stepPresent = await holdsStep();
  // After one redo of two, the second step is still undone and Redo stays enabled.
  const secondPresent = twoRedoEntries && (await holdsSecond());
  const expectRedo = twoRedoEntries || !expectMarker;
  const passed =
    stepPresent === expectMarker &&
    !secondPresent &&
    after.canUndo === expectMarker &&
    after.canRedo === expectRedo &&
    after.text === (expectMarker ? seededText : unseededText);
  recordEvidence({
    cell: cellName(cell),
    ...cell,
    passed,
    chordKeydownReachedPage: chordKeydownReachedPage(events),
    focus,
    before,
    after,
    sent,
    events,
  });
  expect({
    text: stepPresent,
    second: secondPresent,
    exactText: after.text === (expectMarker ? seededText : unseededText),
    canUndo: after.canUndo,
    canRedo: after.canRedo,
  }).toEqual({
    text: expectMarker,
    second: false,
    exactText: true,
    canUndo: expectMarker,
    canRedo: expectRedo,
  });
}

/**
 * Two typed steps, then one undo: exactly the second step leaves and the first stays. Catches a
 * menu item that both runs its action and lets the chord's own `keydown` reach the editor.
 */
async function measureTwoSteps(view: View, path: InputPath): Promise<void> {
  const fileName = await openFreshFile(view, `undo-two-steps-${view}-${path}`);
  await giveNativeFocus(editorQuery(view));
  await placeCaretAtEnd(view, fileName);
  typeNative("kq");
  await browser.waitUntil(async () => (await readState(view, fileName)).text.includes("kq"));
  // The source editor joins adjacent typing into one step whatever the pause, so the second step
  // is typed at the start of the text; a new line would add a step a double undo hides behind.
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  await placeCaretAtEnd(view, fileName, true);
  const firstStep = await readState(view, fileName);
  typeNative("wv");
  await browser.waitUntil(async () => (await readState(view, fileName)).text.includes("wv"));
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  await startProbe();
  const sent = await sendChord(path, "primary+z", "undo");
  await new Promise((resolve) => setTimeout(resolve, 800));
  const after = await readState(view, fileName);
  const events = await readProbe();
  const passed = after.text === firstStep.text && after.canUndo && after.canRedo;
  recordEvidence({
    cell: `${view}-two-steps-undo-${path}`,
    passed,
    chordKeydownReachedPage: chordKeydownReachedPage(events),
    after,
    sent,
    events,
  });
  expect(after).toEqual({ text: firstStep.text, canUndo: true, canRedo: true });
}

/**
 * Independent edits in the source view and in its inline comment field: undo with the comment
 * field focused undoes the comment text and leaves the file's history where it was.
 */
async function measureCommentIndependence(path: InputPath, direction: Direction): Promise<void> {
  const fileName = await openFreshFile("source", `undo-comment-${path}-${direction}`);
  await giveNativeFocus(sourceHostSelector);
  await placeCaretAtEnd("source", fileName);
  typeNative("kq");
  await browser.waitUntil(async () => (await readState("source", fileName)).text.includes("kq"));
  await new Promise((resolve) => setTimeout(resolve, 800));
  // A click on the first line number opens a comment form with its textarea focused.
  await browser.execute((hostQuery: string) => {
    const host = [...document.querySelectorAll<HTMLElement>(hostQuery)].find(
      (candidate) => candidate.getBoundingClientRect().height > 0,
    );
    const gutter = host?.shadowRoot?.querySelector<HTMLElement>(
      "[data-gutter] [data-column-number]",
    );
    if (!gutter) throw new Error("The source view shows no line number.");
    const rect = gutter.getBoundingClientRect();
    const pointer = (type: string, buttons: number) =>
      gutter.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          button: 0,
          buttons,
          clientX: Math.round(rect.left + rect.width / 2),
          clientY: Math.round(rect.top + rect.height / 2),
          composed: true,
          isPrimary: true,
          pointerId: 74,
          pointerType: "mouse",
        }),
      );
    pointer("pointermove", 0);
    pointer("pointerdown", 1);
    pointer("pointerup", 0);
    gutter.click();
  }, sourceHostSelector);
  const comment = browser.$('textarea[aria-label^="Comment on lines"]');
  await comment.waitForDisplayed({ timeoutMsg: "The line number did not open a comment form." });
  await browser.execute(() =>
    document.querySelector<HTMLElement>('textarea[aria-label^="Comment on lines"]')?.focus(),
  );
  // Capitalized, so macOS has no capitalization step of its own to add before the undo.
  typeNative("Cmtq");
  await browser.waitUntil(async () => (await comment.getValue()).toLowerCase().includes("cmtq"), {
    timeoutMsg: "The typed text never reached the comment field.",
  });
  await new Promise((resolve) => setTimeout(resolve, 800));
  // Read before any undo, so a setup undo that also moved the file's history is caught.
  const filesBefore = await readState("source", fileName);
  expect(filesBefore.text.includes("kq") && filesBefore.canUndo).toBe(true);
  if (direction === "redo") {
    await sendChord(path, "primary+z", "undo");
    await browser.waitUntil(
      async () => !(await comment.getValue()).toLowerCase().includes("cmtq"),
      {
        timeoutMsg: `Undo by ${path} did not empty the comment field, so its redo is not measured.`,
      },
    );
  }
  await startProbe();
  const sent = await sendChord(
    path,
    direction === "undo" ? "primary+z" : "primary+shift+z",
    direction,
  );
  await new Promise((resolve) => setTimeout(resolve, 800));
  const commentHoldsText = (await comment.getValue()).toLowerCase().includes("cmtq");
  const filesAfter = await readState("source", fileName);
  const events = await readProbe();
  recordEvidence({
    cell: `comment-${direction}-${path}`,
    passed:
      commentHoldsText === (direction === "redo") &&
      filesAfter.text === filesBefore.text &&
      filesAfter.canUndo === filesBefore.canUndo,
    filesBefore,
    filesAfter,
    commentHoldsText,
    sent,
    events,
  });
  expect(commentHoldsText).toBe(direction === "redo");
  expect(filesAfter).toEqual(filesBefore);
}

const views: readonly View[] = ["source", "rendered"];
const redoChords: readonly Chord[] =
  platform === "mac" ? ["primary+shift+z"] : ["primary+shift+z", "ctrl+y"];

const probeTextareaId = "undo-probe-textarea";

/** Whether any recorded `keydown` was the Z or Y of a chord, that is, whether the chord reached the page. */
function chordKeydownReachedPage(events: readonly ProbeEvent[]): boolean {
  return events.some(
    (event) => event.type.startsWith("keydown") && /^[zy] /i.test(event.key ?? ""),
  );
}

async function fieldText(kind: "composer" | "textarea"): Promise<string> {
  if (kind === "composer") return browser.$(composerSelector).getText();
  return browser.execute(
    (id: string) => (document.getElementById(id) as HTMLTextAreaElement | null)?.value ?? "",
    probeTextareaId,
  );
}

/**
 * Undo outside Files: the chat composer (Lexical) or a plain `textarea` added to the page. One
 * typed step, then the chord or Edit > Undo, and the typed text must be gone.
 */
async function measureTextField(
  kind: "composer" | "textarea",
  path: InputPath,
  direction: Direction = "undo",
): Promise<void> {
  await openFixtureWorkspace();
  if (kind === "composer") {
    const composer = browser.$(composerSelector);
    await composer.waitForDisplayed();
    await composer.click();
  } else {
    await browser.execute((id: string) => {
      const area = document.createElement("textarea");
      area.id = id;
      area.setAttribute("aria-label", "Undo probe");
      area.style.cssText =
        "position:fixed;top:8px;left:8px;z-index:2147483647;width:240px;height:48px";
      document.body.append(area);
      area.focus();
    }, probeTextareaId);
  }
  if (path !== "driver") {
    await giveNativeFocus(kind === "composer" ? composerSelector : `#${probeTextareaId}`);
  }
  if (path === "driver") {
    if (kind === "composer") await browser.$(composerSelector).addValue("cmpq");
    else await browser.$(`#${probeTextareaId}`).addValue("cmpq");
  } else typeNative("Cmpq");
  await browser.waitUntil(async () => (await fieldText(kind)).toLowerCase().includes("cmpq"), {
    timeoutMsg: `The typed text never reached the ${kind}.`,
  });
  await new Promise((resolve) => setTimeout(resolve, 800));
  if (direction === "redo") {
    await sendChord(path, "primary+z", "undo");
    await browser.waitUntil(async () => !(await fieldText(kind)).toLowerCase().includes("cmpq"), {
      timeoutMsg: `Undo by ${path} did not empty the ${kind}, so its redo is not measured.`,
    });
  }
  await startProbe();
  const sent = await sendChord(
    path,
    direction === "undo" ? "primary+z" : "primary+shift+z",
    direction,
  );
  await new Promise((resolve) => setTimeout(resolve, 600));
  const text = await fieldText(kind);
  const events = await readProbe();
  // macOS may capitalize the typed word as a replacement step, which is not an undo.
  const holdsText = text.toLowerCase().includes("cmpq");
  recordEvidence({
    cell: `${kind}-${direction}-${path}`,
    passed: holdsText === (direction === "redo"),
    chordKeydownReachedPage: chordKeydownReachedPage(events),
    text,
    sent,
    events,
  });
  if (kind === "textarea") {
    await browser.execute((id: string) => document.getElementById(id)?.remove(), probeTextareaId);
  }
  expect(holdsText).toBe(direction === "redo");
}

/**
 * A real undo chord in a focused terminal. On Windows and Linux, Ctrl+Z is the shell's suspend
 * key, which the terminal must keep, so the page must not run an undo of its own.
 */
async function recordTerminalChord(sent: Chord = "primary+z"): Promise<void> {
  await openFixtureWorkspace();
  await openCenterTerminal();
  const input = await browser.$(".xterm-helper-textarea");
  await input.waitForExist();
  await giveNativeFocus(".xterm");
  await browser.execute(() =>
    document.querySelector<HTMLElement>(".xterm-helper-textarea")?.focus(),
  );
  await startProbe();
  // Counts the page's native undo and redo, and reads whether the chord was cancelled once its
  // dispatch ended: xterm cancels the keys it sends to the shell.
  await browser.execute(() => {
    const probe = window as unknown as { __terminalChord?: { exec: number; cancelled: boolean } };
    const state = { exec: 0, cancelled: false };
    probe.__terminalChord = state;
    const exec = document.execCommand.bind(document);
    document.execCommand = (command: string, ...rest: unknown[]) => {
      if (command === "undo" || command === "redo") state.exec += 1;
      return exec(command, ...(rest as [boolean?, string?]));
    };
    window.addEventListener(
      "keydown",
      (event) => {
        if (/^[zy]$/i.test(event.key)) {
          setTimeout(() => {
            state.cancelled = event.defaultPrevented;
          });
        }
      },
      true,
    );
  });
  sendNativeChord(sent);
  await new Promise((resolve) => setTimeout(resolve, 600));
  const events = await readProbe();
  const chord = await browser.execute(
    () =>
      (window as unknown as { __terminalChord: { exec: number; cancelled: boolean } })
        .__terminalChord,
  );
  const reached = chordKeydownReachedPage(events);
  recordEvidence({
    cell: `terminal-${sent.replaceAll("+", "-")}-keystroke`,
    chordKeydownReachedPage: reached,
    focus: await focusedElement(),
    chord,
    events,
  });
  // On Windows and Linux the shell gets Ctrl+Z (xterm cancels the keydown it sends) and the page
  // runs no undo. On macOS Cmd+Z never reaches the page; the Edit menu takes it and, the terminal
  // being no Files editor, runs the native undo once, as the predefined item did.
  if (platform === "mac")
    expect({ reached, exec: chord.exec }).toEqual({ reached: false, exec: 1 });
  else {
    // xterm sends Ctrl+Z to the shell and cancels it; it leaves Shift+Ctrl+Z to the page,
    // which must still run no undo of its own.
    expect({
      reached,
      cancelled: chord.cancelled || sent === "primary+shift+z",
      exec: chord.exec,
    }).toEqual({
      reached: true,
      cancelled: true,
      exec: 0,
    });
  }
}

/** The screen point under page coordinates `point` of the main window. */
async function screenPointOf(point: {
  x: number;
  y: number;
}): Promise<{ x: number; y: number; scale: number }> {
  // The window's content origin on screen: the frame's position plus its title bar and borders.
  return browser.execute(
    (x: number, y: number) => {
      const border = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
      return {
        x: window.screenX + border + x,
        y: window.screenY + window.outerHeight - window.innerHeight - border + y,
        scale: window.devicePixelRatio,
      };
    },
    point.x,
    point.y,
  );
}

/** Clicks a screen point from `screenPointOf`, as a person does. */
function nativeClickAtScreen(screen: { x: number; y: number; scale: number }): void {
  const x = Math.round(screen.x);
  const y = Math.round(screen.y);
  if (platform === "mac") {
    // A window-server click: System Events' accessibility click never reaches the preview's
    // child webview, so its page never saw a mouse-down and its field never took focus.
    runNative("osascript", ["-e", `tell application id "${bundleIdentifier}" to activate`]);
    runNative("osascript", [
      "-l",
      "JavaScript",
      "-e",
      [
        'ObjC.import("CoreGraphics");',
        `const point = $.CGPointMake(${x}, ${y});`,
        "for (const type of [$.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp]) {",
        "  $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, type, point, $.kCGMouseButtonLeft));",
        "  delay(0.05);",
        "}",
      ].join("\n"),
    ]);
  } else if (platform === "win") {
    powershell(
      [
        'Add-Type -Namespace LabWin -Name Mouse -MemberDefinition \'[DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(int f, int x, int y, int d, int e);\'',
        "[LabWin.Mouse]::SetProcessDPIAware() | Out-Null",
        `[LabWin.Mouse]::SetCursorPos(${Math.round(x * screen.scale)}, ${Math.round(y * screen.scale)}) | Out-Null`,
        "[LabWin.Mouse]::mouse_event(2, 0, 0, 0, 0); Start-Sleep -Milliseconds 50; [LabWin.Mouse]::mouse_event(4, 0, 0, 0, 0)",
      ].join("; "),
    );
  } else runNative("xdotool", ["mousemove", String(x), String(y), "click", "1"]);
}

/**
 * The Link URL field, a plain input the rendered view's Link button opens: undo empties what was
 * typed there natively and leaves the document's history where it was.
 */
async function measureLinkField(path: InputPath): Promise<void> {
  const fileName = await openFreshFile("rendered", `undo-link-${path}`);
  await giveNativeFocus(richEditorSelector);
  await placeCaretAtEnd("rendered", fileName);
  typeNative("kqv");
  await browser.waitUntil(async () => (await readState("rendered", fileName)).text.includes("kqv"));
  await new Promise((resolve) => setTimeout(resolve, 800));
  const filesBefore = await readState("rendered", fileName);
  expect(filesBefore.canUndo).toBe(true);
  // A plain click: the driver's pointer sequence closes the popover again as an outside press.
  await browser.execute(() =>
    document
      .querySelector<HTMLButtonElement>('[data-file-editor-toolbar] button[aria-label="Link"]')
      ?.click(),
  );
  const field = browser.$('input[aria-label="Link URL"]');
  await field.waitForDisplayed({ timeoutMsg: "The Link button did not open the Link URL field." });
  await browser.execute(() =>
    document.querySelector<HTMLElement>('input[aria-label="Link URL"]')?.focus(),
  );
  typeNative("Lnkq");
  await browser.waitUntil(async () => (await field.getValue()).toLowerCase().includes("lnkq"), {
    timeoutMsg: "The typed text never reached the Link URL field.",
  });
  await new Promise((resolve) => setTimeout(resolve, 800));
  await startProbe();
  const sent = await sendChord(path, "primary+z", "undo");
  await new Promise((resolve) => setTimeout(resolve, 800));
  const fieldValue = await field.getValue();
  const events = await readProbe();
  await browser.keys("Escape");
  await field.waitForDisplayed({ reverse: true });
  const filesAfter = await readState("rendered", fileName);
  const fieldUndone = fieldValue === "";
  recordEvidence({
    cell: `link-url-undo-${path}`,
    passed: fieldUndone && JSON.stringify(filesAfter) === JSON.stringify(filesBefore),
    fieldValue,
    filesBefore,
    filesAfter,
    sent,
    events,
  });
  expect({ fieldUndone, files: filesAfter }).toEqual({ fieldUndone: true, files: filesBefore });
}

// The probe page's field colour, which its native screenshot must show.
const previewPaint = [255, 0, 170] as const;

// A page for the preview webview: it remembers the longest value its field held, and Return
// sends the field's value and that peak to `reportUrl` as an `echo` report. It reports rather than
// navigates: the server serves it as an opaque-origin sandbox, where `location.href =` throws.
const previewProbePage = (reportUrl = "") => `<!doctype html>
<html><head><meta charset="utf-8"><title>Preview probe</title>
<script>let peak = "";</script></head>
<body style="margin:0">
<input aria-label="Preview probe" autofocus style="box-sizing:border-box;width:100vw;height:100vh;border:0;font-size:32px;background:rgb(${previewPaint.join(",")})"
  oninput="if (this.value.length > peak.length) peak = this.value"
  onkeydown="if (event.key === 'Enter') fetch('${reportUrl}?report=' + encodeURIComponent(JSON.stringify({ kind: 'echo', url: 'echo-' + this.value + '-peak-' + peak })))">
</body></html>
<!-- Hello world -->
`;

interface TauriTestGlobal {
  readonly core: { invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> };
  readonly event: {
    listen: (
      name: string,
      listener: (event: {
        payload: { tabId: string; state: { navStatus: { kind: string; url?: string } } };
      }) => void,
    ) => Promise<() => void>;
  };
}

/** What the main page reports about the preview while WebDriver cannot see the window. */
interface PreviewReport {
  readonly kind: "painted" | "echo" | "closed";
  readonly url?: string;
  /** The native screenshot of the loaded page. */
  readonly path?: string;
  readonly error?: string;
}

/**
 * A local endpoint for the main page's preview reports. While the preview's child webview shares
 * the main window, the embedded WebDriver finds no window (Tauri's `webview_windows` leaves out a
 * window with two webviews), so nothing may call WebDriver until the page closed that webview.
 */
async function startPreviewReports() {
  const reports: PreviewReport[] = [];
  let closeRequested = false;
  const server = NodeHttp.createServer((request, response) => {
    const query = new URL(request.url ?? "/", "http://127.0.0.1").searchParams;
    const report = query.get("report");
    if (report) reports.push(JSON.parse(report) as PreviewReport);
    response.writeHead(200, { "access-control-allow-origin": "*" });
    response.end(query.has("poll") && closeRequested ? "close" : "");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as NodeNet.AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    /** The latest report of `kind` so far. */
    last: (kind: PreviewReport["kind"]) => reports.findLast((report) => report.kind === kind),
    /** The first report of `kind`, waiting with timers only: WebDriver may be blind. */
    async next(kind: PreviewReport["kind"], timeoutMs: number): Promise<PreviewReport | undefined> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const found = reports.find((report) => report.kind === kind);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return undefined;
    },
    /** Asks a page armed in `hold` mode to close the preview now. */
    requestClose: () => {
      closeRequested = true;
    },
    close: () => server.close(),
  };
}

/**
 * Arms the main page before "Open file in preview browser": once `fileName` loads it takes the
 * preview's native screenshot, then closes the preview's native webview at once (`paint`) or when
 * the spec asks (`hold`), reporting each step to `reportUrl`. It gives up after 60 s.
 */
async function armPreviewObserver(
  fileName: string,
  reportUrl: string,
  mode: "paint" | "hold",
): Promise<void> {
  await browser.execute(
    async (name: string, url: string, until: string) => {
      const tauri = (window as unknown as { __TAURI__: TauriTestGlobal }).__TAURI__;
      const report = (value: PreviewReport) =>
        void fetch(`${url}?report=${encodeURIComponent(JSON.stringify(value))}`, {
          mode: "no-cors",
        }).catch(() => undefined);
      let tabId: string | null = null;
      let painted = false;
      let closed = false;
      let unlisten = () => {};
      const close = (reason: string) => {
        if (closed) return;
        closed = true;
        unlisten();
        if (tabId === null) {
          report({ kind: "closed", error: `${reason}: no preview opened` });
          return;
        }
        tauri.core.invoke("desktop_preview_close_tab", { tabId }).then(
          () => report(reason === "done" ? { kind: "closed" } : { kind: "closed", error: reason }),
          (error) => report({ kind: "closed", error: `${reason}: ${String(error)}` }),
        );
      };
      unlisten = await tauri.event.listen("preview://state", ({ payload }) => {
        if (closed) return;
        const nav = payload.state.navStatus;
        const page = decodeURIComponent(nav.url ?? "");
        tabId = payload.tabId;
        if (!painted && nav.kind === "Success" && page.includes(name)) {
          painted = true;
          tauri.core.invoke("desktop_preview_capture_screenshot", { tabId }).then(
            (shot) => {
              report({ kind: "painted", url: page, path: (shot as { path: string }).path });
              if (until === "paint") {
                // The first capture can predate the webview's slot size, so take a later one.
                setTimeout(() => {
                  tauri.core
                    .invoke("desktop_preview_capture_screenshot", { tabId })
                    .then(
                      (later) =>
                        report({
                          kind: "painted",
                          url: page,
                          path: (later as { path: string }).path,
                        }),
                      () => undefined,
                    )
                    .finally(() => close("done"));
                }, 1_500);
              }
              if (until === "hold") {
                const poll = () =>
                  void fetch(`${url}?poll=1`)
                    .then((answer) => answer.text())
                    .then((answer) => (answer === "close" ? close("done") : undefined))
                    .catch(() => undefined)
                    .finally(() => {
                      if (!closed) setTimeout(poll, 300);
                    });
                poll();
              }
            },
            (error) => {
              report({ kind: "painted", error: String(error) });
              close("no screenshot");
            },
          );
        }
      });
      setTimeout(() => close("timeout"), 60_000);
    },
    fileName,
    reportUrl,
    mode,
  );
}

/** Waits for the page to close the preview, then until WebDriver sees the window again. */
async function awaitPreviewClosed(
  reports: Awaited<ReturnType<typeof startPreviewReports>>,
): Promise<PreviewReport | undefined> {
  const closed = await reports.next("closed", 70_000);
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      await browser.execute(() => true);
      return closed;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

/** Closes a preview a failed step left open, so the next test finds the main window again. */
async function closePreviewLeftOpen(
  reports: Awaited<ReturnType<typeof startPreviewReports>>,
  open: boolean,
): Promise<void> {
  if (!open) return;
  reports.requestClose();
  await awaitPreviewClosed(reports).catch(() => undefined);
}

interface PreviewPaint {
  /** The share of the capture in the probe page's colour. */
  readonly share: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Reads a preview screenshot: only a painted page shows the probe page's colour, so a webview that
 * never loaded or stayed blank scores near zero.
 */
async function readPreviewPaint(path: string | undefined): Promise<PreviewPaint> {
  if (!path || !NodeFS.existsSync(path)) return { share: 0, width: 0, height: 0 };
  const png = NodeFS.readFileSync(path).toString("base64");
  return browser.execute(
    async (data: string, [red, green, blue]: readonly number[]) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      const empty = { share: 0, width: canvas.width, height: canvas.height };
      if (!context || canvas.width === 0 || canvas.height === 0) return empty;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let sampled = 0;
      let painted = 0;
      // Colour management can shift the capture a little, so the match is loose.
      for (let index = 0; index < pixels.length; index += 4 * 16) {
        sampled += 1;
        if (
          Math.abs(pixels[index]! - red!) < 40 &&
          Math.abs(pixels[index + 1]! - green!) < 40 &&
          Math.abs(pixels[index + 2]! - blue!) < 40
        ) {
          painted += 1;
        }
      }
      return { share: painted / sampled, width: canvas.width, height: canvas.height };
    },
    png,
    [...previewPaint],
  );
}

/** The visible preview's page area, where the native webview sits, in page coordinates. */
async function previewSlotRect(): Promise<{ width: number; height: number } | null> {
  return browser.execute(() => {
    const visible = [
      ...document.querySelectorAll<HTMLElement>("[data-thread-key] > div.relative.flex-1"),
    ].find((candidate) => candidate.getBoundingClientRect().height > 40);
    const box = visible?.getBoundingClientRect();
    return box ? { width: box.width, height: box.height } : null;
  });
}

/**
 * Whether the screenshot shows the page painted over the preview's whole slot: a webview never
 * sized captures a pixel or two. The slot is measured after the close, which keeps the panel.
 */
async function checkPreviewPaint(
  fileName: string,
  painted: PreviewReport | undefined,
): Promise<{ painted: boolean; sized: boolean }> {
  const paint = await readPreviewPaint(painted?.path);
  const slot = await previewSlotRect();
  recordEvidence({ cell: "preview-paint", fileName, report: painted, paint, slot });
  return {
    painted: paint.share > 0.5,
    sized: slot !== null && paint.width >= slot.width * 0.9 && paint.height >= slot.height * 0.9,
  };
}

/**
 * Leaves the preview for Files and reloads the page, whose preview bridge still holds the native
 * webview the observer closed behind its back.
 */
async function leaveClosedPreview(): Promise<void> {
  await openFilesSurface();
  await refreshDesktopUiDocument();
}

async function measurePreviewPaint(): Promise<void> {
  const fileName = await openFreshFile("source", "preview-paint", {
    extension: "html",
    content: previewProbePage(),
  });
  const reports = await startPreviewReports();
  try {
    const focusedBefore = await browser.execute(() => document.hasFocus());
    await armPreviewObserver(fileName, reports.url, "paint");
    await browser.$('button[aria-label="Open file in preview browser"]').click();
    const closed = await awaitPreviewClosed(reports);
    // The preview took keyboard focus when it opened; closing it must hand focus back.
    const focusedAfter = await browser
      .waitUntil(() => browser.execute(() => document.hasFocus()), { timeout: 3_000 })
      .then(
        () => true,
        () => false,
      );
    recordEvidence({ cell: "preview-close-returns-focus", focusedBefore, focusedAfter });
    const result = await checkPreviewPaint(
      fileName,
      await new Promise<PreviewReport | undefined>((resolve) =>
        setTimeout(() => resolve(reports.last("painted")), 1_000),
      ),
    );
    await leaveClosedPreview();
    expect({ ...result, closed: closed?.error ?? "closed" }).toEqual({
      painted: true,
      sized: true,
      closed: "closed",
    });
    // Asserted where it was found; on macOS the evidence shows whether the bug exists there.
    if (platform !== "mac") expect(focusedAfter).toBe(true);
  } finally {
    reports.close();
  }
}

/** The right panel tab of the open file `fileName`, beside the Files tree's own tab. */
function fileTabXPath(fileName: string): string {
  return `//*[@data-right-panel-tab-list]//*[self::button or @role="tab"][contains(normalize-space(), "${fileName}")]`;
}

/** The source view's state once Files shows the file again, after the preview had its place. */
async function readFilesAfterPreview(fileName: string): Promise<EditorState> {
  await browser.$(fileTabXPath(fileName)).click();
  // The remounted editor shows its text before the toolbar learns its history, so both callers'
  // history (an undo or redo step) is waited for; a history really lost stays empty and fails.
  await browser
    .waitUntil(
      async () => {
        const state = await readState("source", fileName);
        return state.text.length > 0 && (state.canUndo || state.canRedo);
      },
      { timeout: 10_000 },
    )
    .catch(() => undefined);
  return readState("source", fileName);
}

/**
 * How far a native click at `screenPointOf(point)` lands from `point`, measured with one click
 * there, which must be harmless: the window's frame on screen is not what the page reports.
 */
async function measureNativeClickOffset(point: {
  x: number;
  y: number;
}): Promise<{ x: number; y: number }> {
  await browser.execute(() => {
    const target = window as unknown as { __bibcodeClickProbe?: { x: number; y: number } | null };
    target.__bibcodeClickProbe = null;
    addEventListener(
      "mousedown",
      (event) => {
        target.__bibcodeClickProbe = { x: event.clientX, y: event.clientY };
      },
      { capture: true, once: true },
    );
  });
  nativeClickAtScreen(await screenPointOf(point));
  let landed: { x: number; y: number } | null = null;
  await browser.waitUntil(
    async () => {
      landed = await browser.execute(
        () =>
          (window as unknown as { __bibcodeClickProbe?: { x: number; y: number } | null })
            .__bibcodeClickProbe ?? null,
      );
      return landed !== null;
    },
    { timeout: 5_000, timeoutMsg: "The calibration click never reached the page." },
  );
  const { x, y } = landed!;
  return { x: point.x - x, y: point.y - y };
}

/** Clicks a macOS menu bar item of the app. */
function clickMacMenuItem(menu: string, item: string): void {
  macSystemEvents([
    `tell (first application process whose bundle identifier is "${bundleIdentifier}")`,
    "    set frontmost to true",
    `    click menu item "${item}" of menu 1 of menu bar item "${menu}" of menu bar 1`,
    "  end tell",
  ]);
}

/** The centre of the first visible element `query` (CSS, or XPath from `//`) finds. */
async function centreOf(query: string): Promise<{ x: number; y: number }> {
  const centre = await browser.execute((selector: string) => {
    const nodes = selector.startsWith("//")
      ? (() => {
          const found = document.evaluate(
            selector,
            document,
            null,
            XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
            null,
          );
          return Array.from({ length: found.snapshotLength }, (_, index) =>
            found.snapshotItem(index),
          ) as Element[];
        })()
      : [...document.querySelectorAll(selector)];
    const rect = nodes
      .find((node) => node.getBoundingClientRect().height > 0)
      ?.getBoundingClientRect();
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
  }, query);
  if (!centre) throw new Error(`Nothing visible matched ${query}.`);
  return centre;
}

/** The editing host of the `view` view, for a native click into it. */
function editorQuery(view: View): string {
  return view === "source" ? sourceHostSelector : richEditorSelector;
}

/**
 * Clicks the centre of `query` natively, as a person does before typing. GTK and Win32 keyboard
 * focus move only with a real click: a WebDriver click or `element.focus()` leaves it where it
 * was, such as in a preview webview an earlier cell opened, and native keys then reach nothing.
 * Callers still place focus and the caret through the page afterwards, since the click moves the
 * caret.
 */
async function giveNativeFocus(query: string): Promise<void> {
  // shortcut: Linux and Windows, where native focus was found lost; add macOS if it shows there.
  if (platform === "mac") return;
  const centre = await centreOf(query);
  // The calibration click is the focusing click; a second one lands it on target if it was off.
  const offset = await measureNativeClickOffset(centre);
  if (Math.hypot(offset.x, offset.y) > 4) {
    nativeClickAtScreen(await screenPointOf({ x: centre.x + offset.x, y: centre.y + offset.y }));
  }
  await browser.waitUntil(() => browser.execute(() => document.hasFocus()), {
    timeout: 3_000,
    timeoutMsg: `The native click on ${query} did not give the main webview keyboard focus.`,
  });
}

/**
 * With a preview webview open in the main window (#418): Edit > Undo still undoes one step of the
 * Files editor, and closing the window with that unsaved edit still asks first.
 */
async function measureMainWindowAfterPreview(): Promise<void> {
  const fileName = await openFreshFile("source", "undo-after-preview", {
    extension: "html",
    content: previewProbePage(),
  });
  const editorCentre = await centreOf(sourceHostSelector);
  const offset = await measureNativeClickOffset(editorCentre);
  const onScreen = async (point: { x: number; y: number }) =>
    screenPointOf({ x: point.x + offset.x, y: point.y + offset.y });
  await placeCaretAtEnd("source", fileName);
  typeNative("kq");
  await browser.waitUntil(async () => (await readState("source", fileName)).text.includes("kq"));
  // Past the editor's history grouping, so the next letters are a step of their own.
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  // A second step, which the one undo removes (the editor may group it with the first).
  typeNative("vx");
  await browser.waitUntil(async () => (await readState("source", fileName)).text.includes("kqvx"));
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  const filesBefore = await readState("source", fileName);
  expect(filesBefore.canUndo).toBe(true);
  // Measured now: WebDriver is blind while the preview's webview is open.
  const fileTab = await onScreen(await centreOf(fileTabXPath(fileName)));
  const editor = await onScreen(editorCentre);
  const reports = await startPreviewReports();
  let previewOpen = false;
  try {
    await armPreviewObserver(fileName, reports.url, "hold");
    await browser.$('button[aria-label="Open file in preview browser"]').click();
    previewOpen = true;
    const painted = await reports.next("painted", 30_000);
    let menu: ReturnType<typeof chooseNativeEditItem> | null = null;
    if (painted?.path) {
      // Back to the file: the preview's webview stays in the window, hidden.
      nativeClickAtScreen(fileTab);
      await new Promise((resolve) => setTimeout(resolve, 800));
      nativeClickAtScreen(editor);
      await new Promise((resolve) => setTimeout(resolve, 400));
      menu = chooseNativeEditItem("Undo");
      await new Promise((resolve) => setTimeout(resolve, 800));
      // Command-W closes the active surface; the window closes from Window > Close Window.
      clickMacMenuItem("Window", "Close Window");
      await new Promise((resolve) => setTimeout(resolve, 1_500));
    }
    reports.requestClose();
    await awaitPreviewClosed(reports);
    previewOpen = false;
    const asked = await browser
      .$(
        '//*[@role="alertdialog"][.//*[starts-with(normalize-space(), "Save your changes before")]]',
      )
      .waitForDisplayed({ timeout: 3_000 })
      .then(
        () => true,
        () => false,
      );
    if (asked) {
      await browser.$('//*[@role="alertdialog"]//button[normalize-space()="Cancel"]').click();
    }
    const filesAfter = await readFilesAfterPreview(fileName);
    recordEvidence({
      cell: "main-window-after-preview",
      painted,
      menu,
      filesBefore,
      filesAfter,
      asked,
    });
    expect({
      painted: painted?.path !== undefined,
      undone: !filesAfter.text.includes("vx") && filesAfter.canRedo,
      asked,
    }).toEqual({ painted: true, undone: true, asked: true });
  } finally {
    await closePreviewLeftOpen(reports, previewOpen);
    reports.close();
  }
}

/**
 * Undo in the preview webview, the browser opened by "Open file in preview browser": the host's
 * focus check sends it to the native responder, so the page's own field undoes and the Files
 * history behind it stays where it was.
 */
async function measurePreviewFallback(path: InputPath): Promise<void> {
  const reports = await startPreviewReports();
  const fileName = await openFreshFile("source", `undo-preview-${path}`, {
    extension: "html",
    content: previewProbePage(reports.url),
  });
  await giveNativeFocus(sourceHostSelector);
  await placeCaretAtEnd("source", fileName);
  typeNative("kq");
  await browser.waitUntil(async () => (await readState("source", fileName)).text.includes("kq"));
  await new Promise((resolve) => setTimeout(resolve, 800));
  const filesBefore = await readState("source", fileName);
  expect(filesBefore.canUndo).toBe(true);
  // The preview takes the Files surface's place; its field fills the page, so the surface's
  // centre is in it. Measured now: WebDriver is blind while the preview is open.
  const centre = await browser.execute((query: string) => {
    const rect = [...document.querySelectorAll<HTMLElement>(query)]
      .find((candidate) => candidate.getBoundingClientRect().height > 0)
      ?.getBoundingClientRect();
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
  }, fileViewSelector);
  if (!centre) throw new Error("The Files surface was not found.");
  const click = await screenPointOf(centre);
  let previewOpen = false;
  try {
    await armPreviewObserver(fileName, reports.url, "hold");
    await browser.$('button[aria-label="Open file in preview browser"]').click();
    previewOpen = true;
    // No WebDriver from here until the observer closed the preview.
    const painted = await reports.next("painted", 30_000);
    let sent: Awaited<ReturnType<typeof sendChord>> | null = null;
    if (painted?.path) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      nativeClickAtScreen(click);
      await new Promise((resolve) => setTimeout(resolve, 400));
      typeNative("Undq");
      await new Promise((resolve) => setTimeout(resolve, 800));
      sent = await sendChord(path, "primary+z", "undo");
      await new Promise((resolve) => setTimeout(resolve, 800));
      typeNativeReturn();
    }
    const title = (await reports.next("echo", 10_000))?.url ?? "";
    reports.requestClose();
    const closed = await awaitPreviewClosed(reports);
    previewOpen = false;
    const paint = await checkPreviewPaint(fileName, painted);
    const filesAfter = await readFilesAfterPreview(fileName);
    await refreshDesktopUiDocument();
    const typed = title.toLowerCase().includes("-peak-undq");
    const undone = title.toLowerCase().includes("echo--peak-");
    recordEvidence({
      cell: `preview-undo-${path}`,
      passed:
        paint.painted &&
        typed &&
        undone &&
        JSON.stringify(filesAfter) === JSON.stringify(filesBefore),
      title,
      closed,
      filesBefore,
      filesAfter,
      sent,
    });
    expect({ ...paint, typed, undone, files: filesAfter }).toEqual({
      painted: true,
      sized: true,
      typed: true,
      undone: true,
      files: filesBefore,
    });
  } finally {
    await closePreviewLeftOpen(reports, previewOpen);
    reports.close();
  }
}

describe("packaged Files undo and redo (#398)", () => {
  for (const view of views) {
    it(`driver: the undo chord undoes one step in the ${view} view`, async () => {
      await measureCell({ view, direction: "undo", path: "driver", chord: "primary+z" });
    });
    for (const chord of redoChords) {
      it(`driver: ${chord} redoes one step in the ${view} view`, async () => {
        await measureCell({ view, direction: "redo", path: "driver", chord, redoAfter: "path" });
      });
    }
  }

  it("driver: the undo chord undoes a formatting step in the rendered view", async () => {
    await measureCell({
      view: "rendered",
      direction: "undo",
      path: "driver",
      chord: "primary+z",
      edit: "format",
    });
  });

  it("driver: the save chord still saves the source view", async () => {
    const fileName = await openFreshFile("source", "undo-save-chord");
    await seedThroughPage("source", fileName, "kq");
    await dispatchPageChord("primary+s");
    await browser.waitUntil(
      () =>
        NodeFS.readFileSync(NodePath.join(preparedProjectPath, fileName), "utf8").includes("kq"),
      { timeoutMsg: "The save chord never wrote the edit to disk." },
    );
  });

  it("driver: the undo chord still undoes in the chat composer", async () => {
    await measureTextField("composer", "driver");
  });

  it("driver: the preview browser paints a local HTML page (#417)", async () => {
    await measurePreviewPaint();
  });

  describe("native input (BIBCODE_E2E_NATIVE_INPUT=1)", function () {
    before(function () {
      if (!nativeInput) this.skip();
    });

    for (const path of ["keystroke", "menu"] as const) {
      for (const view of views) {
        it(`${path}: one undo after two steps removes only the second in the ${view} view`, async function () {
          if (path === "menu" && platform === "linux") this.skip();
          await measureTwoSteps(view, path);
        });
      }
    }

    for (const path of ["keystroke", "menu"] as const) {
      const skipMenu = (context: Mocha.Context) => {
        // The pinned menu library creates no predefined Undo or Redo item on GTK.
        if (path === "menu" && platform === "linux") context.skip();
      };
      for (const view of views) {
        it(`${path}: undo moves the ${view} view one step`, async function () {
          skipMenu(this);
          await measureCell({ view, direction: "undo", path, chord: "primary+z" });
        });
        const chords: readonly Chord[] = path === "menu" ? ["primary+shift+z"] : redoChords;
        for (const chord of chords) {
          for (const redoAfter of ["path", "toolbar"] as const) {
            it(`${path}: ${path === "menu" ? "Redo" : chord} redoes the ${view} view after a ${redoAfter} undo`, async function () {
              skipMenu(this);
              await measureCell({ view, direction: "redo", path, chord, redoAfter });
            });
          }
        }
      }
      it(`${path}: undo removes a formatting step in the rendered view`, async function () {
        skipMenu(this);
        await measureCell({
          view: "rendered",
          direction: "undo",
          path,
          chord: "primary+z",
          edit: "format",
        });
      });
    }

    for (const kind of ["composer", "textarea"] as const) {
      for (const path of ["keystroke", "menu"] as const) {
        for (const direction of ["undo", "redo"] as const) {
          it(`${path}: ${direction} still works in a ${kind === "composer" ? "chat composer" : "plain textarea"}`, async function () {
            if (path === "menu" && platform === "linux") this.skip();
            await measureTextField(kind, path, direction);
          });
        }
      }
    }

    for (const path of ["keystroke", "menu"] as const) {
      for (const direction of ["undo", "redo"] as const) {
        it(`${path}: ${direction} in the inline comment field leaves the file history alone`, async function () {
          if (path === "menu" && platform === "linux") this.skip();
          await measureCommentIndependence(path, direction);
        });
      }
    }

    it("keystroke: the terminal keeps the undo chord", async () => {
      await recordTerminalChord();
    });

    for (const chord of ["primary+shift+z", "ctrl+y"] as const) {
      it(`keystroke: the terminal keeps ${chord} off macOS`, async function () {
        if (platform === "mac") this.skip();
        await recordTerminalChord(chord);
      });
    }

    for (const path of ["keystroke", "menu"] as const) {
      it(`${path}: undo in the Link URL field stays in the field`, async function () {
        if (path === "menu" && platform === "linux") this.skip();
        await measureLinkField(path);
      });
      it(`${path}: undo in the preview browser stays in its page`, async function () {
        if (path === "menu" && platform === "linux") this.skip();
        await measurePreviewFallback(path);
      });
    }

    // Runs last: if the close guard broke, the window closes and ends the session.
    it("menu: after a preview opened, Undo reaches Files and closing still asks (#418)", async function () {
      if (platform !== "mac") this.skip();
      await measureMainWindowAfterPreview();
    });
  });
});
