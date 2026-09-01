import { describe, expect, it } from "vite-plus/test";

import {
  buildImageDataUri,
  isSupportedImageDiffPath,
  resolveImageLayerPresentation,
} from "./gitManagerImageDiff.logic";

describe("Git Manager image diff logic", () => {
  it("recognizes exactly the supported image extension set case-insensitively", () => {
    for (const extension of ["png", "jpg", "jpeg", "gif", "ico", "webp", "bmp", "avif"]) {
      expect(isSupportedImageDiffPath(`asset.${extension}`)).toBe(true);
      expect(isSupportedImageDiffPath(`asset.${extension.toUpperCase()}`)).toBe(true);
    }
    for (const path of ["asset.svg", "asset.tiff", "asset", "asset.png.txt"]) {
      expect(isSupportedImageDiffPath(path)).toBe(false);
    }
  });

  it("builds repository-backed data URIs and never invents a missing side", () => {
    expect(buildImageDataUri({ contentBase64: "iVBORw0KGgo=", mimeType: "image/png" })).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
    expect(buildImageDataUri({ contentBase64: null, mimeType: null })).toBeNull();
    expect(
      buildImageDataUri({ contentBase64: "https://example.test/not-bytes", mimeType: "image/png" }),
    ).toBeNull();
  });

  it("derives stable layer styles for swipe onion-skin and difference modes", () => {
    expect(resolveImageLayerPresentation("swipe", 75)).toMatchObject({
      afterClipPath: "inset(0 25% 0 0)",
    });
    expect(resolveImageLayerPresentation("swipe", 125)).toMatchObject({
      afterClipPath: "inset(0 0% 0 0)",
    });
    expect(resolveImageLayerPresentation("onion", 20)).toMatchObject({
      beforeOpacity: 1,
      afterOpacity: 0.2,
    });
    expect(resolveImageLayerPresentation("difference", 50)).toMatchObject({
      afterMixBlendMode: "difference",
    });
    expect(resolveImageLayerPresentation("two-up", 50)).toEqual({
      beforeOpacity: 1,
      afterOpacity: 1,
      afterClipPath: null,
      afterMixBlendMode: null,
    });
  });
});
