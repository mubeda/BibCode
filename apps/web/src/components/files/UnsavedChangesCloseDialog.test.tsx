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
        expect.objectContaining({ type: "error", title: "The update did not install" }),
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
