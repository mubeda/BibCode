// @vitest-environment happy-dom

/**
 * Leaving an edited file's tab and coming back, through the real panel, editing session, session
 * registry, save coordinator, disk watcher, Pierre editor and Pierre worker pool. Only the seams
 * outside the web client are fakes: the file query, the file RPCs, and the worker transport. The
 * in-thread worker answers like Pierre's own worker, with the same highlighter, but holds its file
 * responses until the test releases them, so a highlight can still be in flight when the first
 * edit lands, as it is on a cold desktop app.
 */

import { EnvironmentId, ThreadId, type ResolvedKeybindingsConfig } from "@bibcode/contracts";
import { getSharedHighlighter, renderFileWithHighlighter } from "@pierre/diffs";
import { WorkerPoolContextProvider, useWorkerPool } from "@pierre/diffs/react";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

interface FakeRead {
  readonly relativePath: string;
  readonly contents: string;
  readonly byteLength: number;
  readonly truncated: boolean;
  readonly version?: string;
}

const fake = vi.hoisted(() => {
  const state = {
    disk: { contents: "", version: "v0" },
    query: null as FakeRead | null,
    overlay: null as FakeRead | null,
    listeners: new Set<() => void>(),
    toolbar: null as null | { canUndo?: boolean; savePhase?: string },
    /** Resolves a held write; null while writes complete at once. */
    heldWrite: null as null | (() => void),
    holdWrites: false,
    notify() {
      for (const listener of state.listeners) listener();
    },
    readDisk(): FakeRead {
      return {
        relativePath: "pierre-edit.ts",
        contents: state.disk.contents,
        byteLength: state.disk.contents.length,
        truncated: false,
        version: state.disk.version,
      };
    },
  };
  return state;
});

vi.mock("~/browser/openFileInPreview", () => ({
  isBrowserPreviewFile: () => false,
  openFileInPreview: vi.fn(),
}));
vi.mock("~/components/ChatMarkdown", () => ({ default: () => null }));
vi.mock("~/components/chat/OpenInPicker", () => ({ OpenInPicker: () => null }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (selector: (settings: { wordWrap: boolean }) => unknown) =>
    selector({ wordWrap: true }),
}));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" as const }) }));
vi.mock("~/hooks/useLocalStorage", () => ({
  getLocalStorageItem: () => false,
  setLocalStorageItem: vi.fn(),
}));
vi.mock("~/previewStateStore", () => ({
  isPreviewSupportedInRuntime: () => false,
  canPreviewAnyUrlInRuntime: () => false,
}));
vi.mock("~/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: () => null,
  TooltipPopup: () => null,
}));
vi.mock("~/components/ui/toggle", () => ({ Toggle: () => null }));
vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: (selector: (store: Record<string, unknown>) => unknown) =>
    selector({ addReviewComment: vi.fn(), removeReviewComment: vi.fn() }),
}));
vi.mock("~/state/environments", () => ({
  usePrimaryEnvironmentId: () => null,
  useEnvironmentHttpBaseUrl: () => null,
  useEnvironmentConnectionState: () => ({ data: { phase: "connected", generation: 1 } }),
}));
vi.mock("~/state/assets", () => ({ assetEnvironment: { createUrl: { label: "createUrl" } } }));
vi.mock("~/state/preview", () => ({ previewEnvironment: { open: { label: "open" } } }));
vi.mock("~/state/projects", () => ({
  projectEnvironment: {
    writeFile: { label: "writeFile" },
    writeFileIfUnchanged: { label: "writeFileIfUnchanged" },
    getFileVersion: { label: "getFileVersion" },
  },
}));

