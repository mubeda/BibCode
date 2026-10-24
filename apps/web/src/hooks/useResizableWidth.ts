import * as Schema from "effect/Schema";
import { type PointerEvent as ReactPointerEvent, useCallback, useRef, useState } from "react";

import { getLocalStorageItem, setLocalStorageItem } from "./useLocalStorage";

const WidthSchema = Schema.Finite;
/** Pointer travel up to this distance is a press, not a drag. */
const DRAG_THRESHOLD_PX = 2;

export interface UseResizableWidthOptions {
  /** localStorage key the persisted width is stored under. */
  readonly storageKey: string;
  readonly defaultWidth: number;
  readonly minWidth: number;
  readonly maxWidth: number;
  /**
   * Which edge of the host element carries the drag handle:
   *   - "left"  → panel grows leftward (right-anchored panels)
   *   - "right" → panel grows rightward (left-anchored panels)
   */
  readonly edge: "left" | "right";
}

export interface ResizableWidthHandlers {
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
}

/**
 * Width state for a side-anchored panel resized via a drag handle on the
 * specified edge.
 *
 * The committed width is the user's preference: read from localStorage on
 * mount and changed only by a drag whose pointer travels further than
 * `DRAG_THRESHOLD_PX` or by `commitWidth`. Travel, not the clamped width,
 * decides: a drag that a bound stops short still commits. The
 * returned `width` is what to paint: the live drag width or the committed
 * one, clamped to the current bounds. A `maxWidth` that shrinks with the
 * window clamps the paint without touching the preference, so the preference
 * comes back when there is room again. A drag commits once at drag-end (not
 * on every rAF tick — would otherwise be ~60 writes/sec).
 */
export function useResizableWidth(options: UseResizableWidthOptions): {
  readonly width: number;
  readonly handlers: ResizableWidthHandlers;
  /** Clamps `width` to the current bounds, persists it, and paints it. */
  readonly commitWidth: (width: number) => void;
} {
  const { storageKey, defaultWidth, minWidth, maxWidth, edge } = options;

  const clamp = useCallback(
    (value: number): number => {
      if (!Number.isFinite(value)) return defaultWidth;
      return Math.max(minWidth, Math.min(maxWidth, value));
    },
    [defaultWidth, maxWidth, minWidth],
  );

  // No cross-tab subscription: panel width is per-window state.
  const [committedWidth, setCommittedWidth] = useState<number>(() => {
    if (typeof window === "undefined") return defaultWidth;
    try {
      return getLocalStorageItem(storageKey, WidthSchema) ?? defaultWidth;
    } catch (error) {
      console.error("Could not read persisted panel width.", error);
      return defaultWidth;
    }
  });
  const [dragWidth, setDragWidth] = useState<number | null>(null);

  const paintedWidth = clamp(dragWidth ?? committedWidth);

  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
    pending: number;
    /** Whether the pointer has travelled past the press threshold. */
    moved: boolean;
    rafId: number | null;
    target: HTMLElement;
  } | null>(null);

  const releasePointer = useCallback((pointerId: number) => {
    const state = dragStateRef.current;
    if (!state) return;
    if (state.rafId !== null) {
      cancelAnimationFrame(state.rafId);
    }
    try {
      if (state.target.hasPointerCapture(pointerId)) {
        state.target.releasePointerCapture(pointerId);
      }
    } catch {
      // pointer may already be released; harmless.
    }
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    dragStateRef.current = null;
  }, []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const target = event.currentTarget;
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        return;
      }
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      dragStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: paintedWidth,
        pending: paintedWidth,
        moved: false,
        rafId: null,
        target,
      };
    },
    [paintedWidth],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const state = dragStateRef.current;
      if (!state || state.pointerId !== event.pointerId) return;
      event.preventDefault();
      const travel = event.clientX - state.startX;
      if (Math.abs(travel) > DRAG_THRESHOLD_PX) state.moved = true;
      state.pending = clamp(state.startWidth + (edge === "left" ? -travel : travel));
      if (state.rafId !== null) return;
      state.rafId = requestAnimationFrame(() => {
        const active = dragStateRef.current;
        if (!active) return;
        active.rafId = null;
        setDragWidth(active.pending);
      });
    },
    [clamp, edge],
  );

  const commitWidth = useCallback(
    (value: number) => {
      const next = clamp(value);
      try {
        setLocalStorageItem(storageKey, next, WidthSchema);
      } catch (error) {
        console.error("Could not persist panel width.", error);
      }
      setCommittedWidth(next);
    },
    [clamp, storageKey],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const state = dragStateRef.current;
      if (!state || state.pointerId !== event.pointerId) return;
      releasePointer(event.pointerId);
      setDragWidth(null);
      // A press keeps a preference the clamped paint hides, even if the
      // ceiling moved under it; a drag commits where it ended.
      if (state.moved) commitWidth(state.pending);
    },
    [commitWidth, releasePointer],
  );

  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const state = dragStateRef.current;
      if (!state || state.pointerId !== event.pointerId) return;
      // Don't persist a cancelled drag; paint the committed width again.
      releasePointer(event.pointerId);
      setDragWidth(null);
    },
    [releasePointer],
  );

  return {
    width: paintedWidth,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
    commitWidth,
  };
}
