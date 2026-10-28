/**
 * Packaged helpers for dropping the app's environment connection from the page while the
 * composer is in use (#199), and for reading one thread's persisted composer draft.
 */

const composerDraftStorageKey = "bibcode:composer-drafts:v1";

export interface ThreadDraftEntry {
  readonly key: string;
  readonly prompt: string;
}

/**
 * Every persisted composer draft whose environment-scoped key (`<environmentId>:<threadId>`)
 * names `threadId`. A caller asserting one draft should require exactly one entry, so a second
 * environment's draft for the same thread id cannot satisfy it.
 */
export function threadDraftEntries(rawStore: string | null, threadId: string): ThreadDraftEntry[] {
  if (!rawStore) return [];
  const parsed = JSON.parse(rawStore) as {
    state?: { draftsByThreadKey?: Record<string, { prompt?: string }> };
  };
  return Object.entries(parsed.state?.draftsByThreadKey ?? {})
    .filter(([key]) => {
      const separator = key.indexOf(":");
      return separator > 0 && key.slice(separator + 1) === threadId;
    })
    .map(([key, draft]) => ({ key, prompt: draft.prompt ?? "" }));
}

export async function readThreadDraftEntries(threadId: string): Promise<ThreadDraftEntry[]> {
  const rawStore = await browser.execute(
    (storageKey: string) => window.localStorage.getItem(storageKey),
    composerDraftStorageKey,
  );
  return threadDraftEntries(rawStore, threadId);
}

/**
 * Routes every new RPC socket through a tracker, so a later reconnect's socket can be closed
 * from the page. The socket that predates it is only tracked once the app opens a new one.
 */
export async function installRpcSocketHarness(): Promise<void> {
  await browser.execute(() => {
    const host = window as Window & {
      __bibcodeRpcSocketHarness?: { current: WebSocket | null; opened: number; blocked: boolean };
    };
    if (host.__bibcodeRpcSocketHarness !== undefined) return;
    const Native = window.WebSocket;
    const state: { current: WebSocket | null; opened: number; blocked: boolean } = {
      current: null,
      opened: 0,
      blocked: false,
    };
    const isRpc = (url: string | URL) => new URL(String(url), location.href).pathname === "/ws";
    function Harnessed(url: string | URL, protocols?: string | string[]) {
      const rpc = isRpc(url);
      // While blocked, a retry reaches a closed port, as an unreachable server would.
      const socket = new Native(rpc && state.blocked ? "ws://127.0.0.1:9/ws" : url, protocols);
      if (rpc && !state.blocked) {
        state.current = socket;
        socket.addEventListener("open", () => (state.opened += 1), { once: true });
      }
      return socket;
    }
    Harnessed.prototype = Native.prototype;
    Object.assign(Harnessed, {
      CONNECTING: Native.CONNECTING,
      OPEN: Native.OPEN,
      CLOSING: Native.CLOSING,
      CLOSED: Native.CLOSED,
    });
    window.WebSocket = Harnessed as unknown as typeof WebSocket;
    host.__bibcodeRpcSocketHarness = state;
  });
}

/** How many RPC sockets opened through the harness. */
export async function rpcSocketsOpened(): Promise<number> {
  return browser.execute(
    () =>
      (window as Window & { __bibcodeRpcSocketHarness?: { opened: number } })
        .__bibcodeRpcSocketHarness?.opened ?? 0,
  );
}

/**
 * Closes the tracked RPC socket as a lost server would and keeps the app's retries failing
 * until {@link allowRpcSockets}, so the environment stays in its reconnecting state.
 */
export async function closeTrackedRpcSocket(): Promise<void> {
  const closed = await browser.execute(() => {
    const harness = (
      window as Window & {
        __bibcodeRpcSocketHarness?: { current: WebSocket | null; blocked: boolean };
      }
    ).__bibcodeRpcSocketHarness;
    const socket = harness?.current;
    if (!harness || !socket || socket.readyState !== WebSocket.OPEN) return false;
    harness.blocked = true;
    socket.close();
    return true;
  });
  if (!closed) throw new Error("No open RPC socket was tracked to close.");
}

/** Lets the app's next RPC retry reach the server again. */
export async function allowRpcSockets(): Promise<void> {
  await browser.execute(() => {
    const harness = (window as Window & { __bibcodeRpcSocketHarness?: { blocked: boolean } })
      .__bibcodeRpcSocketHarness;
    if (harness) harness.blocked = false;
  });
}

/** Fires the window connectivity event the app's network status listens to. */
export async function dispatchConnectivityEvent(name: "offline" | "online"): Promise<void> {
  await browser.execute((eventName: string) => {
    window.dispatchEvent(new Event(eventName));
  }, name);
}

/**
 * Types `text` into the focused composer editor one character per page task, as an input
 * method delivers it, running `interrupt` before the character at `interruptAt`. WebDriver's
 * `addValue` inserts a whole string in one input event, so it cannot type through a change.
 */
export async function typeThrough(
  text: string,
  interruptAt: number,
  interrupt: () => Promise<void>,
): Promise<void> {
  for (const [index, character] of [...text].entries()) {
    if (index === interruptAt) await interrupt();
    const inserted = await browser.execute((value: string) => {
      const editor = document.activeElement;
      if (!(editor instanceof HTMLElement) || editor.dataset.testid !== "composer-editor") {
        throw new Error("The composer editor lost focus while typing.");
      }
      return document.execCommand("insertText", false, value);
    }, character);
    if (!inserted) throw new Error(`The composer did not take ${JSON.stringify(character)}.`);
  }
}
