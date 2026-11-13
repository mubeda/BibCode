// @vitest-environment happy-dom
import type {
  DesktopBridge,
  DesktopCloseRequest,
  ProjectWritePrecondition,
} from "@bibcode/contracts";
import type { AtomCommandResult } from "@bibcode/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { toastAdd } = vi.hoisted(() => ({ toastAdd: vi.fn() }));
vi.mock("../ui/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ui/toast")>()),
  toastManager: { add: toastAdd },
}));

import { FileEditingSession } from "./fileEditingSession";
import { FileEditingSessionRegistry } from "./fileEditingSessionRegistry";
import { UnsavedChangesCloseHost } from "./UnsavedChangesCloseDialog";
import { askBeforeLeaving } from "./unsavedFileEdits";

type WriteResult = AtomCommandResult<{ readonly version?: string }, unknown>;
type Session = FileEditingSession<unknown, { readonly version?: string }, unknown>;
type Persist = (
  relativePath: string,
  contents: string,
  precondition: ProjectWritePrecondition | null,
) => Promise<WriteResult>;

const saved = (): WriteResult => AsyncResult.success({ version: "v2" });
const changedOnDisk = (): WriteResult =>
  AsyncResult.failure(
    Cause.fail({
      _tag: "ProjectWriteFileError",
      failure: "file_changed_on_disk",
      message: "file_changed_on_disk",
    }),
  );

let container: HTMLDivElement;
let root: Root;
let registries: FileEditingSessionRegistry<Session>[] = [];
let originalGetAnimations: PropertyDescriptor | undefined;

function openFile(
  registry: FileEditingSessionRegistry<Session>,
  relativePath: string,
  persist: Persist = vi.fn<Persist>(async () => saved()),
) {
  return registry.getOrCreate(
    relativePath,
    () =>
      new FileEditingSession<unknown, { readonly version?: string }, unknown>({
        cwd: "/repo",
        relativePath,
        debounceMs: 500,
        base: { version: "v1", contents: "old\n" },
        persist,
        onPendingChange: vi.fn(),
        onConfirmed: vi.fn(),
        onConflictChange: vi.fn(),
      }),
  );
}

function newRegistry() {
  const registry = new FileEditingSessionRegistry<Session>();
  registries.push(registry);
  return registry;
}

