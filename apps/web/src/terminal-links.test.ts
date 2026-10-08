import { describe, expect, it } from "vite-plus/test";

import {
  collectWrappedTerminalLinkLine,
  extractTerminalLinks,
  fileUrlToPath,
  isNetworkPath,
  isTerminalLinkActivation,
  resolvePathLinkTarget,
  terminalLinkLabelShowsUri,
  splitPathAndPosition,
  resolveWrappedTerminalLinkRange,
  terminalPreviewFilePath,
  wrappedTerminalLinkRangeIntersectsBufferLine,
  type TerminalBufferLineLike,
} from "./terminal-links";

function createBufferLine(text: string, isWrapped = false): TerminalBufferLineLike {
  return {
    isWrapped,
    translateToString: (trimRight = false) => (trimRight ? text.replace(/\s+$/u, "") : text),
  };
}

describe("extractTerminalLinks", () => {
  it("finds http urls and path tokens", () => {
    const line = "failed at https://example.com/docs and src/components/ThreadTerminalPanel.tsx:42";
    expect(extractTerminalLinks(line)).toEqual([
      {
        kind: "url",
        text: "https://example.com/docs",
        start: 10,
        end: 34,
      },
      {
        kind: "path",
        text: "src/components/ThreadTerminalPanel.tsx:42",
        start: 39,
        end: 80,
      },
    ]);
  });

  it("trims trailing punctuation from links", () => {
    const line = "(https://example.com/docs), ./src/main.ts:12.";
    expect(extractTerminalLinks(line)).toEqual([
      {
        kind: "url",
        text: "https://example.com/docs",
        start: 1,
        end: 25,
      },
      {
        kind: "path",
        text: "./src/main.ts:12",
        start: 28,
        end: 44,
      },
    ]);
  });

  it("finds Windows absolute paths with forward slashes", () => {
    const line = "see C:/Users/someone/project/src/file.ts:42 for details";
    const path = "C:/Users/someone/project/src/file.ts:42";
    const start = line.indexOf(path);
    expect(extractTerminalLinks(line)).toEqual([
      {
        kind: "path",
        text: path,
        start,
        end: start + path.length,
      },
    ]);
  });

  it("trims trailing punctuation from Windows forward-slash paths", () => {
    const line = "(C:/tmp/x.ts).";
    expect(extractTerminalLinks(line)).toEqual([
      {
        kind: "path",
        text: "C:/tmp/x.ts",
        start: 1,
        end: 12,
      },
    ]);
  });

  it("trims only unbalanced closing delimiters and keeps balanced ones", () => {
    expect(extractTerminalLinks("(https://example.test/a(b)) [./a[b].ts] {./a{b}.ts}")).toEqual([
      expect.objectContaining({ kind: "url", text: "https://example.test/a(b)" }),
      expect.objectContaining({ kind: "path", text: "./a[b].ts" }),
      expect.objectContaining({ kind: "path", text: "./a{b}.ts" }),
    ]);
    expect(extractTerminalLinks("...,,,!!!")).toEqual([]);
  });
});

