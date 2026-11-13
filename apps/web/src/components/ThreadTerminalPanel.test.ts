import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  fitTerminalSafely,
  quoteTerminalPastePath,
  getTerminalSelectionRect,
  normalizeComputedColor,
  resolveTerminalDocumentVisibility,
  resolveTerminalSelectionActionPosition,
  runtimeEnvSignature,
  terminalThemeFromApp,
} from "./ThreadTerminalPanel";
import { resolveTerminalPalette } from "./terminalTheme";
import { writeTerminalBuffer } from "./terminalReplyGuard";
import { BUILTIN_THEMES } from "../themes/builtinThemes";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("terminal panel utilities", () => {
  it("restores terminal buffers only when content exists", () => {
    const terminal = { write: vi.fn() };

    writeTerminalBuffer(terminal as never, "");
    expect(terminal.write).toHaveBeenCalledTimes(1);
    expect(terminal.write).toHaveBeenLastCalledWith("\u001bc", undefined);

    writeTerminalBuffer(terminal as never, "saved output");
    expect(terminal.write).toHaveBeenLastCalledWith("saved output", undefined);
  });

  it("contains fit-addon failures", () => {
    expect(fitTerminalSafely({ fit: vi.fn() } as never)).toBe(true);
    expect(
      fitTerminalSafely({
        fit: vi.fn(() => {
          throw new Error("detached");
        }),
      } as never),
    ).toBe(false);
  });

  it("normalizes runtime environment order and invalid entries", () => {
    expect(runtimeEnvSignature(undefined)).toBe("");
    expect(runtimeEnvSignature({ B: "2", A: "1", "": "ignored", INVALID: 1 } as never)).toBe(
      JSON.stringify([
        ["A", "1"],
        ["B", "2"],
      ]),
    );
  });

  it("keeps production visibility semantics while allowing packaged WebKit automation", () => {
    expect(resolveTerminalDocumentVisibility("visible", false)).toBe(true);
    expect(resolveTerminalDocumentVisibility("hidden", false)).toBe(false);
    expect(resolveTerminalDocumentVisibility("hidden", true)).toBe(true);
  });

  it("uses fallbacks for blank and transparent computed colors", () => {
    for (const value of [
      undefined,
      null,
      "",
      " transparent ",
      "rgba(0, 0, 0, 0)",
      "rgba(0 0 0 / 0)",
    ]) {
      expect(normalizeComputedColor(value, "fallback")).toBe("fallback");
    }
    expect(normalizeComputedColor(" RGB(1, 2, 3) ", "fallback")).toBe(" RGB(1, 2, 3) ");
  });

  it("rejects absent, collapsed, and out-of-panel browser selections", () => {
    class FakeElement {
      parentElement: FakeElement | null = null;
      contains = vi.fn(() => true);
    }
    vi.stubGlobal("Element", FakeElement);
    const mount = new FakeElement() as never;

    vi.stubGlobal("window", { getSelection: () => null });
    expect(getTerminalSelectionRect(mount)).toBeNull();

    vi.stubGlobal("window", {
      getSelection: () => ({ rangeCount: 0, isCollapsed: false }),
    });
    expect(getTerminalSelectionRect(mount)).toBeNull();

    vi.stubGlobal("window", {
      getSelection: () => ({ rangeCount: 1, isCollapsed: true }),
    });
    expect(getTerminalSelectionRect(mount)).toBeNull();

    const outside = new FakeElement();
    (mount as FakeElement).contains.mockReturnValue(false);
    vi.stubGlobal("window", {
      getSelection: () => ({
        rangeCount: 1,
        isCollapsed: false,
        getRangeAt: () => ({ commonAncestorContainer: outside }),
      }),
    });
    expect(getTerminalSelectionRect(mount)).toBeNull();
  });

  it("uses the last visible selection rect and falls back to its bounding rect", () => {
    class FakeElement {
      parentElement: FakeElement | null = null;
      contains = vi.fn(() => true);
    }
    vi.stubGlobal("Element", FakeElement);
    const mount = new FakeElement() as never;
    const parent = new FakeElement();
    const hidden = { width: 0, height: 0 };
    const visibleByHeight = { width: 0, height: 4 };
    const visibleByWidth = { width: 5, height: 0 };
    const bounding = { width: 8, height: 0 };
    const range = {
      commonAncestorContainer: { parentElement: parent },
      getClientRects: vi.fn(() => [hidden, visibleByHeight, visibleByWidth]),
      getBoundingClientRect: vi.fn(() => bounding),
    };
    vi.stubGlobal("window", {
      getSelection: () => ({
        rangeCount: 1,
        isCollapsed: false,
        getRangeAt: () => range,
      }),
    });

    expect(getTerminalSelectionRect(mount)).toBe(visibleByWidth);
    range.getClientRects.mockReturnValue([]);
    expect(getTerminalSelectionRect(mount)).toBe(bounding);
    range.getBoundingClientRect.mockReturnValue({ width: 0, height: 0 });
    expect(getTerminalSelectionRect(mount)).toBeNull();
  });
});

