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

describe("FileMediaPreview", () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock =
    vi.fn<(url: string, init?: RequestInit) => Promise<{ ok: boolean; status: number }>>();

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    assetState.result = { _tag: "Success", value: { relativeUrl: "/api/assets/tok/file.png" } };
    assetState.requests.length = 0;
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
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

  it("asks for an asset URL for the file under the thread and shows the image from it", async () => {
    await render();

    expect(assetState.requests).toEqual([
      {
        environmentId,
        input: {
          resource: { _tag: "workspace-file", threadId, path: "/work/demo/shot.png" },
        },
      },
    ]);
    const image = container.querySelector("img");
    expect(image?.getAttribute("src")).toBe("http://127.0.0.1:3773/api/assets/tok/file.png");
    expect(image?.getAttribute("alt")).toBe("shot.png");
    expect(container.querySelector("[data-file-media-notice]")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("explains an image the route refused as too large, with the next step", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 413 });
    await render();

    await act(async () => {
      container.querySelector("img")!.dispatchEvent(new Event("error"));
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3773/api/assets/tok/file.png",
      expect.objectContaining({ method: "HEAD" }),
    );
    expect(container.querySelector("img")).toBeNull();
    const notice = container.querySelector("[data-file-media-notice]")?.textContent ?? "";
    expect(notice).toContain("too large to preview");
    expect(notice).toContain("10 MiB");
    expect(notice).toContain("Open in");
    expect(notice).not.toMatch(/413|AssetTooLarge/);
  });

  it("says a file it could not decode is unreadable, and points elsewhere off the local machine", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await render({ canOpenElsewhere: false });

    await act(async () => {
      container.querySelector("img")!.dispatchEvent(new Event("error"));
    });

    const notice = container.querySelector("[data-file-media-notice]")?.textContent ?? "";
    expect(notice).toContain("couldn't display this file");
    expect(notice).toContain("machine this environment runs on");
  });

  it("shows an SVG as an image, never as markup, and offers its source", async () => {
    assetState.result = { _tag: "Success", value: { relativeUrl: "/api/assets/tok/logo.svg" } };
    const onViewSource = vi.fn();
    await render({ kind: "svg", fileName: "logo.svg", onViewSource });

    expect(container.querySelector("img")?.getAttribute("src")).toContain("/logo.svg");
    expect(container.querySelector("object, embed, iframe, script")).toBeNull();
    const viewSource = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "View source",
    );
    expect(viewSource).toBeDefined();
    viewSource!.click();
    expect(onViewSource).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("Actual size");
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

  it("embeds a PDF in the browser's viewer once the route accepts it", async () => {
    assetState.result = { _tag: "Success", value: { relativeUrl: "/api/assets/tok/doc.pdf" } };
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await render({ kind: "pdf", fileName: "doc.pdf" });

    const frame = container.querySelector("embed");
    expect(frame?.getAttribute("src")).toBe("http://127.0.0.1:3773/api/assets/tok/doc.pdf");
    expect(frame?.getAttribute("title")).toBe("doc.pdf (PDF)");
  });

  it("never frames a PDF the route refused as too large", async () => {
    assetState.result = { _tag: "Success", value: { relativeUrl: "/api/assets/tok/doc.pdf" } };
    fetchMock.mockResolvedValue({ ok: false, status: 413 });
    await render({ kind: "pdf", fileName: "doc.pdf" });

    expect(container.querySelector("embed")).toBeNull();
    expect(container.querySelector("[data-file-media-notice]")?.textContent).toContain(
      "too large to preview",
    );
  });

  it("plays audio with the native controls", async () => {
    assetState.result = { _tag: "Success", value: { relativeUrl: "/api/assets/tok/song.mp3" } };
    await render({ kind: "audio", fileName: "song.mp3" });

    const audio = container.querySelector("audio");
    expect(audio?.hasAttribute("controls")).toBe(true);
    expect(audio?.getAttribute("src")).toBe("http://127.0.0.1:3773/api/assets/tok/song.mp3");
    expect(audio?.getAttribute("aria-label")).toBe("song.mp3");
  });

  it("reports an environment that refused the asset instead of spinning", async () => {
    assetState.result = {
      _tag: "Failure",
      cause: "Only browser documents and images can be previewed.",
    };
    await render();

    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[data-file-media-notice]")?.textContent).toContain(
      "Only browser documents and images can be previewed.",
    );
  });

  it("waits while the URL is being issued and while the environment is not connected", async () => {
    assetState.result = { _tag: "Initial" };
    await render();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[data-file-media-notice]")).toBeNull();

    await render({ httpBaseUrl: null });
    expect(container.querySelector("[data-file-media-notice]")?.textContent).toContain(
      "still connecting",
    );
  });
});
