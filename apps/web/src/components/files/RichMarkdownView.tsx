import { lazy, type ReactNode, Suspense, useRef, useState } from "react";

import { ScrollArea } from "~/components/ui/scroll-area";

import type { RichMarkdownSurfaceProps } from "./richMarkdown/RichMarkdownSurface";
import { type SavableSession, useFileSaveShortcut } from "./useFileSaveShortcut";

type SurfaceModule = typeof import("./richMarkdown/RichMarkdownSurface");
let surfaceModule: Promise<SurfaceModule> | null = null;
/** Set once the editor chunk is in, so a view opened after that never shows the fallback. */
let LoadedSurface: SurfaceModule["default"] | null = null;

/**
 * Starts loading the editor before a file opens. `lazy` shows its fallback for one commit even
 * for a loaded chunk, and the fallback draws the file's diagrams, which the editor then drops and
 * draws again.
 */
export function preloadRichMarkdownSurface(): Promise<SurfaceModule> {
  surfaceModule ??= import("./richMarkdown/RichMarkdownSurface").then((module) => {
    LoadedSurface = module.default;
    return module;
  });
  return surfaceModule;
}
const LazySurface = lazy(preloadRichMarkdownSurface);

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
  // Chosen once per view: switching components would remount the editor.
  const [Surface] = useState(() => LoadedSurface ?? LazySurface);
  return (
    <ScrollArea ref={surfaceRef} className="min-h-0 flex-1">
      <Surface session={session} {...props} />
    </ScrollArea>
  );
}