describe("resolveTerminalSelectionActionPosition", () => {
  it("prefers the selection rect over the last pointer position", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: { right: 260, bottom: 140 },
        pointer: { x: 520, y: 200 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 260,
      y: 144,
    });
  });

  it("falls back to the pointer position when no selection rect is available", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 180, y: 130 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 180,
      y: 130,
    });
  });

  it("clamps the pointer fallback into the terminal panel bounds", () => {
    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 720, y: 340 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 600,
      y: 270,
    });

    expect(
      resolveTerminalSelectionActionPosition({
        bounds: { left: 100, top: 50, width: 500, height: 220 },
        selectionRect: null,
        pointer: { x: 40, y: 20 },
        viewport: { width: 1024, height: 768 },
      }),
    ).toEqual({
      x: 100,
      y: 50,
    });
  });
});

describe("quoteTerminalPastePath", () => {
  it.each([
    [
      "/home/me/.bibcode/userdata/terminal-pastes/a.png",
      "linux",
      "/home/me/.bibcode/userdata/terminal-pastes/a.png",
    ],
    [
      "/Volumes/Work Disk/terminal-pastes/a.png",
      "darwin",
      "/Volumes/Work\\ Disk/terminal-pastes/a.png",
    ],
    ["/srv/it's (new)/a.png", "linux", "/srv/it\\'s\\ \\(new\\)/a.png"],
    ["/tmp/work\\tree/a.png", "linux", "/tmp/work\\\\tree/a.png"],
    ["C:\\Users\\me\\terminal-pastes\\a.png", "windows", "C:\\Users\\me\\terminal-pastes\\a.png"],
    [
      "C:\\Users\\Jane Doe\\terminal-pastes\\a.png",
      "windows",
      '"C:\\Users\\Jane Doe\\terminal-pastes\\a.png"',
    ],
  ])("pastes %s on %s as one token", (path, os, expected) => {
    expect(quoteTerminalPastePath(path, os)).toBe(expected);
  });
});

describe("terminal theme from the app (#290, R51)", () => {
  const tokyoNight = BUILTIN_THEMES.find((theme) => theme.id === "tokyo-night")!;
  // A dark document painted with Tokyo Night surfaces.
  function stubDarkDocument() {
    vi.stubGlobal("document", {
      documentElement: { classList: { contains: (name: string) => name === "dark" } },
      querySelector: () => null,
      body: {},
    });
    vi.stubGlobal("getComputedStyle", () => ({
      backgroundColor: "rgb(26, 27, 38)",
      color: "rgb(169, 177, 214)",
    }));
  }

  it("a running session launched under Tokyo Night keeps its palette after the app turns light", () => {
    stubDarkDocument();
    const launched = resolveTerminalPalette("app", tokyoNight);
    const theme = terminalThemeFromApp("light", null, launched, false);
    expect(theme.background).toBe("#1a1b26");
    expect(theme.green).toBe("#9ece6a");
    expect(theme.scrollbarSliderBackground).toBe("rgba(255, 255, 255, 0.1)");
  });

  it("the Dark preference under a custom app theme paints the built-in dark palette, not the app surfaces", () => {
    stubDarkDocument();
    const theme = terminalThemeFromApp(
      "dark",
      null,
      resolveTerminalPalette("dark", tokyoNight),
      false,
    );
    expect(theme.background).toBe("rgb(14, 18, 24)");
    expect(theme.foreground).toBe("rgb(237, 241, 247)");
  });

  it("under built-in Dark the terminal keeps today's app surface colors", () => {
    stubDarkDocument();
    const dark = BUILTIN_THEMES.find((theme) => theme.id === "dark")!;
    const theme = terminalThemeFromApp("dark", null, resolveTerminalPalette("app", dark), true);
    expect(theme.background).toBe("rgb(26, 27, 38)");
    expect(theme.foreground).toBe("rgb(169, 177, 214)");
  });
});
