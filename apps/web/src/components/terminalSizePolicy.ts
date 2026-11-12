import type { TerminalSize } from "@bibcode/contracts";

export type TerminalDimensions = Pick<TerminalSize, "cols" | "rows">;
export type TerminalSizeTrigger = "attach" | "focus" | "pointer" | "keypress" | "layout" | "fit";

interface TerminalSizePolicy {
  readonly sizeClaim: string;
  readonly applied: TerminalSize | null;
  readonly fitted: TerminalDimensions | null;
  readonly claimInFlight: boolean;
}

export function terminalDimensionsEqual(
  left: TerminalDimensions | null | undefined,
  right: TerminalDimensions | null | undefined,
): boolean {
  return left?.cols === right?.cols && left?.rows === right?.rows;
}

export function terminalSizesEqual(
  left: TerminalSize | null | undefined,
  right: TerminalSize | null | undefined,
): boolean {
  return terminalDimensionsEqual(left, right) && left?.sizeClaim === right?.sizeClaim;
}

export function hasForeignTerminalSizeOwner(
  applied: TerminalSize | null,
  sizeClaim: string,
): boolean {
  return applied?.sizeClaim != null && applied.sizeClaim !== sizeClaim;
}

export function shouldShowTerminalSizeNotice(input: TerminalSizePolicy): boolean {
  return (
    !input.claimInFlight &&
    input.applied !== null &&
    input.fitted !== null &&
    hasForeignTerminalSizeOwner(input.applied, input.sizeClaim) &&
    !terminalDimensionsEqual(input.applied, input.fitted)
  );
}

/** Below this a mirror's text is unreadable; it pins the bottom rows and scrolls instead. */
export const TERMINAL_MIRROR_MIN_SCALE = 0.5;

/**
 * How far a mirror scales the owner's grid down so the whole grid fits its box. Its fit is
 * measured at full size, so `fitted × cell` fits the box and `applied × cell × scale` does too.
 */
export function terminalMirrorScale(
  sizeClaim: string,
  applied: TerminalSize | null,
  fitted: TerminalDimensions | null,
): number {
  if (applied === null || fitted === null || !hasForeignTerminalSizeOwner(applied, sizeClaim))
    return 1;
  const scale = Math.min(1, fitted.cols / applied.cols, fitted.rows / applied.rows);
  return Math.max(TERMINAL_MIRROR_MIN_SCALE, Math.floor(scale * 1000) / 1000);
}

export function shouldClaimTerminalSize(
  input: TerminalSizePolicy & {
    readonly trigger: TerminalSizeTrigger;
    readonly documentFocused: boolean;
    /** Input reached this page moments ago; a window refocused by the system has none. */
    readonly userActive: boolean;
  },
): boolean {
  if (input.claimInFlight || input.fitted === null || input.applied === null) return false;
  if (input.applied.sizeClaim === null) return true;
  const ownsSize = input.applied.sizeClaim === input.sizeClaim;
  // Matching owner geometry needs no resize or claim request.
  if (ownsSize && terminalDimensionsEqual(input.applied, input.fitted)) return false;
  switch (input.trigger) {
    // An unattended window (a locked or idle server host) refocused or remounted by the
    // system never takes a live owner's size.
    case "attach":
      return ownsSize || (input.documentFocused && input.userActive);
    case "focus":
      return ownsSize || input.userActive;
    case "layout":
      return ownsSize;
    case "fit":
    case "pointer":
    case "keypress":
      return true;
  }
}
