// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
const h = vi.hoisted(() => ({ open: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("../../../localApi", () => ({ readLocalApi: () => ({ shell: { openExternal: h.open } }) }));
import { PullRequestsMarkdown } from "./PullRequestsMarkdown";

describe("PullRequestsMarkdown", () => {
  it("renders a linked Dependabot badge as one anchor without React errors or remote requests", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetch = vi.fn();
    const Image = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("Image", Image);
    const container = document.createElement("div");
    const root = createRoot(container);
    h.open.mockClear();
    try {
      await act(async () =>
        root.render(
          <PullRequestsMarkdown text="[![Dependabot compatibility score](https://example.com/badge.svg)](https://example.com/compatibility)" />,
        ),
      );
      expect(error).not.toHaveBeenCalled();
      expect(container.querySelectorAll("a")).toHaveLength(1);
      expect(container.querySelector("img")).toBeNull();
      const link = container.querySelector("a")!;
      expect(link.href).toBe("https://example.com/compatibility");
      expect(link.querySelector("span")?.textContent).toBe("image: Dependabot compatibility score");
      expect(fetch).not.toHaveBeenCalled();
      expect(Image).not.toHaveBeenCalled();
      await act(async () => link.click());
      expect(h.open).toHaveBeenCalledExactlyOnceWith("https://example.com/compatibility");
    } finally {
      await act(async () => root.unmount());
      error.mockRestore();
      vi.unstubAllGlobals();
    }
  });
  it("resolves relative host images and links without loading raw HTML images", () => {
    const html = renderToStaticMarkup(
      <PullRequestsMarkdown
        baseUrl="https://gitlab.example/group/repo/"
        text={
          '![upload](uploads/shot.png)\n\n[issue](/group/repo/-/issues/1)\n\n<img alt="raw" src="https://example.com/raw.png" onerror="bad()">'
        }
      />,
    );
    expect(html).toContain('href="https://gitlab.example/group/repo/uploads/shot.png"');
    expect(html).toContain('href="https://gitlab.example/group/repo/-/issues/1"');
    expect(html).toContain("image: raw — open in browser");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror");
  });
  it("renders GFM tables and task lists", () => {
    const html = renderToStaticMarkup(
      <PullRequestsMarkdown
        text={"| A | B |\n| - | - |\n| one | two |\n\n- [x] done\n- [ ] next"}
      />,
    );
    expect(html).toContain("<table>");
    expect(html).toContain("<td>one</td>");
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).toContain('checked=""');
  });
  it("replaces a remote image with a labelled link and never renders an img", () => {
    const html = renderToStaticMarkup(
      <PullRequestsMarkdown text="![shot](https://user-images.githubusercontent.com/x.png)" />,
    );
    expect(html).toContain("image: shot — open in browser");
    expect(html).toContain('href="https://user-images.githubusercontent.com/x.png"');
    expect(html).not.toContain("<img");
  });
  it("strips scripts, raw image HTML and unsafe link schemes", () => {
    const html = renderToStaticMarkup(
      <PullRequestsMarkdown
        text={
          '<script>alert(1)</script>\n\n<img src="https://example.com/x">\n\n[bad](javascript:alert%281%29)'
        }
      />,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("javascript:");
  });
  it("makes no image or fetch requests when host content contains remote images", () => {
    const fetch = vi.fn();
    const Image = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("Image", Image);
    try {
      renderToStaticMarkup(
        <PullRequestsMarkdown text="![remote](https://example.com/private.png)" />,
      );
      expect(fetch).not.toHaveBeenCalled();
      expect(Image).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("opens links through shell.openExternal with noreferrer", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () =>
        root.render(<PullRequestsMarkdown text="[host](https://example.com/pr)" />),
      );
      const link = container.querySelector("a")!;
      expect(link.rel).toBe("noreferrer");
      await act(async () => link.click());
      expect(h.open).toHaveBeenCalledWith("https://example.com/pr");
    } finally {
      await act(async () => root.unmount());
    }
  });
});
