// @vitest-environment happy-dom
// @effect-diagnostics nodeBuiltinImport:off - Read only the owned fixture inputs and serialized qualification reader.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeVM from "node:vm";
import {
  EnvironmentId,
  ProjectId,
  type GitManagerCommitEntry,
  type GitManagerDiff,
} from "@bibcode/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { GitManagerDiffPane } from "./GitManagerDiffPane";
import { GitManagerCommitDetail } from "../history/GitManagerCommitDetail";

const state = vi.hoisted(() => ({
  diff: null as GitManagerDiff | null,
  getDiff: vi.fn((input: unknown) => input),
  codeViewFiles: [] as Array<{ fileDiff: { hunks: unknown[]; type: string } }>,
}));
vi.mock("../../../state/gitManager", () => ({
  gitManagerEnvironment: {
    getDiff: state.getDiff,
    stagePartial: "stage",
    unstagePartial: "unstage",
  },
}));
vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: state.diff,
    error: null,
    isPending: false,
    revalidate: () => {},
  }),
}));
vi.mock("../../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("../../../composerDraftStore", () => ({ DraftId: { make: (value: string) => value } }));
vi.mock("../../../gitManagerStore", () => {
  const defaults = { lineSelectionByPath: {}, imageDiffMode: "two-up" };
  const snapshot = {
    byProjectKey: {},
    setLineSelection: vi.fn(),
    setImageDiffMode: vi.fn(),
    selectViewState: () => defaults,
  };
  const useGitManagerStore = Object.assign(
    (select: (value: typeof snapshot) => unknown) => select(snapshot),
    { getState: () => snapshot },
  );
  return { DEFAULT_GIT_MANAGER_VIEW_STATE: defaults, useGitManagerStore };
});
vi.mock("../../diffs/AnnotatableCodeView", () => ({
  AnnotatableCodeView: (props: { files: typeof state.codeViewFiles }) => {
    state.codeViewFiles = props.files;
    return <div data-testid="inert-code-renderer" />;
  },
}));
vi.mock("../../DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@legendapp/list/react", () => ({
  LegendList: (props: {
    data: string[];
    renderItem: (input: { item: string; index: number }) => ReactNode;
  }) => (
    <>
      {props.data.map((item, index) => (
        <div key={item}>{props.renderItem({ item, index })}</div>
      ))}
    </>
  ),
}));

it("requires the supported commit image pane rather than treating the working-tree PNG row as an image preview", async () => {
  // oxlint-disable-next-line bibcode/no-global-process-runtime -- Only locate this checkout in its two documented test command working directories.
  const cwd = NodeProcess.cwd();
  const repo = NodeFS.existsSync(NodePath.join(cwd, "apps/desktop/package.json"))
    ? cwd
    : NodePath.resolve(cwd, "../..");
  const readerSource = NodeFS.readFileSync(
    NodePath.join(repo, "apps/desktop/e2e/support/release-visual-observation.ts"),
    "utf8",
  );
  const readers = NodeVM.runInNewContext(
    NodeModule.stripTypeScriptTypes(readerSource).replace(/^export /gm, "") +
      "\n({readVisualImageLoaded, readVisualWorkingImageSelected})",
    {
      document,
      location: {
        origin: "http://127.0.0.1:4885",
        pathname: "/project/local/owned/git",
        search: "",
        hash: "",
      },
    },
  ) as {
    readVisualImageLoaded: () => boolean;
    readVisualWorkingImageSelected: (input: { branch: string }) => boolean;
  };
  const read = readers.readVisualImageLoaded;
  const fixtureSource = NodeFS.readFileSync(
    NodePath.join(repo, "apps/desktop/e2e/support/release-visual-fixture.ts"),
    "utf8",
  );
  const swatches = [...fixtureSource.matchAll(/"(iVBORw0KGgo[A-Za-z0-9+/=]+)"/g)].map(
    (match) => match[1]!,
  );
  expect(swatches).toHaveLength(2);
  const environmentId = EnvironmentId.make("local"),
    projectId = ProjectId.make("owned");
  const path = "visual-swatch.png";
  const binaryPatch = `:100644 100644 ${"1".repeat(40)} ${"2".repeat(40)} M\0${path}\0\ndiff --git a/${path} b/${path}\nindex ${"1".repeat(40)}..${"2".repeat(40)} 100644\nBinary files a/${path} and b/${path} differ\n`;
  const container = document.createElement("div");
  document.body.append(container);
  const chrome = document.createElement("div");
  chrome.innerHTML =
    '<button aria-label="Worktree">codex/delivery-retry-light</button><button aria-label="Choose branch">codex/delivery-retry-light</button><button role="option" data-path="visual-swatch.png" aria-selected="true">Owned image row</button>';
  document.body.append(chrome);
  const root = createRoot(container);
  const fetchSpy = vi.fn(() => {
    throw new Error("No external request in an inert image seam.");
  });
  vi.stubGlobal("fetch", fetchSpy);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  try {
    state.diff = {
      _tag: "patch",
      generation: 1,
      source: { _tag: "working-tree", path, staged: false },
      byteLength: binaryPatch.length,
      longestLineLength: 127,
      patch: binaryPatch,
    };
    await act(async () =>
      root.render(
        <GitManagerDiffPane
          scope={{ environmentId, cwd: "/owned" }}
          projectRef={{ environmentId, projectId }}
          path={path}
          availableAreas={["unstaged"]}
          mutationBusy={false}
          partialStagingDisabledReason={null}
        />,
      ),
    );
    expect(state.getDiff).toHaveBeenLastCalledWith({
      environmentId,
      input: { cwd: "/owned", source: { _tag: "working-tree", path, staged: false } },
    });
    expect(
      container.querySelector('section[aria-label="Diff for visual-swatch.png"]'),
    ).not.toBeNull();
    expect(container.querySelector('section[aria-label="Image diff"]')).toBeNull();
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(read()).toBe(false);
    expect(state.codeViewFiles).toHaveLength(1);
    expect(state.codeViewFiles[0]?.fileDiff.hunks).toHaveLength(0);
    expect(
      container.querySelector('aside[aria-label="Partial staging selection gutter"]'),
    ).not.toBeNull();
    expect(
      container.querySelectorAll('button[aria-label^="Toggle changed-line run starting at line"]'),
    ).toHaveLength(0);
    const workingPane = container.querySelector<HTMLElement>(
      'section[aria-label="Diff for visual-swatch.png"]',
    )!;
    vi.spyOn(workingPane, "getBoundingClientRect").mockReturnValue({ height: 192 } as DOMRect);
    expect(readers.readVisualWorkingImageSelected({ branch: "codex/delivery-retry-light" })).toBe(
      true,
    );

    const commit: GitManagerCommitEntry = {
      sha: "a".repeat(40),
      shortSha: "aaaaaaa",
      parents: ["b".repeat(40)],
      decorations: ["visual-base"],
      subject: "Visual qualification baseline",
      body: "",
      authorName: "Owned Fixture",
      authorEmail: "fixture@example.test",
      authoredAtMs: 1,
      committerName: "Owned Fixture",
      committerEmail: "fixture@example.test",
      committedAtMs: 1,
      changedFiles: [path],
    };
    state.diff = {
      _tag: "image",
      generation: 2,
      source: { _tag: "commit", sha: commit.sha, path },
      byteLength: 358,
      longestLineLength: 0,
      before: { mimeType: "image/png", contentBase64: swatches[1]! },
      after: { mimeType: "image/png", contentBase64: swatches[0]! },
    };
    await act(async () =>
      root.render(
        <GitManagerCommitDetail
          environmentId={environmentId}
          cwd="/owned"
          commit={commit}
          selectedFilePath={path}
          onSelectFile={() => {}}
        />,
      ),
    );
    expect(state.getDiff).toHaveBeenLastCalledWith({
      environmentId,
      input: { cwd: "/owned", source: { _tag: "commit", sha: commit.sha, path } },
    });
    expect(
      container.querySelector(
        '[aria-label="Changed files"] button[data-changed-file-path="visual-swatch.png"][aria-selected="true"]',
      ),
    ).not.toBeNull();
    const pane = container.querySelector<HTMLElement>('section[aria-label="Image diff"]')!;
    const images = Array.from(pane.querySelectorAll("img"));
    expect(images).toHaveLength(2);
    expect(read()).toBe(false);
    // Happy DOM does not decode PNGs; these explicitly inert load signals exercise the real reader.
    vi.spyOn(pane, "getBoundingClientRect").mockReturnValue({ height: 192 } as DOMRect);
    for (const image of images)
      Object.defineProperties(image, {
        complete: { value: true },
        naturalWidth: { value: 64 },
        naturalHeight: { value: 64 },
      });
    expect(read()).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    chrome.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
