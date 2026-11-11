import { memo } from "react";

import { useTheme } from "../../../hooks/useTheme";
import { MarkdownMermaidBlock } from "../../markdown/MarkdownMermaidBlock";

/**
 * A Mermaid fence in the rendered editor, drawn by chat's Mermaid block. Memoized on its source,
 * so typing elsewhere in the file renders nothing here; only a theme switch re-renders it, and
 * the drawn SVG recolors through CSS without drawing again.
 */
export const RichMarkdownMermaid = memo(function RichMarkdownMermaid({
  source,
}: {
  readonly source: string;
}) {
  const { resolvedTheme } = useTheme();
  return (
    <>
      <p className="text-xs text-muted-foreground">Edit the diagram in source view</p>
      <MarkdownMermaidBlock
        source={source.replace(/\r\n?/g, "\n")}
        code={source}
        fenceTitle={null}
        theme={resolvedTheme}
      >
        <pre>
          <code>{source}</code>
        </pre>
      </MarkdownMermaidBlock>
    </>
  );
});
