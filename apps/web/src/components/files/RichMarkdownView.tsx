import { lazy, type ReactNode, Suspense, useRef } from "react";

import { ScrollArea } from "~/components/ui/scroll-area";

import type { RichMarkdownSurfaceProps } from "./richMarkdown/RichMarkdownSurface";
import { useFileSaveShortcut } from "./useFileSaveShortcut";

const RichMarkdownSurface = lazy(() => import("./richMarkdown/RichMarkdownSurface"));

type RichMarkdownViewSession = RichMarkdownSurfaceProps["session"] & { flush(): Promise<unknown> };

/** The editable rendered view; until its editor loads, the read-only view shows the text. */
export function RichMarkdownView({
  session,
  contents,
  onEditorChange,
  fallback,
}: {
  session: RichMarkdownViewSession;
  contents: string;
  onEditorChange: RichMarkdownSurfaceProps["onEditorChange"];
  fallback: ReactNode;
}) {
  return (
    <Suspense fallback={fallback}>
      <LoadedRichMarkdown session={session} contents={contents} onEditorChange={onEditorChange} />
    </Suspense>
  );
}

/** Inside the boundary, so the save shortcut's effect first runs once the loaded editor commits. */
function LoadedRichMarkdown({
  session,
  contents,
  onEditorChange,
}: {
  session: RichMarkdownViewSession;
  contents: string;
  onEditorChange: RichMarkdownSurfaceProps["onEditorChange"];
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  useFileSaveShortcut(surfaceRef, session);
  return (
    <ScrollArea ref={surfaceRef} className="min-h-0 flex-1">
      <RichMarkdownSurface session={session} contents={contents} onEditorChange={onEditorChange} />
    </ScrollArea>
  );
}
