import { describe, expect, it } from "vite-plus/test";
import {
  FLAG_BOLD,
  FLAG_ITALIC,
  FLAG_STRIKE,
  FLAG_UNDERLINE,
  JobLogModel,
  LINE_ERROR,
  LINE_NOTICE,
  LINE_SECTION,
  LINE_WARNING,
  SEARCH_MATCH_CAP,
  gutterNumber,
  lineAtOffset,
  nearestPaletteIndex,
  utf8Length,
  type LogChunkInput,
} from "./jobLog.parse";

const E = "\u001b";

function chunk(text: string, offset = 0, options: Partial<LogChunkInput> = {}): LogChunkInput {
  return {
    text,
    offset,
    nextOffset: offset + utf8Length(text),
    firstLine: offset === 0 ? 0 : null,
    startsAtLine: false,
    ...options,
  };
}

function load(text: string) {
  const model = new JobLogModel();
  model.load(chunk(text));
  return model;
}

/** The shown rows as plain text. */
function shown(model: JobLogModel): string[] {
  const layout = model.layout();
  return [...layout.rows].map((index) => model.plainText(index));
}

function styleOf(model: JobLogModel, index: number, text: string) {
  const spans = model.render([index]).get(index)!;
  const span = spans.find(([value]) => value === text);
  if (!span) throw new Error(`no span ${text} in ${JSON.stringify(spans)}`);
  return model.styleTable[span[1]]!;
}

