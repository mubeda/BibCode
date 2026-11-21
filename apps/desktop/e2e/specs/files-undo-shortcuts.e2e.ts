// @effect-diagnostics nodeBuiltinImport:off - Packaged UI tests write fixture files, record evidence and send native input.
// @effect-diagnostics globalTimers:off - The spec waits out the editors' history grouping delay.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { desktopUiPlatform } from "../support/app-lifecycle.ts";
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

async function clickToolbar(label: "Undo" | "Redo" | "Heading 2"): Promise<void> {
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
  if (cell.direction === "redo") {
    if (cell.redoAfter === "path") {
      await sendChord(cell.path, "primary+z", "undo");
      await new Promise((resolve) => setTimeout(resolve, 800));
      if (await holdsStep()) {
        recordEvidence({
          cell: cellName(cell),
          ...cell,
          passed: false,
          note: "this path did not undo",
        });
        throw new Error("This path cannot undo, so its redo is not measured.");
      }
    } else {
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
  const passed =
    stepPresent === expectMarker &&
    after.canUndo === expectMarker &&
    after.canRedo === !expectMarker;
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
    canUndo: after.canUndo,
    canRedo: after.canRedo,
  }).toEqual({ text: expectMarker, canUndo: expectMarker, canRedo: !expectMarker });
}

/**
 * Two typed steps, then one undo: exactly the second step leaves. Catches a menu item that both
 * runs its action and lets the chord's own `keydown` reach the editor.
 */
async function measureTwoSteps(view: View, path: InputPath): Promise<void> {
  const fileName = await openFreshFile(view, `undo-two-steps-${view}-${path}`);
  await placeCaretAtEnd(view, fileName);
  typeNative("kq");
  await browser.waitUntil(async () => (await readState(view, fileName)).text.includes("kq"));
  // The source editor joins adjacent typing into one step whatever the pause, so a new line
  // separates its steps; the rendered editor separates them by the pause.
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  if (view === "source") typeNativeReturn();
  typeNative("wv");
  await browser.waitUntil(async () => (await readState(view, fileName)).text.includes("wv"));
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  await startProbe();
  const sent = await sendChord(path, "primary+z", "undo");
  await new Promise((resolve) => setTimeout(resolve, 800));
  const after = await readState(view, fileName);
  const events = await readProbe();
  const passed = after.text.includes("kq") && !after.text.includes("wv") && after.canUndo;
  recordEvidence({
    cell: `${view}-two-steps-undo-${path}`,
    passed,
    chordKeydownReachedPage: chordKeydownReachedPage(events),
    after,
    sent,
    events,
  });
  expect({ first: after.text.includes("kq"), second: after.text.includes("wv") }).toEqual({
    first: true,
    second: false,
  });
  expect(after.canUndo).toBe(true);
}

/**
 * Independent edits in the source view and in its inline comment field: undo with the comment
 * field focused undoes the comment text and leaves the file's history where it was.
 */
async function measureCommentIndependence(path: InputPath, direction: Direction): Promise<void> {
  const fileName = await openFreshFile("source", `undo-comment-${path}-${direction}`);
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
  if (direction === "redo") {
    await sendChord(path, "primary+z", "undo");
    await browser.waitUntil(
      async () => !(await comment.getValue()).toLowerCase().includes("cmtq"),
      {
        timeoutMsg: `Undo by ${path} did not empty the comment field, so its redo is not measured.`,
      },
    );
  }
  const filesBefore = await readState("source", fileName);
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
async function recordTerminalChord(): Promise<void> {
  await openFixtureWorkspace();
  await openCenterTerminal();
  const input = await browser.$(".xterm-helper-textarea");
  await input.waitForExist();
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
        if (event.key.toLowerCase() === "z") {
          setTimeout(() => {
            state.cancelled = event.defaultPrevented;
          });
        }
      },
      true,
    );
  });
  sendNativeChord("primary+z");
  await new Promise((resolve) => setTimeout(resolve, 600));
  const events = await readProbe();
  const chord = await browser.execute(
    () =>
      (window as unknown as { __terminalChord: { exec: number; cancelled: boolean } })
        .__terminalChord,
  );
  const reached = chordKeydownReachedPage(events);
  recordEvidence({
    cell: "terminal-undo-keystroke",
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
    expect({ reached, cancelled: chord.cancelled, exec: chord.exec }).toEqual({
      reached: true,
      cancelled: true,
      exec: 0,
    });
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
  });
});
