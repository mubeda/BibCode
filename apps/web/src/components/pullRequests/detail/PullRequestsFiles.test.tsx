// @vitest-environment happy-dom
import { act, useImperativeHandle, type ReactNode, type Ref } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createJSONStorage } from "zustand/middleware";
import { usePullRequestsStore } from "../../../pullRequestsStore";
import { context, detail, file } from "./testFixtures";
const h = vi.hoisted(() => ({
  hash: "",
  navigate: vi.fn(),
  scroll: vi.fn().mockResolvedValue(undefined),
  lists: [] as Record<string, unknown>[],
}));
vi.mock("@tanstack/react-router", () => ({
  useLocation: () => ({ hash: h.hash }),
  useNavigate: () => h.navigate,
}));
vi.mock("../../../hooks/useSettings", () => ({
  useClientSettings: (select: (settings: { diffIgnoreWhitespace: boolean }) => unknown) =>
    select({ diffIgnoreWhitespace: true }),
}));
vi.mock("../../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("../../DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@legendapp/list/react", () => ({
  LegendList: (props: {
    data: readonly unknown[];
    keyExtractor: (item: unknown) => string;
    renderItem: (p: { item: unknown }) => ReactNode;
    ref?: Ref<unknown>;
  }) => {
    h.lists.push(props);
    useImperativeHandle(props.ref, () => ({ scrollToIndex: h.scroll }));
    return (
      <div>
        {props.data.map((item) => (
          <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
        ))}
      </div>
    );
  },
}));
import { PullRequestsFiles } from "./PullRequestsFiles";
let root: Root;
let container: HTMLDivElement;
const persisted = new Map<string, string>();
const storage = {
  getItem: (key: string) => persisted.get(key) ?? null,
  setItem: (key: string, value: string) => {
    persisted.set(key, value);
  },
  removeItem: (key: string) => {
    persisted.delete(key);
  },
};
const projectRef = { environmentId: "env", projectId: "project" } as never;
const files = {
  files: [file, { ...file, path: "docs/read me#é.md", patch: null }],
  diffRefs: { baseSha: "base", startSha: "start", headSha: "head" },
  truncated: false,
};
async function render() {
  await act(async () =>
    root.render(
      <PullRequestsFiles files={files} detail={detail} projectRef={projectRef} context={context} />,
    ),
  );
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  persisted.clear();
  usePullRequestsStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
  usePullRequestsStore.setState({ byProjectKey: {} });
  h.hash = "";
  h.lists = [];
  vi.clearAllMocks();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
describe("PullRequestsFiles", () => {
  it("virtualizes tree and diff lists, scrolls to the selected file and persists Viewed", async () => {
    await render();
    expect(container.textContent).toContain("docs");
    expect(container.textContent).toContain("src");
    expect(h.lists.some((p) => (p.data as unknown[]).length === 4)).toBe(true);
    expect(h.lists.some((p) => (p.data as unknown[]).length === 2)).toBe(true);
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-file-path="docs/read me#é.md"]')!.click(),
    );
    expect(h.scroll).toHaveBeenCalledWith({ index: 1, animated: false, viewPosition: 0 });
    expect(h.navigate).toHaveBeenCalledWith(
      expect.objectContaining({ hash: "file=docs%2Fread%20me%23%C3%A9.md", replace: true }),
    );
    await act(async () =>
      container.querySelector<HTMLInputElement>('input[aria-label="Viewed src/a.ts"]')!.click(),
    );
    expect(usePullRequestsStore.getState().selectViewState(projectRef).viewedFiles[14]).toEqual([
      "src/a.ts",
    ]);
    const saved = persisted.get("bibcode:pull-requests-state:v1")!;
    expect(saved).toContain("src/a.ts");
    await act(async () => root.render(null));
    usePullRequestsStore.setState({ byProjectKey: {} });
    persisted.set("bibcode:pull-requests-state:v1", saved);
    await usePullRequestsStore.persist.rehydrate();
    await render();
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Viewed src/a.ts"]')!.checked,
    ).toBe(true);
    expect(
      container.querySelector<HTMLInputElement>('input[aria-label="Ignore whitespace"]')!.checked,
    ).toBe(true);
  });
  it("selects and scrolls the file encoded in the route hash", async () => {
    h.hash = "file=docs%2Fread%20me%23%C3%A9.md";
    await render();
    expect(h.scroll).toHaveBeenCalledWith({ index: 1, animated: false, viewPosition: 0 });
    expect(
      container.querySelector('[data-file-path="docs/read me#é.md"]')?.getAttribute("aria-current"),
    ).toBe("true");
  });
});
