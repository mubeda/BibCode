// @vitest-environment happy-dom

import { EnvironmentId, ThreadId } from "@bibcode/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

vi.mock("./richMarkdown/RichMarkdownSurface", () => ({
  default: () => <div data-rich-surface />,
}));

import { preloadRichMarkdownSurface, RichMarkdownView } from "./RichMarkdownView";

it("opens a file on the editor, never the read-only fallback, once the editor chunk is preloaded", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // The fallback draws the file's Mermaid diagrams; the editor replacing it draws them again.
  const fallbackCommitted = vi.fn();
  await preloadRichMarkdownSurface();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <RichMarkdownView
        session={{
          flush: vi.fn(async () => "saved"),
          getSnapshot: () => ({ editPending: false }),
          changeFromRichEditor: vi.fn(),
          setPendingEditFlusher: vi.fn(),
          commitRichEdits: vi.fn(),
          setComposing: vi.fn(),
        }}
        contents="# Title\n"
        onEditorChange={vi.fn()}
        workspace={{
          environmentId: EnvironmentId.make("environment-1"),
          threadId: ThreadId.make("thread-1"),
          cwd: "/repo",
          markdownPath: "notes.md",
        }}
        fallback={<div data-fallback ref={fallbackCommitted} />}
      />,
    );
  });
  expect(container.querySelector("[data-rich-surface]")).not.toBeNull();
  expect(fallbackCommitted).not.toHaveBeenCalled();
  act(() => root.unmount());
  container.remove();
});
