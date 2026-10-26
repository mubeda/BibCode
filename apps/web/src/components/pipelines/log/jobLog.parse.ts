/**
 * The job log parser. It runs in the log worker (`jobLog.worker.ts`), or on the main
 * thread in slices when no worker can start, and turns raw job log text into lines:
 *
 * - lines split on `\n`; a trailing `\r` is a line ending, and otherwise only the text
 *   after the last `\r` is kept, as GitLab does for progress bars;
 * - a timestamp prefix (GitLab's runner or GitHub's) becomes a column, detected from
 *   the first line; GitLab's `+` flag continues the previous line;
 * - SGR escapes become styles; every other escape is dropped. The style at each line
 *   start is recorded, so any line renders on its own;
 * - GitLab `section_start`/`section_end` markers and GitHub `##[group]`/`##[endgroup]`
 *   become collapsible sections; GitHub `##[error|warning|notice]` set a line kind.
 *
 * Text arrives in byte-addressed chunks (the server cuts them at character
 * boundaries, never at line boundaries). The model keeps one contiguous byte range:
 * later text is parsed incrementally, earlier text re-parses the whole range because
 * styles and sections flow forward. Host content is only ever text: spans carry a
 * style id, never markup.
 */

export const FLAG_BOLD = 1;
export const FLAG_DIM = 2;
export const FLAG_ITALIC = 4;
export const FLAG_UNDERLINE = 8;
export const FLAG_CONCEAL = 16;
export const FLAG_STRIKE = 32;
export const FLAG_INVERSE = 64;

/** A palette index 0..255, or -1 for the surface's own color. */
export interface LogStyle {
  readonly fg: number;
  readonly bg: number;
  readonly flags: number;
}

export const LINE_TEXT = 0;
export const LINE_SECTION = 1;
export const LINE_ERROR = 2;
export const LINE_WARNING = 3;
export const LINE_NOTICE = 4;
export type LineKind =
  | typeof LINE_TEXT
  | typeof LINE_SECTION
  | typeof LINE_ERROR
  | typeof LINE_WARNING
  | typeof LINE_NOTICE;

export interface LogSection {
  readonly id: number;
  readonly name: string;
  /** Raw index of the section's header line. */
  readonly header: number;
  readonly parent: number;
  /** Seconds between the section's start and end, when both are known. */
  readonly durationSeconds: number | null;
  readonly collapsed: boolean;
}

/** What the viewer needs to lay out every row; spans come per visible range. */
export interface JobLogLayout {
  readonly generation: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly lineCount: number;
  /** Raw indices of the rows to show, in order. */
  readonly rows: Int32Array;
  /** Absolute byte offset of each raw line's start. */
  readonly byteStarts: Float64Array;
  /** Milliseconds since the epoch, or NaN for a line without a timestamp. */
  readonly timestamps: Float64Array;
  readonly kinds: Uint8Array;
  /** The innermost section each raw line belongs to, or -1. */
  readonly sectionOf: Int32Array;
  readonly sections: readonly LogSection[];
  readonly hasTimestamps: boolean;
  /** Line number of raw line 0, or null when the prefix before the loaded text is unread. */
  readonly firstLine: number | null;
  /** Raw index of the first line that can be shown (1 when the loaded text starts mid-line). */
  readonly firstShown: number;
}

/** One line's spans: `[text, style id]` pairs. */
export type LogSpans = readonly (readonly [string, number])[];

export interface LogChunkInput {
  readonly text: string;
  /** Byte offset of `text[0]`. */
  readonly offset: number;
  /** Byte offset just past `text`. */
  readonly nextOffset: number;
  /** Line index of `text[0]`, when the server knows it. */
  readonly firstLine: number | null;
  /** The text starts at a line start (offset 0, or a line link's offset). */
  readonly startsAtLine: boolean;
}

export const SEARCH_MATCH_CAP = 10_000;

