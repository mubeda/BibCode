import { type RefObject, useEffect } from "react";

import { isLinuxPlatform } from "../../lib/utils";

/** The undo and redo the Files toolbar buttons run. */
export interface FilesEditHistory {
  undo(): void;
  redo(): void;
}

/** Menu actions the macOS desktop host sends for Edit > Undo and Edit > Redo. */
export type EditMenuAction = "edit-undo" | "edit-redo";

export function isEditMenuAction(action: string): action is EditMenuAction {
  return action === "edit-undo" || action === "edit-redo";
}

const regions = new Map<Element, FilesEditHistory>();

/** Registers a Files editing region with its history; the returned function removes it. */
export function registerFilesEditRegion(region: Element, history: FilesEditHistory): () => void {
  regions.set(region, history);
  return () => {
    if (regions.get(region) === history) regions.delete(region);
  };
}

function deepActiveElement(doc: Document): Element | null {
  let active = doc.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

/**
 * The history of the Files region holding focus, when focus is on editable text: the source
 * editor's content element or the rendered editor, across shadow roots. A text field inside the
 * region, such as the inline comment textarea, is not editable text and keeps its own undo.
 */
export function focusedFilesEditHistory(doc: Document = document): FilesEditHistory | null {
  const active = deepActiveElement(doc);
  if (!(active instanceof HTMLElement) || !active.isContentEditable) return null;
  const region = filesRegionOf(active);
  return region ? (regions.get(region) ?? null) : null;
}

/** The registered Files region holding `start`, a text node included, across shadow roots. */
function filesRegionOf(start: Node | null): Element | null {
  for (let node = start; node;) {
    if (node instanceof Element && regions.has(node)) return node;
    node = node.parentNode instanceof ShadowRoot ? node.parentNode.host : node.parentNode;
  }
  return null;
}

/**
 * Runs Edit > Undo or Redo: the focused Files history, or else the browser's own undo, which is
 * what the predefined menu item ran. During a composition the input method keeps the native path.
 */
export function runEditMenuAction(
  action: EditMenuAction,
  composing: boolean,
  doc: Document = document,
): void {
  const history = composing ? null : focusedFilesEditHistory(doc);
  if (history) {
    if (action === "edit-undo") history.undo();
    else history.redo();
    return;
  }
  doc.execCommand(action === "edit-undo" ? "undo" : "redo");
}

/**
 * The native history command for an uncancelled Ctrl+Z, Shift+Ctrl+Z or Ctrl+Y in an `input` or
 * `textarea`. WebKitGTK gives those fields no undo key of its own (#408); editors and the
 * terminal cancel their chords before this runs, and editable text is left to its editor.
 */
export function textFieldHistoryChord(event: KeyboardEvent): "undo" | "redo" | null {
  if (event.defaultPrevented || !event.ctrlKey || event.altKey || event.metaKey) return null;
  // An input method owns the keys while it composes.
  if (event.isComposing || event.keyCode === 229) return null;
  if (!isEditableTextField(event.composedPath()[0])) return null;
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "redo" : "undo";
  return key === "y" && !event.shiftKey ? "redo" : null;
}

const textInputTypes = new Set(["", "text", "search", "url", "tel", "email", "password", "number"]);

function isEditableTextField(target: EventTarget | undefined): boolean {
  // The terminal's input textarea passes the chords it leaves alone to the shell.
  if (target instanceof Element && target.closest(".xterm")) return false;
  if (target instanceof HTMLTextAreaElement) return !target.readOnly && !target.disabled;
  return (
    target instanceof HTMLInputElement &&
    textInputTypes.has(target.getAttribute("type")?.toLowerCase() ?? "") &&
    !target.readOnly &&
    !target.disabled
  );
}

/**
 * Runs once the keydown has reached every listener, so an app shortcut bound to the chord (the
 * command palette's window listener, for one) takes it first. The field has no native undo key to
 * pre-empt, so nothing is lost by waiting.
 */
function runTextFieldHistoryChord(event: KeyboardEvent): void {
  if (!textFieldHistoryChord(event)) return;
  const field = event.composedPath()[0];
  setTimeout(() => {
    const command = textFieldHistoryChord(event);
    if (command && deepActiveElement(document) === field) document.execCommand(command);
  }, 0);
}

/** Listens for the desktop Edit menu actions on every route of the app. */
export function useEditMenuActions(): void {
  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") return;
    // The Files region a composition started in, whatever node inside it the input method
    // targeted. It counts only while that region is in the page and still holds focus: an editor
    // removed mid-composition never delivers compositionend to the document.
    // The editing host is kept, not the target: an editor may replace its text nodes meanwhile.
    let composingIn: Element | null = null;
    let composingHost: Element | null = null;
    const start = (event: Event) => {
      const target = event.composedPath()[0];
      let host =
        target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
      while (host?.parentElement instanceof HTMLElement && host.parentElement.isContentEditable) {
        host = host.parentElement;
      }
      composingHost = host;
      composingIn = filesRegionOf(host);
    };
    const end = () => {
      composingIn = null;
      composingHost = null;
    };
    const composing = () =>
      composingIn !== null &&
      composingHost !== null &&
      composingHost.isConnected &&
      filesRegionOf(deepActiveElement(document)) === composingIn;
    document.addEventListener("compositionstart", start, true);
    document.addEventListener("compositionend", end, true);
    // The Linux desktop has no Edit menu Undo to bind the text fields' chords.
    const linux = isLinuxPlatform(navigator.platform);
    if (linux) document.addEventListener("keydown", runTextFieldHistoryChord);
    const unsubscribe = onMenuAction((action) => {
      if (isEditMenuAction(action)) runEditMenuAction(action, composing());
    });
    return () => {
      document.removeEventListener("compositionstart", start, true);
      document.removeEventListener("compositionend", end, true);
      if (linux) document.removeEventListener("keydown", runTextFieldHistoryChord);
      unsubscribe?.();
    };
  }, []);
}

/** Registers `regionRef`'s element as a Files editing region while `history` exists. */
export function useFilesEditRegion(
  regionRef: RefObject<HTMLElement | null>,
  history: FilesEditHistory | null,
): void {
  useEffect(() => {
    const region = regionRef.current;
    if (!region || !history) return;
    return registerFilesEditRegion(region, history);
  }, [regionRef, history]);
}
