// @vitest-environment happy-dom

import { EnvironmentId, ThreadId } from "@bibcode/contracts";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const assetState = vi.hoisted(() => ({
  result: { _tag: "Success", value: { relativeUrl: "/api/assets/tok/file.png" } } as
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
vi.mock("~/state/query", () => ({
  formatEnvironmentQueryError: (cause: string) => cause,
}));

import { FileMediaPreview } from "./FileMediaPreview";

const environmentId = EnvironmentId.make("environment-1");
const threadId = ThreadId.make("thread-1");

interface FakeResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: Headers;
  readonly blob: () => Promise<Blob>;
}

function okResponse(options: { contentLength?: number } = {}): FakeResponse {
  return {
    ok: true,
    status: 200,
    headers: new Headers(
      options.contentLength === undefined
        ? {}
        : { "content-length": String(options.contentLength) },
    ),
    blob: async () => new Blob(["bytes"]),
  };
}

const tooLargeResponse: FakeResponse = {
  ok: false,
  status: 413,
  headers: new Headers(),
  blob: async () => new Blob(),
};

describe("FileMediaPreview", () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<FakeResponse>>();
  const createObjectUrl = vi.fn<(blob: Blob) => string>();
  const revokeObjectUrl = vi.fn<(url: string) => void>();

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    assetState.result = { _tag: "Success", value: { relativeUrl: "/api/assets/tok/file.png" } };
    assetState.requests.length = 0;
    let blobCount = 0;
    fetchMock.mockReset().mockImplementation(async () => okResponse());
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
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  });

  async function render(overrides: Partial<ComponentProps<typeof FileMediaPreview>> = {}) {
    await act(async () => {
      root.render(
        <FileMediaPreview
          kind="image"
          environmentId={environmentId}
          threadId={threadId}
          absolutePath="/work/demo/shot.png"
          httpBaseUrl="http://127.0.0.1:3773"
          fileName="shot.png"
          canOpenElsewhere
          {...overrides}
        />,
      );
    });
  }

  const noticeText = () => container.querySelector("[data-file-media-notice]")?.textContent ?? "";

  it("fetches the asset for the file under the thread and shows the image from a blob URL", async () => {
    await render();

    expect(assetState.requests).toEqual([
      {
        environmentId,
        input: { resource: { _tag: "workspace-file", threadId, path: "/work/demo/shot.png" } },
      },
    ]);
    // The page policy allows blob: for media, never the environment's origin; read fresh, no cookies.
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3773/api/assets/tok/file.png",
      expect.objectContaining({ cache: "no-cache", credentials: "omit" }),
    );
    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("blob:fixture-1");
    expect(image?.getAttribute("alt")).toBe("shot.png");
    expect(noticeText()).toBe("");
  });

  it("revokes the blob URL when the preview goes away", async () => {
    await render();
    expect(revokeObjectUrl).not.toHaveBeenCalled();
    await act(async () => root.unmount());
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:fixture-1");
    root = createRoot(container);
  });

  it("reads the file again when the preview is shown again after a save", async () => {
    await render({ kind: "svg", fileName: "logo.svg" });
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:fixture-1");

    // The panel swaps the preview for the editor, the user saves, and the image comes back.
    await act(async () => root.render(<div />));
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:fixture-1");
    await render({ kind: "svg", fileName: "logo.svg" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, init]) => init?.cache === "no-cache")).toBe(true);
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:fixture-2");
  });

  it("explains an image the route refused as too large, with the next step", async () => {
    fetchMock.mockResolvedValue(tooLargeResponse);
    await render();

    expect(container.querySelector("img")).toBeNull();
    expect(createObjectUrl).not.toHaveBeenCalled();
    expect(noticeText()).toContain("too large to preview");
    expect(noticeText()).toContain("10 MiB");
    expect(noticeText()).toContain("Open in");
    expect(noticeText()).not.toMatch(/413|AssetTooLarge/);
  });

  it("refuses a body past the cap even when the route did not say so", async () => {
    fetchMock.mockResolvedValue(okResponse({ contentLength: 10 * 1024 * 1024 + 1 }));
    await render();

    expect(noticeText()).toContain("too large to preview");
    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it("says a file it could not decode is unreadable, and points elsewhere off the local machine", async () => {
    await render({ canOpenElsewhere: false });

    await act(async () => {
      container.querySelector("img")!.dispatchEvent(new Event("error"));
    });

    expect(noticeText()).toContain("couldn't display this file");
    expect(noticeText()).toContain("machine this environment runs on");
  });

  it("reports a failed fetch as unreadable", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await render();

    expect(noticeText()).toContain("couldn't display this file");
  });

  it("shows an SVG as an image, never as markup, and offers its source", async () => {
    const onViewSource = vi.fn();
    await render({ kind: "svg", fileName: "logo.svg", onViewSource });

    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:fixture-1");
    expect(container.querySelector("object, embed, iframe, script")).toBeNull();
    const viewSource = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "View source",
    );
    expect(viewSource).toBeDefined();
    viewSource!.click();
    expect(onViewSource).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("Actual size");
  });

  it("keeps View source on a malformed or empty SVG, so it can be fixed", async () => {
    const onViewSource = vi.fn();
    await render({ kind: "svg", fileName: "broken.svg", onViewSource });
    await act(async () => {
      container.querySelector("img")!.dispatchEvent(new Event("error"));
    });

    expect(noticeText()).toContain("couldn't display this file");
    const viewSource = container.querySelector<HTMLButtonElement>(
      "[data-file-media-notice] button",
    );
    expect(viewSource?.textContent).toBe("View source");
    viewSource!.click();
    expect(onViewSource).toHaveBeenCalledOnce();
  });

  it("keeps View source when an SVG's preview cannot be prepared at all", async () => {
    assetState.result = { _tag: "Failure", cause: "Workspace asset was not found." };
    await render({ kind: "svg", fileName: "gone.svg", onViewSource: vi.fn() });

    expect(noticeText()).toContain("Workspace asset was not found.");
    expect(container.querySelector("[data-file-media-notice] button")?.textContent).toBe(
      "View source",
    );
  });

  it("toggles a raster image between fitting the panel and actual size", async () => {
    await render();
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show image at actual size"]',
    );
    expect(toggle).not.toBeNull();
    expect(container.querySelector("img")?.className).toContain("max-w-full");

    await act(async () => toggle!.click());

    expect(container.querySelector("img")?.className).toContain("max-w-none");
    expect(container.querySelector('button[aria-label="Fit image to panel"]')).not.toBeNull();
  });

  it("embeds a PDF from a blob URL in the browser's viewer", async () => {
    assetState.result = { _tag: "Success", value: { relativeUrl: "/api/assets/tok/doc.pdf" } };
    await render({ kind: "pdf", fileName: "doc.pdf" });

    const viewer = container.querySelector("embed");
    expect(viewer?.getAttribute("src")).toBe("blob:fixture-1");
    expect(viewer?.getAttribute("type")).toBe("application/pdf");
    expect(viewer?.getAttribute("title")).toBe("doc.pdf (PDF)");
  });

  it("never embeds a PDF the route refused as too large", async () => {
    assetState.result = { _tag: "Success", value: { relativeUrl: "/api/assets/tok/doc.pdf" } };
    fetchMock.mockResolvedValue(tooLargeResponse);
    await render({ kind: "pdf", fileName: "doc.pdf" });

    expect(container.querySelector("embed")).toBeNull();
    expect(noticeText()).toContain("too large to preview");
  });

  it("plays audio with the native controls from a blob URL", async () => {
    assetState.result = { _tag: "Success", value: { relativeUrl: "/api/assets/tok/song.mp3" } };
    await render({ kind: "audio", fileName: "song.mp3" });

    const audio = container.querySelector("audio");
    expect(audio?.hasAttribute("controls")).toBe(true);
    expect(audio?.getAttribute("src")).toBe("blob:fixture-1");
    expect(audio?.getAttribute("aria-label")).toBe("song.mp3");
  });

  it("reports an environment that refused the asset instead of spinning", async () => {
    assetState.result = {
      _tag: "Failure",
      cause: "Only browser documents and images can be previewed.",
    };
    await render();

    expect(container.querySelector("img")).toBeNull();
    expect(noticeText()).toContain("Only browser documents and images can be previewed.");
  });

  it("waits while the URL is being issued and while the environment is not connected", async () => {
    assetState.result = { _tag: "Initial" };
    await render();
    expect(container.querySelector("img")).toBeNull();
    expect(noticeText()).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();

    await render({ httpBaseUrl: null });
    expect(noticeText()).toContain("still connecting");
  });
});
