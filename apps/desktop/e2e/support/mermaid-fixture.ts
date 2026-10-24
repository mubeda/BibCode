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
  rows: "reply with deterministic mermaid rows",
  long: "reply with deterministic long text",
  many: "reply with deterministic mermaid evictions",
} as const;

/** A diagram source with only labels the packaged checks look for. */
export const mermaidFixtureDiagram = "flowchart LR\n  write[Fixture write] --> draw[Fixture draw]";

/**
 * The fixture provider's replies. `rows` holds a diagram with text below it in the same row;
 * `long` is a following row of plain text; `many` holds 101 distinct diagrams, more than the
 * diagram cache keeps, so the first is drawn again when it mounts again.
 */
export const mermaidFixtureReplies: Readonly<Record<string, string>> = {
  [mermaidFixturePrompts.rows]: [
    "Diagram reply intro.",
    fence(mermaidFixtureDiagram),
    filler("Below the diagram", 40),
  ].join("\n\n"),
  [mermaidFixturePrompts.long]: filler("Following reply", 60),
  [mermaidFixturePrompts.many]: [
    ...Array.from({ length: 101 }, (_, index) =>
      fence(`flowchart LR\n  m${String(index)}[Many ${String(index)}] --> n${String(index)}`),
    ),
    "Last line after the diagrams.",
  ].join("\n\n"),
};

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