describe("collectWrappedTerminalLinkLine", () => {
  it("reconstructs a wrapped line from any physical row", () => {
    const firstSegment = "see https://example.com/a";
    const secondSegment = "/bc?x=1";
    const lines = [
      createBufferLine("prompt> "),
      createBufferLine(firstSegment),
      createBufferLine(secondSegment, true),
      createBufferLine("done"),
    ];

    const fromFirstRow = collectWrappedTerminalLinkLine(2, (index) => lines[index]);
    const fromWrappedRow = collectWrappedTerminalLinkLine(3, (index) => lines[index]);

    expect(fromFirstRow).toEqual({
      text: `${firstSegment}${secondSegment}`,
      segments: [
        {
          bufferLineNumber: 2,
          text: firstSegment,
          startIndex: 0,
          endIndex: firstSegment.length,
        },
        {
          bufferLineNumber: 3,
          text: secondSegment,
          startIndex: firstSegment.length,
          endIndex: firstSegment.length + secondSegment.length,
        },
      ],
    });
    expect(fromWrappedRow).toEqual(fromFirstRow);
  });

  it("preserves trailing spaces on continued segments for downstream offsets", () => {
    const firstSegment = "prefix   ";
    const secondSegment = "https://example.com/path";
    const lines = [createBufferLine(firstSegment), createBufferLine(secondSegment, true)];

    const wrappedLine = collectWrappedTerminalLinkLine(2, (index) => lines[index]);

    expect(wrappedLine?.text).toBe(`${firstSegment}${secondSegment}`);
    expect(extractTerminalLinks(wrappedLine?.text ?? "")).toEqual([
      {
        kind: "url",
        text: secondSegment,
        start: firstSegment.length,
        end: firstSegment.length + secondSegment.length,
      },
    ]);
  });

  it("returns null for missing anchors or broken wrapped predecessors", () => {
    expect(collectWrappedTerminalLinkLine(1, () => undefined)).toBeNull();
    const lines = [undefined, createBufferLine("continued", true)];
    expect(collectWrappedTerminalLinkLine(2, (index) => lines[index])).toBeNull();
  });

  it("stops at the first missing continuation line", () => {
    const lines = [createBufferLine("first"), undefined, createBufferLine("later", true)];
    expect(collectWrappedTerminalLinkLine(1, (index) => lines[index])).toEqual({
      text: "first",
      segments: [{ bufferLineNumber: 1, text: "first", startIndex: 0, endIndex: 5 }],
    });
  });

  it("bounds the window on enormous wrapped logical lines and keeps the hovered row inside", () => {
    // ConPTY can mark an entire alt-screen TUI frame as one wrapped logical
    // line; an unbounded hover-time walk previously assembled the whole
    // scrollback per mouse event and exhausted the renderer heap.
    const totalRows = 10_000;
    const hoveredBufferLineNumber = 5_000;
    const getLine = (index: number) => {
      if (index < 0 || index >= totalRows) return undefined;
      const text =
        index === hoveredBufferLineNumber - 1 ? " https://example.com/hit " : `row ${index} `;
      return createBufferLine(text, index > 0);
    };

    const wrappedLine = collectWrappedTerminalLinkLine(hoveredBufferLineNumber, getLine);

    expect(wrappedLine).not.toBeNull();
    expect(wrappedLine!.segments.length).toBeLessThanOrEqual(100);
    const rowNumbers = wrappedLine!.segments.map((segment) => segment.bufferLineNumber);
    expect(rowNumbers).toContain(hoveredBufferLineNumber);
    expect(Math.min(...rowNumbers)).toBeGreaterThanOrEqual(hoveredBufferLineNumber - 50);
    expect(wrappedLine!.text).toContain("https://example.com/hit");
  });

  it("trims very long unbalanced delimiter tails without quadratic blowup", () => {
    const line = `see https://example.com/a${")".repeat(50_000)} end`;
    expect(extractTerminalLinks(line)).toEqual([
      {
        kind: "url",
        text: "https://example.com/a",
        start: 4,
        end: 25,
      },
    ]);
  });
});

