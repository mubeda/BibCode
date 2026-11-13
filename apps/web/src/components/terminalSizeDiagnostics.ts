import type { TerminalResizeOutcome } from "@bibcode/contracts";
import type { TerminalDimensions, TerminalSizeTrigger } from "./terminalSizePolicy";

/**
 * A development-only record of the terminal's sizing and repaint decisions (#348). It holds
 * numbers and enums only: no ids, no paths and nothing written to the terminal.
 */
export const TERMINAL_SIZE_DIAGNOSTICS_CAPACITY = 200;

export type TerminalSizeDiagnosticTrigger =
  | TerminalSizeTrigger
  | "font"
  | "pixel-ratio"
  | "resize-answer"
  | "repaint";

export interface TerminalSizeDiagnosticRecord {
  readonly at: number;
  readonly trigger: TerminalSizeDiagnosticTrigger;
  readonly rendererGeneration: number;
  readonly mountWidth: number;
  readonly mountHeight: number;
  readonly fitted: TerminalDimensions | null;
  readonly applied: TerminalDimensions | null;
  readonly role: "owner" | "mirror" | "legacy";
  readonly devicePixelRatio: number;
  readonly fontStatus: "loading" | "loaded" | "unavailable";
  readonly renderer: "webgl" | "standard";
  readonly request: {
    readonly cols: number;
    readonly rows: number;
    readonly outcome: TerminalResizeOutcome | "pending" | "failed";
  } | null;
  readonly repaint: "none" | "scheduled" | "done";
}

const ring: Array<TerminalSizeDiagnosticRecord | undefined> = Array.from({
  length: TERMINAL_SIZE_DIAGNOSTICS_CAPACITY,
});
let next = 0;
let count = 0;
let enabled = false;

export function clearTerminalSizeDiagnostics(): void {
  ring.fill(undefined);
  next = 0;
  count = 0;
}

/** Ignored outside development; disabling also clears the ring. */
export function setTerminalSizeDiagnosticsEnabled(value: boolean): void {
  if (!import.meta.env.DEV) return;
  enabled = value;
  if (!value) clearTerminalSizeDiagnostics();
}

export function terminalSizeDiagnosticsEnabled(): boolean {
  return enabled;
}

export function recordTerminalSizeDiagnostic(
  record: Omit<TerminalSizeDiagnosticRecord, "at">,
): void {
  if (!enabled) return;
  ring[next] = { at: performance.now(), ...record };
  next = (next + 1) % TERMINAL_SIZE_DIAGNOSTICS_CAPACITY;
  count = Math.min(count + 1, TERMINAL_SIZE_DIAGNOSTICS_CAPACITY);
}

/** Oldest first, a copy. */
export function readTerminalSizeDiagnostics(): readonly TerminalSizeDiagnosticRecord[] {
  const start =
    (next - count + TERMINAL_SIZE_DIAGNOSTICS_CAPACITY) % TERMINAL_SIZE_DIAGNOSTICS_CAPACITY;
  return Array.from(
    { length: count },
    (_, index) => ring[(start + index) % TERMINAL_SIZE_DIAGNOSTICS_CAPACITY]!,
  );
}
