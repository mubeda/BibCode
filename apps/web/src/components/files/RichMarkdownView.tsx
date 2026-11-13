import { lazy, type ReactNode, Suspense, useRef } from "react";

import { ScrollArea } from "~/components/ui/scroll-area";

import type { RichMarkdownSurfaceProps } from "./richMarkdown/RichMarkdownSurface";
import { type SavableSession, useFileSaveShortcut } from "./useFileSaveShortcut";

const RichMarkdownSurface = lazy(() => import("./richMarkdown/RichMarkdownSurface"));

type RichMarkdownViewSession = RichMarkdownSurfaceProps["session"] & SavableSession;

type LoadedRichMarkdownProps = Pick<
  RichMarkdownSurfaceProps,
  "contents" | "onEditorChange" | "workspace"
> & { session: RichMarkdownViewSession };

/** The editable rendered view; until its editor loads, the read-only view shows the text. */
export function RichMarkdownView({
  fallback,
  ...props
}: LoadedRichMarkdownProps & { fallback: ReactNode }) {
  return (
    <Suspense fallback={fallback}>
      <LoadedRichMarkdown {...props} />
    </Suspense>
  );
}

/** Inside the boundary, so the save shortcut's effect first runs once the loaded editor commits. */
function LoadedRichMarkdown({ session, ...props }: LoadedRichMarkdownProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  useFileSaveShortcut(surfaceRef, session);
  return (
    <ScrollArea ref={surfaceRef} className="min-h-0 flex-1">
      <RichMarkdownSurface session={session} {...props} />
    </ScrollArea>
  );
}