const ESC = "\u001b";
const DEFAULT_STYLE_KEY = "-1|-1|0";

const GITLAB_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z [0-9a-f]{2}[EO][+ ]/;
const GITHUB_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,9}Z /;
const GITLAB_TIMESTAMP_LENGTH = 32;
const SECTION_MARKER =
  // oxlint-disable-next-line no-control-regex -- GitLab's section markers carry escapes.
  /(?:\u001b\[0?K)?section_(start|end):(\d+):([^\s[\u001b]+)(\[[^\]]*\])?\r?(?:\u001b\[0?K)?/g;
const GITHUB_COMMAND = /^##\[(group|endgroup|error|warning|notice)\]/;

type TimestampFormat = "gitlab" | "github" | "none";

/** UTF-8 length of a JavaScript string, as the server counts offsets. */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

function countNewlines(text: string): number {
  let count = 0;
  let index = text.indexOf("\n");
  while (index !== -1) {
    count += 1;
    index = text.indexOf("\n", index + 1);
  }
  return count;
}

function timestampMs(iso: string): number {
  // Date.parse reads milliseconds; the host writes micro- or 100-nanoseconds.
  const dot = iso.indexOf(".");
  return Date.parse(dot === -1 ? iso : `${iso.slice(0, dot + 4)}Z`);
}

const CUBE = [0, 95, 135, 175, 215, 255] as const;

/** The nearest xterm 256-color index for a 24-bit color, so it follows the theme palette. */
export function nearestPaletteIndex(red: number, green: number, blue: number): number {
  const cube = (value: number) => {
    let best = 0;
    for (let index = 1; index < CUBE.length; index += 1)
      if (Math.abs(CUBE[index]! - value) < Math.abs(CUBE[best]! - value)) best = index;
    return best;
  };
  const r = cube(red);
  const g = cube(green);
  const b = cube(blue);
  const cubeDistance = (CUBE[r]! - red) ** 2 + (CUBE[g]! - green) ** 2 + (CUBE[b]! - blue) ** 2;
  const gray = Math.round((red + green + blue) / 3);
  const step = Math.min(23, Math.max(0, Math.round((gray - 8) / 10)));
  const level = 8 + step * 10;
  const grayDistance = (level - red) ** 2 + (level - green) ** 2 + (level - blue) ** 2;
  return grayDistance < cubeDistance ? 232 + step : 16 + r * 36 + g * 6 + b;
}

interface Styles {
  readonly table: LogStyle[];
  readonly ids: Map<string, number>;
}

function internStyle(styles: Styles, fg: number, bg: number, flags: number): number {
  const key = `${fg}|${bg}|${flags}`;
  const known = styles.ids.get(key);
  if (known !== undefined) return known;
  const id = styles.table.length;
  styles.table.push({ fg, bg, flags });
  styles.ids.set(key, id);
  return id;
}

/** Applies one SGR parameter list to a style; returns the new style. */
function applySgr(style: LogStyle, params: readonly number[]): LogStyle {
  let { fg, bg, flags } = style;
  if (params.length === 0) return { fg: -1, bg: -1, flags: 0 };
  for (let index = 0; index < params.length; index += 1) {
    const code = params[index]!;
    if (code === 0) {
      fg = -1;
      bg = -1;
      flags = 0;
    } else if (code === 1) flags |= FLAG_BOLD;
    else if (code === 2) flags |= FLAG_DIM;
    else if (code === 3) flags |= FLAG_ITALIC;
    else if (code === 4) flags |= FLAG_UNDERLINE;
    else if (code === 7) flags |= FLAG_INVERSE;
    else if (code === 8) flags |= FLAG_CONCEAL;
    else if (code === 9) flags |= FLAG_STRIKE;
    else if (code === 22) flags &= ~(FLAG_BOLD | FLAG_DIM);
    else if (code === 23) flags &= ~FLAG_ITALIC;
    else if (code === 24) flags &= ~FLAG_UNDERLINE;
    else if (code === 27) flags &= ~FLAG_INVERSE;
    else if (code === 28) flags &= ~FLAG_CONCEAL;
    else if (code === 29) flags &= ~FLAG_STRIKE;
    else if (code >= 30 && code <= 37) fg = code - 30;
    else if (code === 39) fg = -1;
    else if (code >= 40 && code <= 47) bg = code - 40;
    else if (code === 49) bg = -1;
    else if (code >= 90 && code <= 97) fg = code - 90 + 8;
    else if (code >= 100 && code <= 107) bg = code - 100 + 8;
    else if (code === 38 || code === 48) {
      const mode = params[index + 1];
      let color: number | null = null;
      if (mode === 5 && index + 2 < params.length) {
        color = Math.min(255, Math.max(0, params[index + 2]!));
        index += 2;
      } else if (mode === 2 && index + 4 < params.length) {
        color = nearestPaletteIndex(params[index + 2]!, params[index + 3]!, params[index + 4]!);
        index += 4;
      } else index = params.length;
      if (color !== null) {
        if (code === 38) fg = color;
        else bg = color;
      }
    }
  }
  return { fg, bg, flags };
}

/**
 * Walks a line's escapes from `startStyle`. Returns the text without escapes, the
 * style after the line, and, when `spans` is given, fills it with styled runs.
 */
function tokenize(
  content: string,
  startStyle: number,
  styles: Styles,
  spans: [string, number][] | null,
): { plain: string; endStyle: number } {
  if (content.indexOf(ESC) === -1) {
    if (spans !== null && content.length > 0) spans.push([content, startStyle]);
    return { plain: content, endStyle: startStyle };
  }
  let style = styles.table[startStyle]!;
  let styleId = startStyle;
  let plain = "";
  let run = "";
  let index = 0;
  const flush = () => {
    if (run.length === 0) return;
    if (spans !== null) spans.push([run, styleId]);
    plain += run;
    run = "";
  };
  while (index < content.length) {
    const escape = content.indexOf(ESC, index);
    if (escape === -1) {
      run += content.slice(index);
      break;
    }
    run += content.slice(index, escape);
    const kind = content[escape + 1];
    if (kind === "[") {
      // CSI: parameters, intermediates, one final byte.
      let end = escape + 2;
      while (end < content.length) {
        const code = content.charCodeAt(end);
        if (code >= 0x40 && code <= 0x7e) break;
        end += 1;
      }
      if (end >= content.length) {
        index = content.length;
        break;
      }
      if (content[end] === "m") {
        const raw = content.slice(escape + 2, end);
        const params =
          raw.length === 0
            ? []
            : raw.split(/[;:]/).map((part) => (part === "" ? 0 : Number.parseInt(part, 10) || 0));
        const next = applySgr(style, params);
        const nextId = internStyle(styles, next.fg, next.bg, next.flags);
        if (nextId !== styleId) {
          flush();
          style = next;
          styleId = nextId;
        }
      }
      index = end + 1;
    } else if (kind === "]") {
      // OSC: up to BEL or ST.
      const bell = content.indexOf("\u0007", escape + 2);
      const st = content.indexOf(`${ESC}\\`, escape + 2);
      const stop = bell === -1 ? st : st === -1 ? bell : Math.min(bell, st);
      index = stop === -1 ? content.length : stop === st ? st + 2 : bell + 1;
    } else {
      index = escape + 2;
    }
  }
  flush();
  return { plain, endStyle: styleId };
}

interface MutableSection {
  id: number;
  name: string;
  header: number;
  parent: number;
  startTs: number | null;
  endTs: number | null;
  collapsed: boolean;
}

interface ParserState {
  style: number;
  stack: number[];
  format: TimestampFormat | null;
  /** Byte offset of the next raw line. */
  nextByte: number;
}

/** What a provisional (unterminated) last line changed, so the next text can undo it. */
interface Undo {
  readonly lineCount: number;
  readonly sectionCount: number;
  readonly state: ParserState;
  readonly previous: {
    readonly index: number;
    readonly content: string;
    readonly plain: string;
  } | null;
  readonly closed: { readonly id: number; readonly endTs: number | null }[];
}

/**
 * A job log over one contiguous byte range. `append` parses later text; `prepend`
 * re-parses from the new start. Every query is synchronous: the worker and the
 * main-thread fallback wrap it.
 */
export class JobLogModel {
  private readonly styles: Styles = { table: [{ fg: -1, bg: -1, flags: 0 }], ids: new Map() };
  private chunks: string[] = [];
  private startOffset = 0;
  private endOffset = 0;
  private firstLine: number | null = null;
  private headComplete = true;
  private generation = 0;
  private loaded = false;

  // Per raw line.
  private content: string[] = [];
  private plain: string[] = [];
  private lower: (string | undefined)[] = [];
  private startStyle: number[] = [];
  private byteStart: number[] = [];
  private stamp: number[] = [];
  private kind: number[] = [];
  private section: number[] = [];
  private hidden: boolean[] = [];

  private sections: MutableSection[] = [];
  private state: ParserState = { style: 0, stack: [], format: null, nextByte: 0 };
  private pending = "";
  private undo: Undo | null = null;
  private sawTimestamp = false;

  constructor() {
    this.styles.ids.set(DEFAULT_STYLE_KEY, 0);
  }

  get byteLength(): number {
    return this.endOffset - this.startOffset;
  }

  /** Whether any chunk is loaded. */
  get isLoaded(): boolean {
    return this.loaded;
  }

  /** The loaded text as it arrived, for re-feeding it in slices. */
  rawText(): string {
    return this.chunks.join("");
  }

  /** Line number of the first loaded byte's line, or null when unknown. */
  get knownFirstLine(): number | null {
    return this.firstLine;
  }

  get range(): { readonly start: number; readonly end: number } {
    return { start: this.startOffset, end: this.endOffset };
  }

  get styleTable(): readonly LogStyle[] {
    return this.styles.table;
  }

  reset(): void {
    this.chunks = [];
    this.loaded = false;
    this.startOffset = 0;
    this.endOffset = 0;
    this.firstLine = null;
    this.headComplete = true;
    this.clearLines();
    this.generation += 1;
  }

  /**
   * Adds a chunk: later text when it starts where the loaded text ends, earlier text
   * when it ends where the loaded text starts, and otherwise a fresh log.
   */
  load(chunk: LogChunkInput): "append" | "prepend" | "replace" {
    if (this.loaded && chunk.offset === this.endOffset) {
      this.chunks.push(chunk.text);
      this.endOffset = chunk.nextOffset;
      // A later chunk can carry what the loaded text did not: its own line number.
      if (this.firstLine === null && chunk.firstLine !== null)
        this.firstLine =
          chunk.firstLine -
          this.chunks.slice(0, -1).reduce((n, text) => n + countNewlines(text), 0);
      this.feed(chunk.text);
      this.generation += 1;
      return "append";
    }
    if (this.loaded && chunk.nextOffset === this.startOffset) {
      this.chunks.unshift(chunk.text);
      const known = this.firstLine;
      this.startOffset = chunk.offset;
      this.firstLine =
        chunk.firstLine ?? (known === null ? null : known - countNewlines(chunk.text));
      this.headComplete = chunk.offset === 0 || chunk.startsAtLine;
      this.reparse();
      return "prepend";
    }
    this.chunks = [chunk.text];
    this.loaded = true;
    this.startOffset = chunk.offset;
    this.endOffset = chunk.nextOffset;
    this.firstLine = chunk.offset === 0 ? 0 : chunk.firstLine;
    this.headComplete = chunk.offset === 0 || chunk.startsAtLine;
    this.reparse();
    return "replace";
  }

  private clearLines(): void {
    this.content = [];
    this.plain = [];
    this.lower = [];
    this.startStyle = [];
    this.byteStart = [];
    this.stamp = [];
    this.kind = [];
    this.section = [];
    this.hidden = [];
    this.sections = [];
    this.state = { style: 0, stack: [], format: null, nextByte: this.startOffset };
    this.pending = "";
    this.undo = null;
    this.sawTimestamp = false;
  }

  private reparse(): void {
    this.clearLines();
    for (const text of this.chunks) this.feed(text);
    this.generation += 1;
  }

  /** Parses `text` after everything fed so far. */
  feed(text: string): void {
    this.rollbackProvisional();
    let source = this.pending + text;
    let newline = source.indexOf("\n");
    let from = 0;
    while (newline !== -1) {
      this.processLine(source.slice(from, newline));
      from = newline + 1;
      newline = source.indexOf("\n", from);
    }
    source = source.slice(from);
    this.pending = source;
    if (source.length > 0) this.processProvisional(source);
  }

  private rollbackProvisional(): void {
    const undo = this.undo;
    if (undo === null) return;
    this.undo = null;
    const truncate = <T>(values: T[]) => {
      values.length = undo.lineCount;
    };
    truncate(this.content);
    truncate(this.plain);
    truncate(this.lower);
    truncate(this.startStyle);
    truncate(this.byteStart);
    truncate(this.stamp);
    truncate(this.kind);
    truncate(this.section);
    truncate(this.hidden);
    this.sections.length = undo.sectionCount;
    for (const closed of undo.closed) {
      const section = this.sections[closed.id];
      if (section) section.endTs = closed.endTs;
    }
    if (undo.previous !== null) {
      this.content[undo.previous.index] = undo.previous.content;
      this.plain[undo.previous.index] = undo.previous.plain;
      this.lower[undo.previous.index] = undefined;
    }
    this.state = undo.state;
  }

  private processProvisional(raw: string): void {
    const previousIndex = this.content.length - 1;
    const undo: Undo = {
      lineCount: this.content.length,
      sectionCount: this.sections.length,
      state: { ...this.state, stack: [...this.state.stack] },
      previous:
        previousIndex >= 0
          ? {
              index: previousIndex,
              content: this.content[previousIndex]!,
              plain: this.plain[previousIndex]!,
            }
          : null,
      closed: this.state.stack.map((id) => ({ id, endTs: this.sections[id]!.endTs })),
    };
    this.processLine(raw);
    this.undo = undo;
  }

  private processLine(raw: string): void {
    const index = this.content.length;
    const byteStart = this.state.nextByte;
    this.state.nextByte = byteStart + utf8Length(raw) + 1;
    let line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;

    // Timestamps, detected from the first line that has text.
    let ts = Number.NaN;
    let continues = false;
    if (this.state.format === null && line.length > 0)
      this.state.format = GITLAB_TIMESTAMP.test(line)
        ? "gitlab"
        : GITHUB_TIMESTAMP.test(line)
          ? "github"
          : "none";
    if (this.state.format === "gitlab") {
      if (GITLAB_TIMESTAMP.test(line)) {
        ts = timestampMs(line.slice(0, 27));
        continues = line[GITLAB_TIMESTAMP_LENGTH - 1] === "+";
        line = line.slice(GITLAB_TIMESTAMP_LENGTH);
      }
    } else if (this.state.format === "github") {
      const match = GITHUB_TIMESTAMP.exec(line);
      if (match) {
        ts = timestampMs(match[0].trimEnd());
        line = line.slice(match[0].length);
      }
    }
    if (!Number.isNaN(ts)) this.sawTimestamp = true;

    let lineKind: number = LINE_TEXT;
    let opened: number | null = null;
    let structural = false;

    // GitLab sections. Markers come before the `\r` rule: GitLab writes
    // `section_start:…\r\e[0K<header>`, which the rule would erase.
    if (line.includes("section_")) {
      SECTION_MARKER.lastIndex = 0;
      let rest = "";
      let last = 0;
      let match = SECTION_MARKER.exec(line);
      let sawEnd = false;
      while (match !== null) {
        rest += line.slice(last, match.index);
        last = match.index + match[0].length;
        const [, which, seconds, name, options] = match;
        const at = Number(seconds);
        if (which === "start") {
          opened = this.openSection(name!, index, at, options?.includes("collapsed=true") ?? false);
        } else {
          this.closeSection(name!, at);
          sawEnd = true;
        }
        match = SECTION_MARKER.exec(line);
      }
      rest += line.slice(last);
      line = rest;
      if (opened !== null) lineKind = LINE_SECTION;
      else if (sawEnd) structural = true;
    } else if (line.startsWith("##[")) {
      const command = GITHUB_COMMAND.exec(line);
      if (command) {
        const name = command[1];
        line = line.slice(command[0].length);
        if (name === "group") {
          opened = this.openSection(line, index, Number.isNaN(ts) ? null : ts / 1000, false);
          lineKind = LINE_SECTION;
        } else if (name === "endgroup") {
          const top = this.state.stack.at(-1);
          if (top !== undefined) this.closeSectionAt(top, Number.isNaN(ts) ? null : ts / 1000);
          structural = true;
        } else
          lineKind =
            name === "error" ? LINE_ERROR : name === "warning" ? LINE_WARNING : LINE_NOTICE;
      }
    }

    // Progress bars rewrite their line: only the text after the last `\r` stays.
    const carriage = line.lastIndexOf("\r");
    if (carriage !== -1) line = line.slice(carriage + 1);

    const startStyle = this.state.style;
    const { plain, endStyle } = tokenize(line, startStyle, this.styles, null);
    this.state.style = endStyle;
    if (structural && plain.trim().length > 0) structural = false;

    if (continues && index > 0 && !Number.isNaN(this.stamp[index - 1]!)) {
      // GitLab split one long line; the rest rides on the previous row.
      this.content[index - 1] += line;
      this.plain[index - 1] += plain;
      this.lower[index - 1] = undefined;
      structural = true;
    }

    this.content.push(line);
    this.plain.push(plain);
    this.lower.push(undefined);
    this.startStyle.push(startStyle);
    this.byteStart.push(byteStart);
    this.stamp.push(ts);
    this.kind.push(lineKind);
    this.section.push(opened ?? this.state.stack.at(-1) ?? -1);
    this.hidden.push(structural);
  }

  private openSection(name: string, header: number, at: number | null, collapsed: boolean) {
    const id = this.sections.length;
    this.sections.push({
      id,
      name,
      header,
      parent: this.state.stack.at(-1) ?? -1,
      startTs: at,
      endTs: null,
      collapsed,
    });
    this.state.stack.push(id);
    return id;
  }

  private closeSection(name: string, at: number) {
    for (let depth = this.state.stack.length - 1; depth >= 0; depth -= 1) {
      const id = this.state.stack[depth]!;
      if (this.sections[id]!.name === name) {
        this.closeSectionAt(id, at);
        return;
      }
    }
  }

  private closeSectionAt(id: number, at: number | null) {
    const depth = this.state.stack.lastIndexOf(id);
    if (depth === -1) return;
    // Closing an outer section closes the ones still open inside it.
    for (const inner of this.state.stack.splice(depth)) this.sections[inner]!.endTs = at;
  }

  setCollapsed(sectionId: number, collapsed: boolean): void {
    const section = this.sections[sectionId];
    if (!section || section.collapsed === collapsed) return;
    section.collapsed = collapsed;
    this.generation += 1;
  }

  setAllCollapsed(collapsed: boolean): void {
    for (const section of this.sections) section.collapsed = collapsed;
    this.generation += 1;
  }

  /** Expands every section that hides `index`, so a search result can be shown. */
  reveal(index: number): void {
    let id = this.section[index] ?? -1;
    if (id !== -1 && this.sections[id]!.header === index) id = this.sections[id]!.parent;
    let changed = false;
    while (id !== -1) {
      const section = this.sections[id]!;
      if (section.collapsed) {
        section.collapsed = false;
        changed = true;
      }
      id = section.parent;
    }
    if (changed) this.generation += 1;
  }

  private firstShownIndex(): number {
    return this.headComplete ? 0 : Math.min(1, this.content.length);
  }

  layout(): JobLogLayout {
    const count = this.content.length;
    const blocked = new Uint8Array(this.sections.length);
    for (const section of this.sections)
      blocked[section.id] =
        section.collapsed || (section.parent !== -1 && blocked[section.parent] === 1) ? 1 : 0;
    const rows: number[] = [];
    const firstShown = this.firstShownIndex();
    for (let index = firstShown; index < count; index += 1) {
      if (this.hidden[index]) continue;
      const id = this.section[index]!;
      if (id !== -1) {
        const section = this.sections[id]!;
        const owner = section.header === index ? section.parent : id;
        if (owner !== -1 && blocked[owner] === 1) continue;
      }
      rows.push(index);
    }
    return {
      generation: this.generation,
      startOffset: this.startOffset,
      endOffset: this.endOffset,
      lineCount: count,
      rows: Int32Array.from(rows),
      byteStarts: Float64Array.from(this.byteStart),
      timestamps: Float64Array.from(this.stamp),
      kinds: Uint8Array.from(this.kind),
      sectionOf: Int32Array.from(this.section),
      sections: this.sections.map((section) => ({
        id: section.id,
        name: section.name,
        header: section.header,
        parent: section.parent,
        collapsed: section.collapsed,
        durationSeconds:
          section.startTs !== null && section.endTs !== null
            ? Math.max(0, section.endTs - section.startTs)
            : null,
      })),
      hasTimestamps: this.sawTimestamp,
      firstLine: this.firstLine,
      firstShown,
    };
  }

  /** The spans of the given raw lines, from each line's recorded start style. */
  render(indices: readonly number[]): Map<number, LogSpans> {
    const result = new Map<number, LogSpans>();
    for (const index of indices) {
      const content = this.content[index];
      if (content === undefined) continue;
      const spans: [string, number][] = [];
      tokenize(content, this.startStyle[index]!, this.styles, spans);
      result.set(index, spans);
    }
    return result;
  }

  /** Raw indices of shown-able lines containing `query`, case-insensitively, capped. */
  search(query: string): { readonly matches: Int32Array; readonly capped: boolean } {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return { matches: new Int32Array(0), capped: false };
    const matches: number[] = [];
    const firstShown = this.firstShownIndex();
    for (let index = firstShown; index < this.plain.length; index += 1) {
      if (this.hidden[index]) continue;
      let lower = this.lower[index];
      if (lower === undefined) {
        lower = this.plain[index]!.toLowerCase();
        this.lower[index] = lower;
      }
      if (lower.includes(needle)) {
        if (matches.length === SEARCH_MATCH_CAP)
          return { matches: Int32Array.from(matches), capped: true };
        matches.push(index);
      }
    }
    return { matches: Int32Array.from(matches), capped: false };
  }

  /** Plain text of one raw line, without escapes. */
  plainText(index: number): string {
    return this.plain[index] ?? "";
  }
}

/** The raw line whose byte range holds `offset`, or -1 before the loaded text. */
export function lineAtOffset(byteStarts: Float64Array, offset: number): number {
  let low = 0;
  let high = byteStarts.length - 1;
  if (high < 0 || offset < byteStarts[0]!) return -1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (byteStarts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** The line number a gutter shows for a raw line. */
export function gutterNumber(
  layout: Pick<JobLogLayout, "firstLine" | "firstShown">,
  index: number,
) {
  return layout.firstLine === null ? index - layout.firstShown + 1 : layout.firstLine + index + 1;
}
