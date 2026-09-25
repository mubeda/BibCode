export const KEYBOARD_CONTEXT_MENU_ECHO_MS = 1_000;
let pendingKeyboardOpenedAt = Number.NEGATIVE_INFINITY;

/** Called synchronously by the card key handler, before either menu path opens. */
export function markKeyboardContextMenuOpened(): number {
  pendingKeyboardOpenedAt = performance.now();
  return pendingKeyboardOpenedAt;
}

/** A fallback invocation consumes the marker; later pointer-opened menus do not inherit it. */
export function consumeKeyboardContextMenuOpenedAt(): number {
  const openedAt = pendingKeyboardOpenedAt;
  pendingKeyboardOpenedAt = Number.NEGATIVE_INFINITY;
  return openedAt;
}
