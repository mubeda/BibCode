import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal } from "@xterm/xterm";
import {
  TERMINAL_COLS_MIN,
  TERMINAL_COLS_MAX,
  TERMINAL_ROWS_MIN,
  TERMINAL_ROWS_MAX,
} from "@bibcode/contracts";
import { terminalInputKey } from "@bibcode/client-runtime/state/terminal";
import type { TerminalDimensions } from "./terminalSizePolicy";

/**
 * False for a laid-out host with no area, such as a center column collapsed
 * behind a maximized right panel: the fit addon would propose its 2-column or
 * 1-row floor there. A host without a computed size (not laid out) is left to
 * the addon, which already proposes nothing for it.
 */
export function terminalHostHasArea(host: Element): boolean {
  const style = getComputedStyle(host);
  return !(Number.parseFloat(style.width) <= 0 || Number.parseFloat(style.height) <= 0);
}

export function proposeTerminalDimensions(
  fit: Pick<FitAddon, "proposeDimensions">,
  host?: Element,
): TerminalDimensions | null {
  if (host && !terminalHostHasArea(host)) return null;
  try {
    const size = fit.proposeDimensions();
    return size && Number.isFinite(size.cols) && Number.isFinite(size.rows)
      ? {
          cols: Math.min(TERMINAL_COLS_MAX, Math.max(TERMINAL_COLS_MIN, size.cols)),
          rows: Math.min(TERMINAL_ROWS_MAX, Math.max(TERMINAL_ROWS_MIN, size.rows)),
        }
      : null;
  } catch {
    return null;
  }
}

/**
 * Measures the terminal's cell again, so the fit addon proposes from a late font's glyphs:
 * xterm caches the cell size and a repaint measures nothing (#348). False when the
 * installed xterm has no measurement to call.
 */
export function remeasureTerminalCharSize(terminal: Terminal): boolean {
  // shortcut: calls xterm 6.0.0's private CharSizeService.measure, feature-detected; remove when xterm exposes a public re-measure
  try {
    const service = (
      terminal as unknown as {
        readonly _core?: { readonly _charSizeService?: { readonly measure?: () => void } };
      }
    )._core?._charSizeService;
    if (typeof service?.measure !== "function") return false;
    service.measure();
    return true;
  } catch {
    return false;
  }
}

/** The fit addon's own floor (`MINIMUM_COLS`, `MINIMUM_ROWS` in @xterm/addon-fit 0.11). */
const FIT_MINIMUM_COLS = 2;
const FIT_MINIMUM_ROWS = 1;

/**
 * Whether a proposal sits at the sizing minimum: what the fit proposes for a mount a few pixels
 * wide or tall, which no program can draw in.
 */
export function isTerminalSizingMinimum(dimensions: TerminalDimensions): boolean {
  return (
    dimensions.cols <= Math.max(TERMINAL_COLS_MIN, FIT_MINIMUM_COLS) ||
    dimensions.rows <= Math.max(TERMINAL_ROWS_MIN, FIT_MINIMUM_ROWS)
  );
}

// Only mounted renderers register a reader. Launch callbacks can use their
// current fit without subscribing to layout or manufacturing a measuring xterm.
const sizeReaders = new Map<string, () => TerminalDimensions | null>();

export function registerTerminalSizeReader(
  key: string,
  reader: () => TerminalDimensions | null,
): () => void {
  sizeReaders.set(key, reader);
  return () => {
    if (sizeReaders.get(key) === reader) sizeReaders.delete(key);
  };
}

export function readTerminalFittedSize(
  environmentId: string,
  threadId: string,
  terminalId: string,
): TerminalDimensions | null {
  return sizeReaders.get(terminalInputKey(environmentId, threadId, terminalId))?.() ?? null;
}
