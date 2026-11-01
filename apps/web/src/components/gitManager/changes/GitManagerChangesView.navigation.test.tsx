// @vitest-environment happy-dom

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useGitManagerStore } from "../../../gitManagerStore";

const h = vi.hoisted(() => ({
  listProps: null as { onSelect: (path: string) => void } | null,
  scrollTo: vi.fn(),
  patches: {} as Record<string, string>,
  files: [] as ReadonlyArray<string>,
  pending: new Set<string>(),
  failing: new Set<string>(),
  // Data the query still holds from an earlier read of the path.
  stale: {} as Record<string, unknown>,
}));

vi.mock("../../../state/vcs", () => ({
  vcsEnvironment: {
    status: () => ({ kind: "status" }),
    refreshStatus: "cmd",
    stageFiles: "cmd",
    unstageFiles: "cmd",
  },
}));
vi.mock("../../../state/gitManager", () => ({
  gitManagerEnvironment: {
    getRefs: () => ({ kind: "refs" }),
    getCommits: () => ({ kind: "commits" }),
    getDiff: (target: { input: { source: { path: string } } }) => ({
      kind: "diff",
      path: target.input.source.path,
    }),
    commit: "cmd",
    undoCommit: "cmd",
    discard: "cmd",
    stagePartial: "cmd",
    unstagePartial: "cmd",
  },
}));
vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: (atom: { kind?: string; path?: string } | null) => {
    const base = { error: null, emission: null, revalidate: () => {}, refresh: () => {} };
    if (atom?.kind === "status") {
      return {
        ...base,
        isPending: false,
        data: {
          isRepo: true,
          refName: "main",
          workingTree: {
            files: h.files.map((path) => ({
              path,
              status: "modified",
              area: "unstaged",
              insertions: 1,
              deletions: 1,
            })),
          },
        },
      };
    }
    if (atom?.kind === "refs") {
      return {
        ...base,
        isPending: false,
        data: { conflictedPaths: [], headRef: "main", isDirty: true, localBranches: [] },
      };
    }
    if (atom?.kind === "diff" && h.pending.has(atom.path ?? "")) {
      return { ...base, isPending: true, data: h.stale[atom.path ?? ""] ?? null };
    }
    if (atom?.kind === "diff" && h.failing.has(atom.path ?? "")) {
      return {
        ...base,
        isPending: false,
        data: h.stale[atom.path ?? ""] ?? null,
        error: "Could not read this diff.",
      };
    }
    if (atom?.kind === "diff") {
      const patch = h.patches[atom.path ?? ""] ?? "";
      return {
        ...base,
        isPending: false,
        data: {
          _tag: "patch",
          generation: 1,
          byteLength: patch.length,
          longestLineLength: 80,
          patch,
        },
      };
    }
    return { ...base, isPending: false, data: null };
  },
}));
vi.mock("../../../state/entities", () => ({
  useProject: () => ({ workspaceRoot: "/repo" }),
  useServerConfigs: () => new Map(),
  useThreadShellsForProjectRefs: () => [],
}));
vi.mock("../../../editorPreferences", () => ({ useOpenInPreferredEditor: () => vi.fn() }));
vi.mock("../../../localApi", () => ({ readLocalApi: () => undefined }));
vi.mock("../../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("./GitManagerChangesList", () => ({
  GitManagerChangesList: (props: { onSelect: (path: string) => void }) => {
    h.listProps = props;
    return <div data-testid="list" tabIndex={0} />;
  },
}));
vi.mock("./GitManagerCommitBox", () => ({ GitManagerCommitBox: () => null }));
vi.mock("./GitManagerAgentActivity", () => ({ GitManagerAgentActivity: () => null }));
vi.mock("../../diffs/AnnotatableCodeView", () => ({
  AnnotatableCodeView: (props: { viewerRef?: (handle: unknown) => void }) => {
    const { viewerRef } = props;
    useEffect(() => {
      viewerRef?.({ scrollTo: h.scrollTo });
    }, [viewerRef]);
    return <div data-testid="code-view" />;
  },
}));
vi.mock("../../DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { GitManagerChangesView } from "./GitManagerChangesView";

const projectRef = { environmentId: "environment-1", projectId: "project-1" } as never;

/** Each `@@` start line is one block of changes. */
function patchFor(path: string, hunkStarts: ReadonlyArray<number>): string {
  const hunks = hunkStarts
    .map((start) => `@@ -${start} +${start} @@\n-before ${start}\n+after ${start}\n`)
    .join("");
  return `:100644 100644 1111111 0000000 M\0${path}\0\0diff --git a/${path} b/${path}\nindex 1111111..2222222 100644\n--- a/${path}\n+++ b/${path}\n${hunks}`;
}

let container: HTMLDivElement;
let root: Root;

const selectedPath = () =>
  useGitManagerStore.getState().selectViewState(projectRef).selectedFilePath;
const button = (name: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
const lastScroll = () => h.scrollTo.mock.lastCall?.[0] as { lineNumber: number };

async function select(path: string) {
  await act(async () => h.listProps!.onSelect(path));
}

async function press(init: KeyboardEventInit) {
  await act(async () => {
    document
      .querySelector('[data-testid="list"]')!
      .dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
}

const view = () => (
  <GitManagerChangesView
    scope={{ environmentId: "environment-1" as never, cwd: "/repo" }}
    projectRef={projectRef}
    refsRecovering={false}
    repositoryUnavailable={null}
    retrying={false}
    onRetry={() => {}}
  />
);

beforeEach(async () => {
  h.pending.clear();
  h.failing.clear();
  h.stale = {};
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.scrollTo.mockClear();
  h.files = ["a.ts", "b.ts", "c.png"];
  h.patches = {
    "a.ts": patchFor("a.ts", [1, 10]),
    "b.ts": patchFor("b.ts", [5, 20, 30]),
    "c.png": `:100644 100644 1111111 0000000 M\0c.png\0\0diff --git a/c.png b/c.png\nBinary files a/c.png and b/c.png differ\n`,
  };
  useGitManagerStore.setState({ byProjectKey: {} });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(view()));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("Changes diff navigation", () => {
  it("F7 walks the changes of a file, then enters the next file at its first change", async () => {
    await select("a.ts");

    await press({ key: "F7" });
    expect(lastScroll().lineNumber).toBe(1);
    await press({ key: "F7" });
    expect(lastScroll().lineNumber).toBe(10);
    expect(selectedPath()).toBe("a.ts");

    await press({ key: "F7" });
    expect(selectedPath()).toBe("b.ts");
    expect(lastScroll().lineNumber).toBe(5);
  });

  it("Shift+F7 enters the previous file at its last change", async () => {
    await select("b.ts");

    await press({ key: "F7", shiftKey: true });

    expect(selectedPath()).toBe("a.ts");
    expect(lastScroll().lineNumber).toBe(10);
  });

  it("the buttons step the same way", async () => {
    await select("a.ts");

    await act(async () => button("Next change").click());
    await act(async () => button("Next change").click());
    expect(lastScroll().lineNumber).toBe(10);
    await act(async () => button("Next change").click());

    expect(selectedPath()).toBe("b.ts");
    expect(lastScroll().lineNumber).toBe(5);
  });

  it("ends the walk on the last file, where Next is inactive", async () => {
    await select("b.ts");
    await press({ key: "F7" });
    await press({ key: "F7" });
    await press({ key: "F7" });
    expect(lastScroll().lineNumber).toBe(30);

    // c.png is binary and has no change to land on, and no file follows it.
    await press({ key: "F7" });
    expect(selectedPath()).toBe("c.png");
    expect(button("Next change").getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps Previous inactive and inert at the first change of the first file", async () => {
    await select("a.ts");
    expect(button("Previous change").getAttribute("aria-disabled")).toBe("true");
    expect(button("Next change").getAttribute("aria-disabled")).toBe("false");

    await act(async () => button("Previous change").click());

    expect(h.scrollTo).not.toHaveBeenCalled();
    expect(selectedPath()).toBe("a.ts");
  });

  it("starts from the first file when nothing is selected", async () => {
    await press({ key: "F7" });

    expect(selectedPath()).toBe("a.ts");
    expect(lastScroll().lineNumber).toBe(1);
  });

  it("waits for a diff that is still loading instead of passing the file over", async () => {
    h.pending.add("a.ts");
    await select("a.ts");

    await press({ key: "F7" });

    expect(selectedPath()).toBe("a.ts");
    expect(h.scrollTo).not.toHaveBeenCalled();
    expect(button("Next change").getAttribute("aria-disabled")).toBe("true");

    h.pending.clear();
    await act(async () => root.render(view()));
    await press({ key: "F7" });

    expect(selectedPath()).toBe("a.ts");
    expect(lastScroll().lineNumber).toBe(1);
  });

  it("keeps keyboard focus in the diff across the file boundary", async () => {
    await select("a.ts");
    await act(async () => button("Next change").focus());
    const pressFocused = () =>
      act(async () => {
        document.activeElement!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "F7", bubbles: true, cancelable: true }),
        );
      });

    await pressFocused();
    await pressFocused();
    await pressFocused();
    expect(selectedPath()).toBe("b.ts");
    expect(document.activeElement?.closest('section[aria-label="Diff for b.ts"]')).not.toBeNull();

    await pressFocused();
    expect(lastScroll().lineNumber).toBe(20);
  });

  it("stops on a file whose diff failed to load and shows the error", async () => {
    h.failing.add("b.ts");
    await select("a.ts");
    await press({ key: "F7" });
    await press({ key: "F7" });

    await press({ key: "F7" });

    expect(selectedPath()).toBe("b.ts");
    expect(container.textContent).toContain("Could not read this diff.");
    // Asking again moves on: the stop was for the error to be seen, not a dead end.
    await press({ key: "F7" });
    expect(selectedPath()).toBe("c.png");
  });

  it("waits for the refresh of a file that last read as too large instead of skipping it", async () => {
    h.stale["b.ts"] = { _tag: "large-text", generation: 1 };
    h.pending.add("b.ts");
    await select("a.ts");
    await press({ key: "F7" });
    await press({ key: "F7" });

    await press({ key: "F7" });

    expect(selectedPath()).toBe("b.ts");

    // The fresh read is a patch: the walk lands on its first block instead of having moved on.
    h.pending.clear();
    await act(async () => root.render(view()));
    expect(selectedPath()).toBe("b.ts");
    expect(lastScroll().lineNumber).toBe(5);
  });

  it("stops on a file whose refresh failed even though older data is held", async () => {
    h.stale["b.ts"] = { _tag: "large-text", generation: 1 };
    h.failing.add("b.ts");
    await select("a.ts");
    await press({ key: "F7" });
    await press({ key: "F7" });

    await press({ key: "F7" });

    expect(selectedPath()).toBe("b.ts");
    expect(container.textContent).toContain("Could not read this diff.");
  });

  it("keeps keyboard focus in the diff when the walk ends at a trailing binary file", async () => {
    await select("b.ts");
    await act(async () => button("Next change").focus());
    const pressFocused = (init: KeyboardEventInit) =>
      act(async () => {
        document.activeElement!.dispatchEvent(
          new KeyboardEvent("keydown", { key: "F7", bubbles: true, cancelable: true, ...init }),
        );
      });

    for (let step = 0; step < 4; step += 1) await pressFocused({});
    expect(selectedPath()).toBe("c.png");
    expect(document.activeElement?.closest('section[aria-label="Diff for c.png"]')).not.toBeNull();

    await pressFocused({ shiftKey: true });
    expect(selectedPath()).toBe("b.ts");
    expect(lastScroll().lineNumber).toBe(30);
  });

  it("leaves other keys alone", async () => {
    await select("a.ts");

    await press({ key: "F8" });

    expect(h.scrollTo).not.toHaveBeenCalled();
  });
});
