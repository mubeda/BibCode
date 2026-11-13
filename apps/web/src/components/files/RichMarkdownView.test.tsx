// @vitest-environment happy-dom

import { EnvironmentId, ThreadId } from "@bibcode/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const surfaceModule = vi.hoisted(() => {
  let release!: () => void;
  const loaded = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { loaded, release: () => release() };
});

// The editor chunk loads only when the test releases it, as a first lazy load does.
vi.mock("./richMarkdown/RichMarkdownSurface", async () => {
  await surfaceModule.loaded;
  return { default: () => <div data-rich-surface tabIndex={-1} /> };
});

import { RichMarkdownView } from "./RichMarkdownView";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("RichMarkdownView", () => {
  it("saves on the save shortcut once the editor's first lazy load resolves", async () => {
    const session = {
      flush: vi.fn(async () => "saved"),
      getSnapshot: () => ({ editPending: false }),
      changeFromRichEditor: vi.fn(),
      setPendingEditFlusher: vi.fn(),
      commitRichEdits: vi.fn(),
      setComposing: vi.fn(),
    };
    await act(async () => {
      root.render(
        <RichMarkdownView
          session={session}
          contents="# Title\n"
          onEditorChange={vi.fn()}
          workspace={{
            environmentId: EnvironmentId.make("environment-1"),
            threadId: ThreadId.make("thread-1"),
            cwd: "/repo",
            markdownPath: "notes.md",
          }}
          fallback={<div data-fallback />}
        />,
      );
    });
    expect(container.querySelector("[data-fallback]")).not.toBeNull();

    await act(async () => {
      surfaceModule.release();
      await vi.dynamicImportSettled();
    });
    const surface = container.querySelector<HTMLElement>("[data-rich-surface]");
    expect(surface).not.toBeNull();

    const chord = new KeyboardEvent("keydown", {
      key: "s",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    surface!.dispatchEvent(chord);

    expect(session.flush).toHaveBeenCalledOnce();
    expect(chord.defaultPrevented).toBe(true);
  });
});
