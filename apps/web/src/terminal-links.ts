import { isMacPlatform } from "./lib/utils";

export type TerminalLinkKind = "url" | "path";

export interface TerminalLinkMatch {
  kind: TerminalLinkKind;
  text: string;
  start: number;
  end: number;
}

export interface TerminalLinkBufferPosition {
  x: number;
  y: number;
}

export interface TerminalLinkBufferRange {
  start: TerminalLinkBufferPosition;
  end: TerminalLinkBufferPosition;
}

export interface TerminalBufferLineLike {
  readonly isWrapped?: boolean;
  translateToString(trimRight?: boolean, startColumn?: number, endColumn?: number): string;
}

export interface WrappedTerminalLinkLineSegment {
  bufferLineNumber: number;
  text: string;
  startIndex: number;
  endIndex: number;
}

export interface WrappedTerminalLinkLine {
  text: string;
  segments: ReadonlyArray<WrappedTerminalLinkLineSegment>;
}

const URL_PATTERN = /https?:\/\/[^\s"'`<>]+/g;
const FILE_PATH_PATTERN =
  /(?:~\/|\.{1,2}\/|\/|[A-Za-z]:[\\/]|\\\\)[^\s"'`<>]+|[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+(?::\d+){0,2}/g;
const FILE_URL_PATTERN = /file:\/\/[^\s"'`<>]+/g;
// Whole delimiter-bounded tokens only: a prefix or suffix of a longer name would open a different
// file. The leading delimiter is consumed (not a lookbehind, which older macOS WebKit rejects) and
// the `link` group carries the match.
const PREVIEW_FILENAME_PATTERN =
  /(?:^|[\s"'`<>([{])(?<link>[A-Za-z0-9._-]+\.(?:html?|pdf)(?::\d+){0,2})(?=[.,;!?:)\]}]*(?:[\s"'`<>]|$))/gi;
const TRAILING_PUNCTUATION_PATTERN = /[.,;!?]+$/;

// ConPTY full-screen repaints can mark an entire alt-screen TUI frame as one
// wrapped logical line, so the hover-time walk must stay bounded: an unbounded
// walk assembles the whole scrollback per mouse event and exhausts the V8 heap.
const MAX_WRAPPED_LINK_LOOKBEHIND_SEGMENTS = 50;
const MAX_WRAPPED_LINK_SEGMENTS = 100;

function trimClosingDelimiters(value: string): string {
  let output = value.replace(TRAILING_PUNCTUATION_PATTERN, "");
  if (output.length === 0) return output;

  const trimUnbalanced = (open: string, close: string) => {
    let opens = 0;
    let closes = 0;
    for (const character of output) {
      if (character === open) opens += 1;
      else if (character === close) closes += 1;
    }
    let end = output.length;
    while (end > 0 && output[end - 1] === close && closes > opens) {
      end -= 1;
      closes -= 1;
    }
    if (end < output.length) output = output.slice(0, end);
  };

  trimUnbalanced("(", ")");
  trimUnbalanced("[", "]");
  trimUnbalanced("{", "}");
  return output;
}

function overlaps(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end;
}

function collectMatches(
  line: string,
  kind: TerminalLinkKind,
  pattern: RegExp,
  existing: TerminalLinkMatch[],
): TerminalLinkMatch[] {
  const matches: TerminalLinkMatch[] = [];
  pattern.lastIndex = 0;

  for (const rawMatch of line.matchAll(pattern)) {
    const raw = rawMatch.groups?.link ?? rawMatch[0];
    const start = rawMatch.index === undefined ? -1 : rawMatch.index + rawMatch[0].indexOf(raw);
    if (start < 0 || raw.length === 0) continue;

    const trimmed = trimClosingDelimiters(raw);
    if (trimmed.length === 0) continue;
    if (kind === "path" && /^https?:\/\//i.test(trimmed)) continue;

    const candidate: TerminalLinkMatch = {
      kind,
      text: trimmed,
      start,
      end: start + trimmed.length,
    };

    const collides =
      existing.some((other) => overlaps(candidate, other)) ||
      matches.some((other) => overlaps(candidate, other));
    if (collides) continue;

    matches.push(candidate);
  }

  return matches;
}

function isWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}

function isAbsolutePath(value: string): boolean {
  return value.startsWith("/") || isWindowsAbsolutePath(value);
}

function isWindowsPathStyle(value: string): boolean {
  return isWindowsAbsolutePath(value) || /[A-Za-z]:\\/.test(value);
}

function joinPath(base: string, next: string, separator: "/" | "\\"): string {
  const cleanBase = base.replace(/[\\/]+$/, "");
  if (separator === "\\") {
    return `${cleanBase}\\${next.replaceAll("/", "\\")}`;
  }
  return `${cleanBase}/${next.replace(/^\/+/, "")}`;
}

function inferHomeFromCwd(cwd: string): string | undefined {
  const posixUser = cwd.match(/^\/Users\/([^/]+)/);
  if (posixUser?.[1]) {
    return `/Users/${posixUser[1]}`;
  }

  const posixHome = cwd.match(/^\/home\/([^/]+)/);
  if (posixHome?.[1]) {
    return `/home/${posixHome[1]}`;
  }

  const windowsUser = cwd.match(/^([A-Za-z]:\\Users\\[^\\]+)/);
  if (windowsUser?.[1]) {
    return windowsUser[1];
  }

  return undefined;
}

export function splitPathAndPosition(value: string): {
  path: string;
  line: string | undefined;
  column: string | undefined;
} {
  let path = value;
  let column: string | undefined;
  let line: string | undefined;

  const columnMatch = path.match(/:(\d+)$/);
  if (!columnMatch?.[1]) {
    return { path, line: undefined, column: undefined };
  }

  column = columnMatch[1];
  path = path.slice(0, -columnMatch[0].length);

  const lineMatch = path.match(/:(\d+)$/);
  if (lineMatch?.[1]) {
    line = lineMatch[1];
    path = path.slice(0, -lineMatch[0].length);
  } else {
    line = column;
    column = undefined;
  }

  return { path, line, column };
}

export function fileUrlToPath(raw: string): string | null {
  if (!raw.startsWith("file://")) return null;
  let url: URL;
  let pathname: string;
  try {
    url = new URL(raw);
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  // A host (after WHATWG normalisation drops `localhost`) means a network share: opening it
  // makes the host connect over SMB, which can leak credentials to whoever printed the link.
  if (url.host.length > 0) return null;
  const drive = /^\/([A-Za-z]:)(\/.*)?$/.exec(pathname);
  if (drive) return `${drive[1]}${(drive[2] ?? "\\").replaceAll("/", "\\")}`;
  return pathname;
}

/**
 * Network or device paths: any two leading separators, mixed or not. That covers UNC shares
 * (`\\server\share`, `//server/share`) and also `\\?\` and `\\.\` paths, where Win32 resolves
 * `..` (`\\.\C:\..\UNC\host\share`) into an SMB target. Check the path as printed, not one
 * resolved against the cwd: relative paths under a UNC cwd (e.g. WSL) can't name a new host.
 */
export function isNetworkPath(path: string): boolean {
  return /^[\\/]{2}/.test(path);
}

// A label must stand alone: `evil.test` linked inside `evil.test.trusted.example` must not pass.
const LINK_LABEL_BOUNDARY = /^[\s"'`<>()[\]{},;]?$/;

/**
 * Whether an OSC 8 link's label (the clicked cells, read by xterm cell column so wide characters
 * can't shift it) is its URI, with or without scheme and trailing slash, and stands alone, so the
 * link can open without confirmation. xterm reports one range per row, so a label that continues
 * onto another row is not trusted and gets confirmed instead.
 */
export function terminalLinkLabelShowsUri(
  range: TerminalLinkBufferRange,
  uri: string,
  getLine: (bufferLineIndex: number) => TerminalBufferLineLike | null | undefined,
): boolean {
  if (range.start.y !== range.end.y) return false;
  const y = range.start.y;
  const line = getLine(y - 1);
  if (!line) return false;
  const label = line.translateToString(true, range.start.x - 1, range.end.x).trim();
  const withoutScheme = uri.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const shownForms = [uri, withoutScheme].flatMap((form) => [form, form.replace(/\/$/, "")]);
  if (label.length === 0 || !shownForms.includes(label)) return false;

  const before =
    range.start.x > 1
      ? line.translateToString(false, 0, range.start.x - 1).slice(-1)
      : line.isWrapped
        ? (getLine(y - 2)
            ?.translateToString(false)
            .slice(-1) ?? "")
        : "";
  const nextLine = getLine(y);
  const rest = line.translateToString(false, range.end.x);
  const after =
    rest.length > 0
      ? rest.charAt(0)
      : nextLine?.isWrapped
        ? nextLine.translateToString(false, 0, 1)
        : "";
  return LINK_LABEL_BOUNDARY.test(before) && LINK_LABEL_BOUNDARY.test(after);
}

export function terminalPreviewFilePath(rawPath: string, cwd: string): string | null {
  const localPath = rawPath.startsWith("file://") ? fileUrlToPath(rawPath) : rawPath;
  if (localPath === null) return null;
  const { path } = splitPathAndPosition(localPath);
  if (!/\.(?:html?|pdf)$/i.test(path)) return null;
  return resolvePathLinkTarget(path, cwd);
}

export function extractTerminalLinks(line: string): TerminalLinkMatch[] {
  const urlMatches = collectMatches(line, "url", URL_PATTERN, []);
  // File URLs go first so the Windows-drive path alternative can't match inside `file:`.
  const fileUrlMatches = collectMatches(line, "path", FILE_URL_PATTERN, urlMatches);
  const taken = [...urlMatches, ...fileUrlMatches];
  const pathMatches = collectMatches(line, "path", FILE_PATH_PATTERN, taken);
  const filenameMatches = collectMatches(line, "path", PREVIEW_FILENAME_PATTERN, [
    ...taken,
    ...pathMatches,
  ]);
  return [...taken, ...pathMatches, ...filenameMatches].toSorted((a, b) => a.start - b.start);
}

export function collectWrappedTerminalLinkLine(
  bufferLineNumber: number,
  getLine: (bufferLineIndex: number) => TerminalBufferLineLike | null | undefined,
): WrappedTerminalLinkLine | null {
  const anchorLine = getLine(bufferLineNumber - 1);
  if (!anchorLine) return null;

  let startBufferLineNumber = bufferLineNumber;
  let startLine = anchorLine;

  // Walk back at most a bounded number of wrapped rows. Starting the window
  // mid-logical-line only costs detection of links that span past the window.
  while (
    startBufferLineNumber > 1 &&
    startLine.isWrapped &&
    bufferLineNumber - startBufferLineNumber < MAX_WRAPPED_LINK_LOOKBEHIND_SEGMENTS
  ) {
    const previousLine = getLine(startBufferLineNumber - 2);
    if (!previousLine) return null;
    startBufferLineNumber -= 1;
    startLine = previousLine;
  }

  const segments: WrappedTerminalLinkLineSegment[] = [];
  let nextStartIndex = 0;
  let currentBufferLineNumber = startBufferLineNumber;

  while (segments.length < MAX_WRAPPED_LINK_SEGMENTS) {
    const currentLine = getLine(currentBufferLineNumber - 1);
    if (!currentLine) break;

    const nextLine = getLine(currentBufferLineNumber);
    const hasWrappedContinuation = nextLine?.isWrapped === true;
    const text = currentLine.translateToString(!hasWrappedContinuation);

    segments.push({
      bufferLineNumber: currentBufferLineNumber,
      text,
      startIndex: nextStartIndex,
      endIndex: nextStartIndex + text.length,
    });
    nextStartIndex += text.length;

    if (!hasWrappedContinuation) break;
    currentBufferLineNumber += 1;
  }

  return {
    text: segments.map((segment) => segment.text).join(""),
    segments,
  };
}

function resolveCharacterPosition(
  segments: ReadonlyArray<WrappedTerminalLinkLineSegment>,
  characterIndex: number,
): TerminalLinkBufferPosition {
  for (const segment of segments) {
    if (characterIndex < segment.endIndex) {
      return {
        x: characterIndex - segment.startIndex + 1,
        y: segment.bufferLineNumber,
      };
    }
  }

  const lastSegment = segments[segments.length - 1];
  return {
    x: Math.max(lastSegment?.text.length ?? 0, 1),
    y: lastSegment?.bufferLineNumber ?? 1,
  };
}

export function resolveWrappedTerminalLinkRange(
  wrappedLine: WrappedTerminalLinkLine,
  match: Pick<TerminalLinkMatch, "start" | "end">,
): TerminalLinkBufferRange {
  return {
    start: resolveCharacterPosition(wrappedLine.segments, match.start),
    end: resolveCharacterPosition(wrappedLine.segments, match.end - 1),
  };
}

export function wrappedTerminalLinkRangeIntersectsBufferLine(
  range: TerminalLinkBufferRange,
  bufferLineNumber: number,
): boolean {
  return range.start.y <= bufferLineNumber && bufferLineNumber <= range.end.y;
}

export function isTerminalLinkActivation(
  event: Pick<MouseEvent, "metaKey" | "ctrlKey">,
  platform = typeof navigator === "undefined" ? "" : navigator.platform,
): boolean {
  if (platform.length === 0) return false;
  return isMacPlatform(platform)
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
}

export function resolvePathLinkTarget(rawPath: string, cwd: string): string {
  const { path, line, column } = splitPathAndPosition(rawPath);

  let resolvedPath = path;
  if (path.startsWith("~/")) {
    const home = inferHomeFromCwd(cwd);
    if (home) {
      const separator: "/" | "\\" = isWindowsPathStyle(home) ? "\\" : "/";
      resolvedPath = joinPath(home, path.slice(2), separator);
    }
  } else if (!isAbsolutePath(path)) {
    const separator: "/" | "\\" = isWindowsPathStyle(cwd) ? "\\" : "/";
    resolvedPath = joinPath(cwd, path, separator);
  }

  if (!line) return resolvedPath;
  return `${resolvedPath}:${line}${column ? `:${column}` : ""}`;
}