const dialogText = () => document.querySelector('[data-slot="alert-dialog-popup"]')?.textContent;
function button(label: string): HTMLButtonElement {
  const match = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!match) throw new Error(`Missing button: ${label}`);
  return match;
}
async function click(label: string) {
  await act(async () => button(label).click());
}
async function leave(reason: Parameters<typeof askBeforeLeaving>[0] = "close") {
  let answer: Promise<"proceed" | "stay">;
  await act(async () => {
    answer = askBeforeLeaving(reason);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  // Wrapped: an async function would otherwise wait for the answer itself.
  return [answer!] as const;
}

beforeEach(async () => {
  originalGetAnimations = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<UnsavedChangesCloseHost />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  await Promise.all(registries.map((registry) => registry.dispose()));
  registries = [];
  container.remove();
  document.body.replaceChildren();
  toastAdd.mockReset();
  if (originalGetAnimations) {
    Object.defineProperty(Element.prototype, "getAnimations", originalGetAnimations);
  } else {
    Reflect.deleteProperty(Element.prototype, "getAnimations");
  }
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("UnsavedChangesCloseHost", () => {
  it("Save all writes a rendered and a source edit and proceeds", async () => {
    const persist = vi.fn<Persist>(async () => saved());
    const registry = newRegistry();
    const rendered = openFile(registry, "notes.md", persist);
    const source = openFile(registry, "src/app.ts", persist);
    rendered.setPendingEditFlusher(() => rendered.changeFromRichEditor("rendered edit"));
    source.changeFromRichEditor("source edit");

    const [answer] = await leave();
    expect(dialogText()).toContain("notes.md");
    expect(dialogText()).toContain("src/app.ts");
    await click("Save all");

    await expect(answer).resolves.toBe("proceed");
    expect(persist).toHaveBeenCalledWith("notes.md", "rendered edit", expect.anything());
    expect(persist).toHaveBeenCalledWith("src/app.ts", "source edit", expect.anything());
  });

  it("Save all with a file changed on disk stays and shows the reload-or-overwrite choice", async () => {
    const persist = vi.fn<Persist>(async () => changedOnDisk());
    const session = openFile(newRegistry(), "notes.md", persist);
    session.changeFromRichEditor("my edit");

    const [answer] = await leave();
    await click("Save all");

    await expect(answer).resolves.toBe("stay");
    expect(session.getSnapshot().conflict).not.toBeNull();
    expect(session.unsavedContents).toBe("my edit");
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", description: expect.stringContaining("notes.md") }),
    );
    expect(dialogText()).toBeUndefined();
  });

  it("a save that fails for another reason stays and shows the error", async () => {
    const persist = vi.fn<Persist>(async () => AsyncResult.failure(Cause.fail("disk full")));
    const session = openFile(newRegistry(), "notes.md", persist);
    session.changeFromRichEditor("my edit");

    const [answer] = await leave();
    await click("Save all");

    await expect(answer).resolves.toBe("stay");
    expect(session.getSnapshot().save.phase).toBe("failed");
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", description: expect.stringContaining("notes.md") }),
    );
  });

  it("Save all keeps the dialog open and shows that it is saving until the writes end", async () => {
    let finishWrite!: (result: WriteResult) => void;
    const persist = vi.fn<Persist>(
      () =>
        new Promise<WriteResult>((resolve) => {
          finishWrite = resolve;
        }),
    );
    const session = openFile(newRegistry(), "notes.md", persist);
    session.changeFromRichEditor("my edit");

    const [answer] = await leave();
    await click("Save all");
    expect(button("Saving…").disabled).toBe(true);
    expect(button("Discard").disabled).toBe(true);
    expect(button("Cancel").disabled).toBe(true);

    await act(async () => finishWrite(saved()));
    await expect(answer).resolves.toBe("proceed");
    expect(dialogText()).toBeUndefined();
  });

  it("Discard proceeds without writing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const persist = vi.fn<Persist>(async () => saved());
      const session = openFile(newRegistry(), "notes.md", persist);
      session.changeFromRichEditor("my edit");

      const [answer] = await leave();
      await click("Discard");
      await expect(answer).resolves.toBe("proceed");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(persist).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Cancel stays and keeps the edits", async () => {
    const persist = vi.fn<Persist>(async () => saved());
    const session = openFile(newRegistry(), "notes.md", persist);
    session.changeFromRichEditor("my edit");

    const [answer] = await leave();
    await click("Cancel");

    await expect(answer).resolves.toBe("stay");
    expect(session.unsavedContents).toBe("my edit");
    expect(dialogText()).toBeUndefined();
  });

  it("nothing unsaved proceeds at once without a dialog", async () => {
    openFile(newRegistry(), "notes.md");
    const [answer] = await leave();
    await expect(answer).resolves.toBe("proceed");
    expect(dialogText()).toBeUndefined();
  });

  it("typing in rendered view and leaving at once shows the dialog", async () => {
    const session = openFile(newRegistry(), "notes.md");
    // The rendered view registers its flusher on the first keystroke and waits 300 ms.
    session.setPendingEditFlusher(() => session.changeFromRichEditor("typed"));

    const [answer] = await leave();
    expect(dialogText()).toContain("notes.md");
    await click("Cancel");
    await expect(answer).resolves.toBe("stay");
  });

  it("the guard works while the Files view is not mounted", async () => {
    // No FilePreviewPanel is rendered: the registry alone holds the edit, as when another
    // surface is shown in the right panel.
    const session = openFile(newRegistry(), "notes.md");
    session.changeFromRichEditor("kept while hidden");
    expect(container.querySelector("[data-file-preview]")).toBeNull();

    const [answer] = await leave("quit");
    expect(dialogText()).toContain("notes.md");
    await click("Cancel");
    await expect(answer).resolves.toBe("stay");
  });

  it("Cancel returns focus to the element that had it", async () => {
    const session = openFile(newRegistry(), "notes.md");
    session.changeFromRichEditor("my edit");
    const editor = document.createElement("textarea");
    document.body.append(editor);
    editor.focus();

    const [answer] = await leave();
    await click("Cancel");
    await expect(answer).resolves.toBe("stay");
    await vi.waitFor(() => expect(document.activeElement).toBe(editor));
  });

  it("focus lands on Save all and Escape cancels", async () => {
    const session = openFile(newRegistry(), "notes.md");
    session.changeFromRichEditor("my edit");

    const [answer] = await leave();
    await vi.waitFor(() => expect(document.activeElement).toBe(button("Save all")));
    await act(async () => {
      document.activeElement!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    await expect(answer).resolves.toBe("stay");
    expect(session.unsavedContents).toBe("my edit");
  });

  describe("a remote update install the window allowed", () => {
    let send: (request: DesktopCloseRequest) => void;
    let endInstall: () => void;
    let replies: [number, string][];

    beforeEach(async () => {
      await act(async () => root.unmount());
      replies = [];
      window.desktopBridge = {
        onCloseRequest: (listener: (request: DesktopCloseRequest) => void) => {
          send = listener;
          return () => {};
        },
        replyCloseRequest: async (requestId: number, reply: string) => {
          replies.push([requestId, reply]);
        },
        onUpdateInstallEnded: (listener: () => void) => {
          endInstall = listener;
          return () => {};
        },
      } as unknown as DesktopBridge;
      root = createRoot(container);
      await act(async () => root.render(<UnsavedChangesCloseHost />));
    });

    afterEach(async () => {
      // Unblocks whatever a test left blocked, so the next test starts clean.
      await act(async () => endInstall());
      delete window.desktopBridge;
    });

    async function requestInstall(requestId: number) {
      await act(async () => send({ requestId, reason: "update" }));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    // Longer than the 500 ms autosave delay, so a write that is not held would have started.
    const afterTheSaveDelay = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 700));
      });

    function editorOutsideTheDialog() {
      const editor = document.createElement("textarea");
      container.append(editor);
      return editor;
    }

    it("Discard, then the install fails: saving works again", async () => {
      const persist = vi.fn<Persist>(async () => saved());
      const session = openFile(newRegistry(), "notes.md", persist);
      session.changeFromRichEditor("kept edit");

      await requestInstall(4);
      await click("Discard");
      await vi.waitFor(() => expect(replies.at(-1)).toEqual([4, "allow"]));
      await afterTheSaveDelay();
      expect(persist).not.toHaveBeenCalled();

      await act(async () => endInstall());
      await expect(session.flush()).resolves.toBe("saved");
      expect(persist).toHaveBeenCalledWith("notes.md", "kept edit", expect.anything());
    });

    it("Save all, then an edit before the restart is blocked", async () => {
      const persist = vi.fn<Persist>(async () => saved());
      const session = openFile(newRegistry(), "notes.md", persist);
      session.changeFromRichEditor("saved edit");
      const editor = editorOutsideTheDialog();

      await requestInstall(5);
      await click("Save all");
      await vi.waitFor(() => expect(replies.at(-1)).toEqual([5, "allow"]));
      expect(dialogText()).toContain("Installing an update");
      // The modal dialog takes the editors out of reach.
      await vi.waitFor(() =>
        expect(editor.closest("[inert], [aria-hidden='true']")).not.toBeNull(),
      );
      await act(async () => {
        document.activeElement!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
        );
      });
      expect(dialogText()).toContain("Installing an update");
      // An edit that still reaches the session is not written before the restart.
      session.changeFromRichEditor("late edit");
      await afterTheSaveDelay();
      expect(persist).not.toHaveBeenCalledWith("notes.md", "late edit", expect.anything());
    });

    it("the install fails after Save all: editing and saving run again", async () => {
      const persist = vi.fn<Persist>(async () => saved());
      const session = openFile(newRegistry(), "notes.md", persist);
      session.changeFromRichEditor("saved edit");
      const editor = editorOutsideTheDialog();

      await requestInstall(6);
      await click("Save all");
      await vi.waitFor(() => expect(dialogText()).toContain("Installing an update"));

      await act(async () => endInstall());
      expect(dialogText()).toBeUndefined();
      await vi.waitFor(() => expect(editor.closest("[inert], [aria-hidden='true']")).toBeNull());
      expect(toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          title: "The update did not install",
          description:
            "BiBCode did not restart. Files can be edited again. If saving fails, open the Update not installed dialog and choose Restart server.",
        }),
      );
      session.changeFromRichEditor("next edit");
      await expect(session.flush()).resolves.toBe("saved");
      expect(persist).toHaveBeenCalledWith("notes.md", "next edit", expect.anything());
    });

    it("with nothing unsaved, an edit started during the install is not written", async () => {
      const persist = vi.fn<Persist>(async () => saved());
      const session = openFile(newRegistry(), "notes.md", persist);

      await requestInstall(7);
      await vi.waitFor(() => expect(replies.at(-1)).toEqual([7, "allow"]));
      expect(dialogText()).toContain("Installing an update");
      session.changeFromRichEditor("late edit");
      await afterTheSaveDelay();
      expect(persist).not.toHaveBeenCalled();
    });

    it("asks about the update by name", async () => {
      openFile(newRegistry(), "notes.md").changeFromRichEditor("my edit");
      await requestInstall(9);
      expect(dialogText()).toContain("Save your changes before updating?");
    });

    it("an end signal while the question is open drops the request", async () => {
      openFile(newRegistry(), "notes.md").changeFromRichEditor("my edit");
      await requestInstall(10);
      expect(dialogText()).toContain("notes.md");

      // The person forced the install from the native prompt, and it failed.
      await act(async () => endInstall());
      expect(dialogText()).toBeUndefined();
      await afterTheSaveDelay();
      expect(dialogText()).toBeUndefined();
      expect(replies).not.toContainEqual([10, "allow"]);
    });

    it("cancelling another leave during the install keeps it blocked", async () => {
      const session = openFile(newRegistry(), "notes.md");
      session.changeFromRichEditor("kept edit");

      await requestInstall(8);
      await click("Discard");
      await vi.waitFor(() => expect(dialogText()).toContain("Installing an update"));
      const [answer] = await leave("quit");
      expect(dialogText()).toContain("notes.md");
      await click("Cancel");
      await expect(answer).resolves.toBe("stay");
      expect(dialogText()).toContain("Installing an update");
    });
  });

  describe("the update install state when the window loads", () => {
    const MARKER = "bibcode:update-install-allowed";
    type State = {
      readonly requestedBy: { readonly label: string; readonly detail: string | null } | null;
      readonly phase: string;
    };
    const notRunning: State = { requestedBy: null, phase: "idle" };
    const running: State = {
      requestedBy: { label: "Test User", detail: null },
      phase: "installing",
    };

    function stateBridge(getUpdateState?: () => Promise<State>) {
      const bridge = {
        replies: [] as [number, string][],
        send: null as ((request: DesktopCloseRequest) => void) | null,
        endInstall: null as (() => void) | null,
        pushState: null as ((state: State) => void) | null,
        onCloseRequest: (listener: (request: DesktopCloseRequest) => void) => {
          bridge.send = listener;
          return () => {};
        },
        replyCloseRequest: async (requestId: number, reply: string) => {
          bridge.replies.push([requestId, reply]);
        },
        onUpdateInstallEnded: (listener: () => void) => {
          bridge.endInstall = listener;
          return () => {};
        },
        onUpdateState: (listener: (state: State) => void) => {
          bridge.pushState = listener;
          return () => {
            bridge.pushState = null;
          };
        },
        getUpdateState: getUpdateState ? vi.fn(getUpdateState) : undefined,
      };
      if (!getUpdateState) delete bridge.getUpdateState;
      return bridge;
    }

    /** Loads the window again: fresh modules, the same sessionStorage, as a reload does. */
    async function loadWindow(bridge: ReturnType<typeof stateBridge>) {
      await act(async () => root.unmount());
      vi.resetModules();
      const host = await import("./UnsavedChangesCloseDialog");
      const { FileEditingSessionRegistry: Registry } = await import("./fileEditingSessionRegistry");
      const { FileEditingSession: EditingSession } = await import("./fileEditingSession");
      window.desktopBridge = bridge as unknown as DesktopBridge;
      root = createRoot(container);
      await act(async () => root.render(<host.UnsavedChangesCloseHost />));
      return {
        openFile(relativePath: string, persist: Persist = vi.fn<Persist>(async () => saved())) {
          const registry = new Registry<Session>();
          registries.push(registry as unknown as FileEditingSessionRegistry<Session>);
          return registry.getOrCreate(
            relativePath,
            () =>
              new EditingSession<unknown, { readonly version?: string }, unknown>({
                cwd: "/repo",
                relativePath,
                debounceMs: 500,
                base: { version: "v1", contents: "old\n" },
                persist,
                onPendingChange: vi.fn(),
                onConfirmed: vi.fn(),
                onConflictChange: vi.fn(),
              }),
          );
        },
      };
    }

    const advance = (ms: number) =>
      act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });

    beforeEach(() => {
      vi.useFakeTimers();
      window.sessionStorage.clear();
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.restoreAllMocks();
      window.sessionStorage.clear();
      delete window.desktopBridge;
    });

    it("reload during an install: the marker restores the block while the first query rejects", async () => {
      // The window allows the install through the close protocol, which writes the marker.
      const before = stateBridge(() => new Promise<State>(() => {}));
      await loadWindow(before);
      await act(async () => before.send!({ requestId: 3, reason: "update" }));
      await advance(0);
      await vi.waitFor(() => expect(before.replies.at(-1)).toEqual([3, "allow"]), {
        timeout: 30_000,
      });
      expect(window.sessionStorage.getItem(MARKER)).toBe("1");

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const after = stateBridge(() => Promise.reject(new Error("state unavailable")));
      const reloaded = await loadWindow(after);
      expect(dialogText()).toContain("Installing an update");
      const persist = vi.fn<Persist>(async () => saved());
      reloaded.openFile("notes.md", persist).changeFromRichEditor("edit after the reload");
      await advance(700);
      expect(persist).not.toHaveBeenCalled();
      expect(after.getUpdateState).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledOnce();
      await advance(2_000);
      expect(after.getUpdateState).toHaveBeenCalledTimes(2);
      expect(dialogText()).toContain("Installing an update");
      expect(window.sessionStorage.getItem(MARKER)).toBe("1");
    });

    it("reload during an install: a confirmed not-running answer clears the block and the marker", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      window.sessionStorage.setItem(MARKER, "1");
      const answers: (() => Promise<State>)[] = [
        () => Promise.reject(new Error("state unavailable")),
        async () => notRunning,
      ];
      const bridge = stateBridge(() => answers.shift()!());
      const loaded = await loadWindow(bridge);
      const persist = vi.fn<Persist>(async () => saved());
      const session = loaded.openFile("notes.md", persist);
      session.changeFromRichEditor("held edit");
      await advance(700);
      expect(persist).not.toHaveBeenCalled();
      expect(dialogText()).toContain("Installing an update");

      await advance(2_000);
      expect(bridge.getUpdateState).toHaveBeenCalledTimes(2);
      expect(dialogText()).toBeUndefined();
      expect(window.sessionStorage.getItem(MARKER)).toBeNull();
      // Saving resumes: the held edit is written.
      await advance(700);
      expect(persist).toHaveBeenCalledWith("notes.md", "held edit", expect.anything());
      expect(session.unsavedContents).toBeNull();
    });

    it("reload during an install: an answer that still names the requester keeps the block", async () => {
      // Between the allow and the backup the phase still reads "available".
      window.sessionStorage.setItem(MARKER, "1");
      const bridge = stateBridge(async () => ({ ...running, phase: "available" }));
      await loadWindow(bridge);
      await advance(0);
      expect(bridge.getUpdateState).toHaveBeenCalledOnce();
      expect(dialogText()).toContain("Installing an update");
      expect(window.sessionStorage.getItem(MARKER)).toBe("1");
    });

    it("a fresh window with no marker holds nothing until an answer says an install runs", async () => {
      let answer!: (state: State) => void;
      const bridge = stateBridge(
        () =>
          new Promise<State>((resolve) => {
            answer = resolve;
          }),
      );
      const loaded = await loadWindow(bridge);
      expect(dialogText()).toBeUndefined();
      const persist = vi.fn<Persist>(async () => saved());
      const session = loaded.openFile("notes.md", persist);
      session.changeFromRichEditor("free edit");
      await act(async () => {
        await expect(session.flush()).resolves.toBe("saved");
      });
      expect(persist).toHaveBeenCalledOnce();

      await act(async () => answer(running));
      expect(dialogText()).toContain("Installing an update");
      expect(window.sessionStorage.getItem(MARKER)).toBe("1");
    });

    it("a failed query never releases a known block", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      window.sessionStorage.setItem(MARKER, "1");
      const answers: (() => Promise<State>)[] = [
        () => new Promise<State>(() => {}),
        () => Promise.reject(new Error("state unavailable")),
        () => new Promise<State>(() => {}),
      ];
      const bridge = stateBridge(() => answers.shift()!());
      await loadWindow(bridge);
      // The first query never answers: after 5 seconds it counts as failed and is asked again.
      await advance(5_000);
      expect(dialogText()).toContain("Installing an update");
      await advance(2_000);
      expect(bridge.getUpdateState).toHaveBeenCalledTimes(2);
      await advance(2_000);
      expect(bridge.getUpdateState).toHaveBeenCalledTimes(3);
      expect(dialogText()).toContain("Installing an update");
      expect(window.sessionStorage.getItem(MARKER)).toBe("1");
      expect(warn).toHaveBeenCalledOnce();
    });

    it("a failed query never releases a known block, even when its late answer comes", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      window.sessionStorage.setItem(MARKER, "1");
      let late!: (state: State) => void;
      const answers: (() => Promise<State>)[] = [
        () =>
          new Promise<State>((resolve) => {
            late = resolve;
          }),
        () => new Promise<State>(() => {}),
      ];
      const bridge = stateBridge(() => answers.shift()!());
      await loadWindow(bridge);
      await advance(5_000);
      await act(async () => late(notRunning));
      expect(dialogText()).toContain("Installing an update");
      expect(window.sessionStorage.getItem(MARKER)).toBe("1");
    });

    it("a pushed update state ends the wait", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      window.sessionStorage.setItem(MARKER, "1");
      const bridge = stateBridge(() => Promise.reject(new Error("state unavailable")));
      await loadWindow(bridge);
      await advance(0);
      expect(bridge.getUpdateState).toHaveBeenCalledOnce();
      await act(async () => bridge.pushState!(running));
      await advance(10_000);
      expect(bridge.getUpdateState).toHaveBeenCalledOnce();
      expect(dialogText()).toContain("Installing an update");
    });

    it("a desktop without getUpdateState clears a stale marker and holds nothing", async () => {
      window.sessionStorage.setItem(MARKER, "1");
      const loaded = await loadWindow(stateBridge());
      expect(dialogText()).toBeUndefined();
      expect(window.sessionStorage.getItem(MARKER)).toBeNull();
      const persist = vi.fn<Persist>(async () => saved());
      const session = loaded.openFile("notes.md", persist);
      session.changeFromRichEditor("free edit");
      await act(async () => {
        await expect(session.flush()).resolves.toBe("saved");
      });
    });

    it("an unusable sessionStorage means no marker and no crash", async () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("storage disabled");
      });
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("storage disabled");
      });
      const bridge = stateBridge(async () => notRunning);
      await loadWindow(bridge);
      await advance(0);
      expect(dialogText()).toBeUndefined();
      // An allowed install still blocks, without a marker to restore it.
      await act(async () => bridge.send!({ requestId: 4, reason: "update" }));
      await advance(0);
      await vi.waitFor(() => expect(bridge.replies.at(-1)).toEqual([4, "allow"]), {
        timeout: 30_000,
      });
      expect(dialogText()).toContain("Installing an update");
    });
  });

  it("answers a desktop close request through the bridge", async () => {
    await act(async () => root.unmount());
    const replies: [number, string][] = [];
    let send: ((request: DesktopCloseRequest) => void) | null = null;
    window.desktopBridge = {
      onCloseRequest: (listener: (request: DesktopCloseRequest) => void) => {
        send = listener;
        return () => {
          send = null;
        };
      },
      replyCloseRequest: async (requestId: number, reply: string) => {
        replies.push([requestId, reply]);
      },
    } as unknown as DesktopBridge;
    try {
      root = createRoot(container);
      await act(async () => root.render(<UnsavedChangesCloseHost />));
      const session = openFile(newRegistry(), "notes.md");
      session.changeFromRichEditor("my edit");

      await act(async () => send!({ requestId: 9, reason: "close" }));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(dialogText()).toContain("notes.md");
      await click("Save all");
      await vi.waitFor(() => expect(replies.at(-1)).toEqual([9, "allow"]));
      expect(replies[0]).toEqual([9, "acknowledge"]);
    } finally {
      delete window.desktopBridge;
    }
  });
});
