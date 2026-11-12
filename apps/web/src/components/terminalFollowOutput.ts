import type { IDisposable, Terminal } from "@xterm/xterm";

type FollowedTerminal = Pick<
  Terminal,
  "buffer" | "cols" | "rows" | "resize" | "onRender" | "scrollToBottom"
>;

/** Repair attempts after one resume; each waits for the next render. */
const TERMINAL_FOLLOW_REPAIR_ATTEMPTS = 3;

export interface TerminalFollowOutputOptions {
  /**
   * Reports whether xterm's renderer draws: `false` when its screen stops intersecting the
   * viewport (an ancestor with `display: none`, or moved off-screen), which is when xterm
   * pauses. Returns the unsubscribe.
   */
  readonly observeDrawing: (onChange: (drawing: boolean) => void) => () => void;
  /**
   * Reports a scroll the user makes (a wheel over the terminal, a press on its scroll bar),
   * which ends a pending repair: the user chose a position. Returns the unsubscribe.
   */
  readonly observeUserScroll?: (onScroll: () => void) => () => void;
  readonly scheduleFrame?: (callback: () => void) => number;
  readonly cancelFrame?: (handle: number) => void;
}

export interface TerminalFollowOutput {
  /** Whether the view follows the output: the record while paused or repairing, else live. */
  atBottom(): boolean;
  dispose(): void;
}

/**
 * Keeps a view that followed the output at the bottom across a paused renderer (#348).
 * While paused, xterm 6 clamps its scroll position with the canvas height it had before a
 * resize, so a row shrink followed by scrolling output moves the view up without anyone
 * scrolling. Nobody can scroll a terminal that is not drawn, so the position recorded when
 * drawing stopped is the user's, and it is restored once drawing resumes.
 */
export function createTerminalFollowOutput(
  terminal: FollowedTerminal,
  options: TerminalFollowOutputOptions,
): TerminalFollowOutput {
  const scheduleFrame =
    options.scheduleFrame ?? ((callback: () => void) => window.requestAnimationFrame(callback));
  const cancelFrame =
    options.cancelFrame ?? ((handle: number) => window.cancelAnimationFrame(handle));
  const normalAtBottom = () => terminal.buffer.normal.viewportY >= terminal.buffer.normal.baseY;
  let disposed = false;
  let paused = false;
  /** The normal buffer's position when drawing stopped; null when nothing is pending. */
  let followed: boolean | null = null;
  let awaitingRender = false;
  let fallbackFrame: number | null = null;
  let repairTimer: ReturnType<typeof setTimeout> | null = null;
  let attempts = 0;

  const settle = () => {
    followed = null;
    attempts = 0;
  };
  const repair = () => {
    repairTimer = null;
    if (disposed || paused || followed === null) return;
    // The alternate screen has no scrollback; the normal buffer is repaired when it returns.
    if (terminal.buffer.active.type !== "normal") return;
    if (!followed || normalAtBottom()) return settle();
    terminal.scrollToBottom();
    if (normalAtBottom() || attempts >= TERMINAL_FOLLOW_REPAIR_ATTEMPTS) return settle();
    attempts += 1;
    // xterm's scroll area can keep the paused height after drawing resumes and clamps every
    // scroll to it, even at row 0 with no range at all; xterm syncs it on a resize, and a
    // one-row round trip leaves the grid as it was. The next render tries again.
    const { cols, rows } = terminal;
    terminal.resize(cols, rows + 1);
    terminal.resize(cols, rows);
    waitForDraw();
  };
  // Outside xterm's own scroll handling, which ignores a scroll requested inside it.
  const scheduleRepair = () => {
    if (repairTimer === null) repairTimer = setTimeout(repair, 0);
  };
  const resumed = () => {
    if (!awaitingRender) return;
    awaitingRender = false;
    if (fallbackFrame !== null) cancelFrame(fallbackFrame);
    fallbackFrame = null;
    scheduleRepair();
  };
  const stopWaiting = () => {
    awaitingRender = false;
    if (fallbackFrame !== null) cancelFrame(fallbackFrame);
    fallbackFrame = null;
  };
  // xterm applies its deferred resize as it resumes and renders next; nothing may render
  // when nothing changed, so two frames end the wait.
  function waitForDraw() {
    stopWaiting();
    awaitingRender = true;
    fallbackFrame = scheduleFrame(() => {
      fallbackFrame = scheduleFrame(() => {
        fallbackFrame = null;
        resumed();
      });
    });
  }
  const stopObserving = options.observeDrawing((drawing) => {
    if (disposed || drawing === !paused) return;
    paused = !drawing;
    if (paused) {
      // A repair still pending keeps the earlier record: the view has not been drawn since.
      followed ??= normalAtBottom();
      attempts = 0;
      stopWaiting();
      return;
    }
    if (followed !== null) waitForDraw();
  });
  const stopObservingUser =
    options.observeUserScroll?.(() => {
      // Only a pending repair is affected; while paused nothing can be scrolled by hand.
      if (disposed || paused || followed === null) return;
      stopWaiting();
      if (repairTimer !== null) clearTimeout(repairTimer);
      repairTimer = null;
      settle();
    }) ?? (() => undefined);
  const renderDisposable: IDisposable = terminal.onRender(resumed);
  const bufferDisposable: IDisposable = terminal.buffer.onBufferChange((buffer) => {
    if (buffer.type === "normal" && !paused && !awaitingRender && followed !== null)
      scheduleRepair();
  });

  return {
    atBottom: () => (followed !== null ? followed : liveAtBottom(terminal)),
    dispose() {
      if (disposed) return;
      disposed = true;
      stopObserving();
      stopObservingUser();
      renderDisposable.dispose();
      bufferDisposable.dispose();
      if (fallbackFrame !== null) cancelFrame(fallbackFrame);
      if (repairTimer !== null) clearTimeout(repairTimer);
    },
  };
}

function liveAtBottom(terminal: FollowedTerminal): boolean {
  const active = terminal.buffer.active;
  return active.viewportY >= active.baseY;
}

/**
 * Reports a wheel over the terminal's mount, or a press on xterm's scroll bar (its 6.0 and its
 * renamed 6.1 class), never typing or a press on the grid.
 */
export function observeTerminalUserScroll(mount: Element): (onScroll: () => void) => () => void {
  return (onScroll) => {
    const onPointerDown = (event: Event) => {
      if (event.target instanceof Element && event.target.closest(".scrollbar, .xterm-scrollbar"))
        onScroll();
    };
    mount.addEventListener("wheel", onScroll, { capture: true, passive: true });
    mount.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      mount.removeEventListener("wheel", onScroll, { capture: true });
      mount.removeEventListener("pointerdown", onPointerDown, true);
    };
  };
}

/** Observes xterm's screen element the way xterm decides to pause its renderer. */
export function observeTerminalDrawing(
  screen: Element,
): (onChange: (drawing: boolean) => void) => () => void {
  return (onChange) => {
    if (typeof IntersectionObserver === "undefined") return () => undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (entry) onChange(entry.isIntersecting);
      },
      { threshold: 0 },
    );
    observer.observe(screen);
    return () => observer.disconnect();
  };
}
