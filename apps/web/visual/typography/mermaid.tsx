import { useEffect, useState } from "react";
import ChatMarkdown from "../../src/components/ChatMarkdown";
import { __setMermaidRendererLoaderForTests } from "../../src/components/markdown/MarkdownMermaidBlock";
import { sanitizeDiagramSvg } from "../../src/components/markdown/mermaidSanitizer";
import { MERMAID_SANITIZER_PROBES } from "../../src/test/mermaidSanitizerProbes";
import type { Fixture } from "./types";

const cwd = "/owned-fixture/workspace";
const diagrams = [
  "A flowchart, a sequence diagram and an invalid diagram:",
  "",
  "```mermaid",
  "flowchart LR",
  "  write[Write the reply] --> close{Fence closed?}",
  "  close -->|yes| draw[Draw the diagram]",
  "  close -.->|no| source[Show the source]",
  "```",
  "",
  "```mermaid",
  "sequenceDiagram",
  "  participant Agent",
  "  participant Timeline",
  "  Agent->>Timeline: Closing fence",
  "  Timeline-->>Agent: Diagram drawn",
  "```",
  "",
  "```mermaid",
  "flowchart TD",
  "  A --> B",
  "  B --> C]",
  "```",
].join("\n");
const unavailable = ["```mermaid", "flowchart LR", "  Load --> Retry", "```"].join("\n");

/** A renderer that never loads, for the Retry state; restored when the fixture leaves. */
function RendererUnavailable() {
  useState(() => {
    __setMermaidRendererLoaderForTests(() =>
      Promise.reject(new TypeError("Failed to fetch dynamically imported module")),
    );
    return null;
  });
  useEffect(() => () => __setMermaidRendererLoaderForTests(), []);
  return <ChatMarkdown text={unavailable} cwd={cwd} />;
}

/** Every hostile probe, inserted through the sanitizer the way a drawn diagram is. */
function SanitizerProbe() {
  return (
    <div className="chat-markdown grid grid-cols-4 gap-3 text-sm">
      {MERMAID_SANITIZER_PROBES.map(({ name, svg }) => (
        <figure key={name} className="chat-markdown-codeblock m-0">
          <div
            className="chat-markdown-mermaid"
            // The output under test: the sanitizer's, inserted as a drawn diagram is.
            dangerouslySetInnerHTML={{ __html: sanitizeDiagramSvg(svg) }}
          />
          <figcaption className="px-3 pb-2 text-xs text-muted-foreground">
            Sanitized {name}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}

export const mermaidFixtures: readonly Fixture[] = [
  {
    id: "chat-markdown-mermaid",
    title: "Mermaid flowchart, sequence diagram and invalid diagram",
    modules: [
      "components/markdown/MarkdownMermaidBlock.tsx",
      "components/markdown/MarkdownCodeBlock.tsx",
      "components/markdown/mermaidSanitizer.ts",
      "index.css",
    ],
    owners: ["MarkdownMermaidBlock", "MarkdownCodeBlock"],
    anchors: [
      "Write the reply",
      "Draw the diagram",
      "Agent",
      "Diagram drawn",
      "Can't draw this diagram: line 3, Unrecognized text.",
    ],
    render: () => <ChatMarkdown text={diagrams} cwd={cwd} />,
  },
  {
    id: "chat-markdown-mermaid-retry",
    title: "Mermaid renderer that failed to load",
    modules: ["components/markdown/MarkdownMermaidBlock.tsx", "index.css"],
    owners: ["MarkdownMermaidBlock"],
    anchors: ["Couldn't load the diagram renderer.", "Retry"],
    render: () => <RendererUnavailable />,
  },
  {
    id: "mermaid-sanitizer-probe",
    title: "Hostile diagram SVG after the sanitizer",
    modules: ["components/markdown/mermaidSanitizer.ts", "index.css"],
    owners: ["sanitizeDiagramSvg"],
    anchors: MERMAID_SANITIZER_PROBES.map(({ name }) => `Sanitized ${name}`),
    render: () => <SanitizerProbe />,
  },
];
