// WebKitGTK binds no key to a text field's undo, so a preview page gets the chords the main
// window's #408 handler gives the app's own fields. WebKitGTK has no default action for these
// chords, so the script never cancels one: it decides after the page's own listeners have run,
// and leaves a chord the page cancelled, an input method is composing, or a synthetic event.
// WebKitGTK's undo stack is page-wide, so it undoes only when the page's latest user edit was
// in the focused field; otherwise the chord would revert another editor's change.
// shortcut: once the field's own steps are undone, a further Ctrl+Z there still pops an older
// step from another editor; track per-field step counts if that proves to matter.
(() => {
  const textTypes = new Set(["", "text", "search", "url", "tel", "email", "password", "number"]);
  let lastEdited = null;
  const noteEdit = (event) => {
    if (event.isTrusted) lastEdited = event.composedPath()[0];
  };
  window.addEventListener("beforeinput", noteEdit, true);
  window.addEventListener("input", noteEdit, true);
  window.addEventListener("keydown", (event) => {
    if (!event.isTrusted || !event.ctrlKey || event.altKey || event.metaKey) return;
    if (event.isComposing || event.keyCode === 229) return;
    const target = event.composedPath()[0];
    const field =
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLInputElement && textTypes.has(target.type));
    if (!field || target.readOnly || target.disabled) return;
    const key = event.key.toLowerCase();
    const command =
      key === "z"
        ? event.shiftKey
          ? "redo"
          : "undo"
        : key === "y" && !event.shiftKey
          ? "redo"
          : null;
    if (!command) return;
    // Runs once dispatch has finished, after every listener the page registered later.
    setTimeout(() => {
      if (event.defaultPrevented || lastEdited !== target) return;
      if (target.getRootNode().activeElement !== target) return;
      document.execCommand(command);
    }, 0);
  });
})();