describe("resolveWrappedTerminalLinkRange", () => {
  it("maps wrapped URL matches back to the correct buffer rows", () => {
    const prefix = "see ";
    const firstSegment = `${prefix}https://example.com/a`;
    const secondSegment = "/bc?x=1";
    const lines = [
      createBufferLine("prompt> "),
      createBufferLine(firstSegment),
      createBufferLine(secondSegment, true),
    ];
    const wrappedLine = collectWrappedTerminalLinkLine(2, (index) => lines[index]);

    expect(wrappedLine).not.toBeNull();
    if (!wrappedLine) {
      throw new Error("Expected wrapped terminal line to be present.");
    }

    const [match] = extractTerminalLinks(wrappedLine.text);
    expect(match).toEqual({
      kind: "url",
      text: "https://example.com/a/bc?x=1",
      start: prefix.length,
      end: firstSegment.length + secondSegment.length,
    });
    if (!match) {
      throw new Error("Expected wrapped URL match to be present.");
    }

    const range = resolveWrappedTerminalLinkRange(wrappedLine, match);

    expect(range).toEqual({
      start: { x: prefix.length + 1, y: 2 },
      end: { x: secondSegment.length, y: 3 },
    });
    expect(wrappedTerminalLinkRangeIntersectsBufferLine(range, 2)).toBe(true);
    expect(wrappedTerminalLinkRangeIntersectsBufferLine(range, 3)).toBe(true);
    expect(wrappedTerminalLinkRangeIntersectsBufferLine(range, 4)).toBe(false);
  });

  it("clamps character positions beyond the final or an empty segment list", () => {
    expect(
      resolveWrappedTerminalLinkRange(
        {
          text: "abc",
          segments: [{ bufferLineNumber: 7, text: "abc", startIndex: 0, endIndex: 3 }],
        },
        { start: 9, end: 11 },
      ),
    ).toEqual({ start: { x: 3, y: 7 }, end: { x: 3, y: 7 } });
    expect(
      resolveWrappedTerminalLinkRange({ text: "", segments: [] }, { start: 0, end: 1 }),
    ).toEqual({ start: { x: 1, y: 1 }, end: { x: 1, y: 1 } });
  });
});

describe("resolvePathLinkTarget", () => {
  it("splits absent, line-only, and line-column suffixes", () => {
    expect(splitPathAndPosition("src/a.ts")).toEqual({
      path: "src/a.ts",
      line: undefined,
      column: undefined,
    });
    expect(splitPathAndPosition("src/a.ts:4")).toEqual({
      path: "src/a.ts",
      line: "4",
      column: undefined,
    });
    expect(splitPathAndPosition("src/a.ts:4:2")).toEqual({
      path: "src/a.ts",
      line: "4",
      column: "2",
    });
  });

  it("resolves relative paths against cwd", () => {
    expect(
      resolvePathLinkTarget("src/components/ThreadTerminalPanel.tsx:42:7", "/Users/julius/project"),
    ).toBe("/Users/julius/project/src/components/ThreadTerminalPanel.tsx:42:7");
  });

  it("keeps absolute paths unchanged", () => {
    expect(
      resolvePathLinkTarget("/Users/julius/project/src/main.ts:12", "/Users/julius/project"),
    ).toBe("/Users/julius/project/src/main.ts:12");
  });

  it("keeps Windows absolute paths with forward slashes unchanged", () => {
    expect(
      resolvePathLinkTarget("C:/Users/julius/project/src/main.ts:12", "C:\\Users\\julius\\project"),
    ).toBe("C:/Users/julius/project/src/main.ts:12");
  });

  it("expands home paths for macOS, Linux, and Windows cwd styles", () => {
    expect(resolvePathLinkTarget("~/src/a.ts", "/Users/alice/project")).toBe(
      "/Users/alice/src/a.ts",
    );
    expect(resolvePathLinkTarget("~/src/a.ts:2", "/home/alice/project")).toBe(
      "/home/alice/src/a.ts:2",
    );
    expect(resolvePathLinkTarget("~/src/a.ts", "C:\\Users\\alice\\project")).toBe(
      "C:\\Users\\alice\\src\\a.ts",
    );
    expect(resolvePathLinkTarget("~/src/a.ts", "/opt/project")).toBe("~/src/a.ts");
  });

  it("joins relative Windows paths and trims existing cwd separators", () => {
    expect(resolvePathLinkTarget("src/a.ts", "C:\\repo\\")).toBe("C:\\repo\\src\\a.ts");
    expect(resolvePathLinkTarget("/absolute/a.ts", "/repo///")).toBe("/absolute/a.ts");
  });
});

