import { afterEach, describe, expect, it } from "vite-plus/test";

import { readPreviewAnnotationTheme } from "./annotationTheme";

const originalDocument = globalThis.document;
const originalGetComputedStyle = globalThis.getComputedStyle;

function installComputedStyle(values: ReadonlyMap<string, string>): void {
  globalThis.document = {
    documentElement: { classList: { contains: () => false } },
  } as unknown as Document;
  globalThis.getComputedStyle = (() => ({
    fontFamily: "system-ui",
    getPropertyValue: (name: string) => values.get(name) ?? "",
  })) as unknown as typeof getComputedStyle;
}

afterEach(() => {
  if (originalDocument === undefined) {
    delete (globalThis as { document?: Document }).document;
  } else {
    globalThis.document = originalDocument;
  }
  if (originalGetComputedStyle === undefined) {
    delete (globalThis as { getComputedStyle?: typeof getComputedStyle }).getComputedStyle;
  } else {
    globalThis.getComputedStyle = originalGetComputedStyle;
  }
});

describe("readPreviewAnnotationTheme", () => {
  it("falls back to the approved interaction colors", () => {
    installComputedStyle(new Map());

    expect(readPreviewAnnotationTheme()).toMatchObject({
      primary: "#d8610e",
      primaryForeground: "white",
      ring: "#d8610e",
    });
  });

  it("prefers live semantic tokens over fallbacks", () => {
    installComputedStyle(
      new Map([
        ["--primary", "rgb(1 2 3)"],
        ["--ring", "rgb(4 5 6)"],
      ]),
    );

    expect(readPreviewAnnotationTheme()).toMatchObject({
      primary: "rgb(1 2 3)",
      ring: "rgb(4 5 6)",
    });
  });
});