describe("job log parser", () => {
  it("splits lines, ends CRLF lines and keeps only the text after a carriage return", () => {
    const model = load(`one\r\ntwo\nprogress 10%\rprogress 100%\n${E}[0Kcleared${E}[K line\n`);
    expect(shown(model)).toEqual(["one", "two", "progress 100%", "cleared line"]);
  });

  it("strips GitLab runner timestamps into a column and joins `+` continuations", () => {
    const model = load(
      [
        "2026-10-25T10:00:00.123456Z 00O Running with gitlab-runner",
        "2026-10-25T10:00:01.000000Z 00O+ and the rest of the line",
        "2026-10-25T10:00:02.500000Z 01E error output",
        "",
      ].join("\n"),
    );
    const layout = model.layout();
    expect(shown(model)).toEqual([
      "Running with gitlab-runner and the rest of the line",
      "error output",
    ]);
    expect(layout.hasTimestamps).toBe(true);
    expect(layout.timestamps[0]).toBe(Date.parse("2026-10-25T10:00:00.123Z"));
    expect(layout.timestamps[2]).toBe(Date.parse("2026-10-25T10:00:02.500Z"));
  });

  it("strips GitHub timestamps and reads groups and annotations", () => {
    const model = load(
      [
        "2026-10-25T10:00:00.1234567Z ##[group]Run actions/checkout@v4",
        "2026-10-25T10:00:01.0000000Z with: repository",
        "2026-10-25T10:00:04.0000000Z ##[endgroup]",
        "2026-10-25T10:00:05.0000000Z ##[error]Process completed with exit code 1.",
        "2026-10-25T10:00:05.0000000Z ##[warning]Node 16 is deprecated",
        "2026-10-25T10:00:05.0000000Z ##[notice]Cache restored",
        "",
      ].join("\n"),
    );
    const layout = model.layout();
    expect(shown(model)).toEqual([
      "Run actions/checkout@v4",
      "with: repository",
      "Process completed with exit code 1.",
      "Node 16 is deprecated",
      "Cache restored",
    ]);
    expect(layout.kinds[0]).toBe(LINE_SECTION);
    expect([layout.kinds[3], layout.kinds[4], layout.kinds[5]]).toEqual([
      LINE_ERROR,
      LINE_WARNING,
      LINE_NOTICE,
    ]);
    expect(layout.sections[0]).toMatchObject({ name: "Run actions/checkout@v4" });
    expect(layout.sections[0]!.durationSeconds).toBeCloseTo(3.877, 2);
  });

  it("detects the timestamp format from the first line only", () => {
    const model = load("plain first line\n2026-10-25T10:00:00.123456Z 00O looks stamped\n");
    expect(model.layout().hasTimestamps).toBe(false);
    expect(shown(model)[1]).toBe("2026-10-25T10:00:00.123456Z 00O looks stamped");
  });

  it("parses SGR combinations, resets, 256 colors and 24-bit colors", () => {
    const model = load(
      `${E}[1;31mbold red${E}[0m plain ${E}[3;4;9mfancy${E}[23;24;29m back ${E}[38;5;208morange${E}[39m ${E}[38;2;255;0;0mtrue${E}[0m ${E}[92;44mbright${E}[m\n`,
    );
    expect(shown(model)).toEqual(["bold red plain fancy back orange true bright"]);
    expect(styleOf(model, 0, "bold red")).toEqual({ fg: 1, bg: -1, flags: FLAG_BOLD });
    expect(styleOf(model, 0, " plain ")).toEqual({ fg: -1, bg: -1, flags: 0 });
    expect(styleOf(model, 0, "fancy").flags).toBe(FLAG_ITALIC | FLAG_UNDERLINE | FLAG_STRIKE);
    expect(styleOf(model, 0, " back ").flags).toBe(0);
    expect(styleOf(model, 0, "orange").fg).toBe(208);
    expect(styleOf(model, 0, "true").fg).toBe(nearestPaletteIndex(255, 0, 0));
    expect(styleOf(model, 0, "bright")).toEqual({ fg: 10, bg: 4, flags: 0 });
  });

  it("carries a style across lines so any line renders on its own", () => {
    const model = load(`${E}[32mgreen\nstill green\n${E}[0mplain\n`);
    expect(styleOf(model, 1, "still green").fg).toBe(2);
    expect(styleOf(model, 2, "plain").fg).toBe(-1);
  });

  it("drops escapes it does not draw, including OSC titles", () => {
    const model = load(`${E}]0;title${"\u0007"}${E}[2Jcursor${E}[3Amoves${E}=\n`);
    expect(shown(model)).toEqual(["cursormoves"]);
  });

  it("builds nested GitLab sections with options, headers and durations", () => {
    const model = load(
      [
        `${E}[0Ksection_start:1700000000:build[collapsed=true]\r${E}[0K${E}[36mBuild the app${E}[0m`,
        "compiling",
        `${E}[0Ksection_start:1700000002:deps\r${E}[0KInstall dependencies`,
        "npm ci",
        `${E}[0Ksection_end:1700000005:deps\r${E}[0K`,
        `${E}[0Ksection_end:1700000010:build\r${E}[0K`,
        "after",
        "",
      ].join("\n"),
    );
    const layout = model.layout();
    expect(layout.sections).toEqual([
      { id: 0, name: "build", header: 0, parent: -1, collapsed: true, durationSeconds: 10 },
      { id: 1, name: "deps", header: 2, parent: 0, collapsed: false, durationSeconds: 3 },
    ]);
    // `build` starts collapsed: only its header and the text after it show.
    expect(shown(model)).toEqual(["Build the app", "after"]);
    model.setCollapsed(0, false);
    expect(shown(model)).toEqual([
      "Build the app",
      "compiling",
      "Install dependencies",
      "npm ci",
      "after",
    ]);
    model.setCollapsed(1, true);
    expect(shown(model)).toEqual(["Build the app", "compiling", "Install dependencies", "after"]);
    model.setAllCollapsed(false);
    expect(model.layout().sectionOf[3]).toBe(1);
  });

  it("parses a chunk boundary in the middle of an escape sequence and of a line", () => {
    const whole = `${E}[1;32mpass${E}[0m one\nsecond line\n`;
    const cut = whole.indexOf("32m");
    const model = new JobLogModel();
    model.load(chunk(whole.slice(0, cut)));
    model.load(chunk(whole.slice(cut), utf8Length(whole.slice(0, cut))));
    expect(shown(model)).toEqual(["pass one", "second line"]);
    expect(styleOf(model, 0, "pass")).toEqual({ fg: 2, bg: -1, flags: FLAG_BOLD });
  });

  it("shows an unterminated last line and replaces it when the rest arrives", () => {
    const model = new JobLogModel();
    model.load(chunk("done\nhalf a li"));
    expect(shown(model)).toEqual(["done", "half a li"]);
    model.load(chunk("ne\n", utf8Length("done\nhalf a li")));
    expect(shown(model)).toEqual(["done", "half a line"]);
  });

  it("undoes a provisional section start when its line continues", () => {
    const model = new JobLogModel();
    const head = `${E}[0Ksection_start:1:a\r${E}[0KHead`;
    model.load(chunk(head));
    expect(model.layout().sections).toHaveLength(1);
    model.load(chunk("er\nbody\n", utf8Length(head)));
    const layout = model.layout();
    expect(layout.sections).toHaveLength(1);
    expect(shown(model)).toEqual(["Header", "body"]);
  });

  it("records each line's absolute byte start, counting multi-byte characters", () => {
    const model = new JobLogModel();
    model.load(chunk("é\n日本\n😀x\nend\n", 100, { startsAtLine: true }));
    const { byteStarts } = model.layout();
    expect([...byteStarts]).toEqual([100, 103, 110, 116]);
    expect(lineAtOffset(byteStarts, 111)).toBe(2);
    expect(lineAtOffset(byteStarts, 99)).toBe(-1);
  });

  it("hides a partial first line until earlier text loads, and renumbers on prepend", () => {
    const model = new JobLogModel();
    const head = "line one\nline two\n";
    const tail = "two-and-a-half\nline three\n";
    // A tail window that starts inside "line two…" with no known prefix.
    model.load({
      text: tail,
      offset: utf8Length(head) - 4,
      nextOffset: utf8Length(head) - 4 + utf8Length(tail),
      firstLine: null,
      startsAtLine: false,
    });
    let layout = model.layout();
    expect(shown(model)).toEqual(["line three"]);
    expect(layout.firstLine).toBeNull();
    expect(gutterNumber(layout, layout.rows[0]!)).toBe(1);
    model.load({
      text: head.slice(0, -4),
      offset: 0,
      nextOffset: utf8Length(head) - 4,
      firstLine: 0,
      startsAtLine: true,
    });
    layout = model.layout();
    expect(shown(model)).toEqual(["line one", "line two-and-a-half", "line three"]);
    expect(layout.firstLine).toBe(0);
    expect([...layout.rows].map((row) => gutterNumber(layout, row))).toEqual([1, 2, 3]);
  });

  it("numbers lines absolutely when the server knows the first line", () => {
    const model = new JobLogModel();
    model.load({ text: "a\nb\n", offset: 50, nextOffset: 54, firstLine: 41, startsAtLine: true });
    const layout = model.layout();
    expect([...layout.rows].map((row) => gutterNumber(layout, row))).toEqual([42, 43]);
  });

  it("derives the first line number of earlier text from a known later start", () => {
    const model = new JobLogModel();
    model.load({ text: "c\n", offset: 4, nextOffset: 6, firstLine: 2, startsAtLine: true });
    model.load({ text: "b\n", offset: 2, nextOffset: 4, firstLine: null, startsAtLine: true });
    expect(model.layout().firstLine).toBe(1);
  });

  it("replaces the log when a chunk is not adjacent to the loaded range", () => {
    const model = new JobLogModel();
    model.load(chunk("head\n"));
    expect(model.load(chunk("tail\n", 1_000, { startsAtLine: true }))).toBe("replace");
    expect(shown(model)).toEqual(["tail"]);
  });

  it("searches case-insensitively, reveals a match and caps the results", () => {
    const model = load(
      [
        `section_start:1:s[collapsed=true]\rStep`,
        "Needle inside",
        "section_end:2:s\r",
        "a needle",
        "",
      ].join("\n"),
    );
    const { matches } = model.search("NEEDLE");
    expect([...matches]).toEqual([1, 3]);
    expect(model.layout().rows).not.toContain(1);
    model.reveal(1);
    expect([...model.layout().rows]).toContain(1);

    const many = load(`${"x match\n".repeat(SEARCH_MATCH_CAP + 5)}`);
    const capped = many.search("match");
    expect(capped.capped).toBe(true);
    expect(capped.matches.length).toBe(SEARCH_MATCH_CAP);
  });

  it("parses a 100,000-line, 8 MiB log with sections and colors within its bound", () => {
    const lines: string[] = [];
    let bytes = 0;
    for (let index = 0; bytes < 8 * 1024 * 1024 || lines.length < 100_000; index += 1) {
      const line =
        index % 500 === 0
          ? `${E}[0Ksection_start:${1_700_000_000 + index}:step_${index}\r${E}[0K${E}[36;1mStep ${index}${E}[0m`
          : index % 500 === 499
            ? `${E}[0Ksection_end:${1_700_000_000 + index}:step_${index - 499}\r${E}[0K`
            : `${E}[32m${index}${E}[0m ${"compiling module ".repeat(4)}${E}[2m(${index % 97} ms)${E}[22m`;
      lines.push(line);
      bytes += utf8Length(line) + 1;
    }
    const text = `${lines.join("\n")}\n`;
    const started = performance.now();
    const model = load(text);
    const layout = model.layout();
    const elapsed = performance.now() - started;
    const search = model.search("(13 ms)");
    expect(layout.lineCount).toBeGreaterThanOrEqual(100_000);
    expect(layout.sections.length).toBeGreaterThan(190);
    expect(search.matches.length).toBeGreaterThan(900);
    // Measured at about 160 ms (parse and layout) on an Apple-silicon Mac. CI runners
    // are several times slower; the gate is twice a slow runner's expected time.
    expect(elapsed).toBeLessThan(1_000);
  });
});