describe("isTerminalLinkActivation", () => {
  it("requires cmd on macOS", () => {
    expect(
      isTerminalLinkActivation(
        {
          metaKey: true,
          ctrlKey: false,
        },
        "MacIntel",
      ),
    ).toBe(true);
    expect(
      isTerminalLinkActivation(
        {
          metaKey: false,
          ctrlKey: true,
        },
        "MacIntel",
      ),
    ).toBe(false);
  });

  it("requires ctrl on non-macOS", () => {
    expect(
      isTerminalLinkActivation(
        {
          metaKey: false,
          ctrlKey: true,
        },
        "Win32",
      ),
    ).toBe(true);
    expect(
      isTerminalLinkActivation(
        {
          metaKey: true,
          ctrlKey: false,
        },
        "Linux",
      ),
    ).toBe(false);
  });

  it("rejects unknown platforms and conflicting modifier keys", () => {
    expect(isTerminalLinkActivation({ metaKey: true, ctrlKey: false }, "")).toBe(false);
    expect(isTerminalLinkActivation({ metaKey: true, ctrlKey: true }, "MacIntel")).toBe(false);
    expect(isTerminalLinkActivation({ metaKey: true, ctrlKey: true }, "Linux")).toBe(false);
  });
});

describe("file links", () => {
  it("extracts bare preview filenames", () => {
    expect(extractTerminalLinks("open index.html now").map((m) => [m.kind, m.text])).toEqual([
      ["path", "index.html"],
    ]);
  });
  it("links only whole filename tokens, never a prefix or suffix of one", () => {
    const line =
      "report.html.bak report.pdf.sig index.html-old report+2026.pdf réport.html report.htmlé (index.html).";
    expect(extractTerminalLinks(line).map((m) => [m.text, m.start])).toEqual([
      ["index.html", line.indexOf("(index.html") + 1],
    ]);
  });
  it("links filenames followed by a colon", () => {
    expect(extractTerminalLinks("index.html:12:3: error").map((m) => m.text)).toEqual([
      "index.html:12:3",
    ]);
    expect(extractTerminalLinks("Wrote index.html: ok").map((m) => m.text)).toEqual(["index.html"]);
  });
  it("extracts file URLs whole", () => {
    expect(extractTerminalLinks("see file:///tmp/report%20one.PDF").map((m) => m.text)).toEqual([
      "file:///tmp/report%20one.PDF",
    ]);
  });
  it("converts POSIX and Windows-drive file URLs", () => {
    expect(fileUrlToPath("file:///tmp/report%20one.PDF")).toBe("/tmp/report one.PDF");
    expect(fileUrlToPath("file:///C:/repo/report.pdf")).toBe("C:\\repo\\report.pdf");
    expect(fileUrlToPath("file://localhost/tmp/a.html")).toBe("/tmp/a.html");
    expect(fileUrlToPath("/not/a/url")).toBeNull();
    expect(fileUrlToPath("file:///tmp/%E0.html")).toBeNull();
  });
  it("refuses file URLs that name a network host", () => {
    expect(fileUrlToPath("file://server/share/r.pdf")).toBeNull();
  });
  it("classifies html path with line and column", () => {
    expect(terminalPreviewFilePath("dist/index.html:12:3", "/repo")).toBe("/repo/dist/index.html");
  });
  it("classifies a bare preview filename against the cwd", () => {
    expect(terminalPreviewFilePath("index.html", "/repo")).toBe("/repo/index.html");
  });
  it("accepts file URLs and pdf, case-insensitively", () => {
    expect(terminalPreviewFilePath("file:///tmp/report.PDF", "/repo")).toBe("/tmp/report.PDF");
  });
  it("ignores other files", () => {
    expect(terminalPreviewFilePath("src/main.ts:4", "/repo")).toBeNull();
  });
  it("rejects file URLs it cannot convert instead of resolving them as relative paths", () => {
    expect(terminalPreviewFilePath("file://server/share/r.html", "/repo")).toBeNull();
    expect(terminalPreviewFilePath("file:///tmp/%E0.html", "/repo")).toBeNull();
  });
});

