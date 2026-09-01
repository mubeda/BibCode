import { memo, type ChangeEvent, useCallback, useMemo, useState } from "react";

import {
  isRepositoryImageDataUri,
  resolveImageLayerPresentation,
  type GitManagerImageDiffMode,
} from "./gitManagerImageDiff.logic";

const MODE_OPTIONS: ReadonlyArray<{
  readonly mode: GitManagerImageDiffMode;
  readonly label: string;
}> = Object.freeze([
  { mode: "two-up", label: "2-up" },
  { mode: "swipe", label: "Swipe" },
  { mode: "onion", label: "Onion-skin" },
  { mode: "difference", label: "Difference" },
]);

interface ImageModeButtonProps {
  readonly mode: GitManagerImageDiffMode;
  readonly label: string;
  readonly selected: boolean;
  readonly onSelect: (mode: GitManagerImageDiffMode) => void;
}

const ImageModeButton = memo(function ImageModeButton({
  mode,
  label,
  selected,
  onSelect,
}: ImageModeButtonProps) {
  const select = useCallback(() => onSelect(mode), [mode, onSelect]);
  return (
    <button
      aria-pressed={selected}
      className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring aria-pressed:bg-accent aria-pressed:text-accent-foreground"
      type="button"
      onClick={select}
    >
      {label}
    </button>
  );
});

interface ImagePaneProps {
  readonly label: "Before" | "After";
  readonly src: string | null;
}

const ImagePane = memo(function ImagePane({ label, src }: ImagePaneProps) {
  return (
    <figure className="flex min-h-48 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-[repeating-conic-gradient(var(--color-muted)_0_25%,transparent_0_50%)_50%/16px_16px]">
      <figcaption className="border-b border-border bg-background/90 px-2 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </figcaption>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-3">
        {src === null ? (
          <p className="text-xs text-muted-foreground">{label} image unavailable</p>
        ) : (
          <img
            alt={`${label} image`}
            className="max-h-full max-w-full object-contain"
            draggable={false}
            height={1}
            src={src}
            width={1}
          />
        )}
      </div>
    </figure>
  );
});

interface ImageLayerProps extends ImagePaneProps {
  readonly opacity: number;
  readonly clipPath: string | null;
  readonly mixBlendMode: "difference" | null;
}

const ImageLayer = memo(function ImageLayer({
  label,
  src,
  opacity,
  clipPath,
  mixBlendMode,
}: ImageLayerProps) {
  const style = useMemo(
    () => ({
      opacity,
      clipPath: clipPath ?? undefined,
      mixBlendMode: mixBlendMode ?? undefined,
    }),
    [clipPath, mixBlendMode, opacity],
  );
  if (src === null) {
    return (
      <p className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
        {label} image unavailable
      </p>
    );
  }
  return (
    <img
      alt={`${label} image`}
      className="absolute inset-0 size-full object-contain"
      draggable={false}
      height={1}
      src={src}
      style={style}
      width={1}
    />
  );
});

export interface GitManagerImageDiffProps {
  readonly before: string | null;
  readonly after: string | null;
  readonly mode: GitManagerImageDiffMode;
  readonly onModeChange: (mode: GitManagerImageDiffMode) => void;
}

export const GitManagerImageDiff = memo(function GitManagerImageDiff({
  before,
  after,
  mode,
  onModeChange,
}: GitManagerImageDiffProps) {
  const [position, setPosition] = useState(50);
  const beforeSrc = useMemo(() => (isRepositoryImageDataUri(before) ? before : null), [before]);
  const afterSrc = useMemo(() => (isRepositoryImageDataUri(after) ? after : null), [after]);
  const presentation = useMemo(
    () => resolveImageLayerPresentation(mode, position),
    [mode, position],
  );
  const changePosition = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setPosition(Number(event.currentTarget.value));
  }, []);
  const sliderLabel = mode === "swipe" ? "Swipe position" : "Onion opacity";

  return (
    <section aria-label="Image diff" className="flex min-h-0 flex-1 flex-col gap-3">
      <div aria-label="Image diff mode" className="flex flex-wrap gap-1.5" role="group">
        {MODE_OPTIONS.map((option) => (
          <ImageModeButton
            key={option.mode}
            label={option.label}
            mode={option.mode}
            selected={mode === option.mode}
            onSelect={onModeChange}
          />
        ))}
      </div>
      {mode === "swipe" || mode === "onion" ? (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{sliderLabel}</span>
          <input
            aria-label={sliderLabel}
            className="min-w-32 flex-1 accent-primary"
            max="100"
            min="0"
            type="range"
            value={position}
            onChange={changePosition}
          />
          <span className="w-9 text-right tabular-nums">{position}%</span>
        </label>
      ) : null}
      {mode === "two-up" ? (
        <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-2">
          <ImagePane label="Before" src={beforeSrc} />
          <ImagePane label="After" src={afterSrc} />
        </div>
      ) : (
        <div className="relative min-h-64 flex-1 overflow-hidden rounded-lg border border-border bg-[repeating-conic-gradient(var(--color-muted)_0_25%,transparent_0_50%)_50%/16px_16px]">
          <ImageLayer
            clipPath={null}
            label="Before"
            mixBlendMode={null}
            opacity={presentation.beforeOpacity}
            src={beforeSrc}
          />
          <ImageLayer
            clipPath={presentation.afterClipPath}
            label="After"
            mixBlendMode={presentation.afterMixBlendMode}
            opacity={presentation.afterOpacity}
            src={afterSrc}
          />
        </div>
      )}
    </section>
  );
});
