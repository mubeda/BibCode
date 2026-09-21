export interface InlineCommentSelection {
  path: string;
  startLine: number;
  line: number;
  side: "left" | "right";
}
export function createInlineCommentGutter() {
  let anchor: { path: string; line: number; side: "left" | "right" } | null = null;
  let end = 0;
  return {
    beginSelection(path: string, line: number, side: "left" | "right") {
      if (Number.isSafeInteger(line) && line > 0) {
        anchor = { path, line, side };
        end = line;
      }
    },
    extendSelection(line: number) {
      if (anchor && Number.isSafeInteger(line) && line > 0) end = line;
    },
    selectionRange(): InlineCommentSelection | null {
      return anchor
        ? {
            path: anchor.path,
            startLine: Math.min(anchor.line, end),
            line: Math.max(anchor.line, end),
            side: anchor.side,
          }
        : null;
    },
  };
}
export function sourceLinesForSelection(
  patch: string,
  selection: Pick<InlineCommentSelection, "startLine" | "line" | "side">,
): string | null {
  let left = 0;
  let right = 0;
  let inHunk = false;
  const lines: string[] = [];
  for (const raw of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      left = Number(hunk[1]);
      right = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    const kind = raw[0];
    if (kind !== " " && kind !== "+" && kind !== "-") continue;
    const included = selection.side === "left" ? kind !== "+" : kind !== "-";
    const position = selection.side === "left" ? left : right;
    if (included && position >= selection.startLine && position <= selection.line)
      lines.push(raw.slice(1));
    if (kind !== "+") left++;
    if (kind !== "-") right++;
  }
  return lines.length === selection.line - selection.startLine + 1 ? lines.join("\n") : null;
}
export function insertSuggestion(body: string, source: string): string {
  return `${body}${body ? "\n\n" : ""}\`\`\`suggestion\n${source}\n\`\`\``;
}
