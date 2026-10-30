// @effect-diagnostics nodeBuiltinImport:off - The packaged UI fixture owns disposable host files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

function fence(source: string): string {
  return `\`\`\`mermaid\n${source}\n\`\`\``;
}

function filler(label: string, count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `${label} paragraph ${String(index + 1)} keeps the reading position measurable.`,
  ).join("\n\n");
}

/** Prompts the fixture Codex provider answers with diagram replies instead of its fixed text. */
export const mermaidFixturePrompts = {
  fitting: "reply with deterministic fitting mermaid",
  short: "reply with deterministic short mermaid",
  rows: "reply with deterministic mermaid rows",
  long: "reply with deterministic long text",
  activity: "reply with deterministic Activity follow text",
  many: "reply with deterministic mermaid evictions",
  manyAgain: "reply with deterministic second mermaid evictions",
  streamed: "reply with deterministic streamed mermaid",
  streamedPlain: "reply with deterministic streamed plain code",
  keyboard: "reply with deterministic streamed keyboard text",
} as const;

/** A diagram source with only labels the packaged checks look for. */
export const mermaidFixtureDiagram = "flowchart LR\n  write[Fixture write] --> draw[Fixture draw]";

/** A diagram in a reply shorter than the timeline, so its sent row stays anchored at the top. */
export const mermaidFixtureShortDiagram = "flowchart LR\n  kept[Kept at the top]";
export const mermaidFixtureFittingDiagram = "flowchart LR\n  fits[Fits at the top]";

/**
 * The fixture provider's replies. `short` fits below its sent row; `rows` holds a diagram
 * with text below it in the same row; `long` is a following row of plain text; `many` holds
 * 101 distinct diagrams, more than the diagram cache keeps, so the first is drawn again when
 * it mounts again; `manyAgain` holds 101 others, which evict every earlier diagram.
 */
export const mermaidFixtureReplies: Readonly<Record<string, string>> = {
  [mermaidFixturePrompts.fitting]: fence(mermaidFixtureFittingDiagram),
  [mermaidFixturePrompts.short]: [
    fence(mermaidFixtureShortDiagram),
    "After the short diagram.",
  ].join("\n\n"),
  [mermaidFixturePrompts.rows]: [
    "Diagram reply intro.",
    fence(mermaidFixtureDiagram),
    filler("Below the diagram", 40),
  ].join("\n\n"),
  [mermaidFixturePrompts.long]: filler("Following reply", 60),
  [mermaidFixturePrompts.activity]: filler("Activity follow", 60),
  [mermaidFixturePrompts.many]: [
    ...Array.from({ length: 101 }, (_, index) =>
      fence(`flowchart LR\n  m${String(index)}[Many ${String(index)}] --> n${String(index)}`),
    ),
    "Last line after the diagrams.",
  ].join("\n\n"),
  [mermaidFixturePrompts.manyAgain]: [
    ...Array.from({ length: 101 }, (_, index) =>
      fence(`flowchart LR\n  a${String(index)}[Again ${String(index)}] --> b${String(index)}`),
    ),
    "Last line after the second diagrams.",
  ].join("\n\n"),
};

/** The streamed reply's last line, which the timeline follows while the reply streams. */
export const mermaidFixtureStreamedLastLine = "Last streamed line.";

/** The keyboard reply's last line. */
export const mermaidFixtureKeyboardLastLine = "Last keyboard line.";

/**
 * Replies the fixture provider streams one delta per chunk. `streamed` is taller than the
 * timeline before its diagram, so the list follows its end when the diagram's closing fence
 * arrives and the diagram draws, with more text still to come after it. `keyboard` is taller
 * than the timeline from its first delivery and streams for about nine seconds, long enough
 * for a reader to scroll away with the keyboard mid-glide, read while it grows, and return.
 */
export const mermaidFixtureStreamedReplies: Readonly<Record<string, readonly string[]>> = {
  [mermaidFixturePrompts.streamed]: streamedReply("mermaid"),
  [mermaidFixturePrompts.streamedPlain]: streamedReply("text"),
  [mermaidFixturePrompts.keyboard]: [
    `Keyboard reply intro.\n\n${filler("Keyboard before", 30)}\n\n`,
    ...Array.from(
      { length: 30 },
      (_, index) => `Keyboard streamed paragraph ${String(index + 1)} keeps the end in view.\n\n`,
    ),
    mermaidFixtureKeyboardLastLine,
  ],
};

/**
 * `streamedPlain` streams the same reply with the diagram's source in a plain code block, the
 * baseline for how closely the timeline follows a streaming end without a diagram drawing. The
 * diagram is the only sequence diagram the packaged scenario draws, so its renderer chunk loads
 * after its source shows, and the diagram replaces the source at the end in a later frame.
 */
function streamedReply(language: "mermaid" | "text"): readonly string[] {
  return [
    `Streamed reply intro.\n\n${filler("Streamed before", 30)}\n\n`,
    `\`\`\`${language}\nsequenceDiagram\n  participant streamed as Streamed draw\n  participant done as Streamed done\n  streamed->>done: Streamed reply\n  done-->>streamed: Streamed answer\n\`\`\`\n\n`,
    // Enough text after the diagram that a webview slow to draw it still draws it mid-stream.
    ...Array.from(
      { length: 12 },
      (_, index) => `Streamed after paragraph ${String(index + 1)} keeps the end in view.\n\n`,
    ),
    mermaidFixtureStreamedLastLine,
  ];
}

/** Workspace Markdown files the Files rendered view opens. */
export const mermaidFixtureFiles = {
  valid: {
    name: "mermaid-valid.md",
    contents: `# Valid diagram\n\n${fence(mermaidFixtureDiagram)}\n\nAfter the valid diagram.\n`,
  },
  invalid: {
    name: "mermaid-invalid.md",
    contents: `# Invalid diagram\n\n${fence("flowchart TD\n  A --> B\n  B --> C]")}\n`,
  },
  hostile: {
    name: "mermaid-hostile.md",
    contents: [
      "# Hostile diagram",
      "",
      fence(
        [
          "flowchart TD",
          '  A[Start] --> B[Next] --> C["<img src=/mermaid-probe/label>"]',
          '  img@{ img: "/mermaid-probe/node.png", label: "Image", w: 60, h: 60 }',
          '  click A "javascript:alert(1)"',
          '  click B href "/mermaid-probe/link"',
          "  click C call fn()",
        ].join("\n"),
      ),
      "",
    ].join("\n"),
  },
} as const;

export function prepareMermaidFixtureFiles(projectPath: string): void {
  for (const file of Object.values(mermaidFixtureFiles)) {
    NodeFS.writeFileSync(NodePath.join(projectPath, file.name), file.contents);
  }
}