const rpc = vi.hoisted(() => ({
  writeFileIfUnchanged: async ({
    input,
  }: {
    input: { contents: string; precondition: { _tag: string; version?: string } };
  }) => {
    const { AsyncResult } = await import("effect/reactivity");
    if (fake.holdWrites) await new Promise<void>((resolve) => (fake.heldWrite = resolve));
    if (input.precondition.version !== fake.disk.version) {
      return AsyncResult.failure({ failure: "file_changed_on_disk" } as never);
    }
    fake.disk = { contents: input.contents, version: `v:${input.contents}` };
    return AsyncResult.success({ relativePath: "pierre-edit.ts", version: fake.disk.version });
  },
  getFileVersion: async () => {
    const { AsyncResult } = await import("effect/reactivity");
    return AsyncResult.success({ _tag: "present", version: fake.disk.version });
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) =>
    command.label === "writeFileIfUnchanged"
      ? rpc.writeFileIfUnchanged
      : command.label === "getFileVersion"
        ? rpc.getFileVersion
        : vi.fn(),
}));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("./FileBrowserPanel", () => ({ default: () => null }));
vi.mock("./FileEditorToolbar", () => ({
  FileEditorToolbar: (props: { canUndo?: boolean; savePhase?: string }) => {
    fake.toolbar = props;
    return null;
  },
}));
// The file query: the server read plus the optimistic copy a save leaves, as the real module keeps them.
vi.mock("./projectFilesQueryState", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    fake.listeners.add(listener);
    return () => fake.listeners.delete(listener);
  };
  let snapshot: { query: unknown; overlay: unknown; data: unknown; disk: unknown } | null = null;
  const getSnapshot = () => {
    if (snapshot?.query === fake.query && snapshot.overlay === fake.overlay) return snapshot;
    snapshot = {
      query: fake.query,
      overlay: fake.overlay,
      data: fake.overlay ?? fake.query,
      disk: fake.overlay?.version === undefined ? fake.query : fake.overlay,
    };
    return snapshot;
  };
  const reread = () => {
    fake.overlay = null;
    fake.query = fake.readDisk();
    fake.notify();
    return fake.query;
  };
  return {
    useProjectFileQuery: () => {
      const current = useSyncExternalStore(subscribe, getSnapshot);
      return { ...current, error: null, isPending: false, refresh: vi.fn(), revalidate: vi.fn() };
    },
    setProjectFileQueryData: (
      _environmentId: unknown,
      _cwd: unknown,
      relativePath: string,
      contents: string,
      version?: string,
    ) => {
      fake.overlay = {
        relativePath,
        contents,
        byteLength: contents.length,
        truncated: false,
        ...(version === undefined ? {} : { version }),
      };
      fake.notify();
    },
    confirmProjectFileQueryData: () => {
      queueMicrotask(reread);
      return true;
    },
    getOptimisticProjectFileQueryData: () => fake.overlay,
    clearProjectFileQueryData: () => {
      fake.overlay = null;
      fake.notify();
    },
    rereadProjectFile: async () => reread(),
  };
});

import type { FileCommentAnnotationGroup } from "./fileCommentAnnotations";
import { FileEditingSession } from "./fileEditingSession";
import { FileEditingSessionRegistry } from "./fileEditingSessionRegistry";
import FilePreviewPanel from "./FilePreviewPanel";

type WorkerRequest =
  | {
      readonly type: "initialize" | "set-render-options";
      readonly id: string;
      readonly renderOptions: never;
    }
  | {
      readonly type: "file";
      readonly id: string;
      readonly file: Parameters<typeof renderFileWithHighlighter>[0];
    };

/** Pierre's diffs worker, run on this thread; file responses wait for `releaseHighlights`. */
class InThreadDiffsWorker {
  static heldHighlights: Array<() => void> = [];
  /** The text of each file highlight the pool asked for, in order. */
  static requestedHighlights: string[] = [];
  private readonly listeners = new Set<(event: { data: unknown }) => void>();
  private renderOptions: {
    theme?: unknown;
    useTokenTransformer?: boolean;
    tokenizeMaxLineLength?: number;
  } = {};

  addEventListener(type: string, listener: (event: { data: unknown }) => void): void {
    if (type === "message") this.listeners.add(listener);
  }

  removeEventListener(): void {}

  terminate(): void {
    this.listeners.clear();
  }

  postMessage(request: WorkerRequest): void {
    // A real worker receives a structured clone, so later changes to the sender's objects never reach it.
    void this.respond(structuredClone(request)).then((response) => {
      for (const listener of this.listeners) listener({ data: response });
    });
  }

  private async respond(request: WorkerRequest): Promise<unknown> {
    if (request.type !== "file") {
      if (request.type === "initialize") this.renderOptions = request.renderOptions;
      return { type: "success", id: request.id, requestType: request.type };
    }
    InThreadDiffsWorker.requestedHighlights.push(request.file.contents);
    await new Promise<void>((resolve) => InThreadDiffsWorker.heldHighlights.push(resolve));
    const options = {
      theme: this.renderOptions.theme,
      useTokenTransformer: this.renderOptions.useTokenTransformer,
      tokenizeMaxLineLength: this.renderOptions.tokenizeMaxLineLength,
    };
    const highlighter = await getSharedHighlighter({
      themes: [options.theme as never],
      langs: ["typescript"],
    });
    return {
      type: "success",
      requestType: "file",
      id: request.id,
      result: renderFileWithHighlighter(request.file, highlighter, options as never),
      options,
    };
  }
}

/** The pool the panel renders with, read the way the panel reads it. */
let workerPool: ReturnType<typeof useWorkerPool>;
function WorkerPoolProbe() {
  const pool = useWorkerPool();
  useEffect(() => {
    workerPool = pool;
  }, [pool]);
  return null;
}

/** The highlighted text the pool holds for `cacheKey`, or null when it holds none. */
function cachedHighlightText(cacheKey: string): string | null {
  const cached = workerPool?.getFileResultCache({ name: "pierre-edit.ts", contents: "", cacheKey });
  if (cached === undefined) return null;
  const text: string[] = [];
  const collect = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) collect(child);
      return;
    }
    if (node === null || typeof node !== "object") return;
    const { type, value, children } = node as {
      type?: unknown;
      value?: unknown;
      children?: unknown;
    };
    if (type === "text" && typeof value === "string") text.push(value);
    collect(children);
  };
  collect((cached.result as { code?: unknown }).code);
  return text.join("");
}

function releaseHighlights(): void {
  const held = InThreadDiffsWorker.heldHighlights.splice(0);
  for (const release of held) release();
}