describe("OSC 8 link text", () => {
  // A fake xterm row addressed by cell column: a wide character fills two cells, the second empty.
  const row = (cells: readonly string[], isWrapped = false) => ({
    isWrapped,
    translateToString: (trimRight = false, start = 0, end = cells.length) => {
      const text = cells.slice(start, end).join("");
      return trimRight ? text.trimEnd() : text;
    },
  });
  const ascii = (text: string, isWrapped = false) => row([...text], isWrapped);
  const wide = (text: string) =>
    row([..."界".repeat(10)].flatMap((c) => [c, ""]).concat([...text]));
  const lines = [
    ascii("see docs.example.com/guide here"),
    ascii("https://evil.test.trusted.example/"),
    wide(" safe.test https://evil.test/"),
    wide(" https://ok.test/ "),
    ascii("abc https://ok.test"),
    ascii("/ more", true),
  ];
  const getLine = (index: number) => lines[index];
  // xterm's 1-based, end-inclusive range of one row's link cells.
  const cells = (y: number, x: number, endX: number) => ({ start: { x, y }, end: { x: endX, y } });

  it("accepts labels that are the URI, with or without scheme and trailing slash", () => {
    const guide = cells(1, 5, 26);
    expect(terminalLinkLabelShowsUri(guide, "https://docs.example.com/guide", getLine)).toBe(true);
    expect(terminalLinkLabelShowsUri(guide, "https://docs.example.com/guide/", getLine)).toBe(true);
    expect(terminalLinkLabelShowsUri(guide, "http://docs.example.com/guide", getLine)).toBe(true);
  });

  it("rejects labels that name something else", () => {
    expect(terminalLinkLabelShowsUri(cells(1, 5, 20), "https://evil.test/", getLine)).toBe(false);
    expect(terminalLinkLabelShowsUri(cells(1, 5, 26), "https://docs.example.com/", getLine)).toBe(
      false,
    );
    expect(terminalLinkLabelShowsUri(cells(9, 1, 3), "https://docs.example.com/", getLine)).toBe(
      false,
    );
  });

  it("rejects a label that is only part of a longer displayed address", () => {
    // `evil.test` is linked inside the displayed `https://evil.test.trusted.example/`.
    expect(terminalLinkLabelShowsUri(cells(2, 9, 17), "https://evil.test/", getLine)).toBe(false);
  });

  it("reads labels by cell column, so wide characters can't shift them", () => {
    // Ten wide characters fill columns 1-20; ` safe.test` follows.
    expect(terminalLinkLabelShowsUri(cells(3, 22, 30), "https://evil.test/", getLine)).toBe(false);
    expect(terminalLinkLabelShowsUri(cells(4, 22, 37), "https://ok.test/", getLine)).toBe(true);
  });

  it("does not trust a label that continues onto the next wrapped row", () => {
    expect(terminalLinkLabelShowsUri(cells(5, 5, 19), "https://ok.test", getLine)).toBe(false);
  });
});

describe("isNetworkPath", () => {
  it("flags UNC and protocol-relative paths", () => {
    expect(isNetworkPath("\\\\server\\share\\a.html")).toBe(true);
    expect(isNetworkPath("//server/share/a.html")).toBe(true);
    expect(isNetworkPath("\\\\?\\UNC\\server\\share\\a.html")).toBe(true);
    // Windows treats mixed leading separators as UNC too (`file:///%5cattacker/...` decodes so).
    expect(isNetworkPath("/\\attacker.example/share/x.txt")).toBe(true);
    expect(isNetworkPath("\\/attacker.example/share/x.txt")).toBe(true);
  });
  it("flags device and verbatim paths, which `..` can turn into UNC targets", () => {
    expect(isNetworkPath("\\\\.\\C:\\..\\UNC\\a\\s\\x.html")).toBe(true);
    expect(isNetworkPath("//./C:/../UNC/a/s/x.html")).toBe(true);
    expect(isNetworkPath("\\\\?\\C:\\x.html")).toBe(true);
  });
  it("keeps ordinary paths", () => {
    expect(isNetworkPath("C:\\repo\\index.html")).toBe(false);
    expect(isNetworkPath("/repo/index.html")).toBe(false);
  });
});
