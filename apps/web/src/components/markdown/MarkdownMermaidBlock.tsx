import { CodeIcon } from "lucide-react";
import { use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { LRUCache } from "../../lib/lruCache";
import { ReadingAnchorContext } from "../chat/readingAnchor";
import { Button } from "../ui/button";
import { RetryButton } from "../ui/retry-button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  MarkdownCodeBlock,
  MarkdownCodeBlockCopyAction,
  MarkdownCodeBlockWrapAction,
} from "./MarkdownCodeBlock";
import { reportMarkdownActionFailure } from "./markdownActionFailure";
import { MERMAID_SOURCE_LIMIT } from "./mermaidFence";
import type { MermaidDiagram, MermaidDiagramProblem, MermaidFonts } from "./mermaidRenderer";
import { scheduleRender } from "./renderQueue";

type MermaidRenderer = typeof import("./mermaidRenderer");

/** A drawn diagram, or why its source cannot be drawn. */
type DiagramEntry =
  | { readonly kind: "diagram"; readonly diagram: MermaidDiagram; readonly idPrefix: string }
  | { readonly kind: "problem"; readonly problem: MermaidDiagramProblem };

/** What a block shows, for the source it was drawn from. */
interface ShownDiagram {
  readonly source: string;
  readonly entry: DiagramEntry;
}

interface PendingDiagramJob {
  readonly subscribers: Set<(entry: DiagramEntry) => void>;
  cancel: () => void;
}

const MAX_DIAGRAM_CACHE_ENTRIES = 100;
const MAX_DIAGRAM_CACHE_BYTES = 16 * 1024 * 1024;
const TOO_LONG: MermaidDiagramProblem = { kind: "too-large", limit: "characters" };

/**
 * Drawn diagrams and diagram errors, keyed by the fonts and the full source, never a hash, so
 * two sources never share an entry. A cached remount, a theme switch or a second surface showing
 * the same diagram draws in the same commit; an invalid diagram is parsed once.
 */
const diagramCache = new LRUCache<DiagramEntry>(MAX_DIAGRAM_CACHE_ENTRIES, MAX_DIAGRAM_CACHE_BYTES);
/** Queued renders by the same key, so blocks join only a job for their exact source and fonts. */
const pendingDiagramJobs = new Map<string, PendingDiagramJob>();
let diagramIdCounter = 0;
/** Read once, by the first block that misses the cache, and reused. */
let diagramFonts: { readonly fonts: MermaidFonts; readonly key: string } | null = null;
let rendererModule: Promise<MermaidRenderer> | null = null;
const importMermaidRenderer = () => import("./mermaidRenderer");
let rendererLoader: () => Promise<MermaidRenderer> = importMermaidRenderer;

/** One shared import of the renderer; a failed one is cleared so Retry can try again. */
function loadMermaidRenderer(): Promise<MermaidRenderer> {
  rendererModule ??= rendererLoader().catch((error: unknown) => {
    rendererModule = null;
    throw error;
  });
  return rendererModule;
}

/** Test seam: replaces the renderer import, or restores it when given nothing. */
export function __setMermaidRendererLoaderForTests(loader?: () => Promise<MermaidRenderer>): void {
  rendererLoader = loader ?? importMermaidRenderer;
  rendererModule = null;
}

/** Test seam: forgets every drawn diagram, pending job and the measured fonts. */
export function __resetMermaidDiagramsForTests(): void {
  diagramCache.clear();
  for (const job of pendingDiagramJobs.values()) job.cancel();
  pendingDiagramJobs.clear();
  diagramFonts = null;
  rendererModule = null;
}

