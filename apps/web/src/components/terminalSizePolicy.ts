import type { TerminalSize } from "@bibcode/contracts";

export type TerminalDimensions = Pick<TerminalSize, "cols" | "rows">;
export type TerminalSizeTrigger = "attach" | "focus" | "pointer" | "keypress" | "layout" | "fit";

interface TerminalSizePolicy {
  readonly sizeClaim: string;
  readonly applied: TerminalSize | null;
  readonly fitted: TerminalDimensions | null;
  readonly claimInFlight: boolean;
  /**
   * A server that hands the size over left it un-owned: the owner left several windows and
   * none was typed in, so it waits for a person to use one (#348).
   */
  readonly unownedUntilUsed?: boolean;
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

/**
 * Whether this window answers the terminal's queries: the owner does, and while the size is
 * un-owned only the viewer the server names, so the program gets one answer. An older server
 * names none, and every window without a foreign owner answers (#348).
 */
export function answersTerminalQueries(applied: TerminalSize | null, sizeClaim: string): boolean {
  if (hasForeignTerminalSizeOwner(applied, sizeClaim)) return false;
  return applied?.sizeClaim != null || applied?.replyClaim == null || applied.replyClaim === sizeClaim;
}

/** The server left the size un-owned until a window is used, and says so (#348). */
export function isUnownedUntilUsed(applied: TerminalSize | null | undefined): boolean {
  return applied?.sizeClaim === null && applied.replyClaim != null;
}

/** Another window sizes the terminal, or the one that left did and nobody has used one since. */
function sizedElsewhere(
  applied: TerminalSize | null,
  sizeClaim: string,
  unownedUntilUsed = false,
): boolean {
  return (
    hasForeignTerminalSizeOwner(applied, sizeClaim) ||
    (unownedUntilUsed && applied?.sizeClaim === null)
  );
}

export function shouldShowTerminalSizeNotice(input: TerminalSizePolicy): boolean {
  return (
    !input.claimInFlight &&
    input.applied !== null &&
    input.fitted !== null &&
    sizedElsewhere(input.applied, input.sizeClaim, input.unownedUntilUsed) &&
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
  unownedUntilUsed = false,
): number {
  if (applied === null || fitted === null || !sizedElsewhere(applied, sizeClaim, unownedUntilUsed))
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
  // A restart, or a server that leaves every released size un-owned: some window must size it.
  if (input.applied.sizeClaim === null && !input.unownedUntilUsed) return true;
  const ownsSize = input.applied.sizeClaim === input.sizeClaim;
  // Matching owner geometry needs no resize or claim request.
  if (ownsSize && terminalDimensionsEqual(input.applied, input.fitted)) return false;
  switch (input.trigger) {
    // An unattended window (a locked or idle server host) refocused or remounted by the
    // system never takes the size.
    case "attach":
    case "focus":
      return ownsSize || (input.documentFocused && input.userActive);
    case "layout":
      return ownsSize;
    case "fit":
    case "pointer":
    case "keypress":
      return true;
  }
}
