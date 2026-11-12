import { describe, expect, it } from "vite-plus/test";

import { resolveRichMarkdownImageSource } from "./richMarkdownImageSource";

const resolve = (src: string, markdownPath = "docs/guide/readme.md") =>
  resolveRichMarkdownImageSource(markdownPath, src);

describe("resolveRichMarkdownImageSource", () => {
  it("reads a relative path from the Markdown file's folder", () => {
    expect(resolve("images/pic.png")).toEqual({
      kind: "workspace",
      path: "docs/guide/images/pic.png",
    });
    expect(resolve("./pic.png")).toEqual({ kind: "workspace", path: "docs/guide/pic.png" });
    expect(resolve("pic.png", "readme.md")).toEqual({ kind: "workspace", path: "pic.png" });
  });

  it("decodes each segment, and drops a query or fragment", () => {
    expect(resolve("my%20image%231.png")).toEqual({
      kind: "workspace",
      path: "docs/guide/my image#1.png",
    });
    expect(resolve("fig%20%281%29.png?v=2#top")).toEqual({
      kind: "workspace",
      path: "docs/guide/fig (1).png",
    });
  });

  it("allows `..` that stays inside the workspace", () => {
    expect(resolve("../shared.png")).toEqual({ kind: "workspace", path: "docs/shared.png" });
    expect(resolve("../../top.png")).toEqual({ kind: "workspace", path: "top.png" });
  });

  it("refuses a path that leaves the workspace or hides a separator", () => {
    for (const src of [
      "../../../outside.png",
      "%2e%2e/%2e%2e/%2e%2e/outside.png",
      "..%2F..%2F..%2Foutside.png",
      "images%5C..%5Cpic.png",
      "/etc/pic.png",
      "//host.example.test/pic.png",
      "file:///pic.png",
      // Without `//` the page would read these as paths on its own address.
      "http:/pic.png",
      "https:pic.png",
      "C:/pic.png",
      "images\\pic.png",
      "bad%E0%A4%A.png",
      "../../..",
    ]) {
      expect(resolve(src), src).toEqual({ kind: "refused" });
    }
  });

  it("keeps a home-looking path inside the workspace", () => {
    expect(resolve("~/pic.png", "readme.md")).toEqual({ kind: "workspace", path: "~/pic.png" });
  });

  it("leaves web, data and blob URLs alone", () => {
    for (const src of [
      "https://images.example.test/pic.png",
      "http://images.example.test/pic.png",
      "data:image/png;base64,AAAA",
      "blob:https://app.example.test/1234",
    ]) {
      expect(resolve(src), src).toEqual({ kind: "url", url: src });
    }
  });
});
