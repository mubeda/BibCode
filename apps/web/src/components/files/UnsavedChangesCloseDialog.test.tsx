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
