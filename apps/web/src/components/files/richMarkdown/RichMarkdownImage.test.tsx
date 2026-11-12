// @vitest-environment happy-dom

import { EnvironmentId, ThreadId } from "@bibcode/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const assetState = vi.hoisted(() => ({
  result: { _tag: "Success", value: { relativeUrl: "/api/assets/tok/pic.png" } } as
    | { _tag: "Success"; value: { relativeUrl: string } }
    | { _tag: "Initial" }
    | { _tag: "Failure"; cause: string },
  requests: [] as unknown[],
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => assetState.result }));
vi.mock("~/state/assets", () => ({
  assetEnvironment: {
    createUrl: (request: unknown) => {
      assetState.requests.push(request);
      return request;
    },
  },
}));
vi.mock("~/state/environments", () => ({
  useEnvironmentHttpBaseUrl: () => "https://server.example.test/",
}));

import { RichMarkdownImage, type RichMarkdownWorkspace } from "./RichMarkdownImage";

const workspace: RichMarkdownWorkspace = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  cwd: "/workspace",
  markdownPath: "docs/readme.md",
};

describe("RichMarkdownImage", () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>();
  const createObjectUrl = vi.fn<(blob: Blob) => string>();
  const revokeObjectUrl = vi.fn<(url: string) => void>();

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    assetState.result = { _tag: "Success", value: { relativeUrl: "/api/assets/tok/pic.png" } };
    assetState.requests.length = 0;
    let blobCount = 0;
    fetchMock.mockReset().mockImplementation(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      blob: async () => new Blob(["png"]),
    }));
    createObjectUrl.mockReset().mockImplementation(() => `blob:fixture-${(blobCount += 1)}`);
    revokeObjectUrl.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal(
      "URL",
      Object.assign(URL, { createObjectURL: createObjectUrl, revokeObjectURL: revokeObjectUrl }),
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render(src: string, alt = "A pixel") {
    await act(async () => {
      root.render(<RichMarkdownImage workspace={workspace} src={src} alt={alt} />);
    });
    await act(async () => {});
  }

  it("loads a relative image from the Markdown file's folder through the workspace", async () => {
    await render("images/pic.png");

    expect(assetState.requests).toEqual([
      {
        environmentId: workspace.environmentId,
        input: {
          resource: {
            _tag: "workspace-file",
            threadId: workspace.threadId,
            path: "/workspace/docs/images/pic.png",
          },
        },
      },
    ]);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://server.example.test/api/assets/tok/pic.png");
    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("blob:fixture-1");
    expect(image?.getAttribute("alt")).toBe("A pixel");

    act(() => root.render(null));
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:fixture-1");
  });

  it("does not ask for an image outside the workspace and shows its text instead", async () => {
    await render("../../outside.png");

    expect(assetState.requests).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector("img")).toBeNull();
    const text = container.querySelector("[data-rich-markdown-image-text='failed']");
    expect(text?.textContent).toBe("A pixel");
    expect(text?.getAttribute("title")).toBe("Only images inside this project are shown.");
  });

  it("shows the file name when an image without text cannot be read", async () => {
    fetchMock.mockImplementation(async () => ({
      ok: false,
      status: 404,
      headers: new Headers(),
      blob: async () => new Blob(),
    }));
    await render("images/missing.png", "");

    expect(container.querySelector("img")).toBeNull();
    const text = container.querySelector("[data-rich-markdown-image-text='failed']");
    expect(text?.textContent).toBe("missing.png");
    expect(text?.getAttribute("title")).toContain("Check that the file exists");
  });

  it("says the file may be missing when the environment refuses its address", async () => {
    assetState.result = { _tag: "Failure", cause: "not found" };
    await render("images/missing.png");

    expect(fetchMock).not.toHaveBeenCalled();
    const text = container.querySelector("[data-rich-markdown-image-text='failed']");
    expect(text?.textContent).toBe("A pixel");
    expect(text?.getAttribute("title")).toContain("Check that the file exists");
  });

  it("keeps the drawn image while its signed address is reissued", async () => {
    await render("images/pic.png");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:fixture-1");

    const seen: (string | null)[] = [];
    const observer = new MutationObserver(() =>
      seen.push(container.querySelector("img")?.getAttribute("src") ?? null),
    );
    observer.observe(container, { subtree: true, childList: true, attributes: true });
    assetState.result = { _tag: "Success", value: { relativeUrl: "/api/assets/tok2/pic.png" } };
    await render("images/pic.png");
    observer.disconnect();

    expect(seen).not.toContain(null);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:fixture-2");
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:fixture-1");
  });

  it("leaves a web or data URL to the page", async () => {
    await render("https://images.example.test/pic.png");

    expect(assetState.requests).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "https://images.example.test/pic.png",
    );
  });
});