function diagramKey(fontKey: string, source: string): string {
  return `${fontKey}\0${source}`;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

/** The cached entry for `source` with the measured fonts, if both exist. */
function cachedDiagramEntry(source: string): DiagramEntry | null {
  return diagramFonts ? diagramCache.get(diagramKey(diagramFonts.key, source)) : null;
}

/** The fonts diagrams are measured in, read from the first block that misses the cache. */
function measureDiagramFonts(host: HTMLElement): { fonts: MermaidFonts; key: string } {
  diagramFonts ??= readDiagramFonts(host);
  return diagramFonts;
}

function readDiagramFonts(host: HTMLElement): { fonts: MermaidFonts; key: string } {
  const root = host.closest<HTMLElement>(".chat-markdown") ?? host;
  const rootStyle = getComputedStyle(root);
  const sourceBlock = host.querySelector("pre");
  const fontFamily = rootStyle.fontFamily || "sans-serif";
  const fontSize = Number.parseFloat(rootStyle.fontSize) || 14;
  const fontFamilyMono = (sourceBlock && getComputedStyle(sourceBlock).fontFamily) || "monospace";
  return {
    fonts: { fontFamily, fontFamilyMono, fontSize },
    key: `${fontFamily}|${fontSize}|${fontFamilyMono}`,
  };
}

function estimateEntrySize(key: string, entry: DiagramEntry): number {
  const content = entry.kind === "diagram" ? entry.diagram.svg : JSON.stringify(entry.problem);
  return (key.length + content.length) * 2;
}

function finishDiagramJob(key: string, job: PendingDiagramJob, entry: DiagramEntry): void {
  if (pendingDiagramJobs.get(key) === job) pendingDiagramJobs.delete(key);
  // An unexpected failure is shown but not kept: the next mount tries again.
  if (entry.kind === "diagram" || entry.problem.kind !== "failed") {
    diagramCache.set(key, entry, estimateEntrySize(key, entry));
  }
  for (const subscriber of job.subscribers) subscriber(entry);
}

/**
 * Joins, or queues, the one render job for `key`. The returned unsubscribe cancels a job that
 * has not run once its last subscriber leaves; a job that ran has already written the cache.
 */
function subscribeToDiagramJob(
  key: string,
  source: string,
  fonts: MermaidFonts,
  renderer: MermaidRenderer,
  onEntry: (entry: DiagramEntry) => void,
): () => void {
  let job = pendingDiagramJobs.get(key);
  if (!job) {
    diagramIdCounter += 1;
    const idPrefix = `bibcode-mmd-${diagramIdCounter}`;
    const created: PendingDiagramJob = { subscribers: new Set(), cancel: () => undefined };
    created.cancel = scheduleRender(
      () => renderer.renderMermaidDiagram(source, fonts, idPrefix),
      (diagram) => finishDiagramJob(key, created, { kind: "diagram", diagram, idPrefix }),
      (error) => {
        const problem = renderer.describeMermaidProblem(error);
        // Pele's messages can quote the source: log the failure's class only.
        if (problem.kind === "failed") {
          reportMarkdownActionFailure({ operation: "render-diagram", code: problem.code });
        }
        finishDiagramJob(key, created, { kind: "problem", problem });
      },
    );
    pendingDiagramJobs.set(key, created);
    job = created;
  }
  const joined = job;
  joined.subscribers.add(onEntry);
  return () => {
    joined.subscribers.delete(onEntry);
    if (joined.subscribers.size === 0 && pendingDiagramJobs.get(key) === joined) {
      joined.cancel();
      pendingDiagramJobs.delete(key);
    }
  };
}

function withPeriod(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function problemMessage(problem: MermaidDiagramProblem): string {
  switch (problem.kind) {
    case "invalid":
      return withPeriod(
        problem.line > 0
          ? `Can't draw this diagram: line ${problem.line}, ${problem.detail}`
          : `Can't draw this diagram: ${problem.detail}`,
      );
    case "unsupported":
      return "Diagram type not supported.";
    case "too-large":
      if (problem.limit === "edges") return "Too large to draw: over 500 edges.";
      if (problem.limit === "characters") return "Too large to draw: over 50,000 characters.";
      return "Too large to draw.";
    case "failed":
      return "Couldn't draw this diagram.";
  }
}

/** The fenced source a copied selection inside the diagram becomes. */
function fencedMermaidSource(source: string): string {
  const longestRun = Math.max(0, ...[...source.matchAll(/`{3,}/g)].map((run) => run[0].length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}mermaid\n${source}\n${fence}`;
}

function DiagramViewToggle({
  showingSource,
  onToggle,
}: {
  showingSource: boolean;
  onToggle: () => void;
}) {
  const label = showingSource ? "Show diagram" : "Show source";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="chat-markdown-chrome-action"
            aria-pressed={showingSource}
            onClick={onToggle}
            aria-label={label}
          />
        }
      >
        <CodeIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

export interface MarkdownMermaidBlockProps {
  /** The fence body with `\n` line endings. */
  readonly source: string;
  /** The code block's text, which Copy writes. */
  readonly code: string;
  readonly fenceTitle: string | null;
  readonly theme: "light" | "dark";
  /** The highlighted source, shown until the diagram is ready and on Show source. */
  readonly children: ReactNode;
}

/**
 * A closed Mermaid fence: its highlighted source until the diagram is drawn, then the diagram
 * in the same code-block card. Drawing waits for the shared renderer module, the diagram
 * type's chunk and the page fonts, then runs one job in the render queue (#103). A source or
 * font change, or an unmount, cancels an attempt at whatever step it has reached, and a result
 * shows only in a block that still holds its source.
 */
export function MarkdownMermaidBlock({
  source,
  code,
  fenceTitle,
  theme,
  children,
}: MarkdownMermaidBlockProps) {
  const readingAnchor = use(ReadingAnchorContext);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const tooLong = source.length > MERMAID_SOURCE_LIMIT;
  // The fonts are measured once per page, so a shown entry belongs to the current source when
  // it was drawn from it. Render reads no other module state that could go stale.
  const [shown, setShown] = useState<ShownDiagram | null>(() => {
    const cached = tooLong ? null : cachedDiagramEntry(source);
    return cached ? { source, entry: cached } : null;
  });
  const [loadFailure, setLoadFailure] = useState<{ source: string; retrying: boolean } | null>(
    null,
  );
  const [showingSource, setShowingSource] = useState(false);

  let entry = shown?.source === source ? shown.entry : null;
  if (entry === null && !tooLong) {
    // A source replaced by one already drawn, such as the final text of a streamed reply.
    const cached = cachedDiagramEntry(source);
    if (cached) {
      entry = cached;
      setShown({ source, entry: cached });
    }
  }

  // Swaps that change the block's height go through the timeline's reading anchor.
  const commitSwap = useCallback(
    (update: () => void) => {
      const body = bodyRef.current;
      if (readingAnchor && body) readingAnchor.preserveReadingPosition(body, update);
      else update();
    },
    [readingAnchor],
  );

  // A failed load waits for Retry, which marks the failure as retrying.
  const waitingForRetry = loadFailure?.source === source && !loadFailure.retrying;

  useEffect(() => {
    const host = bodyRef.current;
    if (tooLong || entry !== null || waitingForRetry || !host) return;
    const fonts = measureDiagramFonts(host);
    const attemptKey = diagramKey(fonts.key, source);
    const cached = diagramCache.get(attemptKey);
    if (cached) {
      commitSwap(() => setShown({ source, entry: cached }));
      return;
    }
    let cancelled = false;
    let unsubscribe = (): void => undefined;
    void (async () => {
      let renderer: MermaidRenderer;
      try {
        renderer = await loadMermaidRenderer();
        if (cancelled) return;
        await renderer.loadMermaidDiagramType(source);
        if (cancelled) return;
        const fontSet = typeof document === "undefined" ? undefined : document.fonts;
        if (fontSet?.status === "loading") {
          await fontSet.ready;
          if (cancelled) return;
        }
      } catch (error) {
        if (cancelled) return;
        reportMarkdownActionFailure({ operation: "load-diagram-renderer", code: errorName(error) });
        setLoadFailure({ source, retrying: false });
        return;
      }
      unsubscribe = subscribeToDiagramJob(attemptKey, source, fonts.fonts, renderer, (drawn) => {
        if (cancelled) return;
        commitSwap(() => {
          setShown({ source, entry: drawn });
          setLoadFailure(null);
        });
      });
    })();
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [commitSwap, entry, source, tooLong, waitingForRetry]);

  const diagram = !tooLong && entry?.kind === "diagram" ? entry : null;
  const problem = tooLong ? TOO_LONG : entry?.kind === "problem" ? entry.problem : null;
  const failedLoad = loadFailure?.source === source && diagram === null ? loadFailure : null;
  const showDiagram = diagram !== null && !showingSource;
  // React sets innerHTML again for every new object, which would replace the SVG on each render.
  const diagramMarkup = useMemo(
    () => (diagram ? { __html: diagram.diagram.svg } : null),
    [diagram],
  );

  return (
    <MarkdownCodeBlock
      code={code}
      language="mermaid"
      fenceTitle={fenceTitle}
      theme={theme}
      actions={
        <>
          {diagram ? (
            <DiagramViewToggle
              showingSource={showingSource}
              onToggle={() => commitSwap(() => setShowingSource((value) => !value))}
            />
          ) : null}
          {showDiagram ? null : <MarkdownCodeBlockWrapAction />}
          <MarkdownCodeBlockCopyAction />
        </>
      }
    >
      <div ref={bodyRef} className="chat-markdown-mermaid-body">
        {showDiagram ? (
          <div
            className="chat-markdown-mermaid"
            data-markdown-copy={fencedMermaidSource(source)}
            data-markdown-atomic=""
            // Sanitized by the diagram SVG sanitizer, parsed in this same HTML context.
            dangerouslySetInnerHTML={diagramMarkup!}
          />
        ) : (
          <>
            {problem || failedLoad ? (
              <div className="chat-markdown-mermaid-error" role="status">
                <span>
                  {failedLoad ? "Couldn't load the diagram renderer." : problemMessage(problem!)}
                </span>
                {failedLoad ? (
                  <RetryButton
                    retrying={failedLoad.retrying}
                    onRetry={() => setLoadFailure({ source, retrying: true })}
                  />
                ) : null}
              </div>
            ) : null}
            {children}
          </>
        )}
      </div>
    </MarkdownCodeBlock>
  );
}
