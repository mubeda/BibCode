// WebKitGTK binds no key to a text field's undo, so a preview page gets the chords the main
// window's #408 handler gives the app's own fields. It listens last, on the window's bubble
// phase, and leaves a chord the page cancelled or an input method is composing.
(() => {
  const textTypes = new Set(["", "text", "search", "url", "tel", "email", "password", "number"]);
  window.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || !event.ctrlKey || event.altKey || event.metaKey) return;
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
    event.preventDefault();
    document.execCommand(command);
  });
})();