const environmentId = EnvironmentId.make("environment-1");
const threadRef = { environmentId, threadId: ThreadId.make("thread-1") };
const ORIGINAL = 'export const editableMessage = "original packaged text";\n';
const EDITED = 'export const editableMessage = "edited packaged text";';

describe("FilePreviewPanel across a right-panel tab switch", () => {
  let container: HTMLDivElement;
  let root: Root;
  let canvasGetContext: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    canvasGetContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      font: "",
      measureText: (text: string) => ({ width: text.length * 8 }),
    } as unknown as CanvasRenderingContext2D);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    fake.disk = { contents: ORIGINAL, version: "v0" };
    fake.query = fake.readDisk();
    fake.overlay = null;
    fake.toolbar = null;
    fake.heldWrite = null;
    fake.holdWrites = false;
    InThreadDiffsWorker.heldHighlights = [];
    InThreadDiffsWorker.requestedHighlights = [];
  });

  afterEach(async () => {
    fake.heldWrite?.();
    releaseHighlights();
    await act(async () => root.unmount());
    container.remove();
    canvasGetContext.mockRestore();
  });

  it.each([
    { save: "landed before the tab comes back", holdWrites: false },
    { save: "still in flight when the tab comes back", holdWrites: true },
  ])(
    "keeps the edited text and its Undo when the file tab returns (save $save)",
    async ({ holdWrites }) => {
      fake.holdWrites = holdWrites;
      const registry = new FileEditingSessionRegistry<
        FileEditingSession<FileCommentAnnotationGroup>
      >();
      const panelProps = {
        environmentId,
        cwd: "/repo",
        projectName: "repo",
        relativePath: "pierre-edit.ts",
        threadRef,
        composerDraftTarget: threadRef,
        keybindings: [] as ResolvedKeybindingsConfig,
        availableEditors: [],
        revealLine: null,
        revealRequestId: 0,
        onOpenFile: vi.fn(),
        onPendingChange: vi.fn(),
        onConflictChange: vi.fn(),
        editingSessions: registry,
      };
      // The chat view keeps the worker pool and the registry while right-panel tabs change.
      const render = async (fileTabActive: boolean) => {
        await act(async () => {
          root.render(
            <WorkerPoolContextProvider
              poolOptions={{ workerFactory: () => new InThreadDiffsWorker() as never, poolSize: 1 }}
              highlighterOptions={{
                theme: "pierre-dark",
                tokenizeMaxLineLength: 1_000,
                useTokenTransformer: true,
              }}
            >
              <WorkerPoolProbe />
              {fileTabActive ? <FilePreviewPanel {...panelProps} /> : <div data-diff-panel />}
            </WorkerPoolContextProvider>,
          );
          registry.setActivePath(fileTabActive ? "pierre-edit.ts" : null);
        });
      };
      const settle = async (until: () => boolean) => {
        for (let attempt = 0; attempt < 100 && !until(); attempt += 1) {
          await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10));
          });
        }
      };
      const editorText = () =>
        container.querySelector("diffs-container")?.shadowRoot?.querySelector('[role="textbox"]')
          ?.textContent ?? null;

      await render(true);
      await settle(
        () => editorText() !== null && InThreadDiffsWorker.requestedHighlights.length > 0,
      );
      expect(editorText()).toContain("original packaged text");
      const session = registry.get("pierre-edit.ts")!;

      // The first edit lands while the opening highlight is still in the worker.
      expect(InThreadDiffsWorker.heldHighlights).toHaveLength(1);
      await act(async () => {
        session.editor.applyEdits([
          {
            range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
            newText: EDITED,
          },
        ]);
      });
      expect(fake.toolbar).toMatchObject({ canUndo: true, savePhase: "pending" });
      // The opening highlight's reply lands after the edit and is stored under the session's key.
      releaseHighlights();
      await settle(() => cachedHighlightText(session.cacheKey) !== null);
      expect(cachedHighlightText(session.cacheKey)).toContain("original packaged text");
      expect(editorText()).toBe(EDITED);

      // Diff tab: the panel unmounts and the registry flushes the edit.
      await render(false);
      await settle(() => holdWrites || fake.disk.contents === EDITED);
      expect(fake.disk.contents).toBe(holdWrites ? ORIGINAL : EDITED);

      // Back to the file tab. Pierre reports the attach on its next render frame.
      await render(true);
      releaseHighlights();
      await settle(
        () =>
          InThreadDiffsWorker.heldHighlights.length === 0 &&
          editorText()?.includes("edited packaged text") === true &&
          fake.toolbar?.canUndo === true,
      );

      expect(editorText()).toBe(EDITED);
      expect(fake.toolbar?.canUndo).toBe(true);

      fake.heldWrite?.();
      await settle(() => fake.disk.contents === EDITED);
      expect(editorText()).toBe(EDITED);
      expect(fake.toolbar).toMatchObject({ canUndo: true, savePhase: "clean" });
      await act(async () => session.undo());
      expect(editorText()).toContain("original packaged text");
    },
  );
});
